# Decoding `relai:shielded:<base64url>` locally

The shielded link payload is a compact JSON document, base64url-encoded, prefixed with one of:

- `relai:shielded:` (canonical)
- `shielded:`
- `s:`
- a URL with the payload in the hash fragment, e.g. `https://relai.fi/codes/redeem#s:<base64url>`

Decoding is **local-only**: no network call, no secret material leaves the agent.

## Field map

| Short | Long | Meaning | Safe to surface? |
|---|---|---|---|
| `v` | `version` | Note schema version (`1`) | yes |
| `p` | `poolId` | Canonical pool ID (e.g. `solana-devnet:usdc:4000000`) | yes |
| `l` | `linkId` | Server-side link identifier — pass to `relai_shielded_status` | **yes** |
| `s` | `secret` | 32-byte spend secret (base64url) | **NO — never log or echo** |
| `b` | `blinding` | 32-byte blinding factor (base64url) | **NO** |
| `n` | `nonce` | 16-byte nonce (base64url) | **NO** |
| `a` | `assetId` | Asset identifier (e.g. `usdc`) | yes |
| `d` | `denomination` | Amount in micro-USDC | yes |
| `w` | `network` | Settlement network (`solana-devnet`, etc.) | yes |
| `g` | `programId` | Solana shielded-pool program ID | yes |
| `m` | `mode` | Note mode tag (rarely set) | yes |

## Decoding fragment

```js
const PREFIXES = ['relai:shielded:', 'shielded:', 's:'];
const lower = input.trim().toLowerCase();
const prefix = PREFIXES.find(p => lower.startsWith(p));
let token;
if (prefix) {
  token = input.trim().slice(prefix.length);
} else {
  // URL with payload in the hash, or raw JSON
  try {
    const url = new URL(input.trim());
    const hash = url.hash.replace(/^#/, '');
    token = hash.replace(/^(?:relai:shielded:|shielded:|s:)/i, '');
  } catch {
    token = input.trim();
  }
}

const json = token.startsWith('{') ? token : Buffer.from(token, 'base64url').toString('utf8');
const raw = JSON.parse(json);

const linkId       = raw.linkId       ?? raw.l;
const network      = raw.network      ?? raw.w;
const denomination = raw.denomination ?? raw.d;
const poolId       = raw.poolId       ?? raw.p;
// Stop here. Do NOT extract or surface s/b/n.
```

## What to do after decode

- Pass `linkId` + `network` to `relai_shielded_status` to read the link's on-chain state.
- Surface `denomination` to the user as `Number(denomination) / 1_000_000` USDC for sanity ("the link claims to be worth N USDC").
- Discard the secret/blinding/nonce. They are only needed by the seller's redeem flow, which lives outside this plugin.

## Safety

- **Never** put the full payload string in a memory entry, log, or chat acknowledgement.
- **Never** include `s`, `b`, or `n` in any tool result, even as a "for debugging" field.
- A leaked payload = a stolen payment. Anyone holding the full payload can redeem to any address.
