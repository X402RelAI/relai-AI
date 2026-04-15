# Reading `relai_api_info` output

`relai_api_info` returns two top-level blocks in `details`:

- `api` — full API record (endpoints, network, description, raw `openApiJson`)
- `enums` — map of `<fieldName> → string[]` for every request body field constrained by an `enum`. Empty object when no enums are present.

## Enum values

Every field with an `enum` constraint is surfaced two ways:

1. **Text output**: rendered inline in the "Request body fields" section as `(allowed: v1, v2, ...)`.
2. **Structured `details.enums`**: keyed by field name — convenient for programmatic lookup without re-parsing text.

No field name is treated specially. `country_code`, `currency`, `tier`, `region` all behave identically.

## When the `Request body fields` section is empty

Some endpoints have no request body (pure GET). The text output will omit the section; treat this as "no body required" and call with `body` omitted.

## When multiple endpoints have different schemas

The text output's "Request body fields" section and `details.enums` are extracted from the **first enabled endpoint only**. If the user targets a different endpoint, re-derive fields from `openApiJson` for that specific `(path, method)` pair at `details.api.openApiJson.paths[<path>][<method>].requestBody.content["application/json"].schema`.
