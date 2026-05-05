# Seller redeem protocol reference

Exact request/response shapes and circuit input layout for the SPR redeem flow on Solana. Authoritative reference: `402-everywhere/contracts/circuits/ShieldedPaymentRedeem.circom` + `examples/spr-agent/src/redeem-prover.mjs` + `examples/spr-agent/src/redeem-flow.mjs`.

## Poll match status

```bash
curl -s "$API/facilitator/shielded-payment-requests/$QUOTE_ID/match-status" | jq
```

Wait until `status: "paid"`.

## Read the redeem proof input

```bash
curl -s "$API/v1/shielded-payment-requests/$QUOTE_ID/redeem-proof-input" \
  -H "X-Service-Key: $SK" | jq
```

Response shape (the four fields you actually need are at the top level):

```json
{
  "quoteId":      "q_…",
  "amount":       "1000000",
  "sellerSecret": "…",
  "nonce":        "…"
}
```

These are the same `(amount, sellerSecret, nonce, quoteId)` already encoded in the original `relai:quote:` payload. The endpoint exists so the seller can run the redeem flow purely from the `quoteId` without re-decoding the payload. Other fields the server may include are informational; the prover only consumes the four listed.

## Public-signal layout

The redeem circuit (`ShieldedPaymentRedeem.circom`) is intentionally tiny — three private inputs + one public input → one public output:

```
private:  sellerSecret, nonceQuote, quoteIdHash
public:   recipient                                ← input
output:   quoteNullifier                           ← Poseidon(3)(sellerSecret, nonceQuote, quoteIdHash)
```

circom serialises outputs first then public inputs alphabetically, so the on-chain verifier reads:

```
[0] quoteNullifier
[1] recipient
```

The `recipient` is the per-quote **stealth pubkey** (NOT the seller's main wallet) — see Stealth Recipient below.

## Derive the per-quote stealth keypair

```js
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

const challenge = new TextEncoder().encode(`relai-spr-stealth-seller:v1:${quoteId}`);
const signature = nacl.sign.detached(challenge, walletKeypair.secretKey);    // 64-byte ed25519 sig
const seed      = new Uint8Array(createHash('sha256').update(signature).digest());
const stealthKp = Keypair.fromSeed(seed);
```

Deterministic per `(wallet, quoteId)`. Anyone with the seller's main wallet can re-derive the stealth keypair; an attacker without it can't.

## Generate the redeem proof

```js
import * as snarkjs from 'snarkjs';
import { keccak256, toUtf8Bytes } from 'ethers';

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const reduce       = v => { const r = v % P; return r >= 0n ? r : r + P; };
const stringField  = s => s ? reduce(BigInt(keccak256(toUtf8Bytes(String(s).trim())))) : 0n;
const pubkeyToBigInt = bytes => bytes.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n);

const inputs = {
  sellerSecret: stringField(proofInput.sellerSecret).toString(),
  nonceQuote:   stringField(proofInput.nonce).toString(),
  quoteIdHash:  stringField(proofInput.quoteId).toString(),
  recipient:    pubkeyToBigInt(stealthKp.publicKey.toBytes()).toString(), // raw, NOT pre-reduced
};

const wasmBytes = new Uint8Array(await (await fetch('https://relai.fi/zk/shielded-payment-redeem/redeem.wasm')).arrayBuffer());
const zkeyBytes = new Uint8Array(await (await fetch('https://relai.fi/zk/shielded-payment-redeem/redeem.zkey')).arrayBuffer());

const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmBytes, zkeyBytes);
// publicSignals = [quoteNullifier, recipient_mod_p]
```

`recipient` is passed RAW to the circuit; snarkjs auto-reduces mod P. The on-chain `solana-spr-payout-router` reduces the actual stealth pubkey via its `pubkey_mod_bn254_p` helper before its byte-equality check — so even "high-bytes" stealth pubkeys (~25% of generated keypairs) verify.

## Encode proof for Solana

256-byte big-endian buffer: `pi_a (64B) || pi_b (128B) || pi_c (64B)`. Use `snarkjs.groth16.exportSolidityCallData` — it already produces the `(real, im)` G2 ordering ark-bn254 expects:

```js
const raw = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals.map(String));
const [pA, pB, pC] = JSON.parse(`[${raw}]`);

function be32(v) {
  const hex = BigInt(v).toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

const proofBytes = Buffer.concat([
  be32(pA[0]), be32(pA[1]),
  be32(pB[0][0]), be32(pB[0][1]),
  be32(pB[1][0]), be32(pB[1][1]),
  be32(pC[0]), be32(pC[1]),
]);
const proofBase64 = proofBytes.toString('base64');
```

## Redeem relay

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/$QUOTE_ID/solana-redeem-relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\":              \"solana-devnet\",
    \"proofBase64\":          \"$PROOF_BASE64\",
    \"recipientHex\":         \"0x$REDUCED_RECIPIENT_HEX\",
    \"recipientPubkey\":      \"$STEALTH_PUBKEY_BASE58\",
    \"quoteNullifierHex\":    \"0x$QUOTE_NULLIFIER_HEX\",
    \"claimedAmountAtomic\":  \"$AMOUNT_FROM_PROOF_INPUT\"
  }" | jq
```

Response: `{ok: true, signature, alreadyRedeemed?, relayer}`. The operator signed `payout_to_seller`; the router atomically split 95% to the **stealth ATA** (NOT the seller's main wallet) and 5% to the platform fee ATA. Save the `relayer` pubkey — you need it as `feePayer` for the next step.

## Stealth claim — second relay step

The 95% sits in the stealth ATA. To get it into the seller's main wallet, the seller's stealth keypair signs a `transferChecked` from `stealthAta → mainAta` and the operator co-signs as `feePayer`.

```js
import {
  Connection, PublicKey, Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const fee = (BigInt(amount) * 500n + 9_999n) / 10_000n; // ceil(face * 5%)
const net = BigInt(amount) - fee;                        // 95%

const stealthAta = getAssociatedTokenAddressSync(usdcMint, stealthKp.publicKey, false);
const mainAta    = getAssociatedTokenAddressSync(usdcMint, walletKeypair.publicKey, false);

const claimTx = new Transaction();
const mainAtaInfo = await connection.getAccountInfo(mainAta);
if (!mainAtaInfo) {
  claimTx.add(createAssociatedTokenAccountIdempotentInstruction(
    relayerPubkey, mainAta, walletKeypair.publicKey, usdcMint,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
}
claimTx.add(createTransferCheckedInstruction(
  stealthAta, usdcMint, mainAta, stealthKp.publicKey, net, 6, [], TOKEN_PROGRAM_ID,
));

claimTx.feePayer = relayerPubkey;
const { blockhash } = await connection.getLatestBlockhash('confirmed');
claimTx.recentBlockhash = blockhash;
claimTx.partialSign(stealthKp);  // only the stealth keypair signs locally
const txBase64 = claimTx.serialize({ requireAllSignatures: false }).toString('base64');
```

Then:

```bash
curl -s -X POST "$API/v1/shielded-payment-requests/solana-stealth-claim-relay" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\":           \"solana-devnet\",
    \"txBase64\":          \"$TX_BASE64\",
    \"expectedAuthority\": \"$STEALTH_PUBKEY_BASE58\"
  }" | jq
```

Response: `{ok: true, signature}`. Funds now in the seller's main wallet ATA.

## Common pitfalls

| Bug | Symptom |
|---|---|
| Hit `/redeem-proof-input` before `match-status` is `paid` | 409 `match not yet recorded` |
| Forgot the stealth keypair derivation, used the main wallet pubkey | The on-chain match is by `quoteNullifier`, but the proof's `recipient` won't match what the operator pays out to → `invalid_proof` 400 |
| Skipped the stealth claim step | 95% sits in the stealth ATA forever (or until you re-derive the keypair and run the claim) |
| Used `claimedAmountAtomic` ≠ `proofInput.amount` | Server rejects: face value mismatch |
| Wrong G2 byte order in `proofBase64` | Pairing check fails on-chain → `invalid_proof` |
| Service key from a different agent | 403 — only the issuing service key can pull proof input |
