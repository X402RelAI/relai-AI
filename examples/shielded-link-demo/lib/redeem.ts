// Seller-side redeem flow — service-key-authed, no on-chain signing.
//
// Mirrors the contract of `examples/shielded-agent/src/redeem.mjs` from the
// reference 402-everywhere repo, kept independent of the openclaw plugin so
// this demo stands alone.
//
// Four-call happy path:
//   1. GET  /v1/shielded-links/:id/proof-input
//   2. POST /v1/shielded-links/:id/redeem-intent
//   3. snarkjs.groth16.fullProve(...)            ← local CPU, ~1.5–3s
//   4. POST /v1/shielded-links/:id/execute-withdraw   ← relayer signs + pays gas

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
import { traceMethod } from "../shared/visuals.mjs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type RedeemShieldedLinkInput = {
  baseUrl: string;
  serviceKey: string;
  shieldedLinkPayload?: string;
  linkId?: string;
  note?: ShieldedNote;
  /** Solana pubkey (base58) or EVM address — public information, no key. */
  targetAddress: string;
  targetNetwork?: string;
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

// BN254 scalar field modulus. Public-input values must lie in [0, P). The
// on-chain Solana verifier reduces `BigUint::from_bytes_be(pubkey) % P` for
// recipient/relayer (see solana-shielded-verifier-asp::encode_pubkey_public_input);
// the prover must produce the SAME value or the proof won't verify.
const BN254_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

// Sentinel: "no relayer" / "no specific recipient". The reference
// `examples/shielded-agent` uses the EVM zero address even on Solana flows
// because relayerFee=0 means the relayer pubkey is unused by the on-chain
// verifier — `encode_pubkey_public_input(&Pubkey::default())` is 0 either way.
function isZeroAddressSentinel(t: string): boolean {
  if (!t) return true;
  if (t === "0") return true;
  if (/^0x0+$/.test(t)) return true;
  if (t === "11111111111111111111111111111111") return true; // Solana System Program (all-zero pubkey)
  return false;
}

function toRecipientDecimal(value: string, isSolana: boolean): string {
  const t = String(value ?? "").trim();
  if (isZeroAddressSentinel(t)) return "0";
  if (isSolana) {
    // Solana pubkey is base58 → 32 raw bytes → BigInt big-endian → mod P.
    // Without bs58 decoding, BigInt(t) throws on base58 chars and the
    // fallback would silently return "0" — proof would commit to recipient=0
    // while redeem-intent locked the real pubkey, giving "invalid_proof"
    // / "Simulation failed" on-chain.
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
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
    // EVM address fits in 160 bits, well below the field modulus — no reduction needed.
    return BigInt(t).toString();
  }
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
   * response. They're already field-decimal strings (recipient/relayer encoded
   * via the server's `solanaPubkeyToFieldDecimalString`, denomination as a
   * decimal u64, relayerFee likewise). We pass them VERBATIM into the circuit
   * so the proof's public signals match exactly what the on-chain verifier
   * computes from the actual relayer/payee accounts.
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
  // backend) expects each F_p^2 component of G2 as (im, re), not the (re, im)
  // order snarkjs returns. This is the same swap snarkjs.groth16.exportSolidityCallData
  // applies. Without it the pairing check silently fails → custom program error 3
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
    // Surface as much detail as possible — the demo's renderer truncates the
    // error message, and a bare "Simulation failed" hides the actual reason.
    // Compose a single string with status code + errorCode + details so the
    // operator can debug after the fact.
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
    // Echo the full body to stderr for the operator's eyes — the LLM only
    // sees the truncated message above.
    try {
      process.stderr.write(
        `[redeem] server error on ${url}\n${JSON.stringify(body, null, 2)}\n`,
      );
    } catch {
      // ignore stderr issues
    }
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
  // Bind narrowed values to const so TS keeps the narrowing across the trace
  // closures below (which capture lazily and would otherwise widen back to
  // `string | undefined` / `ShieldedNote | undefined`).
  const linkIdResolved: string = linkId;
  const noteResolved: ShieldedNote = note;

  const network = input.targetNetwork ?? noteResolved.network ?? "solana-devnet";
  const proofInput = await traceMethod(
    { kind: "http", label: "GET  /facilitator/solana-payment-codes/shielded-links/:id/proof-input" },
    () =>
      getJson<ProofInput>(
        fetchImpl,
        `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkIdResolved)}/proof-input?network=${encodeURIComponent(network)}`,
        sk,
      ),
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

  const nullifier = await traceMethod(
    { kind: "compute", label: "poseidon(note, idx) → nullifier  (off-chain)" },
    () => computeNullifier(noteResolved),
  );
  // The redeem-intent response carries the server-canonical public inputs
  // (recipient, relayer, relayerFee, denomination) already encoded as field
  // decimals — exactly what the on-chain verifier will compute from the
  // accounts. Use them verbatim instead of recomputing client-side.
  const redeemIntent = await traceMethod(
    { kind: "http", label: "POST /facilitator/solana-payment-codes/shielded-links/:id/redeem-intent" },
    () =>
      postJson<{
        recipient: string;
        relayer: string;
        relayerFee: string;
        denomination: string;
      }>(
        fetchImpl,
        `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkIdResolved)}/redeem-intent`,
        sk,
        {
          network: proofInput.settlementNetwork,
          nullifier,
          targetAddress: input.targetAddress,
          targetNetwork: input.targetNetwork ?? proofInput.settlementNetwork,
          recipient: input.targetAddress,
        },
      ),
  );

  if (!proofInput.circuitArtifacts?.wasmUrl || !proofInput.circuitArtifacts?.zkeyUrl) {
    throw new Error(
      "proofInput.circuitArtifacts.{wasmUrl,zkeyUrl} missing — backend must return V4 circuit URLs",
    );
  }

  const circuitInputs = buildCircuitInputs(proofInput, noteResolved, {
    recipient: redeemIntent.recipient,
    relayer: redeemIntent.relayer,
    relayerFee: redeemIntent.relayerFee ?? "0",
    denomination: redeemIntent.denomination,
  });
  // snarkjs in Node treats string args as filesystem paths by default — it
  // throws ENOENT on the HTTPS URLs the backend advertises. Pre-fetch both
  // artifacts as raw bytes; snarkjs accepts Uint8Array buffers regardless of
  // origin. ~5 MB total, cached by the OS HTTP layer for repeat redeems.
  const [wasmBytes, zkeyBytes] = await traceMethod(
    { kind: "http", label: "GET  circuit artifacts  (wasm + zkey, ~5 MB)" },
    () =>
      Promise.all([
        fetchAsBytes(fetchImpl, proofInput.circuitArtifacts!.wasmUrl!),
        fetchAsBytes(fetchImpl, proofInput.circuitArtifacts!.zkeyUrl!),
      ]),
  );
  const { proof, publicSignals } = await traceMethod(
    { kind: "compute", label: "snarkjs.groth16.fullProve  (Groth16 · BN254 · local CPU)" },
    () => snarkjs.groth16.fullProve(circuitInputs, wasmBytes, zkeyBytes),
  );

  const isSolana =
    proofInput.settlementNetwork === "solana" || proofInput.settlementNetwork === "solana-devnet";
  const sigs = (publicSignals as string[]).map((v) => String(v ?? ""));
  const root = toHex32(BigInt(sigs[0]));
  const aspRoot = toHex32(BigInt(sigs[1]));
  const proofNullifier = toHex32(BigInt(sigs[2]));

  if (!isSolana) {
    throw new Error(
      `Solana → Solana redeem only in this demo. Got settlementNetwork=${proofInput.settlementNetwork}`,
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

  const result = await traceMethod(
    { kind: "http", label: "POST /facilitator/solana-payment-codes/shielded-links/:id/execute-withdraw" },
    () =>
      postJson<{
        success?: boolean;
        status?: string;
        payoutTxHash?: string;
        payoutExplorerUrl?: string;
        explorerUrl?: string;
        state?: { status?: string };
      }>(
        fetchImpl,
        `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(linkIdResolved)}/execute-withdraw`,
        sk,
        withdrawBody,
      ),
  );

  // Status field nesting differs between EVM and Solana facilitators:
  //   - EVM payload returns `{status: "redeemed", payoutTxHash, ...}`
  //   - Solana payload returns `{success: true, state: {status: "redeemed"}, payoutTxHash, ...}`
  // Reach for both and fall back to "redeemed" when `success: true` so the
  // caller never sees `undefined`.
  const statusValue =
    result.status ??
    result.state?.status ??
    (result.success ? "redeemed" : "unknown");

  return {
    shieldedLinkId: linkIdResolved,
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
