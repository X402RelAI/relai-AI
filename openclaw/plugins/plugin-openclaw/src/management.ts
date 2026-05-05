import type { RelaiPluginConfig } from "./config.js";

// ============================================================================
// Types (mirrors relai-sdk/src/management.ts)
// ============================================================================

export interface RelaiApi {
  apiId: string;
  name: string;
  description?: string;
  baseUrl: string;
  subdomain?: string | null;
  network: string;
  facilitator: string;
  x402Version: number;
  status: string;
  merchantWallet: string;
  solanaWallet?: string | null;
  evmCrossChainWallet?: string | null;
  websiteUrl?: string;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * OpenAPI-style parameter descriptor (query / path / header).
 * Shown on the marketplace test form so buyers can fill required inputs.
 */
export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

/**
 * OpenAPI-style request body descriptor.
 * Accepts either the full OpenAPI shape
 * ({ required, content: { 'application/json': { schema } } })
 * or a simplified { description?, required?: string[], properties?: {...} } shape.
 */
export type OpenApiRequestBody = Record<string, unknown>;

/**
 * Known facilitator identifiers. `string` is kept in the union so new
 * facilitators can be passed without bumping the plugin — the server validates.
 *
 * Support matrix (server is source of truth):
 * - `payai`           solana, solana-devnet, base, base-sepolia, peaq, polygon, sei (v1/v2; peaq+polygon+sei = v1)
 * - `dexter`          solana, base (v2)
 * - `openfacilitator` solana, base (v2)
 * - `relai`           solana, solana-devnet, base, base-sepolia, skale-base, skale-base-sepolia, avalanche, polygon, ethereum, telos (v2)
 * - `autoincentive`   base, base-sepolia (v2)
 * - `stratum`         solana, base (v2)
 * - `thirdweb`        ethereum (v1)
 * - `0xgasless`       avalanche (v2)
 * - `custom`          most networks (v1/v2)
 */
export type Facilitator =
  | "payai"
  | "dexter"
  | "openfacilitator"
  | "relai"
  | "autoincentive"
  | "stratum"
  | "thirdweb"
  | "0xgasless"
  | "custom"
  | (string & {});

/** x402 protocol version. */
export type X402Version = 1 | 2;

export interface ApiEndpointInput {
  path: string;
  method: string;
  usdPrice: number;
  enabled?: boolean;
  description?: string;
  /** Query / path / header parameter descriptors (OpenAPI shape). */
  parameters?: OpenApiParameter[];
  /** Request body descriptor for POST/PUT/PATCH endpoints (OpenAPI shape). */
  requestBody?: OpenApiRequestBody;
}

export interface ManagementApiEndpoint extends ApiEndpointInput {
  network: string;
  enabled: boolean;
}

export interface CreateApiInput {
  name: string;
  baseUrl: string;
  merchantWallet: string;
  solanaWallet?: string;
  evmCrossChainWallet?: string;
  network: string;
  /**
   * Facilitator to settle payments through. Defaults to `relai` whenever the
   * network supports it (every network except `peaq` and `sei`, which fall back
   * to `payai`). Server rejects unsupported (facilitator, network) combinations
   * with a 400.
   */
  facilitator?: Facilitator;
  /**
   * x402 protocol version. Defaults to `2` whenever the (facilitator, network)
   * pair supports v2; v1-only pairs (e.g. `thirdweb` on ethereum) fall back
   * to v1. Validated server-side.
   */
  x402Version?: X402Version;
  description?: string;
  websiteUrl?: string;
  logoUrl?: string;
  endpoints?: ApiEndpointInput[];
  /**
   * Full OpenAPI 3.x specification (object or JSON string). When provided, the spec
   * is saved and the marketplace UI renders full schemas. If `endpoints` is omitted,
   * endpoints are derived from the spec's paths with a default price.
   */
  openApi?: Record<string, unknown> | string;
}

export interface UpdateApiInput {
  name?: string;
  description?: string;
  baseUrl?: string;
  merchantWallet?: string;
  solanaWallet?: string | null;
  evmCrossChainWallet?: string | null;
  websiteUrl?: string;
  logoUrl?: string;
}

export interface ApiStats {
  apiId: string;
  totalRequests: number;
  totalRevenue: number;
  currency: string;
}

export interface ApiPayment {
  transaction: string;
  path: string;
  method: string;
  amount: number;
  currency: string;
  network: string;
  status: string;
  success: boolean;
  payer: string;
  createdAt: string;
}

export interface ApiPaymentsResult {
  apiId: string;
  payments: ApiPayment[];
  nextCursor: string | null;
}

export interface ApiLogItem {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: string;
  cost: number;
  currency: string;
  duration: number;
  transaction: string;
  network: string;
  success: boolean;
  payer: string;
}

export interface ApiLogsResult {
  items: ApiLogItem[];
  nextCursor: string | null;
}

export interface BridgeQuoteResult {
  inputAmount: number;
  outputAmount: number;
  fee: number;
  feeBps: number;
  inputUsd: number;
  outputUsd: number;
  direction: "solana-to-skale" | "skale-to-solana";
  from: string;
  to: string;
}

export interface BridgeBalances {
  solana: { atomic: number; usd: number };
  skaleBase: { atomic: number; usd: number };
  base: { atomic: number; usd: number };
}

// ============================================================================
// HTTP
// ============================================================================

async function mgmtReq<T>(
  config: RelaiPluginConfig,
  serviceKey: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (serviceKey) headers["X-Service-Key"] = serviceKey;

    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    if (!res.ok) {
      const data = payload as { message?: string; error?: string } | null;
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(`[relai-mgmt] ${method} ${path} → ${res.status}: ${msg}`);
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// APIs
// ============================================================================

export function createApi(config: RelaiPluginConfig, serviceKey: string, input: CreateApiInput) {
  return mgmtReq<RelaiApi>(config, serviceKey, "POST", "/v1/apis", input);
}

export async function listManagedApis(config: RelaiPluginConfig, serviceKey: string): Promise<RelaiApi[]> {
  const data = await mgmtReq<{ apis: RelaiApi[] }>(config, serviceKey, "GET", "/v1/apis");
  return data.apis;
}

export function getManagedApi(config: RelaiPluginConfig, serviceKey: string, apiId: string) {
  return mgmtReq<RelaiApi>(config, serviceKey, "GET", `/v1/apis/${encodeURIComponent(apiId)}`);
}

export function updateApi(
  config: RelaiPluginConfig,
  serviceKey: string,
  apiId: string,
  input: UpdateApiInput,
) {
  return mgmtReq<RelaiApi>(config, serviceKey, "PATCH", `/v1/apis/${encodeURIComponent(apiId)}`, input);
}

export function deleteApi(config: RelaiPluginConfig, serviceKey: string, apiId: string) {
  return mgmtReq<{ success: boolean; apiId: string }>(
    config,
    serviceKey,
    "DELETE",
    `/v1/apis/${encodeURIComponent(apiId)}`,
  );
}

// ============================================================================
// Pricing
// ============================================================================

export function getPricing(config: RelaiPluginConfig, serviceKey: string, apiId: string) {
  return mgmtReq<{ apiId: string; endpoints: ManagementApiEndpoint[] }>(
    config,
    serviceKey,
    "GET",
    `/v1/apis/${encodeURIComponent(apiId)}/pricing`,
  );
}

export function setPricing(
  config: RelaiPluginConfig,
  serviceKey: string,
  apiId: string,
  endpoints: ApiEndpointInput[],
) {
  return mgmtReq<{ success: boolean; apiId: string; updated: number }>(
    config,
    serviceKey,
    "PUT",
    `/v1/apis/${encodeURIComponent(apiId)}/pricing`,
    { endpoints },
  );
}

// ============================================================================
// Analytics
// ============================================================================

export function getStats(config: RelaiPluginConfig, serviceKey: string, apiId: string) {
  return mgmtReq<ApiStats>(config, serviceKey, "GET", `/v1/apis/${encodeURIComponent(apiId)}/stats`);
}

function buildQuery(options: { limit?: number; from?: string; cursor?: string }): string {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.from) params.set("from", options.from);
  if (options.cursor) params.set("cursor", options.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function getPayments(
  config: RelaiPluginConfig,
  serviceKey: string,
  apiId: string,
  options: { limit?: number; from?: string; cursor?: string } = {},
) {
  return mgmtReq<ApiPaymentsResult>(
    config,
    serviceKey,
    "GET",
    `/v1/apis/${encodeURIComponent(apiId)}/payments${buildQuery(options)}`,
  );
}

export function getLogs(
  config: RelaiPluginConfig,
  serviceKey: string,
  apiId: string,
  options: { limit?: number; from?: string; cursor?: string } = {},
) {
  return mgmtReq<ApiLogsResult>(
    config,
    serviceKey,
    "GET",
    `/v1/apis/${encodeURIComponent(apiId)}/logs${buildQuery(options)}`,
  );
}

// ============================================================================
// Bridge (public — no service key required)
// ============================================================================

export function getBridgeQuote(
  config: RelaiPluginConfig,
  amount: number,
  from: "solana" | "skale-base" = "solana",
) {
  const params = new URLSearchParams({ amount: String(amount), from });
  return mgmtReq<BridgeQuoteResult>(config, null, "GET", `/v1/bridge/quote?${params}`);
}

export function getBridgeBalances(config: RelaiPluginConfig) {
  return mgmtReq<BridgeBalances>(config, null, "GET", "/v1/bridge/balances");
}

// ============================================================================
// Shielded private links — read-only (status / config)
//
// The full create + fund + redeem flow involves on-chain wallet ops and
// local zk-proof generation, which don't belong in this thin HTTP plugin.
// The endpoints below cover the read-only surface that any agent can use to
// inspect a shielded link or the pool's state. Service-key-authenticated.
// ============================================================================

export type ShieldedNetwork = "solana-devnet" | "solana" | "base-sepolia" | "skale-base-sepolia";

export interface ShieldedPoolConfigSolana {
  shieldedLink: true;
  nativeSolanaShielded: true;
  settlementNetwork: string;
  programId: string;
  verifierProgramId: string | null;
  usdcMint: string;
  rpcUrl: string;
  issuerFeeBps: number;
}

export interface ShieldedPoolConfigEvm {
  shieldedLink: true;
  settlementNetwork: string;
  poolAddress: string;
  contractVersion: string;
  fundingMode?: string;
  verifierAddress?: string;
  poseidonHasherAddress?: string;
  treeDepth?: number;
  usdcAddress: string;
  denomination?: string | null;
  issuerFeeBps: number;
  feeRecipient?: string;
}

export type ShieldedPoolConfig = ShieldedPoolConfigSolana | ShieldedPoolConfigEvm;

export interface ShieldedLinkStatus {
  shieldedLinkId: string;
  shieldedLink: true;
  status: string; // "draft" | "funded" | "redeemed" | "expired" | "cancelled"
  settlementNetwork: string;
  value?: number;
  feeAmount?: number;
  totalAmount?: number;
  validBefore?: number;
  description?: string | null;
  redeemable?: boolean;
  contractVersion?: string;
  poolAddress?: string;
  // Plus other fields the server returns; kept open so we don't drift.
  [extra: string]: unknown;
}

export interface ShieldedAspStatus {
  enabled: boolean;
  providers?: Array<{ id: string; freshAt?: string }>;
  lastSnapshot?: { rootHex?: string; leafCount?: number; publishedAt?: number };
  // Read-only mirror of `/asp/status`; kept open since the server surface evolves.
  [extra: string]: unknown;
}

export function getShieldedPoolConfig(
  config: RelaiPluginConfig,
  serviceKey: string,
  network: ShieldedNetwork,
) {
  // Bypass the v1 proxy: in prod it routes Solana to a non-existent facilitator
  // path and falls through to requireAuth, returning 401. The EVM-facilitator
  // dispatcher handles both EVM and Solana via the `?network=` query.
  return mgmtReq<ShieldedPoolConfig>(
    config,
    serviceKey,
    "GET",
    `/facilitator/payment-codes/shielded-links/config?network=${encodeURIComponent(network)}`,
  );
}

function shieldedFacilitatorBaseFor(network: ShieldedNetwork): string {
  if (network === "solana" || network === "solana-devnet") {
    return "/facilitator/solana-payment-codes";
  }
  return "/facilitator/payment-codes";
}

export function getShieldedLinkStatus(
  config: RelaiPluginConfig,
  serviceKey: string,
  linkId: string,
  network: ShieldedNetwork,
) {
  // Same v1-proxy bypass as getShieldedPoolConfig — pick the right facilitator
  // based on network so the read hits the route that actually exists in prod.
  const base = shieldedFacilitatorBaseFor(network);
  return mgmtReq<ShieldedLinkStatus>(
    config,
    serviceKey,
    "GET",
    `${base}/shielded-links/${encodeURIComponent(linkId)}?network=${encodeURIComponent(network)}`,
  );
}

export function getShieldedAspStatus(config: RelaiPluginConfig, serviceKey: string) {
  // ASP status lives on the EVM facilitator (it's network-agnostic — one ASP
  // per pool family — and the v1 proxy for `asp/status` falls through to
  // requireAuth in prod).
  return mgmtReq<ShieldedAspStatus>(
    config,
    serviceKey,
    "GET",
    `/facilitator/payment-codes/shielded-links/asp/status`,
  );
}

// ============================================================================
// Shielded Payment Requests (SPR) — reverse-direction shielded payments.
//
// Direction is opposite to shielded links: the SELLER issues an opaque quote,
// the BUYER deposits into Privacy Pool V4.1 with a Groth16 pairing proof, and
// the seller redeems with a separate Groth16 redeem proof. Two ZK proofs total
// instead of one.
//
// Testnet only at this stage: `base-sepolia`, `skale-base-sepolia`,
// `solana-devnet`. Mainnet blocked on a multi-party trusted-setup ceremony +
// amount-binding redeem circuit.
//
// Service-key-authed routes are owner-only (the issuing seller). Public
// witness/relay/match-status routes need no auth — opaque IDs act as bearer.
// ============================================================================

export type SprNetwork = "base-sepolia" | "skale-base-sepolia" | "solana-devnet";

export type SprStatus =
  | "draft"
  | "issued"
  | "matched"
  | "paid"
  | "redeemed"
  | "expired"
  | "cancelled"
  | "refunded";

export interface SprQuote {
  quoteId: string;
  status: SprStatus;
  commitment?: string;
  nullifier?: string;
  amount: string;
  expiry: number;
  network: SprNetwork;
  poolId?: string;
  description?: string | null;
  /** Bearer token returned ONLY by the /issue endpoint (and by /list for the owner). */
  payload?: string;
  sellerReceiptId?: string;
  sellerEncPk?: string;
  solanaRedeemTx?: string;
  [extra: string]: unknown;
}

export interface SprMatch {
  quoteRoot: string;
  poolRoot: string;
  aspRoot: string;
  paymentNullifier: string;
  submitter: string;
  matchedAt: number;
}

export interface SprPairingAttestation {
  proofBase64: string;
  publicSignals: string[];
  recordedAt: string;
}

export interface SprMatchStatus {
  quoteId: string;
  status: SprStatus | "pending" | "unknown";
  network: SprNetwork;
  commitment?: string;
  quoteNullifier?: string;
  expiry?: number;
  match?: SprMatch;
  registryAddress?: string;
  pairingAttestation?: SprPairingAttestation; // Solana only
  sellerEncPk?: string;
  [extra: string]: unknown;
}

export interface SprRedeemProofInput {
  quoteId: string;
  network: SprNetwork;
  amount: string;
  poolId: string;
  /** Hex-encoded note material from the quote payload — feed to circuit, then discard. */
  sellerSecret: string;
  nonce: string;
  commitment: string;
  quoteNullifier: string;
  match: SprMatch;
  registryAddress: string;
  circuitArtifacts?: { wasmUrl?: string; zkeyUrl?: string };
  [extra: string]: unknown;
}

export interface SprQuoteWitness {
  commitment: string;
  quoteRoot: string;
  leafIndex: number;
  leafCount: number;
  depth: number;
  pathElements: string[];
  pathIndices: number[];
  snapshot?: { rootHex?: string; publishedAt?: string; [k: string]: unknown };
}

export interface SprPoolWitness {
  pool: {
    root: string;
    depth: number;
    leafIndex?: number;
    pathElements: string[];
    pathIndices: number[];
  };
  asp: {
    root: string;
    depth: number;
    leafIndex: number;
    leafCount: number;
    pathElements: string[];
    pathIndices: number[];
    publishedAt?: string;
  };
  aspBlockedReason?: string | null;
  aspReady?: boolean;
}

export interface SprSellerReceipt {
  receiptId: string;
  quoteId: string;
  status: SprStatus | string;
  redeemTxHash?: string;
  network: SprNetwork;
  [extra: string]: unknown;
}

export interface SprBuyerReceipt {
  receiptId: string;
  quoteId: string;
  status: SprStatus | string;
  matchTxHash?: string;
  depositTxHash?: string;
  network: SprNetwork;
  [extra: string]: unknown;
}

export interface SprPairingRelayResult {
  ok: boolean;
  signature?: string;
  alreadyRelayed?: boolean;
  matchedAt?: number;
}

export interface SprRedeemRelayResult {
  ok: boolean;
  signature?: string;
  paidOut: string;
  operatorFee: string;
  /** Operator pubkey that signed payout_to_seller. */
  relayer?: string;
  alreadyRedeemed?: boolean;
}

export interface SprStealthClaimResult {
  ok: boolean;
  signature?: string;
}

// ---- Owner-authenticated (service key) -------------------------------------

export function createSprQuote(
  config: RelaiPluginConfig,
  serviceKey: string,
  input: {
    amount: string;
    expiry: number;
    network: SprNetwork;
    description?: string;
    poolId?: string;
    sellerEncPk?: string;
  },
) {
  return mgmtReq<SprQuote>(config, serviceKey, "POST", "/v1/shielded-payment-requests", input);
}

export function issueSprQuote(
  config: RelaiPluginConfig,
  serviceKey: string,
  quoteId: string,
  input: { sellerEncPk?: string } = {},
) {
  return mgmtReq<SprQuote>(
    config,
    serviceKey,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/issue`,
    input,
  );
}

export function cancelSprQuote(config: RelaiPluginConfig, serviceKey: string, quoteId: string) {
  return mgmtReq<{ success: boolean; quoteId: string }>(
    config,
    serviceKey,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/cancel`,
    {},
  );
}

export async function listSprQuotes(
  config: RelaiPluginConfig,
  serviceKey: string,
  options: { status?: SprStatus } = {},
): Promise<SprQuote[]> {
  const qs = options.status ? `?status=${encodeURIComponent(options.status)}` : "";
  const data = await mgmtReq<{ quotes: SprQuote[] }>(
    config,
    serviceKey,
    "GET",
    `/v1/shielded-payment-requests${qs}`,
  );
  return data.quotes;
}

export function getSprQuote(config: RelaiPluginConfig, serviceKey: string, quoteId: string) {
  return mgmtReq<SprQuote>(
    config,
    serviceKey,
    "GET",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}`,
  );
}

export function getSprRedeemProofInput(
  config: RelaiPluginConfig,
  serviceKey: string,
  quoteId: string,
) {
  return mgmtReq<SprRedeemProofInput>(
    config,
    serviceKey,
    "GET",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/redeem-proof-input`,
  );
}

// ---- Public reads (opaque-ID bearer) ---------------------------------------

export function getSprSellerReceipt(config: RelaiPluginConfig, receiptId: string) {
  return mgmtReq<SprSellerReceipt>(
    config,
    null,
    "GET",
    `/v1/shielded-payment-requests/receipt/seller/${encodeURIComponent(receiptId)}`,
  );
}

export function getSprBuyerReceipt(config: RelaiPluginConfig, receiptId: string) {
  return mgmtReq<SprBuyerReceipt>(
    config,
    null,
    "GET",
    `/v1/shielded-payment-requests/receipt/buyer/${encodeURIComponent(receiptId)}`,
  );
}

export function getSprQuoteWitness(config: RelaiPluginConfig, quoteId: string) {
  return mgmtReq<SprQuoteWitness>(
    config,
    null,
    "GET",
    `/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/quote-witness`,
  );
}

export function getSprPoolWitness(
  config: RelaiPluginConfig,
  options: {
    network: SprNetwork;
    commitment: string;
    leafIndex: number;
    depositor: string;
  },
) {
  const params = new URLSearchParams({
    network: options.network,
    commitment: options.commitment,
    leafIndex: String(options.leafIndex),
    depositor: options.depositor,
  });
  return mgmtReq<SprPoolWitness>(
    config,
    null,
    "GET",
    `/facilitator/shielded-payment-requests/pool-witness?${params}`,
  );
}

export function getSprMatchStatus(config: RelaiPluginConfig, quoteId: string) {
  return mgmtReq<SprMatchStatus>(
    config,
    null,
    "GET",
    `/facilitator/shielded-payment-requests/${encodeURIComponent(quoteId)}/match-status`,
  );
}

// ---- Solana-specific (public, operator-relayed) ----------------------------

export function getSprSolanaPoolWitness(
  config: RelaiPluginConfig,
  commitment: string,
  network: SprNetwork = "solana-devnet",
) {
  return mgmtReq<SprPoolWitness["pool"] & { leafIndex?: number }>(
    config,
    null,
    "GET",
    `/v1/shielded-payment-requests/solana-pool-witness/${encodeURIComponent(commitment)}?network=${encodeURIComponent(network)}`,
  );
}

export function getSprSolanaAspWitness(
  config: RelaiPluginConfig,
  commitment: string,
  network: SprNetwork = "solana-devnet",
) {
  return mgmtReq<SprPoolWitness["asp"]>(
    config,
    null,
    "GET",
    `/v1/shielded-payment-requests/solana-asp-witness/${encodeURIComponent(commitment)}?network=${encodeURIComponent(network)}`,
  );
}

export function postSprSolanaDepositConfirmed(
  config: RelaiPluginConfig,
  quoteId: string,
  body: { commitment: string; depositTxHash: string; depositPda: string },
) {
  return mgmtReq<{ success: boolean; quoteId: string }>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-deposit-confirmed`,
    body,
  );
}

export function postSprSolanaPairingRelay(
  config: RelaiPluginConfig,
  quoteId: string,
  body: { network: SprNetwork; proofBase64: string; publicSignals: string[] },
) {
  return mgmtReq<SprPairingRelayResult>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-pairing-relay`,
    body,
  );
}

export function postSprSolanaPairingProof(
  config: RelaiPluginConfig,
  quoteId: string,
  body: { proofBase64: string; publicSignals: string[]; txHash?: string },
) {
  return mgmtReq<{ ok: boolean }>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-pairing-proof`,
    body,
  );
}

export function postSprSolanaRedeemRelay(
  config: RelaiPluginConfig,
  quoteId: string,
  body: {
    network: SprNetwork;
    /** 256-byte Groth16 proof, base64 — serialised by snarkjs.exportSolidityCallData. */
    sellerProofBase64: string;
    /** Two public signals: [quoteNullifier, recipient], 0x-prefixed 32-byte hex each. */
    sellerPublicSignals: string[];
    /**
     * Public Solana pubkey of the per-quote stealth recipient (base58).
     * Server uses this for the on-chain `payout_to_seller` recipient
     * account; the proof's `recipient` public signal must reduce to the
     * same field element via `pubkey_mod_bn254_p`.
     */
    seller: string;
  },
) {
  // Server-side request shape per server/spr-agent reference:
  // `{ network, proofBase64, recipientHex, recipientPubkey, quoteNullifierHex,
  // claimedAmountAtomic }`. We construct it from the caller's
  // (sellerProofBase64, sellerPublicSignals, seller) shape and the proof
  // input the caller already pulled.
  const [quoteNullifierHex, recipientHex] = body.sellerPublicSignals;
  return mgmtReq<SprRedeemRelayResult>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/${encodeURIComponent(quoteId)}/solana-redeem-relay`,
    {
      network: body.network,
      proofBase64: body.sellerProofBase64,
      recipientHex,
      recipientPubkey: body.seller,
      quoteNullifierHex,
      // claimedAmountAtomic must match what the seller pulled from
      // /redeem-proof-input. The plugin caller (relai_spr_redeem) passes
      // it via the `claimedAmountAtomic` field; we trust whatever the
      // proof input returned.
      claimedAmountAtomic: (body as unknown as { claimedAmountAtomic?: string }).claimedAmountAtomic ?? "0",
    },
  );
}

export function postSprSolanaStealthClaimRelay(
  config: RelaiPluginConfig,
  body: { network: SprNetwork; txBase64: string; expectedAuthority: string },
) {
  return mgmtReq<SprStealthClaimResult>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/solana-stealth-claim-relay`,
    body,
  );
}

export function postSprSolanaFaucet(
  config: RelaiPluginConfig,
  body: { network: SprNetwork; recipientAta: string; amount: number },
) {
  return mgmtReq<{ success: boolean; txSignature: string; fundedAmount: string }>(
    config,
    null,
    "POST",
    `/v1/shielded-payment-requests/solana-spr-faucet`,
    body,
  );
}
