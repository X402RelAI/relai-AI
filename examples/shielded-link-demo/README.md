# shielded-link-demo

Two Claude-driven agents negotiate a one-page Japanese-to-Polish translation and settle the payment privately via a [RelAI shielded link](https://relai.fi/blog/anonymous-agent-payments) on solana-devnet. Live RelAI API, real on-chain Solana transactions, real Groth16 zk proofs. No simulation, no scripted dialogue.

The interesting bit: each agent **loads a Claude Skill at startup** ([`.claude/skills/relai-shielded-send`](../../.claude/skills/relai-shielded-send) and [`.claude/skills/relai-shielded-receive`](../../.claude/skills/relai-shielded-receive)) and runs against the same SKILL.md content a Claude Code user would see — proving the skills are runtime-portable per the [Agent Skills spec](https://agentskills.io/specification).

## What you'll see on screen

The orchestrator pre-renders a hackathon-grade UI on top of the raw agent chatter:

- **Opening banner** — network + model + spawned agent processes.
- **Five step badges** (`STEP 1 · NEGOTIATE` … `STEP 5 · DELIVER TRANSLATION`) that fire as each phase completes, with elapsed wall-clock time.
- **Inline method-trace lines** under each step badge so the audience sees exactly which methods generate the link and which claim the USDC. Three glyph kinds:
  - `→` HTTP call (RelAI facilitator endpoint)
  - `⛓` on-chain instruction (`solana.deposit_note`)
  - `∑` local compute (Poseidon hash, Groth16 proving)
- **Privacy callouts** (gold `▸`) — short notes explaining what is and isn't on-chain at each step.
- **On-chain receipts** (green `┃`) — Solscan link + tx signature for both the deposit and the relayer-signed withdraw.
- **`DEAL COMPLETE` summary panel** — final wallet labels, amount, total elapsed, deposit + withdraw URLs, per-phase timings.

All of this is in `shared/visuals.mjs` and is independent of the agent loop — disable it by stubbing the helpers if you want raw stdout.

## What's real

| Layer | Implementation |
|---|---|
| Agent reasoning | `claude-sonnet-4-6` via `@anthropic-ai/sdk`, full tool-use loop, prompt caching on the system prompt (skill body cached as ephemeral) |
| Skill loading | `shared/load-skill.mjs` reads `.claude/skills/<name>/SKILL.md`, strips YAML frontmatter, inlines `references/*.md`, and injects the body into the system prompt — minimal client-implementor pattern from [agentskills.io/client-implementation](https://agentskills.io/client-implementation/adding-skills-support) |
| Tool surface | Same names a Claude Code agent with `plugin-openclaw` installed would see: `relai_shielded_create` (buyer) and `relai_shielded_redeem` (seller). The skill body's tool references resolve correctly |
| Inter-agent comms | Localhost HTTP chat bus (`POST /send`, `GET /poll` long-poll, `POST /clear` to drop stale messages between runs). For production multi-agent IPC, see the [A2A protocol](https://a2aproject.github.io/A2A/) — this demo uses a minimal subset for clarity |
| RelAI calls | Live: `GET /facilitator/payment-codes/shielded-links/config`, `POST /facilitator/solana-payment-codes/shielded-links`, `POST .../:id/fund`, `GET .../:id/proof-input`, `POST .../:id/redeem-intent`, `POST .../:id/execute-withdraw` against `RELAI_BASE_URL` (default `https://api.relai.fi`) |
| On-chain deposit | Real `deposit_note` Anchor instruction broadcast to `solana-devnet`, signed by the buyer's keypair |
| ZK proof | Real `snarkjs.groth16.fullProve` against the V4 ASP circuit artefacts the backend advertises (~5 MB wasm + zkey, ~1–3 s on local CPU) |
| On-chain withdraw | Signed and paid by the RelAI pool relayer — the seller never touches Solana directly |

## Privacy invariants the demo enforces

### Buyer wallet keypair never enters the LLM context

The buyer's Solana keypair is loaded **once at process startup** from `RELAI_BUYER_SOLANA_SECRET_KEY`, materialized into a `Keypair` object, and bound into the `relai_shielded_create` tool's closure. The LLM only ever sees and passes `recipientAmountUsdc` — never the private key.

This matches the public-demo guideline that the signing operation should happen in a small adjacent process/tool that the LLM invokes with a transaction *intent*, never with the key itself.

If you read `lib/create.ts`, you'll see `CreateShieldedLinkInput.buyer` is typed as `Keypair`, not `string` — making it structurally impossible for an LLM tool param to introduce a key.

### Buyer privacy guardrails (system-prompt-level)

The buyer agent's system prompt is structurally prevented from sending any of the following over the chat bus:

- Solana pubkey
- Poseidon commitment
- Nullifier
- Deposit tx hash

The shielded link payload string is the only payment-related thing the seller ever receives.

### Seller privacy guardrails (system-prompt-level)

The seller agent never sends the buyer:

- Its receive pubkey
- The payout tx hash
- The nullifier

A bare "received, here is the delivery" is the entire ack.

Both invariants come from the SKILL.md `Guardrails` sections — loaded at startup, cached in the system prompt, applied uniformly across the whole tool loop.

## Setup

```bash
# 1. Install deps (this directory)
npm install

# 2. Configure env
cp .env.example .env
# edit .env — fill in:
#   ANTHROPIC_API_KEY                — sk-ant-api03-...
#   RELAI_SERVICE_KEY_BUYER          — sk-agent-... (run `relai-setup` skill if needed)
#   RELAI_SERVICE_KEY_SELLER         — sk-agent-... (separate one for the seller)
#   RELAI_BUYER_SOLANA_SECRET_KEY    — JSON byte array (Solana CLI format) or base58
#   RELAI_SELLER_SOLANA_PUBKEY       — base58 pubkey

# 3. Top up the buyer wallet
#    a) Devnet SOL: auto-airdropped by the demo when the balance is below 0.01 SOL.
#    b) Devnet USDC: https://faucet.circle.com → Solana Devnet → paste the buyer pubkey
#       (the buyer agent prints its pubkey at startup).
#       Get at least 2 USDC (covers ~20 demo runs at 0.10 USDC + 5% fee each).
```

## Run

```bash
# One-shot orchestrated demo (banner + step badges + summary panel)
npm run demo
```

Or run each piece in its own terminal — clearer errors, identical output:

```bash
npm run bus      # chat bus on :4747
npm run buyer    # buyer agent
npm run seller   # seller agent
```

Sequence (fully autonomous after launch):

1. Buyer pings the seller and asks for a quote.
2. Seller quotes 0.10 USDC for one page.
3. Buyer agrees and announces it's about to send a shielded payment.
4. Buyer calls `relai_shielded_create` → method-trace lines fire under `STEP 2 · DEPOSIT ON-CHAIN` (config → commitment → POST draft → on-chain `deposit_note` → nullifier → POST fund). On-chain receipt with the Solscan link prints below.
5. Buyer sends the `relai:shielded:…` payload over the chat bus (one message, nothing else in it).
6. Seller calls `relai_shielded_redeem` → method-trace lines fire under `STEP 4 · ZK PROOF + WITHDRAW` (proof-input → nullifier → redeem-intent → fetch wasm/zkey → Groth16 → execute-withdraw). Relayer broadcasts the withdraw, seller pays zero gas.
7. Seller delivers the translation. Buyer acks.
8. Both agents print `DEAL COMPLETE:`. Orchestrator renders the summary panel.

## Verify privacy on-chain

After the demo:

```bash
# The deposit (visible to anyone, but not attributable to the seller)
open "<deposit explorer URL from the buyer log>"

# The withdraw (visible to anyone, but not attributable to the buyer)
open "<payout explorer URL from the seller log>"
```

There is no on-chain transaction with both wallets as inputs/outputs. The buyer's deposit goes to the pool PDA; the pool PDA → seller's wallet is signed by the relayer. The two events sit among unrelated pool ops.

## Anatomy

```
shielded-link-demo/
├── package.json              demo deps (anthropic SDK + crypto), no plugin coupling
├── LICENSE                   MIT
├── .env.example              required env vars
├── .gitignore                ignores .env, .buyer-devnet.json, *-devnet.json
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
│   ├── note.ts               Poseidon commitment + nullifier (BN254 field)
│   ├── payload.ts            encode/parse `relai:shielded:<base64url>`
│   ├── solana-deposit.ts     Anchor `deposit_note` ix builder + signer
│   ├── create.ts             buyer flow (assembles all the above + emits method traces)
│   └── redeem.ts             seller flow (proof-input → groth16 → execute-withdraw + traces)
├── agent-buyer.mjs           buyer persona + relai_shielded_create tool
└── agent-seller.mjs          seller persona + relai_shielded_redeem tool
```

The demo is **standalone** — it does not import from `@relai-fi/plugin-openclaw`. Plugin and demo are independent consumers of the same RelAI HTTP API.

## Method-trace cheat sheet

What gets logged under each step badge — useful for screenshots / video overlays:

**STEP 2 · DEPOSIT ON-CHAIN** *(buyer, link generation)*
```
→  GET  /facilitator/payment-codes/shielded-links/config
∑  poseidon(note) → commitment  (off-chain)
→  POST /facilitator/solana-payment-codes/shielded-links
⛓  solana.deposit_note  (on-chain · buyer signs)
∑  poseidon(note, idx) → nullifier  (off-chain)
→  POST /facilitator/solana-payment-codes/shielded-links/:id/fund
```

**STEP 4 · ZK PROOF + WITHDRAW** *(seller, USDC claim)*
```
→  GET  /facilitator/solana-payment-codes/shielded-links/:id/proof-input
∑  poseidon(note, idx) → nullifier  (off-chain)
→  POST /facilitator/solana-payment-codes/shielded-links/:id/redeem-intent
→  GET  circuit artifacts  (wasm + zkey, ~5 MB)
∑  snarkjs.groth16.fullProve  (Groth16 · BN254 · local CPU)
→  POST /facilitator/solana-payment-codes/shielded-links/:id/execute-withdraw
```

## Why two processes?

The blog says "two agents collaborating remotely". A two-process HTTP demo proves the agents could equally well run on different hosts — the chat bus would just have a public URL. For a real production system, see the [A2A protocol](https://a2aproject.github.io/A2A/) (Linux Foundation, JSON-RPC over HTTPS). This demo intentionally rolls its own minimal bus to keep the runnable code under 200 lines.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Buyer ... has X micro-USDC on devnet; needs at least Y` | Hit the Circle devnet USDC faucet for the buyer pubkey (printed at agent startup). |
| `aspReady: false` repeatedly | The pool's ASP scheduler debounces ~10 s after a deposit. The seller agent retries automatically; if it persists for ≥ 60 s, the buyer's funding wallet may be on the ASP defer list. |
| One agent crashes early | Run each in its own terminal: `npm run bus`, then `npm run buyer`, then `npm run seller`. Clearer error output. |
| Seller reacts to a message it shouldn't | The chat bus persists across runs in 3-terminal mode. Each agent calls `POST /clear` on its inbox at startup; if you see stale messages, restart the bus. |
| `Missing X-Service-Key` | The relevant `RELAI_SERVICE_KEY_*` env var isn't set or is wrong. Run the `relai-setup` skill to provision a fresh one. |
| Skill-loader can't find `.claude/skills/...` | The demo expects to live at `examples/shielded-link-demo/` relative to the repo root. If you copied it elsewhere, update `skillsRoot` in `agent-{buyer,seller}.mjs`. |

## License

MIT. See `LICENSE`.
