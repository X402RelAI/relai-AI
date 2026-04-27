---
name: relai-shielded-send
description: Use this skill when an agent wants to pay another agent privately via a RelAI shielded link — the recipient learns the amount through the link but the sender's wallet stays hidden, and the on-chain deposit and withdraw are not linkable. Documents the protocol (HTTP + on-chain deposit + payload emission) and routes the on-chain step to an external client. Triggers on "send a shielded link", "pay this agent privately", "create a private USDC payment", "anonymous payment to another agent", "shielded send".
---

# RelAI shielded link — buyer-side flow

The buyer half of the [anonymous-agent-payments](https://relai.fi/blog/anonymous-agent-payments) pattern: deposit USDC into the privacy pool under a Poseidon commitment only the buyer knows, then hand the resulting `relai:shielded:…` payload to the recipient over any channel. The seller redeems without ever learning the buyer's wallet.

**This skill is a protocol guide, not a self-contained executor.** Two of the steps (Poseidon commitment generation and the on-chain Solana `deposit_note` instruction) require local cryptography and a wallet keypair. They cannot be done with HTTP alone, and a SKILL.md is not the right place to ship the wallet keypair. The skill describes the full sequence and tells you which steps are HTTP (Claude can fire them directly) versus which steps must be delegated to an external client.

Solana → Solana only here. Cross-network is supported by the API but adds steps the skill doesn't yet cover.

## Prerequisite — service key

Service-key resolution (same as every RelAI skill):

1. `RELAI_SERVICE_KEY` environment variable.
2. `~/.relai/service-key.json` — written by `relai-setup`. Read the `key` field.
3. A file the user explicitly references.
4. Ask the user.

If none resolves, hand off to `relai-setup` to provision one.

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## HTTP endpoints (all `X-Service-Key`-authed)

> **Prod gotcha:** the `/v1/shielded-links/...` proxy is currently broken for Solana — it routes to a non-existent facilitator path and falls through to `requireAuth`, returning "Missing or invalid Authorization header" 401. Hit the facilitator paths directly until that's fixed upstream.

| Step | Method | Path | Skill can fire? |
|---|---|---|---|
| Read pool config | `GET` | `/facilitator/payment-codes/shielded-links/config?network=<id>` | yes (EVM-dispatcher handles Solana too) |
| Create draft | `POST` | `/facilitator/solana-payment-codes/shielded-links` | yes (with off-platform-computed commitment) |
| Report on-chain fund | `POST` | `/facilitator/solana-payment-codes/shielded-links/{linkId}/fund` | yes (after off-platform deposit) |
| Read status | `GET` | `/facilitator/solana-payment-codes/shielded-links/{linkId}?network=<id>` | yes |

## Sequence

| # | Step | Where it runs |
|---|---|---|
| 1 | Resolve pool config (program ID, USDC mint, fee bps) | **HTTP** |
| 2 | Generate note (`secret`, `blinding`, `nonce`) and Poseidon commitment | **off-platform** |
| 3 | Confirm price with the user (recipient amount, 5% fee, total debit, expiry) | **conversation** |
| 4 | POST draft with the commitment, get `shieldedLinkId` | **HTTP** |
| 5 | Build, sign, broadcast Anchor `deposit_note` instruction with the buyer's Solana keypair | **off-platform** |
| 6 | POST `/fund` with `commitment`, `depositTxHash`, `fundedBy`, `nullifier` | **HTTP** |
| 7 | Encode the `relai:shielded:<base64url>` payload | **off-platform** |
| 8 | Deliver the payload string to the recipient over any channel | **conversation** |

Steps 2, 5, 7 cannot be done with HTTP alone — see "Delegation" below.

## Delegation — running the off-platform steps

For steps 2, 5, 7, choose one of:

- **openclaw plugin** — install `@relai-fi/plugin-openclaw` and use a downstream agent. The plugin currently exposes only the **seller-side redeem** (`relai_shielded_redeem`), not the buyer flow, so this option does not help here unless the plugin gains a buyer-side tool.
- **Reference Node client** — the [`examples/shielded-agent`](https://github.com/relai-fi/402-everywhere/tree/main/examples/shielded-agent) repo ships the redeem helper. There is no equivalent buyer-side reference yet — direct the user to the [Management API HTTP spec](https://relai.fi/documentation/management-api#shielded-links) and the [private-shielded-links blog post](https://relai.fi/blog/private-shielded-links) for guidance, or to the dashboard at `relai.fi/codes/create` for a UI-driven create flow.
- **Dashboard UI** — `relai.fi/codes/create` runs the entire buyer flow in the browser. Recommend this for one-off sends or when no agent-side wallet is available.

If the user has a Node sandbox with `circomlibjs`, `snarkjs`, `@solana/web3.js`, and `@solana/spl-token` installed AND has explicitly authorised passing a Solana keypair to the agent for this run, the technical details for steps 2, 5, 7 are in [references/buyer-protocol.md](references/buyer-protocol.md). **Do not** load a wallet keypair from env unprompted — always confirm with the user first.

## After the on-chain deposit

Once the user (or the delegated client) confirms `depositTxHash`:

1. POST `/facilitator/solana-payment-codes/shielded-links/{linkId}/fund` with `network`, `commitment`, `depositTxHash`, `fundedBy` (buyer pubkey), `nullifier`. The server reads the on-chain `ShieldedDeposit` event, asserts the commitment matches, and flips the link to `funded`.
2. Encode the payload (compact JSON `{v,p,l,s,b,n,a,d,w,g}` → base64url → prefix `relai:shielded:`). See [references/buyer-protocol.md](references/buyer-protocol.md) for the field map.
3. Deliver the payload string to the recipient. **Nothing else** in that message.

Conform to the blog's invariant: "*Forty-eight bytes of text. Nothing else.*"

## Guardrails

- **Never share `buyerPubkey`, `commitment`, `nullifier`, or `depositTxHash`** with the recipient over the chat channel. Each breaks the unlinkability the pool is designed to provide.
- **Never load a wallet private key from env without explicit user confirmation in the same session.** A SKILL is a recipe, not a permission grant. If a delegated tool needs the keypair, the user is the one to provide it.
- **Always price-check before the user signs the deposit.** The on-chain step is non-reversible — only sender-initiated cancellation after `validBefore` recovers the funds.
- **Do not retry a failed mid-flow.** If the deposit broadcast confirmed but the `/fund` call failed, the link is in `draft` with a real on-chain commitment. Do NOT re-initiate the create — surface the explorer link and ask for ops attention.
- **Emit only one shielded payload per message.** No metadata bundling.

## Error recovery

| Symptom | Action |
|---|---|
| `401 Missing X-Service-Key` | Re-resolve service key. Run `relai-setup` if needed. |
| `400 invalid_shielded_fee` | Recompute as `Math.ceil(value * 500 / 10_000)` (round up, not down). |
| `400 invalid_shielded_expiry` | `validBefore` is past or below the ASP-aware minimum TTL. Push it further out. |
| `429 shielded_create_rate_limited` | Wait `Retry-After` seconds. The buyer service key hit the per-window draft cap. |
| Deposit confirms but `/fund` returns 400 | Server can't parse `ShieldedDeposit` event. Verify the deposit tx targeted the program ID returned by step 1. |

## References

- [references/buyer-protocol.md](references/buyer-protocol.md) — exact request/response shapes, Poseidon field-reduction rules, Anchor instruction layout. Loaded only when the agent needs to drive a delegated execution end-to-end.
- [references/privacy-checklist.md](references/privacy-checklist.md) — what the buyer can and cannot reveal in the chat channel without compromising the unlinkability story.
