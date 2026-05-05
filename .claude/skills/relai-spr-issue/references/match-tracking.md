# Tracking the match

After issuing, the seller wants to know when (or whether) the buyer pairs against the quote. The platform exposes a public match-status endpoint keyed on `quoteId`:

```
GET /facilitator/shielded-payment-requests/{quoteId}/match-status
```

No auth needed — the opaque `quoteId` is the bearer.

## Status values

| `status` | Meaning |
|---|---|
| `pending` | Quote is `ISSUED`; no buyer pairing yet. |
| `paid` | Buyer's pairing proof landed on-chain in `PaymentMatchRegistry`. The match snapshot is now in `match`. |
| `redeemed` | The seller has already redeemed (the on-chain payout fired). |
| `refunded` | Buyer reclaimed after expiry without ever pairing. |
| `expired` | The quote's `expiry` passed without a match. Cannot redeem from this state. |
| `cancelled` | The seller cancelled before pairing. |
| `unknown` | Quote not recognised — wrong ID, wrong instance. |

The seller-side flow only progresses on `status: paid`. Treat `pending` as "still waiting", and treat `expired` / `cancelled` as terminal failures (redeem will never succeed).

## Polling cadence

Server publishes match-status as soon as the on-chain pairing tx is recorded — a few seconds after the buyer's deposit on Solana, near-block on EVM. A reasonable cadence is **every 5–10 seconds for the first minute, then back off to every 30s**. Don't poll faster than 1Hz — the route hits the indexer.

## What `match` carries (when `status >= "paid"`)

```json
{
  "match": {
    "quoteRoot":         "0x...",   // Merkle root of QuoteRegistry at pairing time
    "poolRoot":          "0x...",   // Merkle root of ShieldedPoolV41
    "aspRoot":           "0x...",   // Merkle root of ASP snapshot
    "paymentNullifier":  "0x...",   // Buyer's pairing nullifier
    "submitter":         "...",     // Buyer's wallet address (publicly visible on-chain)
    "matchedAt":         1735776123
  }
}
```

`submitter` is the buyer's Solana / EVM address — that's the wallet that sent the on-chain pairing tx. In the SPR privacy model, this address is a one-shot wallet from the buyer's POV: they fund the deposit, then never use it again. So `submitter` is the leaf the buyer sacrificed for this payment, not their primary wallet.

## `pairingAttestation` (Solana only)

When `status >= "paid"` on Solana, the response carries a `pairingAttestation` object:

```json
{
  "pairingAttestation": {
    "proofBase64":   "<256 bytes base64>",
    "publicSignals": ["0x...", "0x...", "0x...", "0x...", "0x..."],
    "recordedAt":    "2026-04-26T00:35:11.482Z"
  }
}
```

This is the buyer's Groth16 pairing proof, stashed by the operator so the seller's receipt UI can run `snarkjs.verify` locally without a Solana RPC round-trip. EVM has no equivalent — verification is on-chain.

If the seller issued with a `sellerEncPk`, the `proofBase64` may be a sealed bundle (XSalsa20-Poly1305 sealed box). Decrypt locally with the corresponding X25519 secret key before passing to `snarkjs.verify`.
