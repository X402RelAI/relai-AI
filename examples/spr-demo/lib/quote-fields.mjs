// Quote-side Poseidon commitment + nullifier helpers — Node port of
// `frontend/src/lib/shielded-payment-requests.ts`. The exact layout is
// locked by `server/src/services/shielded/payment-requests/__tests__/commitment-circuit-parity.test.js`,
// so any drift here gets caught at CI time.
//
//   commitment = Poseidon(4)(amount, sellerSecret, nonce, quoteIdHash)
//   nullifier  = Poseidon(3)(sellerSecret, nonce, quoteIdHash)
//
// Where each input is reduced into the BN254 scalar field — quoteId /
// sellerSecret / nonce go through `keccak256(utf8) mod p`, amount goes
// through `BigInt(amount) mod p` (both numeric-string and decimal forms
// are accepted to match the frontend's tolerance).

import { keccak256, toUtf8Bytes } from "ethers";
import { buildPoseidon } from "circomlibjs";

export const BN254_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

let poseidonPromise = null;
async function loadPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

function normalizeField(value) {
  const reduced = value % BN254_FIELD;
  return reduced >= 0n ? reduced : reduced + BN254_FIELD;
}

function stringToField(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return 0n;
  return normalizeField(BigInt(keccak256(toUtf8Bytes(trimmed))));
}

function numericOrStringToField(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return 0n;
  try { return normalizeField(BigInt(trimmed)); }
  catch { return stringToField(trimmed); }
}

export function toHex32(value) {
  return `0x${normalizeField(value).toString(16).padStart(64, "0")}`;
}

export function deriveQuoteFieldInputs(note) {
  if (!note.amount) throw new Error("spr-agent/quote-fields: amount is required");
  if (!note.sellerSecret) throw new Error("spr-agent/quote-fields: sellerSecret is required");
  if (!note.nonce) throw new Error("spr-agent/quote-fields: nonce is required");
  if (!note.quoteId) throw new Error("spr-agent/quote-fields: quoteId is required");
  return {
    amount: numericOrStringToField(note.amount),
    sellerSecret: stringToField(note.sellerSecret),
    nonce: stringToField(note.nonce),
    quoteIdHash: stringToField(note.quoteId),
  };
}

function poseidonResultToBigInt(poseidon, value) {
  const lifted = poseidon.F && typeof poseidon.F.toObject === "function"
    ? poseidon.F.toObject(value)
    : value;
  return normalizeField(BigInt(String(lifted)));
}

export async function computeQuoteCommitment(payload) {
  const fields = deriveQuoteFieldInputs(payload);
  const poseidon = await loadPoseidon();
  return toHex32(
    poseidonResultToBigInt(
      poseidon,
      poseidon([fields.amount, fields.sellerSecret, fields.nonce, fields.quoteIdHash]),
    ),
  );
}

export async function computeQuoteNullifier(payload) {
  // amount is irrelevant — nullifier only binds (sellerSecret, nonce, quoteId)
  const fields = deriveQuoteFieldInputs({ ...payload, amount: "0" });
  const poseidon = await loadPoseidon();
  return toHex32(
    poseidonResultToBigInt(
      poseidon,
      poseidon([fields.sellerSecret, fields.nonce, fields.quoteIdHash]),
    ),
  );
}
