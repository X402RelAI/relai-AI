// Buyer agent — drives the SPR buyer flow:
//   1. Open conversation, ask for a quote (include source text).
//   2. Receive `relai:quote:<base64url>` payload from the seller.
//   3. Pay anonymously: deposit into Privacy Pool V4.1 + generate pairing
//      Groth16 proof + operator-relayed pairing record on-chain.
//   4. Ack to the seller, wait for delivery.
//
// Privacy invariant: buyer's Solana keypair is loaded ONCE at startup
// from RELAI_BUYER_SOLANA_SECRET_KEY, materialized into a Keypair, and
// bound by closure into the pay tool. The LLM never sees the secret bytes
// — it only passes the opaque `relai:quote:…` string.

import "dotenv/config";
import path from "node:path";
import url from "node:url";
import { Connection } from "@solana/web3.js";
import { loadSolanaKeypair, readBalances, airdropSolDevnet } from "./lib/solana-balances.mjs";
import { paySPR } from "./lib/pay-spr.mjs";
import { parseShieldedQuotePayload } from "./lib/parse-quote-payload.mjs";
import { runAgent } from "./shared/agent-loop.mjs";
import { makeChatTools, clearInbox } from "./shared/chat-tools.mjs";
import { loadSkill } from "./shared/load-skill.mjs";
import { printBuyerBanner } from "./shared/banners.mjs";
import {
  renderAssistantText,
  renderStatus,
  startToolPulse,
  endToolPulse,
  summarizeToolResult,
  renderChatMessage,
  renderChatTimeout,
} from "./shared/render.mjs";
import {
  printStepBadge,
  printPrivacyNote,
  printOnChainReceipt,
  writeSummaryFragment,
} from "./shared/visuals.mjs";

const MODEL = "claude-sonnet-4-6";
const PREFIX = "buyer";
const ACCENT = "\x1b[36m";
const SELF_NAME = "Atlas Studios";
const PEER_NAME = "Kana Translation Co.";
const PEER_ACCENT = "\x1b[35m";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function env(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

const status = (text) => renderStatus({ prefix: PREFIX, accent: ACCENT, text });

const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const RELAI_BASE_URL = env("RELAI_BASE_URL", "https://api.relai.fi");
const SERVICE_KEY = env("RELAI_SERVICE_KEY_BUYER");
const NETWORK = env("DEMO_NETWORK", "solana-devnet");
const BUS_URL = `http://localhost:${env("CHAT_BUS_PORT", "4748")}`;
const SELF_ID = "buyer-atlas-studios";
const PEER_ID = "seller-translator";
const QUOTE_AMOUNT_USDC = Number(env("DEMO_AMOUNT_USDC", "0.1"));

const BUYER = loadSolanaKeypair(env("RELAI_BUYER_SOLANA_SECRET_KEY"));

const PERSONA = `You are an autonomous procurement agent representing **Atlas Studios**, a content studio.
You operate independently — no human will reply mid-conversation. You raise issues by sending messages to the other agent or by ending your turn, never by waiting for human input.

## Your job

You need a one-page Japanese-to-Polish translation of a short technical brief about the x402 micropayment protocol. Your budget is up to ${QUOTE_AMOUNT_USDC * 1.5} USDC; you want delivery within an hour.

The exact source text (paste it verbatim in your opening message so the seller can quote — do NOT alter, abbreviate, or omit any sentence):

\`\`\`
x402 プロトコルは HTTP 402 Payment Required レスポンスを拡張し、Solana 上の USDC マイクロペイメントを通じて API エンドポイントへのアクセスを実現します。クライアントは支払いプルーフを X-PAYMENT ヘッダーに含めて送信し、サーバーはオンチェーン上でトランザクションを検証してから本来のレスポンスを返します。RelAI のシールドペイメントリクエストはこの仕組みに Privacy Pools V4.1 を組み合わせ、売り手が発行した不透明な見積もりに対して買い手が匿名で支払えるようにします。買い手と売り手のウォレットがオンチェーン上で同一トランザクションに現れることはありません。
\`\`\`

When the seller delivers the translation, briefly acknowledge (no need to verify quality — you trust the specialist for this demo) and end the conversation.

## Your privacy posture

Atlas pays a dozen suppliers from the same Solana wallet. You DO NOT want this specific translator to learn your wallet address. So you settle this payment via a **RelAI Shielded Payment Request**: the seller sends a \`relai:quote:<base64url>\` payload, and you pay it anonymously through Privacy Pool V4.1.

## Conduct

- Be terse and businesslike, like a procurement agent.
- Ask clearly for a quote in your opening message; include the source text.
- When the seller sends a \`relai:quote:…\` payload, **immediately** call \`relai_spr_pay\` with that exact string — pass the payload verbatim.
- After the pay tool returns, send a brief "paid" ack. DO NOT include your wallet, the deposit tx, the buyer commitment, or the payment nullifier — those are on-chain artifacts the seller must not learn through chat.
- Wait for the translation. Once received, ack and end the conversation.
- If the seller quotes more than ${QUOTE_AMOUNT_USDC * 1.5} USDC, decline.

## When the conversation reaches a natural end

After the translation arrives and you've acknowledged it, output a final line beginning with "DEAL COMPLETE:" and stop calling tools.`;

async function main() {
  printBuyerBanner({
    pubkey: BUYER.publicKey.toBase58(),
    network: NETWORK,
    model: MODEL,
    skill: "relai-spr-pay",
  });

  // Pre-flight: airdrop SOL on devnet if needed, sanity-check USDC balance.
  try {
    const rpcUrl = NETWORK === "solana-devnet"
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com";
    const usdcMint = NETWORK === "solana-devnet"
      ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
      : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const bal = await readBalances({ rpcUrl, usdcMint, owner: BUYER.publicKey });
    if (NETWORK === "solana-devnet" && bal.solLamports < 10_000_000) {
      status(`SOL balance low (${(bal.solLamports / 1e9).toFixed(4)} SOL) — airdropping…`);
      await airdropSolDevnet({ rpcUrl, recipient: BUYER.publicKey });
    }
    status(
      `pre-flight  SOL=${(bal.solLamports / 1e9).toFixed(4)}   ` +
        `USDC=${(Number(bal.usdcMicro) / 1e6).toFixed(2)}   ` +
        `ATA=${bal.ataExists ? "ok" : "missing"}`,
    );
  } catch (err) {
    status(`pre-flight failed: ${err.message}`);
    process.exit(1);
  }

  const skill = loadSkill({
    skillsRoot: path.join(__dirname, "../../.claude/skills"),
    skillName: "relai-spr-pay",
  });
  status(`skill loaded (${skill.refsCount} reference(s) inlined)`);

  try {
    const dropped = await clearInbox({ busUrl: BUS_URL, selfId: SELF_ID });
    if (dropped > 0) status(`cleared ${dropped} stale message(s)`);
  } catch (err) {
    status(`could not clear inbox (${err.message}) — continuing`);
  }

  status(`ready to negotiate.`);
  process.stdout.write("\n");

  const chatTools = makeChatTools({ busUrl: BUS_URL, selfId: SELF_ID, peerId: PEER_ID });
  const badgeFlags = { negotiated: false, paid: false };

  const tools = [
    ...chatTools,
    {
      name: "relai_spr_pay",
      description:
        "Pay a Shielded Payment Request quote. Decodes the `relai:quote:<base64url>` payload, deposits USDC into Privacy Pool V4.1 with the buyer's keypair, generates the Groth16 pairing proof locally, and asks the operator to relay the on-chain match. The buyer's wallet is bound by closure outside the LLM context — you only pass the payload.",
      input_schema: {
        type: "object",
        properties: {
          quotePayload: {
            type: "string",
            description: "The full `relai:quote:<base64url>` string from the seller. Pass verbatim.",
          },
        },
        required: ["quotePayload"],
      },
      async run({ quotePayload }) {
        const parsed = parseShieldedQuotePayload(quotePayload);
        if (!parsed) {
          throw new Error("Could not parse quote payload — malformed or unsupported prefix.");
        }
        const amountUsdc = Number(parsed.amount) / 1_000_000;
        if (amountUsdc > QUOTE_AMOUNT_USDC * 1.5) {
          throw new Error(
            `Quote asks for ${amountUsdc} USDC, exceeds budget cap ${QUOTE_AMOUNT_USDC * 1.5}. Refusing.`,
          );
        }
        printStepBadge("Pay (deposit + pair)");
        const payStartedAt = Date.now();
        const result = await paySPR({
          baseUrl: RELAI_BASE_URL,
          payload: quotePayload,
          walletKeypair: BUYER,
          network: NETWORK,
        });
        const payMs = Date.now() - payStartedAt;
        printOnChainReceipt({
          label: `Deposit confirmed · ${amountUsdc} USDC → pool`,
          signature: result.depositTxSig,
          explorerUrl: result.depositExplorerUrl,
          extra: result.pairingTxSig
            ? `pairing tx ${result.pairingTxSig.slice(0, 8)}…`
            : "(pairing relay returned no tx — may have been already-relayed)",
        });
        if (result.pairingExplorerUrl) {
          printOnChainReceipt({
            label: `Pairing recorded · operator-signed`,
            signature: result.pairingTxSig,
            explorerUrl: result.pairingExplorerUrl,
            extra: `verify_and_record on PaymentMatchRouterV2`,
          });
        }
        printPrivacyNote(
          "buyer wallet appears in this deposit + pairing event but the seller redeem will NOT name the buyer — pool PDA + stealth ATA + main wallet sit among unrelated pool ops.",
        );
        writeSummaryFragment("buyer", {
          buyerPubkey: result.buyerPubkey,
          quoteId: result.quoteId,
          amountUsdc,
          depositTxHash: result.depositTxSig,
          depositExplorerUrl: result.depositExplorerUrl,
          pairTxHash: result.pairingTxSig,
          pairExplorerUrl: result.pairingExplorerUrl,
          payMs,
        });
        return {
          quoteId: result.quoteId,
          amountUsdc,
          status: "paired",
          // Buyer-only; never relay to seller.
          _privateBuyerCommitment: result.commitmentHex,
          _privateBuyerPubkey: result.buyerPubkey,
          _privateDepositTxHash: result.depositTxSig,
          _privateDepositExplorer: result.depositExplorerUrl,
          _privatePairingTxHash: result.pairingTxSig,
        };
      },
    },
  ];

  await runAgent({
    apiKey: ANTHROPIC_API_KEY,
    model: MODEL,
    systemBlocks: [
      PERSONA,
      `## Reference card: relai-spr-pay skill\n\n${skill.body}`,
    ],
    initialUserMessage:
      "You are now online. The translator agent is also online and waiting on the chat bus. " +
      "Open the conversation by introducing yourself and stating your need: one-page JP→PL " +
      "specialist translation delivered within the hour, with the verbatim source text from " +
      "your system prompt included as a fenced code block in that same opening message so the " +
      "translator can quote on it. Then poll for replies and react to them.",
    tools,
    onAssistantText: (text) =>
      renderAssistantText({ prefix: PREFIX, accent: ACCENT, text }),
    onToolCall: ({ name, input }) => {
      if (name === "send_message" && typeof input?.body === "string") {
        if (!badgeFlags.negotiated) {
          printStepBadge("Negotiate");
          badgeFlags.negotiated = true;
        }
        renderChatMessage({ speakerAccent: ACCENT, speakerName: SELF_NAME, body: input.body });
        return;
      }
      if (name === "relai_spr_pay") badgeFlags.paid = true;
      startToolPulse({ prefix: PREFIX, accent: ACCENT, name, input });
    },
    onToolResult: ({ name, result, isError }) => {
      if (name === "send_message") return;
      if (name === "wait_for_message" && !isError) {
        try {
          const parsed = JSON.parse(result);
          if (parsed?.timeout) renderChatTimeout({ prefix: PREFIX, accent: ACCENT });
          else if (typeof parsed?.body === "string")
            renderChatMessage({ speakerAccent: PEER_ACCENT, speakerName: PEER_NAME, body: parsed.body });
          return;
        } catch { /* fall through */ }
      }
      endToolPulse({ success: !isError, summary: summarizeToolResult(result) ?? undefined });
    },
  });

  status("agent loop ended.");
}

main().catch((err) => {
  status(`fatal: ${err.stack || err}`);
  process.exit(1);
});
