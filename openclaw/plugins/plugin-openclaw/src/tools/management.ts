import { Type } from "@sinclair/typebox";
import {
  createApi,
  listManagedApis,
  getManagedApi,
  updateApi,
  deleteApi,
  getPricing,
  setPricing,
  getStats,
  getPayments,
  getLogs,
  type ApiEndpointInput,
  type CreateApiInput,
  type UpdateApiInput,
} from "../management.js";
import type { RelaiPluginConfig } from "../config.js";
import {
  textResult,
  errorResult,
  requireServiceKey,
  type ToolCtx,
} from "./shared.js";

const ParameterSchema = Type.Object({
  name: Type.String(),
  in: Type.Union([
    Type.Literal("query"),
    Type.Literal("path"),
    Type.Literal("header"),
  ]),
  required: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  schema: Type.Optional(Type.Any()),
});

const EndpointSchema = Type.Object({
  path: Type.String(),
  method: Type.String(),
  usdPrice: Type.Number(),
  enabled: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  parameters: Type.Optional(
    Type.Array(ParameterSchema, {
      description:
        "OpenAPI Parameter Objects (query / path / header) shown on the marketplace test form.",
    }),
  ),
  requestBody: Type.Optional(
    Type.Any({
      description:
        "OpenAPI-style request body. Full shape ({ content: { 'application/json': { schema } } }) or simplified shape ({ required: [...], properties: {...} }) both accepted.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// APIs CRUD
// ---------------------------------------------------------------------------

export function createMgmtCreateApiTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_create_api",
    description:
      "Create a new monetised API on RelAI. Requires a configured service key (run relai_setup first).",
    parameters: Type.Object({
      name: Type.String({ description: "Display name for the API." }),
      baseUrl: Type.String({ description: "Upstream base URL that RelAI will proxy." }),
      merchantWallet: Type.String({ description: "Primary wallet that receives payments." }),
      network: Type.String({ description: "Network (e.g. 'base', 'solana', 'skale-base')." }),
      description: Type.Optional(Type.String()),
      websiteUrl: Type.Optional(Type.String()),
      logoUrl: Type.Optional(Type.String()),
      solanaWallet: Type.Optional(
        Type.String({ description: "Solana cross-chain wallet (EVM networks)." }),
      ),
      evmCrossChainWallet: Type.Optional(
        Type.String({ description: "EVM cross-chain wallet (Solana networks)." }),
      ),
      endpoints: Type.Optional(
        Type.Array(EndpointSchema, { description: "Initial priced endpoints." }),
      ),
      openApi: Type.Optional(
        Type.Any({
          description:
            "Optional full OpenAPI 3.x spec (object or JSON string). When provided, the marketplace renders full schemas and, if 'endpoints' is omitted, endpoints are derived from its paths with a default price.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const api = await createApi(config, auth.serviceKey, params as unknown as CreateApiInput);
        return textResult(
          `Created API "${api.name}" (\`${api.apiId}\`) on network ${api.network}.`,
          { api },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtListApisTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_list_apis",
    description: "List APIs owned by the current service key.",
    parameters: Type.Object({}),

    async execute(_id: string, _params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const apis = await listManagedApis(config, auth.serviceKey);
        if (apis.length === 0) {
          return textResult("No APIs owned by this service key.", { apis: [] });
        }
        const lines = apis.map(
          (a) => `- **${a.name}** (\`${a.apiId}\`) — ${a.network} — status: ${a.status}`,
        );
        return textResult(`Owned APIs (${apis.length}):\n\n${lines.join("\n")}`, { apis });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtGetApiTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_get_api",
    description: "Get full configuration for an owned API.",
    parameters: Type.Object({ apiId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const api = await getManagedApi(config, auth.serviceKey, params.apiId as string);
        return textResult(
          `**${api.name}** (\`${api.apiId}\`)\nNetwork: ${api.network}\nStatus: ${api.status}\nBase URL: ${api.baseUrl}\nMerchant wallet: ${api.merchantWallet}`,
          { api },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtUpdateApiTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_update_api",
    description: "Update metadata or wallets on an owned API. Only pass fields you want to change.",
    parameters: Type.Object({
      apiId: Type.String(),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
      merchantWallet: Type.Optional(Type.String()),
      solanaWallet: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      evmCrossChainWallet: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      websiteUrl: Type.Optional(Type.String()),
      logoUrl: Type.Optional(Type.String()),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      const { apiId, ...rest } = params as { apiId: string } & Record<string, unknown>;
      try {
        const api = await updateApi(
          config,
          auth.serviceKey,
          apiId,
          rest as unknown as UpdateApiInput,
        );
        return textResult(`Updated API \`${api.apiId}\`.`, { api });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtDeleteApiTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_delete_api",
    description: "Delete an owned API. This is irreversible.",
    parameters: Type.Object({ apiId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const res = await deleteApi(config, auth.serviceKey, params.apiId as string);
        return textResult(`Deleted API \`${res.apiId}\`.`, { ...res });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export function createMgmtGetPricingTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_get_pricing",
    description: "Get endpoint pricing for an owned API.",
    parameters: Type.Object({ apiId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const res = await getPricing(config, auth.serviceKey, params.apiId as string);
        const lines = res.endpoints.map(
          (e) =>
            `- \`${e.method.toUpperCase()} ${e.path}\` — $${e.usdPrice} (${e.enabled ? "enabled" : "disabled"})`,
        );
        return textResult(
          lines.length > 0
            ? `Pricing for \`${res.apiId}\`:\n${lines.join("\n")}`
            : "No endpoints configured.",
          { ...res },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtSetPricingTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_set_pricing",
    description: "Replace the endpoint pricing list for an owned API.",
    parameters: Type.Object({
      apiId: Type.String(),
      endpoints: Type.Array(EndpointSchema),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const res = await setPricing(
          config,
          auth.serviceKey,
          params.apiId as string,
          params.endpoints as ApiEndpointInput[],
        );
        return textResult(`Updated ${res.updated} endpoint(s) on \`${res.apiId}\`.`, { ...res });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function createMgmtStatsTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_stats",
    description: "Get aggregate request count and revenue for an owned API.",
    parameters: Type.Object({ apiId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const stats = await getStats(config, auth.serviceKey, params.apiId as string);
        return textResult(
          `API \`${stats.apiId}\`: ${stats.totalRequests} requests, ${stats.totalRevenue} ${stats.currency}.`,
          { ...stats },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtPaymentsTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_payments",
    description: "List payments received by an owned API.",
    parameters: Type.Object({
      apiId: Type.String(),
      limit: Type.Optional(Type.Integer()),
      from: Type.Optional(Type.String({ description: "ISO8601 start timestamp." })),
      cursor: Type.Optional(Type.String()),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const res = await getPayments(config, auth.serviceKey, params.apiId as string, {
          limit: params.limit as number | undefined,
          from: params.from as string | undefined,
          cursor: params.cursor as string | undefined,
        });
        const lines = res.payments.map(
          (p) =>
            `- ${p.createdAt} — ${p.method} ${p.path} — ${p.amount} ${p.currency} (${p.status})`,
        );
        return textResult(
          lines.length > 0
            ? `Payments for \`${res.apiId}\`:\n${lines.join("\n")}${res.nextCursor ? `\n\nNext cursor: ${res.nextCursor}` : ""}`
            : "No payments.",
          { ...res },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createMgmtLogsTool(config: RelaiPluginConfig) {
  return {
    name: "relai_mgmt_logs",
    description: "List request logs for an owned API.",
    parameters: Type.Object({
      apiId: Type.String(),
      limit: Type.Optional(Type.Integer()),
      from: Type.Optional(Type.String({ description: "ISO8601 start timestamp." })),
      cursor: Type.Optional(Type.String()),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const res = await getLogs(config, auth.serviceKey, params.apiId as string, {
          limit: params.limit as number | undefined,
          from: params.from as string | undefined,
          cursor: params.cursor as string | undefined,
        });
        const lines = res.items.map(
          (l) =>
            `- ${l.timestamp} — ${l.method} ${l.path} → ${l.status} (${l.cost} ${l.currency}, ${l.duration}ms)`,
        );
        return textResult(
          lines.length > 0
            ? `Logs:\n${lines.join("\n")}${res.nextCursor ? `\n\nNext cursor: ${res.nextCursor}` : ""}`
            : "No logs.",
          { ...res },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
