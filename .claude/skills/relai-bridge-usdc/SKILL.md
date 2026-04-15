---
name: relai-bridge-usdc
description: Use this skill when the user wants to check RelAI bridge liquidity or get a quote for moving USDC between Solana and SKALE Base over HTTP. Triggers on "bridge USDC", "what's the bridge fee", "how much liquidity is on RelAI bridge", "solana to skale quote".
---

# RelAI bridge — USDC quotes and liquidity (HTTP)

Transport-agnostic: use any HTTP-capable tool (WebFetch, Bash+curl, fetch MCP, code execution). No shell or OS-specific dependency.

Quotes and balances are **public** — no service key needed. Execution of the actual bridge transaction happens outside this skill (requires an x402 client signing with a wallet keypair).

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## Endpoints

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Quote | `GET` | `/v1/bridge/quote?amount={usd}&from={solana\|skale-base}` | none |
| Balances | `GET` | `/v1/bridge/balances` | none |

## Workflow

### 1. Check liquidity first

GET `/v1/bridge/balances`:

```json
{
  "solana":    { "atomic": 1000000, "usd": 1.0 },
  "skaleBase": { "atomic": 5000000, "usd": 5.0 },
  "base":      { "atomic": 2000000, "usd": 2.0 }
}
```

If the **destination** side has less USDC than the user wants to bridge, the bridge will reject. Surface this before quoting.

- `solana → skale-base` → destination is `skaleBase`.
- `skale-base → solana` → destination is `solana`.

### 2. Get a quote

GET `/v1/bridge/quote?amount=10.5&from=solana`.

**Response**:

```json
{
  "inputAmount": 10.5,
  "outputAmount": 10.45,
  "fee": 0.05,
  "feeBps": 50,
  "inputUsd": 10.5,
  "outputUsd": 10.45,
  "direction": "solana-to-skale",
  "from": "solana",
  "to": "skale-base"
}
```

Query params:
- `amount` — USD decimal (not atomic units). `10` means $10.
- `from` — `solana` or `skale-base`. Defaults to `solana`.

Present the fee in both absolute (`$`) and `bps` to the user.

### 3. Report, do not execute

This skill does not execute bridge transactions. Hand the quote to the user; if they want to proceed, direct them to an x402-capable wallet/client — execution is not part of this skill.

## Guardrails

- **Liquidity is a snapshot.** A quote is valid instantly, not minutes later. Do not cache.
- **Round-trip cost.** Bridging there-and-back incurs the fee twice — mention this if the user's plan implies a return.
- **Decimals.** `amount` is USD, not µUSDC.

## Relation to other skills

- To **spend** USDC on a paid API after bridging → `relai-marketplace-buy`.
- To **receive** bridged funds on a published API → configure `solanaWallet` / `evmCrossChainWallet` via `relai-api-publish`.
