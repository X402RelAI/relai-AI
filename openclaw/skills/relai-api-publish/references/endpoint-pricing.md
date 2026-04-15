# Endpoint pricing

## Shape

Each endpoint entry:

```json
{
  "path": "/v1/predict",
  "method": "post",
  "usdPrice": 0.05,
  "enabled": true
}
```

- `method` is lowercase by convention (`get`, `post`, `put`, `patch`, `delete`).
- `usdPrice` is USDC, decimal. `0` is valid for free endpoints but disables metering.
- `enabled` defaults to `true` when omitted.

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
