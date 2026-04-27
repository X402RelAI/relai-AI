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
