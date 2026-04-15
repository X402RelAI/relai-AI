#!/usr/bin/env node
// RelAI consent-flow provisioner.
// Generates a local EVM pairing keypair, walks the browser-consent flow, and
// persists the resulting service key to ~/.relai/service-key.json (0600).
// The private key never leaves this process.
//
// The pairing keypair is always EVM (secp256k1): RelAI's /agent-keys/consent/retrieve
// endpoint verifies with `ethers.verifyMessage` (EIP-191), which only accepts EVM
// signatures. The resulting service key works on all chains regardless.
//
// Usage:
//   node consent.mjs --label="my-agent"
//   node consent.mjs --label="my-agent" --base-url=https://api.relai.fi
//   node consent.mjs --no-save           # print only, skip ~/.relai/service-key.json

import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const label = args.label || "relai-agent";
const baseUrl = (args["base-url"] || "https://api.relai.fi").replace(/\/$/, "");
const pollMs = Number(args["poll-ms"] || 3000);
const maxPolls = Number(args["max-polls"] || 300); // ~15 min at 3s

function logStep(msg) {
  console.error(`[relai-setup] ${msg}`);
}

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const m = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${res.status}: ${m}`);
  }
  return parsed;
}

/**
 * Persist the issued service key to ~/.relai/service-key.json (0600).
 * The RELAI_SERVICE_KEY env var still takes precedence in downstream skills.
 */
function persistKey(retrieved) {
  const dir = join(homedir(), ".relai");
  const file = join(dir, "service-key.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    key: retrieved.key,
    agentId: retrieved.agentId ?? null,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

async function makeSigner() {
  const { ethers } = await import("ethers").catch(() => {
    throw new Error(
      "Missing dependency: install with `npm i ethers` (or run from a project that already has it).",
    );
  });
  const wallet = ethers.Wallet.createRandom();
  return {
    publicKey: wallet.address,
    sign: (msg) => wallet.signMessage(msg),
  };
}

async function main() {
  logStep(`label=${label} baseUrl=${baseUrl}`);
  const signer = await makeSigner();
  logStep(`local pairing keypair generated (internal — will not be shown to the user)`);

  const initiated = await http("POST", "/agent-keys/consent/initiate", {
    agentPubKey: signer.publicKey,
    agentName: label,
    label,
  });

  console.log(
    "\nOpen this URL in your browser and approve the agent:\n\n  " +
      initiated.authorizeUrl +
      "\n",
  );
  logStep(`consentToken=${initiated.consentToken} expiresAt=${initiated.expiresAt}`);
  logStep(`polling every ${pollMs}ms (up to ${maxPolls} times)...`);

  for (let i = 0; i < maxPolls; i++) {
    await delay(pollMs);
    const status = await http(
      "GET",
      `/agent-keys/consent/status/${encodeURIComponent(initiated.consentToken)}`,
    );

    if (status.status === "approved" && status.retrieveNonce) {
      logStep("approved — signing nonce and retrieving service key");
      const signature = await signer.sign(status.retrieveNonce);
      const retrieved = await http("POST", "/agent-keys/consent/retrieve", {
        consentToken: initiated.consentToken,
        signature,
      });

      const saved = args["no-save"] ? null : persistKey(retrieved);

      console.log("\n┌──────────────────────────────────────────────────────┐");
      console.log("│  SERVICE KEY  (chain-agnostic — works on all chains) │");
      console.log("└──────────────────────────────────────────────────────┘\n");
      console.log(retrieved.key);
      console.log("");
      if (retrieved.agentId) logStep(`agentId: ${retrieved.agentId}`);
      if (saved) {
        logStep(`saved to ${saved}  (read automatically by relai-* skills)`);
      } else {
        logStep(`not persisted — set RELAI_SERVICE_KEY=... in your env before using other skills`);
      }
      logStep("done.");
      return;
    }

    if (status.status === "rejected") {
      throw new Error("Consent was rejected by the user.");
    }
    if (status.status === "expired") {
      throw new Error("Consent link expired. Re-run the script.");
    }

    if (i % 5 === 0) logStep(`status=${status.status} (still waiting)`);
  }

  throw new Error("Timed out waiting for consent approval.");
}

main().catch((err) => {
  console.error(`\n[relai-setup] ${err.message}`);
  process.exit(1);
});
