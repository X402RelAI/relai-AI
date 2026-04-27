// Seller-side redeem — service-key-authed, no on-chain signing on this side.
//
// Four-call happy path:
//   1. GET  /facilitator/solana-payment-codes/shielded-links/:id/proof-input
//   2. POST /facilitator/solana-payment-codes/shielded-links/:id/redeem-intent
//   3. snarkjs.groth16.fullProve(...)            ← local CPU, ~1.5–3s
//   4. POST /facilitator/solana-payment-codes/shielded-links/:id/execute-withdraw
//
// Notes on prod-validated specifics (do not "simplify" without re-testing):
//   - The /v1/shielded-links proxy is currently broken in prod for Solana
//     (`/facilitator/solana-payment-codes/shielded-links/config` doesn't exist;
//     proxy fall-through hits requireAuth and returns "Missing or invalid
//     Authorization header"). We bypass and call the facilitator directly.
//   - The on-chain verifier expects each F_p^2 G2 component as (im, re).
//     snarkjs returns (re, im); we swap before ABI-encoding the proof bytes.
//     Without the swap → custom program error 3 / "groth16 proof verification
//     failed" on every redeem.
//   - recipient/relayer/relayerFee/denomination must be the EXACT field-decimal
//     values the verifier will compute from the on-chain accounts. The server
//     returns them pre-encoded in the redeem-intent response (via its own
//     `solanaPubkeyToFieldDecimalString`). We pass those VERBATIM to snarkjs
//     instead of recomputing client-side — the only safe way to guarantee
//     match between proof and verifier.
//   - On `aspReady: false` we throw a retryable error — the openclaw tool
//     surfaces a "wait ~12s and retry" hint to the agent.

// snarkjs ships no first-party types
// @ts-expect-error
import * as snarkjs from "snarkjs";
import { AbiCoder } from "ethers";
import bs58 from "bs58";
import { parseShieldedPayload } from "./payload.js";
import {
  computeNullifier,
  deriveFieldInputs,
  toHex32,
  type ShieldedNote,
} from "./note.js";

export type RedeemShieldedLinkInput = {
  baseUrl: string;
  serviceKey: string;
  /** Either pass the encoded payload string, or `linkId` + `note` directly. */
  shieldedLinkPayload?: string;
  linkId?: string;
  note?: ShieldedNote;
  /** Where the relayer should pay out. Solana pubkey (base58) or EVM address. */
  targetAddress: string;
  /** Override settlement network (defaults to the network the buyer deposited on). */
  targetNetwork?: string;
  /** Optional override; usually leave unset and let the server return canonical values. */
  relayer?: string;
  relayerFee?: string;
  fetchImpl?: typeof fetch;
};

export type RedeemShieldedLinkResult = {
  shieldedLinkId: string;
  status: string;
  payoutTxHash?: string;
  payoutExplorerUrl?: string;
  nullifier: `0x${string}`;
  recipient: string;
  raw: unknown;
};

type ProofInput = {
  contractVersion: string;
  settlementNetwork: string;
  denomination: string;
  root: string;
  pathElements: string[];
  pathIndices: number[];
  asp?: { root: string; pathElements: string[]; pathIndices: number[] };
  aspRequired?: boolean;
  aspReady?: boolean;
  aspBlockedReason?: string;
  circuitArtifacts?: { wasmUrl?: string; zkeyUrl?: string };
};

// BN254 scalar field modulus. Public-input values must lie in [0, P). The
// on-chain Solana verifier reduces `BigUint::from_bytes_be(pubkey) % P` for
// recipient/relayer (see solana-shielded-verifier-asp::encode_pubkey_public_input).
const BN254_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

function explorerUrlForSolana(signature: string, network: string): string {
  const cluster = network === "solana-devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

function toDecimal(v: unknown, fallback = "0"): string {
  const t = String(v ?? "").trim();
  if (!t) return fallback;
  try {
    return BigInt(t).toString();
  } catch {
    return fallback;
  }
}

// Sentinel: "no relayer" / "no specific recipient". `relayerFee=0` flows
// historically use the EVM zero address even on Solana — the verifier
// `encode_pubkey_public_input(&Pubkey::default())` is 0 either way.
function isZeroAddressSentinel(t: string): boolean {
  if (!t) return true;
  if (t === "0") return true;
  if (/^0x0+$/.test(t)) return true;
  if (t === "11111111111111111111111111111111") return true; // Solana System Program
  return false;
}

/** Reserved for callers that bypass the redeem-intent response. */
export function toRecipientDecimal(value: string, isSolana: boolean): string {
  const t = String(value ?? "").trim();
  if (isZeroAddressSentinel(t)) return "0";
  if (isSolana) {
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(t);
    } catch (err) {
      throw new Error(`Invalid base58 Solana pubkey "${t}": ${(err as Error).message}`);
    }
    if (bytes.length !== 32) {
      throw new Error(`Solana pubkey must decode to 32 bytes, got ${bytes.length}`);
    }
    const hex = Buffer.from(bytes).toString("hex");
    return (BigInt(`0x${hex}`) % BN254_FIELD).toString();
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return BigInt(t).toString();
  try {
    return (BigInt(t) % BN254_FIELD).toString();
  } catch {
    return "0";
  }
}

function buildCircuitInputs(
  proofInput: ProofInput,
  note: ShieldedNote,
  /**
   * Pre-encoded public inputs as the server returned them in the redeem-intent
   * response. Already field-decimal strings — pass VERBATIM to the circuit so
   * the proof's public signals match what the on-chain verifier computes.
   */
  publicInputs: {
    recipient: string;
    relayer: string;
    relayerFee: string;
    denomination: string;
  },
) {
  if (!proofInput.asp) {
    throw new Error("proofInput is missing the `asp` field — pool is not V4 / witness not ready");
  }

  const f = deriveFieldInputs({
    ...note,
    denomination: note.denomination ?? proofInput.denomination,
  });

  return {
    noteVersion: f.noteVersion.toString(),
    poolIdHash: f.poolIdHash.toString(),
    assetIdHash: f.assetIdHash.toString(),
    denomination: f.denomination.toString(),
    secret: f.secret.toString(),
    blinding: f.blinding.toString(),
    nonce: f.nonce.toString(),
    pathElements: (proofInput.pathElements || []).map((v) => toDecimal(v)),
    pathIndices: (proofInput.pathIndices || []).map((v) => Number(v)),
    aspPathElements: proofInput.asp.pathElements.map((v) => toDecimal(v)),
    aspPathIndices: proofInput.asp.pathIndices.map((v) => Number(v)),
    recipient: publicInputs.recipient,
    relayer: publicInputs.relayer,
    relayerFee: publicInputs.relayerFee,
  };
}

function encodeSolanaCalldata(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): string {
  // The on-chain Solana verifier (Light-Protocol's groth16-solana, ark-bn254
  // backend) expects each F_p^2 component of G2 as (im, re), not (re, im).
  // This is the same swap snarkjs.groth16.exportSolidityCallData applies.
  // Without it the pairing check fails → custom program error 3
  // ("groth16 proof verification failed"). The verifier negates pi_a itself
  // (negate_proof_a), so we leave pi_a as-is.
  const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
  const b = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ];
  const c = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [a, b, c],
  );
}

async function fetchAsBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} → HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

async function getJson<T>(fetchImpl: typeof fetch, url: string, sk: string): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { "X-Service-Key": sk, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error || `HTTP ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  sk: string,
  payload: unknown,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "X-Service-Key": sk, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as Record<string, unknown>;
    const parts = [
      `HTTP ${res.status}`,
      typeof b.error === "string" ? b.error : null,
      typeof b.errorCode === "string" ? `[${b.errorCode}]` : null,
      typeof b.detail === "string" ? `· ${b.detail}` : null,
      typeof b.simulationLogs === "string" ? `· logs: ${b.simulationLogs.slice(0, 400)}` : null,
      Array.isArray(b.logs) ? `· logs: ${(b.logs as string[]).slice(0, 6).join(" | ")}` : null,
    ].filter(Boolean);
    const err = new Error(parts.join(" ")) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export async function redeemShieldedLink(
  input: RedeemShieldedLinkInput,
): Promise<RedeemShieldedLinkResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No global fetch — pass fetchImpl explicitly");
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const sk = input.serviceKey;

  let linkId = input.linkId;
  let note = input.note;
  if (input.shieldedLinkPayload && (!linkId || !note)) {
    const parsed = parseShieldedPayload(input.shieldedLinkPayload);
    if (!parsed) throw new Error("Could not parse shieldedLinkPayload — malformed or unsupported");
    linkId = linkId ?? parsed.linkId;
    note = note ?? parsed.note;
  }
  if (!linkId || !note) {
    throw new Error("redeemShieldedLink needs either shieldedLinkPayload or linkId+note");
  }

  const network = input.targetNetwork ?? note.network ?? "solana-devnet";
  const proofInput = await getJson<ProofInput>(
    fetchImpl,
    `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkId)}/proof-input?network=${encodeURIComponent(network)}`,
    sk,
  );
  if (proofInput.contractVersion !== "v4") {
    throw new Error(
      `This helper only handles V4 pools. Got contractVersion=${proofInput.contractVersion}`,
    );
  }
  if (proofInput.aspRequired && proofInput.aspReady === false) {
    const err = new Error(
      `ASP witness not ready — retry later (${proofInput.aspBlockedReason ?? "unknown"})`,
    ) as Error & { retryable?: boolean; aspBlockedReason?: string };
    err.retryable = true;
    err.aspBlockedReason = proofInput.aspBlockedReason;
    throw err;
  }

  const nullifier = await computeNullifier(note);
  // The redeem-intent response carries the server-canonical public inputs
  // (recipient, relayer, relayerFee, denomination) already encoded as field
  // decimals — exactly what the on-chain verifier will compute from the
  // accounts. Use them verbatim instead of recomputing client-side.
  const redeemIntent = await postJson<{
    recipient: string;
    relayer: string;
    relayerFee: string;
    denomination: string;
  }>(
    fetchImpl,
    `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkId)}/redeem-intent`,
    sk,
    {
      network: proofInput.settlementNetwork,
      nullifier,
      targetAddress: input.targetAddress,
      targetNetwork: input.targetNetwork ?? proofInput.settlementNetwork,
      recipient: input.targetAddress,
    },
  );

  if (!proofInput.circuitArtifacts?.wasmUrl || !proofInput.circuitArtifacts?.zkeyUrl) {
    throw new Error(
      "proofInput.circuitArtifacts.{wasmUrl,zkeyUrl} missing — backend must return V4 circuit URLs",
    );
  }

  const circuitInputs = buildCircuitInputs(proofInput, note, {
    recipient: redeemIntent.recipient,
    relayer: redeemIntent.relayer,
    relayerFee: redeemIntent.relayerFee ?? "0",
    denomination: redeemIntent.denomination,
  });
  // snarkjs in Node treats string args as filesystem paths — it ENOENTs on the
  // HTTPS URLs the backend advertises. Pre-fetch both artifacts as raw bytes;
  // snarkjs accepts Uint8Array buffers regardless of origin. ~5 MB total.
  const [wasmBytes, zkeyBytes] = await Promise.all([
    fetchAsBytes(fetchImpl, proofInput.circuitArtifacts.wasmUrl),
    fetchAsBytes(fetchImpl, proofInput.circuitArtifacts.zkeyUrl),
  ]);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmBytes,
    zkeyBytes,
  );

  const isSolana =
    proofInput.settlementNetwork === "solana" || proofInput.settlementNetwork === "solana-devnet";
  const sigs = (publicSignals as string[]).map((v) => String(v ?? ""));
  const root = toHex32(BigInt(sigs[0]));
  const aspRoot = toHex32(BigInt(sigs[1]));
  const proofNullifier = toHex32(BigInt(sigs[2]));

  if (!isSolana) {
    throw new Error(
      `Solana → Solana redeem only in this plugin. Got settlementNetwork=${proofInput.settlementNetwork}`,
    );
  }
  const encodedProof = encodeSolanaCalldata(proof as {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  });
  const withdrawBody = {
    network: proofInput.settlementNetwork,
    targetAddress: input.targetAddress,
    targetNetwork: input.targetNetwork ?? proofInput.settlementNetwork,
    nullifier: proofNullifier,
    root,
    aspRoot,
    proof: encodedProof,
    recipient: input.targetAddress,
    relayerFee: redeemIntent.relayerFee ?? "0",
  };

  const result = await postJson<{
    success?: boolean;
    status?: string;
    payoutTxHash?: string;
    payoutExplorerUrl?: string;
    explorerUrl?: string;
    state?: { status?: string };
  }>(
    fetchImpl,
    `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkId)}/execute-withdraw`,
    sk,
    withdrawBody,
  );

  // Status field nesting differs between EVM and Solana facilitators:
  //   - EVM payload: `{status: "redeemed", payoutTxHash, ...}`
  //   - Solana:      `{success: true, state: {status: "redeemed"}, payoutTxHash, ...}`
  // Pull from both and fall back to "redeemed" on `success: true` so callers
  // never see `undefined`.
  const statusValue =
    result.status ??
    result.state?.status ??
    (result.success ? "redeemed" : "unknown");

  return {
    shieldedLinkId: linkId,
    status: statusValue,
    payoutTxHash: result.payoutTxHash,
    payoutExplorerUrl:
      result.payoutExplorerUrl ??
      result.explorerUrl ??
      (result.payoutTxHash
        ? explorerUrlForSolana(result.payoutTxHash, proofInput.settlementNetwork)
        : undefined),
    nullifier: proofNullifier,
    recipient: input.targetAddress,
    raw: result,
  };
}
