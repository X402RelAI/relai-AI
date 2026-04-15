import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const RelaiConfigSchema = Type.Object({
  baseUrl: Type.String({ default: "https://api.relai.fi" }),
  x402Domain: Type.String({ default: "x402.fi" }),
  requestTimeoutMs: Type.Integer({ default: 15000 }),
});

export type RelaiPluginConfig = Static<typeof RelaiConfigSchema>;

export function parseConfig(raw: unknown): RelaiPluginConfig {
  const input = (raw && typeof raw === "object") ? { ...raw } : {};
  Value.Default(RelaiConfigSchema, input);
  return input as RelaiPluginConfig;
}
