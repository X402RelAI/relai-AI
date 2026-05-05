// V4 shielded-pool note field helpers — copy of
// `examples/shielded-agent/src/note-fields.mjs` (so spr-agent stays
// self-contained) plus the Poseidon-7 `computeShieldedCommitment`
// that's used by both shielded-link and SPR for the buyer's pool
// commitment.
//
// Why duplicate? Each example agent is a standalone npm project so it
// can be vendored / lifted into a different repo without dragging in
// the sibling. The drift risk is bounded by the
// `commitment-circuit-parity.test.js` suite on the server side, which
// pins the field reduction rules — whichever agent diverges first
// gets caught at CI time.

import { keccak256, toUtf8Bytes } from "ethers";
import { buildPoseidon } from "circomlibjs";

import { BN254_FIELD, toHex32 } from "./quote-fields.mjs";

let poseidonPromise = null;
async function loadPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

function normalizeField(value) {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const reduced = v % BN254_FIELD;
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

/**
 * Derive the 7 BN254 field elements that make up the V4 pool
 * commitment / nullifier preimage. Mirror of the frontend's
 * `deriveShieldedNoteFieldInputs`.
 */
export function deriveShieldedNoteFieldInputs(note) {
  return {
    noteVersion: numericOrStringToField(
      Number.isFinite(Number(note.version ?? note.noteVersion ?? 1))
        ? Number(note.version ?? note.noteVersion ?? 1)
        : 1,
    ),
    poolIdHash: stringToField(note.poolId ?? ""),
    assetIdHash: stringToField(note.assetId ?? ""),
    denomination: numericOrStringToField(note.denomination ?? note.amount ?? "0"),
    secret: stringToField(note.secret ?? ""),
    blinding: stringToField(note.blinding ?? ""),
    nonce: stringToField(note.nonce ?? ""),
  };
}

/**
 * Compute the V4 pool commitment:
 *
 *   Poseidon(7)(noteVersion, poolIdHash, assetIdHash, denomination,
 *               secret, blinding, nonce)
 *
 * Same scheme used by shielded-private-links and SPR Solana — buyer
 * deposits this commitment into the pool, the on-chain Merkle tree
 * tracks its leaf index, and the pairing prover later proves
 * inclusion + preimage knowledge to the matching circuit.
 */
export async function computeShieldedCommitment(note) {
  const f = deriveShieldedNoteFieldInputs(note);
  const poseidon = await loadPoseidon();
  const result = poseidon([
    f.noteVersion,
    f.poolIdHash,
    f.assetIdHash,
    f.denomination,
    f.secret,
    f.blinding,
    f.nonce,
  ]);
  const lifted = poseidon.F && typeof poseidon.F.toObject === "function"
    ? poseidon.F.toObject(result)
    : result;
  return toHex32(BigInt(String(lifted)));
}

export { stringToField, numericOrStringToField, normalizeField };
