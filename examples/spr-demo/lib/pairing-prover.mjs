// Vendored from 402-everywhere/examples/spr-agent/src/pairing-prover.mjs
// with two adaptations:
//   1. Accept Uint8Array `wasmBytes` / `zkeyBytes` (snarkjs supports both
//      filesystem paths and in-memory buffers; the demo fetches the
//      circuit artefacts over HTTP so it doesn't need a checked-in copy).
//   2. The default *paths* are kept as a fallback, but the demo flows
//      always pass bytes — see lib/circuit-artifacts.mjs.
//
// Public signal layout (MUST match the circuit declaration order):
//   [0] poolRoot
//   [1] aspRoot
//   [2] quoteRoot
//   [3] paymentNullifier
//   [4] quoteNullifier

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";
import * as snarkjs from "snarkjs";

import { deriveQuoteFieldInputs, toHex32, BN254_FIELD } from "./quote-fields.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WASM_PATH = resolve(
  __dirname,
  "../../../402-everywhere/frontend/public/zk/shielded-payment-pairing/pairing.wasm",
);
const DEFAULT_ZKEY_PATH = resolve(
  __dirname,
  "../../../402-everywhere/frontend/public/zk/shielded-payment-pairing/pairing.zkey",
);

function normalizeField(value) {
  const reduced = value % BN254_FIELD;
  return reduced >= 0n ? reduced : reduced + BN254_FIELD;
}

function stringToField(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return 0n;
  return normalizeField(BigInt(keccak256(toUtf8Bytes(trimmed))));
}

function toDecimalString(value, fallback = "0") {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return fallback;
  try { return BigInt(trimmed).toString(); }
  catch { return fallback; }
}

function toHex32String(value, fallback) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return fallback;
  try { return toHex32(BigInt(trimmed)); }
  catch { return fallback; }
}

export function buildPairingCircuitInputs(witness) {
  const quoteFields = deriveQuoteFieldInputs({
    amount: witness.amount,
    sellerSecret: witness.quote.sellerSecret,
    nonce: witness.quote.nonce,
    quoteId: witness.quote.quoteId,
  });
  const paymentNoteFields = deriveQuoteFieldInputs({
    amount: witness.amount,
    sellerSecret: witness.payment.secret,
    nonce: witness.payment.nonce,
    quoteId: "payment-side",
  });
  return {
    amount: quoteFields.amount.toString(),
    sellerSecret: quoteFields.sellerSecret.toString(),
    nonceQuote: quoteFields.nonce.toString(),
    quoteIdHash: quoteFields.quoteIdHash.toString(),
    quotePathElements: witness.quote.merkle.pathElements.map((v) => toDecimalString(v)),
    quotePathIndices: witness.quote.merkle.pathIndices.map((v) => Number(v)),
    noteVersion: toDecimalString(witness.payment.noteVersion, "1"),
    poolIdHash: stringToField(witness.payment.poolId).toString(),
    assetIdHash: stringToField(witness.payment.assetId).toString(),
    secretPayment: paymentNoteFields.sellerSecret.toString(),
    blindingPayment: stringToField(witness.payment.blinding).toString(),
    noncePayment: paymentNoteFields.nonce.toString(),
    poolPathElements: witness.payment.merkle.pathElements.map((v) => toDecimalString(v)),
    poolPathIndices: witness.payment.merkle.pathIndices.map((v) => Number(v)),
    aspPathElements: witness.payment.asp.pathElements.map((v) => toDecimalString(v)),
    aspPathIndices: witness.payment.asp.pathIndices.map((v) => Number(v)),
  };
}

function normalizePublicSignals(rawPublicSignals) {
  const fallback = `0x${"00".repeat(32)}`;
  const values = (rawPublicSignals ?? []).map((v) => String(v ?? ""));
  return {
    poolRoot: toHex32String(values[0], fallback),
    aspRoot: toHex32String(values[1], fallback),
    quoteRoot: toHex32String(values[2], fallback),
    paymentNullifier: toHex32String(values[3], fallback),
    quoteNullifier: toHex32String(values[4], fallback),
  };
}

export function encodeProofToBytes(proof) {
  const buf = Buffer.alloc(256);
  function writeFieldBE(slice, value) {
    const hex = BigInt(value).toString(16).padStart(64, "0");
    Buffer.from(hex, "hex").copy(slice);
  }
  writeFieldBE(buf.subarray(0, 32), proof.pi_a[0]);
  writeFieldBE(buf.subarray(32, 64), proof.pi_a[1]);
  writeFieldBE(buf.subarray(64, 96), proof.pi_b[0][1]);
  writeFieldBE(buf.subarray(96, 128), proof.pi_b[0][0]);
  writeFieldBE(buf.subarray(128, 160), proof.pi_b[1][1]);
  writeFieldBE(buf.subarray(160, 192), proof.pi_b[1][0]);
  writeFieldBE(buf.subarray(192, 224), proof.pi_c[0]);
  writeFieldBE(buf.subarray(224, 256), proof.pi_c[1]);
  return buf;
}

export async function generatePairingProof({
  witness,
  wasmPath = DEFAULT_WASM_PATH,
  zkeyPath = DEFAULT_ZKEY_PATH,
  wasmBytes,
  zkeyBytes,
}) {
  const circuitInputs = buildPairingCircuitInputs(witness);
  const wasmArg = wasmBytes ?? wasmPath;
  const zkeyArg = zkeyBytes ?? zkeyPath;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmArg,
    zkeyArg,
  );
  const proofBytes = encodeProofToBytes(proof);
  const named = normalizePublicSignals(publicSignals);
  return {
    proofBase64: proofBytes.toString("base64"),
    publicSignals: [
      named.poolRoot,
      named.aspRoot,
      named.quoteRoot,
      named.paymentNullifier,
      named.quoteNullifier,
    ],
    publicSignalsByName: named,
    raw: { proof, publicSignals },
  };
}
