import type { RelaiPluginConfig } from "./config.js";

// ============================================================================
// Shared HTTP
// ============================================================================

async function fetchJson<T>(
  config: RelaiPluginConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string>) || {}),
      },
      signal: controller.signal,
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
      throw new Error(msg);
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Marketplace (public)
// ============================================================================

export interface MarketplaceApi {
  apiId: string;
  name: string;
  description: string;
  supportedNetworks: string[];
  zAuthEnabled: boolean;
}

export interface ApiEndpoint {
  path: string;
  method: string;
  summary: string;
  usdPrice: number;
  enabled: boolean;
}

export interface ApiDetails {
  apiId: string;
  name: string;
  description: string;
  network: string;
  zAuthEnabled: boolean;
  endpoints: ApiEndpoint[];
}

export async function listApis(config: RelaiPluginConfig): Promise<MarketplaceApi[]> {
  return fetchJson<MarketplaceApi[]>(config, "/marketplace");
}

export async function getApiDetails(
  config: RelaiPluginConfig,
  apiId: string,
): Promise<ApiDetails> {
  return fetchJson<ApiDetails>(config, `/marketplace/${encodeURIComponent(apiId)}`);
}

// ============================================================================
// Consent flow (Agent Keys)
// ============================================================================

export interface ConsentInitiateResponse {
  consentToken: string;
  authorizeUrl: string;
  expiresAt: string;
}

export interface ConsentStatusResponse {
  status: "consent_pending" | "approved" | "rejected" | "expired" | "retrieved";
  retrieveNonce?: string;
}

export interface ConsentRetrieveResponse {
  key: string;
  agentId?: string;
  [extra: string]: unknown;
}

export async function consentInitiate(
  config: RelaiPluginConfig,
  request: {
    agentPubKey: string;
    agentId?: string;
    contractAddress?: string;
    network?: string;
    agentName?: string;
    label?: string;
  },
): Promise<ConsentInitiateResponse> {
  return fetchJson<ConsentInitiateResponse>(
    config,
    "/agent-keys/consent/initiate",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function consentStatus(
  config: RelaiPluginConfig,
  consentToken: string,
): Promise<ConsentStatusResponse> {
  return fetchJson<ConsentStatusResponse>(
    config,
    `/agent-keys/consent/status/${encodeURIComponent(consentToken)}`,
  );
}

export async function consentRetrieve(
  config: RelaiPluginConfig,
  consentToken: string,
  signature: string,
): Promise<ConsentRetrieveResponse> {
  return fetchJson<ConsentRetrieveResponse>(
    config,
    "/agent-keys/consent/retrieve",
    {
      method: "POST",
      body: JSON.stringify({ consentToken, signature }),
    },
  );
}

// ============================================================================
// Metered API calls (authenticated via service key)
// ============================================================================

export async function meteredCall(
  config: RelaiPluginConfig,
  serviceKey: string,
  agentId: string,
  apiId: string,
  endpointPath: string,
  method: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const url = `${config.baseUrl}/relay/${encodeURIComponent(apiId)}${endpointPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Service-Key": serviceKey,
        "X-Agent-ID": agentId,
      },
      signal: controller.signal,
    };
    if (body && method !== "GET" && method !== "HEAD") {
      init.body = body;
    }

    const res = await fetch(url, init);
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timeout);
  }
}
