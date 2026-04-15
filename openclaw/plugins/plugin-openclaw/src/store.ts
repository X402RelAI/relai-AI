import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ethers } from "ethers";

export type SetupStatus =
  | "uninitialized"
  | "awaiting-consent"
  | "awaiting-approval"
  | "configured"
  | "rejected"
  | "expired";

/**
 * Legacy field — older plugin versions stored a `chainType` ("evm" | "solana")
 * and generated Solana keypairs for consent signing. The consent/retrieve
 * endpoint is EVM-only (EIP-191), so Solana pairing keypairs never actually
 * authenticated. The field is kept in the stored type for backward compat
 * with existing `~/.openclaw/relai/agent-keys.json` files, but new records
 * no longer set it and new keypairs are always EVM.
 */
export type LegacyChainType = "evm" | "solana";

export type AgentKeyData = {
  // Legacy — see LegacyChainType above. Undefined on new records.
  chainType?: LegacyChainType;

  // Local EVM pairing keypair (generated automatically at setup).
  // Used once to sign the consent retrieve nonce; unused after that.
  privateKey: string; // 0x-prefixed hex (secp256k1)
  agentPubKey: string; // EVM address (0x…)

  // Agent metadata
  agentId?: string;
  contractAddress?: string;
  network?: string;
  agentName?: string;

  // Consent flow state
  setupStatus?: SetupStatus;
  consentToken?: string;
  authorizeUrl?: string;
  consentExpiresAt?: string;

  // Issued service key
  serviceKey?: string;

  // Timestamps
  createdAt: string;
  configuredAt?: string;
  setupUpdatedAt?: string;
};

export type KeyStore = {
  agents: Record<string, AgentKeyData>;
};

function getStoreDir(): string {
  const override = process.env.RELAI_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".openclaw", "relai");
}

function ensureStoreDir(): void {
  const dir = getStoreDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function getStorePath(): string {
  return path.join(getStoreDir(), "agent-keys.json");
}

function loadStore(): KeyStore {
  ensureStoreDir();
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return { agents: {} };
  }
  try {
    const data = fs.readFileSync(storePath, "utf-8");
    return JSON.parse(data) as KeyStore;
  } catch {
    return { agents: {} };
  }
}

function saveStore(store: KeyStore): void {
  ensureStoreDir();
  fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function getAgentKey(agentId: string): AgentKeyData | null {
  const store = loadStore();
  return store.agents[agentId] ?? null;
}

export function isAgentConfigured(agentId: string): boolean {
  const data = getAgentKey(agentId);
  return !!(data?.serviceKey);
}

export function getServiceKey(agentId: string): string | null {
  const data = getAgentKey(agentId);
  return data?.serviceKey ?? null;
}

/**
 * Get or create a local EVM pairing keypair for this agent.
 *
 * The service key resulting from the consent flow is chain-agnostic — it
 * works on every chain RelAI supports. The pairing keypair is only used once,
 * to sign the retrieve nonce; no notion of chain applies at this stage.
 */
export function getOrCreateAgent(
  agentId: string,
  opts?: {
    agentName?: string;
    contractAddress?: string;
    nftTokenId?: string;
    network?: string;
  },
): AgentKeyData {
  const store = loadStore();

  if (store.agents[agentId]) {
    const existing = store.agents[agentId];
    if (opts) {
      store.agents[agentId] = {
        ...existing,
        contractAddress: opts.contractAddress ?? existing.contractAddress,
        network: opts.network ?? existing.network,
        agentName: opts.agentName ?? existing.agentName,
        agentId: opts.nftTokenId ?? existing.agentId,
      };
      saveStore(store);
    }
    return store.agents[agentId];
  }

  const wallet = ethers.Wallet.createRandom();
  const privateKey = wallet.privateKey;
  const agentPubKey = wallet.address;

  const derivedAgentId = opts?.nftTokenId
    || `openclaw-agent-${crypto.createHash("sha256").update(agentPubKey).digest("hex").slice(0, 8)}`;

  const data: AgentKeyData = {
    privateKey,
    agentPubKey,
    agentId: derivedAgentId,
    contractAddress: opts?.contractAddress,
    network: opts?.network,
    agentName: opts?.agentName,
    createdAt: new Date().toISOString(),
  };

  store.agents[agentId] = data;
  saveStore(store);
  return data;
}

/**
 * Sign a message with the agent's pairing keypair (always EVM / EIP-191).
 */
export async function signMessage(agentId: string, message: string): Promise<string> {
  const data = getAgentKey(agentId);
  if (!data?.privateKey) {
    throw new Error(`No keypair found for agent "${agentId}". Run relai_setup first.`);
  }

  if (data.chainType === "solana") {
    // Legacy Solana keypair — cannot authenticate against the EVM-only
    // consent/retrieve endpoint. Force a reset so the user regenerates an
    // EVM pairing keypair via relai_setup.
    throw new Error(
      `Agent "${agentId}" has a legacy Solana pairing keypair that cannot authenticate ` +
      `against the RelAI consent/retrieve endpoint. Delete the entry from ` +
      `~/.openclaw/relai/agent-keys.json and re-run relai_setup.`,
    );
  }

  const wallet = new ethers.Wallet(data.privateKey);
  return wallet.signMessage(message);
}

export function updateConsentPending(
  agentId: string,
  consentToken: string,
  authorizeUrl: string,
  expiresAt: string,
): AgentKeyData {
  const store = loadStore();
  const existing = store.agents[agentId];
  if (!existing) {
    throw new Error(`No agent entry for "${agentId}". Run relai_setup first.`);
  }

  store.agents[agentId] = {
    ...existing,
    setupStatus: "awaiting-consent",
    consentToken,
    authorizeUrl,
    consentExpiresAt: expiresAt,
    setupUpdatedAt: new Date().toISOString(),
  };

  saveStore(store);
  return store.agents[agentId];
}

export function completeSetup(
  agentId: string,
  serviceKey: string,
  serverAgentId?: string,
): AgentKeyData {
  const store = loadStore();
  const existing = store.agents[agentId];
  if (!existing) {
    throw new Error(`No agent entry for "${agentId}". Run relai_setup first.`);
  }

  store.agents[agentId] = {
    ...existing,
    setupStatus: "configured",
    serviceKey,
    ...(serverAgentId ? { agentId: serverAgentId } : {}),
    consentToken: undefined,
    authorizeUrl: undefined,
    consentExpiresAt: undefined,
    configuredAt: new Date().toISOString(),
    setupUpdatedAt: new Date().toISOString(),
  };

  saveStore(store);
  return store.agents[agentId];
}

export function updateSetupStatus(agentId: string, status: SetupStatus): AgentKeyData {
  const store = loadStore();
  const existing = store.agents[agentId];
  if (!existing) {
    throw new Error(`No agent entry for "${agentId}". Run relai_setup first.`);
  }

  store.agents[agentId] = {
    ...existing,
    setupStatus: status,
    setupUpdatedAt: new Date().toISOString(),
  };

  if (status === "rejected" || status === "expired") {
    store.agents[agentId].consentToken = undefined;
    store.agents[agentId].authorizeUrl = undefined;
    store.agents[agentId].consentExpiresAt = undefined;
  }

  saveStore(store);
  return store.agents[agentId];
}

export function clearAgent(agentId: string): boolean {
  const store = loadStore();
  if (!store.agents[agentId]) return false;
  delete store.agents[agentId];
  saveStore(store);
  return true;
}

export function listAgents(): Record<string, AgentKeyData> {
  return loadStore().agents;
}
