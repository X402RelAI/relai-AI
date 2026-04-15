import { Type } from "@sinclair/typebox";
import { consentInitiate, consentStatus, consentRetrieve } from "../api.js";
import {
  getOrCreateAgent,
  signMessage,
  updateConsentPending,
  completeSetup,
  updateSetupStatus,
} from "../store.js";
import type { RelaiPluginConfig } from "../config.js";
import { getAgentIdFromCtx, textResult, errorResult, type ToolCtx } from "./shared.js";

export function createSetupTool(config: RelaiPluginConfig) {
  return {
    name: "relai_setup",
    description:
      "Set up a RelAI service key for this agent. Generates a local keypair, opens consent URL in the user's browser, and waits for approval automatically.",
    parameters: Type.Object({
      agentName: Type.Optional(
        Type.String({ description: "Human-readable name shown in consent UI." }),
      ),
      contractAddress: Type.Optional(
        Type.String({ description: "ERC-721 agent NFT contract address (optional)." }),
      ),
      nftTokenId: Type.Optional(
        Type.String({ description: "Agent NFT token ID (optional)." }),
      ),
      network: Type.Optional(
        Type.String({ description: "Network name (e.g. 'skale-base'). Optional." }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const ctxAgentId = getAgentIdFromCtx(ctx);

      try {
        const agentData = getOrCreateAgent(ctxAgentId, {
          agentName: params.agentName as string | undefined,
          contractAddress: params.contractAddress as string | undefined,
          nftTokenId: params.nftTokenId as string | undefined,
          network: params.network as string | undefined,
        });

        if (agentData.serviceKey) {
          return textResult(
            `Agent "${ctxAgentId}" is already configured with a RelAI service key. This key works on all chains.`,
            { status: "already_configured", agentId: ctxAgentId },
          );
        }

        let token = agentData.consentToken;
        let authUrl = agentData.authorizeUrl;

        if (!token) {
          const initiated = await consentInitiate(config, {
            agentPubKey: agentData.agentPubKey,
            agentId: agentData.agentId,
            contractAddress: agentData.contractAddress,
            network: agentData.network,
            agentName: agentData.agentName,
            label: agentData.agentName,
          });

          token = initiated.consentToken;
          authUrl = initiated.authorizeUrl;

          updateConsentPending(
            ctxAgentId,
            initiated.consentToken,
            initiated.authorizeUrl,
            initiated.expiresAt,
          );
        }

        const currentStatus = await consentStatus(config, token!);

        if (currentStatus.status === "approved" && currentStatus.retrieveNonce) {
          const signature = await signMessage(ctxAgentId, currentStatus.retrieveNonce);
          const retrieved = await consentRetrieve(config, token!, signature);
          completeSetup(ctxAgentId, retrieved.key, retrieved.agentId);

          return textResult(
            `Agent "${ctxAgentId}" is now configured. Service key stored (works on all chains). You can now use relai_call to call paid APIs.`,
            { status: "configured", agentId: ctxAgentId },
          );
        }

        if (currentStatus.status === "rejected") {
          updateSetupStatus(ctxAgentId, "rejected");
          return textResult(
            `Consent was rejected for agent "${ctxAgentId}". Call relai_setup again to start a new consent flow.`,
            { status: "rejected", agentId: ctxAgentId },
          );
        }

        if (currentStatus.status === "expired") {
          updateSetupStatus(ctxAgentId, "expired");
          return textResult(
            `Consent link expired for agent "${ctxAgentId}". Call relai_setup again to get a new link.`,
            { status: "expired", agentId: ctxAgentId },
          );
        }

        return textResult(
          `Please open this link to approve the agent key for "${ctxAgentId}":\n\n${authUrl}\n\nOnce approved, call relai_setup again to complete the configuration.`,
          { status: "awaiting_consent", agentId: ctxAgentId, authorizeUrl: authUrl },
        );
      } catch (error) {
        return errorResult(error, "Setup failed");
      }
    },
  };
}
