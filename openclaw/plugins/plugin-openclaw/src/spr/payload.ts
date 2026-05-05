// Parse `relai:quote:<base64url>` payloads — seller-side emission +
// buyer/seller-side consumption.
//
// Authoritative shape mirrors the server's `generateQuotePayload` (in
// `server/src/services/shielded/payment-requests/payload.js`) and the
// reference Node parser at `examples/spr-agent/src/parse-quote-payload.mjs`:
//
//   v: payload version (currently 1)
//   q: quoteId
//   p: poolId             (e.g. "solana-devnet-spr")
//   a: amount             (atomic units, string)
//   s: sellerSecret       (string)
//   n: nonce              (string)
//   e: expiry             (unix seconds)
//   d: description        (optional, ≤ 100 chars)
//   w: network            (optional, e.g. "solana-devnet")
//   k: sellerEncPk        (optional X25519 base64url pubkey, Solana sealed bundle)
//
// The payload does NOT carry the commitment or the quoteNullifier — both
// are deterministic from (amount, sellerSecret, nonce, quoteId), so any
// holder of the payload can recompute them via the pairing/redeem
// circuits' Poseidon helpers.

const PREFIXES = ["relai:quote:", "quote:", "q:"] as const;

export type SprQuotePayload = {
  version: number;
  quoteId: string;
  poolId: string;
  amount: string;
  sellerSecret: string;
  nonce: string;
  expiry: number;
  description?: string;
  network?: string;
  sellerEncPk?: string;
};

function fromBase64Url(token: string): string {
  return Buffer.from(token, "base64url").toString("utf8");
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function extractToken(input: string): string | null {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || null;
  }
  try {
    const u = new URL(trimmed);
    const direct = u.searchParams.get("quote");
    if (direct) return direct.trim() || null;
    const hash = u.hash.replace(/^#/, "");
    if (hash.startsWith("quote=")) {
      return decodeURIComponent(hash.slice("quote=".length)).trim() || null;
    }
    for (const prefix of PREFIXES) {
      if (hash.toLowerCase().startsWith(prefix)) return hash.slice(prefix.length).trim() || null;
    }
  } catch {
    // not a URL
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

export function parseSprQuotePayload(input: string): SprQuotePayload | null {
  const token = extractToken(input);
  if (!token) return null;
  const json = token.startsWith("{") ? token : fromBase64Url(token);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const quoteId = String((raw as Record<string, unknown>).quoteId ?? raw.q ?? "").trim();
  const poolId = String((raw as Record<string, unknown>).poolId ?? raw.p ?? "").trim();
  const amount = String((raw as Record<string, unknown>).amount ?? raw.a ?? "").trim();
  const sellerSecret = String((raw as Record<string, unknown>).sellerSecret ?? raw.s ?? "").trim();
  const nonce = String((raw as Record<string, unknown>).nonce ?? raw.n ?? "").trim();
  const expiry = Number((raw as Record<string, unknown>).expiry ?? raw.e ?? 0);

  if (!quoteId || !poolId || !amount || !sellerSecret || !nonce || !Number.isFinite(expiry)) {
    return null;
  }

  return {
    version: Number(raw.v ?? raw.version ?? 1) || 1,
    quoteId,
    poolId,
    amount,
    sellerSecret,
    nonce,
    expiry,
    description: String((raw as Record<string, unknown>).description ?? raw.d ?? "").trim() || undefined,
    network: String((raw as Record<string, unknown>).network ?? raw.w ?? "").trim() || undefined,
    sellerEncPk: String((raw as Record<string, unknown>).sellerEncPk ?? raw.k ?? "").trim() || undefined,
  };
}

export function encodeSprQuotePayload(p: SprQuotePayload): string {
  const compact: Record<string, unknown> = {
    v: p.version || 1,
    q: p.quoteId,
    p: p.poolId,
    a: p.amount,
    s: p.sellerSecret,
    n: p.nonce,
    e: p.expiry,
  };
  if (p.description) compact.d = p.description;
  if (p.network) compact.w = p.network;
  if (p.sellerEncPk) compact.k = p.sellerEncPk;
  return `relai:quote:${toBase64Url(JSON.stringify(compact))}`;
}
