---
name: relai-bridge-usdc
description: Use this skill when the user wants to check RelAI bridge liquidity or get a quote for moving USDC between Solana and SKALE Base. Triggers on "bridge USDC", "what's the bridge fee", "how much liquidity is on RelAI bridge", "solana to skale quote".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI bridge — USDC quotes and liquidity

The RelAI bridge moves USDC between Solana and SKALE Base. Quotes and balances are public (no service key needed). Execution of the actual bridge transaction happens outside this plugin — the tools here answer "can I bridge X, at what cost?"

## Tools

- `relai_bridge_balances` — current USDC liquidity on `solana`, `skaleBase`, `base`.
- `relai_bridge_quote` — fee + net output for a USD amount, given a source network.

## Standard workflow

### 1. Check liquidity first

Before quoting, call `relai_bridge_balances`. If the **destination** side has less USDC than the user wants to bridge, the bridge will reject the operation. Surface this early.

- Bridging `solana → skale-base`: destination is `skaleBase`.
- Bridging `skale-base → solana`: destination is `solana`.

### 2. Get a quote

Call `relai_bridge_quote` with:
- `amount` — USD (decimal, e.g. `10.5`)
- `from` — `"solana"` or `"skale-base"` (default `"solana"`)

The response includes `inputUsd`, `outputUsd`, `fee`, `feeBps`, and the inferred `direction`. Present the fee in both absolute ($) and bps so the user understands the rate.

### 3. Report, do not execute

This skill does not execute transactions. Hand the quote back to the user and, if they want to proceed, direct them to the appropriate wallet/client — bridge execution requires an x402 client that is not part of `plugin-openclaw`.

## Guardrails

- **Liquidity is a snapshot.** A quote is valid instantly, not minutes later. Do not cache.
- **Round-trip cost.** Bridging there-and-back incurs the fee twice — mention this if the user's plan implies a return trip.
- **Decimals.** `amount` is USD, not atomic units. `10` means $10, not 10 µUSDC.

## Relation to other skills

- To **spend** USDC on a paid API after bridging, hand off to `relai-marketplace-buy`.
- To **receive** bridged funds on a published API, configure wallets via `relai-api-publish` (`solanaWallet` / `evmCrossChainWallet` fields).
