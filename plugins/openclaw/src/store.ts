import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

export type ChainType = "evm" | "solana";

export type SetupStatus =
  | "uninitialized"
  | "awaiting-consent"
  | "awaiting-approval"
  | "configured"
  | "rejected"
  | "expired";

export type AgentKeyData = {
  // Chain type
  chainType: ChainType;

  // Local keypair (generated automatically)
  privateKey: string; // EVM: hex private key, Solana: base64-encoded 64-byte secret key
  agentPubKey: string; // EVM: address, Solana: base58 public key

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
  const entry = store.agents[agentId] ?? null;
  if (entry && !entry.chainType) {
    entry.chainType = "evm";
  }
  return entry;
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
 * Get or create a local keypair for this agent.
 * Generates an EVM wallet or Solana keypair based on chainType.
 */
export function getOrCreateAgent(
  agentId: string,
  chainType: ChainType,
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
    if (!existing.chainType) existing.chainType = "evm";
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

  let privateKey: string;
  let agentPubKey: string;

  if (chainType === "solana") {
    const keypair = Keypair.generate();
    privateKey = Buffer.from(keypair.secretKey).toString("base64");
    agentPubKey = keypair.publicKey.toBase58();
  } else {
    const wallet = ethers.Wallet.createRandom();
    privateKey = wallet.privateKey;
    agentPubKey = wallet.address;
  }

  const derivedAgentId = opts?.nftTokenId
    || `openclaw-agent-${crypto.createHash("sha256").update(agentPubKey).digest("hex").slice(0, 8)}`;

  const data: AgentKeyData = {
    chainType,
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
 * Sign a message with the agent's local private key.
 * Supports both EVM (ethers) and Solana (tweetnacl) signing.
 */
export async function signMessage(agentId: string, message: string): Promise<string> {
  const data = getAgentKey(agentId);
  if (!data?.privateKey) {
    throw new Error(`No keypair found for agent "${agentId}". Run relai_setup first.`);
  }

  if (data.chainType === "solana") {
    const secretKey = Buffer.from(data.privateKey, "base64");
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = nacl.sign.detached(msgBytes, secretKey);
    return Buffer.from(sigBytes).toString("base64");
  } else {
    const wallet = new ethers.Wallet(data.privateKey);
    return wallet.signMessage(message);
  }
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
