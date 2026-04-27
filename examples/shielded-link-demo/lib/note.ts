// Shielded note crypto: secret/blinding/nonce generation, Poseidon commitment
// and nullifier. Mirrors the V4 ShieldedWithdrawWithAsp circuit:
//   commitment = Poseidon(noteVersion, poolIdHash, assetIdHash, denomination,
//                         secret, blinding, nonce)
//   nullifier  = Poseidon(secret, nonce, poolIdHash, noteVersion)
//
// Field reduction: keccak256(utf8) for strings → mod BN254. BigInt for numerics.

import crypto from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
// circomlibjs ships no first-party types
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

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function generateShieldedNote(input: {
  network: string;
  recipientAmountMicro: number | string;
  poolId?: string;
  assetId?: string;
  denomination?: string | number;
  programId?: string;
  version?: number;
}): ShieldedNote & { programId?: string } {
  const version = Number.isFinite(Number(input.version)) ? Number(input.version) : 1;
  const amountMicroStr = String(input.recipientAmountMicro ?? "").trim() || "0";
  const poolId =
    input.poolId?.trim() || `${String(input.network).trim()}:usdc:${amountMicroStr}`;
  const denomination =
    input.denomination != null && String(input.denomination).trim()
      ? String(input.denomination).trim()
      : amountMicroStr;
  return {
    version,
    poolId,
    assetId: input.assetId?.trim() || undefined,
    denomination,
    network: String(input.network).trim(),
    programId: input.programId?.trim() || undefined,
    secret: randomBase64Url(32),
    blinding: randomBase64Url(32),
    nonce: randomBase64Url(16),
  };
}

export async function computeCommitment(note: ShieldedNote): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon();
  const f = deriveFieldInputs(note);
  const c = poseidon([
    f.noteVersion,
    f.poolIdHash,
    f.assetIdHash,
    f.denomination,
    f.secret,
    f.blinding,
    f.nonce,
  ]);
  return toHex32(poseidon.F.toObject(c));
}

export async function computeNullifier(note: ShieldedNote): Promise<`0x${string}`> {
  const poseidon = await loadPoseidon();
  const f = deriveFieldInputs(note);
  const n = poseidon([f.secret, f.nonce, f.poolIdHash, f.noteVersion]);
  return toHex32(poseidon.F.toObject(n));
}
