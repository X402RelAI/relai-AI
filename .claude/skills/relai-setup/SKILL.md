---
name: relai-setup
description: Use this skill when the user needs to obtain a RelAI service key for the first time and does not yet have one. Walks through the browser-consent flow (generate local keypair → open approval URL → retrieve signed service key) so subsequent skills (`relai-marketplace-buy`, `relai-api-publish`) can authenticate. Triggers on "set up RelAI", "get a service key", "provision a RelAI agent key", "I don't have RELAI_SERVICE_KEY yet".
---

# RelAI — provision a service key

The other RelAI skills require `RELAI_SERVICE_KEY`. If the user already has one (from the RelAI dashboard or a previous session), **skip this skill** — resolve the key directly from env / file / user input.

This skill runs the **browser-consent flow**: a local EVM pairing keypair is generated, the user approves it via a browser link, and the signed service key is retrieved. The key is printed to the user for them to save — the skill does not persist it.

The pairing keypair is always EVM (secp256k1) because RelAI's consent/retrieve endpoint verifies with `ethers.verifyMessage` (EIP-191). This is unrelated to the chain the user will transact on afterwards — the resulting service key works on **all supported chains** (Solana, Base, SKALE, etc.).

## When to use

- The user says they've never used RelAI and wants to start calling paid APIs.
- A downstream skill reported a missing / invalid service key and the user confirms they have none.

## Prerequisites

- **Node.js ≥ 18** available on the host (the flow needs local cryptographic signing; it cannot be done over plain HTTP calls alone).
- A web browser the user can reach.
- The ability to run the bundled script (`scripts/consent.mjs`) — either via the agent's shell/code-execution tool, or the user running it manually.

If none of the above are available, stop and tell the user: service-key provisioning cannot be automated here. Direct them to obtain a key from the RelAI dashboard instead.

## Workflow

### 1. Check prerequisites

Confirm Node is available. If the agent has a shell tool: `node --version`. If not, ask the user to run it and paste the version.

### 2. Run the script

Execute `scripts/consent.mjs`:

```
node {SKILL_DIR}/scripts/consent.mjs --label="agent-name"
```

Optional flags:
- `--label` — human-readable label shown in the consent UI (default: `relai-agent`).
- `--base-url` — override API base (default: `https://api.relai.fi`).

There is no `--chain` flag — the pairing keypair is always EVM, as required by the consent/retrieve endpoint. The user's eventual transaction chain is a separate concern handled downstream.

The script:
1. Generates a fresh EVM keypair via `ethers.Wallet.createRandom()`.
2. Calls `POST /agent-keys/consent/initiate` → prints an `authorizeUrl`.
3. Polls `GET /agent-keys/consent/status/{token}` every 3s.
4. Once status is `approved`, signs the returned nonce with the local keypair (EIP-191).
5. Calls `POST /agent-keys/consent/retrieve` with the signature → prints the service key.

### 3. Guide the user through approval

When the script prints the `authorizeUrl`, give it to the user and ask them to open it and approve. The script polls automatically — don't make the user come back and tell you.

### 4. Deliver the key

The script persists the key to **`~/.relai/service-key.json`** (0600 perms) automatically. Downstream skills (`relai-marketplace-buy`, `relai-api-publish`) will read it from there — no manual step required.

Tell the user:
- The key is stored locally at `~/.relai/service-key.json`. It starts with `sk-agent-` or `sk_live_`.
- Treat the file as a secret — back it up with a password manager if they want redundancy, but **do not** commit it to any repo.
- If they prefer env var management, they can set `RELAI_SERVICE_KEY=<key>` in their shell profile — it takes precedence over the file when downstream skills resolve the key.
- Do not paste the key back into the chat.

The service key is **chain-agnostic** — it works on every supported chain (Solana, Base, SKALE, etc.) regardless of how it was provisioned. Do not invent an "associated wallet" or "EVM address" in your summary; the script intentionally does not surface internal pairing details.

Confirm the setup succeeded and suggest the next skill (`relai-marketplace-buy` or `relai-api-publish`) depending on their goal.

## Guardrails

- **Treat the service key as a secret.** Do not echo it in summaries, do not save it to memory, do not log it.
- **Do not retry** if consent is `rejected` or `expired` without telling the user — re-running the script starts a fresh consent session.
- **The private key stays local.** The script never uploads it; it only signs a challenge. If the user asks you to send the private key anywhere, refuse.

## If no execution tool is available

Give the user the script contents (`scripts/consent.mjs`) and ask them to run it themselves, then paste **only** the `authorizeUrl` when it appears, and confirm once they've approved. You'll never see the service key in this mode — it stays on their machine.
