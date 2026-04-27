import type { RelaiPluginConfig } from "../config.js";
import { createSetupTool } from "./setup.js";
import {
  createDiscoverTool,
  createApiInfoTool,
  createCallTool,
} from "./marketplace.js";
import {
  createMgmtCreateApiTool,
  createMgmtListApisTool,
  createMgmtGetApiTool,
  createMgmtUpdateApiTool,
  createMgmtDeleteApiTool,
  createMgmtGetPricingTool,
  createMgmtSetPricingTool,
  createMgmtStatsTool,
  createMgmtPaymentsTool,
  createMgmtLogsTool,
} from "./management.js";
import { createBridgeQuoteTool, createBridgeBalancesTool } from "./bridge.js";
import {
  createShieldedConfigTool,
  createShieldedStatusTool,
  createShieldedAspStatusTool,
  createShieldedRedeemTool,
} from "./shielded.js";

/**
 * Build the full set of tools exposed by the RelAI marketplace plugin.
 * Grouped by domain: setup → consumer (marketplace) → provider (management) → bridge.
 */
export function buildTools(config: RelaiPluginConfig) {
  return [
    // Setup
    createSetupTool(config),

    // Consumer — browse & call paid APIs
    createDiscoverTool(config),
    createApiInfoTool(config),
    createCallTool(config),

    // Provider — manage your own APIs
    createMgmtCreateApiTool(config),
    createMgmtListApisTool(config),
    createMgmtGetApiTool(config),
    createMgmtUpdateApiTool(config),
    createMgmtDeleteApiTool(config),
    createMgmtGetPricingTool(config),
    createMgmtSetPricingTool(config),
    createMgmtStatsTool(config),
    createMgmtPaymentsTool(config),
    createMgmtLogsTool(config),

    // Bridge
    createBridgeQuoteTool(config),
    createBridgeBalancesTool(config),

    // Shielded private links
    // - Read-only inspection: config / link status / ASP snapshot.
    // - Seller-side redeem: service-key-only, no on-chain signing on the
    //   seller's side (the pool relayer signs and pays gas).
    // - Buyer-side create+fund deliberately stays out of the plugin: it
    //   requires the buyer's Solana keypair to sign `deposit_note` on-chain,
    //   which is incompatible with the "no private keys in tool params"
    //   convention used by every other tool.
    createShieldedConfigTool(config),
    createShieldedStatusTool(config),
    createShieldedAspStatusTool(config),
    createShieldedRedeemTool(config),
  ];
}
