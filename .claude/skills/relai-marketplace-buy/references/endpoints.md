# RelAI marketplace — endpoint reference

All paths are relative to `RELAI_API_URL` (default `https://api.relai.fi`).

## `GET /marketplace`

List all public APIs.

**Response** — `200 OK`:

```json
[
  {
    "apiId": "example-api",
    "name": "Example API",
    "description": "Short description",
    "supportedNetworks": ["solana", "base"],
    "zAuthEnabled": false
  }
]
```

Always filter out entries where `zAuthEnabled` is `true` — they need a separate auth flow.

## `GET /marketplace/{apiId}`

Full API record, including endpoint list and OpenAPI schema.

**Response** — `200 OK`:

```json
{
  "apiId": "example-api",
  "name": "Example API",
  "description": "...",
  "network": "solana",
  "subdomain": "example",
  "zAuthEnabled": false,
  "endpoints": [
    {
      "path": "/v1/resource",
      "method": "post",
      "summary": "...",
      "description": "...",
      "usdPrice": 0.05,
      "enabled": true
    }
  ],
  "openApiJson": { "paths": { "...": { "...": { "...": "..." } } } }
}
```

`subdomain` may be `null` or absent. When a non-empty string, paid calls go to `https://{subdomain}.{x402Domain}{endpointPath}` with a fallback to the relay URL on 5xx / transport errors.

Filter `endpoints[]` to `enabled == true`. Parse the request schema at:

```
openApiJson.paths[<path>][<method>].requestBody.content[<mediaType>].schema
```

Prefer `application/json`; fall back to the first media type if absent.

**404** — unknown `apiId`. Ask the user to re-run discover.

## Metered call — URL resolution

Two possible URLs, picked from the `subdomain` field of the API record:

1. **Primary** (when `subdomain` is a non-empty string):
   `{method} https://{subdomain}.{x402Domain}{endpointPath}`
2. **Fallback** (always available):
   `{method} {RELAI_API_URL}/relay/{apiId}{endpointPath}`

Retry on the fallback when the primary returns `5xx` or fails at transport (DNS, timeout, reset). Never fall back on `4xx` — those are authoritative from the primary.

**Required headers**:
- `X-Service-Key: sk_live_...`
- `Content-Type: application/json` (when sending a body)
- `Accept: application/json`

**Method**: must match the endpoint's declared method. Do not override.

**Body**: JSON built from the schema. Omit for methods with no body.

**Response**: whatever the upstream returns, with added payment-settlement metadata in RelAI's own error cases.

**Status codes**:
- `2xx` — upstream succeeded; payment settled.
- `400` — usually a body validation error. Re-check required fields.
- `401` — bad or missing service key.
- `402` — payment failed. Do not retry blindly.
- `404` — unknown API or endpoint path.
- `5xx` — upstream or facilitator error. Payment may or may not have settled; investigate before retrying.

## Agent identification (optional)

Some APIs look at an `X-Agent-ID` header to distinguish agents behind the same key. Include it when you have a stable agent identifier, omit otherwise.
