# What's in the SPR payload

`relai:quote:<base64url>` decodes (after stripping the prefix) to a compact JSON object — authoritative shape from the server's `generateQuotePayload`:

| Key | Long name | Notes |
|---|---|---|
| `v` | version | Currently `1`. |
| `q` | quoteId | Server-assigned opaque ID (`q_...`). |
| `p` | poolId | e.g. `solana-devnet-spr`. |
| `a` | amount | Atomic units (string, USDC = 6 decimals). |
| `s` | sellerSecret | String; private input to BOTH the pairing circuit (buyer) AND the redeem circuit (seller). |
| `n` | nonce | String; private input to both circuits. |
| `e` | expiry | Unix seconds. |
| `d` | description | Optional, ≤ 100 chars. |
| `w` | network | `solana-devnet` / `base-sepolia` / `skale-base-sepolia`. |
| `k` | sellerEncPk | Optional Solana-only X25519 pubkey for sealed proof bundles. |

The payload does NOT carry the commitment or the `quoteNullifier` — both are deterministic from `(amount, sellerSecret, nonce, quoteId)`:

```
quoteCommitment = Poseidon(4)(amount, sellerSecret, nonce, quoteIdHash)
quoteNullifier  = Poseidon(3)(sellerSecret, nonce, quoteIdHash)
quoteIdHash     = keccak256(utf8(quoteId)) mod BN254
```

The seller secret material (`s`, `n`) is held by the platform too — that's how the server can recompute `commitment` and `quoteNullifier` consistently. Encoding it inside the payload lets the seller redeem from any device that has the payload, without storing a separate "redeem credential" alongside the service key.

That's also why the payload is bearer-secret: anyone with it could attempt to redeem (the redeem circuit only checks the holder knows `s` + `n` + `quoteId` and binds them to a recipient pubkey). The redeem flow gates on the on-chain match record — so a redeem only succeeds if a buyer has already paired against this quote.

## Sealed bundles (Solana, optional)

Pass `sellerEncPk` (URL-safe base64 of an X25519 pubkey) when issuing on Solana. Buyers (or the operator on their behalf) seal the buyer's pairing-proof bundle for that key, so the on-chain proof URL stores ciphertext only the seller can open.

The seller MUST keep the corresponding X25519 secret key — losing it doesn't break redeem (the platform-side proof bundle is enough for the operator to relay), but it does break the receipt-UI feature where `snarkjs.verify` runs locally on the decrypted bundle.

Generation example (Node, demo only — production should use a hardware-backed keystore):

```js
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes } from 'node:crypto';
const sk = randomBytes(32);
const pk = x25519.getPublicKey(sk);
const sellerEncPk = Buffer.from(pk).toString('base64url');
```

Hand `sellerEncPk` (publishable) to `/issue`; keep `sk` (secret) in the seller process only.
