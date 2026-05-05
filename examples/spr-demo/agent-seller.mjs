// Seller agent — drives the SPR seller flow:
//   1. Negotiate with the buyer over the chat bus.
//   2. Issue an SPR quote → emit `relai:quote:<base64url>` payload.
//   3. Poll match-status until status: paid.
//   4. Redeem on-chain (operator-relayed payout-to-seller → 95/5 split,
//      then claim stealth → main wallet).
//   5. Deliver the translation.
//
// Privacy invariant: the seller's Solana keypair is loaded ONCE at
// process startup from RELAI_SELLER_SOLANA_SECRET_KEY, materialized into
// a Keypair, and bound by closure into the redeem tool. The LLM only
// passes opaque quoteIds — never the keypair. The keypair is required
// because SPR derives a per-quote stealth keypair from
// sha256(wallet.signMessage(challenge)), and the stealth claim tx
// (stealth → main ATA) is partial-signed by the stealth keypair.

import "dotenv/config";
import path from "node:path";
import url from "node:url";
import { loadSolanaKeypair } from "./lib/solana-balances.mjs";
import { createAndIssueQuote, getMatchStatus } from "./lib/seller-flow.mjs";
import { redeemSPR } from "./lib/redeem-spr.mjs";
import { runAgent } from "./shared/agent-loop.mjs";
import { makeChatTools, clearInbox } from "./shared/chat-tools.mjs";
import { loadSkill } from "./shared/load-skill.mjs";
import { printSellerBanner } from "./shared/banners.mjs";
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
  traceMethod,
} from "./shared/visuals.mjs";

const MODEL = "claude-sonnet-4-6";
const PREFIX = "seller";
const ACCENT = "\x1b[35m";
const SELF_NAME = "Kana Translation Co.";
const PEER_NAME = "Atlas Studios";
const PEER_ACCENT = "\x1b[36m";

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
const SERVICE_KEY = env("RELAI_SERVICE_KEY_SELLER");
const SELLER_KEYPAIR = loadSolanaKeypair(env("RELAI_SELLER_SOLANA_SECRET_KEY"));
const NETWORK = env("DEMO_NETWORK", "solana-devnet");
const BUS_URL = `http://localhost:${env("CHAT_BUS_PORT", "4748")}`;
const SELF_ID = "seller-translator";
const PEER_ID = "buyer-atlas-studios";
const QUOTE_AMOUNT_USDC = Number(env("DEMO_AMOUNT_USDC", "0.1"));

const PERSONA = `You are an autonomous freelance agent representing **Kana Translation Co.**, a solo JP→PL specialist with technical-domain experience.
You operate independently — no human will reply mid-conversation. You raise issues by sending messages to the other agent or by ending your turn, never by waiting for human input.

## Your business

- Specialist JP→PL translation, technical terminology comfortable.
- Standard rate: **${QUOTE_AMOUNT_USDC} USDC per page** (a page = up to 500 chars JP).
- Turnaround: same hour for one-page jobs.

## Your privacy posture

Your client list is your competitive moat. You DO NOT want this buyer to learn your wallet address — they could correlate it to your other clients. You issue **RelAI Shielded Payment Request quotes** and let the buyer pay anonymously through Privacy Pool V4.1. The platform's operator signs the on-chain payout when you redeem; you never sign a Solana tx — and the payout lands in a per-quote stealth ATA that gets swept to your main wallet by the same operator co-signing flow, so on-chain observers see only "stealth wallet → main wallet" with no link back to the buyer's deposit.

## Conduct

- Be terse, professional. Like a working translator agent.
- When asked for a quote: ${QUOTE_AMOUNT_USDC} USDC for one page, deliverable within the hour. Confirm you saw the source text.
- Once the buyer accepts, **issue the SPR quote** with \`relai_spr_issue\` (the demo's local tool). The amount is ${Math.round(QUOTE_AMOUNT_USDC * 1_000_000)} atomic micro-USDC. Hand the resulting \`relai:quote:…\` payload to the buyer in a single message — nothing else in that message.
- After sending the payload, wait. Use \`relai_spr_status\` to check whether the buyer paired. End your turn between checks so the buyer's reply has a chance to arrive.
- Once \`relai_spr_status\` reports \`status: paid\`, **redeem the quote** with \`relai_spr_redeem\` — operator signs payout-to-seller, splits 95/5, then a second operator-co-signed tx claims the stealth ATA into your main wallet ATA.
- After redeem succeeds, **actually translate** the Japanese source the buyer sent into Polish. Specialist quality, technical-domain terminology preserved. Send the translation back as a fenced \`\`\`pl code block, with no other commentary beyond a one-line "received" ack.
- DO NOT relay your wallet, the redeem tx, the claim tx, or any nullifier to the buyer.

## When the conversation reaches a natural end

After delivering the translation, output a final line beginning with "DEAL COMPLETE:" and stop calling tools.`;

async function main() {
  printSellerBanner({
    pubkey: SELLER_KEYPAIR.publicKey.toBase58(),
    network: NETWORK,
    model: MODEL,
    skill: "relai-spr-issue + relai-spr-redeem",
  });

  const issueSkill = loadSkill({
    skillsRoot: path.join(__dirname, "../../.claude/skills"),
    skillName: "relai-spr-issue",
  });
  const redeemSkill = loadSkill({
    skillsRoot: path.join(__dirname, "../../.claude/skills"),
    skillName: "relai-spr-redeem",
  });
  status(`skills loaded (${issueSkill.refsCount + redeemSkill.refsCount} reference(s) inlined)`);

  try {
    const dropped = await clearInbox({ busUrl: BUS_URL, selfId: SELF_ID });
    if (dropped > 0) status(`cleared ${dropped} stale message(s)`);
  } catch (err) {
    status(`could not clear inbox (${err.message}) — continuing`);
  }

  status(`listening for inbound work…`);
  process.stdout.write("\n");

  const chatTools = makeChatTools({ busUrl: BUS_URL, selfId: SELF_ID, peerId: PEER_ID });

  const badgeFlags = { negotiated: false, issued: false, redeemed: false, delivered: false };
  let currentQuoteId = null;

  const tools = [
    ...chatTools,
    {
      name: "relai_spr_issue",
      description:
        "Issue a Shielded Payment Request quote. Creates a draft + transitions to ISSUED in one call, returns the bearer payload `relai:quote:<base64url>` for the buyer.",
      input_schema: {
        type: "object",
        properties: {
          recipientAmountUsdc: { type: "number", description: `USDC amount to charge. Standard rate is ${QUOTE_AMOUNT_USDC} USDC for one page.` },
          description: { type: "string", description: "Optional short job tag (≤ 100 chars)." },
          validForSeconds: { type: "number", description: "Quote TTL. Default 3600. Server requires > 5 min." },
        },
        required: ["recipientAmountUsdc"],
      },
      async run({ recipientAmountUsdc, description, validForSeconds }) {
        printStepBadge("Issue SPR quote");
        const issueStartedAt = Date.now();
        const amountAtomic = String(Math.round(recipientAmountUsdc * 1_000_000));
        const ttl = validForSeconds ?? 3600;
        const expiry = Math.floor(Date.now() / 1000) + ttl;
        const issued = await traceMethod(
          { kind: "http", label: "POST /v1/shielded-payment-requests  (draft + issue)" },
          () =>
            createAndIssueQuote({
              baseUrl: RELAI_BASE_URL,
              serviceKey: SERVICE_KEY,
              amountAtomic,
              expiry,
              description: description ?? "demo",
              network: NETWORK,
            }),
        );
        const issueMs = Date.now() - issueStartedAt;
        currentQuoteId = issued.quoteId;
        printPrivacyNote(
          "no on-chain footprint yet — the quote sits in QuoteRegistry off-chain until the buyer pairs.",
        );
        writeSummaryFragment("seller", {
          sellerPubkey: SELLER_KEYPAIR.publicKey.toBase58(),
          quoteId: issued.quoteId,
          amountUsdc: recipientAmountUsdc,
          description: description ?? "demo",
          issueMs,
        });
        return {
          quoteId: issued.quoteId,
          payload: issued.payload,
          amountUsdc: recipientAmountUsdc,
          expiry: new Date(expiry * 1000).toISOString(),
          _privateSellerReceiptId: issued.sellerReceiptId,
        };
      },
    },
    {
      name: "relai_spr_status",
      description: "Check the public match-status for an SPR quote. Returns status: pending|paid|redeemed|expired|cancelled.",
      input_schema: {
        type: "object",
        properties: {
          quoteId: { type: "string", description: "Defaults to the most recently issued quote." },
        },
      },
      async run({ quoteId }) {
        const id = quoteId || currentQuoteId;
        if (!id) throw new Error("No quoteId provided and none cached.");
        const s = await getMatchStatus({ baseUrl: RELAI_BASE_URL, quoteId: id });
        return {
          quoteId: id,
          status: s.status,
          matchedAt: s.match?.matchedAt ?? null,
          expiry: s.expiry ?? null,
        };
      },
    },
    {
      name: "relai_spr_redeem",
      description:
        "Redeem a paid SPR quote. Derives a per-quote stealth keypair from your wallet signature, runs the Groth16 redeem proof, asks the operator to broadcast payout-to-seller (95/5 atomic split), then claims the stealth ATA into your main wallet ATA via a second operator-co-signed tx. Seller pays NO gas.",
      input_schema: {
        type: "object",
        properties: {
          quoteId: { type: "string", description: "Quote to redeem. Must be in PAID state." },
        },
      },
      async run({ quoteId }) {
        const id = quoteId || currentQuoteId;
        if (!id) throw new Error("No quoteId provided and none cached.");
        printStepBadge("Redeem (operator-signed payout)");
        const redeemStartedAt = Date.now();
        const result = await redeemSPR({
          baseUrl: RELAI_BASE_URL,
          serviceKey: SERVICE_KEY,
          quoteId: id,
          walletKeypair: SELLER_KEYPAIR,
        });
        const redeemMs = Date.now() - redeemStartedAt;
        printOnChainReceipt({
          label: `Redeem confirmed · 95% (${(Number(result.netAmountAtomic) / 1e6).toFixed(2)} USDC) → stealth ATA`,
          signature: result.redeemSignature,
          explorerUrl: result.redeemExplorerUrl,
          extra: `operator fee ${(Number(result.feeAmountAtomic) / 1e6).toFixed(4)} USDC · seller paid 0 gas`,
        });
        if (result.claimSignature) {
          printStepBadge("Claim (stealth → main wallet)");
          printOnChainReceipt({
            label: `Claim confirmed · ${(Number(result.netAmountAtomic) / 1e6).toFixed(2)} USDC → main wallet`,
            signature: result.claimSignature,
            explorerUrl: result.claimExplorerUrl,
            extra: `relayer signed as fee_payer · stealth keypair derived from wallet sig`,
          });
        }
        printPrivacyNote(
          "withdraw + claim events name the stealth + main wallets, but the buyer's deposit leaf is opaque on-chain — no graph edge between buyer and seller.",
        );
        writeSummaryFragment("seller", {
          sellerPubkey: SELLER_KEYPAIR.publicKey.toBase58(),
          quoteId: id,
          stealthPubkey: result.stealthPubkey,
          payoutTxHash: result.redeemSignature,
          payoutExplorerUrl: result.redeemExplorerUrl,
          claimTxHash: result.claimSignature,
          claimExplorerUrl: result.claimExplorerUrl,
          paidOutUsdc: Number(result.netAmountAtomic) / 1_000_000,
          operatorFeeUsdc: Number(result.feeAmountAtomic) / 1_000_000,
          redeemMs,
        });
        return {
          quoteId: id,
          status: result.alreadyRedeemed ? "redeemed (idempotent re-relay)" : "redeemed",
          paidOutUsdc: Number(result.netAmountAtomic) / 1_000_000,
          _privatePayoutTxHash: result.redeemSignature,
          _privateClaimTxHash: result.claimSignature,
          _privatePayoutExplorer: result.redeemExplorerUrl,
        };
      },
    },
  ];

  await runAgent({
    apiKey: ANTHROPIC_API_KEY,
    model: MODEL,
    systemBlocks: [
      PERSONA,
      `## Reference card: relai-spr-issue skill\n\n${issueSkill.body}\n\n## Reference card: relai-spr-redeem skill\n\n${redeemSkill.body}`,
    ],
    initialUserMessage:
      "You are now online. Wait for the buyer to open a conversation. React to their request — quote, issue an SPR payload, wait for them to pair, redeem, then deliver the translation.",
    tools,
    onAssistantText: (text) =>
      renderAssistantText({ prefix: PREFIX, accent: ACCENT, text }),
    onToolCall: ({ name, input }) => {
      if (name === "send_message" && typeof input?.body === "string") {
        if (!badgeFlags.negotiated) {
          printStepBadge("Negotiate");
          badgeFlags.negotiated = true;
        }
        if (badgeFlags.redeemed && !badgeFlags.delivered) {
          printStepBadge("Deliver translation");
          badgeFlags.delivered = true;
        }
        renderChatMessage({ speakerAccent: ACCENT, speakerName: SELF_NAME, body: input.body });
        return;
      }
      if (name === "relai_spr_redeem") badgeFlags.redeemed = true;
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
