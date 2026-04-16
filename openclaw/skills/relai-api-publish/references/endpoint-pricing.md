# Endpoint pricing

## Shape

Each endpoint entry:

```json
{
  "path": "/v1/predict",
  "method": "post",
  "usdPrice": 0.05,
  "enabled": true,
  "description": "Run inference on the user prompt",
  "requestBody": {
    "required": ["prompt"],
    "properties": {
      "prompt": { "type": "string" },
      "temperature": { "type": "number", "minimum": 0, "maximum": 1 }
    }
  }
}
```

- `method` is lowercase by convention (`get`, `post`, `put`, `patch`, `delete`).
- `usdPrice` is USDC, decimal. `0` is valid for free endpoints but disables metering.
- `enabled` defaults to `true` when omitted.
- `description` is shown on the marketplace detail page — prefer a short, action-oriented line ("Search the catalog", "Run inference").

## Schemas — `parameters` and `requestBody`

Populate these so the marketplace test form can render inputs. Without them, buyers see an empty form and can't test the endpoint.

### GET / query endpoints — `parameters[]`

OpenAPI Parameter Objects:

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

- `in` — one of `query`, `path`, `header`. Path params are also auto-detected from `{placeholders}` in the `path` string.
- `required` — path params are forced to `true` on the server (OpenAPI rule).
- `schema` — optional JSON Schema for the field (used for validation hints).

### POST / PUT / PATCH endpoints — `requestBody`

Two accepted shapes — both normalised server-side to a valid OpenAPI Request Body:

**Simplified** (recommended for quick setup):

```json
"requestBody": {
  "required": ["prompt"],
  "properties": {
    "prompt": { "type": "string" },
    "temperature": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```

**Full OpenAPI**:

```json
"requestBody": {
  "required": true,
  "content": {
    "application/json": {
      "schema": {
        "required": ["prompt"],
        "properties": {
          "prompt": { "type": "string" }
        }
      }
    }
  }
}
```

### Or: pass a full OpenAPI spec at creation

If you already maintain an OpenAPI spec for the upstream API, pass it as top-level `openApi` on `relai_mgmt_create_api` instead of populating `parameters`/`requestBody` per endpoint. Endpoints can still be priced individually via `endpoints[]`; otherwise they are auto-derived from the spec's paths with a default price of `$0.01` (override later with `relai_mgmt_set_pricing`).

## `relai_mgmt_set_pricing` is a full replace

The server replaces the entire pricing list with the payload. To disable one endpoint while keeping others, fetch the current list via `relai_mgmt_get_pricing`, flip `enabled: false` on the target, and re-send the whole list.

## Path matching

Paths are matched exactly as registered. `/users` and `/users/` are **different** endpoints. Prefer the form the upstream API actually serves.

## Pricing heuristics

- Inference / generation endpoints: price by approximate compute cost.
- Static lookups: low flat fee (e.g. $0.001–$0.01).
- Stateful purchases (gift cards, credits): price = face value + margin; the call itself mediates delivery.

## Disabling without deleting

To take an endpoint offline temporarily, keep it in the list with `enabled: false`. This preserves its price record for later re-enable without re-entering the value.
