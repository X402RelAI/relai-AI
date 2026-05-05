# @relai-fi/plugin-openclaw

OpenClaw plugin (v0.4.0) for the [RelAI](https://relai.fi) marketplace. Browse, discover, and call paid APIs with automatic x402 micropayments (EVM + Solana), publish and monitor your own monetised APIs, quote the USDC bridge (Solana ↔ SKALE-Base), redeem **shielded payment links** seller-side without holding gas, and run the full **Shielded Payment Request (SPR)** seller flow with on-chain 95/5 fee split (testnet only).

## Installation

```bash
openclaw plugins install @relai-fi/plugin-openclaw
```

For local development:

```bash
openclaw plugins install -l ./plugins/openclaw
```

## Configuration

In your OpenClaw gateway config:

```json5
{
  plugins: {
    entries: {
      "plugin-openclaw": {
        enabled: true,
        config: {
          baseUrl: "https://api.relai.fi",   // RelAI platform URL
          x402Domain: "x402.fi",              // Subdomain root for paid-call routing
          requestTimeoutMs: 15000             // HTTP timeout (default: 15000)
        }
      }
    }
  }
}
```

All config fields are optional and have sensible defaults.

## Tools

The plugin registers **29 tools** grouped by domain. Tool wiring lives in [`src/tools/index.ts`](./src/tools/index.ts); JSON schemas are colocated with each `create*Tool` factory.

### Setup (1)

| Tool | What it does |
|---|---|
| `relai_setup` | Generate a local EVM pairing keypair, open the consent URL, poll until approved, sign the retrieve nonce (EIP-191), persist the service key in `~/.openclaw/relai/agent-keys.json` (0600). One-shot per agent; the issued key is chain-agnostic. |

### Marketplace — consume paid APIs (3)

| Tool | What it does |
|---|---|
| `relai_discover` | List available APIs (optional `network` filter). |
| `relai_api_info` | Get an API record + endpoint pricing by `apiId`. |
| `relai_call` | Call a paid endpoint. Routes to `https://{subdomain}.x402.fi{path}` when set, falls back to `{baseUrl}/relay/{apiId}{path}` on 5xx/transport errors. Sends `X-Service-Key` + `X-Agent-ID` automatically. |

### Management — publish + monitor your own APIs (10)

`relai_mgmt_create_api`, `relai_mgmt_list_apis`, `relai_mgmt_get_api`, `relai_mgmt_update_api`, `relai_mgmt_delete_api`, `relai_mgmt_get_pricing`, `relai_mgmt_set_pricing` (per-endpoint USDC pricing), `relai_mgmt_stats`, `relai_mgmt_payments`, `relai_mgmt_logs`.

### Bridge (2)

`relai_bridge_quote`, `relai_bridge_balances`. Public, no auth — quotes for moving USDC between Solana and SKALE-Base, plus per-chain liquidity snapshots.

### Shielded payment links (4) — privacy pool, buyer-initiated

| Tool | What it does |
|---|---|
| `relai_shielded_config` | Read pool + ASP config for the active network. |
| `relai_shielded_status` | Status of a specific shielded link. |
| `relai_shielded_asp_status` | ASP scheduler snapshot. |
| `relai_shielded_redeem` | Seller-side redeem: parse payload → fetch `proof-input` → Poseidon nullifier → `snarkjs.groth16.fullProve` → `execute-withdraw`. The pool relayer signs and pays gas — the seller never holds SOL. |

> Buyer-side `create + fund + emit` is **not** in the plugin (requires a Solana keypair to sign `deposit_note` on-chain, which conflicts with the "no private keys in tool params" convention). Use the `relai-shielded-send` Claude skill or the [shielded-link-demo](../../../examples/shielded-link-demo/).

### Shielded Payment Requests (SPR) — privacy pool, seller-initiated, on-chain 95/5 split (9)

Testnet only (`solana-devnet` / `base-sepolia` / `skale-base-sepolia`). Mainnet ships after a multi-party trusted-setup ceremony for the redeem zkey.

| Tool | What it does |
|---|---|
| `relai_spr_issue` | Mint a `relai:quote:<base64url>` bearer payload (draft → issue). Seller-side, service-key-authed. |
| `relai_spr_cancel` | Cancel an unpaired quote you issued. |
| `relai_spr_list` | List quotes you issued (with status filter). |
| `relai_spr_get` | Get one quote by id. |
| `relai_spr_status` | Match status (`pending` / `paid` / `expired`). |
| `relai_spr_redeem` | Seller-side redeem after pairing: `proof-input` → Groth16 → `solana-redeem-relay`. Operator atomically transfers 95% to the seller pubkey + 5% to itself in `payout_to_seller`. Seller pays no gas. |
| `relai_spr_seller_receipt` | Opaque seller-side receipt by quote id. |
| `relai_spr_buyer_receipt` | Opaque buyer-side receipt (public). |
| `relai_spr_decode` | Decode a `relai:quote:…` payload locally without hitting the network. |

> Buyer-side `pay` (deposit + Groth16 pairing proof) is **not** in the plugin (same Solana-keypair convention as buyer-side shielded-link). Use the `relai-spr-pay` Claude skill or the [spr-demo](../../../examples/spr-demo/).

## Example prompts

### 1. Setup the agent wallet

```
> Set up my RelAI agent key on Solana
```

The agent will generate a keypair and return a consent link. Open it in your browser, approve, then say:

```
> Check if my RelAI setup is complete
```

### 2. Discover available APIs

```
> What paid APIs are available on RelAI?
> Show me APIs available on the Solana network
```

### 3. Get API details and pricing

```
> How much does the nshield API cost per call?
> Show me all endpoints for the nshield API
```

### 4. Call a paid API

```
> Use the nshield API to check /v1/health
> Call the nshield API endpoint /v1/scan with POST body {"url": "https://example.com"}
```

### 5. Full workflow

```
> Set up RelAI, find an API that does security scanning, and run a health check on it
```

## How it works

1. **Setup** — `relai_setup` generates a local EVM pairing keypair and starts the consent flow. The user approves in their browser, the plugin signs the retrieve nonce (EIP-191), and the issued service key is persisted in `~/.openclaw/relai/agent-keys.json` (0600). The pairing key is only used once; the service key is chain-agnostic.

2. **Discovery** — `relai_discover` + `relai_api_info` query the RelAI marketplace catalog.

3. **Metered calls** — `relai_call` routes paid requests through `{subdomain}.x402.fi` when set (with relay fallback on 5xx) and sends `X-Service-Key` + `X-Agent-ID` automatically.

4. **Provider tools** — the `relai_mgmt_*` family wraps the Management API for publishing endpoints, setting per-endpoint USDC pricing, and pulling stats / payments / logs.

5. **Shielded payment links** — `relai_shielded_redeem` parses the `relai:shielded:…` payload, fetches the proof input, computes the Poseidon nullifier, runs Groth16 locally (`snarkjs.groth16.fullProve` against the V4 BN254 circuit), and posts to `execute-withdraw`. The pool relayer signs the on-chain withdraw — sellers never hold gas.

6. **Shielded Payment Requests (SPR)** — `relai_spr_issue` mints a `relai:quote:<base64url>` bearer payload, the buyer pays anonymously through Privacy Pool V4.1 (out-of-plugin), and `relai_spr_redeem` finishes the seller side: `proof-input` → local Groth16 → `solana-redeem-relay`. The operator broadcasts `payout_to_seller`, splitting 95% to the seller and 5% to itself atomically on-chain.

## Data storage

Agent keys are stored in `~/.openclaw/relai/agent-keys.json` with restricted file permissions (`0600`). Override the storage directory with the `RELAI_STORE_DIR` environment variable.

## License

MIT
