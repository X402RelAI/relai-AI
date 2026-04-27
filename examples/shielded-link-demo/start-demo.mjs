// Orchestrator: spawns the chat bus + the two agent processes, lets each
// agent's pre-coloured stdout pass through, and tears everything down on
// agent exit, Ctrl-C, or fatal error.
//
// Signal handling: Node does not auto-propagate SIGINT/SIGTERM to spawned
// children. We register handlers, send SIGTERM, wait `GRACE_MS`, then SIGKILL
// any laggards. Parent exit code propagates the worst child exit code.

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

// Spawn children via the local `tsx` binary so the .ts imports inside lib/
// resolve. Plain `node` cannot load TypeScript or rewrite the `.js` extension
// → `.ts` source mapping that NodeNext convention requires.
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
  "RELAI_SELLER_SOLANA_PUBKEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  console.error(`Copy .env.example to .env and fill in the values.`);
  process.exit(1);
}

async function main() {
  // Stamp the demo origin so step-badge timings in both agent processes
  // share the same wall clock anchor (read via env + a tiny tmp file).
  const runId = crypto.randomBytes(6).toString("hex");
  process.env.SHIELDED_DEMO_RUN_ID = runId;
  const demoStart = markDemoStart();
  // Wipe any leftover summary fragments from a previous run (defensive — the
  // runId is fresh, so collisions are impossible, but keeps tmpdir tidy).
  clearSummaryFragments(runId);

  const bus = await startChatBus({ port: PORT });

  printOpeningBanner({
    network: process.env.DEMO_NETWORK || "solana-devnet",
    model: "claude-sonnet-4-6",
  });
  console.log(`\x1b[2mchat-bus on http://localhost:${PORT}  ·  spawning buyer + seller agents…\x1b[0m\n`);

  const childEnv = {
    ...process.env,
    FORCE_COLOR: "1",
    SHIELDED_DEMO_RUN_ID: runId,
  };

  const buyer = spawn(
    TSX_BIN,
    [path.join(__dirname, "agent-buyer.mjs")],
    { env: childEnv, stdio: ["ignore", "inherit", "inherit"] },
  );
  const seller = spawn(
    TSX_BIN,
    [path.join(__dirname, "agent-seller.mjs")],
    { env: childEnv, stdio: ["ignore", "inherit", "inherit"] },
  );

  const children = [
    { proc: buyer, name: "buyer", exitCode: null },
    { proc: seller, name: "seller", exitCode: null },
  ];

  function renderSummary() {
    const frags = readSummaryFragments(runId);
    if (!frags.buyer && !frags.seller) return; // demo aborted before any data
    const totalMs = Date.now() - demoStart;
    printDealCompleteSummary({
      buyerLabel: "Atlas Studios",
      sellerLabel: "Kana Translation Co.",
      amountUsdc: frags.buyer?.amountUsdc ?? "—",
      description: frags.buyer?.description ?? null,
      buyerPubkey: frags.buyer?.buyerPubkey,
      sellerPubkey: frags.seller?.sellerPubkey,
      depositTxHash: frags.buyer?.depositTxHash,
      depositExplorerUrl: frags.buyer?.depositExplorerUrl,
      payoutTxHash: frags.seller?.payoutTxHash,
      payoutExplorerUrl: frags.seller?.payoutExplorerUrl,
      timings: {
        depositMs: frags.buyer?.depositMs,
        // We don't separately measure proof vs withdraw — bundle as redeemMs.
        // Show under "on-chain withdraw" since that's the user-visible event.
        withdrawMs: frags.seller?.redeemMs,
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
          // process may already be gone
        }
      }
    }
    // Hard fallback: SIGKILL after grace period if anyone is still alive.
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
      // Map signal exits to the conventional 128 + signum.
      const SIGNAL_NUMS = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };
      c.exitCode = code ?? (signal ? 128 + (SIGNAL_NUMS[signal] ?? 0) : 1);
      console.log(`[orchestrator] ${c.name} exited (code=${code} signal=${signal ?? "—"})`);

      const allDone = children.every((x) => x.exitCode != null);
      if (allDone) {
        // Defer briefly so the children's last stdout flushes before we
        // print the summary panel.
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
