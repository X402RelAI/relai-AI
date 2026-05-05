// Chat-bus tool definitions shared by both agents. `send_message` posts to the
// bus; `wait_for_message` long-polls until something arrives.

const POLL_TIMEOUT_MS = 28_000;

/**
 * Drop every message queued for `selfId` on the chat bus. Call once at agent
 * startup so a fresh run doesn't pick up stale messages from a previous run
 * — only matters in 3-terminal mode where the bus stays up across runs.
 * Returns the number of messages dropped.
 */
export async function clearInbox({ busUrl, selfId, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${busUrl}/clear?as=${encodeURIComponent(selfId)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`chat-bus /clear → ${res.status}`);
  const json = await res.json();
  return Number(json.dropped ?? 0);
}

export function makeChatTools({ busUrl, selfId, peerId, fetchImpl = globalThis.fetch }) {
  return [
    {
      name: "send_message",
      description:
        `Send a plain-text message to the other agent (${peerId}) over the chat bus. ` +
        `Use for negotiation, quoting, and handing off the shielded payment payload. ` +
        `The bus has no idea what the message contains — treat it like a public IM channel.`,
      input_schema: {
        type: "object",
        properties: {
          body: {
            type: "string",
            description:
              "The full message text. Send only one shielded payload per message — bundle nothing else with it.",
          },
        },
        required: ["body"],
      },
      async run({ body }) {
        const res = await fetchImpl(`${busUrl}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: peerId, from: selfId, body }),
        });
        if (!res.ok) throw new Error(`chat-bus /send → ${res.status}`);
        const json = await res.json();
        return { ok: true, ts: json.ts };
      },
    },
    {
      name: "wait_for_message",
      description:
        `Wait for the next inbound message from the other agent. Long-polls up to ${POLL_TIMEOUT_MS / 1000}s. ` +
        `Returns the message body if one arrives, or {timeout: true} if the wait window expired ` +
        `(call again to keep waiting). Do NOT call this in a tight loop — call it once and react ` +
        `to the result.`,
      input_schema: {
        type: "object",
        properties: {},
      },
      async run() {
        const res = await fetchImpl(`${busUrl}/poll?as=${encodeURIComponent(selfId)}`);
        if (!res.ok) throw new Error(`chat-bus /poll → ${res.status}`);
        const json = await res.json();
        if (!json.message) return { timeout: true };
        return { from: json.message.from, body: json.message.body, ts: json.message.ts };
      },
    },
  ];
}
