// Minimal HTTP bulletin board between the two agent processes.
//
// Endpoints:
//   POST /send         { to, from, body }  → enqueues a message for `to`
//   GET  /poll?as=…    → long-polls (≤ 25s) and returns one message
//   POST /clear?as=…   → drop every queued message for `as` (used by agents at
//                        startup so a re-run doesn't pick up stale messages
//                        from the previous run when the bus stays up across
//                        runs in 3-terminal mode)
//
// Conforms to the blog's framing: "any channel works — Telegram, email, the
// agent's own chat stream". The string the buyer sends is just text; the bus
// has no idea it's a shielded link payload.
//
// Run standalone with `node shared/chat-bus.mjs` or import `startChatBus`.

import http from "node:http";

export function startChatBus({ port = 4747 } = {}) {
  // Per-recipient queues. Each entry: { to, from, body, ts }
  const queues = new Map(); // agentId → message[]
  // Long-poll waiters: agentId → array of { resolve }
  const waiters = new Map(); // agentId → Resolver[]

  function enqueue(msg) {
    const list = queues.get(msg.to) || [];
    list.push(msg);
    queues.set(msg.to, list);

    // Wake up exactly one waiter for this recipient.
    const w = waiters.get(msg.to) || [];
    while (w.length > 0 && (queues.get(msg.to) || []).length > 0) {
      const next = w.shift();
      const m = (queues.get(msg.to) || []).shift();
      if (m) next.resolve(m);
    }
    waiters.set(msg.to, w);
  }

  function dequeue(to, timeoutMs) {
    const queue = queues.get(to) || [];
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve) => {
      const list = waiters.get(to) || [];
      const w = { resolve };
      list.push(w);
      waiters.set(to, list);
      setTimeout(() => {
        const idx = list.indexOf(w);
        if (idx >= 0) list.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "POST" && url.pathname === "/send") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const { to, from, body } = JSON.parse(raw);
          if (!to || !from || typeof body !== "string") throw new Error("bad request");
          const msg = { to, from, body, ts: Date.now() };
          enqueue(msg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ts: msg.ts }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (err).message }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      const as = url.searchParams.get("as");
      if (!as) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing ?as=<agentId>" }));
        return;
      }
      const msg = await dequeue(as, 25_000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: msg }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/clear") {
      const as = url.searchParams.get("as");
      if (!as) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing ?as=<agentId>" }));
        return;
      }
      const dropped = (queues.get(as) || []).length;
      queues.set(as, []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dropped }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[chat-bus] listening on http://localhost:${port}`);
      resolve({ server, port, close: () => server.close() });
    });
  });
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CHAT_BUS_PORT || 4747);
  startChatBus({ port }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
