// Pretty-print module for hackathon demo output.
//
// Two render modes:
//   - Assistant text: prefix · 💬 · message body, multi-line indented
//   - Tool call: prefix · ⠋ · name(args)   ← pulsing gray (animated, gray-light
//     to gray-dark) while the tool runs, then replaced in place by:
//                  prefix · ✓ · name(args)   ← dim gray on success
//                  prefix · ✗ · name — err   ← red on failure
//
// Shared stdout — the pulse uses \r so a single line is overwritten in place.
// Two concurrent processes sharing a TTY can briefly clobber each other; in
// the 3-terminal mode (each agent in its own pane) there's no conflict.

import process from "node:process";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";

// 256-color gray palette — pulse cycles through these to give the
// "breathing" gray-light → gray-dark effect requested for tool calls.
const GRAY_DARKEST = "\x1b[38;5;236m";
const GRAY_DARK = "\x1b[38;5;240m";
const GRAY_MID = "\x1b[38;5;244m";
const GRAY_LIGHT = "\x1b[38;5;249m";
const PULSE_PALETTE = [
  GRAY_DARKEST, GRAY_DARK, GRAY_MID, GRAY_LIGHT,
  GRAY_LIGHT, GRAY_MID, GRAY_DARK, GRAY_DARKEST,
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE_MS = 90;

// One pulse handle at a time per process — agent-loop runs tools sequentially.
let active = null;

// Keep the whole spinner line ≤ ~70 visible cols. Anything longer wraps in
// most terminals, breaking the in-place \r overwrite. Prefix + spinner + name
// already eat ~30 cols, leaving ~40 for the args.
function fmtInput(input, max = 40) {
  if (input == null) return "";
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    return "";
  }
  if (!s || s === "{}") return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

/**
 * Render a multi-line assistant message with a chat icon and indented body.
 * The first line stays on the same line as the prefix; subsequent lines align
 * under the message text.
 */
export function renderAssistantText({ prefix, accent, text }) {
  // If a pulse is currently active, finalize the line so we don't overwrite it.
  if (active) endToolPulse({ success: true });

  const trimmed = text.trim();
  if (!trimmed) return;
  const lines = trimmed.split("\n");
  const head = `${accent}${BOLD}${prefix}${RESET}  💬  ${lines[0]}`;
  process.stdout.write(head + "\n");

  // Indent continuation lines under the message text:
  // visible prefix has length: prefix + 2 spaces + emoji (2 cols) + 2 spaces.
  const indent = " ".repeat(prefix.length + 6);
  for (let i = 1; i < lines.length; i += 1) {
    process.stdout.write(`${indent}${lines[i]}\n`);
  }
}

/**
 * Begin a pulsing gray spinner line for a tool call. Returns immediately —
 * call `endToolPulse` when the tool resolves or rejects.
 */
export function startToolPulse({ prefix, accent, name, input }) {
  if (active) endToolPulse({ success: true });

  const argStr = fmtInput(input);
  const callSig = argStr ? `${name}(${argStr})` : `${name}()`;

  let frame = 0;
  const draw = () => {
    const spin = SPINNER[frame % SPINNER.length];
    const shade = PULSE_PALETTE[frame % PULSE_PALETTE.length];
    clearLine();
    process.stdout.write(
      `${accent}${prefix}${RESET}  ${shade}${spin}  ${callSig}${RESET}`,
    );
  };

  draw();
  const interval = setInterval(() => {
    frame += 1;
    draw();
  }, PULSE_MS);

  active = { interval, prefix, accent, callSig };
}

/**
 * Replace the pulsing line with a final-state line (✓ or ✗) and a newline.
 */
export function endToolPulse({ success, summary }) {
  if (!active) return;
  const { interval, prefix, accent, callSig } = active;
  clearInterval(interval);
  active = null;

  clearLine();
  if (success) {
    const line =
      `${accent}${prefix}${RESET}  ${DIM}✓${RESET}  ${DIM}${callSig}${RESET}` +
      (summary ? `  ${DIM}→ ${summary}${RESET}` : "");
    process.stdout.write(line + "\n");
  } else {
    const line =
      `${accent}${prefix}${RESET}  ${RED}✗${RESET}  ${callSig}` +
      (summary ? `  ${RED}— ${summary}${RESET}` : "");
    process.stdout.write(line + "\n");
  }
}

/**
 * Print a status line (no spinner, no pulse) — used for boot info, pre-flight,
 * skill loading. Plain dim gray with a small bullet.
 */
export function renderStatus({ prefix, accent, text }) {
  if (active) endToolPulse({ success: true });
  if (!text) return;
  process.stdout.write(
    `${accent}${prefix}${RESET}  ${DIM}·  ${text}${RESET}\n`,
  );
}

// ── Chat-bubble rendering ───────────────────────────────────────────────────
//
// Renders chat messages as a transcript: the speaker's name + a colored
// bullet, with the message body indented underneath. Directionality (sent
// vs received) is deliberately dropped — the speaker's identity carries the
// info implicitly, and a chat reads more naturally without "to X" / "from Y".

const CHAT_INDENT = "   ";
const WRAP_WIDTH = 80;

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

/**
 * Render one chat message: bullet + speaker name (in accent color, bold),
 * body indented underneath. Use the SAME helper for both outbound (the agent
 * itself sending) and inbound (the peer's reply received via long-poll) — the
 * caller is responsible for passing the correct speaker name + accent so the
 * peer's messages always appear with the peer's color regardless of which
 * agent process is rendering.
 */
export function renderChatMessage({ speakerAccent, speakerName, body }) {
  if (active) endToolPulse({ success: true });
  // Blank line above each turn for breathing room — makes the conversation
  // feel like a chat log rather than dense log output.
  process.stdout.write("\n");
  process.stdout.write(
    `${speakerAccent}●${RESET}  ${speakerAccent}${BOLD}${speakerName}${RESET}\n`,
  );
  for (const line of softWrap(body.trim(), WRAP_WIDTH)) {
    process.stdout.write(`${CHAT_INDENT}${line}\n`);
  }
}

export function renderChatTimeout({ prefix, accent }) {
  if (active) endToolPulse({ success: true });
  process.stdout.write(
    `${accent}${prefix}${RESET}  ${DIM}·  poll timeout — listening again${RESET}\n`,
  );
}

/**
 * Best-effort one-liner summary extractor for tool results. Returns null when
 * nothing useful can be surfaced (call site falls back to no summary).
 */
export function summarizeToolResult(rawResult) {
  if (typeof rawResult !== "string") return null;
  // Tool results stringified by agent-loop are usually JSON. Try to extract
  // a salient field.
  let parsed;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    // Not JSON — return first line, truncated.
    const first = rawResult.split("\n")[0].trim();
    return first.length > 70 ? first.slice(0, 69) + "…" : first || null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  // Known shapes — surface the most informative field.
  if (parsed.shieldedLinkId && parsed.payoutTxHash) {
    return `redeemed · ${parsed.shieldedLinkId.slice(0, 8)}…`;
  }
  if (parsed.shieldedLinkId && parsed.shieldedLinkPayload) {
    return `link ${parsed.shieldedLinkId.slice(0, 8)}…  fee ${parsed.feeUsdc} USDC`;
  }
  if (parsed.from && parsed.body) {
    const snippet = parsed.body.slice(0, 60).replace(/\n/g, " ");
    return `from ${parsed.from} · ${snippet}${parsed.body.length > 60 ? "…" : ""}`;
  }
  if (parsed.timeout === true) {
    return "timeout — re-poll";
  }
  if (parsed.ok === true && parsed.ts) {
    return "delivered";
  }
  if (parsed.buyerPubkey) {
    return `${parsed.buyerPubkey.slice(0, 8)}…  SOL=${(parsed.solLamports / 1e9).toFixed(2)}  USDC=${(Number(parsed.usdcMicro) / 1e6).toFixed(2)}`;
  }
  return null;
}
