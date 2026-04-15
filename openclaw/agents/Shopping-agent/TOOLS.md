# Tools — Local Notes

## RelAI Marketplace Plugin (`plugin-openclaw`)

Four generic tools for any paid API on the RelAI marketplace. The plugin is domain-agnostic — this agent adapts them to gift-card shopping.

### `relai_setup`
Generate a wallet keypair and obtain a service key via the browser consent flow.
Run once per agent. The returned service key works on all chains.

### `relai_discover`
List available APIs on the marketplace. Returns `{ apiId, name, description, supportedNetworks }`.
Optional filter: `network` (e.g. `"solana"`, `"base"`).
For this agent, all gift-card providers have IDs ending in `-store`.

### `relai_api_info`
Inspect a specific API. Pass `apiId`. Returns:
- `details.api` — full record: enabled endpoints (method, path, `usdPrice`), description, network, `subdomain` (drives call routing), raw `openApiJson`.
- `details.enums` — map `<fieldName> → string[]` for every request-body field constrained by an enum. Generic: applies to `country_code`, `currency`, `tier`, anything.
- Text output lists each request-body field with its type and, for enums, `(allowed: v1, v2, ...)` inline.

For gift-card stores specifically, `details.enums.country_code` gives the list of allowed countries.

### `relai_call`
Execute a paid call. All of `apiId`, `endpointPath`, `method` are **required** — there is no inference. `body` is a JSON string; omit for `GET`/`HEAD` or when the endpoint has no body schema.

**Routing (automatic)** — the plugin reads the `subdomain` property from the API record and routes to `https://{subdomain}.{x402Domain}{endpointPath}` when set, falling back to `{baseUrl}/relay/{apiId}{endpointPath}` on network failure or 5xx. No agent action needed.

For gift-card stores, the call shape is:
- `method`: `"POST"`
- `endpointPath`: pattern `/store/buy/{brand}-{amount}` (e.g. `/store/buy/amazon-25`) — get exact paths from `relai_api_info`
- `body`: JSON string with `recipient_email` and `country_code` (check `details.enums.country_code` for valid values)

The response is passed through verbatim from the upstream provider — format varies (redemption code, link, JSON with delivery details, or `PENDING` status).

## Defaults

- Base URL: `https://api.relai.fi`
- x402 domain: `x402.fi` (used for subdomain-routed calls)
- Timeout: 15000ms
- Chain type: `solana`
- Payment: USDC via x402 protocol (automatic)

## Store quick reference

48 stores across these categories:
- **Fashion**: Adidas, H&M, ASOS, Gap, Banana Republic, Abercrombie & Fitch, American Eagle, Athleta, Chico's, Columbia, JCPenney, Belk
- **Beauty**: Sephora, Bath & Body Works
- **Food delivery**: DoorDash, GrubHub, Instacart
- **Dining**: Applebee's, Buffalo Wild Wings, California Pizza Kitchen, BJ's, Dunkin'
- **Gaming**: GameStop, EA Play, EA Apex, EA Access, Free Fire
- **Digital**: Netflix, App Store & iTunes, Google Play, Paramount+, Fandango
- **Shopping**: Amazon, eBay, Etsy, Walmart, Groupon, HomeGoods, Crate & Barrel, Barnes & Noble
- **Travel**: Airbnb, Delta, Celebrity Cruises, Airalo
- **Auto**: AutoZone, Advance Auto Parts
- **Other**: Guitar Center, Dick's Sporting Goods

Most stores offer $10, $25, $50, $100 denominations. Some vary (Dunkin' starts at $3, Airalo at $5, Netflix at $20).
