# Redeem protocol — what `relai_shielded_redeem` wraps

The tool collapses four request/response steps into one call. This file documents them so you can debug a partial failure or reproduce the call manually with `curl` + `snarkjs` if needed.

## Endpoint paths — known prod gotcha

The `/v1/shielded-links/...` proxy is currently broken in prod for Solana (the Solana facilitator doesn't expose `/shielded-links/config` and proxy fall-through hits `requireAuth`, returning "Missing or invalid Authorization header"). The plugin tool bypasses this by calling the Solana facilitator directly:

```
GET  /facilitator/solana-payment-codes/shielded-links/{linkId}/proof-input?network=…
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/redeem-intent
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/execute-withdraw
```

If you reproduce manually, use these paths.

## Step 1 — `proof-input`

```
GET /facilitator/solana-payment-codes/shielded-links/{linkId}/proof-input?network={network}
X-Service-Key: sk-agent-...
```

Response (V4 pool):

```json
{
  "contractVersion": "v4",
  "settlementNetwork": "solana-devnet",
  "denomination": "100000",
  "root":          "0x...",
  "pathElements":  [...],
  "pathIndices":   [0, 1, ...],
  "asp": {
    "root":         "0x...",
    "pathElements": [...],
    "pathIndices":  [...]
  },
  "aspRequired": true,
  "aspReady":    true,
  "circuitArtifacts": {
    "wasmUrl":  "https://relai.fi/zk/shielded-withdraw-asp/withdraw.wasm",
    "zkeyUrl":  "https://relai.fi/zk/shielded-withdraw-asp/withdraw.zkey"
  }
}
```

`aspReady: false` is a transient state — the commitment is too fresh for the latest ASP snapshot. The tool surfaces this as `retryable: true`.

## Step 2 — `redeem-intent` — the response carries the canonical public inputs

Locks the recipient and the nullifier so concurrent redeem attempts are detected.

```
POST /facilitator/solana-payment-codes/shielded-links/{linkId}/redeem-intent
X-Service-Key: sk-agent-...
Content-Type: application/json

{
  "network":       "solana-devnet",
  "nullifier":     "0x...",                 // Poseidon4(secret, nonce, poolIdHash, noteVersion)
  "targetAddress": "<seller pubkey>",
  "targetNetwork": "solana-devnet",
  "recipient":     "<seller pubkey>"
}
```

**Critical:** the response body returns `recipient`, `relayer`, `relayerFee`, and `denomination` as **already field-reduced decimal strings** (the server runs them through its own `solanaPubkeyToFieldDecimalString`). They're the EXACT values the on-chain verifier will compute from the actual relayer keypair and payee account. Use them VERBATIM as circuit inputs in step 3 — do not recompute client-side.

```json
{
  "recipient":   "20335766934857665272...",   // bs58→bigint→mod BN254 of seller pubkey
  "relayer":     "...",                       // bs58→bigint→mod BN254 of SERVER relayer pubkey (NOT zero!)
  "relayerFee":  "0",
  "denomination":"100000",
  ...
}
```

## Step 3 — Groth16 proof (local)

Public-signal order is mandatory:

```
[ root, aspRoot, nullifier, denomination, recipient, relayer, relayerFee ]
```

Circuit inputs:

```js
{
  // Note fields, all reduced mod BN254 — same field reduction as the buyer
  // used at create time (keccak for strings, BigInt for numerics).
  noteVersion, poolIdHash, assetIdHash, denomination,
  secret, blinding, nonce,

  // Pool Merkle witness (depth 20)
  pathElements, pathIndices,

  // ASP Merkle witness
  aspPathElements, aspPathIndices,

  // Public inputs — pass redeem-intent response values VERBATIM.
  // Do NOT recompute. The server already field-reduced them; any client-side
  // re-encoding (bs58 + modulo, EVM zero address, etc.) risks divergence
  // from what the on-chain verifier will compute → "groth16 proof
  // verification failed" / custom program error 3.
  recipient: redeemIntent.recipient,    // decimal string from the response
  relayer:   redeemIntent.relayer,      // decimal string of SERVER relayer pubkey
  relayerFee:redeemIntent.relayerFee,   // "0" by default
}
```

```js
// snarkjs in Node treats string args as filesystem paths and ENOENTs on the
// HTTPS URLs the backend advertises. Pre-fetch both artifacts as Uint8Array.
const wasmBytes = new Uint8Array(await (await fetch(pi.circuitArtifacts.wasmUrl)).arrayBuffer());
const zkeyBytes = new Uint8Array(await (await fetch(pi.circuitArtifacts.zkeyUrl)).arrayBuffer());

const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmBytes, zkeyBytes);
```

Encode the proof for Solana. **G2 swap is mandatory** — the Light-Protocol `groth16-solana` verifier (ark-bn254 backend) expects each F_p^2 component as `(im, re)`; snarkjs returns `(re, im)`. This is the same swap `snarkjs.groth16.exportSolidityCallData` produces. Without it the on-chain pairing check fails silently with "groth16 proof verification failed".

```js
const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
const b = [
  // SWAP (im, re) — pi_b[0][1] before pi_b[0][0], pi_b[1][1] before pi_b[1][0]
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

EVM uses `snarkjs.groth16.exportSolidityCallData(proof, publicSignals)` directly — same swap convention but a different ABI shape and call site (proofRequest wrapper vs flat fields).

## Step 4 — `execute-withdraw`

Body shape differs per network.

**Solana:**

```json
{
  "network":       "solana-devnet",
  "targetAddress": "<seller pubkey>",
  "targetNetwork": "solana-devnet",
  "nullifier":     "0x...",
  "root":          "0x...",
  "aspRoot":       "0x...",
  "proof":         "0x<abi-encoded a,b,c>",
  "recipient":     "<seller pubkey>",
  "relayerFee":    "0"
}
```

**EVM:**

```json
{
  "network":       "base-sepolia",
  "targetAddress": "0x<seller>",
  "targetNetwork": "base-sepolia",
  "proofRequest": {
    "proof": "0x<abi-encoded>",
    "publicSignals": {
      "root": "...", "aspRoot": "...", "nullifier": "...",
      "denomination": "...", "recipient": "...",
      "relayer": "...", "relayerFee": "0"
    }
  }
}
```

The pool relayer:

1. Verifies `root` matches the on-chain pool root.
2. Verifies `aspRoot` matches the latest published ASP root.
3. CPI-calls the ASP verifier program to check the Groth16 proof.
4. Marks the nullifier PDA as spent.
5. Transfers `denomination - relayerFee` USDC from `pool_vault` → recipient ATA. Creates the recipient ATA if needed (relayer pays rent).

Response (success):

```json
{
  "status":            "redeemed",
  "payoutTxHash":      "<base58 signature>",
  "payoutExplorerUrl": "https://solscan.io/tx/...?cluster=devnet"
}
```

## Common pitfalls (all surface as "groth16 proof verification failed" / custom error 3)

| Bug | Symptom |
|---|---|
| Recipient passed as raw base58 to `BigInt()` (no bs58 decode) | `BigInt` throws → fallback `0` → recipient mismatch |
| Recipient encoded but not reduced mod BN254 | Value > field modulus → snarkjs rejects |
| Relayer = `0x000…` (EVM zero) instead of the server relayer pubkey | On-chain `caller.key()` ≠ proof's `relayer` |
| pi_b passed in `(re, im)` order without G2 swap | Pairing check fails silently |
| `relayerFee` recomputed differently from the server's value | Public-input mismatch |
| Hitting `/v1/shielded-links/...` for Solana create/redeem | "Missing or invalid Authorization header" 401 |

The plugin's `relai_shielded_redeem` tool already encodes all of these correctly. If you reproduce manually, mirror its behavior exactly: trust the redeem-intent response for public inputs, swap pi_b's internal indices, and use the facilitator path.

## Common errors

| HTTP / signal | Cause |
|---|---|
| `aspReady: false` (proof-input) | Commitment too fresh for the latest ASP snapshot. Wait ≥ 12s. |
| `409 already_redeemed` | Nullifier already spent. Funds went to whoever called execute-withdraw first. |
| `400 invalid_proof` | Public signals don't match the circuit. See the "Common pitfalls" table above. |
| `429 rate_limited` | Too many invalid proofs in a row. Stop and verify the payload. |
| `502 shielded_payout_failed_after_settlement` | Source-side withdraw OK but cross-network relay failed (only with `targetNetwork ≠ network`). Use `POST .../shielded-links/{linkId}/retry-payout` to recover. |
