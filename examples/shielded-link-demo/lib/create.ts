// Buyer-side end-to-end flow:
//   1. GET pool config (programId, usdcMint, rpcUrl).
//   2. Generate fresh note (server NEVER sees secret/blinding/nonce).
//   3. Compute Poseidon commitment.
//   4. POST /v1/shielded-links with the commitment → receive linkId.
//   5. Build + broadcast on-chain `deposit_note` ix (signed by buyer keypair
//      bound by closure — never as LLM tool param).
//   6. Compute nullifier; POST /v1/shielded-links/{id}/fund.
//   7. Encode `relai:shielded:<base64url>` payload.

import { Keypair } from "@solana/web3.js";
import {
  generateShieldedNote,
  computeCommitment,
  computeNullifier,
  type ShieldedNote,
} from "./note.js";
import { encodeShieldedPayload } from "./payload.js";
import {
  depositToShieldedPool,
  readBuyerBalances,
  airdropSolDevnet,
  type SolanaDepositResult,
} from "./solana-deposit.js";
import { traceMethod } from "../shared/visuals.mjs";

export const SHIELDED_FEE_BPS = 500; // 5% pool fee

export type ShieldedConfig = {
  shieldedLink: true;
  nativeSolanaShielded: boolean;
  settlementNetwork: string;
  programId: string;
  verifierProgramId: string | null;
  usdcMint: string;
  rpcUrl: string;
  issuerFeeBps: number;
};

export type CreateShieldedLinkInput = {
  baseUrl: string;
  serviceKey: string;
  network: "solana-devnet" | "solana";
  recipientAmountMicro: number;
  validForSeconds?: number;
  description?: string;
  /**
   * Buyer's Solana keypair, already loaded from secure storage by the caller.
   * Never accepts a raw secret string — the calling process is responsible for
   * loading the secret outside the LLM context (e.g. process.env at startup)
   * and passing the materialized Keypair object here. This shape makes it
   * impossible for an LLM to pass a private key as a tool parameter.
   */
  buyer: Keypair;
  fetchImpl?: typeof fetch;
  autoAirdrop?: boolean;
};

export type CreateShieldedLinkResult = {
  shieldedLinkId: string;
  shieldedLinkPayload: string;
  commitment: `0x${string}`;
  nullifier: `0x${string}`;
  network: string;
  recipientAmountMicro: number;
  feeAmountMicro: number;
  totalAmountMicro: number;
  validBefore: number;
  buyerPubkey: string;
  buyerAta: string;
  poolPda: string;
  depositTxHash: string;
  depositExplorerUrl: string;
  status: string;
};

function explorerUrlForSolana(signature: string, network: string): string {
  const cluster = network === "solana-devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

function feeAmountFor(value: number): number {
  return Math.ceil((value * SHIELDED_FEE_BPS) / 10_000);
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { "X-Service-Key": serviceKey, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      (body as { error?: string }).error || `HTTP ${res.status} on ${url}`,
    ) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
  payload: unknown,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "X-Service-Key": serviceKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      (body as { error?: string }).error || `HTTP ${res.status} on ${url}`,
    ) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export async function createAndFundShieldedLink(
  input: CreateShieldedLinkInput,
): Promise<CreateShieldedLinkResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No global fetch — pass fetchImpl explicitly");
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const validForSeconds = input.validForSeconds ?? 3600;

  // ── 0. Fetch pool config
  // Note: in prod the `/v1/shielded-links/config` route's internal proxy is
  // broken for Solana networks — it routes to `/facilitator/solana-payment-codes/`
  // where no `/shielded-links/config` exists. The dispatcher on the EVM
  // facilitator file (`/facilitator/payment-codes/shielded-links/config`) works
  // for both EVM and Solana via the `?network=` query param. Bypass the v1
  // proxy and hit the dispatcher directly for the config read only.
  const config = await traceMethod(
    { kind: "http", label: "GET  /facilitator/payment-codes/shielded-links/config" },
    () =>
      getJson<ShieldedConfig>(
        fetchImpl,
        `${baseUrl}/facilitator/payment-codes/shielded-links/config?network=${encodeURIComponent(input.network)}`,
        input.serviceKey,
      ),
  );
  if (!config.programId || !config.usdcMint || !config.rpcUrl) {
    throw new Error(
      `Shielded pool config incomplete for ${input.network}: ${JSON.stringify(config)}`,
    );
  }

  // ── 1. Devnet preflight (auto-airdrop SOL, hard-fail on missing USDC)
  if (input.network === "solana-devnet" && (input.autoAirdrop ?? true)) {
    const bal = await readBuyerBalances({
      rpcUrl: config.rpcUrl,
      usdcMint: config.usdcMint,
      owner: input.buyer.publicKey,
    });
    if (bal.solLamports < 10_000_000) {
      await airdropSolDevnet({ rpcUrl: config.rpcUrl, recipient: input.buyer.publicKey });
    }
    if (bal.usdcMicro < BigInt(input.recipientAmountMicro + feeAmountFor(input.recipientAmountMicro))) {
      throw new Error(
        `Buyer ${input.buyer.publicKey.toBase58()} has ${bal.usdcMicro} micro-USDC on devnet; ` +
          `needs at least ${input.recipientAmountMicro + feeAmountFor(input.recipientAmountMicro)}. ` +
          `Get devnet USDC from https://faucet.circle.com (Solana Devnet).`,
      );
    }
  }

  // ── 2. Build note + commitment
  const note: ShieldedNote & { programId?: string } = generateShieldedNote({
    network: input.network,
    recipientAmountMicro: input.recipientAmountMicro,
    programId: config.programId,
    assetId: "usdc",
  });
  const commitment = await traceMethod(
    { kind: "compute", label: "poseidon(note) → commitment  (off-chain)" },
    () => computeCommitment(note),
  );

  const value = input.recipientAmountMicro;
  const feeAmount = feeAmountFor(value);
  const totalAmount = value + feeAmount;
  const validBefore = Math.floor(Date.now() / 1000) + validForSeconds;

  // ── 3. POST draft (BYO commitment mode)
  const draft = await traceMethod(
    { kind: "http", label: "POST /facilitator/solana-payment-codes/shielded-links" },
    () =>
      postJson<{
        shieldedLinkId: string;
        poolId?: string;
        assetId?: string;
        denomination?: string;
        noteVersion?: number;
        noteMode?: string;
      }>(
        fetchImpl,
        `${baseUrl}/facilitator/solana-payment-codes/shielded-links`,
        input.serviceKey,
        {
          settlementNetwork: input.network,
          from: input.buyer.publicKey.toBase58(),
          value,
          feeAmount,
          totalAmount,
          validBefore,
          description: input.description ?? null,
          commitment,
          noteVersion: note.version,
        },
      ),
  );

  // Server may rewrite poolId/denomination/assetId. Realign before encoding
  // payload — the seller recomputes the commitment from the payload, so the
  // strings must match what the server hashed.
  if (draft.poolId) note.poolId = draft.poolId;
  if (draft.assetId) note.assetId = draft.assetId;
  if (draft.denomination) note.denomination = draft.denomination;

  // ── 4. On-chain deposit
  // The on-chain `deposit_note` ix takes only ONE amount and transfers exactly
  // that many USDC from the depositor ATA to the pool vault. The pool issuer
  // fee on Solana is NOT a separate on-chain transfer — it's server-side
  // accounting only. The server's `verifyShieldedSolanaDepositOnChain` checks
  // the deposit account's `amount` against `entry.value` (recipient amount),
  // not against `totalAmount`. So we deposit `value` micro-USDC, not the
  // value+fee total. Mismatch otherwise → 400 invalid_shielded_deposit_tx.
  let depositResult: SolanaDepositResult;
  try {
    depositResult = await traceMethod(
      { kind: "chain", label: "solana.deposit_note  (on-chain · buyer signs)" },
      () =>
        depositToShieldedPool({
          rpcUrl: config.rpcUrl,
          programId: config.programId,
          usdcMint: config.usdcMint,
          depositor: input.buyer,
          commitment,
          totalAmountMicro: BigInt(value),
        }),
    );
  } catch (err) {
    throw new Error(
      `On-chain deposit failed for shieldedLinkId=${draft.shieldedLinkId}: ${(err as Error).message}`,
    );
  }

  // ── 5. Report fund + register the nullifier
  const nullifier = await traceMethod(
    { kind: "compute", label: "poseidon(note, idx) → nullifier  (off-chain)" },
    () => computeNullifier(note),
  );
  const fundResp = await traceMethod(
    { kind: "http", label: "POST /facilitator/solana-payment-codes/shielded-links/:id/fund" },
    () =>
      postJson<{ status: string }>(
        fetchImpl,
        `${baseUrl}/facilitator/solana-payment-codes/shielded-links/${encodeURIComponent(draft.shieldedLinkId)}/fund`,
        input.serviceKey,
        {
          network: input.network,
          commitment,
          depositTxHash: depositResult.depositTxHash,
          fundedBy: input.buyer.publicKey.toBase58(),
          nullifier,
        },
      ),
  );

  // ── 6. Encode payload
  const shieldedLinkPayload = encodeShieldedPayload({
    ...note,
    linkId: draft.shieldedLinkId,
  });

  return {
    shieldedLinkId: draft.shieldedLinkId,
    shieldedLinkPayload,
    commitment,
    nullifier,
    network: input.network,
    recipientAmountMicro: value,
    feeAmountMicro: feeAmount,
    totalAmountMicro: totalAmount,
    validBefore,
    buyerPubkey: input.buyer.publicKey.toBase58(),
    buyerAta: depositResult.depositorAta,
    poolPda: depositResult.poolPda,
    depositTxHash: depositResult.depositTxHash,
    depositExplorerUrl: explorerUrlForSolana(depositResult.depositTxHash, input.network),
    status: fundResp.status ?? "unknown",
  };
}

export async function inspectBuyer(input: {
  baseUrl: string;
  serviceKey: string;
  network: "solana-devnet" | "solana";
  buyer: Keypair;
  fetchImpl?: typeof fetch;
}): Promise<{
  buyerPubkey: string;
  solLamports: number;
  usdcMicro: string;
  ataExists: boolean;
  rpcUrl: string;
  programId: string;
  usdcMint: string;
}> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No global fetch — pass fetchImpl explicitly");
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  // Same prod workaround as createAndFundShieldedLink — bypass the v1 proxy
  // for /config and hit the EVM-facilitator dispatcher (handles Solana too).
  const config = await getJson<ShieldedConfig>(
    fetchImpl,
    `${baseUrl}/facilitator/payment-codes/shielded-links/config?network=${encodeURIComponent(input.network)}`,
    input.serviceKey,
  );
  const bal = await readBuyerBalances({
    rpcUrl: config.rpcUrl,
    usdcMint: config.usdcMint,
    owner: input.buyer.publicKey,
  });
  return {
    buyerPubkey: input.buyer.publicKey.toBase58(),
    solLamports: bal.solLamports,
    usdcMicro: bal.usdcMicro.toString(),
    ataExists: bal.ataExists,
    rpcUrl: config.rpcUrl,
    programId: config.programId,
    usdcMint: config.usdcMint,
  };
}
