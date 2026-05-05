---
name: relai-spr-issue
description: Use this skill when an agent wants to issue a private payment quote (Shielded Payment Request) using the openclaw plugin. Returns a `relai:quote:<base64url>` payload to hand to the buyer for anonymous payment. Triggers on "issue an SPR quote", "publish a private invoice", "create a shielded payment request", "send me money privately".
metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}
---

# RelAI SPR — issue a quote (seller-side)

Operates the SPR seller-issue flow through `plugin-openclaw`. Single tool call (`relai_spr_issue`) wraps `POST /v1/shielded-payment-requests` (create draft) + `POST /…/issue` (transition + emit payload).

**Testnet only.** Currently `base-sepolia`, `skale-base-sepolia`, `solana-devnet`.

## Prerequisite

A configured service key. If `relai_spr_*` tools return `status: not_configured`, run `relai_setup` first.

## Workflow

### 1. Ensure the agent is configured

Call `relai_setup`. Three outcomes: `already_configured` / `awaiting_consent` (return URL, ask for approval, retry) / `configured`.

### 2. Confirm the quote with the user

Before issuing, confirm explicitly:

- **`amount`** — atomic units (1 USDC = 1,000,000). Read it back as both atomic and the human "X USDC" form.
- **`network`** — one of `base-sepolia`, `skale-base-sepolia`, `solana-devnet`.
- **`validForSeconds`** — TTL. Default 3600 (1h). Server requires `> 5 min`.
- **`description`** — optional short tag (≤ 100 chars). No PII, no buyer identity.
- **`sellerEncPk`** — optional X25519 pubkey for sealed proof bundles (Solana only). If the user doesn't know what this is, leave it unset — the redeem still works without it.

### 3. Call `relai_spr_issue`

Returns `quoteId`, `payload` (`relai:quote:eyJ…`), `commitment`, `sellerReceiptId`. The `payload` field is bearer — share it with ONE buyer over any channel, nothing else in that message.

### 4. Hand the payload to the buyer

Send the payload string verbatim. Do NOT include in the same message:

- The bare `quoteId` (it's already inside the payload).
- The `sellerReceiptId` (your private record).
- Your wallet address.
- The amount (the buyer reads it from the payload — quoting again invites mismatch).

### 5. Track the match

Use `relai_spr_status` (public — no service key) periodically to check whether the buyer paired. Status will move from `pending` → `paid` → `redeemed`. Don't poll faster than 1 Hz.

If the user wants to abort before pairing, call `relai_spr_cancel`. After pairing (`status: paid` or later), the cancel route returns 409 — proceed to redeem instead.

## Guardrails

- **Treat the payload as bearer-secret** until pairing. Anyone with it can attempt to pair (the worst case is the wrong buyer claims the slot).
- **Don't re-issue** for a quote already in `paid` / `redeemed`. Server returns 409. Mint a fresh quote instead.
- **Set expiry generously.** 1h–24h depending on the buyer's expected response time. The 5-min floor is enforced strictly.
- **Never auto-cancel** without confirming with the user.
- **Respect amount precision.** The tool takes atomic micro-USDC. `0.5` USDC is `"500000"` — passing `"0.5"` raises a server-side validation error.

## Error recovery

| Symptom | Action |
|---|---|
| `not_configured` | Run `relai_setup`. |
| `400 expiry must be >5min in future` | Bump `validForSeconds`. |
| `400 invalid network` | Only `base-sepolia`, `skale-base-sepolia`, `solana-devnet` accepted. |
| `400 amount must be positive` | Atomic units; check sign and zero. |

## References

- The transport-agnostic Claude skill `.claude/skills/relai-spr-issue/SKILL.md` documents the raw HTTP contract underneath the plugin tool.

## Relation to other skills

- **`relai-spr-redeem`** (this directory) — the seller's follow-up after the buyer pairs.
- **`relai-spr-pay`** (`.claude/skills/`) — what the BUYER runs against the payload you hand them. They consume the same `quoteId` over public endpoints.
- **`relai-shielded-receive`** — the BUYER-initiated direction (no quote involved).
