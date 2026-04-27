# Buyer protocol reference

Exact request/response shapes and the Poseidon math. The HTTP steps work with any HTTP client (`curl`, fetch, WebFetch, etc.). The cryptographic + on-chain steps need a runtime with the right libraries — Node snippets below are one example; equivalent Python (`pycryptodome` + Poseidon BN254 + Solana SDK) or Rust implementations are valid alternatives.

## Endpoint paths — known prod gotcha

The `/v1/shielded-links/...` proxy is currently broken in prod for Solana
networks (the Solana facilitator doesn't expose a `/shielded-links/config`
route, the proxy fall-through hits `requireAuth`, and the response is
"Missing or invalid Authorization header" 401). Until that's fixed upstream,
hit the facilitator paths directly:

```
GET  /facilitator/payment-codes/shielded-links/config?network=…   ← dispatcher, handles Solana too
POST /facilitator/solana-payment-codes/shielded-links              ← create draft
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/fund ← report on-chain deposit
GET  /facilitator/solana-payment-codes/shielded-links/{linkId}     ← read status
```

The samples below use these paths.

## Pool config

```bash
curl -s "$API/facilitator/payment-codes/shielded-links/config?network=solana-devnet" \
  -H "X-Service-Key: $SK" | jq
```

```json
{
  "shieldedLink": true,
  "nativeSolanaShielded": true,
  "settlementNetwork": "solana-devnet",
  "programId": "GW43ARYCQgzVmnX7Nx9mx1s8AjJSdrpAbthaMpKJU8aj",
  "verifierProgramId": "...",
  "usdcMint": "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
  "rpcUrl": "https://api.devnet.solana.com",
  "issuerFeeBps": 500
}
```

## Note generation (Node)

```js
import crypto from 'node:crypto';
const note = {
  version: 1,
  poolId: `solana-devnet:usdc:${valueMicro}`,
  assetId: 'usdc',
  denomination: String(valueMicro),
  network: 'solana-devnet',
  programId: cfg.programId,
  secret:   crypto.randomBytes(32).toString('base64url'),
  blinding: crypto.randomBytes(32).toString('base64url'),
  nonce:    crypto.randomBytes(16).toString('base64url'),
};
```

## Field reduction (BN254)

```js
import { keccak256, toUtf8Bytes } from 'ethers';
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const reduce = v => { const r = v % P; return r >= 0n ? r : r + P; };
const stringField  = s => s ? reduce(BigInt(keccak256(toUtf8Bytes(String(s).trim())))) : 0n;
const numericField = v => { const t = String(v).trim(); if (!t) return 0n;
  try { return reduce(BigInt(t)); } catch { return stringField(t); } };
```

## Poseidon commitment

```js
import { buildPoseidon } from 'circomlibjs';
const poseidon = await buildPoseidon();

const f = {
  noteVersion:  numericField(note.version),
  poolIdHash:   stringField(note.poolId),
  assetIdHash:  stringField(note.assetId),
  denomination: numericField(note.denomination),
  secret:       stringField(note.secret),
  blinding:     stringField(note.blinding),
  nonce:        stringField(note.nonce),
};
const c = poseidon([
  f.noteVersion, f.poolIdHash, f.assetIdHash, f.denomination,
  f.secret, f.blinding, f.nonce,
]);
const commitment = '0x' + poseidon.F.toObject(c).toString(16).padStart(64, '0');
```

## Create draft

```bash
curl -s -X POST "$API/facilitator/solana-payment-codes/shielded-links" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d "{
    \"settlementNetwork\": \"solana-devnet\",
    \"from\":              \"$BUYER_PUB\",
    \"value\":             4000000,
    \"feeAmount\":         200000,
    \"totalAmount\":       4200000,
    \"validBefore\":       $((`date +%s` + 3600)),
    \"description\":       \"translation\",
    \"commitment\":        \"$COMMITMENT\",
    \"noteVersion\":       1
  }" | jq
```

If the response includes a rewritten `poolId`/`denomination`/`assetId`, **realign the local note before encoding the payload** — the seller's redeem will compute the commitment from the payload values and the proof will fail otherwise.

## On-chain deposit

Anchor `deposit_note` discriminator: `sha256("global:deposit_note")[0..8]`.

Data: `discriminator || commitment[32] || amount_le_u64`.

**Critical — amount is `value`, NOT `totalAmount`.** On Solana, the pool issuer fee is server-side accounting only — there's no on-chain fee transfer. The `verifyShieldedSolanaDepositOnChain` server check compares the on-chain `deposit_account.amount` against `entry.value` (recipient amount). If you deposit `totalAmount = value + fee` on-chain, the server returns `400 invalid_shielded_deposit_tx` ("Shielded deposit account amount does not match the expected value"). Use `amount = value` (the recipient amount) in the deposit ix data.

EVM is different: the EIP-3009 authorization moves `totalAmount` and the fee is split server-side. The Solana on-chain fee is non-existent.

Accounts: `[depositor(SW), pool(W), deposit(W), pool_vault(W), depositor_ata(W), token_program, system_program]`.

PDAs:

```js
const [pool] = PublicKey.findProgramAddressSync(
  [Buffer.from('shielded-pool'), new PublicKey(cfg.usdcMint).toBuffer()],
  new PublicKey(cfg.programId),
);
const [depositPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('shielded-deposit'), pool.toBuffer(),
   Buffer.from(commitment.slice(2), 'hex')],
  new PublicKey(cfg.programId),
);
const poolVaultAta   = getAssociatedTokenAddressSync(usdcMint, pool, true,  TOKEN_PROGRAM_ID);
const depositorAta   = getAssociatedTokenAddressSync(usdcMint, buyer, false, TOKEN_PROGRAM_ID);
```

If `depositorAta` does not exist, prepend `createAssociatedTokenAccountInstruction(buyer, depositorAta, buyer, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)` to the tx.

## Nullifier

```js
const n = poseidon([f.secret, f.nonce, f.poolIdHash, f.noteVersion]);
const nullifier = '0x' + poseidon.F.toObject(n).toString(16).padStart(64, '0');
```

## Report fund

```bash
curl -s -X POST "$API/facilitator/solana-payment-codes/shielded-links/$LINK_ID/fund" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d "{
    \"network\":        \"solana-devnet\",
    \"commitment\":     \"$COMMITMENT\",
    \"depositTxHash\":  \"$DEPOSIT_SIG\",
    \"fundedBy\":       \"$BUYER_PUB\",
    \"nullifier\":      \"$NULLIFIER\"
  }" | jq
```

Expect `{ "status": "funded", ... }`.

## Encode payload

Compact JSON, base64url, prefix `relai:shielded:`:

```js
const compact = {
  v: note.version, p: note.poolId, l: shieldedLinkId,
  s: note.secret, b: note.blinding, n: note.nonce,
  a: note.assetId, d: note.denomination, w: note.network, g: note.programId,
};
const payload = 'relai:shielded:' +
  Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
```
