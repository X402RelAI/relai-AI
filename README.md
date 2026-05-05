# relai-ai

Skills, plugin, agents and runnable demos for the [RelAI](https://relai.fi) marketplace — a catalogue of HTTP APIs priced per-call in USDC via the [x402](https://x402.fi) protocol, plus a USDC bridge (Solana ↔ SKALE-Base), the privacy-pool **shielded link** primitive (buyer-initiated unlinkable payments) and the new **Shielded Payment Request (SPR)** primitive (seller-initiated unlinkable payments with an atomic 95/5 fee split).

This repo ships five surfaces:

| Surface | Where | What it gives you |
|---|---|---|
| **Claude Code skills** | `.claude/skills/` | Discover, call, publish, bridge, shielded send/receive, **SPR issue/pay/redeem** — all over plain HTTP. Transport-agnostic (works on Claude Code, Desktop, any tool with HTTP access). |
| **OpenClaw skills** | `openclaw/skills/` | Same workflows, layered on top of the `plugin-openclaw` tools (richer UX, automatic key + agentId management, plugin-handled subdomain routing and zk redeem). |
| **OpenClaw plugin** | `openclaw/plugins/plugin-openclaw/` | TypeScript native plugin (v0.4.0) registering 29 `relai_*` tools: setup (1) · marketplace (3) · management (10) · bridge (2) · shielded (4) · **SPR (9)**. |
| **Reference agent** | `openclaw/agents/Shopping-agent/` | Domain-specific agent (gift-card concierge) demonstrating that the plugin tools are domain-agnostic — the agent personality is pure markdown config, no custom code. |
| **End-to-end demos** | `examples/shielded-link-demo/`, `examples/spr-demo/` | Two Claude-driven Node processes negotiate a translation and settle privately on solana-devnet — live RelAI API, real Solana tx, real Groth16. The shielded-link demo is buyer-initiated; the SPR demo is seller-initiated with the on-chain 95/5 split. Each agent loads its `.claude/skills/` SKILL.md at startup. |

## Install

### Claude Code — from GitHub

```
/plugin marketplace add <github-user>/<repo>
/plugin install relai-skills@relai-ai
```

The plugin marketplace manifest (`.claude-plugin/marketplace.json`) currently exposes the four core HTTP skills: `relai-setup`, `relai-marketplace-buy`, `relai-api-publish`, `relai-bridge-usdc`. The shielded-link and SPR skills (`relai-shielded-send`, `relai-shielded-receive`, `relai-spr-issue`, `relai-spr-pay`, `relai-spr-redeem`) live in `.claude/skills/` and are auto-detected when you open a Claude Code session from this repo — they aren't in the marketplace manifest because they require Node + crypto libraries on the host (see each SKILL.md's "Delegation" section).

### Claude Code — from a local clone

```bash
git clone <repo-url> relai-ai
cd relai-ai
# start a Claude Code session from this directory — done.
```

The skills in `.claude/skills/` (all nine: `relai-setup`, `relai-marketplace-buy`, `relai-api-publish`, `relai-bridge-usdc`, `relai-shielded-send`, `relai-shielded-receive`, `relai-spr-issue`, `relai-spr-pay`, `relai-spr-redeem`) are auto-detected by Claude Code when launched from this directory. No install step needed for project-local use.

For personal install (all projects), symlink them into `~/.claude/skills/`:

```bash
node scripts/install-skills.mjs --claude-global
```

### OpenClaw skills

```bash
node scripts/install-skills.mjs --openclaw
```

Symlinks `openclaw/skills/*` into `~/.openclaw/skills/`. Restart your agent to load them. Eight skills ship: `relai-marketplace-buy`, `relai-api-publish`, `relai-bridge-usdc`, `relai-shielded-inspect` (read-only shielded-link config / status / ASP), `relai-shielded-receive` (full shielded-link seller-side redeem), `relai-spr-inspect` (read-only SPR list / decode / match-status / receipts), `relai-spr-issue` (SPR seller mint), `relai-spr-redeem` (SPR seller redeem with the 95/5 split).

### OpenClaw plugin

The plugin is distributed as a local workspace, not yet on npm.

```bash
cd openclaw/plugins/plugin-openclaw
npm install
# Consumed directly from TypeScript sources by OpenClaw — no build step.
```

Register it in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "plugin-openclaw": {
        "enabled": true,
        "path": "/absolute/path/to/openclaw/plugins/plugin-openclaw",
        "config": {
          "baseUrl": "https://api.relai.fi",
          "x402Domain": "x402.fi",
          "requestTimeoutMs": 15000
        }
      }
    }
  }
}
```

### Run the shielded-link demo (buyer-initiated)

```bash
cd examples/shielded-link-demo
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, two RELAI_SERVICE_KEY_*, buyer Solana keypair, seller pubkey
npm run demo
```

Two agents negotiate a one-page JP→PL translation, the buyer pays 0.10 USDC privately via a shielded link, the seller redeems with zero gas (the pool relayer signs), translation is delivered. Full breakdown in [`examples/shielded-link-demo/README.md`](examples/shielded-link-demo/README.md).

### Run the SPR demo (seller-initiated, on-chain 95/5 split)

```bash
cd examples/spr-demo
npm install
cp .env.example .env   # same env vars as shielded-link, plus CHAT_BUS_PORT=4748 to run side-by-side
npm run demo
```

Same two agents, opposite direction: the **seller** issues a `relai:quote:<base64url>` payload, the **buyer** pays it anonymously through Privacy Pool V4.1 (Groth16 pairing proof, operator-relayed match), and the seller redeems with a separate Groth16 proof — the operator atomically splits 95% to the seller and 5% to itself in `payout_to_seller`. Full breakdown in [`examples/spr-demo/README.md`](examples/spr-demo/README.md). **Testnet only at this stage** — SPR is `solana-devnet` / `base-sepolia` / `skale-base-sepolia`; mainnet ships after a multi-party trusted-setup ceremony.

## Uninstall

```bash
node scripts/install-skills.mjs --uninstall
```

## Repo layout

```
relai-ai/
├── .claude-plugin/
│   └── marketplace.json           # Claude Code plugin marketplace manifest (4 core skills)
├── .claude/skills/                # Claude Code skills (HTTP, transport-agnostic)
│   ├── relai-setup/               #   provision a service key via the consent flow (consent.mjs)
│   ├── relai-marketplace-buy/     #   discover + call paid APIs
│   ├── relai-api-publish/         #   publish and monitor your own APIs (Management API)
│   ├── relai-bridge-usdc/         #   bridge quotes + liquidity (public, no auth)
│   ├── relai-shielded-send/       #   buyer-side: create + fund a shielded link, emit payload
│   ├── relai-shielded-receive/    #   seller-side: parse payload, generate Groth16, redeem
│   ├── relai-spr-issue/           #   SPR seller-side: mint a `relai:quote:…` payload
│   ├── relai-spr-pay/             #   SPR buyer-side: deposit + pair against a quote
│   └── relai-spr-redeem/          #   SPR seller-side: redeem after pairing (95/5 split)
├── openclaw/
│   ├── skills/                    # OpenClaw skills (built on plugin-openclaw tools)
│   │   ├── relai-marketplace-buy/
│   │   ├── relai-api-publish/
│   │   ├── relai-bridge-usdc/
│   │   ├── relai-shielded-inspect/  # read-only shielded-link: config, status, ASP
│   │   ├── relai-shielded-receive/  # full shielded-link seller redeem
│   │   ├── relai-spr-inspect/       # read-only SPR: list, get, decode, match-status, receipts
│   │   ├── relai-spr-issue/         # SPR seller mint via relai_spr_issue
│   │   └── relai-spr-redeem/        # SPR seller redeem via relai_spr_redeem
│   ├── plugins/plugin-openclaw/   # TypeScript native plugin (25 tools, v0.4.0)
│   │   ├── src/
│   │   │   ├── api.ts              #  marketplace + consent + metered call (subdomain routing + relay fallback)
│   │   │   ├── management.ts       #  Management API + bridge + shielded + SPR HTTP client
│   │   │   ├── config.ts
│   │   │   ├── store.ts            #  ~/.openclaw/relai/agent-keys.json (0600), per-agent EVM pairing keypair
│   │   │   ├── shielded/           #  payload parse, Poseidon nullifier, Groth16 redeem helper (shielded link)
│   │   │   ├── spr/                #  payload parse + Groth16 redeem helper (SPR)
│   │   │   └── tools/              #  tool definitions: setup, marketplace, management, bridge, shielded, spr
│   │   ├── index.ts
│   │   └── openclaw.plugin.json
│   └── agents/
│       └── Shopping-agent/         # reference agent (markdown-only config; consumes plugin tools)
├── examples/
│   ├── shielded-link-demo/         # buyer-initiated private payment (solana-devnet, live API, real tx, real zk)
│   └── spr-demo/                   # seller-initiated private payment with 95/5 fee split (testnet)
└── scripts/
    └── install-skills.mjs          # cross-platform installer (symlinks, junctions on Windows, copy fallback)
```

## How it works

### Skills

Each skill is a folder with a `SKILL.md` (YAML frontmatter `name` + `description` + optional `metadata`). Claude Code or OpenClaw loads it when a user request matches the description. Supporting files (`references/*.md`, `scripts/*.mjs`) are referenced from SKILL.md and loaded on demand. See the [Agent Skills spec](https://agentskills.io).

### Plugin vs Claude skills — same backend, different layers

- **Claude skills** describe the REST contract and tell the agent to make HTTP calls directly (`WebFetch`, `curl` via Bash, fetch MCP, code execution — whatever's available). No runtime dependency beyond `relai-setup`'s one-shot Node script.
- **OpenClaw skills** wrap the plugin's pre-built tools (`relai_setup`, `relai_call`, `relai_mgmt_*`, `relai_bridge_*`, `relai_shielded_*`). More ergonomic, OpenClaw-specific.

Both hit the same backend (`api.relai.fi`). The shielded-link demo proves the SKILL.md content is enough on its own — its agents load the same `.claude/skills/relai-shielded-{send,receive}/SKILL.md` files at startup, no plugin dependency.

### URL routing for paid calls

Paid calls route to `https://{subdomain}.x402.fi{path}` when the API record has a `subdomain`, falling back to `{baseUrl}/relay/{apiId}{path}` on 5xx or transport errors (4xx is authoritative — no retry). The plugin handles this automatically; Claude skills implement the fallback manually (documented in each SKILL.md).

### Authentication

All paid + management calls require a service key (`sk-agent-...` or `sk_live_...`) in the `X-Service-Key` header. The plugin additionally sends `X-Agent-ID` on every metered call so APIs can distinguish agents behind the same key.

Two ways to provision a key:

1. **OpenClaw**: `relai_setup` tool — generates a local EVM pairing keypair, opens a browser consent URL, polls until approved, signs the retrieve nonce (EIP-191), persists the result in `~/.openclaw/relai/agent-keys.json` (0600). Per-agent storage keyed on `ctx.agentId`.
2. **Claude**: the `relai-setup` skill invokes `scripts/consent.mjs` (Node ≥ 18). Same flow, persists the key in `~/.relai/service-key.json` (0600). Downstream skills resolve in this order: `RELAI_SERVICE_KEY` env → that file → user-referenced file → ask the user.

A single service key works on **all supported chains** — the EVM pairing keypair is only used once to sign the consent retrieve nonce; the issued service key is chain-agnostic.

### Shielded links — privacy pool primitive (buyer-initiated)

Buyer deposits USDC into the pool under a Poseidon commitment they alone know. Seller redeems by generating a Groth16 ASP proof (V4 circuit, BN254). The on-chain deposit and withdraw events are not linkable.

Split between buyer-side and seller-side because of asymmetric requirements:

- **Buyer-side** (`relai-shielded-send` / `lib/create.ts` in the demo) — needs a Solana keypair to sign `deposit_note` on-chain. **Not** in the OpenClaw plugin (incompatible with the "no private keys in tool params" convention). The Claude skill is a protocol guide; the demo provides a working executor where the keypair is bound by closure outside the LLM context.
- **Seller-side** (`relai-shielded-receive` / `relai_shielded_redeem` plugin tool / `lib/redeem.ts` in the demo) — service-key-only; the pool relayer signs and pays the on-chain withdraw. The plugin ships the full flow: parse payload → `proof-input` → nullifier → `redeem-intent` → `snarkjs.groth16.fullProve` → `execute-withdraw`.

Known prod gotcha (documented across the relevant SKILL.md files and plugin code): the `/v1/shielded-links/...` proxy is broken for Solana. Hit `/facilitator/solana-payment-codes/...` (and `/facilitator/payment-codes/shielded-links/config?network=` for the dispatcher route) directly.

### Shielded Payment Requests (SPR) — reverse direction, on-chain fee split

The seller-initiated companion to shielded links. Where shielded links push privacy from the buyer's side, SPR pulls it from the seller's: the seller mints an opaque `relai:quote:<base64url>` payload (a "private invoice"), the buyer pays anonymously through Privacy Pool V4.1, and the seller redeems with a separate Groth16 proof. **Two ZK proofs total** instead of one — buyer pairing proof + seller redeem proof.

Distinguishing features vs shielded links:

- **Direction inverted**: seller initiates with `POST /v1/shielded-payment-requests` + `/issue`; the bearer payload is the quote.
- **On-chain registries**: `QuoteRegistry` (off-chain root with on-chain anchor), `PaymentMatchRegistry` (buyer pairings), and the same `ShieldedPoolV41` for buyer commitments.
- **Atomic 95/5 fee split**: the operator's `payout_to_seller` instruction transfers 95% of `quote.amount` to the seller and 5% to the operator in the same on-chain tx. No off-chain accounting fee.
- **Operator-relayed everywhere on Solana**: the operator signs both `verify_and_record` (pairing) and `payout_to_seller` (redeem). The seller never holds gas; the buyer signs only the SPL deposit.
- **Optional sealed proof bundles** (Solana): when issuing, the seller can pass `sellerEncPk` (X25519 base64url pubkey) so the buyer's pairing proof is sealed for the seller's key — useful for receipt UIs that verify locally.
- **Testnet only** for now: `solana-devnet`, `base-sepolia`, `skale-base-sepolia`. Mainnet ships after a multi-party trusted-setup ceremony for the redeem zkey.

Surface split:

- **Seller-side issue** (`relai-spr-issue` Claude skill, `relai_spr_issue` plugin tool) — service-key-only, two HTTP calls (`POST /…` + `POST /…/issue`), returns the bearer payload.
- **Seller-side redeem** (`relai-spr-redeem` Claude skill, `relai_spr_redeem` plugin tool, `lib/redeem.ts` in the demo) — service-key-authed `proof-input` + local Groth16 + public `solana-redeem-relay`. Same convention as shielded-link redeem: 95% lands in the seller pubkey, 5% goes to the operator, atomically.
- **Buyer-side pay** (`relai-spr-pay` Claude skill, `lib/pair.ts` in the demo) — needs a Solana keypair (signs the deposit). **Not** in the OpenClaw plugin (same convention as shielded-link's buyer-side flow). The Claude skill is a protocol guide; the demo provides a working executor.
- **Read-only inspection** (`relai-spr-inspect` OpenClaw skill, `relai_spr_status` / `_list` / `_get` / `_decode` / `_seller_receipt` / `_buyer_receipt` plugin tools) — public match-status + opaque-ID receipts.

## Development

### Plugin

```bash
cd openclaw/plugins/plugin-openclaw
npm install
# OpenClaw consumes index.ts directly — no build step needed.
```

Tools are grouped by domain in `src/tools/index.ts`: `setup`, `marketplace`, `management`, `bridge`, `shielded`, `spr`.

### Testing skills

1. Install via `node scripts/install-skills.mjs` (idempotent).
2. Claude Code: start a new session from this repo and type `/` to list available skills, or trigger by phrase (e.g. *"find an API on RelAI"*, *"redeem this shielded link"*).
3. OpenClaw: restart your agent. Skills are watched from `~/.openclaw/skills/`.

### Adding a skill

- **Claude**: create `.claude/skills/<name>/SKILL.md` with `name` + `description` frontmatter. Auto-detected immediately (live reload in session). To expose it via the plugin marketplace, add it to `.claude-plugin/marketplace.json`.
- **OpenClaw**: create `openclaw/skills/<name>/SKILL.md` with the same frontmatter + `metadata: {"openclaw":{"requires":{"plugins":["plugin-openclaw"]}}}` if it depends on the plugin. Re-run `node scripts/install-skills.mjs --openclaw`.
- Keep SKILL.md under 500 lines; split reference material into `references/<topic>.md` and link from SKILL.md (the harness loads references on demand).

## License

MIT.
