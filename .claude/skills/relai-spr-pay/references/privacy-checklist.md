# Privacy checklist — buyer agent (SPR)

The unlinkability story for SPR depends on the buyer being disciplined about what flows back to the seller through the chat channel. The on-chain match record names a `submitter` (the buyer's wallet) — that's public anyway. What the seller MUST NOT learn from chat is anything that ties THIS deposit back to a recurring buyer identity.

## Always safe to share

- A short ack ("paid").
- The fact that the deposit is in flight (non-actionable status update).

## Never share

- Buyer's Solana / EVM **pubkey** (`submitter`). The on-chain event names it; you don't need to confirm it in chat.
- The Poseidon **commitment** beyond what's in the payload (the seller can read it from their own quote).
- The **paymentNullifier** — partial leak of buyer secret material.
- The **deposit tx hash** — explicit on-chain link from chat to wallet.
- Any **other** SPR quotes you've paid recently (set membership leaks pipeline scale).

## Fund a one-shot wallet for stronger unlinkability

If the user wants the strongest privacy: fund a fresh keypair with the exact `amount + a few thousand lamports for fees` from a separate well-mixed source, use that keypair only for THIS deposit, and never touch it again. The on-chain `submitter` becomes a dead-end leaf the seller can't tie to other transactions of yours.

This is optional — for routine payments where the buyer's identity is already common knowledge to the seller (e.g. a B2B procurement flow), reusing a primary wallet is fine. The decision is the user's, not the agent's.

## Channel hygiene

- Use a channel the seller will not log indefinitely.
- Do **not** include any "never share" item in the same message as the ack, even in a debug dump.
- If the seller asks for proof of payment, tell them to call `match-status` with their own service key. They don't need anything from you.
