// Pro-grade ASCII banners for the demo agents. Unicode box-drawing — clean
// at any terminal size, no figlet kitsch. One coloured accent per agent
// matching the live-log prefix tags (cyan for buyer, magenta for seller).

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// Inner width between the box borders, in visible characters.
const W = 74;

// Strip ANSI escape codes so we can measure visible length for padding.
function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s, w) {
  const v = visibleLen(s);
  return v >= w ? s : s + " ".repeat(w - v);
}

function row(accent, content) {
  // Each visible row is `│ <content padded to W> │`
  return `${accent}│${RESET} ${padRight(content, W - 2)} ${accent}│${RESET}`;
}

function blank(accent) {
  return row(accent, "");
}

function rule(accent) {
  return `${accent}├${"─".repeat(W)}┤${RESET}`;
}

function box(accent, contentRows) {
  const top = `${accent}┌${"─".repeat(W)}┐${RESET}`;
  const bot = `${accent}└${"─".repeat(W)}┘${RESET}`;
  return [top, ...contentRows, bot].join("\n");
}

function kv(key, value) {
  // Two-column "key   value" with consistent label width.
  return `${DIM}${padRight(key, 9)}${RESET}${value}`;
}

export function printBuyerBanner({ pubkey, network, model, skill }) {
  const accent = CYAN;
  const rows = [
    blank(accent),
    row(accent, `  ${BOLD}${accent}ATLAS STUDIOS${RESET}`),
    row(accent, `  ${DIM}supplier-ops agent · Anthropic SDK · ${network}${RESET}`),
    blank(accent),
    row(accent, `  Buying a one-page translation. Funds the deal through a`),
    row(accent, `  RelAI shielded link so the supplier never learns the wallet`),
    row(accent, `  that pays Atlas's roster.`),
    blank(accent),
    rule(accent),
    blank(accent),
    row(accent, `  ${kv("model", model)}`),
    row(accent, `  ${kv("skill", `${skill}  ${DIM}(loaded from .claude/skills)${RESET}`)}`),
    row(accent, `  ${kv("wallet", pubkey)}`),
    blank(accent),
    rule(accent),
    blank(accent),
    row(accent, `  ${BOLD}Privacy invariant${RESET}  ${DIM}·${RESET}  buyer keypair never reaches the LLM.`),
    row(accent, `  Bound by closure into the deposit tool — only the USDC amount`),
    row(accent, `  is an LLM input. Signing happens outside the model context.`),
    blank(accent),
  ];
  console.log(box(accent, rows));
}

export function printSellerBanner({ pubkey, network, model, skill }) {
  const accent = MAGENTA;
  const rows = [
    blank(accent),
    row(accent, `  ${BOLD}${accent}KANA TRANSLATION CO.${RESET}`),
    row(accent, `  ${DIM}solo JP→PL specialist · Anthropic SDK · ${network}${RESET}`),
    blank(accent),
    row(accent, `  Sells specialist translations. Accepts payment only through`),
    row(accent, `  RelAI shielded links so the client list stays a competitive`),
    row(accent, `  moat.`),
    blank(accent),
    rule(accent),
    blank(accent),
    row(accent, `  ${kv("model", model)}`),
    row(accent, `  ${kv("skill", `${skill}  ${DIM}(loaded from .claude/skills)${RESET}`)}`),
    row(accent, `  ${kv("receive", pubkey)}`),
    blank(accent),
    rule(accent),
    blank(accent),
    row(accent, `  ${BOLD}Privacy invariant${RESET}  ${DIM}·${RESET}  zero on-chain signing on this side.`),
    row(accent, `  The pool relayer signs the withdraw and pays the gas. The`),
    row(accent, `  receive address is just a pubkey, not a custodial wallet.`),
    blank(accent),
  ];
  console.log(box(accent, rows));
}
