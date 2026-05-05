import { Type } from "@sinclair/typebox";
import {
  createSprQuote,
  issueSprQuote,
  cancelSprQuote,
  listSprQuotes,
  getSprQuote,
  getSprMatchStatus,
  getSprSellerReceipt,
  getSprBuyerReceipt,
  type SprNetwork,
  type SprStatus,
} from "../management.js";
import { redeemSprQuote } from "../spr/redeem.js";
import { encodeSprQuotePayload, parseSprQuotePayload } from "../spr/payload.js";
import type { RelaiPluginConfig } from "../config.js";
import { textResult, errorResult, requireServiceKey, type ToolCtx } from "./shared.js";

const NetworkSchema = Type.Union(
  [
    Type.Literal("base-sepolia"),
    Type.Literal("skale-base-sepolia"),
    Type.Literal("solana-devnet"),
  ],
  {
    description:
      "SPR network. Testnet only at this stage: 'base-sepolia', 'skale-base-sepolia', 'solana-devnet'. Mainnet ships after the multi-party trusted-setup ceremony.",
  },
);

const StatusSchema = Type.Union(
  [
    Type.Literal("draft"),
    Type.Literal("issued"),
    Type.Literal("matched"),
    Type.Literal("paid"),
    Type.Literal("redeemed"),
    Type.Literal("expired"),
    Type.Literal("cancelled"),
    Type.Literal("refunded"),
  ],
  { description: "Filter by quote status." },
);

// ---------------------------------------------------------------------------
// relai_spr_issue — create draft + transition to ISSUED in one call.
// ---------------------------------------------------------------------------

export function createSprIssueTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_issue",
    description:
      "Create and issue a Shielded Payment Request quote in one call. Returns the bearer payload `relai:quote:<base64url>` to hand to the buyer over any channel. The seller learns the buyer's deposit only via match-status polling — never on-chain attribution. Service-key-authed.",
    parameters: Type.Object({
      amount: Type.String({
        description:
          "Amount in atomic units (1 USDC = 1000000). Pass as a string to avoid Number precision loss for large values.",
      }),
      network: NetworkSchema,
      validForSeconds: Type.Optional(
        Type.Integer({
          description:
            "Quote TTL in seconds. Default 3600 (1h). Server requires expiry > now + 5 minutes.",
        }),
      ),
      description: Type.Optional(
        Type.String({ description: "Optional short tag, ≤ 100 chars. No PII." }),
      ),
      poolId: Type.Optional(
        Type.String({ description: "Override pool ID. Defaults to network's canonical V4.1 pool." }),
      ),
      sellerEncPk: Type.Optional(
        Type.String({
          description:
            "Solana only. URL-safe base64 X25519 pubkey. Buyers seal the proof bundle for this key so on-chain proof URLs become opaque ciphertext. Optional.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;

      const validForSeconds = (params.validForSeconds as number | undefined) ?? 3600;
      if (validForSeconds <= 5 * 60) {
        return textResult(
          `validForSeconds must be > 300 (5 min). Got ${validForSeconds}.`,
          { error: "expiry_too_soon" },
        );
      }
      const expiry = Math.floor(Date.now() / 1000) + validForSeconds;

      try {
        const draft = await createSprQuote(config, auth.serviceKey, {
          amount: params.amount as string,
          expiry,
          network: params.network as SprNetwork,
          description: params.description as string | undefined,
          poolId: params.poolId as string | undefined,
          sellerEncPk: params.sellerEncPk as string | undefined,
        });

        const issued = await issueSprQuote(config, auth.serviceKey, draft.quoteId, {
          sellerEncPk: params.sellerEncPk as string | undefined,
        });

        const expiryIso = new Date(expiry * 1000).toISOString();
        return textResult(
          `Quote \`${issued.quoteId}\` issued on ${draft.network}.\n` +
            `- amount:    ${issued.amount} (atomic)\n` +
            `- expiry:    ${expiryIso}\n` +
            `- payload:   ${issued.payload ?? "(missing — server bug)"}\n\n` +
            `Hand the payload string to the buyer. NOTHING ELSE in that message.`,
          {
            quoteId: issued.quoteId,
            status: issued.status,
            payload: issued.payload,
            commitment: issued.commitment,
            sellerReceiptId: issued.sellerReceiptId,
            amount: issued.amount,
            expiry,
            network: issued.network,
          },
        );
      } catch (error) {
        return errorResult(error, "Failed to issue SPR quote");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_cancel
// ---------------------------------------------------------------------------

export function createSprCancelTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_cancel",
    description:
      "Cancel an issued SPR quote that has NOT been matched yet. Reverts with 409 once a buyer has paired. Service-key-authed.",
    parameters: Type.Object({ quoteId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;
      try {
        const r = await cancelSprQuote(config, auth.serviceKey, params.quoteId as string);
        return textResult(`Cancelled quote \`${r.quoteId}\`.`, { ...r });
      } catch (error) {
        return errorResult(error, "Failed to cancel SPR quote");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_list
// ---------------------------------------------------------------------------

export function createSprListTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_list",
    description:
      "List SPR quotes owned by the current service key. Includes the bearer payload + sellerReceiptId for each (owner-only fields).",
    parameters: Type.Object({ status: Type.Optional(StatusSchema) }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;
      try {
        const quotes = await listSprQuotes(config, auth.serviceKey, {
          status: params.status as SprStatus | undefined,
        });
        if (quotes.length === 0) {
          return textResult("No SPR quotes for this service key.", { quotes: [] });
        }
        const lines = quotes.map(
          (q) =>
            `- \`${q.quoteId}\` — ${q.status} — ${q.amount} atomic — ${q.network} — expires ${new Date(q.expiry * 1000).toISOString()}`,
        );
        return textResult(`${quotes.length} quote(s):\n${lines.join("\n")}`, { quotes });
      } catch (error) {
        return errorResult(error, "Failed to list SPR quotes");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_get — owner read of a single quote (no payload).
// ---------------------------------------------------------------------------

export function createSprGetTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_get",
    description:
      "Get a single SPR quote owned by the current service key. Excludes the bearer `payload` (use relai_spr_list for owner-only fields).",
    parameters: Type.Object({ quoteId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;
      try {
        const q = await getSprQuote(config, auth.serviceKey, params.quoteId as string);
        return textResult(
          `Quote \`${q.quoteId}\`: ${q.status}\n- amount: ${q.amount}\n- expiry: ${new Date(q.expiry * 1000).toISOString()}\n- network: ${q.network}`,
          { ...q },
        );
      } catch (error) {
        return errorResult(error, "Failed to get SPR quote");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_status — public read; no auth needed.
// ---------------------------------------------------------------------------

export function createSprStatusTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_status",
    description:
      "Read SPR match status for a quote. Public endpoint — opaque quoteId acts as bearer. Returns status (pending / paid / redeemed / refunded / expired / cancelled), the on-chain match snapshot when present, and the seller's pairing-attestation on Solana for offline verification.",
    parameters: Type.Object({ quoteId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const s = await getSprMatchStatus(config, params.quoteId as string);
        const lines: string[] = [
          `Quote \`${s.quoteId}\` on ${s.network}: status=${s.status}`,
        ];
        if (s.expiry) lines.push(`- expiry: ${new Date(s.expiry * 1000).toISOString()}`);
        if (s.match) {
          lines.push(`- matchedAt: ${new Date(s.match.matchedAt * 1000).toISOString()}`);
          lines.push(`- submitter: ${s.match.submitter}`);
        }
        if (s.registryAddress) lines.push(`- registry: ${s.registryAddress}`);
        return textResult(lines.join("\n"), { ...s });
      } catch (error) {
        return errorResult(error, "Failed to read SPR status");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_redeem — full seller-side flow on Solana.
// ---------------------------------------------------------------------------

export function createSprRedeemTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_redeem",
    description:
      "Generate the Groth16 redeem proof for a matched SPR quote and ask the operator to broadcast `payout_to_seller` on Solana (atomic 95% to recipient stealth ATA, 5% operator fee). Service-key-authed for proof input; the relay endpoint itself is public. Solana SPR only.\n\n**Caller must pre-derive the per-quote stealth pubkey externally** — SPR ties the recipient to `sha256(wallet.signMessage('relai-spr-stealth-seller:v1:<quoteId>'))`, which requires the seller's wallet keypair. Plugin convention forbids passing private keys as tool params, so the caller (e.g. examples/spr-demo/lib/redeem-spr.mjs) does the stealth derivation in its own process and hands the resulting public key here.\n\nThis tool DOES NOT cover the second-step `solana-stealth-claim-relay` that hops 95% from the stealth ATA to the seller's main wallet — that needs a partial-signed `transferChecked` tx from the stealth keypair, which also lives outside the plugin.",
    parameters: Type.Object({
      quoteId: Type.String({ description: "Quote to redeem (must be in MATCHED / PAID state)." }),
      recipientStealthPubkey: Type.String({
        description:
          "Solana base58 pubkey of the per-quote stealth recipient. Derive externally via sha256(wallet.signMessage('relai-spr-stealth-seller:v1:<quoteId>')) → Keypair.fromSeed.",
      }),
    }),

    async execute(_id: string, params: Record<string, unknown>, ctx: ToolCtx) {
      const auth = requireServiceKey(ctx);
      if ("content" in auth) return auth;
      try {
        const r = await redeemSprQuote({
          config,
          serviceKey: auth.serviceKey,
          quoteId: params.quoteId as string,
          recipientStealthPubkey: params.recipientStealthPubkey as string,
        });
        return textResult(
          [
            `SPR redeem proof submitted.`,
            ``,
            `quote:        ${r.quoteId}`,
            `status:       ${r.status}`,
            `stealth pk:   ${r.recipientStealthPubkey}`,
            `paid out:     ${r.paidOutMicro} (95% → stealth ATA)`,
            `operator fee: ${r.operatorFeeMicro} (5%)`,
            `payoutTx:     ${r.payoutExplorerUrl || "(no signature on already-redeemed re-relay)"}`,
            ``,
            `Next step: hop ${r.paidOutMicro} micro-USDC from the stealth ATA to your`,
            `main wallet ATA via solana-stealth-claim-relay (operator co-signs as`,
            `fee_payer; the stealth keypair partial-signs locally — see`,
            `examples/spr-demo/lib/redeem-spr.mjs for the canonical implementation).`,
          ].join("\n"),
          { ...r },
        );
      } catch (error) {
        return errorResult(error, "Failed to redeem SPR quote");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_seller_receipt
// ---------------------------------------------------------------------------

export function createSprSellerReceiptTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_seller_receipt",
    description:
      "Look up an SPR seller receipt by `sr_…` opaque ID. Public endpoint (the receipt ID acts as bearer). Cross-party (buyer) fields are server-suppressed.",
    parameters: Type.Object({ receiptId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const r = await getSprSellerReceipt(config, params.receiptId as string);
        return textResult(
          `Seller receipt \`${r.receiptId}\` (quote ${r.quoteId}): status=${r.status}${r.redeemTxHash ? `, redeemTx=${r.redeemTxHash}` : ""}`,
          { ...r },
        );
      } catch (error) {
        return errorResult(error, "Failed to read SPR seller receipt");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_buyer_receipt
// ---------------------------------------------------------------------------

export function createSprBuyerReceiptTool(config: RelaiPluginConfig) {
  return {
    name: "relai_spr_buyer_receipt",
    description:
      "Look up an SPR buyer receipt by `br_…` opaque ID. Public endpoint (the receipt ID acts as bearer). Seller identity is server-suppressed.",
    parameters: Type.Object({ receiptId: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const r = await getSprBuyerReceipt(config, params.receiptId as string);
        return textResult(
          `Buyer receipt \`${r.receiptId}\` (quote ${r.quoteId}): status=${r.status}`,
          { ...r },
        );
      } catch (error) {
        return errorResult(error, "Failed to read SPR buyer receipt");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relai_spr_decode — local payload parse, no network call.
// ---------------------------------------------------------------------------

export function createSprDecodeTool(_config: RelaiPluginConfig) {
  return {
    name: "relai_spr_decode",
    description:
      "Decode a `relai:quote:<base64url>` payload locally (no network call). Returns the structured fields the buyer needs to pair (quoteId, commitment, amount, network, …) and the seller secret material.",
    parameters: Type.Object({ payload: Type.String() }),

    async execute(_id: string, params: Record<string, unknown>) {
      const parsed = parseSprQuotePayload(String(params.payload ?? ""));
      if (!parsed) {
        return textResult("Could not parse payload — malformed or unsupported prefix.", {
          error: "invalid_payload",
        });
      }
      const reEncoded = encodeSprQuotePayload(parsed);
      return textResult(
        `Decoded SPR quote payload (quoteId=${parsed.quoteId}, network=${parsed.network}, amount=${parsed.amount}).`,
        { decoded: parsed, reEncoded },
      );
    },
  };
}
