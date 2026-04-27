# Seller protocol reference

Exact request/response shapes and circuit input layout for the redeem flow. The HTTP steps work with any HTTP client. The Groth16 proof step requires a Groth16/snarkjs-compatible runtime — Node snippets below are one example; the openclaw plugin's `relai_shielded_redeem` tool wraps the same logic when openclaw is available.

## Endpoint paths — known prod gotcha

The `/v1/shielded-links/...` proxy is currently broken in prod for Solana
networks (the proxy routes to a non-existent path under the Solana
facilitator and falls through to `requireAuth`, returning "Missing or invalid
Authorization header"). Until that's fixed upstream, hit the Solana
facilitator directly:

```
GET  /facilitator/solana-payment-codes/shielded-links/{linkId}/proof-input?network=…
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/redeem-intent
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/execute-withdraw
```

The pool config endpoint stays on the EVM-facilitator dispatcher (it routes
both EVM and Solana via the `?network=` query):

```
GET  /facilitator/payment-codes/shielded-links/config?network=…
```

## Parse the payload

```js
const PREFIXES = ['relai:shielded:', 'shielded:', 's:'];
const lower = input.toLowerCase();
const prefix = PREFIXES.find(p => lower.startsWith(p));
const token = prefix ? input.slice(prefix.length) : input;
const json  = Buffer.from(token, 'base64url').toString('utf8');
const raw   = JSON.parse(json);

const note = {
  version:      raw.v ?? 1,
  poolId:       raw.p ?? raw.poolId,
  assetId:      raw.a ?? raw.assetId,
  denomination: raw.d ?? raw.denomination,
  network:      raw.w ?? raw.network,
  secret:       raw.s ?? raw.secret,
  blinding:     raw.b ?? raw.blinding,
  nonce:        raw.n ?? raw.nonce,
  programId:    raw.g ?? raw.programId,
};
const linkId = raw.l ?? raw.linkId;
```

## Proof input

```bash
curl -s "$API/facilitator/solana-payment-codes/shielded-links/$LINK_ID/proof-input?network=solana-devnet" \
  -H "X-Service-Key: $SK" | jq
```

If `aspReady: false`, sleep 12s and retry.

## Compute nullifier (Poseidon4)

Same field-reduction rules as the buyer (keccak for strings, BigInt for numerics, mod BN254).

```js
const f = {
  noteVersion: numericField(note.version),
  poolIdHash:  stringField(note.poolId),
  secret:      stringField(note.secret),
  nonce:       stringField(note.nonce),
};
const n = poseidon([f.secret, f.nonce, f.poolIdHash, f.noteVersion]);
const nullifier = '0x' + poseidon.F.toObject(n).toString(16).padStart(64, '0');
```

## Redeem intent — the response carries the canonical public inputs

```bash
curl -s -X POST "$API/facilitator/solana-payment-codes/shielded-links/$LINK_ID/redeem-intent" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d "{
    \"network\":       \"solana-devnet\",
    \"nullifier\":     \"$NULLIFIER\",
    \"targetAddress\": \"$SELLER_PUB\",
    \"targetNetwork\": \"solana-devnet\",
    \"recipient\":     \"$SELLER_PUB\"
  }" | jq
```

**Critical:** the response body returns `recipient`, `relayer`, `relayerFee`, and `denomination` as **already field-reduced decimal strings** (the server runs them through its own `solanaPubkeyToFieldDecimalString`). Use them VERBATIM as circuit inputs in the next step. Do **not** recompute them client-side — any subtle encoding difference (missing modulo, wrong endianness, wrong relayer pubkey) silently breaks the proof.

```js
const redeemIntent = await fetch(...).then(r => r.json());
// redeemIntent.recipient      ← decimal string, ready for circuit
// redeemIntent.relayer        ← decimal string of the SERVER relayer pubkey, mod BN254
// redeemIntent.relayerFee     ← decimal string ("0" by default)
// redeemIntent.denomination   ← decimal string of micro-USDC value
```

## Generate Groth16 proof

Public-signal order: `[root, aspRoot, nullifier, denomination, recipient, relayer, relayerFee]`.

```js
import * as snarkjs from 'snarkjs';
const inputs = {
  noteVersion:    numericField(note.version).toString(),
  poolIdHash:     stringField(note.poolId).toString(),
  assetIdHash:    stringField(note.assetId).toString(),
  denomination:   numericField(note.denomination).toString(),
  secret:         stringField(note.secret).toString(),
  blinding:       stringField(note.blinding).toString(),
  nonce:          stringField(note.nonce).toString(),
  pathElements:    pi.pathElements.map(String),
  pathIndices:     pi.pathIndices.map(Number),
  aspPathElements: pi.asp.pathElements.map(String),
  aspPathIndices:  pi.asp.pathIndices.map(Number),
  // Use redeem-intent values verbatim — the server already reduced
  // the relayer pubkey (NOT the EVM zero address!) and the recipient
  // pubkey to BN254 field decimals.
  recipient:       redeemIntent.recipient,
  relayer:         redeemIntent.relayer,
  relayerFee:      redeemIntent.relayerFee,
};

// snarkjs in Node treats string args as filesystem paths and ENOENTs on the
// HTTPS URLs the backend advertises. Pre-fetch both artifacts as Uint8Array.
const wasmBytes = new Uint8Array(await (await fetch(pi.circuitArtifacts.wasmUrl)).arrayBuffer());
const zkeyBytes = new Uint8Array(await (await fetch(pi.circuitArtifacts.zkeyUrl)).arrayBuffer());

const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmBytes, zkeyBytes);
```

## Encode proof for Solana — G2 swap is mandatory

The Solana on-chain verifier (Light-Protocol's `groth16-solana`, ark-bn254 backend) expects each F_p^2 component of G2 as `(im, re)` — snarkjs returns `(re, im)`. We must swap the indices within each pair before ABI-encoding. This matches what `snarkjs.groth16.exportSolidityCallData` produces. Without the swap, the on-chain pairing check silently fails with "groth16 proof verification failed" / custom program error 3.

```js
import { AbiCoder } from 'ethers';
const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
const b = [
  // SWAP: pi_b[0][1] before pi_b[0][0], pi_b[1][1] before pi_b[1][0]
  [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
  [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
];
const c = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];
const encodedProof = AbiCoder.defaultAbiCoder().encode(
  ['uint256[2]', 'uint256[2][2]', 'uint256[2]'],
  [a, b, c],
);
```

The verifier negates pi_a internally (`negate_proof_a`), so we leave pi_a as-is.

EVM uses `snarkjs.groth16.exportSolidityCallData(proof, publicSignals)` directly — the swap convention is the same but the ABI shape and call site differ (proofRequest wrapper vs flat fields).

## Execute withdraw

```bash
curl -s -X POST "$API/facilitator/solana-payment-codes/shielded-links/$LINK_ID/execute-withdraw" \
  -H "X-Service-Key: $SK" -H "Content-Type: application/json" \
  -d "{
    \"network\":       \"solana-devnet\",
    \"targetAddress\": \"$SELLER_PUB\",
    \"targetNetwork\": \"solana-devnet\",
    \"nullifier\":     \"$NULLIFIER\",
    \"root\":          \"$ROOT\",
    \"aspRoot\":       \"$ASP_ROOT\",
    \"proof\":         \"$ENCODED_PROOF\",
    \"recipient\":     \"$SELLER_PUB\",
    \"relayerFee\":    \"0\"
  }" | jq
```

Response: `{status: "redeemed", payoutTxHash, payoutExplorerUrl}`.

## Common pitfalls (all of these cause "groth16 proof verification failed")

| Bug | Symptom |
|---|---|
| Recipient passed as raw base58 to `BigInt()` (no bs58 decode) | `BigInt` throws → fallback `0` → recipient mismatch |
| Recipient encoded but not reduced mod BN254 | Value > field modulus → snarkjs rejects |
| Relayer = `0x000…` (EVM zero address) instead of the server relayer pubkey | On-chain `caller.key()` ≠ proof's `relayer` |
| pi_b passed in `(re, im)` order without G2 swap | Pairing check fails silently |
| `relayerFee` recomputed differently from the server's value | Public-input mismatch |
| Hitting `/v1/shielded-links/...` for Solana create/redeem | "Missing or invalid Authorization header" 401 |

The safest path is to **trust the server's redeem-intent response** for `recipient`, `relayer`, `relayerFee`, `denomination`, and use them verbatim. The only thing the client computes is the proof itself.
