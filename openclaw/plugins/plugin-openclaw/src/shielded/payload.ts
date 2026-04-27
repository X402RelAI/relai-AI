// Parse `relai:shielded:<base64url>` payloads — seller-side only.
//
// The plugin never EMITS payloads (that's the buyer's off-plugin job). It only
// parses incoming strings into `{ linkId, note }` so the seller's redeem flow
// can read what the buyer sent.

import type { ShieldedNote } from "./note.js";

const PREFIXES = ["relai:shielded:", "shielded:", "s:"] as const;

function fromBase64Url(token: string): string {
  return Buffer.from(token, "base64url").toString("utf8");
}

function extractToken(input: string): string | null {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || null;
  }
  try {
    const u = new URL(trimmed);
    const direct = u.searchParams.get("shielded");
    if (direct) return direct.trim() || null;
    const hash = u.hash.replace(/^#/, "");
    if (hash.startsWith("shielded=")) {
      return decodeURIComponent(hash.slice("shielded=".length)).trim() || null;
    }
    for (const prefix of PREFIXES) {
      if (hash.toLowerCase().startsWith(prefix)) return hash.slice(prefix.length).trim() || null;
    }
  } catch {
    // not a URL
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

export function parseShieldedPayload(
  input: string,
): { linkId: string; note: ShieldedNote & { programId?: string } } | null {
  const token = extractToken(input);
  if (!token) return null;
  const json = token.startsWith("{") ? token : fromBase64Url(token);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const linkId = String((raw as Record<string, unknown>).linkId ?? raw.l ?? "").trim();
  const secret = String((raw as Record<string, unknown>).secret ?? raw.s ?? "").trim();
  const poolId = String((raw as Record<string, unknown>).poolId ?? raw.p ?? "").trim();
  const denomination = String(
    (raw as Record<string, unknown>).denomination ?? raw.d ?? "",
  ).trim();
  if (!linkId || !secret || !poolId || !denomination) return null;

  return {
    linkId,
    note: {
      version: Number(raw.v ?? 1) || 1,
      poolId,
      assetId: String((raw as Record<string, unknown>).assetId ?? raw.a ?? "").trim() || undefined,
      denomination,
      network: String((raw as Record<string, unknown>).network ?? raw.w ?? "").trim() || undefined,
      secret,
      blinding: String((raw as Record<string, unknown>).blinding ?? raw.b ?? "").trim(),
      nonce: String((raw as Record<string, unknown>).nonce ?? raw.n ?? "").trim(),
      programId: String((raw as Record<string, unknown>).programId ?? raw.g ?? "").trim() || undefined,
    },
  };
}
