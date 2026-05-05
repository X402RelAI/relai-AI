---
name: relai-spr-redeem
description: Use this skill after a Shielded Payment Request quote has been paired by a buyer and the seller wants to redeem the on-chain payout via the openclaw plugin. The operator signs and pays the Solana fee — the seller pays NO gas and never signs anything on-chain. 95% to the seller, 5% operator fee, atomically split. Triggers on "redeem an SPR quote", "claim my SPR payout", "the buyer paid the quote, withdraw it".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI SPR — redeem (seller-side)

Operates the SPR seller redeem flow through `plugin-openclaw`. Single tool call (`relai_spr_redeem`) wraps `GET /redeem-proof-input` + `snarkjs.groth16.fullProve` (~1–3s local) + `POST /solana-redeem-relay`. The seller wallet only needs to be ready to receive USDC.

**Solana SPR only.** EVM SPR ships fee-split parity in v0.3 (the EVM path currently requires the seller to sign on-chain — out of scope for this no-gas-on-seller skill).

## Prerequisite

- A configured service key (run `relai_setup` if `relai_spr_*` tools return `status: not_configured`).
- **Pre-derived per-quote stealth pubkey.** SPR's Solana redeem pays out to a stealth Solana account derived from `sha256(walletKeypair.signMessage("relai-spr-stealth-seller:v1:<quoteId>"))`. The plugin tool does NOT derive it (no private keys in tool params); the caller must produce the stealth pubkey externally — see `examples/spr-demo/lib/redeem-spr.mjs` or run a separate openclaw tool / shell helper that has the wallet keypair. The plugin's `relai_spr_redeem` accepts the result as `recipientStealthPubkey`.
- After redeem, the 95% sits in the stealth ATA — a SECOND operator-co-signed claim tx is needed to move it to the seller's main wallet ATA. That step also requires the stealth keypair (it partial-signs `transferChecked`) and is handled by the `solana-stealth-claim-relay` endpoint, which the plugin currently does NOT wrap. Use the demo helper or a custom client for that hop.

## Workflow

### 1. Ensure the agent is configured

`relai_setup` → `already_configured` / `configured`.

### 2. Confirm the quote is paid

Call `relai_spr_status` with `quoteId`. Three outcomes:

- `pending` — buyer hasn't paired yet. Don't redeem; keep polling (≥ 1s between calls).
- `paid` (or `matched`) — proceed.
- `redeemed` — already done (or someone leaked the service key). Stop.
- `expired` / `cancelled` — terminal. The redeem will not succeed.

### 3. Verify denomination matches the quoted amount

Read `amount` from `relai_spr_status` and confirm with the user. Once redeemed, the amount is final — there's no partial redeem.

### 4. Resolve the receive address

Order of resolution:

1. The address the user explicitly typed in this conversation.
2. Otherwise ask the user. **Do NOT default** to anything — always confirm.

The address is public information. Surfacing it back to the user is fine; never echo it over the chat channel where the buyer can see it (see Guardrails).

### 5. Redeem

Call `relai_spr_redeem` with:

- `quoteId` — the same one you issued / inspected.
- `sellerPubkey` — the receive address from step 4.

The tool returns `{quoteId, status, recipient, paidOutMicro, operatorFeeMicro, payoutExplorerUrl}`. `status: redeemed` confirms the on-chain payout. Operator collected `operatorFeeMicro` (5%); seller received `paidOutMicro` (95%).

### 6. Verify and acknowledge

Read `payoutExplorerUrl` once locally to confirm. If the user wants a confirmation message to send back to the buyer, draft a minimal "received, thanks" — and **do NOT** include `payoutTxHash`, `nullifier`, or the seller wallet.

## Guardrails

- **Never share `quoteId` outside the seller's record.** It's bearer for `match-status` lookups; a third party with it can poll your match without your service key.
- **Do not echo the redeem proof input.** The `sellerSecret` and `nonce` carried in the proof input are the seller's spending capability for this quote — feed them to the circuit, then drop them.
- **Treat the payout tx as an internal record.** Don't paste `payoutExplorerUrl` into the same chat where you delivered work to the buyer — it ties their pairing event to your wallet on-chain.
- **Confirm the 95/5 split.** The relay response returns `paidOutMicro` and `operatorFeeMicro` explicitly. If they don't match the expected split for your `amount`, escalate — do not silently accept.
- **Do not auto-retry on `invalid_proof`.** Stop and verify the proof input wasn't tampered with mid-flight.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` | Run `relai_setup`. |
| `409 match not yet recorded` | Buyer hasn't paired. Poll `relai_spr_status` first; only call redeem when `status >= paid`. |
| `409 already redeemed` | Quote was drained. Stop. |
| `400 invalid_proof` | Most often: wrong recipient encoding. Re-verify `sellerPubkey` and don't auto-retry. |
| `429 rate_limited` | Stop. Verify quoteId hasn't been brute-forced. |
| `500 zkey_artifact_unavailable` | Backend's CDN dropped the wasm/zkey. Retry once, escalate if persistent. |

## References

- The transport-agnostic Claude skill `.claude/skills/relai-spr-redeem/SKILL.md` documents the raw HTTP + circuit contract underneath the plugin tool.
- `relai-spr-inspect` (this directory) — read-only sibling for status / receipt lookups.

## Relation to other skills

- **`relai-spr-issue`** (this directory) — what you ran to mint the quote you're redeeming.
- **`relai-spr-pay`** (`.claude/skills/`) — the BUYER's flow. Don't run it yourself.
- **`relai-shielded-receive`** — the BUYER-initiated direction's seller-side flow (no quote involved).
