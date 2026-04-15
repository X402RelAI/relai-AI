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
- `endpoints[]` — initial priced endpoints; each `{path, method, usdPrice, enabled?}`

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

## References

- [references/endpoint-pricing.md](references/endpoint-pricing.md) — conventions for pricing endpoints, enabling/disabling, and partial updates.
