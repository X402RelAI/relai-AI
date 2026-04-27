import { Type } from "@sinclair/typebox";
import {
  getShieldedPoolConfig,
  getShieldedLinkStatus,
  getShieldedAspStatus,
  type ShieldedNetwork,
} from "../management.js";
import { redeemShieldedLink } from "../shielded/redeem.js";
import { parseShieldedPayload } from "../shielded/payload.js";
import type { RelaiPluginConfig } from "../config.js";
import { textResult, errorResult, requireServiceKey, type ToolCtx } from "./shared.js";

const NetworkSchema = Type.Union(
  [
    Type.Literal("solana-devnet"),
    Type.Literal("solana"),
    Type.Literal("base-sepolia"),
    Type.Literal("skale-base-sepolia"),
  ],
  {
    description:
      "Shielded-pool network. Currently 'solana-devnet', 'base-sepolia', and 'skale-base-sepolia' are live; 'solana' (mainnet) is reserved for the post-audit rollout.",
  },
);

// ---------------------------------------------------------------------------
// relai_shielded_config
// ---------------------------------------------------------------------------

export function createShieldedConfigTool(config: RelaiPluginConfig) {
  return {
    name: "relai_shielded_config",
    description:
      "Get the on-chain shielded-pool configuration for a network: pool program / contract address, USDC mint, issuer fee. Read-only — does not create or fund anything.",
    parameters: Type.Object({
      network: NetworkSchema,
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const cfg = await getShieldedPoolConfig(
          config,
          auth.serviceKey,
          params.network as ShieldedNetwork,
        );
        if ("nativeSolanaShielded" in cfg) {
          return textResult(
            `Solana shielded pool on ${cfg.settlementNetwork}:\n` +
              `- programId:        ${cfg.programId}\n` +
              `- verifierProgram:  ${cfg.verifierProgramId ?? "—"}\n` +
              `- usdcMint:         ${cfg.usdcMint}\n` +
              `- rpcUrl:           ${cfg.rpcUrl}\n` +
              `- issuerFeeBps:     ${cfg.issuerFeeBps}`,
            { ...cfg },
          );
        }
        return textResult(
          `EVM shielded pool on ${cfg.settlementNetwork}:\n` +
            `- poolAddress:      ${cfg.poolAddress}\n` +
            `- contractVersion:  ${cfg.contractVersion}\n` +
            `- usdcAddress:      ${cfg.usdcAddress}\n` +
            `- issuerFeeBps:     ${cfg.issuerFeeBps}`,
          { ...cfg },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_shielded_status
// ---------------------------------------------------------------------------

export function createShieldedStatusTool(config: RelaiPluginConfig) {
  return {
    name: "relai_shielded_status",
    description:
      "Look up the current state of a shielded link by its `linkId`. Returns the link's status (draft / funded / redeemed / expired / cancelled), denomination, expiry, and pool. Use this to verify a buyer funded a link before redeeming, or to check whether a sent payment has been claimed yet.",
    parameters: Type.Object({
      linkId: Type.String({
        description:
          "Shielded link ID returned by `POST /v1/shielded-links` (the `shieldedLinkId` field). Also embedded inside any `relai:shielded:<base64url>` payload as the short key `l`.",
      }),
      network: NetworkSchema,
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const s = await getShieldedLinkStatus(
          config,
          auth.serviceKey,
          params.linkId as string,
          params.network as ShieldedNetwork,
        );
        const expiry = s.validBefore
          ? new Date(s.validBefore * 1000).toISOString()
          : "—";
        return textResult(
          `Shielded link \`${s.shieldedLinkId}\` on ${s.settlementNetwork}:\n` +
            `- status:        ${s.status}\n` +
            `- value:         ${s.value ?? "—"} micro-USDC\n` +
            `- fee:           ${s.feeAmount ?? "—"} micro-USDC\n` +
            `- validBefore:   ${expiry}\n` +
            `- redeemable:    ${s.redeemable ?? false}`,
          { ...s },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_shielded_asp_status
// ---------------------------------------------------------------------------

export function createShieldedAspStatusTool(config: RelaiPluginConfig) {
  return {
    name: "relai_shielded_asp_status",
    description:
      "Get the Association Set Provider (ASP) status: which providers are configured, snapshot freshness, last published root. Useful when a redeem fails with `aspReady: false` — this tool tells you whether the snapshot is up to date or being rebuilt.",
    parameters: Type.Object({}),

    async execute(_id: string, _params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      try {
        const s = await getShieldedAspStatus(config, auth.serviceKey);
        return textResult(
          `ASP status: enabled=${s.enabled}, ` +
            `lastSnapshot=${s.lastSnapshot?.publishedAt ? new Date(s.lastSnapshot.publishedAt * 1000).toISOString() : "—"}, ` +
            `leafCount=${s.lastSnapshot?.leafCount ?? "—"}`,
          { ...s },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_shielded_redeem
//
// Seller-side flow. Takes a `relai:shielded:…` payload + the seller's receive
// address, generates the Groth16 ASP proof locally (~1.5–3s, no GPU), and asks
// the pool relayer to broadcast the withdraw — the relayer signs and pays the
// on-chain fee. The seller wallet only needs to be ready to receive USDC.
//
// No private key is ever passed: `targetAddress` is just the destination
// pubkey. Authenticates with the agent's `X-Service-Key` (resolved via
// requireServiceKey, same pattern as every other plugin tool).
// ---------------------------------------------------------------------------

export function createShieldedRedeemTool(config: RelaiPluginConfig) {
  return {
    name: "relai_shielded_redeem",
    description:
      "Redeem a `relai:shielded:…` payload sent by another agent. Generates the Groth16 ASP proof locally and asks the RelAI pool relayer to broadcast the on-chain withdraw to `targetAddress`. The seller pays NO on-chain gas (the relayer signs the tx). The buyer's wallet stays hidden. Returns the payout tx hash for the seller's records — DO NOT relay it to the buyer (it would let them link the withdraw event back to the deposit they made).",
    parameters: Type.Object({
      shieldedLinkPayload: Type.String({
        description:
          "The full `relai:shielded:<base64url>` string the buyer sent. Also accepts `s:…`, `shielded:…`, or a redeem URL with the payload in the hash. Pass verbatim — do not modify.",
      }),
      targetAddress: Type.String({
        description:
          "Destination wallet for the redeemed USDC. Solana pubkey (base58) for Solana redeems, EVM checksum address for Base/SKALE redeems. Public, no private key — the relayer creates the recipient ATA if it doesn't exist.",
      }),
      targetNetwork: Type.Optional(
        Type.String({
          description:
            "Override redeem network (e.g. 'solana-devnet', 'base-sepolia'). Defaults to the network the buyer deposited on. Use only when the buyer agreed to a cross-network payout out-of-band.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      const payload = String(params.shieldedLinkPayload ?? "");
      const parsed = parseShieldedPayload(payload);
      if (!parsed) {
        return textResult(
          "Could not parse shieldedLinkPayload — malformed or unsupported prefix. Expected `relai:shielded:<base64url>`.",
          { error: "invalid_payload" },
        );
      }

      try {
        const result = await redeemShieldedLink({
          baseUrl: config.baseUrl,
          serviceKey: auth.serviceKey,
          shieldedLinkPayload: payload,
          targetAddress: String(params.targetAddress),
          targetNetwork: params.targetNetwork as string | undefined,
        });

        const lines = [
          `Shielded link redeemed.`,
          ``,
          `linkId:    ${result.shieldedLinkId}`,
          `status:    ${result.status}`,
          `recipient: ${result.recipient}`,
          result.payoutTxHash
            ? `payoutTx:  ${result.payoutExplorerUrl ?? result.payoutTxHash}`
            : `payoutTx:  (pending — re-check with relai_shielded_status)`,
        ];
        return textResult(lines.join("\n"), {
          shieldedLinkId: result.shieldedLinkId,
          status: result.status,
          recipient: result.recipient,
          nullifier: result.nullifier,
          payoutTxHash: result.payoutTxHash,
          payoutExplorerUrl: result.payoutExplorerUrl,
        });
      } catch (error) {
        const err = error as Error & { retryable?: boolean; aspBlockedReason?: string };
        if (err.retryable) {
          return textResult(
            `ASP witness not ready yet (${err.aspBlockedReason ?? "unknown"}). The pool's ASP scheduler debounces ~10s after a fresh deposit. Wait ~12s and call relai_shielded_redeem again with the same parameters.`,
            { retryable: true, aspBlockedReason: err.aspBlockedReason },
          );
        }
        return errorResult(error, "Failed to redeem shielded link");
      }
    },
  };
}
