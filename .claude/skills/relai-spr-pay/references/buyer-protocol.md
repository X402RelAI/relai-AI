# Buyer protocol reference

Exact request/response shapes and the cryptography for SPR pairing on Solana. The HTTP steps work with any HTTP client; the cryptography needs a Groth16/snarkjs-compatible runtime.

The reference Node implementation is `examples/spr-demo/lib/pay-spr.mjs` (vendored from `402-everywhere/examples/spr-agent/src/pay-spr.mjs`). What follows are the shapes that helper assembles.

## Decode the payload

The payload short keys are: `v` (version), `q` (quoteId), `p` (poolId), `a` (amount), `s` (sellerSecret), `n` (nonce), `e` (expiry), `d` (description), `w` (network), `k` (sellerEncPk). NO commitment or nullifier — recompute them locally if you need them.

```js
const PREFIXES = ['relai:quote:', 'quote:', 'q:'];
const lower = input.toLowerCase();
const prefix = PREFIXES.find(p => lower.startsWith(p));
const token = prefix ? input.slice(prefix.length) : input;
const json  = Buffer.from(token, 'base64url').toString('utf8');
const raw   = JSON.parse(json);

const quote = {
  version:      raw.v ?? 1,
  quoteId:      raw.q ?? raw.quoteId,
  poolId:       raw.p ?? raw.poolId,
  amount:       raw.a ?? raw.amount,
  sellerSecret: raw.s ?? raw.sellerSecret,
  nonce:        raw.n ?? raw.nonce,
  expiry:       raw.e ?? raw.expiry,
  description:  raw.d ?? raw.description,
  network:      raw.w ?? raw.network,
  sellerEncPk:  raw.k ?? raw.sellerEncPk,
};
```

## Generate the buyer's V4-pool note

The buyer's deposit goes into the SAME `solana-shielded-pool` program shielded links use. The note has the V4 7-field shape:

```js
import crypto from 'node:crypto';
const buyerNote = {
  noteVersion: 1,
  poolId:      'solana-devnet-spr',          // SPR uses its own logical pool id
  assetId:     'usdc',
  denomination: quote.amount,                // MUST equal quote.amount
  secret:   '0x' + crypto.randomBytes(32).toString('hex'),
  blinding: '0x' + crypto.randomBytes(32).toString('hex'),
  nonce:    '0x' + crypto.randomBytes(32).toString('hex'),
};
```

**Persist `secret`/`blinding`/`nonce` BEFORE depositing** — losing them locks the funds. The reference implementation in `examples/spr-demo/lib/pay-spr.mjs` returns them in `result.buyerNote` so the caller can serialise them to disk.

## Compute the buyer's pool commitment

```js
import { computeShieldedCommitment } from './shielded-note-fields.mjs';   // V4 Poseidon-7
const commitmentHex = await computeShieldedCommitment(buyerNote);
//   = Poseidon(7)(noteVersion, poolIdHash, assetIdHash, denomination,
//                 secret, blinding, nonce)
```

Field reduction is keccak256-mod-p for strings, BigInt-mod-p for numerics — same convention as the redeem circuit.

## SPL deposit on Solana

SPR reuses the SAME `deposit_note` instruction shielded links use — the on-chain pool program is `solana-shielded-pool` (V4.1, `GW43...`), and the leaf inserted into the pool tree is the BUYER's commitment (computed above), not the seller's quote commitment.

Hardcoded devnet constants:

```
programId = GW43ARYCQgzVmnX7Nx9mx1s8AjJSdrpAbthaMpKJU8aj
usdcMint  = 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
rpcUrl    = https://api.devnet.solana.com
```

Anchor `deposit_note` discriminator: `sha256("global:deposit_note")[0..8]`.
Data: `discriminator || buyer_commitment[32] || amount_le_u64`.

PDAs:

```js
const [pool] = PublicKey.findProgramAddressSync(
  [Buffer.from('shielded-pool'), new PublicKey(usdcMint).toBuffer()],
  new PublicKey(programId),
);
const [depositPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('shielded-deposit'), pool.toBuffer(),
   buyerCommitmentBytes],
  new PublicKey(programId),
);
```

Accounts (in order): `[buyer(SW), pool(W), depositPda(W), pool_vault(W), buyer_ata(W), token_program, system_program]`.

After confirmation, read the deposit PDA's `leaf_index` (offset 80, u64 LE) — the witness fetch needs it.

## Report the deposit

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/$QUOTE_ID/solana-deposit-confirmed" \
  -H "Content-Type: application/json" \
  -d "{
    \"commitment\":    \"$BUYER_COMMITMENT\",
    \"depositTxHash\": \"$DEPOSIT_SIG\",
    \"depositPda\":    \"$DEPOSIT_PDA\"
  }" | jq
```

(Body keys: `commitment`, `depositTxHash`, `depositPda` — the network is implicit per the quote and `network` is NOT a field here.) Server reads the deposit PDA, indexes the new pool leaf, and unlocks the witness routes.

## Wait for ASP, then fetch witnesses

```bash
# Wait ~10s after the deposit lands.

# Quote witness (no auth)
curl -s "$API/facilitator/shielded-payment-requests/$QUOTE_ID/quote-witness" | jq

# Pool witness
curl -s "$API/v1/shielded-payment-requests/solana-pool-witness/$QUOTE_COMMITMENT?network=solana-devnet" | jq

# ASP witness
curl -s "$API/v1/shielded-payment-requests/solana-asp-witness/$QUOTE_COMMITMENT?network=solana-devnet" | jq
```

If the ASP witness response includes `aspBlockedReason`, sleep 12s and retry.

## Generate the pairing proof

Authoritative public-signal order — circuit outputs in declaration order, NO public inputs (taken verbatim from `402-everywhere/contracts/circuits/ShieldedPaymentPairing.circom`):

```
[0] poolRoot
[1] aspRoot
[2] quoteRoot
[3] paymentNullifier      Poseidon(4)(secretPayment, noncePayment, poolIdHash, noteVersion)
[4] quoteNullifier        Poseidon(3)(sellerSecret, nonceQuote, quoteIdHash)
```

The buyer's `submitter` pubkey is NOT in the public signals — it's tracked by `PaymentMatchRouterV2.verify_and_record` as the on-chain caller.

Circuit inputs (mirror of the reference `buildPairingCircuitInputs`):

```js
const inputs = {
  // Shared private witness — same `amount` enters BOTH Poseidon preimages
  // (this is how amount-equality between quote and payment is enforced).
  amount:           numericField(quote.amount).toString(),

  // Quote-side private witness
  sellerSecret:     stringField(quote.sellerSecret).toString(),
  nonceQuote:       stringField(quote.nonce).toString(),
  quoteIdHash:      stringField(quote.quoteId).toString(),
  quotePathElements: quoteWitness.pathElements.map(BigInt).map(String),
  quotePathIndices:  quoteWitness.pathIndices.map(Number),

  // Payment-side (V4 buyer note) private witness
  noteVersion:      numericField(buyerNote.noteVersion).toString(),
  poolIdHash:       stringField(buyerNote.poolId).toString(),
  assetIdHash:      stringField(buyerNote.assetId).toString(),
  secretPayment:    stringField(buyerNote.secret).toString(),
  blindingPayment:  stringField(buyerNote.blinding).toString(),
  noncePayment:     stringField(buyerNote.nonce).toString(),
  poolPathElements: poolWitness.pathElements.map(BigInt).map(String),
  poolPathIndices:  poolWitness.pathIndices.map(Number),
  aspPathElements:  aspWitness.pathElements.map(BigInt).map(String),
  aspPathIndices:   aspWitness.pathIndices.map(Number),
};

// Pre-fetch wasm/zkey as Uint8Array (snarkjs in Node ENOENTs on https URLs).
const WASM_URL = 'https://relai.fi/zk/shielded-payment-pairing/pairing.wasm';
const ZKEY_URL = 'https://relai.fi/zk/shielded-payment-pairing/pairing.zkey';
const wasmBytes = new Uint8Array(await (await fetch(WASM_URL)).arrayBuffer());
const zkeyBytes = new Uint8Array(await (await fetch(ZKEY_URL)).arrayBuffer());

const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmBytes, zkeyBytes);
```

## Encode the proof for Solana

Same convention as shielded-link redeem: G2 components must be swapped `(im, re)` for the on-chain ark-bn254 backend. Then concat `pi_a (64B) || pi_b (128B) || pi_c (64B)` into a 256-byte buffer, base64-encode.

```js
function bigintToBE32(v) {
  const out = new Uint8Array(32);
  let n = v % P; if (n < 0n) n += P;
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

const buf = new Uint8Array(256);
buf.set(bigintToBE32(BigInt(proof.pi_a[0])),    0);
buf.set(bigintToBE32(BigInt(proof.pi_a[1])),   32);
buf.set(bigintToBE32(BigInt(proof.pi_b[0][1])), 64);  // SWAP
buf.set(bigintToBE32(BigInt(proof.pi_b[0][0])), 96);
buf.set(bigintToBE32(BigInt(proof.pi_b[1][1])), 128); // SWAP
buf.set(bigintToBE32(BigInt(proof.pi_b[1][0])), 160);
buf.set(bigintToBE32(BigInt(proof.pi_c[0])),   192);
buf.set(bigintToBE32(BigInt(proof.pi_c[1])),   224);
const proofBase64 = Buffer.from(buf).toString('base64');
```

Public signals are sent as 0x-padded 64-char hex.

## Pairing relay

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/$QUOTE_ID/solana-pairing-relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\":        \"solana-devnet\",
    \"proofBase64\":    \"$PROOF_BASE64\",
    \"publicSignals\":  [\"$POOL_ROOT\",\"$ASP_ROOT\",\"$QUOTE_ROOT\",\"$PAYMENT_NULLIFIER\",\"$QUOTE_NULLIFIER\"]
  }" | jq
```

Response: `{ok: true, signature, alreadyRelayed?, matchedAt}`. The operator signed `verify_and_record` on `PaymentMatchRouterV2`; the match is now in `PaymentMatchRegistry`.

## Optional — proof stash for the seller's receipt UI

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/$QUOTE_ID/solana-pairing-proof" \
  -H "Content-Type: application/json" \
  -d "{
    \"proofBase64\":   \"$PROOF_BASE64\",
    \"publicSignals\": [\"$POOL_ROOT\",\"$ASP_ROOT\",\"$QUOTE_ROOT\",\"$PAYMENT_NULLIFIER\",\"$QUOTE_NULLIFIER\"],
    \"txHash\":        \"$PAIR_TX_SIG\"
  }" | jq
```

(Body keys: `proofBase64`, `publicSignals`, `txHash` — no `network` field.) If the seller issued with `sellerEncPk`, optionally seal the proof bundle for their X25519 pubkey first (using `tweetnacl.box.seal` or `@noble/curves` equivalent), and POST the ciphertext as `proofBase64`.

## Common pitfalls

| Bug | Symptom |
|---|---|
| Hit `/v1/shielded-payment-requests/...` on a non-existent quoteId | 404 |
| Used `RELAI_SERVICE_KEY` accidentally on a public route | Some routes 401 if header is malformed; remove the header for the public endpoints. |
| Forgot the G2 swap | Pairing relay 400 / `invalid_proof` |
| Submitter field not pubkey-to-BN254-reduced | proof verifies locally but on-chain pairing check fails |
| Re-fetched witnesses too soon (`aspReady: false` ignored) | Stale ASP root → proof mismatches snapshot at `verify_and_record` time |
| Deposited `amount + fee` (shielded-link habit) | SPR has no per-deposit fee — the 5% is a redeem-side router split. Excess deposit silently sits in the pool. |
