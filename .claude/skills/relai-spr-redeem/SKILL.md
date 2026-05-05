---
name: relai-spr-redeem
description: Use this skill after a Shielded Payment Request quote you issued has been paired by a buyer and you want to redeem the on-chain payout to your wallet. The operator signs and pays the Solana fee — the seller pays NO gas and never signs anything on-chain. Returns 95% of the amount; the operator collects 5% atomically. Triggers on "redeem an SPR quote", "claim my SPR payout", "the buyer paid the quote, withdraw it", "settle paid quote".
---

# RelAI SPR — redeem a paired quote (seller-side)

The seller's follow-up to `relai-spr-issue`. After you handed the buyer a `relai:quote:<base64url>` payload and they paired against it on-chain, this skill pulls the redeem proof input, runs the Groth16 redeem proof locally (~1–3s), and asks the operator to broadcast the on-chain payout. The seller wallet only needs to be ready to receive USDC.

**Solana SPR only at this stage.** EVM SPR ships fee-split parity in v0.3 (the redeem path on `base-sepolia` / `skale-base-sepolia` works but currently the seller signs on-chain themselves — out of scope for this no-gas-on-seller skill).

## Prerequisite — service key + wallet keypair

Service key resolution: `RELAI_SERVICE_KEY` env → `~/.relai/service-key.json` (`key` field) → user-referenced file → ask. Hand off to `relai-setup` if none resolves.

**Wallet keypair (required):** SPR derives a per-quote stealth keypair from `sha256(walletKeypair.signMessage("relai-spr-stealth-seller:v1:<quoteId>"))`. The 95% payout lands in the stealth ATA, then a SECOND operator-co-signed tx hops it to the seller's main wallet ATA — that step partial-signs with the stealth keypair, so the seller's wallet keypair must be available locally. Resolve via `RELAI_SELLER_SOLANA_SECRET_KEY` env (JSON byte array or base58), or ask the user.

The seller still pays NO gas: the operator's keypair is `feePayer` for both the redeem relay AND the stealth claim relay.

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## HTTP endpoints

| Step | Method | Path | Auth |
|---|---|---|---|
| Match status | `GET` | `/facilitator/shielded-payment-requests/{quoteId}/match-status` | none |
| Redeem proof input | `GET` | `/v1/shielded-payment-requests/{quoteId}/redeem-proof-input` | service key |
| Redeem relay | `POST` | `/v1/shielded-payment-requests/{quoteId}/solana-redeem-relay` | none |
| Seller receipt | `GET` | `/v1/shielded-payment-requests/receipt/seller/{sr_id}` | none |

## Sequence

| # | Step | Where it runs |
|---|---|---|
| 1 | Resolve `quoteId` (the seller knows it from `relai-spr-issue`'s output) | **conversation / state** |
| 2 | Poll `match-status` until `status: paid` | **HTTP** |
| 3 | Verify denomination matches what you quoted (sanity check) | **conversation** |
| 4 | GET `/redeem-proof-input` → secret material + match snapshot + circuit URLs | **HTTP** |
| 5 | Run `snarkjs.groth16.fullProve` against the seller-redeem circuit (2 public signals) | **off-platform** |
| 6 | POST `/solana-redeem-relay` with the proof + seller pubkey | **HTTP** |
| 7 | Confirm `status: redeemed` and surface `payoutTxHash` to the user privately | **HTTP / conversation** |

Step 5 cannot be done with HTTP alone — see "Delegation".

## Delegation — running the off-platform proof step

Step 5 cannot be done with HTTP alone. The agent needs a host runtime with `snarkjs` + `circomlibjs` + `bs58` (+ `tweetnacl` if the seller wants to verify the buyer's pairing attestation). Run the proof inline; exact request/response shapes, circuit-input layout, public-signal order, and the G2 swap convention for Solana are in [references/redeem-protocol.md](references/redeem-protocol.md).

The seller's wallet keypair is also needed locally to derive the per-quote stealth recipient — the proof's `recipient` public signal is a BN254-reduced 32-byte pubkey, and the on-chain `payout_to_seller` deposits 95% of the face value into that stealth account's USDC ATA. A second `solana-stealth-claim-relay` hop (operator-signed `feePayer`, stealth keypair partial-signs `transferChecked`) moves it to the seller's main wallet ATA. Keep both keypairs out of any LLM tool param.

## Pre-flight

Before running the proof:

- `match-status.status` is exactly `paid`. If `pending`, the buyer hasn't paired yet. If `redeemed`, you've already redeemed (or someone else did with a leaked service key — investigate). If `expired`, you missed the window.
- The quote's `expiry` has at least ~30s headroom for proof generation + relay round-trip.
- `match-status.match.matchedAt` looks recent; if it's been hours and the proof still hasn't been pulled, no harm — but don't auto-redeem stale matches without surfacing to the user.

## Guardrails

- **Never share `quoteId` outside the seller's record** if you can avoid it. The opaque ID is bearer for `match-status` lookups; if a third party has it, they can monitor your match without your service key.
- **Do not echo the redeem proof input** to anywhere durable. `sellerSecret` and `nonce` are the seller's spending capability for this quote — feed them to the circuit, then drop them.
- **Treat the payout tx as an internal record.** Don't paste `payoutTxHash` into the same chat where you delivered work to the buyer — it ties their pairing event to your wallet.
- **Do not auto-retry on `invalid_proof`.** Stop and verify the proof input wasn't tampered with mid-flight.
- **Confirm the 95/5 split.** The relay response returns `paidOut` (95%) and `operatorFee` (5%) explicitly. If they don't match the expected split for your `amount`, escalate — do not silently accept.

## Error recovery

| Symptom | Action |
|---|---|
| `409 match not yet recorded` | Buyer hasn't paired. Poll `match-status` first; only call `/redeem-proof-input` when `status >= paid`. |
| `409 already redeemed` | Quote was already drained. Stop — funds went to whichever recipient was used first. Investigate. |
| `400 invalid_proof` on relay | Proof public signals don't match the on-chain match record. Most often: wrong recipient encoding (must be BN254-reduced from base58 pubkey). |
| `429 rate_limited` | Stop. Verify quoteId hasn't been brute-forced; rate limits are aggressive on relay endpoints. |
| `500 zkey_artifact_unavailable` | Backend's CDN dropped the wasm/zkey. Retry once, escalate if it persists. |

## References

- [references/redeem-protocol.md](references/redeem-protocol.md) — exact request/response payloads, circuit input layout, public-signal order, G2 swap convention for Solana.
- [references/privacy-checklist.md](references/privacy-checklist.md) — what to ack to the buyer without leaking the seller wallet.

## Relation to other skills

- **`relai-spr-issue`** — what you ran to mint the quote you're now redeeming.
- **`relai-spr-pay`** — what the BUYER ran. Don't run it yourself; it requires their secrets.
- **`relai-shielded-receive`** — the BUYER-initiated direction's seller-side flow (no quote involved). Use it when there's no quoteId.
