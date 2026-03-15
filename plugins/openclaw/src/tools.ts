import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import {
  listApis,
  getApiDetails,
  consentInitiate,
  consentStatus,
  consentRetrieve,
  meteredCall,
} from "./api.js";
import {
  getAgentKey,
  isAgentConfigured,
  getServiceKey,
  getOrCreateAgent,
  signMessage,
  updateConsentPending,
  completeSetup,
  updateSetupStatus,
} from "./store.js";
import type { RelaiPluginConfig } from "./config.js";

let _isWSL: boolean | undefined;
function isWSL(): boolean {
  if (_isWSL === undefined) {
    try {
      _isWSL = readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
    } catch {
      _isWSL = false;
    }
  }
  return _isWSL;
}

function openUrl(url: string): void {
  if (isWSL()) {
    execFile("cmd.exe", ["/c", "start", url.replace(/&/g, "^&")], () => {});
  } else if (process.platform === "darwin") {
    execFile("open", [url], () => {});
  } else if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", url.replace(/&/g, "^&")], () => {});
  } else {
    execFile("xdg-open", [url], () => {});
  }
}

function getAgentIdFromCtx(ctx: OpenClawPluginToolContext): string {
  return ctx.agentId || "main";
}

// ---------------------------------------------------------------------------
// relai_setup
// ---------------------------------------------------------------------------

export function createSetupTool(_api: OpenClawPluginApi, config: RelaiPluginConfig) {
  return {
    name: "relai_setup",
    label: "Setup Agent Key",
    description:
      "Set up a RelAI service key for this agent. Generates a local keypair, opens consent URL in the user's browser, and waits for approval automatically.",
    parameters: Type.Object({
      agentName: Type.Optional(
        Type.String({ description: "Human-readable name shown in consent UI." }),
      ),
      chainType: Type.Optional(
        Type.String({ description: 'Chain type for keypair generation: "evm" or "solana". Defaults to plugin config. The service key works on all chains regardless.' }),
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

    async execute(
      _id: string,
      params: Record<string, unknown>,
      ctx: OpenClawPluginToolContext,
    ) {
      const ctxAgentId = getAgentIdFromCtx(ctx);
      const chainType = (params.chainType as "evm" | "solana") || config.chainType;

      try {
        // Get or create local keypair (EVM or Solana)
        const agentData = getOrCreateAgent(ctxAgentId, chainType, {
          agentName: params.agentName as string | undefined,
          contractAddress: params.contractAddress as string | undefined,
          nftTokenId: params.nftTokenId as string | undefined,
          network: params.network as string | undefined,
        });

        // Already configured — nothing to do
        if (agentData.serviceKey) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent "${ctxAgentId}" is already configured with a RelAI service key. This key works on all chains.`,
              },
            ],
            details: {
              status: "already_configured",
              agentId: ctxAgentId,
              chainType: agentData.chainType,
              agentPubKey: agentData.agentPubKey,
            },
          };
        }

        // Reuse pending consent token or start fresh
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

        // Open consent URL in the user's browser
        openUrl(authUrl!);

        // Poll for approval (5s interval, up to 5 min)
        const POLL_INTERVAL_MS = 5_000;
        const MAX_POLL_MS = 5 * 60 * 1000;
        const pollStart = Date.now();

        while (Date.now() - pollStart < MAX_POLL_MS) {
          const statusRes = await consentStatus(config, token!);

          if (statusRes.status === "approved" && statusRes.retrieveNonce) {
            const signature = await signMessage(ctxAgentId, statusRes.retrieveNonce);
            const retrieved = await consentRetrieve(config, token!, signature);
            completeSetup(ctxAgentId, retrieved.key, retrieved.agentId);

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Agent "${ctxAgentId}" is now configured. Service key stored (works on all chains). You can now use relai_call to call paid APIs.`,
                },
              ],
              details: {
                status: "configured",
                agentId: ctxAgentId,
                chainType,
              },
            };
          }

          if (statusRes.status === "rejected") {
            updateSetupStatus(ctxAgentId, "rejected");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Consent was rejected for agent "${ctxAgentId}". Call relai_setup again to start a new consent flow.`,
                },
              ],
              details: { status: "rejected", agentId: ctxAgentId },
            };
          }

          if (statusRes.status === "expired") {
            updateSetupStatus(ctxAgentId, "expired");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Consent link expired for agent "${ctxAgentId}". Call relai_setup again to get a new link.`,
                },
              ],
              details: { status: "expired", agentId: ctxAgentId },
            };
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        // Polling timed out
        return {
          content: [
            {
              type: "text" as const,
              text: `Timed out waiting for approval for agent "${ctxAgentId}". Call relai_setup to try again.`,
            },
          ],
          details: {
            status: "timeout",
            agentId: ctxAgentId,
            authorizeUrl: authUrl,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Setup failed: ${(error as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_discover
// ---------------------------------------------------------------------------

export function createDiscoverTool(_api: OpenClawPluginApi, config: RelaiPluginConfig) {
  return {
    name: "relai_discover",
    label: "Discover APIs",
    description:
      "List available paid APIs on the RelAI marketplace.",
    parameters: Type.Object({
      network: Type.Optional(
        Type.String({
          description:
            'Filter by supported network (e.g. "solana", "base"). Omit to show all.',
        }),
      ),
    }),

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _ctx: OpenClawPluginToolContext,
    ) {
      try {
        let apis = await listApis(config);
        apis = apis.filter((a) => !a.zAuthEnabled);

        const network = params.network as string | undefined;
        if (network) {
          apis = apis.filter((a) =>
            a.supportedNetworks.some(
              (n) => n.toLowerCase() === network.toLowerCase(),
            ),
          );
        }

        if (apis.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: network
                  ? `No compatible APIs found for network "${network}".`
                  : "No compatible APIs found on the marketplace.",
              },
            ],
            details: { apis: [] },
          };
        }

        const lines = apis.map(
          (a) =>
            `- **${a.name}** (\`${a.apiId}\`) — ${a.description} [${a.supportedNetworks.join(", ")}]`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${apis.length} API(s) on RelAI:\n\n${lines.join("\n")}`,
            },
          ],
          details: { apis },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list APIs: ${(error as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_api_info
// ---------------------------------------------------------------------------

export function createApiInfoTool(_api: OpenClawPluginApi, config: RelaiPluginConfig) {
  return {
    name: "relai_api_info",
    label: "API Info & Pricing",
    description:
      "Get details and endpoint pricing for a specific API on the RelAI marketplace.",
    parameters: Type.Object({
      apiId: Type.String({ description: "API identifier (e.g. 'nshield')." }),
    }),

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _ctx: OpenClawPluginToolContext,
    ) {
      const apiId = params.apiId as string;

      try {
        const details = await getApiDetails(config, apiId);
        const enabledEndpoints = details.endpoints.filter((e) => e.enabled);
        const lines = enabledEndpoints.map(
          (e) =>
            `- \`${e.method} ${e.path}\` — ${e.summary} ($${e.usdPrice}/call)`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `**${details.name}** (\`${details.apiId}\`)`,
                details.description,
                `Network: ${details.network}`,
                "",
                enabledEndpoints.length > 0
                  ? `Endpoints:\n${lines.join("\n")}`
                  : "No enabled endpoints.",
              ].join("\n"),
            },
          ],
          details: { api: details },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get API info: ${(error as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_call
// ---------------------------------------------------------------------------

export function createCallTool(_api: OpenClawPluginApi, config: RelaiPluginConfig) {
  return {
    name: "relai_call",
    label: "Call Paid API",
    description:
      "Call a paid API on the RelAI marketplace. Payment is handled automatically by RelAI via the service key (works on all chains). Use relai_discover and relai_api_info to find APIs and endpoints.",
    parameters: Type.Object({
      apiId: Type.String({ description: "API identifier (e.g. 'nshield')." }),
      endpointPath: Type.String({
        description: "Endpoint path (e.g. '/v1/health').",
      }),
      method: Type.Optional(
        Type.String({ description: "HTTP method. Defaults to GET." }),
      ),
      body: Type.Optional(
        Type.String({
          description: "Request body (JSON string) for POST/PUT requests.",
        }),
      ),
    }),

    async execute(
      _id: string,
      params: Record<string, unknown>,
      ctx: OpenClawPluginToolContext,
    ) {
      const ctxAgentId = getAgentIdFromCtx(ctx);
      const apiId = params.apiId as string;
      const endpointPath = params.endpointPath as string;
      const method = ((params.method as string) || "GET").toUpperCase();
      const body = params.body as string | undefined;

      if (!isAgentConfigured(ctxAgentId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No service key configured for agent "${ctxAgentId}". Run relai_setup first.`,
            },
          ],
          details: { status: "not_configured" },
        };
      }

      const serviceKey = getServiceKey(ctxAgentId)!;
      const agentData = getAgentKey(ctxAgentId)!;
      const nftId = agentData.agentId || ctxAgentId;

      try {
        const result = await meteredCall(
          config,
          serviceKey,
          nftId,
          apiId,
          endpointPath,
          method,
          body,
        );

        const success = result.status >= 200 && result.status < 300;

        return {
          content: [
            {
              type: "text" as const,
              text: success
                ? `API response (${result.status}):\n\n${result.body}`
                : `API call failed (${result.status}):\n\n${result.body}`,
            },
          ],
          details: {
            status: result.status,
            body: result.body,
            success,
            apiId,
            endpointPath,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to call API: ${(error as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}
