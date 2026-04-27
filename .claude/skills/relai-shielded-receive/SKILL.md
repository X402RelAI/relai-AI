---
name: relai-shielded-receive
description: Use this skill when an agent has received a `relai:shielded:…` payload from another agent and wants to redeem it to its own wallet privately. The pool relayer signs and pays the on-chain withdraw — the seller pays NO gas and never signs anything on-chain. Documents the protocol; the local Groth16 proof step is delegated to a code-execution sandbox or the openclaw plugin. Triggers on "redeem this shielded link", "claim a private payment", "I got a relai:shielded link", "withdraw a shielded payment", "shielded receive".
---

# RelAI shielded link — seller-side flow

The seller half of the [anonymous-agent-payments](https://relai.fi/blog/anonymous-agent-payments) pattern. Given an opaque `relai:shielded:…` string from a buyer, parse it, generate the seven-input Groth16 ASP proof, and submit the withdraw. The pool relayer signs and pays the on-chain fee — the seller wallet only receives.

This skill is transport-agnostic for the HTTP parts. The Groth16 proof step is local CPU work (~1.5–3s) and requires `snarkjs` + `circomlibjs` — it cannot be done with HTTP alone, so the skill routes that step to the appropriate executor.

## Prerequisite — service key + receive address

Service-key resolution: `RELAI_SERVICE_KEY` env → `~/.relai/service-key.json` (`key` field) → user-referenced file → ask the user. Hand off to `relai-setup` if none resolves.

Receive address: `RELAI_SELLER_SOLANA_PUBKEY` env (or EVM equivalent) → otherwise ask the user. The destination wallet does **not** need a private key, gas, or any prior on-chain history. The relayer creates the recipient ATA if missing.

Base URL: `https://api.relai.fi` (override via `RELAI_API_URL`).

## HTTP endpoints (all `X-Service-Key`-authed)

> **Prod gotcha:** the `/v1/shielded-links/...` proxy is broken for Solana — the proxy routes to a non-existent facilitator path and falls through to `requireAuth`, returning "Missing or invalid Authorization header" 401. Hit the Solana facilitator path directly until that's fixed upstream.

| Step | Method | Path | Skill can fire? |
|---|---|---|---|
| Read link status | `GET` | `/facilitator/solana-payment-codes/shielded-links/{linkId}?network=<id>` | yes |
| Read proof inputs | `GET` | `/facilitator/solana-payment-codes/shielded-links/{linkId}/proof-input?network=<id>` | yes |
| Lock recipient | `POST` | `/facilitator/solana-payment-codes/shielded-links/{linkId}/redeem-intent` | yes (after off-platform nullifier compute) |
| Submit withdraw | `POST` | `/facilitator/solana-payment-codes/shielded-links/{linkId}/execute-withdraw` | yes (after off-platform proof) |

## Sequence

| # | Step | Where it runs |
|---|---|---|
| 1 | Decode payload locally to extract `linkId`, `denomination`, `network` | **off-platform (no network call)** |
| 2 | Pre-flight `GET /shielded-links/{linkId}` — assert `status: funded`, `validBefore` in future, denomination matches the buyer's quote | **HTTP** |
| 3 | Resolve seller's receive address | **conversation** |
| 4 | `GET /proof-input?network=…` to fetch Merkle witness + ASP witness + circuit URLs | **HTTP** |
| 5 | Compute Poseidon nullifier from the note's `secret`, `nonce`, `poolIdHash`, `noteVersion` | **off-platform** |
| 6 | `POST /redeem-intent` to lock the recipient + nullifier | **HTTP** |
| 7 | Generate the Groth16 proof against the V4 circuit (`snarkjs.groth16.fullProve`) | **off-platform** |
| 8 | `POST /execute-withdraw` with the proof + public signals | **HTTP** |
| 9 | Read `payoutTxHash` and verify on the explorer | **off-platform / conversation** |

Steps 1, 5, 7 cannot be done with HTTP alone — see "Delegation".

## Delegation — running the off-platform steps

For steps 1, 5, 7, choose one (in preference order):

1. **openclaw plugin (`relai_shielded_redeem`)** — if the agent has access to `plugin-openclaw`, the entire seller flow (parse → proof-input → nullifier → redeem-intent → Groth16 → execute-withdraw) is a single tool call. The plugin uses the same service key that this skill resolves. **This is the recommended path** when openclaw is available.
2. **Code-execution sandbox** — if the agent has Bash + Node available with `snarkjs`, `circomlibjs`, `ethers`, and `bs58`, the steps can be run inline. Detailed protocol in [references/seller-protocol.md](references/seller-protocol.md).
3. **Reference Node client** — direct the user to [`examples/shielded-agent`](https://github.com/relai-fi/402-everywhere/tree/main/examples/shielded-agent) which ships a working `redeemShieldedLink(...)` helper. They run it locally with the payload + their service key + the receive address.

Pick the first option that's available. Do not climb back up the list.

## Pre-flight before any redeem attempt

Before step 4, always:

- Verify `status: funded` (not `draft`, `redeemed`, `expired`, `cancelled`).
- Verify `validBefore` has ≥ 60s headroom (proof generation can take 3s).
- Verify `value` matches what the buyer quoted in the chat. If lower, **stop** and ask the buyer — once redeemed, the amount is final.

These are pure HTTP checks via `GET /v1/shielded-links/{linkId}`. Run them before starting the proof flow so a stale or wrong-amount link doesn't burn proof-generation cycles.

## On `aspReady: false`

The `proof-input` response can return `aspReady: false` when the buyer's commitment is too fresh for the latest ASP snapshot (the scheduler debounces ~10s). Sleep ≥ 12s and retry the proof-input call. If still failing after 60s, the buyer's funding wallet may be on the ASP defer list — escalate to the buyer.

## Guardrails

- **Treat the payload as bearer-secret.** Anyone holding the full payload can redeem to any address. Do not log or persist the full string anywhere durable until execute-withdraw succeeds.
- **Decode locally to extract `linkId` only — discard `s`, `b`, `n` after passing them to the proof step.** Echoing the secret material to a chat or log defeats the privacy guarantee.
- **Never share the seller's receive address, payout tx hash, or nullifier with the buyer.** Each lets the buyer link the on-chain withdraw event back to the deposit they made.
- **Verify denomination matches the buyer's quote** before step 4. Once redeemed, final.
- **Redact the service key** from every output, log, and memory entry.
- **Do not auto-retry on rate-limit or invalid-proof errors.** Stop and verify payload integrity.

## Error recovery

| Symptom | Action |
|---|---|
| Cannot parse payload | Malformed or truncated. Ask the buyer to resend the full string. |
| `aspReady: false` | Sleep ≥ 12s, retry. After 60s of failure, escalate. |
| `409 already_redeemed` | The link has been redeemed — funds went to whichever `targetAddress` was used first. Stop. |
| `410 expired` | `validBefore` passed before redeem. Funds will return to the buyer on cancel. |
| `429 rate_limited` | Stop. Verify payload integrity before any further attempt. |
| `400 invalid_proof` | Public signals don't match the circuit. Most often: wrong recipient encoding or denomination mismatch. |
| `502 shielded_payout_failed_after_settlement` | (Cross-network only) on-chain withdraw OK but cross-network relay failed. Use `POST /v1/shielded-links/{linkId}/retry-payout?network=<source>` with the same service key. |

## References

- [references/seller-protocol.md](references/seller-protocol.md) — exact request/response payloads, public-signal order, circuit input layout. Loaded only when the agent is driving a code-execution sandbox or debugging a delegated client.
- [references/privacy-checklist.md](references/privacy-checklist.md) — what to ack to the buyer without leaking the seller wallet.
