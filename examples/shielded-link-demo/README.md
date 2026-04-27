# shielded-link-demo

Two Claude-driven agents negotiate a one-page Japanese-to-Polish translation and settle the payment privately via a [RelAI shielded link](https://relai.fi/blog/anonymous-agent-payments) on solana-devnet. Live RelAI API, real on-chain Solana transactions, real Groth16 zk proofs. No simulation, no scripted dialogue.

The interesting bit: each agent **loads a Claude Skill at startup** ([`.claude/skills/relai-shielded-send`](../../.claude/skills/relai-shielded-send) and [`.claude/skills/relai-shielded-receive`](../../.claude/skills/relai-shielded-receive)) and runs against the same SKILL.md content a Claude Code user would see — proving the skills are runtime-portable per the [Agent Skills spec](https://agentskills.io/specification).

## What's real

| Layer | Implementation |
|---|---|
| Agent reasoning | `claude-sonnet-4-6` via `@anthropic-ai/sdk`, full tool-use loop, prompt caching on the system prompt (skill body cached as ephemeral) |
| Skill loading | `shared/load-skill.mjs` reads `.claude/skills/<name>/SKILL.md`, strips YAML frontmatter, inlines `references/*.md`, and injects the body into the system prompt — minimal client-implementor pattern from [agentskills.io/client-implementation](https://agentskills.io/client-implementation/adding-skills-support) |
| Tool surface | Same names a Claude Code agent with `plugin-openclaw` installed would see: `relai_shielded_create` (buyer) and `relai_shielded_redeem` (seller). The skill body's tool references resolve correctly |
| Inter-agent comms | Localhost HTTP chat bus (`POST /send`, `GET /poll` long-poll). For production multi-agent inter-process communication, see the [A2A protocol](https://a2aproject.github.io/A2A/) — this demo uses a minimal subset for clarity |
| RelAI calls | Live `POST /v1/shielded-links`, `POST /fund`, `GET /proof-input`, `POST /redeem-intent`, `POST /execute-withdraw` against `RELAI_BASE_URL` (default `https://api.relai.fi`) |
| On-chain deposit | Real `deposit_note` Anchor instruction broadcast to `solana-devnet`, signed by the buyer's keypair |
| ZK proof | Real `snarkjs.groth16.fullProve` against the V4 ASP circuit artefacts the backend advertises |
| On-chain withdraw | Signed and paid by the RelAI pool relayer — the seller never touches Solana directly |

## Privacy invariants the demo enforces

### Buyer wallet keypair never enters the LLM context

The buyer's Solana keypair is loaded **once at process startup** from `RELAI_BUYER_SOLANA_SECRET_KEY`, materialized into a `Keypair` object, and bound into the `relai_shielded_create` tool's closure. The LLM only ever sees and passes `recipientAmountUsdc` — never the private key.

This matches the public-demo guideline that "the signing operation should happen in a small adjacent process/tool that the LLM invokes with a transaction *intent*, never with the key itself" (general OSS LLM-agent best practice).

If you read `lib/create.ts`, you'll see `CreateShieldedLinkInput.buyer` is typed as `Keypair`, not `string` — making it structurally impossible for an LLM tool param to introduce a key.

### Buyer privacy guardrails (system-prompt-level)

The buyer agent's system prompt is structurally prevented from sending any of the following over the chat bus:
- Solana pubkey
- Poseidon commitment
- Nullifier
- Deposit tx hash

The shielded link payload string is the only payment-related thing the seller ever receives. This matches the blog: "*Forty-eight bytes of text. Nothing else.*"

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
#       Get at least 2 USDC (covers ~20 demo runs at 0.1 USDC + 5% fee each).
```

## Run

```bash
npm run demo
```

You'll see two coloured streams interleaved (`[buyer]` cyan, `[seller]` magenta):

1. The buyer pings the seller and asks for a quote.
2. The seller quotes 0.10 USDC for one page.
3. The buyer agrees and announces it's about to send a shielded payment.
4. The buyer calls `relai_shielded_create` — you see the on-chain Solscan link in the local log only.
5. The buyer sends the `relai:shielded:…` payload over the chat bus (one message, nothing else in it).
6. The seller calls `relai_shielded_redeem`. The Groth16 proof generates locally (~2s); the relayer broadcasts the withdraw. The seller log shows the payout Solscan link.
7. The seller delivers the translation. The buyer acks.
8. Both agents print `DEAL COMPLETE:` and stop.

## Verify privacy on-chain

After the demo:

```bash
# The deposit (visible to anyone, but not attributable to the seller)
open "<deposit explorer URL from the buyer log>"

# The withdraw (visible to anyone, but not attributable to the buyer)
open "<payout explorer URL from the seller log>"
```

There is no on-chain transaction with both wallets as inputs/outputs. The buyer's deposit goes to the pool PDA; the pool PDA → seller's wallet is signed by the relayer. The two events sit among hundreds of unrelated pool ops.

## Anatomy

```
shielded-link-demo/
├── package.json              demo deps (anthropic SDK + crypto), no plugin coupling
├── LICENSE                   MIT
├── .env.example              required env vars
├── start-demo.mjs            orchestrator: chat bus + 2 spawned agents
├── shared/
│   ├── agent-loop.mjs        Anthropic tool-use loop, multi-block system, prompt caching
│   ├── chat-bus.mjs          HTTP bulletin board (POST /send, GET /poll)
│   ├── chat-tools.mjs        send_message + wait_for_message tool defs
│   └── load-skill.mjs        SKILL.md loader (Agent Skills spec, minimal client)
├── lib/
│   ├── note.ts               Poseidon commitment + nullifier (BN254 field)
│   ├── payload.ts            encode/parse `relai:shielded:<base64url>`
│   ├── solana-deposit.ts     Anchor `deposit_note` ix builder + signer
│   ├── create.ts             buyer flow (assembles all the above)
│   └── redeem.ts             seller flow (proof-input → groth16 → execute-withdraw)
├── agent-buyer.mjs           buyer persona + relai_shielded_create tool
└── agent-seller.mjs          seller persona + relai_shielded_redeem tool
```

The demo is **standalone** — it does not import from `@relai-fi/plugin-openclaw`. Plugin and demo are independent consumers of the same RelAI HTTP API.

## Why two processes?

The blog says "two agents collaborating remotely". A two-process HTTP demo proves the agents could equally well run on different hosts — the chat bus would just have a public URL. For a real production system, see the [A2A protocol](https://a2aproject.github.io/A2A/) (Linux Foundation, JSON-RPC over HTTPS). This demo intentionally rolls its own minimal bus to keep the runnable code under 200 lines.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Buyer ... has X micro-USDC on devnet; needs at least Y` | Hit the Circle devnet USDC faucet for the buyer pubkey (printed at agent startup). |
| `aspReady: false` repeatedly | The pool's ASP scheduler debounces ~10s after a deposit. The seller agent retries automatically; if it persists for ≥ 60s, the buyer's funding wallet may be on the ASP defer list. |
| One agent crashes early | Run each in its own terminal: `npm run bus`, then `npm run buyer`, then `npm run seller`. Clearer error output. |
| `Missing X-Service-Key` | The relevant `RELAI_SERVICE_KEY_*` env var isn't set or is wrong. Run the `relai-setup` skill to provision a fresh one. |
| Skill-loader can't find `.claude/skills/...` | The demo expects to live at `examples/shielded-link-demo/` relative to the repo root. If you copied it elsewhere, update `skillsRoot` in `agent-{buyer,seller}.mjs`. |

## License

MIT. See `LICENSE`.
