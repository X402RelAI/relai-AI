// Seller agent — Claude reasoning loop driven by the .claude/skills/relai-shielded-receive
// skill. The seller never holds a private key on Solana — the relayer signs
// the on-chain withdraw and pays the gas. Only a destination pubkey is needed.

import "dotenv/config";
import path from "node:path";
import url from "node:url";
import { redeemShieldedLink } from "./lib/redeem.ts";
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
} from "./shared/visuals.mjs";

const MODEL = "claude-sonnet-4-6";
const PREFIX = "seller";
const ACCENT = "\x1b[35m"; // magenta
const SELF_NAME = "Kana Translation Co.";
const PEER_NAME = "Atlas Studios";
const PEER_ACCENT = "\x1b[36m"; // cyan — must match buyer's ACCENT

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
const SELLER_PUBKEY = env("RELAI_SELLER_SOLANA_PUBKEY");
const BUS_URL = `http://localhost:${env("CHAT_BUS_PORT", "4747")}`;
const SELF_ID = "seller-translator";
const PEER_ID = "buyer-atlas-studios";

const PERSONA = `You are an autonomous freelance agent representing **Kana Translation Co.**, a solo JP→PL specialist with technical-domain experience.
You operate independently — no human will reply mid-conversation. You raise issues by sending messages to the other agent or by ending your turn, never by waiting for human input.

## Your business

- Specialist JP→PL translation, technical terminology comfortable.
- Standard rate: **0.10 USDC per page** (a page = up to 500 chars JP).
- Turnaround: same hour for one-page jobs.

## Your privacy posture

Your client list is your competitive moat. You DO NOT want this buyer to learn your wallet address — they could correlate it to your other clients. You accept payment via **RelAI shielded links** only. The detailed protocol is in the reference card below — follow it exactly.

## Conduct

- Be terse, professional. Like a working translator agent.
- When asked for a quote: 0.10 USDC for one page, deliverable within the hour. Confirm you saw the source text in their message.
- Once the buyer says they sent the shielded link AND includes a \`relai:shielded:…\` string in a chat message, **immediately** call \`relai_shielded_redeem\` with that exact string and your destination address.
- After redeem succeeds, **actually translate** the Japanese source the buyer sent into Polish. Specialist quality, technical-domain terminology preserved (protocole, mikropłatności, łańcuch bloków, etc.). Send the translation back as a fenced \`\`\`pl code block, with no other commentary beyond a one-line "received" ack.
- If the proof fails with a retryable error (\`aspReady: false\`), wait ~12s and retry the same call up to 3 times.

## When the conversation reaches a natural end

After you've delivered the translation, output a final line beginning with "DEAL COMPLETE:" and stop calling tools. The orchestrator will tear everything down.`;

async function main() {
  printSellerBanner({
    pubkey: SELLER_PUBKEY,
    network: process.env.DEMO_NETWORK || "solana-devnet",
    model: MODEL,
    skill: "relai-shielded-receive",
  });

  const skill = loadSkill({
    skillsRoot: path.join(__dirname, "../../.claude/skills"),
    skillName: "relai-shielded-receive",
  });
  status(`skill loaded (${skill.refsCount} reference(s) inlined)`);

  // 3-terminal mode keeps the chat bus alive across runs — drop any stale
  // messages from previous runs so the seller doesn't react to a buyer
  // that already finished.
  try {
    const dropped = await clearInbox({ busUrl: BUS_URL, selfId: SELF_ID });
    if (dropped > 0) status(`cleared ${dropped} stale message(s) from inbox`);
  } catch (err) {
    status(`could not clear inbox (${err.message}) — continuing`);
  }

  status(`listening for inbound work on the chat bus…`);
  process.stdout.write("\n");

  const chatTools = makeChatTools({ busUrl: BUS_URL, selfId: SELF_ID, peerId: PEER_ID });

  const badgeFlags = { redeemed: false, delivered: false };

  const tools = [
    ...chatTools,
    {
      name: "relai_shielded_redeem",
      description:
        "Redeem a `relai:shielded:…` payload received from the buyer. Generates the Groth16 ASP proof locally and asks the RelAI pool relayer to broadcast the on-chain withdraw to your wallet. You pay no gas (relayer signs the tx). Returns the payout tx hash for your records ONLY — DO NOT relay to the buyer (it would let them link your withdraw event back to their deposit).",
      input_schema: {
        type: "object",
        properties: {
          shieldedLinkPayload: {
            type: "string",
            description:
              "The full `relai:shielded:<base64url>` string the buyer sent you. Pass verbatim — do not modify.",
          },
        },
        required: ["shieldedLinkPayload"],
      },
      async run({ shieldedLinkPayload }) {
        printStepBadge("ZK proof + withdraw");
        const redeemStartedAt = Date.now();
        const result = await redeemShieldedLink({
          baseUrl: RELAI_BASE_URL,
          serviceKey: SERVICE_KEY,
          shieldedLinkPayload,
          targetAddress: SELLER_PUBKEY,
        });
        const redeemMs = Date.now() - redeemStartedAt;
        printOnChainReceipt({
          label: `Withdraw confirmed · status ${result.status}`,
          signature: result.payoutTxHash,
          explorerUrl: result.payoutExplorerUrl,
          extra: `signed by pool relayer · seller paid 0 gas`,
        });
        printPrivacyNote(
          "this withdraw event names the seller wallet but the source commitment is opaque — no on-chain link back to the buyer's deposit.",
        );
        writeSummaryFragment("seller", {
          sellerPubkey: SELLER_PUBKEY,
          payoutTxHash: result.payoutTxHash,
          payoutExplorerUrl: result.payoutExplorerUrl,
          status: result.status,
          redeemMs,
        });
        return {
          status: result.status,
          shieldedLinkId: result.shieldedLinkId,
          // Privacy-sensitive — seller agent must NOT relay these to the buyer.
          _privatePayoutTxHash: result.payoutTxHash,
          _privatePayoutExplorer: result.payoutExplorerUrl,
          _privateNullifier: result.nullifier,
        };
      },
    },
  ];

  await runAgent({
    apiKey: ANTHROPIC_API_KEY,
    model: MODEL,
    systemBlocks: [
      PERSONA,
      `## Reference card: relai-shielded-receive skill\n\n${skill.body}`,
    ],
    initialUserMessage:
      "You are now online and listening for inbound work. Begin by polling the chat bus for any incoming message from a prospective client. React to whatever they say.",
    tools,
    onAssistantText: (text) =>
      renderAssistantText({ prefix: PREFIX, accent: ACCENT, text }),
    onToolCall: ({ name, input }) => {
      if (name === "send_message" && typeof input?.body === "string") {
        // Last seller message that contains a Polish translation = step 5 (Deliver).
        // Heuristic: any seller send_message AFTER redeem is the delivery.
        if (badgeFlags.redeemed && !badgeFlags.delivered) {
          printStepBadge("Deliver translation");
          badgeFlags.delivered = true;
        }
        renderChatMessage({
          speakerAccent: ACCENT,
          speakerName: SELF_NAME,
          body: input.body,
        });
        return;
      }
      if (name === "relai_shielded_redeem") {
        badgeFlags.redeemed = true;
      }
      startToolPulse({ prefix: PREFIX, accent: ACCENT, name, input });
    },
    onToolResult: ({ name, result, isError }) => {
      if (name === "send_message") return;
      if (name === "wait_for_message" && !isError) {
        try {
          const parsed = JSON.parse(result);
          if (parsed?.timeout) {
            renderChatTimeout({ prefix: PREFIX, accent: ACCENT });
          } else if (typeof parsed?.body === "string") {
            renderChatMessage({
              speakerAccent: PEER_ACCENT,
              speakerName: PEER_NAME,
              body: parsed.body,
            });
          }
          return;
        } catch {
          // fall through
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
