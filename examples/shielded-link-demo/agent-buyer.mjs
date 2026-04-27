// Buyer agent — Claude reasoning loop driven by the .claude/skills/relai-shielded-send
// skill, exactly the same skill a Claude Code user would invoke. Persona is a
// thin wrapper on top.
//
// Privacy invariant: the buyer's Solana keypair is loaded ONCE from
// RELAI_BUYER_SOLANA_SECRET_KEY at process startup, materialized into a
// Keypair object, and bound into the tool closure. The LLM never sees the
// secret bytes — its only signing input is `recipientAmountUsdc`. This
// matches the public-demo guidance: "the signing operation should happen in a
// small adjacent process/tool that the LLM invokes with a transaction intent,
// never with the key itself."

import "dotenv/config";
import path from "node:path";
import url from "node:url";
import { loadSolanaKeypair } from "./lib/solana-deposit.ts";
import { inspectBuyer, createAndFundShieldedLink } from "./lib/create.ts";
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
const ACCENT = "\x1b[36m"; // cyan
const SELF_NAME = "Atlas Studios";
const PEER_NAME = "Kana Translation Co.";
const PEER_ACCENT = "\x1b[35m"; // magenta — must match seller's ACCENT

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function env(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

// Status line helper bound to this agent's prefix + accent.
const status = (text) => renderStatus({ prefix: PREFIX, accent: ACCENT, text });

const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const RELAI_BASE_URL = env("RELAI_BASE_URL", "https://api.relai.fi");
const SERVICE_KEY = env("RELAI_SERVICE_KEY_BUYER");
const NETWORK = env("DEMO_NETWORK", "solana-devnet");
const BUS_URL = `http://localhost:${env("CHAT_BUS_PORT", "4747")}`;
const SELF_ID = "buyer-atlas-studios";
const PEER_ID = "seller-translator";

// ── Load buyer keypair from env ONCE, outside the LLM context. The LLM only
// sees the resulting Keypair via closure capture — never the raw secret.
const BUYER = loadSolanaKeypair(env("RELAI_BUYER_SOLANA_SECRET_KEY"));

const PERSONA = `You are an autonomous procurement agent representing **Atlas Studios**, a content studio.
You operate independently — no human will reply mid-conversation. You raise issues by sending messages to the other agent or by ending your turn, never by waiting for human input.

## Your job

You need a one-page Japanese-to-Polish translation of a short technical brief about the x402 micropayment protocol. You have a budget of up to 0.15 USDC for this single page and want delivery within an hour.

The exact source text you need translated (paste it verbatim in your opening message so the seller can quote — do NOT alter, abbreviate, or omit any sentence):

\`\`\`
x402 プロトコルは HTTP 402 Payment Required レスポンスを拡張し、Solana 上の USDC マイクロペイメントを通じて API エンドポイントへのアクセスを実現します。クライアントは支払いプルーフを X-PAYMENT ヘッダーに含めて送信し、サーバーはオンチェーン上でトランザクションを検証してから本来のレスポンスを返します。RelAI のシールドリンクはこの仕組みに Privacy Pools を組み合わせ、二つのエージェント間の決済を完全に切り離します。買い手と売り手のウォレットがオンチェーン上で同一トランザクションに現れることはありません。
\`\`\`

When the seller delivers the translation, briefly acknowledge that you received it (no need to verify quality — you trust the specialist for this demo) and end the conversation.

## Your privacy posture

Atlas pays a dozen suppliers from the same Solana wallet. You DO NOT want this specific translator to learn your wallet address — they would be able to map your other supplier relationships. So you settle this payment via a **RelAI shielded link**. The detailed protocol is in the reference card below — follow it exactly.

## Conduct

- Be terse and businesslike, like a procurement agent. Don't roleplay extra fluff.
- Ask clearly for a quote before agreeing.
- After payment, wait for delivery confirmation. Once you have it, end the conversation politely and stop.
- If the seller quotes more than 0.15 USDC, decline.

## When the conversation reaches a natural end

After you've received the delivery and acknowledged it, output a final line beginning with "DEAL COMPLETE:" and stop calling tools. The orchestrator will tear everything down.`;

async function main() {
  printBuyerBanner({
    pubkey: BUYER.publicKey.toBase58(),
    network: NETWORK,
    model: MODEL,
    skill: "relai-shielded-send",
  });

  // Pre-flight: confirm balances before the LLM loop starts. The result is
  // logged to stdout for the operator, not fed into the LLM context.
  try {
    const info = await inspectBuyer({
      baseUrl: RELAI_BASE_URL,
      serviceKey: SERVICE_KEY,
      network: NETWORK,
      buyer: BUYER,
    });
    status(
      `pre-flight  SOL=${(info.solLamports / 1e9).toFixed(4)}   ` +
        `USDC=${(Number(info.usdcMicro) / 1e6).toFixed(2)}   ` +
        `ATA=${info.ataExists ? "ok" : "missing"}`,
    );
  } catch (err) {
    status(`pre-flight failed: ${err.message}`);
    process.exit(1);
  }

  // Load the .claude/skills/relai-shielded-send skill — the source of truth
  // for what this agent should do. Same skill a Claude Code user invokes.
  const skill = loadSkill({
    skillsRoot: path.join(__dirname, "../../.claude/skills"),
    skillName: "relai-shielded-send",
  });
  status(`skill loaded (${skill.refsCount} reference(s) inlined)`);

  // 3-terminal mode keeps the chat bus alive across runs — drop any stale
  // messages from previous runs so we start with a clean inbox.
  try {
    const dropped = await clearInbox({ busUrl: BUS_URL, selfId: SELF_ID });
    if (dropped > 0) status(`cleared ${dropped} stale message(s) from inbox`);
  } catch (err) {
    status(`could not clear inbox (${err.message}) — continuing`);
  }

  status(`waiting for the conversation to start…`);
  process.stdout.write("\n");

  const chatTools = makeChatTools({ busUrl: BUS_URL, selfId: SELF_ID, peerId: PEER_ID });

  // Track which step badges we've already printed so onToolCall doesn't
  // spam the same badge on every send_message.
  const badgeFlags = { negotiated: false, handedOff: false };

  const tools = [
    ...chatTools,
    {
      name: "relai_shielded_create",
      description:
        "Create and fund a RelAI shielded link in one step. Generates a fresh Poseidon commitment locally, posts the draft, signs and broadcasts the on-chain Solana `deposit_note` instruction, reports the funded state, and returns the encoded `relai:shielded:…` payload to hand to the seller. Non-reversible once on-chain. The buyer pubkey, commitment, nullifier, and deposit tx hash are returned for your records ONLY — DO NOT relay them to the seller (each one breaks the unlinkability).",
      input_schema: {
        type: "object",
        properties: {
          recipientAmountUsdc: {
            type: "number",
            description:
              "USDC amount the seller will receive, e.g. 0.1 for 0.10 USDC. The 5% pool fee is added on top automatically.",
          },
          description: {
            type: "string",
            description:
              "Optional short job tag (≤ 200 chars). No PII, no buyer identity. E.g. 'translation'.",
          },
          validForSeconds: {
            type: "number",
            description: "Link TTL in seconds. Default 3600 (1 hour). Server caps at 30 days.",
          },
        },
        required: ["recipientAmountUsdc"],
      },
      async run({ recipientAmountUsdc, description, validForSeconds }) {
        printStepBadge("Deposit on-chain");
        const recipientAmountMicro = Math.round(recipientAmountUsdc * 1_000_000);
        const depositStartedAt = Date.now();
        const result = await createAndFundShieldedLink({
          baseUrl: RELAI_BASE_URL,
          serviceKey: SERVICE_KEY,
          network: NETWORK,
          recipientAmountMicro,
          validForSeconds,
          description: description ?? "demo",
          buyer: BUYER,
        });
        const depositMs = Date.now() - depositStartedAt;
        printOnChainReceipt({
          label: `Deposit confirmed · ${recipientAmountUsdc} USDC + 5% fee`,
          signature: result.depositTxHash,
          explorerUrl: result.depositExplorerUrl,
          extra: `commitment ${result.commitment.slice(0, 12)}…`,
        });
        printPrivacyNote(
          "buyer wallet appears in this deposit but will NOT appear in the future withdraw event — the chain holds two unrelated pool ops, no graph edge.",
        );
        // Persist the buyer's perspective for the unified summary panel
        // printed by the orchestrator after both agents finish.
        writeSummaryFragment("buyer", {
          buyerPubkey: result.buyerPubkey,
          amountUsdc: recipientAmountUsdc,
          feeUsdc: result.feeAmountMicro / 1_000_000,
          description: description ?? "demo",
          depositTxHash: result.depositTxHash,
          depositExplorerUrl: result.depositExplorerUrl,
          depositMs,
        });
        return {
          shieldedLinkPayload: result.shieldedLinkPayload,
          shieldedLinkId: result.shieldedLinkId,
          recipientAmountUsdc,
          feeUsdc: result.feeAmountMicro / 1_000_000,
          totalDebitedUsdc: result.totalAmountMicro / 1_000_000,
          validBefore: new Date(result.validBefore * 1000).toISOString(),
          // Privacy-sensitive — buyer agent must NOT relay these to the seller.
          // Returned only so the buyer can log them locally.
          _privateBuyerPubkey: result.buyerPubkey,
          _privateCommitment: result.commitment,
          _privateNullifier: result.nullifier,
          _privateDepositTxHash: result.depositTxHash,
          _privateDepositExplorer: result.depositExplorerUrl,
        };
      },
    },
  ];

  await runAgent({
    apiKey: ANTHROPIC_API_KEY,
    model: MODEL,
    systemBlocks: [
      PERSONA,
      `## Reference card: relai-shielded-send skill\n\n${skill.body}`,
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
        // First message of the conversation = step 1 (Negotiate).
        // Message containing the shielded payload = step 3 (Handoff).
        if (!badgeFlags.negotiated) {
          printStepBadge("Negotiate");
          badgeFlags.negotiated = true;
        }
        if (!badgeFlags.handedOff && /relai:shielded:/i.test(input.body)) {
          printStepBadge("Handoff (payload over chat)");
          badgeFlags.handedOff = true;
        }
        renderChatMessage({
          speakerAccent: ACCENT,
          speakerName: SELF_NAME,
          body: input.body,
        });
        return;
      }
      startToolPulse({ prefix: PREFIX, accent: ACCENT, name, input });
    },
    onToolResult: ({ name, result, isError }) => {
      if (name === "send_message") return; // already rendered on call
      if (name === "wait_for_message" && !isError) {
        try {
          const parsed = JSON.parse(result);
          if (parsed?.timeout) {
            renderChatTimeout({ prefix: PREFIX, accent: ACCENT });
          } else if (typeof parsed?.body === "string") {
            // Inbound from the peer: render with the PEER's identity so the
            // chat reads as a unified transcript regardless of which agent
            // process is logging it.
            renderChatMessage({
              speakerAccent: PEER_ACCENT,
              speakerName: PEER_NAME,
              body: parsed.body,
            });
          }
          return;
        } catch {
          // fall through to generic tool result rendering
        }
      }
      endToolPulse({
        success: !isError,
        summary: summarizeToolResult(result) ?? undefined,
      });
    },
  });

  status("agent loop ended.");
}

main().catch((err) => {
  status(`fatal: ${err.stack || err}`);
  process.exit(1);
});
