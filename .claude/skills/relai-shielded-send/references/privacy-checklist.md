# Privacy checklist — buyer agent

The pool's unlinkability story relies on the buyer being disciplined about what it reveals to the seller through the message channel. The chain is private; the chat must not undo that.

## Always safe to share

- The encoded `relai:shielded:<base64url>` payload itself.
- The denomination (the seller learns it on redeem anyway).
- A short job tag (e.g. "translation"). No PII.
- The `validBefore` so the seller knows when to redeem.

## Never share

- Buyer's Solana **pubkey** (`fundedBy`).
- The Poseidon **commitment**.
- The **nullifier** (Poseidon4 of the secret material — partial leak of the note).
- The **`depositTxHash`** (explicit on-chain link to the buyer wallet).
- Any **other** shielded link IDs you've created (set membership leaks pipeline scale).

## Channel hygiene

- Use a channel the seller will not log indefinitely.
- Do **not** include any "never share" item in the same message as the payload, even in a debug dump.
- If the seller asks for proof of funding, tell them to call `GET /v1/shielded-links/{linkId}` themselves with their own service key.
