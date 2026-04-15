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
  "description": "optional",
  "websiteUrl": "optional",
  "logoUrl": "optional",
  "solanaWallet": "optional — for EVM-network APIs accepting Solana payments",
  "evmCrossChainWallet": "optional — for Solana-network APIs accepting EVM payments",
  "endpoints": [
    { "path": "/v1/predict", "method": "post", "usdPrice": 0.05, "enabled": true }
  ]
}
```

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
    { "path": "/v1/predict", "method": "post", "usdPrice": 0.05, "enabled": true }
  ]
}
```

Send the complete list — the server replaces the existing pricing wholesale.

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
