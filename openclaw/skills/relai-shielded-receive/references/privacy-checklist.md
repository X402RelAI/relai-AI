# Privacy checklist — seller agent

The on-chain story is solid: the withdraw event names the seller's wallet but has no path back to the buyer's deposit. A chatty seller can leak the link via the chat channel — that's the only failure mode left.

## Always safe to share with the buyer

- A simple acknowledgement ("paid, thanks").
- The delivery the buyer paid for (the work product).
- That you redeemed before `validBefore`.

## Never share with the buyer

- `targetAddress` (seller wallet).
- `payoutTxHash` (lets the buyer read the recipient pubkey from the on-chain event).
- `nullifier` (helps link your withdraw to their deposit).
- Other shielded link IDs you've redeemed (set-membership leak).

## Always safe to share with the user (your operator)

- Everything. The user is the seller — they own the seller wallet, the service key, and the redeem outcome. The privacy budget is between buyer and seller, not between agent and operator.

## What the buyer learns no matter what

- That the link was redeemed (`relai_shielded_status` shows it).
- The redeem timestamp.

## What you (the seller) learn no matter what

- The denomination.
- That some buyer paid you for this job.

That's it. Mapping a deposit to a specific buyer requires the buyer to leak their own pubkey — which the buyer-side discipline (separate skill) explicitly forbids.

## Channel hygiene

- Do not paste `payoutExplorerUrl` into the same chat where you delivered the work product.
- If the buyer wants proof of redeem, tell them to call `relai_shielded_status` with the `linkId` themselves.
- Drop the full `relai:shielded:…` payload from any persistent log immediately after the redeem call returns.
