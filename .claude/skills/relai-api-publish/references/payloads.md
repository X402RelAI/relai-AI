# RelAI Management API — payloads

All paths are relative to `RELAI_API_URL` (default `https://api.relai.fi`). Authenticated requests require `X-Service-Key: sk_live_...`.

## `POST /v1/apis` — create

**Request body**:

```json
{
  "name": "My ML API",
  "baseUrl": "https://inference.example.com",
  "merchantWallet": "0xabc...",
  "network": "base",
  "facilitator": "payai",
  "x402Version": 2,
  "description": "optional",
  "websiteUrl": "optional",
  "logoUrl": "optional",
  "solanaWallet": "optional — for EVM-network APIs accepting Solana payments",
  "evmCrossChainWallet": "optional — for Solana-network APIs accepting EVM payments",
  "endpoints": [
    {
      "path": "/v1/predict",
      "method": "post",
      "usdPrice": 0.05,
      "enabled": true,
      "description": "Run inference on a user prompt",
      "requestBody": {
        "required": ["prompt"],
        "properties": {
          "prompt": { "type": "string" },
          "temperature": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    }
  ]
}
```

### Endpoint schemas (recommended)

Provide schema info so the marketplace test form can render query fields or body inputs. Three options — any one is enough:

**Per-endpoint `parameters`** (query / path / header):

```json
{
  "path": "/v1/search",
  "method": "get",
  "usdPrice": 0.01,
  "parameters": [
    { "name": "q", "in": "query", "required": true, "description": "Search query" },
    { "name": "limit", "in": "query", "schema": { "type": "integer" } }
  ]
}
```

- `in` — one of `query`, `path`, `header`. Path params can also be declared via `{placeholder}` in `path`.
- Path params are forced to `required: true` server-side (OpenAPI rule).

**Per-endpoint `requestBody`** — accepts either the simplified JSON Schema shape:

```json
"requestBody": {
  "required": ["prompt"],
  "properties": {
    "prompt": { "type": "string" }
  }
}
```

or the full OpenAPI shape:

```json
"requestBody": {
  "required": true,
  "content": {
    "application/json": {
      "schema": {
        "required": ["prompt"],
        "properties": { "prompt": { "type": "string" } }
      }
    }
  }
}
```

The server normalises both to a valid OpenAPI 3.x Request Body Object before persisting.

**Top-level `openApi`** — pass a full OpenAPI 3.x document instead (object or JSON string):

```json
{
  "name": "My ML API",
  "baseUrl": "https://inference.example.com",
  "merchantWallet": "0xabc...",
  "network": "base",
  "openApi": { "openapi": "3.0.0", "info": {...}, "paths": {...} }
}
```

If `endpoints` is omitted, endpoints are auto-derived from the spec's `paths` with a default price of `$0.01`. Override later via `PUT /v1/apis/{apiId}/pricing`.

### Facilitator & x402Version (optional)

- `facilitator` — one of `payai`, `dexter`, `openfacilitator`, `relai`, `autoincentive`, `stratum`, `thirdweb`, `0xgasless`, `custom`. Defaults to the first supported on `network`.
- `x402Version` — `1` or `2`. Defaults to the newest version the `(facilitator, network)` pair supports.

Support matrix:

| Facilitator | Networks | Versions |
|---|---|---|
| `payai` | solana, solana-devnet, base, base-sepolia, peaq, polygon, sei | v1 & v2 (peaq/polygon/sei = v1 only) |
| `dexter` | solana, base | v2 |
| `openfacilitator` | solana, base | v2 |
| `relai` | solana, solana-devnet, base, base-sepolia, skale-base, skale-base-sepolia, avalanche, polygon, ethereum, telos | v2 |
| `autoincentive` | base, base-sepolia | v2 |
| `stratum` | solana, base | v2 |
| `thirdweb` | ethereum | v1 |
| `0xgasless` | avalanche | v2 |
| `custom` | most networks | v1 & v2 |

Unsupported `(facilitator, network, x402Version)` triples produce a `400` with the list of valid facilitators for that network.

**Response** `200 OK`: the full record including `apiId`, `status`, timestamps.

## `GET /v1/apis` — list owned

**Response**:

```json
{ "apis": [ { "apiId": "...", "name": "...", "network": "...", "status": "..." } ] }
```

## `GET /v1/apis/{apiId}` — get one

**Response**: full API record.

## `PATCH /v1/apis/{apiId}` — update

**Request body**: any subset of updatable fields.

```json
{
  "name": "New name",
  "description": "optional",
  "baseUrl": "optional",
  "merchantWallet": "optional",
  "solanaWallet": null,
  "evmCrossChainWallet": "optional or null to clear",
  "websiteUrl": "optional",
  "logoUrl": "optional"
}
```

`null` clears optional wallets. Omitted fields are left as-is.

## `DELETE /v1/apis/{apiId}`

**Response**: `{ "success": true, "apiId": "..." }`. Irreversible.

## `GET /v1/apis/{apiId}/pricing`

**Response**:

```json
{
  "apiId": "...",
  "endpoints": [
    { "path": "/v1/predict", "method": "post", "usdPrice": 0.05, "enabled": true, "network": "base" }
  ]
}
```

## `PUT /v1/apis/{apiId}/pricing` — full replace

**Request body**:

```json
{
  "endpoints": [
    {
      "path": "/v1/predict",
      "method": "post",
      "usdPrice": 0.05,
      "enabled": true,
      "description": "Run inference on a user prompt",
      "parameters": [],
      "requestBody": {
        "required": ["prompt"],
        "properties": { "prompt": { "type": "string" } }
      }
    }
  ]
}
```

Send the complete list — the server replaces the existing pricing wholesale. `parameters` and `requestBody` use the same shapes as on `POST /v1/apis` above; omitting them on an update wipes any previously stored schema for that endpoint.

**Response**: `{ "success": true, "apiId": "...", "updated": 1 }`.

## `GET /v1/apis/{apiId}/stats`

**Response**:

```json
{ "apiId": "...", "totalRequests": 1234, "totalRevenue": 56.78, "currency": "USDC" }
```

## `GET /v1/apis/{apiId}/payments`

Query params: `limit`, `from` (ISO8601), `cursor`.

**Response**:

```json
{
  "apiId": "...",
  "payments": [
    {
      "transaction": "0x...",
      "path": "/v1/predict",
      "method": "post",
      "amount": 0.05,
      "currency": "USDC",
      "network": "base",
      "status": "confirmed",
      "success": true,
      "payer": "0x...",
      "createdAt": "2026-04-15T10:00:00Z"
    }
  ],
  "nextCursor": "opaque-string-or-null"
}
```

## `GET /v1/apis/{apiId}/logs`

Same query params as payments.

**Response**:

```json
{
  "items": [
    {
      "id": "...",
      "timestamp": "2026-04-15T10:00:00Z",
      "method": "post",
      "path": "/v1/predict",
      "status": "200",
      "cost": 0.05,
      "currency": "USDC",
      "duration": 120,
      "transaction": "0x...",
      "network": "base",
      "success": true,
      "payer": "0x..."
    }
  ],
  "nextCursor": "opaque-string-or-null"
}
```

## Endpoint shape conventions

- `method` — lowercase (`get`, `post`, `put`, `patch`, `delete`).
- `usdPrice` — decimal USDC. `0` disables metering.
- `enabled` — defaults to `true` when omitted.
- Paths are matched exactly: `/users` ≠ `/users/`.
- `parameters[]` and `requestBody` — OpenAPI 3.x shapes; see the create-flow section for examples. Path params can also be declared inline via `{placeholder}` in `path`.
