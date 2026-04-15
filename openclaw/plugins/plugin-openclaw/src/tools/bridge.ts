import { Type } from "@sinclair/typebox";
import { getBridgeQuote, getBridgeBalances } from "../management.js";
import type { RelaiPluginConfig } from "../config.js";
import { textResult, errorResult } from "./shared.js";

export function createBridgeQuoteTool(config: RelaiPluginConfig) {
  return {
    name: "relai_bridge_quote",
    description: "Get a RelAI bridge quote (fee + net output) for a given USD amount.",
    parameters: Type.Object({
      amount: Type.Number({ description: "Amount in USD." }),
      from: Type.Optional(
        Type.Union([Type.Literal("solana"), Type.Literal("skale-base")], {
          description: "Source network (default: solana).",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const q = await getBridgeQuote(
          config,
          params.amount as number,
          (params.from as "solana" | "skale-base" | undefined) ?? "solana",
        );
        return textResult(
          `Quote ${q.direction}: in $${q.inputUsd} → out $${q.outputUsd} (fee $${q.fee}, ${q.feeBps}bps).`,
          { ...q },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createBridgeBalancesTool(config: RelaiPluginConfig) {
  return {
    name: "relai_bridge_balances",
    description: "Get current USDC liquidity on all RelAI bridge networks.",
    parameters: Type.Object({}),

    async execute() {
      try {
        const b = await getBridgeBalances(config);
        return textResult(
          `Bridge liquidity:\n- solana: $${b.solana.usd}\n- skaleBase: $${b.skaleBase.usd}\n- base: $${b.base.usd}`,
          { ...b },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
