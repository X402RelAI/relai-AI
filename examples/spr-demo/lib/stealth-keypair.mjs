// Faza 6a stealth recipient — Node port of
// `frontend/src/lib/stealth-addresses-solana.ts`. Derivation rule MUST
// stay byte-identical to the frontend so the same wallet derives the
// same stealth keypair regardless of whether the seller redeems via
// browser or agent:
//
//   challenge   = `relai-spr-stealth-seller:v1:<quoteId>`
//   signature   = wallet.signMessage(challenge)             // ed25519 sig
//   stealth_sk  = sha256(signature)                         // 32 bytes
//   stealth_kp  = Keypair.fromSeed(stealth_sk)              // ed25519 kp
//
// Two derivation paths exposed here:
//
//   - `deriveSellerStealthKeypair({ quoteId, signMessage })` —
//     externally-signed flavour. Pass any callable that takes a 32-byte
//     `Uint8Array` challenge and returns a 64-byte ed25519 signature
//     (Phantom/Solflare-shape). Useful when the agent delegates signing
//     to a hardware wallet, an HSM, or a remote signing service.
//
//   - `deriveSellerStealthKeypairFromKeypair({ quoteId, walletKeypair })`
//     — convenience wrapper for the common case where the agent holds
//     its own `@solana/web3.js Keypair` directly. Internally signs the
//     challenge with `nacl.sign.detached(challenge, walletKeypair.secretKey)`.
//
// Properties (carried over from the frontend):
//
//   - Deterministic per (wallet, quoteId): repeat invocations yield the
//     SAME stealth keypair. Backed by deterministic ed25519 (RFC 8032),
//     which Phantom/Solflare/Backpack all use. Anyone deviating from
//     deterministic ed25519 breaks the property — Node's `nacl.sign`
//     stays deterministic.
//   - Per-quote forward secrecy: leaking one stealth_sk doesn't expose
//     stealth_sks for past or future quotes.
//
// No localStorage caching here (Node-side has no localStorage), so
// repeat callers always re-derive. Cheap (~1 ms) — sha256 + Keypair
// construction.

import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

export const STEALTH_SELLER_CHALLENGE_PREFIX = "relai-spr-stealth-seller:v1:";

function challengeFor(quoteId) {
  return new TextEncoder().encode(`${STEALTH_SELLER_CHALLENGE_PREFIX}${quoteId}`);
}

function sha256(input) {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

/**
 * Derive a stealth Keypair from a caller-provided signMessage closure.
 *
 * @param {Object} params
 * @param {string} params.quoteId
 * @param {(message: Uint8Array) => Promise<Uint8Array>} params.signMessage
 *   Returns a 64-byte ed25519 signature over the challenge bytes.
 * @returns {Promise<Keypair>}
 */
export async function deriveSellerStealthKeypair({ quoteId, signMessage }) {
  const challenge = challengeFor(quoteId);
  const signature = await signMessage(challenge);
  if (!signature || signature.length !== 64) {
    throw new Error(
      `signMessage returned ${signature?.length} bytes (expected 64-byte ed25519 sig)`,
    );
  }
  const seed = sha256(signature);
  return Keypair.fromSeed(seed);
}

/**
 * Convenience: derive stealth keypair when the agent already has the
 * wallet's `@solana/web3.js Keypair` in process. Internally signs the
 * challenge with `nacl.sign.detached`.
 *
 * @param {Object} params
 * @param {string} params.quoteId
 * @param {Keypair} params.walletKeypair
 * @returns {Keypair}
 */
export function deriveSellerStealthKeypairFromKeypair({ quoteId, walletKeypair }) {
  const challenge = challengeFor(quoteId);
  const signature = nacl.sign.detached(challenge, walletKeypair.secretKey);
  const seed = sha256(signature);
  return Keypair.fromSeed(seed);
}

export const __testHelpers = { challengeFor, sha256 };
