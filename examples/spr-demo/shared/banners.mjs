// Pro-grade ASCII banners for the SPR demo agents. Same Unicode box-drawing
// style as the shielded-link demo, with SPR-specific copy: the SELLER
// initiates the protocol (issues the quote), the BUYER pays anonymously,
// the seller redeems.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

const W = 74;

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s, w) {
  const v = visibleLen(s);
  return v >= w ? s : s + " ".repeat(w - v);
}

function row(accent, content) {
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
  return `${DIM}${padRight(key, 9)}${RESET}${value}`;
}

export function printBuyerBanner({ pubkey, network, model, skill }) {
  const accent = CYAN;
  const rows = [
    blank(accent),
    row(accent, `  ${BOLD}${accent}ATLAS STUDIOS${RESET}`),
    row(accent, `  ${DIM}supplier-ops agent · Anthropic SDK · ${network}${RESET}`),
    blank(accent),
    row(accent, `  Buying a one-page translation. The supplier will issue a`),
    row(accent, `  RelAI shielded payment request; Atlas pays it anonymously`),
    row(accent, `  through Privacy Pool V4.1 — no on-chain link to its roster.`),
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
    row(accent, `  Bound by closure into the pay tool — only the parsed quote`),
    row(accent, `  payload is an LLM input. Signing happens outside the model.`),
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
    row(accent, `  Issues SPR quotes for every job — keeps the client list a`),
    row(accent, `  competitive moat. Operator-relayed payouts mean Kana never`),
    row(accent, `  signs a Solana tx and never holds gas.`),
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
    row(accent, `  The pool relayer signs verify_and_record + payout_to_seller`),
    row(accent, `  with an atomic 95/5 fee split. Receive address is just a key.`),
    blank(accent),
  ];
  console.log(box(accent, rows));
}
