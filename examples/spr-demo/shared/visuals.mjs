// Hackathon-grade visual helpers — opening banner, step badges, final
// summary panel. Mirrors shielded-link-demo's visuals.mjs but with SPR
// labels (the seller initiates, the buyer pays anonymously, the seller
// redeems with a 95/5 fee split).

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const ACCENT = "\x1b[38;5;141m"; // soft purple — distinguishes SPR from shielded-link blue
const GOLD = "\x1b[38;5;220m";
const GREEN = "\x1b[38;5;78m";
const GRAY_DARK = "\x1b[38;5;240m";
const GRAY_MID = "\x1b[38;5;245m";
const GRAY_LIGHT = "\x1b[38;5;250m";

const W = 78;

function pad(text, w) {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  if (visible >= w) return text;
  return text + " ".repeat(w - visible);
}

let demoStartedAt = null;

function startMarkerPath(runId) {
  return path.join(os.tmpdir(), `relai-spr-demo-start-${runId || "default"}`);
}

export function markDemoStart() {
  demoStartedAt = Date.now();
  try {
    fs.writeFileSync(
      startMarkerPath(process.env.SPR_DEMO_RUN_ID),
      String(demoStartedAt),
      "utf8",
    );
  } catch {
    // ignore
  }
  return demoStartedAt;
}

function getDemoOrigin() {
  if (demoStartedAt) return demoStartedAt;
  try {
    const file = startMarkerPath(process.env.SPR_DEMO_RUN_ID);
    if (fs.existsSync(file)) {
      const ts = Number(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(ts)) {
        demoStartedAt = ts;
        return ts;
      }
    }
  } catch {
    // ignore
  }
  demoStartedAt = Date.now();
  return demoStartedAt;
}

function fragmentPath(runId, role) {
  return path.join(os.tmpdir(), `relai-spr-demo-summary-${runId || "default"}-${role}.json`);
}

export function writeSummaryFragment(role, data) {
  try {
    fs.writeFileSync(
      fragmentPath(process.env.SPR_DEMO_RUN_ID, role),
      JSON.stringify(data),
      "utf8",
    );
  } catch {
    // ignore
  }
}

export function readSummaryFragments(runId) {
  const out = { buyer: null, seller: null };
  for (const role of ["buyer", "seller"]) {
    try {
      const file = fragmentPath(runId, role);
      if (fs.existsSync(file)) {
        out[role] = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    } catch {
      // ignore
    }
  }
  return out;
}

export function clearSummaryFragments(runId) {
  for (const role of ["buyer", "seller"]) {
    try {
      const file = fragmentPath(runId, role);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  try {
    const file = startMarkerPath(runId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

function fmtElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function printOpeningBanner({ network, model } = {}) {
  const lines = [
    "",
    `${ACCENT}╔${"═".repeat(W)}╗${RESET}`,
    `${ACCENT}║${RESET}${pad("", W)}${ACCENT}║${RESET}`,
    `${ACCENT}║${RESET}${pad(`     ${BOLD}🧾  RELAI · SHIELDED PAYMENT REQUESTS · LIVE DEMO${RESET}`, W)}${ACCENT}║${RESET}`,
    `${ACCENT}║${RESET}${pad("", W)}${ACCENT}║${RESET}`,
    `${ACCENT}║${RESET}${pad(`     ${DIM}Seller-issued opaque quote · Buyer pays anonymously · 95/5 split${RESET}`, W)}${ACCENT}║${RESET}`,
    `${ACCENT}║${RESET}${pad(`     ${DIM}Privacy Pool V4.1 · Two Groth16 proofs · Operator-relayed${RESET}`, W)}${ACCENT}║${RESET}`,
    `${ACCENT}║${RESET}${pad("", W)}${ACCENT}║${RESET}`,
  ];
  if (network || model) {
    lines.push(
      `${ACCENT}║${RESET}${pad(
        `     ${DIM}network${RESET}  ${network ?? "—"}   ${DIM}model${RESET}  ${model ?? "—"}`,
        W,
      )}${ACCENT}║${RESET}`,
    );
    lines.push(`${ACCENT}║${RESET}${pad("", W)}${ACCENT}║${RESET}`);
  }
  lines.push(`${ACCENT}╚${"═".repeat(W)}╝${RESET}`);
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

let stepCounter = 0;

export function printStepBadge(label) {
  stepCounter += 1;
  const elapsed = fmtElapsed(Date.now() - getDemoOrigin());
  const STEP = `${BOLD}STEP ${stepCounter}${RESET}`;
  const LABEL = `${BOLD}${ACCENT}${label.toUpperCase()}${RESET}`;
  const TIME = `${DIM}${elapsed}${RESET}`;
  const left = `${GRAY_DARK}───${RESET} ${STEP} ${GRAY_DARK}·${RESET} ${LABEL} `;
  const right = ` ${TIME} ${GRAY_DARK}───${RESET}`;
  const visibleLen = `─── STEP ${stepCounter} · ${label.toUpperCase()}  ${elapsed} ───`.length;
  const fillCount = Math.max(3, W - visibleLen);
  const fill = `${GRAY_DARK}${"─".repeat(fillCount)}${RESET}`;
  process.stdout.write("\n" + left + fill + right + "\n");
}

const TRACE_GLYPHS = {
  http: { glyph: "→", color: GRAY_LIGHT },
  chain: { glyph: "⛓", color: GREEN },
  compute: { glyph: "∑", color: GOLD },
};

export function printMethodTrace({ kind = "http", label, ms }) {
  const indent = "       ";
  const meta = TRACE_GLYPHS[kind] ?? TRACE_GLYPHS.http;
  const time = ms != null ? `${String(ms).padStart(5)} ms` : "       ";
  const labelMax = 56;
  const trimmed = label.length > labelMax ? label.slice(0, labelMax - 1) + "…" : label;
  const padded = trimmed + " ".repeat(Math.max(0, labelMax - trimmed.length));
  process.stdout.write(
    `${indent}${meta.color}${meta.glyph}${RESET}  ${DIM}${padded}${RESET} ${GRAY_MID}${time}${RESET}\n`,
  );
}

export async function traceMethod({ kind = "http", label }, thunk) {
  const t0 = Date.now();
  try {
    const out = await thunk();
    printMethodTrace({ kind, label, ms: Date.now() - t0 });
    return out;
  } catch (err) {
    printMethodTrace({ kind, label: `${label}  (err)`, ms: Date.now() - t0 });
    throw err;
  }
}

export function printPrivacyNote(text) {
  const indent = "       ";
  const wrapped = softWrap(text, W - indent.length - 4);
  for (const [i, line] of wrapped.entries()) {
    const prefix = i === 0 ? `${GOLD}▸${RESET}  ` : "   ";
    process.stdout.write(`${indent}${prefix}${DIM}${line}${RESET}\n`);
  }
}

function softWrap(text, width) {
  const out = [];
  for (const segment of text.split("\n")) {
    if (segment.length <= width) {
      out.push(segment);
      continue;
    }
    let line = "";
    for (const word of segment.split(" ")) {
      if (line.length + word.length + 1 > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function printOnChainReceipt({ label, signature, explorerUrl, extra }) {
  const indent = "       ";
  const sigShort = signature ? `${signature.slice(0, 8)}…${signature.slice(-6)}` : "—";
  process.stdout.write(`${indent}${GREEN}┃${RESET} ${BOLD}${label}${RESET}  ${DIM}${sigShort}${RESET}\n`);
  if (extra) {
    process.stdout.write(`${indent}${GREEN}┃${RESET} ${DIM}${extra}${RESET}\n`);
  }
  if (explorerUrl) {
    process.stdout.write(`${indent}${GREEN}┃${RESET} ${ACCENT}${explorerUrl}${RESET}\n`);
  }
}

export function printDealCompleteSummary({
  buyerLabel,
  sellerLabel,
  amountUsdc,
  description,
  buyerPubkey,
  sellerPubkey,
  stealthPubkey,
  depositTxHash,
  depositExplorerUrl,
  pairTxHash,
  pairExplorerUrl,
  payoutTxHash,
  payoutExplorerUrl,
  claimTxHash,
  claimExplorerUrl,
  paidOutUsdc,
  operatorFeeUsdc,
  timings,
} = {}) {
  const ROUND = "─";
  const TOP = `${ACCENT}╭${ROUND.repeat(W)}╮${RESET}`;
  const BOT = `${ACCENT}╰${ROUND.repeat(W)}╯${RESET}`;
  const SEP = `${ACCENT}├${ROUND.repeat(W)}┤${RESET}`;
  const row = (text) => `${ACCENT}│${RESET}${pad(text, W)}${ACCENT}│${RESET}`;
  const blank = () => row("");
  const header = (label) =>
    row(`  ${DIM}── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}${RESET}`);
  const truncPubkey = (pk) => (pk ? `${pk.slice(0, 10)}…${pk.slice(-6)}` : "—");
  const fmtMs = (ms) => (ms != null ? `${(ms / 1000).toFixed(1).padStart(5)} s` : "    — s");
  const totalLine = timings?.totalMs ? `${BOLD}${(timings.totalMs / 1000).toFixed(1)} s${RESET}` : "—";

  const lines = [
    "",
    "",
    TOP,
    blank(),
    row(`  ${BOLD}${GREEN}DEAL COMPLETE${RESET}    ${GRAY_LIGHT}${totalLine} end-to-end${RESET}`),
    blank(),
    row(
      `  ${ITALIC}${sellerLabel ?? "Seller"}${RESET} issued · ${ITALIC}${buyerLabel ?? "Buyer"}${RESET} paid ${BOLD}${amountUsdc} USDC${RESET}`,
    ),
    description ? row(`  ${DIM}for: ${description}${RESET}`) : null,
    paidOutUsdc != null
      ? row(
          `  ${DIM}seller received${RESET} ${BOLD}${paidOutUsdc} USDC${RESET}  ${DIM}·  operator fee${RESET} ${operatorFeeUsdc ?? "—"} USDC`,
        )
      : null,
    blank(),
    SEP,
    blank(),
    header("Privacy preserved on-chain"),
    row(`  ${GOLD}▸${RESET} buyer  ${DIM}${truncPubkey(buyerPubkey)}${RESET}  →  pool PDA`),
    stealthPubkey
      ? row(`  ${GOLD}▸${RESET} pool   →  ${DIM}stealth ${truncPubkey(stealthPubkey)}${RESET}  ${DIM}(operator pays out, 5% split)${RESET}`)
      : null,
    row(`  ${GOLD}▸${RESET} stealth →  ${DIM}${truncPubkey(sellerPubkey)}${RESET}  ${DIM}(operator co-signs claim)${RESET}`),
    row(`  ${GOLD}▸${RESET} ${DIM}no on-chain tx contains both buyer and seller addresses${RESET}`),
    blank(),
    ...(() => {
      const rows = [];
      if (!timings) return rows;
      const entries = [
        ["issue + handoff   ", timings.issueMs],
        ["buyer deposit     ", timings.depositMs],
        ["pairing relay     ", timings.pairMs],
        ["redeem proof      ", timings.proofMs],
        ["redeem relay      ", timings.redeemMs],
      ].filter(([, v]) => v != null);
      if (entries.length === 0) return rows;
      rows.push(SEP, blank(), header("Timings"));
      for (const [label, ms] of entries) {
        rows.push(row(`  ${GRAY_MID}${label}${RESET} ${fmtMs(ms)}`));
      }
      rows.push(blank());
      return rows;
    })(),
    SEP,
    blank(),
    header("Verifiable on-chain"),
    row(`  ${GOLD}▸${RESET} ${DIM}deposit ${RESET} ${ACCENT}${depositExplorerUrl ?? depositTxHash ?? "—"}${RESET}`),
    row(`  ${GOLD}▸${RESET} ${DIM}pair    ${RESET} ${ACCENT}${pairExplorerUrl ?? pairTxHash ?? "—"}${RESET}`),
    row(`  ${GOLD}▸${RESET} ${DIM}redeem  ${RESET} ${ACCENT}${payoutExplorerUrl ?? payoutTxHash ?? "—"}${RESET}`),
    claimExplorerUrl || claimTxHash
      ? row(`  ${GOLD}▸${RESET} ${DIM}claim   ${RESET} ${ACCENT}${claimExplorerUrl ?? claimTxHash}${RESET}`)
      : null,
    blank(),
    BOT,
    "",
  ].filter(Boolean);

  process.stdout.write(lines.join("\n") + "\n");
}
