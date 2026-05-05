# spr-demo

Two Claude-driven agents settle a one-page Japanese-to-Polish translation privately via a [RelAI Shielded Payment Request (SPR)](https://relai.fi/documentation/management-api#shielded-payment-requests) on solana-devnet. **The seller initiates** — issues an opaque `relai:quote:<base64url>` payload, the buyer pays anonymously through Privacy Pool V4.1, the seller redeems with a separate ZK proof, and the operator splits 95% / 5% atomically on-chain.

This is the **reverse-direction** companion to the [shielded-link-demo](../shielded-link-demo/). Same skill-loading mechanism (Agent Skills spec), same chat bus, same prompt-caching system blocks — the protocol direction is what changes.

## What's different vs shielded-link-demo

| Aspect | shielded-link | shielded-payment-request (this demo) |
|---|---|---|
| Initiation | **Buyer** creates a payload, gives it to the seller | **Seller** issues a quote, gives it to the buyer |
| ZK proofs | 1 (seller redeem) | **2** (buyer pairing + seller redeem) |
| Fee | 5% rounded up, off-chain accounting | **5% on-chain split** atomic in `payout_to_seller` |
| On-chain registry | Privacy Pool only | `QuoteRegistry` + `PaymentMatchRegistry` + `ShieldedPoolV41` |
| Buyer signs on-chain? | Yes — `deposit_note` | Yes — same `deposit_note` (against the buyer's commitment) |
| Seller signs on-chain? | No — operator-relayed withdraw | No — operator-relayed `verify_and_record` + `payout_to_seller` |
| Networks | solana-devnet (mainnet roadmap) | **Testnet only**: solana-devnet, base-sepolia, skale-base-sepolia |

## What gets logged on screen

Same hackathon-grade UI as shielded-link-demo:

- **Opening banner** — network, model, two spawned agent processes (purple accent vs the shielded-link blue, so you can tell them apart in screenshots).
- **Five step badges** that fire as each phase completes: `STEP 1 · NEGOTIATE` → `STEP 2 · ISSUE SPR QUOTE` → `STEP 3 · PAY (DEPOSIT + PAIR)` → `STEP 4 · REDEEM (OPERATOR-SIGNED)` → `STEP 5 · DELIVER TRANSLATION`.
- **Method-trace lines** under each badge with the same glyphs as the shielded-link demo: `→` HTTP, `⛓` on-chain, `∑` local compute (Poseidon, Groth16).
- **Privacy callouts** (gold `▸`) explaining what is and isn't on-chain at each step.
- **On-chain receipts** (green `┃`) — Solscan link + tx signature for the deposit, the pairing relay, and the redeem payout.
- **`DEAL COMPLETE` summary panel** with timings, the 95/5 split numbers, and all three explorer links.

## What's real

| Layer | Implementation |
|---|---|
| Agent reasoning | `claude-sonnet-4-6` via `@anthropic-ai/sdk`, full tool-use loop, prompt caching on the system prompt (skills cached as ephemeral) |
| Skill loading | `shared/load-skill.mjs` reads `.claude/skills/relai-spr-{issue,pay,redeem}/SKILL.md`, strips frontmatter, inlines references — same minimal client-implementor pattern as shielded-link-demo |
| Tool surface | `relai_spr_issue` + `relai_spr_status` + `relai_spr_redeem` (seller) and `relai_spr_pay` (buyer). Demo-local tools, not the openclaw plugin — the demo proves the SKILL.md content is enough on its own |
| Inter-agent comms | Same localhost HTTP chat bus (`POST /send`, `GET /poll`, `POST /clear`) on port `CHAT_BUS_PORT` (default `4748` here, vs `4747` in shielded-link-demo) |
| RelAI calls | Live: `POST /v1/shielded-payment-requests` (draft + issue), `POST /…/solana-deposit-confirmed`, `GET /…/quote-witness` + `/solana-{pool,asp}-witness/:c`, `POST /…/solana-pairing-relay`, `GET /…/redeem-proof-input`, `POST /…/solana-redeem-relay` against `RELAI_BASE_URL` |
| On-chain deposit | Real `deposit_note` Anchor instruction broadcast to `solana-devnet`, signed by the buyer's keypair (same instruction the shielded-link-demo uses — SPR shares the `solana-shielded-pool` program) |
| ZK proofs | Real `snarkjs.groth16.fullProve` against the SPR pairing circuit (buyer side) and the SPR redeem circuit (seller side) |
| On-chain pairing + payout | Signed and paid by the RelAI operator — buyer signs only the deposit, seller signs nothing |

> **Reference implementation**
>
> The pairing + redeem flows in `lib/pay-spr.mjs` and `lib/redeem-spr.mjs` are vendored from `402-everywhere/examples/spr-agent/src/` (the canonical SPR Node reference). They consume the actual circuit `.wasm` + `.zkey` published at `https://relai.fi/zk/shielded-payment-{pairing,redeem}/`. Public-signal layouts and circuit input shapes are authoritative — taken from the circom sources at `402-everywhere/contracts/circuits/ShieldedPayment{Pairing,Redeem}.circom`.

## Privacy invariants the demo enforces

### Buyer wallet keypair never enters the LLM context

The buyer's Solana keypair is loaded **once at process startup** from `RELAI_BUYER_SOLANA_SECRET_KEY`, materialized into a `Keypair`, and bound by closure into the `relai_spr_pay` tool. The LLM only ever passes the `quotePayload` string — never the private key.

`lib/pair.ts` types `SprPairInput.buyer` as `Keypair`, not `string` — making it structurally impossible for an LLM tool param to introduce a key.

### Buyer privacy guardrails (system-prompt-level)

The buyer agent's system prompt is structurally prevented from sending any of the following over the chat bus:

- Solana pubkey
- Buyer commitment (Poseidon leaf)
- Payment nullifier
- Deposit tx hash
- Pairing relay tx signature

A bare "paid" ack is the entire message after pay completes.

### Seller privacy guardrails (system-prompt-level)

The seller agent never sends the buyer:

- Its receive pubkey
- The redeem payout tx hash
- The quote nullifier
- The split numbers (`paidOut` / `operatorFee`)

A "received, here is the delivery" is the entire ack.

Both invariants come from the SKILL.md `Guardrails` sections — loaded at startup, cached in the system prompt, applied uniformly across the whole tool loop.

## Setup

```bash
# 1. Install deps
cd examples/spr-demo
npm install

# 2. Configure env
cp .env.example .env
# edit .env — fill in:
#   ANTHROPIC_API_KEY                 — sk-ant-api03-...
#   RELAI_SERVICE_KEY_BUYER           — sk-agent-...
#   RELAI_SERVICE_KEY_SELLER          — sk-agent-...
#   RELAI_BUYER_SOLANA_SECRET_KEY     — JSON byte array (Solana CLI format) or base58
#   RELAI_SELLER_SOLANA_SECRET_KEY    — JSON byte array (NOT just a pubkey: the seller signs
#                                        a per-quote stealth-derivation challenge and partial-signs
#                                        the stealth → main wallet claim tx)
#   CHAT_BUS_PORT                     — defaults to 4748 (vs 4747 for shielded-link-demo)

# 3. Top up the buyer wallet on devnet
#    a) Devnet SOL: auto-airdropped by the demo when balance < 0.01 SOL.
#    b) Devnet USDC: https://faucet.circle.com → Solana Devnet → paste the buyer pubkey,
#       OR hit POST /v1/shielded-payment-requests/solana-spr-faucet (testnet helper).
#       Get at least 1 USDC (covers ~10 demo runs at 0.10 USDC each — no per-deposit fee
#       for SPR; the 5% comes off the seller's redeem).
```

## Run

```bash
# One-shot orchestrated demo (banner + step badges + summary panel)
npm run demo
```

Or run each piece in its own terminal:

```bash
npm run bus       # chat bus on :4748
npm run seller    # seller agent (issues first)
npm run buyer     # buyer agent (pays the issued quote)
```

Sequence (autonomous after launch):

1. Buyer pings the seller and asks for a quote (includes the source text).
2. Seller quotes 0.10 USDC and calls `relai_spr_issue` → method-trace lines fire under `STEP 2 · ISSUE SPR QUOTE` (POST draft → POST issue → emit payload).
3. Seller sends the `relai:quote:…` payload over the chat bus.
4. Buyer calls `relai_spr_pay` with that payload → method-trace lines fire under `STEP 3 · PAY (DEPOSIT + PAIR)` (config → buyer note → on-chain `deposit_note` → /deposit-confirmed → wait ASP → witness fetch ×3 → poseidon nullifier → snarkjs Groth16 → /pairing-relay).
5. Buyer acks "paid". Seller polls `relai_spr_status` until `status: paid`.
6. Seller calls `relai_spr_redeem` → method-trace lines fire under `STEP 4 · REDEEM (OPERATOR-SIGNED)` (proof-input → fetch wasm/zkey → snarkjs Groth16 → /solana-redeem-relay). Operator broadcasts the payout, splits 95/5 atomically.
7. Seller delivers the translation. Buyer acks.
8. Both agents print `DEAL COMPLETE:`. Orchestrator renders the summary panel with three explorer links (deposit, pair, redeem) and the timing breakdown.

## Verify privacy on-chain

After the demo:

```bash
# Buyer's deposit + pairing — names the buyer wallet on-chain
open "<deposit explorer URL from the buyer log>"
open "<pair explorer URL from the buyer log>"

# Seller's redeem payout — names the seller wallet on-chain
open "<payout explorer URL from the seller log>"
```

There is no on-chain transaction with both wallets as inputs/outputs. The buyer's deposit and pairing event reference the pool PDA + QuoteRegistry; the operator's `payout_to_seller` references the pool PDA + the seller's ATA. The two trees of events sit among unrelated pool ops.

## Anatomy

```
spr-demo/
├── package.json              demo deps (Anthropic SDK + Solana + crypto)
├── .env.example              env vars template
├── start-demo.mjs            orchestrator: banner + chat bus + 2 spawned agents + summary panel
├── shared/
│   ├── agent-loop.mjs        Anthropic tool-use loop, multi-block system, prompt caching
│   ├── chat-bus.mjs          HTTP bulletin board (POST /send, GET /poll, POST /clear)
│   ├── chat-tools.mjs        send_message + wait_for_message tool defs + clearInbox helper
│   ├── load-skill.mjs        SKILL.md loader (Agent Skills spec, minimal client)
│   ├── render.mjs            assistant text 💬, gray pulsing tool spinner, ✓/✗, chat bubbles
│   ├── banners.mjs           per-agent startup banner (pubkey, network, model, skill)
│   └── visuals.mjs           opening banner, step badges, method traces, privacy callouts,
│                             on-chain receipts, deal-complete summary panel
├── lib/
│   ├── note.ts               Poseidon commitment + nullifier (BN254 field) — same as shielded-link
│   ├── solana-deposit.ts     Anchor `deposit_note` ix builder + signer — same as shielded-link
│   ├── payload.ts            encode/parse `relai:quote:<base64url>`
│   ├── issue.ts              seller issue flow (HTTP only)
│   ├── pair.ts               buyer pay flow (config → deposit → witnesses → Groth16 → pair-relay)
│   └── redeem.ts             seller redeem flow (proof-input → Groth16 → redeem-relay)
├── agent-buyer.mjs           buyer persona + relai_spr_pay tool
└── agent-seller.mjs          seller persona + relai_spr_issue / _status / _redeem tools
```

The demo is **standalone** — it does not import from `@relai-fi/plugin-openclaw`. Plugin and demo are independent consumers of the same RelAI HTTP API.

## Method-trace cheat sheet

What gets logged under each step badge — useful for screenshots / video overlays:

**STEP 2 · ISSUE SPR QUOTE** *(seller)*
```
→  POST /v1/shielded-payment-requests              (draft)
→  POST /v1/shielded-payment-requests/:id/issue
```

**STEP 3 · PAY (DEPOSIT + PAIR)** *(buyer)*
```
→  GET  /facilitator/payment-codes/shielded-links/config
∑  poseidon(buyer note) → commitment  (off-chain)
⛓  solana.deposit_note  (on-chain · buyer signs)
→  POST /v1/shielded-payment-requests/:id/solana-deposit-confirmed
→  GET  /facilitator/.../:id/quote-witness
→  GET  /v1/shielded-payment-requests/solana-pool-witness/:c
→  GET  /v1/shielded-payment-requests/solana-asp-witness/:c
∑  poseidon(buyer note, quote secrets) → paymentNullifier
∑  snarkjs.groth16.fullProve  (Groth16 · pairing)
→  POST /v1/shielded-payment-requests/:id/solana-pairing-relay
```

**STEP 4 · REDEEM (OPERATOR-SIGNED)** *(seller)*
```
→  GET  /v1/shielded-payment-requests/:id/redeem-proof-input
→  GET  circuit artifacts  (wasm + zkey, ~5 MB)
∑  snarkjs.groth16.fullProve  (Groth16 · redeem)
→  POST /v1/shielded-payment-requests/:id/solana-redeem-relay
```

## Why two processes?

Same reasoning as shielded-link-demo: a two-process HTTP demo proves the agents could equally well run on different hosts — the chat bus would just have a public URL. For production multi-agent IPC, see the [A2A protocol](https://a2aproject.github.io/A2A/).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Buyer ... has X micro-USDC; needs at least Y` | Hit the Circle devnet USDC faucet for the buyer pubkey (printed at agent startup), or call `POST /v1/shielded-payment-requests/solana-spr-faucet`. |
| `solana-pairing-relay → 400 invalid_proof` | Best-effort pairing-circuit input layout in `lib/pair.ts` doesn't match the deployed `solana-payment-match-router-v2`. Match `buildPairingCircuitInputs` to the SPR repo's pairing circom source. |
| `redeem-proof-input → 409 match not yet recorded` | Buyer hasn't paired yet, or the operator's `verify_and_record` tx failed. Check buyer logs. |
| `Failed to fetch …/pairing.{wasm,zkey} → HTTP 404` | The default circuit URLs don't match your RelAI instance. Set `SPR_PAIRING_WASM_URL` / `SPR_PAIRING_ZKEY_URL` in `.env`. |
| `Missing X-Service-Key` | The relevant `RELAI_SERVICE_KEY_*` env var isn't set or is invalid. Run the `relai-setup` skill to provision. |
| Skill-loader can't find `.claude/skills/...` | The demo expects to live at `examples/spr-demo/` relative to the repo root. If you copied it elsewhere, update `skillsRoot` in `agent-{buyer,seller}.mjs`. |

## License

MIT.
