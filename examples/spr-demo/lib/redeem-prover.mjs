// Vendored from 402-everywhere/examples/spr-agent/src/redeem-prover.mjs
// with one adaptation: accept Uint8Array `wasmBytes` / `zkeyBytes` so the
// demo can fetch circuit artefacts over HTTP.
//
// Public-signal layout (4 private witnesses → 2 public outputs):
//   private:  sellerSecret, nonceQuote, quoteIdHash, recipient
//   public:   [0] quoteNullifier   (Poseidon3(sellerSecret, nonceQuote, quoteIdHash))
//             [1] recipient        (mod-p reduced 32-byte pubkey)

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

import { deriveQuoteFieldInputs } from "./quote-fields.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WASM_PATH = resolve(
  __dirname,
  "../../../402-everywhere/frontend/public/zk/shielded-payment-redeem/redeem.wasm",
);
const DEFAULT_ZKEY_PATH = resolve(
  __dirname,
  "../../../402-everywhere/frontend/public/zk/shielded-payment-redeem/redeem.zkey",
);

function bigIntToBe32(value) {
  const hex = BigInt(value).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function pubkeyToBigInt(bytes) {
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) + BigInt(byte);
  return acc;
}

export async function generateRedeemProof({
  proofInput,
  recipientBytes,
  wasmPath = DEFAULT_WASM_PATH,
  zkeyPath = DEFAULT_ZKEY_PATH,
  wasmBytes,
  zkeyBytes,
}) {
  if (!recipientBytes || recipientBytes.length !== 32) {
    throw new Error("recipientBytes must be a 32-byte buffer");
  }
  const fields = deriveQuoteFieldInputs({
    amount: proofInput.amount,
    sellerSecret: proofInput.sellerSecret,
    nonce: proofInput.nonce,
    quoteId: proofInput.quoteId,
  });
  const recipientBig = pubkeyToBigInt(recipientBytes);
  const input = {
    sellerSecret: fields.sellerSecret.toString(),
    nonceQuote: fields.nonce.toString(),
    quoteIdHash: fields.quoteIdHash.toString(),
    recipient: recipientBig.toString(),
  };

  const wasmArg = wasmBytes ?? wasmPath;
  const zkeyArg = zkeyBytes ?? zkeyPath;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmArg, zkeyArg);
  if (!Array.isArray(publicSignals) || publicSignals.length !== 2) {
    throw new Error(`redeem prover returned ${publicSignals?.length} public signals (expected 2)`);
  }

  const sigArr = publicSignals.map((v) => String(v ?? ""));
  const raw = await snarkjs.groth16.exportSolidityCallData(proof, sigArr);
  const [pA, pB, pC] = JSON.parse(`[${raw}]`);

  const proofBytes = Buffer.concat([
    bigIntToBe32(BigInt(pA[0])), bigIntToBe32(BigInt(pA[1])),
    bigIntToBe32(BigInt(pB[0][0])), bigIntToBe32(BigInt(pB[0][1])),
    bigIntToBe32(BigInt(pB[1][0])), bigIntToBe32(BigInt(pB[1][1])),
    bigIntToBe32(BigInt(pC[0])), bigIntToBe32(BigInt(pC[1])),
  ]);
  if (proofBytes.length !== 256) {
    throw new Error(`encoded proof must be 256 bytes, got ${proofBytes.length}`);
  }

  const quoteNullifierBuf = bigIntToBe32(BigInt(sigArr[0]));
  const recipientBuf = bigIntToBe32(BigInt(sigArr[1]));

  return {
    proof: proofBytes,
    proofBase64: proofBytes.toString("base64"),
    quoteNullifier: quoteNullifierBuf,
    quoteNullifierHex: `0x${quoteNullifierBuf.toString("hex")}`,
    recipient: recipientBuf,
    recipientHex: `0x${recipientBuf.toString("hex")}`,
  };
}
