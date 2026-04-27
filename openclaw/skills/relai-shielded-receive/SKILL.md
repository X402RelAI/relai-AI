---
name: relai-shielded-receive
description: Use this skill when an agent has received a `relai:shielded:…` payload from another agent and wants to redeem it to its own wallet privately. The pool relayer signs and pays the on-chain withdraw — the seller pays NO gas and never signs anything on-chain. Triggers on "redeem this shielded link", "claim a private payment", "I got a relai:shielded link", "withdraw a shielded payment", "shielded receive".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI shielded link — seller-side redeem

The seller half of the [anonymous-agent-payments](https://relai.fi/blog/anonymous-agent-payments) flow. Given an opaque `relai:shielded:…` string from a buyer, the agent generates the seven-input Groth16 ASP proof locally (~1.5–3s on a normal CPU) and asks the pool relayer to broadcast the withdraw. **The relayer signs and pays the on-chain Solana fee** — the seller wallet only needs to be ready to receive USDC.

This is the slice of the shielded-link flow that fits a service-key-only HTTP plugin perfectly. The buyer half (note generation + on-chain `deposit_note`) lives outside this plugin because it requires a Solana keypair the LLM must never see.

## Tools

- `relai_shielded_redeem` — full redeem: parse payload → request proof inputs → generate Groth16 proof → submit to relayer.
- `relai_shielded_status` — verify the link is `funded` (not yet `redeemed` or `expired`) before attempting.
- `relai_shielded_asp_status` — when a redeem fails with `aspReady: false`, check whether the next snapshot is imminent.

All three are service-key-authenticated through the agent's own `relai_setup` consent — no private keys, no wallet credentials passed in tool params.

## Workflow

### 1. Ensure the agent is configured

Call `relai_setup`. Three outcomes:

- `status: already_configured` → proceed.
- `status: awaiting_consent` → return the `authorizeUrl` to the user, wait for approval, call `relai_setup` again.
- `status: configured` → proceed.

### 2. Resolve the receive address

The seller's destination wallet is whatever pubkey the user wants the funds delivered to. The destination does **not** need a private key, SOL/ETH balance, or any prior on-chain history — the relayer creates the recipient ATA if it doesn't exist.

Order of resolution:
1. Address the user explicitly typed in this conversation.
2. If unspecified, ask the user. Do NOT default to anything — always confirm.

The address is public information. Surfacing it to the user for confirmation is fine; **never** echo it back over the chat channel where the buyer can see it (see Guardrails).

### 3. Pre-flight (optional but recommended)

Before redeeming, call `relai_shielded_status` with the `linkId` extracted from the payload. Verify:

- `status === "funded"` (not `draft`, not already `redeemed`, not `expired`).
- `validBefore` is comfortably in the future (≥ 60s headroom; proof generation can take 3s).
- Reported `value` matches what the buyer quoted in the chat. If lower, **stop** and ask the buyer — once redeemed, the amount is final.

To extract `linkId` from `relai:shielded:<base64url>` locally (no network call): base64url-decode the payload after the prefix, parse JSON, read field `l`. Do NOT echo the full payload, the secret (`s`), the blinding (`b`), or the nonce (`n`) — those are the spending capability.

### 4. Redeem

Call `relai_shielded_redeem` with:

- `shieldedLinkPayload` — the **full** `relai:shielded:<base64url>` string from the buyer, verbatim.
- `targetAddress` — the seller pubkey from step 2.
- `targetNetwork` — optional. Omit for same-network redeem (default). Set only when the buyer explicitly agreed to a cross-network payout out-of-band (e.g. buyer deposited on `base-sepolia`, seller wants `solana-devnet`).

The tool returns `{status, recipient, payoutTxHash, payoutExplorerUrl, nullifier}`. The `payoutTxHash` and `nullifier` are for the seller's records — see Guardrails.

### 5. Verify and acknowledge

Confirm the funds landed by reading the explorer URL **once, locally**. If the user wants a confirmation message to send back to the buyer over the business-level chat, draft a minimal one — "received, here is the delivery" — and **do not** include the payout tx, the nullifier, the seller wallet, or any other forensic artifact.

A common mistake: pasting the explorer URL into the same chat where the work product is delivered. That's a privacy leak that defeats the point of a shielded link.

## Guardrails

- **Treat the payload as bearer-secret.** Anyone holding the full payload can redeem to any address. Until the redeem call returns, do not log or persist the full string anywhere durable.
- **Never share the seller's `targetAddress`, `payoutTxHash`, or `nullifier` with the buyer.** Each is a vector that lets the buyer link the on-chain withdraw event back to the deposit they made.
- **Verify denomination matches the buyer's quote** before calling `relai_shielded_redeem`. Once redeemed, the amount is final.
- **On `aspReady: false` retry, wait the full debounce.** The tool surfaces this as `retryable: true` with `aspBlockedReason`. Sleep ≥ 12s before retrying — the ASP scheduler debounces ~10s.
- **Do not auto-retry on rate-limit or invalid-proof errors.** Stop, inspect the payload, and ask the user to verify it's the unmodified string the buyer sent.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` | Run `relai_setup`. |
| `Could not parse shieldedLinkPayload` | Malformed or truncated. Ask the buyer to resend the full string. |
| `retryable: true` with `aspBlockedReason` | Sleep ~12s and call `relai_shielded_redeem` again with the same params. If still failing after 60s, call `relai_shielded_asp_status` — the buyer's funding wallet may be on the ASP defer list. |
| 409 `already_redeemed` | The link has been redeemed — funds went to whichever `targetAddress` was used first. Stop. |
| 410 `expired` | `validBefore` passed before redeem. Funds will return to the buyer on cancel; nothing for the seller to do. |
| 400 `invalid_proof` | Most often: wrong `recipient` encoding or denomination mismatch. Re-verify the payload integrity; do NOT auto-retry. |
| 429 `rate_limited` | Stop — too many invalid proofs in a row. Verify the payload integrity before any further attempt. |

## References

- [references/redeem-protocol.md](references/redeem-protocol.md) — the four-call sequence the tool wraps, plus the public-signal order.
- [references/privacy-checklist.md](references/privacy-checklist.md) — what's safe to ack to the buyer vs. what leaks the seller wallet.

## Relation to other skills

- **Buyer-side flow** (note generation, on-chain `deposit_note`, fund report, payload emission) requires a Solana keypair to sign on-chain — out of scope for an openclaw plugin. The transport-agnostic version lives in `.claude/skills/relai-shielded-send`.
- **Pre-redeem inspection** is also covered by `relai-shielded-inspect` (config / status / ASP status). Use that skill if the user only wants to inspect, not redeem.
- For non-private metered payments, `relai-marketplace-buy` is the standard x402 path.
