import { getServiceKey, isAgentConfigured } from "../store.js";

export type ToolCtx = { agentId?: string };

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function getAgentIdFromCtx(ctx: ToolCtx): string {
  return ctx.agentId || "main";
}

export function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function errorResult(err: unknown, prefix = "Failed"): ToolResult {
  return textResult(`${prefix}: ${(err as Error).message}`);
}

/**
 * Resolve the service key for the current agent context.
 * Returns the key + agentId on success, or a ToolResult to return directly on failure.
 */
export function requireServiceKey(
  ctx: ToolCtx,
): { serviceKey: string; agentId: string } | ToolResult {
  const agentId = getAgentIdFromCtx(ctx);
  if (!isAgentConfigured(agentId)) {
    return textResult(
      `No service key configured for agent "${agentId}". Run relai_setup first.`,
      { status: "not_configured" },
    );
  }
  return { serviceKey: getServiceKey(agentId)!, agentId };
}
