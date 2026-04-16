---
name: relai-api-publish
description: Use this skill when the user wants to publish, price, update, or monitor their own monetised API on the RelAI marketplace over HTTP. Covers creating an API record, setting per-endpoint USDC pricing, listing owned APIs, updating metadata or wallets, and inspecting stats/payments/logs. Triggers on "publish an API on RelAI", "create a monetised endpoint", "set x402 pricing", "check my API revenue".
---

# RelAI — publish and monitor a monetised API (HTTP)

Transport-agnostic: use any HTTP-capable tool available (WebFetch, Bash+curl, fetch MCP, code execution). No shell or OS-specific dependency.

## Prerequisite — service key

Every Management API call requires `X-Service-Key: sk-agent-...` (or `sk_live_...`). Resolve in this order:

1. `RELAI_SERVICE_KEY` env var.
2. `~/.relai/service-key.json` — written by the `relai-setup` skill. Shape: `{ "key": "sk-...", "agentId": "...", "createdAt": "..." }`. Read the `key` field.
3. A file/secret the user references.
4. Ask the user.

If none of the above resolves, hand off to the `relai-setup` skill first to provision one via the browser-consent flow, then resume here.

Treat as secret. Never echo or persist.

Base URL: `https://api.relai.fi` (override with `RELAI_API_URL` if needed).

## Endpoints

All return JSON. All require `X-Service-Key` unless noted.

| Purpose | Method | Path |
|---|---|---|
| Create API | `POST` | `/v1/apis` |
| List owned APIs | `GET` | `/v1/apis` |
| Get one API | `GET` | `/v1/apis/{apiId}` |
| Update API | `PATCH` | `/v1/apis/{apiId}` |
| Delete API | `DELETE` | `/v1/apis/{apiId}` |
| Get pricing | `GET` | `/v1/apis/{apiId}/pricing` |
| Set pricing (full replace) | `PUT` | `/v1/apis/{apiId}/pricing` |
| Stats | `GET` | `/v1/apis/{apiId}/stats` |
| Payments | `GET` | `/v1/apis/{apiId}/payments?limit=&from=&cursor=` |
| Logs | `GET` | `/v1/apis/{apiId}/logs?limit=&from=&cursor=` |

See [references/payloads.md](references/payloads.md) for request/response shapes.

## Create flow

### 1. Gather inputs

Ask explicitly — do not guess:

- `name` — display name
- `baseUrl` — upstream URL RelAI will proxy (must be reachable)
- `merchantWallet` — wallet that receives payments
- `network` — e.g. `base`, `solana`, `skale-base`

Optional:

- `description`, `websiteUrl`, `logoUrl`
- `solanaWallet` — cross-chain receiver when `network` is an EVM chain
- `evmCrossChainWallet` — cross-chain receiver when `network` is `solana`
- `endpoints[]` — initial priced endpoints, each `{ path, method, usdPrice, enabled?, description?, parameters?, requestBody? }`
- `openApi` — full OpenAPI 3.x spec (object or JSON string). When supplied, the marketplace test form renders full schemas. If `endpoints` is omitted, endpoints are derived from the spec's paths with a default price.

### Endpoint schemas (strongly recommended)

Without schema info the marketplace test tab can't render query fields or body inputs — buyers won't be able to try the endpoint. Provide **one** of:

- Per-endpoint `parameters` — OpenAPI Parameter Objects (`{ name, in: 'query'|'path'|'header', required?, description?, schema? }`).
- Per-endpoint `requestBody` — full OpenAPI shape `{ content: { 'application/json': { schema } } }` or simplified inner-schema shape `{ required: [...], properties: {...} }` (server normalises both to a valid OpenAPI fragment).
- Top-level `openApi` — covers both.

See [references/payloads.md](references/payloads.md) for worked payload examples.

### 2. POST `/v1/apis`

Send the JSON body. Response is the persisted record including `apiId`. Save the `apiId` — every subsequent call needs it.

### 3. Set pricing (if not inline)

If you did not include `endpoints[]` in step 2, PUT `/v1/apis/{apiId}/pricing` with `{ "endpoints": [...] }`. This **replaces** the entire list — always send the full set, not a delta.

### 4. Verify

GET `/v1/apis/{apiId}` and `/v1/apis/{apiId}/pricing` to confirm the config is live.

## Update flow

PATCH `/v1/apis/{apiId}` with **only the fields being changed** — omitted fields are left untouched. To clear an optional wallet, send `null` explicitly.

For pricing changes, PUT the full endpoint list via `/v1/apis/{apiId}/pricing`.

## Monitoring

| Need | Endpoint |
|---|---|
| Aggregate requests + revenue | `GET /v1/apis/{apiId}/stats` |
| Per-payment breakdown | `GET /v1/apis/{apiId}/payments?limit=&from=&cursor=` |
| Per-request logs with latency | `GET /v1/apis/{apiId}/logs?limit=&from=&cursor=` |

- `from` — ISO8601 start timestamp.
- `cursor` — opaque pagination token; pass the previous response's `nextCursor`.
- Iterate pagination until `nextCursor == null` for full history.

## Delete

DELETE `/v1/apis/{apiId}` is **irreversible**. Confirm with the user before calling. Pending payments settle before deletion takes effect server-side.

## Guardrails

- **Never change `merchantWallet` without confirmation** — payments redirect immediately.
- **Verify `baseUrl` reachability** before creating — broken upstream produces 5xx metered calls that still count.
- **Price sanity** — USDC decimals. `0.5` vs `0.05` is a 10× error. Read the value back to the user.
- **Network/wallet match** — don't set `network: solana` with an EVM `0x…` wallet or vice versa.
- **Empty schema UX** — if neither `parameters`/`requestBody` per endpoint nor a top-level `openApi` is provided, the marketplace test form will show no inputs and buyers can't try the endpoint. Treat schemas as a ship requirement, not optional.
- **Redact the service key** from everything user-visible.

## References

- [references/payloads.md](references/payloads.md) — request/response schemas for every endpoint.
