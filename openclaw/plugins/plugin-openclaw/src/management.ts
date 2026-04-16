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
   * Facilitator to settle payments through. Defaults to the first supported
   * facilitator on `network` (e.g. `payai` on solana/base, `relai` on skale-base,
   * avalanche, telos, ...). Server rejects unsupported (facilitator, network)
   * combinations with a 400.
   */
  facilitator?: Facilitator;
  /**
   * x402 protocol version. Defaults to the newest version the (facilitator, network)
   * pair supports. Validated server-side.
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
