// Seller-side SPR redeem — service-key-authed for proof-input + relay,
// no on-chain signing on this side.
//
// IMPORTANT: SPR Solana redeem requires a per-quote *stealth* recipient
// pubkey, derived from `sha256(wallet.signMessage("relai-spr-stealth-seller:v1:<quoteId>"))`.
// That derivation needs the seller's wallet keypair, which we
// deliberately keep OUT of plugin tool params (same convention as
// shielded-link buyer-side create). The caller is therefore expected to
// derive the stealth pubkey externally and pass it in here. The
// `examples/spr-demo/lib/redeem-spr.mjs` reference does exactly this.
//
// What this helper covers:
//   1. GET  /v1/shielded-payment-requests/:id/redeem-proof-input  (auth)
//   2. snarkjs.groth16.fullProve(redeem circuit)                  ← local CPU, ~1s
//   3. POST /v1/shielded-payment-requests/:id/solana-redeem-relay (no auth)
//
// What this helper does NOT cover:
//   - stealth keypair derivation (caller does it; pass `recipientStealthPubkey`)
//   - the second-step `solana-stealth-claim-relay` that hops 95% from the
//     stealth ATA to the seller's main wallet ATA. That step requires a
//     partial-signed `transferChecked` tx from the stealth keypair, which
//     also lives outside the plugin.
//
// Public-signal layout (matches the circom `ShieldedPaymentRedeem` source
// at 402-everywhere/contracts/circuits/ShieldedPaymentRedeem.circom):
//   [0] quoteNullifier   (Poseidon3(sellerSecret, nonceQuote, quoteIdHash))
//   [1] recipient        (mod-p reduced 32-byte pubkey)

// snarkjs ships no first-party types
// @ts-expect-error
import * as snarkjs from "snarkjs";
// circomlibjs ships no types
// @ts-expect-error
import { buildPoseidon } from "circomlibjs";
import { keccak256, toUtf8Bytes } from "ethers";
import bs58 from "bs58";
import {
  getSprRedeemProofInput,
  postSprSolanaRedeemRelay,
  type SprNetwork,
} from "../management.js";
import type { RelaiPluginConfig } from "../config.js";

const BN254_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

// Default circuit URLs match the server's static hosting convention
// (`<frontend>/zk/shielded-payment-redeem/redeem.{wasm,zkey}`). Override via
// env if your deployment serves them elsewhere.
const REDEEM_WASM_URL =
  process.env.SPR_REDEEM_WASM_URL ||
  "https://relai.fi/zk/shielded-payment-redeem/redeem.wasm";
const REDEEM_ZKEY_URL =
  process.env.SPR_REDEEM_ZKEY_URL ||
  "https://relai.fi/zk/shielded-payment-redeem/redeem.zkey";

export type SprRedeemInput = {
  config: RelaiPluginConfig;
  serviceKey: string;
  quoteId: string;
  /**
   * Per-quote stealth Solana pubkey (base58). The caller must derive this
   * via `sha256(wallet.signMessage("relai-spr-stealth-seller:v1:<quoteId>"))`
   * → `Keypair.fromSeed`. The on-chain `payout_to_seller` deposits 95% of
   * the quote face value into this pubkey's USDC ATA; a separate claim
   * step (not handled here) hops it to the main wallet.
   */
  recipientStealthPubkey: string;
  /** Override the network the relay broadcasts on. Defaults to proof-input's. */
  targetNetwork?: SprNetwork;
  fetchImpl?: typeof fetch;
};

export type SprRedeemResult = {
  quoteId: string;
  status: string;
  redeemTxSignature: string;
  paidOutMicro: string;
  operatorFeeMicro: string;
  payoutExplorerUrl: string;
  recipientStealthPubkey: string;
  /** Server-supplied pubkey of the operator that signed payout_to_seller. */
  relayer: string | null;
  /**
   * Decimal string of the BN254-reduced stealth pubkey. The caller can
   * pass this to the on-chain `payout_to_seller`'s
   * `pubkey_mod_bn254_p`-derived check if they want to validate locally.
   */
  recipientHex: string;
  quoteNullifierHex: string;
  alreadyRedeemed: boolean;
};

function reduce(v: bigint): bigint {
  const r = v % BN254_FIELD;
  return r >= 0n ? r : r + BN254_FIELD;
}

function stringToField(value: string): bigint {
  const t = String(value ?? "").trim();
  if (!t) return 0n;
  return reduce(BigInt(keccak256(toUtf8Bytes(t))));
}

function pubkeyToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) + BigInt(byte);
  return acc;
}

function bigIntToBe32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = reduce(v);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function explorerUrlForSolana(signature: string, network: string): string {
  const cluster = network === "solana-devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

async function fetchAsBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} → HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

export async function redeemSprQuote(input: SprRedeemInput): Promise<SprRedeemResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No global fetch — pass fetchImpl explicitly");

  const proofInput = await getSprRedeemProofInput(input.config, input.serviceKey, input.quoteId);
  if (!proofInput) {
    throw new Error(`No redeem proof input for quote ${input.quoteId}`);
  }

  const network = (input.targetNetwork ?? proofInput.network) as SprNetwork;
  if (network !== "solana-devnet") {
    throw new Error(
      `redeemSprQuote currently supports solana-devnet only. Got network=${network}`,
    );
  }

  const stealthBytes = bs58.decode(input.recipientStealthPubkey);
  if (stealthBytes.length !== 32) {
    throw new Error(`recipientStealthPubkey must decode to 32 bytes (got ${stealthBytes.length})`);
  }

  // Field-reduce the inputs the same way the circuit does — keccak for
  // string secrets, BigInt mod p for the recipient pubkey bytes.
  const sellerSecretField = stringToField(proofInput.sellerSecret);
  const nonceField = stringToField(proofInput.nonce);
  const quoteIdField = stringToField(proofInput.quoteId);
  const recipientField = reduce(pubkeyToBigInt(stealthBytes));

  // Quote nullifier — server should also return this; recompute locally
  // and assert parity defensively.
  const poseidon = await buildPoseidon();
  const expectedNullifier =
    poseidon.F.toObject(
      poseidon([sellerSecretField, nonceField, quoteIdField]),
    );

  const circuitInputs = {
    sellerSecret: sellerSecretField.toString(),
    nonceQuote: nonceField.toString(),
    quoteIdHash: quoteIdField.toString(),
    recipient: recipientField.toString(),
  };

  const [wasmBytes, zkeyBytes] = await Promise.all([
    fetchAsBytes(fetchImpl, REDEEM_WASM_URL),
    fetchAsBytes(fetchImpl, REDEEM_ZKEY_URL),
  ]);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmBytes,
    zkeyBytes,
  );

  const sigArr = (publicSignals as string[]).map((v) => String(v ?? ""));
  if (sigArr.length !== 2) {
    throw new Error(`SPR redeem prover returned ${sigArr.length} public signals (expected 2)`);
  }
  if (BigInt(sigArr[0]) !== expectedNullifier) {
    throw new Error("SPR redeem proof's quoteNullifier did not match local recomputation");
  }

  // Encode proof for the Solana payout-router: 256-byte big-endian
  // [a(64)][b(128)][c(64)] with snarkjs's `exportSolidityCallData`-derived
  // ordering (which already produces `(real, im)` per G2 limb).
  const raw = await snarkjs.groth16.exportSolidityCallData(proof, sigArr);
  const [pA, pB, pC] = JSON.parse(`[${raw}]`) as [string[], string[][], string[]];
  const proofBytes = Buffer.concat([
    bigIntToBe32(BigInt(pA[0])),
    bigIntToBe32(BigInt(pA[1])),
    bigIntToBe32(BigInt(pB[0][0])),
    bigIntToBe32(BigInt(pB[0][1])),
    bigIntToBe32(BigInt(pB[1][0])),
    bigIntToBe32(BigInt(pB[1][1])),
    bigIntToBe32(BigInt(pC[0])),
    bigIntToBe32(BigInt(pC[1])),
  ]);
  if (proofBytes.length !== 256) {
    throw new Error(`encoded proof must be 256 bytes, got ${proofBytes.length}`);
  }

  const proofBase64 = Buffer.from(proofBytes).toString("base64");
  const quoteNullifierHex = `0x${Buffer.from(bigIntToBe32(BigInt(sigArr[0]))).toString("hex")}`;
  const recipientHex = `0x${Buffer.from(bigIntToBe32(BigInt(sigArr[1]))).toString("hex")}`;

  // claimedAmountAtomic comes verbatim from the redeem proof input — the
  // server compares it to the on-chain match record and rejects mismatches.
  const relay = await postSprSolanaRedeemRelay(input.config, input.quoteId, {
    network,
    seller: input.recipientStealthPubkey,
    sellerProofBase64: proofBase64,
    sellerPublicSignals: [quoteNullifierHex, recipientHex],
    claimedAmountAtomic: String(proofInput.amount),
  });

  if (!relay.ok) {
    throw new Error(
      `Operator relay refused redeem: ${(relay as unknown as { reason?: string }).reason ?? "unknown"}`,
    );
  }

  return {
    quoteId: input.quoteId,
    status: relay.alreadyRedeemed ? "redeemed (idempotent re-relay)" : "redeemed",
    redeemTxSignature: relay.signature ?? "",
    paidOutMicro: relay.paidOut,
    operatorFeeMicro: relay.operatorFee,
    payoutExplorerUrl: relay.signature ? explorerUrlForSolana(relay.signature, network) : "",
    recipientStealthPubkey: input.recipientStealthPubkey,
    relayer: relay.relayer ?? null,
    recipientHex,
    quoteNullifierHex,
    alreadyRedeemed: !!relay.alreadyRedeemed,
  };
}
