# Privacy checklist — seller agent

The on-chain story is solid (the withdraw event has the seller wallet, but no path back to the buyer's deposit). A chatty seller can leak the link via the chat channel.

## Always safe to share with the buyer

- A simple acknowledgement ("paid, thanks").
- The delivery the buyer paid for.
- Confirmation that you redeemed before `validBefore`.

## Never share with the buyer

- `targetAddress` (seller wallet).
- `payoutTxHash` (lets them read the recipient pubkey from the on-chain event).
- `nullifier` (helps them link your withdraw to their deposit).
- Other shielded link IDs you've redeemed (set membership leak).

## What the buyer learns no matter what

- That the link was redeemed (visible via `GET /v1/shielded-links/{linkId}`).
- The redeem timestamp.

## What you (the seller) learn no matter what

- The denomination of this specific link.
- That some buyer paid you for this job.

That's it. Mapping a deposit to a specific buyer requires the buyer to leak their own pubkey — which the buyer skill explicitly forbids.

## Channel hygiene

- Do not paste `payoutExplorerUrl` into the same chat where you delivered the work product.
- If the buyer wants proof, tell them to `GET /v1/shielded-links/{linkId}` themselves.
