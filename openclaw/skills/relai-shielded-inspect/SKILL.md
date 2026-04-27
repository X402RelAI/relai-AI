---
name: relai-shielded-inspect
description: Use this skill when the user wants to inspect the state of a RelAI shielded private payment link, the pool configuration, or the Association Set Provider (ASP) snapshot. Read-only — does not create, fund, or redeem links. Triggers on "check shielded link status", "is this shielded link funded", "shielded pool config", "ASP status", "did the recipient claim my shielded payment", "verify shielded link before redeem".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI shielded private links — inspection

The RelAI shielded link is a privacy-pool payment instrument: the sender deposits USDC into the pool under a Poseidon commitment they alone know, hands an opaque `relai:shielded:<base64url>` payload to the recipient, and the recipient redeems by generating a Groth16 proof. The on-chain deposit and withdraw events are not linkable on-chain.

This skill does **not** create, fund, or redeem shielded links. The full flow needs an on-chain wallet (for the buyer's deposit) and local zk-proof generation (for the seller's redeem) — neither belongs in a thin HTTP plugin. This skill answers "what's the state of this link / pool / ASP?", which is the slice the plugin can serve.

## Tools

- `relai_shielded_config` — pool program / contract address, USDC mint, fee bps, for a network.
- `relai_shielded_status` — current state of one shielded link (draft / funded / redeemed / expired / cancelled), denomination, expiry.
- `relai_shielded_asp_status` — ASP system state: providers, last snapshot timestamp, leaf count.

All three require the agent's service key (resolve via `relai_setup` if not yet configured).

## Workflow

### 1. Ensure the agent is configured

Call `relai_setup`. Three outcomes:

- `status: already_configured` → proceed.
- `status: awaiting_consent` → return the `authorizeUrl` to the user, ask them to approve, then call `relai_setup` again.
- `status: configured` → proceed.

### 2. Pick the right tool for the user's question

| User intent | Tool | Inputs |
|---|---|---|
| "What's the pool address / mint / fee on `<network>`?" | `relai_shielded_config` | `network` |
| "Is link `aH9…` still claimable / funded / expired?" | `relai_shielded_status` | `linkId`, `network` |
| "Why is my redeem failing with `aspReady: false`?" | `relai_shielded_asp_status` | (none) |

Multiple tools may be needed for one question — for example, "should I redeem now?" combines `relai_shielded_status` (is it funded and not expired?) with `relai_shielded_asp_status` (is the ASP snapshot fresh enough?).

### 3. Extract `linkId` from a payload string when needed

If the user pasted a `relai:shielded:<base64url>` (or `s:…`, `shielded:…`, or a redeem URL with the payload in the hash), the `linkId` is the `l` field inside the base64url-decoded JSON. Decode locally — no network call. Then pass it to `relai_shielded_status`.

A minimal decoder fragment:

```js
const token = input.replace(/^.*?(?:relai:shielded:|shielded:|s:)/i, '');
const json  = Buffer.from(token, 'base64url').toString('utf8');
const linkId = JSON.parse(json).l;
```

Decoding is a local operation. **Do not** echo the rest of the payload (`s`, `b`, `n`) back to the user — those are the secret material. See [references/payload-decode.md](references/payload-decode.md) for the full schema and safety rules.

### 4. Report the state, do not act

Surface the fields plainly. For a status lookup:

- `status` — the headline.
- `value` (in micro-USDC) — divide by 1_000_000 for human USDC.
- `validBefore` — render as a human timestamp, mention how long until expiry.
- `redeemable` — true means the seller can withdraw right now.

For an ASP status: report whether the snapshot is recent (last published within the debounce window) and how many leaves it covers.

## Guardrails

- **Read-only.** This skill never creates, funds, or redeems a link. If the user asks to do so, point them at the off-plugin tooling and stop.
- **Do not echo secret material from a pasted payload.** When the user pastes `relai:shielded:…`, decode locally to extract `linkId` (`l`), then **discard** the rest. Echoing `s` (secret), `b` (blinding), or `n` (nonce) leaks the spending capability.
- **Stale-by-design results.** ASP and link status are snapshots — a `funded` link can become `redeemed` between two calls. Re-poll if a downstream action hinges on it.
- **404 / not_found is meaningful.** If `relai_shielded_status` 404s, the `linkId` is wrong (bad copy-paste) or the network is wrong (link lives on a different pool than queried). Don't paper over with a guess.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` | Run `relai_setup`. |
| `404 shielded_link_not_found` | Re-confirm the `linkId` and `network`. The link may live on a different pool. |
| `unsupported_shielded_network` | The network argument is not supported by this RelAI instance. Ask the user to confirm. |
| `aspReady: false` reported by an external redeem | Call `relai_shielded_asp_status`. If `lastSnapshot.publishedAt` is older than the debounce (~10s), the next snapshot is imminent — wait and retry the redeem. If the snapshot is fresh but the commitment is missing, the funder address may be on the ASP defer list. |
| `503 shielded_pool_unavailable` from `relai_shielded_config` | Pool not configured for that network on this RelAI instance. |

## References

- [references/payload-decode.md](references/payload-decode.md) — local decoding of `relai:shielded:<base64url>`, schema field map, what's safe to surface vs. what to discard.
- [references/state-machine.md](references/state-machine.md) — status transitions (draft → funded → redeemed / expired / cancelled) and what each means operationally.

## Relation to other skills

- The full **buyer-side** flow (note generation, on-chain `deposit_note`, fund report, payload emission) is described in the transport-agnostic `relai-shielded-send` skill in `.claude/skills/`. This plugin skill complements it by providing the post-fund status check.
- The full **seller-side** flow (parse payload, Groth16 proof, execute-withdraw) is in `.claude/skills/relai-shielded-receive`. This plugin skill complements it by providing pre-redeem status verification and ASP freshness checks.
- For non-private agent-to-agent payments, `relai-marketplace-buy` is the standard x402 path.
