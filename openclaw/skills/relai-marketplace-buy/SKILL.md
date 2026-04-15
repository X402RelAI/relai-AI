---
name: relai-marketplace-buy
description: Use this skill when the user wants to discover or call a paid API on the RelAI marketplace (x402 micropayments). Covers first-time agent key setup, browsing available APIs, inspecting pricing and required fields, and executing a metered call. Triggers on phrases like "call a RelAI API", "use an x402 paid endpoint", "find an API on RelAI", "pay to call a metered endpoint".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI marketplace — consume paid APIs

RelAI exposes a marketplace of HTTP APIs priced per-call in USDC. The `plugin-openclaw` plugin provides four tools to consume them. This skill encodes the canonical workflow.

## Workflow

Follow this order. Skipping steps causes silent failures (missing key → 401, missing required fields → 400).

### 1. Ensure the agent is configured

Call `relai_setup`. Three outcomes:

- `status: already_configured` → proceed.
- `status: awaiting_consent` → return the `authorizeUrl` to the user, ask them to approve, then call `relai_setup` again.
- `status: configured` → the user just approved; proceed.

Do not attempt any paid call before this tool reports `already_configured` or `configured`.

### 2. Discover the API

If the user named a specific API, skip to step 3. Otherwise call `relai_discover`, optionally filtering by `network` (e.g. `"solana"`, `"base"`). Present a short list with `apiId`, name, and network. Ask the user to pick one.

### 3. Inspect endpoints and pricing

Call `relai_api_info` with the chosen `apiId`. This returns:
- enabled endpoints with method, path, and USDC price
- required/optional request body fields
- allowed values for any enum-constrained field (exposed as `(allowed: ...)` inline and as a `details.enums` map)

Summarise the price and required fields to the user **before** calling — paid calls are non-refundable.

### 4. Call

Call `relai_call` with:

- `apiId` — from step 2.
- `endpointPath` — the target endpoint's path from step 3.
- `method` — the HTTP method listed for that endpoint in step 3 (required, no inference).
- `body` — JSON string built from the request fields surfaced in step 3. Respect any `(allowed: ...)` enum constraints. Omit for methods that take no body (typically `GET`, `HEAD`).

Report the HTTP status and response body verbatim to the user.

**Routing (handled by the plugin)** — when the API record has a `subdomain` property, the plugin routes the call to `https://{subdomain}.{x402Domain}{endpointPath}` and falls back to `{baseUrl}/relay/{apiId}{endpointPath}` on network failure or 5xx. This is transparent to the skill; no action needed.

## Guardrails

- **Always price-check before calling.** Quote the USDC cost from `relai_api_info` and get explicit confirmation for amounts above $1.
- **Never invent field values.** If `relai_api_info` lists a field as required (especially enum-constrained fields) and the user did not specify a value, ask.
- **Do not retry a failed paid call** without diagnosing the error — the payment may have succeeded on a non-2xx response.
- **Respect zAuth filtering.** `relai_discover` already filters zAuth-gated APIs; do not try to work around this.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` | Run `relai_setup` (step 1). |
| `Consent was rejected` | Run `relai_setup` again to start a fresh consent flow. |
| `Consent link expired` | Run `relai_setup` again; a new link will be issued. |
| 402 in `relai_call` response | Payment failed on-chain — check wallet balance with `relai_bridge_balances` if relevant. |
| 400 with missing field | Re-read `relai_api_info` output; the body is incomplete. |

## References

- [references/field-extraction.md](references/field-extraction.md) — how to read the OpenAPI schema returned by `relai_api_info` when the field list is not obvious.
