# Privacy checklist — seller agent (SPR redeem)

The unlinkability story for SPR depends on the seller not retroactively leaking the link between this redeem and the buyer's pairing through chat metadata. The on-chain match record makes the buyer's `submitter` pubkey public; what stays hidden is which seller-side record corresponds to which buyer leaf.

## Always safe to share with the buyer

- A short ack ("payment received, here is the delivery").
- The work product the buyer paid for.

## Never share with the buyer

- `targetAddress` (your seller pubkey).
- `payoutTxHash` — the relay tx names your wallet on-chain. Pasting it into the chat where you delivered work hands the buyer the link.
- `quoteNullifier` (private input to your circuit, mirrored on-chain after redeem).
- `paymentNullifier` (the buyer's, but you have it too — never echo).
- The bare `paidOut`/`operatorFee` numbers (the buyer can derive them from `amount` × 0.95 / 0.05; sending the explicit values doesn't help and confirms timing).
- Other quote IDs you've redeemed recently (set membership leak).

## What the buyer learns no matter what

- That the quote settled (visible via `match-status` → `redeemed`).
- The redeem timestamp (within a block window).
- That some seller picked up the funds.

That's it. The mapping `buyer's deposit → seller's wallet` requires either of:
- The seller leaking their pubkey or `payoutTxHash`.
- The buyer reusing the same on-chain wallet to also trade with this seller via a non-shielded path.

The buyer skill explicitly forbids the second; this skill forbids the first.

## Channel hygiene

- Don't put `payoutExplorerUrl` in the same chat where you delivered the buyer's order.
- If the buyer asks for proof, tell them to call `match-status` themselves. The opaque `quoteId` is bearer — they have it via the original payload anyway.
- If you keep a private receipt for accounting, store the seller-side artifacts (`payoutTxHash`, `quoteNullifier`, `sellerReceiptId`) in a place the buyer cannot read.
