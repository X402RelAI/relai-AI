---
name: relai-spr-pay
description: Use this skill when an agent receives a `relai:quote:<base64url>` payload (a Shielded Payment Request from a seller) and wants to pay it privately. The buyer deposits USDC into Privacy Pool V4.1 anonymously, generates a Groth16 pairing proof, and the operator records the on-chain match — the seller never sees the buyer's wallet. Triggers on "pay this SPR quote", "settle a relai:quote payload", "deposit against a shielded payment request", "anonymous pay-to-quote", "shielded pay".
---

# RelAI SPR — pay against a quote (buyer-side)

The buyer half of [Shielded Payment Requests](https://relai.fi/documentation/management-api#shielded-payment-requests). Given a `relai:quote:<base64url>` payload from a seller, decode it, deposit the matching USDC into Privacy Pool V4.1, build a Groth16 pairing proof, and have the operator record the on-chain match. After this, the seller will see `status: paid` on `match-status` and run their own redeem flow.

**This skill is a protocol guide, not a self-contained executor.** The deposit and pairing-proof steps require local cryptography and a Solana / EVM keypair — they cannot be done with HTTP alone, and a SKILL.md is not the right place to ship a wallet keypair. The skill describes which steps are HTTP (the agent can fire them directly) versus which steps must be delegated to an external client.

Solana → Solana only here. EVM SPR support exists on the server but the on-chain pairing tx is buyer-signed (not operator-relayed) and adds steps this skill doesn't yet cover.

**Testnet only.** Currently `solana-devnet`, `base-sepolia`, `skale-base-sepolia`.

## Prerequisite — service key (optional)

The buyer-side flow does **not** strictly require a RelAI service key. Witness fetches and the pairing relay are public endpoints (the opaque `quoteId` acts as bearer). Still, the buyer typically wants:

- The decode → deposit → pair flow to fail loudly with structured logs.
- A `br_…` buyer receipt for their own records (post-match lookup).

If the user has a service key, resolve it the standard way (`RELAI_SERVICE_KEY` → `~/.relai/service-key.json` → user-referenced file → ask). It's optional — not blocking.

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## HTTP endpoints

| Step | Method | Path | Auth | Skill can fire? |
|---|---|---|---|---|
| Read pool config (Solana) | `GET` | `/facilitator/payment-codes/shielded-links/config?network=solana-devnet` | service key | yes — to learn `programId`, `usdcMint`, `rpcUrl` |
| Pool witness | `GET` | `/v1/shielded-payment-requests/solana-pool-witness/{commitment}?network=...` | none | yes (after deposit) |
| ASP witness | `GET` | `/v1/shielded-payment-requests/solana-asp-witness/{commitment}?network=...` | none | yes |
| Quote witness | `GET` | `/facilitator/shielded-payment-requests/{quoteId}/quote-witness` | none | yes |
| Deposit confirmed | `POST` | `/v1/shielded-payment-requests/{quoteId}/solana-deposit-confirmed` | none | yes (after off-platform deposit) |
| Pairing relay (operator-signed) | `POST` | `/v1/shielded-payment-requests/{quoteId}/solana-pairing-relay` | none | yes (after off-platform proof) |
| Optional proof stash | `POST` | `/v1/shielded-payment-requests/{quoteId}/solana-pairing-proof` | none | yes — for receipt UI |
| Match status | `GET` | `/facilitator/shielded-payment-requests/{quoteId}/match-status` | none | yes — verify `status: paid` after relay |

## Sequence (Solana)

| # | Step | Where it runs |
|---|---|---|
| 1 | Decode payload locally — extract `quoteId`, `commitment`, `nullifier`, `amount`, `network`, `poolId`, `sellerSecret`, `nonce`, `sellerEncPk?` | **off-platform (no network)** |
| 2 | Sanity-check `match-status` — assert `status: pending` and `expiry > now + 60s` | **HTTP** |
| 3 | Resolve pool config (program ID, USDC mint, rpc URL) | **HTTP** |
| 4 | Generate the buyer's note: fresh `buyerSecret`, `buyerNonce` (random); compute `paymentNullifier = Poseidon(buyerSecret, buyerNonce, quoteCommitmentField, ...)` | **off-platform** |
| 5 | Sign and broadcast the SPL `transfer` of `amount` USDC from the buyer's ATA to the pool's commitment PDA | **off-platform (Solana keypair)** |
| 6 | POST `/solana-deposit-confirmed` with the deposit tx + commitment + PDA | **HTTP** |
| 7 | Wait ~10s for the ASP scheduler to ingest the deposit (`aspReady: false` until then) | **wait** |
| 8 | GET `/quote-witness` + `/solana-pool-witness` + `/solana-asp-witness` | **HTTP** |
| 9 | Run `snarkjs.groth16.fullProve` against the pairing circuit (5 public signals) | **off-platform** |
| 10 | POST `/solana-pairing-relay` with the proof bundle | **HTTP** |
| 11 | (Optional) POST `/solana-pairing-proof` so the seller's receipt UI can run `snarkjs.verify` locally | **HTTP** |
| 12 | Poll `/match-status` until `status: paid` confirms the on-chain match | **HTTP** |

Steps 1, 4, 5, 9 cannot be done with HTTP alone — see "Delegation".

## Delegation — running the off-platform steps

Steps 1 + 4 + 5 + 9 cannot be done with HTTP alone. The agent must hand them to a host runtime that has both a Solana keypair and the relevant crypto libraries (`@solana/web3.js`, `@solana/spl-token`, `circomlibjs`, `snarkjs`):

1. **Code-execution sandbox** — if the agent has Bash + Node available with the libraries installed AND the user has explicitly authorised loading a Solana keypair for this run, run the steps inline. Exact request shapes, the Poseidon nullifier derivation, the SPL deposit-ix layout, and the public-signal order for the pairing circuit are in [references/buyer-protocol.md](references/buyer-protocol.md).
2. **Dashboard UI** — when the seller-issued payload is shared with a human, the buyer can pay via the dashboard at `relai.fi/quotes/pay` (in-browser wallet flow). Direct the user there for one-off payments where no agent-side wallet is configured.

**Do not** load a wallet keypair from env unprompted — always confirm with the user first. A SKILL is a recipe, not a permission grant.

## Pre-flight before deposit

Before step 5 (the on-chain SPL transfer), always:

- Decode the payload locally (step 1) and confirm with the user the **decoded amount + decoded network + decoded expiry** match what the seller quoted in the chat.
- Check `match-status` returns `pending` (not already paid by someone else racing on the same payload).
- Verify the buyer wallet has at least `amount` micro-USDC + ~5,000 lamports of SOL for transaction fees.

These checks are pure HTTP / local — run them before signing the deposit so a stale quote doesn't burn an on-chain transfer.

## On `aspReady: false`

`solana-asp-witness` returns `aspBlockedReason` when the buyer's commitment hasn't been ingested into the latest ASP snapshot yet (debounced ~10s after the deposit lands). Sleep ≥ 12s and retry. If still failing after 60s, the buyer wallet may be on the ASP defer list — escalate.

## Guardrails

- **Do NOT echo the decoded payload material to the seller.** The seller already knows `quoteId`, `commitment`, `amount` — they were the issuer. But never message the seller your `paymentNullifier`, your buyer secret material, or the `submitter` pubkey you used. The whole SPR design point is that those stay on-chain only.
- **Use a one-shot Solana wallet.** The `submitter` field of the on-chain match is publicly visible. If the buyer wants stronger unlinkability, fund a fresh keypair just for this deposit and never reuse it. Routine privacy hygiene.
- **Never load a wallet private key from env without explicit user confirmation in the same session.** A SKILL is a recipe, not a permission grant.
- **Always price-check before depositing.** The on-chain step is non-reversible. Until the deposit confirms and the `/solana-deposit-confirmed` ack lands, you can still abort. After that, the buyer is committed.
- **Do not retry mid-flow.** If the deposit confirmed but the pairing relay fails, the funds are locked in the pool against the buyer's commitment. The buyer can still pair (re-run from step 6), but DO NOT redeposit.
- **Send only the payload across the chat channel.** If the buyer responds to the seller, an "ok, paid" is enough — the seller polls match-status. Don't include tx hashes, nullifiers, or wallet pubkeys.

## Error recovery

| Symptom | Action |
|---|---|
| Cannot decode payload | Malformed or truncated. Ask the seller to resend the full string. |
| `404 quote not found` on match-status | Wrong instance (mainnet vs testnet) or quote was cancelled. Stop. |
| `409 already_matched` on pairing relay | Someone else paired against this quote first (multi-buyer race). The first deposit wins; the loser's deposit sits in the pool and can be reclaimed via a separate withdraw flow. |
| `400 invalid_proof` on pairing relay | Proof doesn't verify — most often a stale witness (re-fetch quote/pool/asp witnesses and re-prove). |
| `aspReady: false` repeatedly | Sleep 12s, retry; after 60s of failure the funder address may be on the ASP defer list. |
| `expiry passed` between deposit and pair | Quote expired in-flight. Funds are reclaimable via the buyer's own withdraw — do NOT abandon. Surface the explorer link to the user. |

## References

- [references/buyer-protocol.md](references/buyer-protocol.md) — exact request/response shapes, Poseidon nullifier derivation, SPL deposit ix layout, public-signal order for the pairing circuit.
- [references/privacy-checklist.md](references/privacy-checklist.md) — what's safe to ack to the seller without breaking unlinkability.

## Relation to other skills

- **`relai-spr-issue`** — what the SELLER ran to mint the quote you're paying. You don't run that.
- **`relai-spr-redeem`** — what the seller runs after your match lands. Not your concern.
- **`relai-shielded-send`** — the BUYER-initiated direction (no quote involved). Use that when the seller hasn't issued a quote and the buyer wants to push a private payment.
