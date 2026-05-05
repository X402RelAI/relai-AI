// Seller-side redeem helpers — programmatic counterpart to the
// "Redeem to my wallet" button on the seller dashboard. Pulls
// matched-quote funds from the shielded pool into the seller's
// wallet, paying the on-chain 5% platform fee enforced by
// `solana-spr-payout-router::payout_to_seller`.
//
// SCOPE — what's wired up today:
//
//   ✓ getRedeemProofInput({...})              GET /v1/.../redeem-proof-input (service-key gated)
//   ✓ submitRedeemRelay({...})                POST /v1/.../solana-redeem-relay
//   ✓ submitStealthClaimRelay({...})          POST /v1/shielded-payment-requests/solana-stealth-claim-relay
//
// SCOPE — what's NOT included (yet):
//
//   ✗ Stealth recipient keypair derivation     (per-quote ephemeral pubkey
//                                              from a deterministic
//                                              signMessage challenge — port of
//                                              `frontend/src/lib/spr-stealth-recipient.ts`.
//                                              Trivial to add; left out so an
//                                              agent can plug in any recipient
//                                              policy it likes — e.g. a fixed
//                                              treasury wallet.)
//   ✗ Redeem Groth16 proof generation          (snarkjs.groth16.fullProve over
//                                              `shielded-payment-redeem` —
//                                              same posture as the pairing
//                                              proof in buyer-flow.mjs.)
//   ✗ Stealth-claim transaction assembly      (`transferChecked` from stealth
//                                              ATA → main wallet ATA, signed
//                                              by stealth keypair + relayer
//                                              fee_payer. The relay endpoint
//                                              just submits an already-signed
//                                              tx — agent builds it locally.)
//
// The high-level flow an agent runs:
//
//   1. listQuotes({ status: "issued" })       — find quotes with a paid match
//   2. Filter to `matchStatus === "paid"`     — via getMatchStatus or pollMatchStatus
//   3. derive stealth keypair                  — agent's own logic
//   4. getRedeemProofInput(quoteId)            — server hands the secrets back
//   5. snarkjs.groth16.fullProve(...)          — agent's own proof generation
//   6. submitRedeemRelay({...})                — operator broadcasts payout-to-seller
//   7. agent builds claim tx (stealth → main)  — partial-signed by stealth
//   8. submitStealthClaimRelay({...})          — operator co-signs as fee_payer
//
// Each helper here is a thin wrapper around its endpoint — the agent
// drives the dance, the server handles the on-chain custody.

const DEFAULT_BASE_URL = "http://localhost:3001";

/**
 * GET /v1/shielded-payment-requests/:quoteId/redeem-proof-input
 *
 * Service-key gated — returns sellerSecret + nonce + the inputs the
 * redeem circuit needs to bind the seller's identity. Only the
 * quote's owner (verified via service-key → subject mapping) is
 * allowed.
 */
export async function getRedeemProofInput({ serviceKey, quoteId, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/redeem-proof-input`,
    { headers: { "X-Service-Key": serviceKey } },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `redeem-proof-input HTTP ${res.status}`);
  return body;
}

/**
 * POST /v1/shielded-payment-requests/:quoteId/solana-redeem-relay
 *
 * Hand the operator a Groth16 redeem proof + (recipient,
 * claimedAmount). The operator's keypair signs `payout_to_seller`,
 * the router splits 95/5 between the stealth recipient ATA and the
 * platform fee ATA in the same tx.
 *
 * @param {Object} params
 * @param {string} params.quoteId
 * @param {string} params.network                e.g. "solana-devnet"
 * @param {string} params.proofBase64            256-byte Groth16 proof, base64
 * @param {string} params.recipientHex           0x-prefixed 32-byte hex, MOD-p reduced
 * @param {string} params.recipientPubkey        base58 pubkey of the stealth recipient
 * @param {string} params.quoteNullifierHex      0x-prefixed 32-byte hex
 * @param {string} params.claimedAmountAtomic    USDC atomic units, decimal string
 * @returns {Promise<{ ok: boolean, signature?: string, alreadyRedeemed?: boolean, relayer?: string }>}
 */
export async function submitRedeemRelay({
  quoteId,
  network,
  proofBase64,
  recipientHex,
  recipientPubkey,
  quoteNullifierHex,
  claimedAmountAtomic,
  baseUrl = DEFAULT_BASE_URL,
}) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-redeem-relay`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network,
        proofBase64,
        recipientHex,
        recipientPubkey,
        quoteNullifierHex,
        claimedAmountAtomic,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `solana-redeem-relay HTTP ${res.status}`);
  return body;
}

/**
 * POST /v1/shielded-payment-requests/solana-stealth-claim-relay
 *
 * After `submitRedeemRelay` lands, the stealth ATA holds (face − 5%).
 * Send a partially-signed `transferChecked` tx (stealth → main) here
 * — the operator co-signs as fee_payer and broadcasts. Agent builds
 * the tx locally (see buyer-flow scope note re. wallet operations).
 *
 * @param {Object} params
 * @param {string} params.network
 * @param {string} params.txBase64             partial-signed tx (only stealth keypair has signed)
 * @param {string} params.expectedAuthority    base58 stealth pubkey — server sanity-checks
 *                                             this matches a signer on the tx before
 *                                             co-signing as fee_payer.
 * @returns {Promise<{ ok: boolean, signature?: string }>}
 */
export async function submitStealthClaimRelay({ network, txBase64, expectedAuthority, baseUrl = DEFAULT_BASE_URL }) {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/shielded-payment-requests/solana-stealth-claim-relay`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network, txBase64, expectedAuthority }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `solana-stealth-claim-relay HTTP ${res.status}`);
  return body;
}

/**
 * Faza 6a-fee mirror of the on-chain `payout_to_seller` rounding rule
 * — given the face amount the buyer paid, returns the net the seller
 * actually receives (after the hardcoded 5% platform fee).
 *
 *   fee = ceil(face * 500 / 10000)
 *   net = face - fee
 *
 * Agent should use this to compute the `amountAtomic` argument for
 * the stealth-claim transferChecked instruction — passing the face
 * value would overdraft the stealth ATA and fail with `0x1
 * InsufficientFunds` from the SPL Token program.
 */
export function netFromFace(faceAtomic) {
  const face = BigInt(faceAtomic);
  const fee = (face * 500n + 9_999n) / 10_000n;
  return { face, fee, net: face - fee };
}
