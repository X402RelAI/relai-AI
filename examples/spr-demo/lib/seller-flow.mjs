// Seller agent helpers — programmatic create/issue/list/cancel of
// SPR quotes via the service-key-gated `/v1/shielded-payment-requests`
// API. Mirror of what a human seller does in the browser dashboard
// (`frontend/src/app/payment-requests/create` + `seller`), without any
// React or wallet adapter — a plain Node process with a service key
// can spin up quotes and stream their status.
//
// Scope:
//   - createDraftQuote()     — POST /v1/shielded-payment-requests
//   - issueQuote()           — POST /v1/shielded-payment-requests/:id/issue
//   - listQuotes()           — GET  /v1/shielded-payment-requests
//   - cancelQuote()          — POST /v1/shielded-payment-requests/:id/cancel
//   - getMatchStatus()       — GET  /facilitator/shielded-payment-requests/:id/match-status
//
// All methods return whatever the server returned, lightly typed via
// JSDoc. Service key handling is the agent's responsibility — same
// posture as `examples/shielded-agent/`.
//
// `sellerEncPk` is OPTIONAL. If you provide it, the buyer's frontend
// (or another agent reading the quote payload) can encrypt the proof
// bundle for you before sharing — turns proof URLs into ciphertext-
// only artefacts that only your wallet's signMessage-derived key can
// decrypt. See `frontend/src/lib/seller-encryption-key.ts` for how
// the X25519 keypair is derived in the browser; an agent that wants
// the same property would derive its own X25519 keypair from a
// deterministic seed (e.g. nacl.box.keyPair.fromSecretKey(sha256(seed)))
// and encode the public key as URL-safe base64 here.

const DEFAULT_BASE_URL = "http://localhost:3001";

/**
 * @typedef {Object} QuoteEntry
 * @property {string} quoteId
 * @property {string} owner
 * @property {string} poolId
 * @property {string|null} network
 * @property {string} amount         atomic units (USDC = 6 decimals)
 * @property {string|null} description
 * @property {number} expiry         unix seconds
 * @property {"draft"|"issued"|"matched"|"cancelled"|"expired"} status
 * @property {string} commitment
 * @property {string} nullifier
 * @property {string} createdAt
 * @property {string|null} issuedAt
 * @property {string|null} matchedAt
 * @property {string|null} cancelledAt
 * @property {string|null} paymentTxHash
 * @property {string|null} paymentNullifier
 * @property {string} [payload]      the opaque `relai:quote:…` string (only on issue + owner-list)
 * @property {string|null} [sellerReceiptId]
 * @property {string|null} [sellerEncPk]
 * @property {string|null} [solanaRedeemTx]
 */

async function request(baseUrl, serviceKey, path, init = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      "X-Service-Key": serviceKey,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Create a draft quote on the server.
 *
 * @param {Object} params
 * @param {string} params.serviceKey
 * @param {string} params.amountAtomic    USDC atomic units, e.g. "1000000" for 1 USDC
 * @param {number} params.expiry          unix seconds (must be >= now + 5min)
 * @param {string} [params.description]
 * @param {string} [params.poolId]        defaults to `<network>-v4`
 * @param {string} [params.network]       e.g. "solana-devnet" / "base-sepolia"
 * @param {string} [params.baseUrl]
 * @returns {Promise<QuoteEntry>}
 */
export async function createDraftQuote(params) {
  const baseUrl = params.baseUrl || DEFAULT_BASE_URL;
  return request(baseUrl, params.serviceKey, "/v1/shielded-payment-requests", {
    method: "POST",
    body: JSON.stringify({
      amount: params.amountAtomic,
      expiry: params.expiry,
      description: params.description,
      poolId: params.poolId,
      network: params.network,
    }),
  });
}

/**
 * Flip a draft to ISSUED — server stamps the canonical
 * `relai:quote:<base64>` payload (with seller secrets) onto the entry
 * and returns it on this response only. Save it.
 *
 * @param {Object} params
 * @param {string} params.serviceKey
 * @param {string} params.quoteId
 * @param {string} [params.sellerEncPk]   URL-safe base64 X25519 pubkey
 * @param {string} [params.baseUrl]
 * @returns {Promise<QuoteEntry & { payload: string }>}
 */
export async function issueQuote(params) {
  const baseUrl = params.baseUrl || DEFAULT_BASE_URL;
  const body = params.sellerEncPk
    ? JSON.stringify({ sellerEncPk: params.sellerEncPk })
    : undefined;
  return request(baseUrl, params.serviceKey, `/v1/shielded-payment-requests/${encodeURIComponent(params.quoteId)}/issue`, {
    method: "POST",
    ...(body ? { body } : {}),
  });
}

/**
 * Convenience: createDraft + issue in one call. Returns the issued
 * entry (with the `payload` field).
 */
export async function createAndIssueQuote(params) {
  const draft = await createDraftQuote(params);
  return issueQuote({
    serviceKey: params.serviceKey,
    quoteId: draft.quoteId,
    sellerEncPk: params.sellerEncPk,
    baseUrl: params.baseUrl,
  });
}

/** GET /v1/shielded-payment-requests — owner-scoped list. */
export async function listQuotes({ serviceKey, status, baseUrl = DEFAULT_BASE_URL }) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(baseUrl, serviceKey, `/v1/shielded-payment-requests${qs}`, { method: "GET" });
}

/** POST /v1/shielded-payment-requests/:id/cancel — destroy an unmatched draft. */
export async function cancelQuote({ serviceKey, quoteId, baseUrl = DEFAULT_BASE_URL }) {
  return request(baseUrl, serviceKey, `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/cancel`, {
    method: "POST",
  });
}

/**
 * Public match-status read — no service key required. Useful for an
 * agent polling an external quote it doesn't own (e.g. a buyer agent
 * watching a quote it just paid).
 */
export async function getMatchStatus({ quoteId, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/match-status`,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
