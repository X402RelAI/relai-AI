---
name: relai-spr-inspect
description: Use this skill when the user wants to inspect a RelAI Shielded Payment Request (SPR) — list owned quotes, decode a `relai:quote:<base64url>` payload locally, or read public match-status / receipts. Read-only. Triggers on "list my SPR quotes", "decode this relai:quote payload", "is this SPR quote paid", "check SPR match status", "look up SPR seller receipt".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI SPR — inspect (read-only)

The plugin's read-only / decode surface for Shielded Payment Requests. Doesn't issue, pay, or redeem — for those, see `relai-spr-issue` (seller mint), `relai-spr-pay` (buyer pay, transport-agnostic), `relai-spr-redeem` (seller redeem).

**Testnet only.** SPR currently supports `base-sepolia`, `skale-base-sepolia`, `solana-devnet`.

## Tools

| Tool | What it does | Auth |
|---|---|---|
| `relai_spr_decode` | Parse a `relai:quote:<base64url>` payload locally. No network call. | none |
| `relai_spr_list` | List quotes owned by the agent's service key. Includes payload + sellerReceiptId. | service key |
| `relai_spr_get` | Get a single quote owned by the service key (excludes payload). | service key |
| `relai_spr_status` | Public match-status read. Returns status, on-chain match snapshot, pairing attestation (Solana). | none |
| `relai_spr_seller_receipt` | Look up an `sr_…` seller receipt. Public; opaque ID is bearer. | none |
| `relai_spr_buyer_receipt` | Look up a `br_…` buyer receipt. Public; opaque ID is bearer. | none |

## Workflow

### 1. Ensure the agent is configured (only when calling the service-key-authed tools)

`relai_spr_decode` and the public `_status` / `_receipt` tools need no setup. For `_list` / `_get`, run `relai_setup` first if not yet configured.

### 2. Pick the right tool for the user's question

| User intent | Tool | Inputs |
|---|---|---|
| "What's inside this `relai:quote:…` string?" | `relai_spr_decode` | `payload` |
| "Show me my SPR quotes." | `relai_spr_list` | `status?` filter |
| "What's the state of quote `q_…`?" | `relai_spr_status` | `quoteId` |
| "Did the buyer pair against my quote yet?" | `relai_spr_status` | `quoteId` (look for `status: paid`) |
| "Lookup my seller receipt `sr_…`" | `relai_spr_seller_receipt` | `receiptId` |
| "Lookup my buyer receipt `br_…`" | `relai_spr_buyer_receipt` | `receiptId` |

### 3. Report state, do not act

Surface the decoded fields plainly. Status semantics:

- `pending` — quote ISSUED, no pairing yet.
- `paid` — buyer's pairing proof landed; ready to redeem.
- `redeemed` — already settled.
- `expired` — `expiry` passed without a match.
- `cancelled` — seller cancelled before pairing.
- `refunded` — buyer reclaimed after expiry.

For `paid`/`redeemed`, the `match` object includes `submitter` (the buyer's pubkey — public on-chain anyway) and `matchedAt`. On Solana, `pairingAttestation` carries the buyer's Groth16 proof for offline `snarkjs.verify`.

## Guardrails

- **Read-only.** This skill never issues, pays, or redeems. If the user asks for those, hand off to `relai-spr-issue` / `relai-spr-pay` / `relai-spr-redeem`.
- **Do not echo decoded secret material from a payload.** When the user pastes `relai:quote:…`, decode it once, surface only `quoteId`, `amount`, `expiry`, `network`, and `description` to the user. Do NOT echo `sellerSecret` (`s`) or `nonce` (`o`) — those are the seller's spending capability for that quote.
- **Stale-by-design results.** A `pending` quote can become `paid` between two calls. Re-poll if a downstream action hinges on it.
- **404 on `relai_spr_status`** means wrong quoteId or wrong instance (mainnet vs testnet) — don't paper over with a guess.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` on `_list`/`_get` | Run `relai_setup`. |
| `404 quote not found` | Re-confirm `quoteId`. The quote may live on a different instance. |
| `429 rate_limited` | Stop polling. The match-status route is the polling target — back off to ≤ 1 Hz. |

## References

- See the Claude transport-agnostic skills (`relai-spr-issue`, `relai-spr-pay`, `relai-spr-redeem`) for end-to-end protocol detail.

## Relation to other skills

- The full **seller-side issue + redeem** flow is covered by `relai-spr-issue` and `relai-spr-redeem` (both rely on `plugin-openclaw` tools too).
- The **buyer-side pay** flow (deposit + pairing proof) requires a Solana keypair and stays out of the plugin — see `relai-spr-pay` in `.claude/skills/`.
