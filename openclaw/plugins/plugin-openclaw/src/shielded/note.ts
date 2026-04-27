// Minimal note utilities — seller-side only.
//
// The seller never generates note material (the buyer does that off-platform).
// All the seller needs is the Poseidon nullifier derivation, computed from a
// note that was decoded out of the `relai:shielded:…` payload. Field reduction
// matches the V4 ShieldedWithdrawWithAsp circuit:
//   nullifier = Poseidon(secret, nonce, poolIdHash, noteVersion)

import { keccak256, toUtf8Bytes } from "ethers";
// circomlibjs ships no types
// @ts-expect-error
import { buildPoseidon } from "circomlibjs";

export const SHIELDED_BN254_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export type ShieldedNote = {
  version: number;
  poolId: string;
  assetId?: string;
  denomination: string;
  network?: string;
  secret: string;
  blinding: string;
  nonce: string;
};

let poseidonPromise: Promise<unknown> | null = null;
async function loadPoseidon(): Promise<{
  (inputs: Array<bigint | number | string>): unknown;
  F: { toObject(value: unknown): bigint };
}> {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise as Promise<ReturnType<typeof loadPoseidon> extends Promise<infer T> ? T : never>;
}

function reduce(v: bigint): bigint {
  const r = v % SHIELDED_BN254_FIELD;
  return r >= 0n ? r : r + SHIELDED_BN254_FIELD;
}

function stringField(v: string): bigint {
  const t = String(v ?? "").trim();
  if (!t) return 0n;
  return reduce(BigInt(keccak256(toUtf8Bytes(t))));
}

function numericField(v: number | string): bigint {
  const t = String(v ?? "").trim();
  if (!t) return 0n;
  try {
    return reduce(BigInt(t));
  } catch {
    return stringField(t);
  }
}

export function deriveFieldInputs(note: ShieldedNote) {
  return {
    noteVersion: numericField(note.version ?? 1),
    poolIdHash: stringField(note.poolId ?? ""),
    assetIdHash: stringField(note.assetId ?? ""),
    denomination: numericField(note.denomination ?? "0"),
    secret: stringField(note.secret ?? ""),
    blinding: stringField(note.blinding ?? ""),
    nonce: stringField(note.nonce ?? ""),
  };
}

export function toHex32(v: bigint): `0x${string}` {
  return `0x${reduce(v).toString(16).padStart(64, "0")}`;
}

export async function computeNullifier(note: ShieldedNote): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon();
  const f = deriveFieldInputs(note);
  const n = poseidon([f.secret, f.nonce, f.poolIdHash, f.noteVersion]);
  return toHex32(poseidon.F.toObject(n));
}
