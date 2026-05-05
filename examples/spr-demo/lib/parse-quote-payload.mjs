// Pure-Node port of the frontend's `parseShieldedQuotePayload`
// (`frontend/src/lib/shielded-payment-requests.ts`). Decodes any of:
//
//   "relai:quote:<base64url>"      ← canonical compact form, Faza 1+
//   "quote:<base64url>" / "q:..."  ← legacy short prefixes
//   "https://…/payment-requests/fulfill#relai:quote:<base64url>"
//   raw JSON string `{ "v":1, "q":"...", ... }` (some debug paths)
//
// Returns the same `ShieldedQuotePayload` shape the frontend uses:
//
//   {
//     v: 1,
//     quoteId, poolId, amount, sellerSecret, nonce, expiry,
//     description?, network?, sellerEncPk?
//   }
//
// All field naming mirrors the canonical short keys (q/p/a/s/n/e/d/w/k)
// produced by the server's `generateQuotePayload` in
// `server/src/services/shielded/payment-requests/payload.js`.

const QUOTE_PREFIXES = ["relai:quote:", "quote:", "q:"];

function fromBase64Url(b64url) {
  const std = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractToken(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  for (const prefix of QUOTE_PREFIXES) {
    if (lowered.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || null;
  }
  // URL forms (?quote=… or #relai:quote:…)
  try {
    const url = new URL(trimmed);
    const direct = url.searchParams.get("quote");
    if (direct) return direct.trim() || null;
    const hash = url.hash.replace(/^#/, "");
    if (hash.startsWith("quote=")) return decodeURIComponent(hash.slice("quote=".length)).trim() || null;
    for (const prefix of QUOTE_PREFIXES) {
      if (hash.toLowerCase().startsWith(prefix)) return hash.slice(prefix.length).trim() || null;
    }
  } catch { /* not a URL — fall through */ }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const quoteId = String(raw.quoteId ?? raw.q ?? "").trim();
  const poolId = String(raw.poolId ?? raw.p ?? "").trim();
  const amount = String(raw.amount ?? raw.a ?? "").trim();
  const sellerSecret = String(raw.sellerSecret ?? raw.s ?? "").trim();
  const nonce = String(raw.nonce ?? raw.n ?? "").trim();
  const expiry = Number(raw.expiry ?? raw.e);
  if (!quoteId || !poolId || !amount || !sellerSecret || !nonce || !Number.isFinite(expiry)) {
    return null;
  }
  return {
    v: Number(raw.v ?? raw.version ?? 1) || 1,
    quoteId,
    poolId,
    amount,
    sellerSecret,
    nonce,
    expiry,
    description: String(raw.description ?? raw.d ?? "").trim() || undefined,
    network: String(raw.network ?? raw.w ?? "").trim() || undefined,
    sellerEncPk: String(raw.sellerEncPk ?? raw.k ?? "").trim() || undefined,
  };
}

export function parseShieldedQuotePayload(input) {
  const token = extractToken(input);
  if (!token) return null;
  const json = token.startsWith("{") ? token : fromBase64Url(token);
  if (!json) return null;
  let parsed;
  try { parsed = JSON.parse(json); } catch { return null; }
  return normalize(parsed);
}
