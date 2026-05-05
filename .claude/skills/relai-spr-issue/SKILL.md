---
name: relai-spr-issue
description: Use this skill when an agent wants to issue a private payment quote — a `relai:quote:<base64url>` bearer token a buyer can pay anonymously against — using RelAI Shielded Payment Requests (SPR). Reverse direction of shielded links: the seller publishes the quote, the buyer deposits anonymously, the seller redeems with a separate ZK proof. Triggers on "issue an SPR quote", "publish a private invoice", "create a shielded payment request", "send me money privately".
---

# RelAI SPR — issue a quote (seller-side)

The seller half of [Shielded Payment Requests](https://relai.fi/documentation/management-api#shielded-payment-requests). The seller asks the platform to mint a quote with a fresh Poseidon commitment + nullifier, transitions it to `ISSUED`, and receives an opaque `relai:quote:<base64url>` payload. The seller hands that payload to ONE buyer over any channel; the buyer uses it to deposit into Privacy Pool V4.1 anonymously. The seller redeems later via a separate ZK proof — see `relai-spr-redeem`.

**Testnet only.** Currently `base-sepolia`, `skale-base-sepolia`, `solana-devnet`. Mainnet ships after a multi-party trusted-setup ceremony for the redeem zkey.

## Prerequisite — service key

Same resolution order as every RelAI skill:

1. `RELAI_SERVICE_KEY` env var.
2. `~/.relai/service-key.json` written by `relai-setup`. Read the `key` field.
3. A file the user explicitly references.
4. Ask the user.

If none resolves, hand off to `relai-setup` first.

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## Endpoints (all `X-Service-Key`-authed unless noted)

| Step | Method | Path |
|---|---|---|
| Create draft | `POST` | `/v1/shielded-payment-requests` |
| Issue (transition + emit payload) | `POST` | `/v1/shielded-payment-requests/{quoteId}/issue` |
| Cancel (only if not yet matched) | `POST` | `/v1/shielded-payment-requests/{quoteId}/cancel` |
| List owned quotes | `GET` | `/v1/shielded-payment-requests?status=...` |
| Get one (no payload) | `GET` | `/v1/shielded-payment-requests/{quoteId}` |
| Match status (public) | `GET` | `/facilitator/shielded-payment-requests/{quoteId}/match-status` |

The `payload` field is **only** returned by `/issue` and by the owner's `/list` view. `/get` excludes it.

## Sequence

| # | Step | Notes |
|---|---|---|
| 1 | Resolve service key | see Prerequisite |
| 2 | Confirm amount + expiry + network with the user | non-reversible if you re-issue |
| 3 | (Solana, optional) Generate an X25519 keypair for sealed proof bundles | see `references/seller-secrets.md` |
| 4 | POST draft → store `quoteId` | server may rewrite `poolId`; respect it |
| 5 | POST `/issue` → receive `payload` (`relai:quote:<base64url>`) + `sellerReceiptId` | one and done — payload is bearer |
| 6 | Hand the payload string to ONE buyer over any channel | nothing else in that message |
| 7 | (Optional) Tail match-status until `paid` | poll, don't block the conversation |

Cancellation is allowed only while `status < MATCHED`. Server returns 409 once a buyer pairs.

## Worked example — Solana devnet

Compose the create body:

```bash
curl -s -X POST "$API/v1/shielded-payment-requests" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d '{
    "amount":  "1000000",
    "expiry":  '"$(($(date +%s) + 3600))"',
    "network": "solana-devnet",
    "description": "translation"
  }' | jq
```

Server responds `201` with `quoteId`, `commitment`, `nullifier`, `amount`, `expiry`, `network`, `poolId`, `status: "draft"`.

Then issue:

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/$QUOTE_ID/issue" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d '{}' | jq
```

(For Solana sealed bundles, replace `'{}'` with `'{"sellerEncPk":"<base64url X25519 pubkey>"}'`.)

Response includes `payload` (`relai:quote:eyJ2Ij…`) and `sellerReceiptId` (`sr_…`). The payload is the bearer the buyer pays against.

## Telling the user what to share

Hand the buyer **only** the `payload` string. The buyer needs nothing else from you. **Never** include in that message:

- `quoteId` separately (the buyer can decode it from the payload anyway, but explicit echo just adds attack surface)
- `sellerReceiptId` (your private record)
- Your wallet address — it has no role in this flow until redeem
- The amount (the buyer reads it from the payload; quoting it again can introduce mismatches if you misread)

After delivery, follow up only by polling `match-status` yourself. The buyer's deposit lands on-chain at a moment you don't control; don't pressure them.

## Guardrails

- **Treat the payload as bearer-secret** until the buyer pays. Anyone holding it can pair against the quote and you'd see a successful match — but only the holder's deposit funds it, so the worst case is the wrong buyer "claims" the slot. Re-issue if leaked.
- **Do not re-issue** for a quote that's already in `paid` or `redeemed`. Server returns 409. The recovery path is a fresh quote.
- **Set expiry generously.** `expiry > now + 5 min` is enforced; common practice is 1h–24h depending on the buyer's expected response time.
- **Never auto-cancel** without confirming with the user — once cancelled, the same quote can never be reused, even if the buyer was on the verge of paying.
- **Respect amount precision.** SPR amounts are atomic units (1 USDC = 1,000,000). Do not pass decimal USDC numbers — the server treats them as raw atomic and you'll under-quote by 6 zeros.

## Error recovery

| Symptom | Action |
|---|---|
| `400 expiry must be >5min in future` | Bump `expiry` further. The 5-min floor is enforced strictly. |
| `400 invalid network` | Only `base-sepolia`, `skale-base-sepolia`, `solana-devnet` are live. |
| `400 amount must be positive` | The body uses atomic units; check you didn't pass `0` or a negative value. |
| `409 quote already matched` on `/cancel` | A buyer already paired. Cancellation is no longer possible — proceed to redeem. |
| `403` on `/issue` | The service key doesn't own the quote. Ensure the same key created and issues. |

## References

- [references/seller-secrets.md](references/seller-secrets.md) — what the `payload` actually contains, why the seller secret material lives both in the payload and on the server, and the optional Solana sealed-bundle workflow (X25519).
- [references/match-tracking.md](references/match-tracking.md) — polling cadence, status semantics, and what `pairingAttestation` carries on Solana.

## Relation to other skills

- **`relai-spr-redeem`** — the seller's follow-up after the buyer pairs. Generates the redeem Groth16 proof and asks the operator to relay the on-chain payout.
- **`relai-spr-pay`** — what the BUYER runs against the payload you hand them. You don't run that one; it's their flow.
- **`relai-shielded-send` / `relai-shielded-receive`** — the BUYER-initiated direction. Use those when the buyer wants to push a private payment without a quote.
