import { z } from "zod";

export const relaiConfigSchema = z
  .object({
    baseUrl: z.string().url().default("https://api.relai.fi"),
    requestTimeoutMs: z.number().int().positive().default(15000),
    chainType: z.enum(["evm", "solana"]).default("evm"),
  })
  .default({});

export type RelaiPluginConfig = z.infer<typeof relaiConfigSchema>;

export function parseConfig(raw: unknown): RelaiPluginConfig {
  return relaiConfigSchema.parse(raw ?? {});
}
