# relai-ai

Skills, plugin and agents for the [RelAI](https://relai.fi) marketplace — a catalogue of HTTP APIs priced per-call in USDC via the x402 protocol.

This repo ships three surfaces:

| Surface | Consumes | What it gives you |
|---|---|---|
| **Claude Code skills** | `.claude/skills/` | Discover, call, publish, and bridge — all over plain HTTP. Portable (works on Claude Code, Desktop, any tool with HTTP access). |
| **OpenClaw skills** | `openclaw/skills/` | Same workflows, but built on top of the `plugin-openclaw` tools (richer UX, automatic key management). |
| **OpenClaw plugin** | `openclaw/plugins/plugin-openclaw/` | TypeScript plugin exposing `relai_*` tools: setup, discover, api_info, call, management, bridge. |

A reference `Shopping-agent` (`openclaw/agents/Shopping-agent/`) demonstrates domain-specific use of the plugin — buying gift cards.

## Install

### Claude Code — from GitHub (recommended)

Once this repo is public:

```
/plugin marketplace add <github-user>/<repo>
/plugin install relai-skills@relai-ai
```

All four Claude skills become available automatically: `relai-setup`, `relai-marketplace-buy`, `relai-api-publish`, `relai-bridge-usdc`.

### Claude Code — from a local clone

```bash
git clone <repo-url> relai-ai
cd relai-ai
# start a Claude Code session from this directory — done.
```

The skills live in `.claude/skills/` at the project root and are auto-detected by Claude Code. No install step needed for project-local use.

For personal install (all projects), symlink them into `~/.claude/skills/`:

```bash
node scripts/install-skills.mjs --claude-global
```

### OpenClaw skills

```bash
node scripts/install-skills.mjs --openclaw
```

Symlinks into `~/.openclaw/skills/`. Restart your agent for the skills to load.

### OpenClaw plugin

The plugin is distributed as a local workspace, not yet published to npm.

```bash
cd openclaw/plugins/plugin-openclaw
npm install
```

Then register it in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "plugin-openclaw": {
        "enabled": true,
        "path": "/absolute/path/to/openclaw/plugins/plugin-openclaw",
        "config": {
          "baseUrl": "https://api.relai.fi",
          "x402Domain": "x402.fi"
        }
      }
    }
  }
}
```

## Uninstall

```bash
node scripts/install-skills.mjs --uninstall
```

## Repo layout

```
relai-ai/
├── .claude-plugin/
│   └── marketplace.json           # Claude Code plugin marketplace manifest
├── .claude/skills/                # Claude Code skills (HTTP, transport-agnostic)
│   ├── relai-setup/               #   provisions a service key via consent flow
│   ├── relai-marketplace-buy/     #   discover + call paid APIs
│   ├── relai-api-publish/         #   publish and monitor your own APIs
│   └── relai-bridge-usdc/         #   bridge quotes + liquidity
├── openclaw/
│   ├── skills/                    # OpenClaw skills (built on plugin-openclaw)
│   │   ├── relai-marketplace-buy/
│   │   ├── relai-api-publish/
│   │   └── relai-bridge-usdc/
│   ├── plugins/plugin-openclaw/   # TypeScript plugin
│   │   ├── src/
│   │   │   ├── api.ts             #   marketplace + consent + metered call
│   │   │   ├── management.ts      #   Management API client
│   │   │   ├── config.ts
│   │   │   ├── store.ts           #   local keypair / service key store
│   │   │   └── tools/             #   tool definitions (setup, marketplace, management, bridge)
│   │   └── openclaw.plugin.json
│   └── agents/
│       └── Shopping-agent/        # reference agent: gift-card shopping
└── scripts/
    └── install-skills.mjs         # cross-platform installer
```

## How it works

### Skills

Skills are folders containing a `SKILL.md` with YAML frontmatter describing when to use them. Claude (or OpenClaw) loads the skill automatically when a user request matches its `description`. Supporting files (`references/`, `scripts/`) are loaded on demand. See the [Agent Skills spec](https://agentskills.io).

### Plugin vs Claude skills — same workflows, different layers

- The **Claude skills** describe the REST contract and instruct the agent to make HTTP calls directly. No runtime dependency.
- The **OpenClaw skills** rely on the plugin's pre-built tools (`relai_setup`, `relai_call`, `relai_mgmt_*`, `relai_bridge_*`). More ergonomic, but OpenClaw-specific.

Both operate against the same backend (`api.relai.fi`).

### URL routing for paid calls

Paid calls route to `https://{subdomain}.x402.fi{path}` when the API record has a `subdomain`, falling back to `{baseUrl}/relay/{apiId}{path}` on 5xx or transport errors. This is handled automatically by the plugin; Claude skills must implement the fallback manually (documented in each skill).

### Authentication

All paid calls require a `sk_live_...` service key in the `X-Service-Key` header. Two ways to obtain one:

1. **OpenClaw**: `relai_setup` tool — generates a local keypair, opens a browser consent URL, retrieves the signed key. Key is stored in `~/.openclaw/relai/agent-keys.json`.
2. **Claude**: the `relai-setup` skill runs `scripts/consent.mjs` (Node ≥ 18) to do the same flow. The key is printed for the user to store as `RELAI_SERVICE_KEY`.

A single service key works on all supported chains.

## Development

### Plugin

```bash
cd openclaw/plugins/plugin-openclaw
npm install
# The plugin is consumed by OpenClaw directly from TypeScript sources — no build step needed.
```

### Testing skills

1. Install via `node scripts/install-skills.mjs` (idempotent).
2. Claude Code: start a new session, type `/` to list available skills. Test a natural trigger (e.g. *"find an API on RelAI"*).
3. OpenClaw: restart your agent. Skills are watched from `~/.openclaw/skills/`.

### Adding a skill

- Claude: create `.claude/skills/<name>/SKILL.md` with `name` + `description` frontmatter. Auto-detected immediately (live reload in session).
- OpenClaw: create `openclaw/skills/<name>/SKILL.md`, then re-run `node scripts/install-skills.mjs --openclaw`.
- Keep SKILL.md under 500 lines; split reference material into `references/<topic>.md` and link from SKILL.md.

## License

MIT.
