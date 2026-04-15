import { Type } from "@sinclair/typebox";
import { listApis, getApiDetails, meteredCall } from "../api.js";
import { getAgentKey } from "../store.js";
import type { RelaiPluginConfig } from "../config.js";
import {
  getAgentIdFromCtx,
  textResult,
  errorResult,
  requireServiceKey,
  type ToolCtx,
} from "./shared.js";

// ---------------------------------------------------------------------------
// relai_discover
// ---------------------------------------------------------------------------

export function createDiscoverTool(config: RelaiPluginConfig) {
  return {
    name: "relai_discover",
    description: "List available paid APIs on the RelAI marketplace.",
    parameters: Type.Object({
      network: Type.Optional(
        Type.String({
          description:
            'Filter by supported network (e.g. "solana", "base"). Omit to show all.',
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      try {
        let apis = await listApis(config);
        apis = apis.filter((a) => !a.zAuthEnabled);

        const network = params.network as string | undefined;
        if (network) {
          apis = apis.filter((a) =>
            a.supportedNetworks.some((n) => n.toLowerCase() === network.toLowerCase()),
          );
        }

        if (apis.length === 0) {
          return textResult(
            network
              ? `No compatible APIs found for network "${network}".`
              : "No compatible APIs found on the marketplace.",
            { apis: [] },
          );
        }

        const lines = apis.map(
          (a) =>
            `- **${a.name}** (\`${a.apiId}\`) — ${a.description} [${a.supportedNetworks.join(", ")}]`,
        );

        return textResult(`Found ${apis.length} API(s) on RelAI:\n\n${lines.join("\n")}`, {
          apis,
        });
      } catch (error) {
        return errorResult(error, "Failed to list APIs");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_api_info
// ---------------------------------------------------------------------------

function extractRequestInfo(
  openApiJson: Record<string, unknown> | undefined,
  endpointPath: string,
  method: string,
): { fields: string[]; enums: Record<string, string[]> } {
  if (!openApiJson) return { fields: [], enums: {} };

  const paths = openApiJson.paths as Record<string, Record<string, unknown>> | undefined;
  const pathEntry = paths?.[endpointPath];
  const op = pathEntry?.[method.toLowerCase()] as Record<string, unknown> | undefined;
  const reqBody = op?.requestBody as Record<string, unknown> | undefined;
  const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
  // Prefer application/json when available, otherwise fall back to the first
  // declared content type — don't assume a specific media type.
  const mediaType = content
    ? (content["application/json"] ? "application/json" : Object.keys(content)[0])
    : undefined;
  const schema = (mediaType && content ? content[mediaType]?.schema : undefined) as
    | Record<string, unknown>
    | undefined;
  const properties = schema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = (schema?.required as string[]) || [];

  if (!properties) return { fields: [], enums: {} };

  const fields: string[] = [];
  const enums: Record<string, string[]> = {};

  for (const [name, prop] of Object.entries(properties)) {
    const req = required.includes(name) ? " (required)" : " (optional)";
    const desc = prop.description ? ` — ${prop.description}` : "";
    const enumValues = prop.enum as string[] | undefined;

    if (enumValues) {
      enums[name] = enumValues;
      fields.push(`  - \`${name}\`${req}${desc} (allowed: ${enumValues.join(", ")})`);
    } else {
      fields.push(`  - \`${name}\`${req}${desc}`);
    }
  }

  return { fields, enums };
}

export function createApiInfoTool(config: RelaiPluginConfig) {
  return {
    name: "relai_api_info",
    description:
      "Get details, endpoint pricing, and request body schema (including enum constraints) for a specific API on the RelAI marketplace.",
    parameters: Type.Object({
      apiId: Type.String({ description: "API identifier as returned by relai_discover." }),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const apiId = params.apiId as string;

      try {
        const details = await getApiDetails(config, apiId);
        const enabledEndpoints = details.endpoints.filter((e) => e.enabled);

        const firstEndpoint = enabledEndpoints[0];
        const requestInfo = firstEndpoint
          ? extractRequestInfo(details.openApiJson, firstEndpoint.path, firstEndpoint.method)
          : { fields: [], enums: {} };

        const lines = enabledEndpoints.map(
          (e) =>
            `- \`${e.method.toUpperCase()} ${e.path}\` — ${e.description || e.summary} (${e.usdPrice} USDC)`,
        );

        const sections = [
          `**${details.name}** (\`${details.apiId}\`)`,
          details.description,
          `Network: ${details.network}`,
          "",
          enabledEndpoints.length > 0
            ? `Endpoints:\n${lines.join("\n")}`
            : "No enabled endpoints.",
        ];

        if (requestInfo.fields.length > 0) {
          sections.push("", `Request body fields:\n${requestInfo.fields.join("\n")}`);
        }

        return textResult(sections.join("\n"), {
          api: details,
          enums: requestInfo.enums,
        });
      } catch (error) {
        return errorResult(error, "Failed to get API info");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_call
// ---------------------------------------------------------------------------

export function createCallTool(config: RelaiPluginConfig) {
  return {
    name: "relai_call",
    description:
      "Call a paid API on the RelAI marketplace. Payment is handled automatically via the service key. Use relai_api_info first to discover the endpoint's method, required fields, and any enum constraints.",
    parameters: Type.Object({
      apiId: Type.String({ description: "API identifier as returned by relai_discover." }),
      endpointPath: Type.String({
        description: "Endpoint path as returned by relai_api_info (e.g. '/v1/resource').",
      }),
      method: Type.String({
        description: "HTTP method of the endpoint (GET, POST, PUT, PATCH, DELETE).",
      }),
      body: Type.Optional(
        Type.String({
          description:
            "Request body as a JSON string. Required for methods that accept a body and when relai_api_info lists request body fields. Omit for GET/HEAD or endpoints with no body.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      const ctxAgentId = getAgentIdFromCtx(ctx);
      const apiId = params.apiId as string;
      const endpointPath = params.endpointPath as string;
      const method = (params.method as string).toUpperCase();
      const body = params.body as string | undefined;

      const agentData = getAgentKey(ctxAgentId)!;
      const nftId = agentData.agentId || ctxAgentId;

      try {
        const result = await meteredCall(
          config,
          auth.serviceKey,
          nftId,
          apiId,
          endpointPath,
          method,
          body,
        );

        const success = result.status >= 200 && result.status < 300;

        return textResult(
          success
            ? `API response (${result.status}):\n\n${result.body}`
            : `API call failed (${result.status}):\n\n${result.body}`,
          {
            status: result.status,
            body: result.body,
            success,
            apiId,
            endpointPath,
          },
        );
      } catch (error) {
        return errorResult(error, "Failed to call API");
      }
    },
  };
}
