---
name: relai-api-publish
description: Use this skill when the user wants to publish, price, update, or monitor their own monetised API on the RelAI marketplace. Covers creating an API record, setting per-endpoint USDC pricing, listing owned APIs, updating metadata or wallets, inspecting stats/payments/logs, and deleting APIs. Triggers on "publish an API on RelAI", "create a monetised endpoint", "set x402 pricing", "check my API revenue".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI — publish and monitor a monetised API

Operates the RelAI Management API through `plugin-openclaw`. Authentication uses the service key provisioned by `relai_setup`.

## Prerequisite

The agent must have a configured service key. If `relai_mgmt_*` tools return `status: not_configured`, run `relai_setup` first and resume.

## Create flow

### 1. Gather the required inputs from the user

Do not guess these — ask explicitly:

- `name` — public display name
- `baseUrl` — upstream URL RelAI will proxy (the API must already be reachable)
- `merchantWallet` — wallet that receives payments
- `network` — one of `base`, `solana`, `skale-base`, etc.

Optional but commonly needed:

- `description`, `websiteUrl`, `logoUrl`
- `solanaWallet` — cross-chain receiver when `network` is an EVM chain
- `evmCrossChainWallet` — cross-chain receiver when `network` is `solana`
- `facilitator` — settlement facilitator (see the matrix below). Defaults to the first supported on `network`.
- `x402Version` — `1` or `2`. Defaults to the newest version the `(facilitator, network)` pair supports.
- `endpoints[]` — initial priced endpoints; each `{ path, method, usdPrice, enabled?, description?, parameters?, requestBody? }`
- `openApi` — full OpenAPI 3.x spec (object or JSON string). When supplied, the marketplace test form renders full schemas. If `endpoints` is omitted, endpoints are derived from its paths with a default price (still overridable later via `relai_mgmt_set_pricing`).

### Facilitator & x402 version

| Facilitator | Networks | Versions |
|---|---|---|
| `payai` | solana, solana-devnet, base, base-sepolia, peaq, polygon, sei | v1 & v2 (peaq/polygon/sei = v1 only) |
| `dexter` | solana, base | v2 |
| `openfacilitator` | solana, base | v2 |
| `relai` | solana, solana-devnet, base, base-sepolia, skale-base, skale-base-sepolia, avalanche, polygon, ethereum, telos | v2 |
| `autoincentive` | base, base-sepolia | v2 |
| `stratum` | solana, base | v2 |
| `thirdweb` | ethereum | v1 |
| `0xgasless` | avalanche | v2 |
| `custom` | most networks | v1 & v2 |

**Defaults**:
- `solana`, `base`, `peaq`, `sei` → `payai`
- `skale-base`, `skale-base-sepolia`, `avalanche`, `ethereum`, `telos`, `polygon` → `relai`

If you pass an unsupported `(facilitator, network, x402Version)` triple the server returns `400` — don't guess, look up the matrix above or omit both fields and let the server pick the default.

### Endpoint schemas (strongly recommended)

Without schema info the marketplace test tab can't render query fields or body inputs — buyers won't be able to try the endpoint. Provide **one** of the following:

- Per-endpoint `parameters` — OpenAPI Parameter Objects. Each `{ name, in: 'query'|'path'|'header', required?, description?, schema? }`.
- Per-endpoint `requestBody` — OpenAPI-style body. Full shape `{ content: { 'application/json': { schema } } }` **or** simplified inner-schema shape `{ required: [...], properties: {...} }` (server normalises to a valid OpenAPI fragment).
- Top-level `openApi` — bypasses the need for per-endpoint schemas.

See [references/endpoint-pricing.md](references/endpoint-pricing.md) for worked examples.

### 2. Call `relai_mgmt_create_api`

Returns the persisted record including the new `apiId`. Save this ID — it is required for every subsequent management call.

### 3. Set pricing (if not inline)

If endpoints were not supplied in step 2, call `relai_mgmt_set_pricing` with the full endpoint list. This **replaces** the existing pricing — always pass the complete list, not a delta.

### 4. Verify

Call `relai_mgmt_get_api` and `relai_mgmt_get_pricing` to confirm the configuration is live.

## Update flow

Use `relai_mgmt_update_api` for metadata and wallet changes. Pass **only the fields being changed** — omitted fields are left untouched. To clear an optional wallet, pass it as `null` explicitly.

For pricing changes, re-send the full endpoint list via `relai_mgmt_set_pricing`.

## Monitoring flow

| Need | Tool |
|---|---|
| Aggregate requests & revenue | `relai_mgmt_stats` |
| Per-payment breakdown | `relai_mgmt_payments` (supports `limit`, `from`, `cursor`) |
| Per-request logs with latency | `relai_mgmt_logs` (same pagination shape) |

For time-bounded queries use `from` (ISO8601). For pagination, pass the `nextCursor` from the previous response as `cursor`.

## Deletion

`relai_mgmt_delete_api` is **irreversible**. Confirm with the user before calling. Active pending payments settle before deletion takes effect server-side.

## Discovery vs. management

`relai_mgmt_list_apis` returns only APIs owned by the current service key. To browse the public marketplace use the `relai-marketplace-buy` skill.

## Guardrails

- **Never change `merchantWallet` without user confirmation** — payments start flowing to the new wallet immediately.
- **Verify `baseUrl` reachability** before creating — a broken upstream produces 502s that still count as failed metered calls.
- **Price sanity**: RelAI prices are USDC. A misplaced decimal (0.5 vs 0.05) is a 10× pricing error. Read the value back to the user before confirming.
- **Network mismatch**: `network` must match where `merchantWallet` lives. Do not set `network: solana` with an EVM `0x…` wallet.
- **Empty schema UX**: if neither `parameters`/`requestBody` per endpoint nor a top-level `openApi` is provided, the marketplace test form will show no inputs — buyers can't test the endpoint and conversions drop. Treat schemas as a ship requirement, not optional.

## References

- [references/endpoint-pricing.md](references/endpoint-pricing.md) — conventions for pricing endpoints, enabling/disabling, and partial updates.
