// Buyer agent helpers — programmatic side of "I receive a
// `relai:quote:…` payload and want to pay for it without a browser".
//
// SCOPE — what's wired up here today:
//
//   ✓ parseShieldedQuotePayload(input)        re-export of the parser
//   ✓ computeQuoteCommitment(payload)         Poseidon helper, parity-locked vs. server
//   ✓ computeQuoteNullifier(payload)          ditto
//   ✓ fetchQuoteWitness({quoteId, baseUrl})   GET /facilitator/.../quote-witness
//   ✓ fetchPoolWitness({...})                 GET /facilitator/.../pool-witness
//   ✓ announceSolanaDeposit({...})            POST /v1/.../solana-deposit-confirmed
//   ✓ submitPairingRelay({...})               POST /v1/.../solana-pairing-relay
//   ✓ recordPairingProof({...})               POST /v1/.../solana-pairing-proof
//   ✓ pollMatchStatus({quoteId, baseUrl})     GET /facilitator/.../match-status
//
// SCOPE — what's deliberately NOT included (yet):
//
//   ✗ Solana SPL deposit transaction signing  (agent must do this with
//                                              its own Keypair + @solana/spl-token,
//                                              same way a browser wallet would —
//                                              see demo.mjs for the canonical pattern)
//   ✗ Groth16 pairing-proof generation        (snarkjs.groth16.fullProve over
//                                              the `shielded-payment-pairing`
//                                              circuit — port of
//                                              `frontend/src/lib/payment-request-browser-prover.ts`
//                                              — kept out of v0.1 because the
//                                              witness assembly is ~200 LOC and
//                                              deserves its own audit pass.
//                                              The endpoint helpers below are
//                                              ready to receive a proof bundle
//                                              built any way you like.)
//
// In other words: this v0.1 file gives a Node agent every API client it
// needs to **drive** the SPR pipeline; the cryptographic heavy-lifting
// (Solana tx signing + ZK proof) is the agent author's responsibility,
// same posture as `examples/shielded-agent/`'s redeem flow exposes the
// `generateShieldedAspProof` primitive for the agent to call directly.

import { parseShieldedQuotePayload } from "./parse-quote-payload.mjs";
import { computeQuoteCommitment, computeQuoteNullifier } from "./quote-fields.mjs";

const DEFAULT_BASE_URL = "http://localhost:3001";

/**
 * GET /facilitator/shielded-payment-requests/:quoteId/quote-witness
 *
 * Returns the Merkle path that proves the quote's commitment is in
 * the published quote-tree snapshot. Required input for the pairing
 * proof's `quoteRoot` public signal.
 */
export async function fetchQuoteWitness({ quoteId, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/quote-witness`,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `quote-witness HTTP ${res.status}`);
  return body;
}

/**
 * GET /facilitator/shielded-payment-requests/pool-witness
 *
 * EVM-side combined pool tree path + ASP membership witness. Solana
 * agents should use `fetchSolanaPairingWitnesses` instead — Solana
 * has separate routes for pool / ASP and a different config shape.
 */
export async function fetchPoolWitness({
  network,
  commitment,
  leafIndex,
  depositor,
  baseUrl = DEFAULT_BASE_URL,
}) {
  const params = { network, commitment, leafIndex: String(leafIndex) };
  if (depositor) params.depositor = depositor;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/facilitator/shielded-payment-requests/pool-witness?${qs}`,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `pool-witness HTTP ${res.status}`);
  return body;
}

/**
 * Solana-specific witness fetch — three parallel reads for pool / ASP
 * / quote Merkle paths. Mirror of
 * `frontend/src/lib/spr-pairing-flow-solana.ts: fetchSolanaPairingWitnesses`.
 *
 * Caller must have already POSTed `/solana-deposit-confirmed` so the
 * server resolved the deposit PDA and indexed the new commitment;
 * without that step `/solana-pool-witness/:commitment` returns 404
 * and the witnesses can't be assembled.
 *
 * @returns {Promise<{
 *   pool:  { root: string, leafIndex: number, pathElements: string[], pathIndices: number[] },
 *   asp:   { root: string, leafIndex: number, pathElements: string[], pathIndices: number[] },
 *   quote: { root: string, leafIndex: number, pathElements: string[], pathIndices: number[] },
 * }>}
 */
export async function fetchSolanaPairingWitnesses({
  baseUrl = DEFAULT_BASE_URL,
  network,
  commitment,
  quoteId,
}) {
  const root = baseUrl.replace(/\/+$/, "");
  const c = commitment.startsWith("0x") ? commitment : `0x${commitment}`;
  const fetchJson = async (url) => {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status} for ${url}`);
    return body;
  };
  const [pool, asp, quote] = await Promise.all([
    fetchJson(
      `${root}/v1/shielded-payment-requests/solana-pool-witness/${encodeURIComponent(c)}?network=${encodeURIComponent(network)}`,
    ),
    fetchJson(
      `${root}/v1/shielded-payment-requests/solana-asp-witness/${encodeURIComponent(c)}?network=${encodeURIComponent(network)}`,
    ),
    fetchJson(
      `${root}/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/quote-witness`,
    ).then((q) => ({ ...q, root: q.quoteRoot ?? q.root })),
  ]);
  return { pool, asp, quote };
}

/**
 * POST /v1/shielded-payment-requests/:quoteId/solana-deposit-confirmed
 *
 * After your Solana SPL deposit lands, announce the on-chain
 * commitment + tx signature so the server can resolve the deposit
 * PDA and start surfacing the buyer-side receipt status.
 */
export async function announceSolanaDeposit({
  quoteId,
  commitmentHex,
  depositTxHash,
  depositPda,
  baseUrl = DEFAULT_BASE_URL,
}) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-deposit-confirmed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commitment: commitmentHex,
        depositTxHash,
        depositPda,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `solana-deposit-confirmed HTTP ${res.status}`);
  return body;
}

/**
 * POST /v1/shielded-payment-requests/:quoteId/solana-pairing-relay
 *
 * Hand the operator a Groth16 pairing proof bundle; the operator
 * signs `verify_and_record` on chain so the seller dashboard can flip
 * to "Paid". Server returns the on-chain pairing tx signature.
 *
 * @param {Object} params
 * @param {string} params.quoteId
 * @param {string} params.network                e.g. "solana-devnet"
 * @param {string} params.proofBase64            256-byte Groth16 proof, base64
 * @param {string[]} params.publicSignals        5 hex strings, [poolRoot, aspRoot, quoteRoot, paymentNullifier, quoteNullifier]
 * @returns {Promise<{ ok: boolean, signature?: string, alreadyRelayed?: boolean }>}
 */
export async function submitPairingRelay({ quoteId, network, proofBase64, publicSignals, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-pairing-relay`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network, proofBase64, publicSignals }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `solana-pairing-relay HTTP ${res.status}`);
  return body;
}

/**
 * POST /v1/shielded-payment-requests/:quoteId/solana-pairing-proof
 *
 * Best-effort follow-up: stash the proof bundle on the server so the
 * receipt page can run snarkjs.verify locally without the buyer's
 * proof URL. Optionally include the relay tx signature so the
 * buyer's role-scoped receipt can render a "match tx" link.
 */
export async function recordPairingProof({ quoteId, proofBase64, publicSignals, txHash, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-pairing-proof`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proofBase64, publicSignals, txHash }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `solana-pairing-proof HTTP ${res.status}`);
  return body;
}

/**
 * Convenience wrapper around the public match-status endpoint —
 * polls until the quote's status reaches one of `targetStatuses` or
 * the timeout elapses. No auth required; uses the same endpoint the
 * receipt page hits on mount.
 */
export async function pollMatchStatus({
  quoteId,
  targetStatuses = ["paid", "redeemed"],
  intervalMs = 2_000,
  timeoutMs = 60_000,
  baseUrl = DEFAULT_BASE_URL,
}) {
  const targets = new Set(targetStatuses);
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/match-status`,
    );
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.status && targets.has(body.status)) return body;
    if (Date.now() >= deadline) {
      const err = new Error(`match-status did not reach ${[...targets].join("/")} within ${timeoutMs}ms (last: ${body?.status || "unknown"})`);
      err.lastBody = body;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Re-exports so a caller can pull everything from a single import.
export { parseShieldedQuotePayload, computeQuoteCommitment, computeQuoteNullifier };
