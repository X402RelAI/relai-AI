---
name: relai-marketplace-buy
description: Use this skill when the user wants to discover or call a paid API on the RelAI marketplace (x402 micropayments) over HTTP. Covers browsing available APIs, inspecting pricing and request schema (including enum constraints), and executing a metered call with a pre-provisioned service key. Triggers on "call a RelAI API", "use an x402 paid endpoint", "find an API on RelAI", "pay to call a metered endpoint".
---

# RelAI marketplace — consume paid APIs (HTTP)

This skill describes the REST contract. It is transport-agnostic: use whichever HTTP-capable tool is available (WebFetch, `curl` via Bash, a fetch MCP server, code execution, etc.). Do not assume any particular shell, OS, or utility is installed.

## Prerequisite — service key

Paid calls require a service key (`sk-agent-...` or `sk_live_...`) sent in the `X-Service-Key` header. Resolve it in this order:

1. `RELAI_SERVICE_KEY` environment variable.
2. `~/.relai/service-key.json` — written by the `relai-setup` skill. Shape: `{ "key": "sk-...", "agentId": "...", "createdAt": "..." }`. Read the `key` field.
3. A file or secret the user explicitly references.
4. Ask the user.

If none of the above resolves, hand off to the `relai-setup` skill to run the browser-consent flow and obtain one, then resume here.

Treat the key as a secret: never echo it, never save it to memory, redact it in any output shown to the user.

## Endpoints

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL` if the user has a custom instance).
x402 domain: `x402.fi` (override via `RELAI_X402_DOMAIN` if needed).

| Purpose | Method | Path | Auth |
|---|---|---|---|
| List marketplace | `GET` | `/marketplace` | none |
| API details | `GET` | `/marketplace/{apiId}` | none |
| Metered call (primary, when `subdomain` is set) | `{method}` | `https://{subdomain}.{x402Domain}{endpointPath}` | `X-Service-Key` |
| Metered call (fallback / no subdomain) | `{method}` | `{baseUrl}/relay/{apiId}{endpointPath}` | `X-Service-Key` |

All request/response bodies are JSON unless the target endpoint says otherwise.

## Workflow

### 1. Discover

GET `/marketplace`. Filter out APIs where `zAuthEnabled == true` (they require a separate auth flow not covered here). If the user specified a network, keep only APIs whose `supportedNetworks` (case-insensitive) contains it.

Present a short list — `apiId`, `name`, `supportedNetworks` — and ask the user to pick one.

### 2. Inspect

GET `/marketplace/{apiId}`. From the response:

- `subdomain` — string or null. Drives routing in step 3.
- `endpoints[]` where `enabled == true`: each has `path`, `method`, `usdPrice`, `summary`, `description`.
- `openApiJson.paths[<path>][<method>].requestBody.content[<mediaType>].schema`: the request body schema. Prefer `application/json`; otherwise fall back to the first declared media type.

For each schema property, surface:
- `(required)` vs `(optional)` based on `schema.required`
- the `description`
- if `enum` is present: `allowed: v1, v2, ...`

Apply this uniformly across all fields — no special casing by field name.

Summarise price + required fields to the user **before** moving on.

### 3. Call

**Pick the URL** based on the `subdomain` from step 2:

- If `subdomain` is a non-empty string → primary URL = `https://{subdomain}.{x402Domain}{endpointPath}`, fallback URL = `{RELAI_API_URL}/relay/{apiId}{endpointPath}`.
- If `subdomain` is null/missing → only the fallback URL applies.

Send the request with:

- Method: exactly the `method` listed in step 2 (never inferred from the path).
- Headers: `X-Service-Key: <key>`, `Content-Type: application/json`, `Accept: application/json`.
- Body: JSON built from the schema in step 2. Respect enum constraints. Omit entirely for methods that take no body (typically `GET`, `HEAD`) or endpoints with no `requestBody` in the schema.

**Fallback logic**: if the primary URL returns a 5xx or fails at the transport level (DNS, timeout, connection reset), retry once on the fallback URL. **Do not fall back on 4xx** — client errors are authoritative.

Capture both the HTTP status and the response body from whichever URL succeeded. Report both verbatim to the user.

## Guardrails

- **Price-check before calling.** Quote the USDC cost; confirm explicitly for amounts above $1.
- **Never invent field values.** If a required field has an enum and the user hasn't chosen a value, ask.
- **Do not blindly retry a failed paid call.** A non-2xx response does not guarantee the payment did not settle. Diagnose first.
- **Redact the service key** from every user-visible output, log, and memory entry.

## Error recovery

| Symptom | Action |
|---|---|
| 401 on `/relay/...` | Service key missing or invalid — re-resolve from the sources above. |
| 402 | Payment failed on-chain — check wallet balance; do not retry until investigated. |
| 400 with missing-field error | Body incomplete — re-derive required fields from step 2 and reconstruct. |
| 404 on `/marketplace/{apiId}` | `apiId` wrong or the API was delisted — re-run discover. |

## References

- [references/endpoints.md](references/endpoints.md) — full endpoint shapes with example request/response payloads.
