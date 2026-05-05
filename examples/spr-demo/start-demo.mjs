// Orchestrator: spawns the chat bus + the two SPR agents, lets each agent's
// pre-coloured stdout pass through, and tears everything down on agent exit,
// Ctrl-C, or fatal error.

import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import { startChatBus } from "./shared/chat-bus.mjs";
import {
  printOpeningBanner,
  printDealCompleteSummary,
  markDemoStart,
  readSummaryFragments,
  clearSummaryFragments,
} from "./shared/visuals.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.CHAT_BUS_PORT || 4747);
const GRACE_MS = 5_000;

const TSX_BIN = path.join(__dirname, "node_modules", ".bin", "tsx");
if (!fs.existsSync(TSX_BIN)) {
  console.error(`tsx binary missing at ${TSX_BIN}. Run \`npm install\` first.`);
  process.exit(1);
}

const required = [
  "ANTHROPIC_API_KEY",
  "RELAI_SERVICE_KEY_BUYER",
  "RELAI_SERVICE_KEY_SELLER",
  "RELAI_BUYER_SOLANA_SECRET_KEY",
  "RELAI_SELLER_SOLANA_SECRET_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  console.error(`Copy .env.example to .env and fill in the values.`);
  process.exit(1);
}

async function main() {
  const runId = crypto.randomBytes(6).toString("hex");
  process.env.SPR_DEMO_RUN_ID = runId;
  const demoStart = markDemoStart();
  clearSummaryFragments(runId);

  const bus = await startChatBus({ port: PORT });

  printOpeningBanner({
    network: process.env.DEMO_NETWORK || "solana-devnet",
    model: "claude-sonnet-4-6",
  });
  console.log(
    `\x1b[2mchat-bus on http://localhost:${PORT}  ·  spawning seller + buyer agents…\x1b[0m\n`,
  );

  const childEnv = {
    ...process.env,
    FORCE_COLOR: "1",
    SPR_DEMO_RUN_ID: runId,
  };

  // Seller starts first — listens for the buyer's opening message.
  const seller = spawn(
    TSX_BIN,
    [path.join(__dirname, "agent-seller.mjs")],
    { env: childEnv, stdio: ["ignore", "inherit", "inherit"] },
  );
  const buyer = spawn(
    TSX_BIN,
    [path.join(__dirname, "agent-buyer.mjs")],
    { env: childEnv, stdio: ["ignore", "inherit", "inherit"] },
  );

  const children = [
    { proc: seller, name: "seller", exitCode: null },
    { proc: buyer, name: "buyer", exitCode: null },
  ];

  function renderSummary() {
    const frags = readSummaryFragments(runId);
    if (!frags.buyer && !frags.seller) return;
    const totalMs = Date.now() - demoStart;
    printDealCompleteSummary({
      buyerLabel: "Atlas Studios",
      sellerLabel: "Kana Translation Co.",
      amountUsdc: frags.seller?.amountUsdc ?? frags.buyer?.amountUsdc ?? "—",
      description: frags.seller?.description ?? null,
      buyerPubkey: frags.buyer?.buyerPubkey,
      sellerPubkey: frags.seller?.sellerPubkey,
      stealthPubkey: frags.seller?.stealthPubkey,
      depositTxHash: frags.buyer?.depositTxHash,
      depositExplorerUrl: frags.buyer?.depositExplorerUrl,
      pairTxHash: frags.buyer?.pairTxHash,
      pairExplorerUrl: frags.buyer?.pairExplorerUrl,
      payoutTxHash: frags.seller?.payoutTxHash,
      payoutExplorerUrl: frags.seller?.payoutExplorerUrl,
      claimTxHash: frags.seller?.claimTxHash,
      claimExplorerUrl: frags.seller?.claimExplorerUrl,
      paidOutUsdc: frags.seller?.paidOutUsdc,
      operatorFeeUsdc: frags.seller?.operatorFeeUsdc,
      timings: {
        issueMs: frags.seller?.issueMs,
        depositMs: frags.buyer?.payMs,
        redeemMs: frags.seller?.redeemMs,
        totalMs,
      },
    });
    clearSummaryFragments(runId);
  }

  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log();
    console.log(`──────────────── shutdown: ${reason} ────────────────`);
    for (const c of children) {
      if (c.exitCode == null) {
        try {
          c.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    setTimeout(() => {
      for (const c of children) {
        if (c.exitCode == null) {
          console.error(`[orchestrator] ${c.name} did not exit within ${GRACE_MS / 1000}s — SIGKILL`);
          try {
            c.proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
      bus.close();
    }, GRACE_MS).unref();
  }

  for (const c of children) {
    c.proc.on("exit", (code, signal) => {
      const SIGNAL_NUMS = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };
      c.exitCode = code ?? (signal ? 128 + (SIGNAL_NUMS[signal] ?? 0) : 1);
      console.log(`[orchestrator] ${c.name} exited (code=${code} signal=${signal ?? "—"})`);

      const allDone = children.every((x) => x.exitCode != null);
      if (allDone) {
        setTimeout(() => {
          renderSummary();
          shutdown("both agents done");
          const worst = Math.max(...children.map((x) => x.exitCode ?? 0));
          setTimeout(() => process.exit(worst), 100).unref();
        }, 200).unref();
      } else if (c.exitCode !== 0) {
        shutdown(`${c.name} died (code ${c.exitCode})`);
      }
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
