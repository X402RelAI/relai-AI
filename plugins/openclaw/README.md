# @relai-fi/plugin-openclaw

OpenClaw plugin for the [RelAI](https://relai.fi) marketplace. Browse, discover, and call paid APIs with automatic x402 micropayments — supporting both EVM and Solana chains.

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
      "relai": {
        enabled: true,
        config: {
          baseUrl: "https://api.relai.fi",   // RelAI platform URL
          requestTimeoutMs: 15000,            // HTTP timeout (default: 15000)
          chainType: "evm"                    // "evm" or "solana" (default: "evm")
        }
      }
    }
  }
}
```

All config fields are optional and have sensible defaults.

## Tools

The plugin registers 4 tools:

### `relai_setup`

Set up an agent key for this agent. Generates a local keypair (EVM or Solana), opens a consent URL in the browser, and polls for approval automatically.

```
> Set up my RelAI agent key
```

Parameters:
- `agentName` — Human-readable name shown in consent UI
- `chainType` — `"evm"` or `"solana"` (defaults to plugin config)
- `contractAddress` — ERC-721 agent NFT contract address (optional)
- `nftTokenId` — Agent NFT token ID (optional)
- `network` — Network name, e.g. `"skale-base"` (optional)

### `relai_discover`

List available paid APIs on the RelAI marketplace.

```
> What APIs are available on RelAI?
```

Parameters:
- `network` — Filter by supported network (optional)

### `relai_api_info`

Get details and endpoint pricing for a specific API.

```
> Show me the endpoints and pricing for the nshield API
```

Parameters:
- `apiId` — API identifier (e.g. `"nshield"`)

### `relai_call`

Call a paid API endpoint. Payment is handled automatically via the service key.

```
> Call the nshield API endpoint /v1/health
```

Parameters:
- `apiId` — API identifier
- `endpointPath` — Endpoint path (e.g. `"/v1/health"`)
- `method` — HTTP method (default: `GET`)
- `body` — JSON request body for POST/PUT requests (optional)

## How it works

1. **Setup** — `relai_setup` generates a local keypair and initiates a consent flow with the RelAI platform. The user approves in their browser, and a service key is issued and stored locally in `~/.openclaw/relai/agent-keys.json`.

2. **Discovery** — `relai_discover` and `relai_api_info` query the RelAI marketplace to find APIs and their pricing.

3. **Calling** — `relai_call` proxies requests through the RelAI relay with automatic x402 payment using the stored service key. The service key works across all chains.

## Data storage

Agent keys are stored in `~/.openclaw/relai/agent-keys.json` with restricted file permissions (`0600`). Override the storage directory with the `RELAI_STORE_DIR` environment variable.

## License

MIT
