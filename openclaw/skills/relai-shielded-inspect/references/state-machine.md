# Shielded link state machine

A shielded link traverses a small set of states. `relai_shielded_status` reports the current one in the `status` field.

```
                                       ┌────────────────┐
                                       │   redeemed     │  (final, success)
                                       │ (terminal)     │
                                       └────────┬───────┘
                                                │
                                  execute-withdraw OK
                                                │
   POST /v1/shielded-links               POST /:id/execute-withdraw
   ────────────────────►  draft  ──fund──►  funded  ──proof OK──►
                            │                 │
                            │                 │  validBefore reached
                            │                 ▼
                            │              expired (terminal)
                            │
                            │ validBefore reached before fund
                            ▼
                          expired (terminal)

                          (sender) cancel via dashboard ──► cancelled (terminal)
```

## States

| Status | Meaning | Plugin can do? |
|---|---|---|
| `draft` | Server has the commitment but no on-chain deposit yet. Buyer must broadcast the `deposit_note` ix and POST to `/fund`. | Read-only inspection. The fund step lives outside the plugin. |
| `funded` | Deposit confirmed on-chain, link is claimable. ASP must also be ready before the redeem proof verifies. | Read-only. Redeem lives outside the plugin. |
| `redeemed` | Withdraw broadcast and settled. The recipient has the funds. | Read-only. |
| `expired` | `validBefore` passed without a successful redeem. Sender can cancel via the dashboard to recover the deposit. | Read-only. |
| `cancelled` | Sender explicitly cancelled. Funds returned to the depositor. | Read-only. |

## Field reading

| Field from `relai_shielded_status` | Meaning |
|---|---|
| `status` | The state above. |
| `value` | Recipient amount in micro-USDC. Divide by `1_000_000` for human USDC. |
| `feeAmount` | Pool fee in micro-USDC (5%). |
| `totalAmount` | `value + feeAmount` — what the buyer's wallet was actually debited. |
| `validBefore` | Unix seconds when the link expires. Render as ISO8601 + relative ("in 42min"). |
| `redeemable` | `true` only when `status === "funded"` AND ASP witness is ready AND `validBefore` is in the future. |
| `settlementNetwork` | The network the link lives on. |
| `description` | Sender-set tag (≤ 200 chars). Avoid surfacing if it might re-identify either party. |

## ASP gate

Even when `status === "funded"`, the redeem can fail with `aspReady: false` if the commitment is too fresh (the ASP scheduler debounces ~10s after a deposit). Use `relai_shielded_asp_status` to check the snapshot's `publishedAt` — if it's older than the deposit's confirm time, the next snapshot is still pending and the redeem must wait.

## Common questions, mapped to tool calls

| User question | Calls |
|---|---|
| "Has my recipient claimed yet?" | `relai_shielded_status` → `status === "redeemed"`? |
| "Is this link still valid?" | `relai_shielded_status` → `status === "funded"` AND `validBefore > now`? |
| "Why is my redeem failing?" | `relai_shielded_status` (link state) + `relai_shielded_asp_status` (snapshot freshness). |
| "What pool is this on?" | `relai_shielded_config` with the network from the payload. |
| "What's the fee?" | `relai_shielded_config` → `issuerFeeBps` (currently 500 = 5%). |

## What this skill cannot answer

- "Cancel this expired link and return the funds." — Sender-only, done via the dashboard at `relai.fi/codes/manage`. The plugin has no cancel tool.
- "Fund this draft." — On-chain wallet operation, not a plugin tool.
- "Redeem this funded link." — Local zk-proof generation, not a plugin tool.

For any of these, point the user at the appropriate off-plugin path: dashboard, CLI, or the standalone shielded-agent reference clients.
