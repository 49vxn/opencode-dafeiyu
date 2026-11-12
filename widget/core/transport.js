// Shared transport for the dafeiyu adapters.
//
// Owns the parts every adapter needs and none of them should re-implement:
//   - the atomic state write (tmp + rename, one retry for a busy file)
//   - the loopback HTTP surface: /state, /events, CORS allowlist
//   - the watch loop: sample -> smooth -> dedupe -> write -> broadcast
//
// It knows nothing about coding agents. An adapter supplies sample(smoother)
// and a signature function; that is the whole contract.

const fs = require("fs");
const http = require("http");
const path = require("path");

function corsFor(req) {
  const o = req.headers.origin;
  const ok =
    typeof o === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const h = { "Cache-Control": "no-store" };
  if (ok) {
    h["Access-Control-Allow-Origin"] = o;
    h.Vary = "Origin";
  }
  return h;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // A scanner or indexer briefly holding the target is the usual cause;
    // pause 25ms and try once more before giving up this tick.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    fs.renameSync(tmp, file);
  }
}

function runWatch({ tag, port, file, pollMs, sample, Smoother, sig, onEvent }) {
  const smoother = new Smoother();
  const signature = sig || ((p) => p.state + "|" + (p.detail || ""));
  const clients = new Set();
  let latest = null;
  let lastLogged = null;
  let lastSig = null;
  let lastWrite = 0;
  let lastWriteWarn = 0;
  let pushed = null; // { state, detail, ts } from POST /event

  const broadcast = (payload) => {
    const frame = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  const publish = (payload) => {
    latest = payload;
    broadcast(payload);
    const s = signature(payload);
    const n = Date.now();
    if (s !== lastSig || n - lastWrite > 3000) {
      lastSig = s;
      lastWrite = n;
      try {
        writeAtomic(file, payload);
      } catch (err) {
        if (n - lastWriteWarn > 30000) {
          lastWriteWarn = n;
          console.error(`${tag} state file busy (${err.message})`);
        }
      }
    }
    if (payload.state !== lastLogged) {
      lastLogged = payload.state;
      console.log(`${tag} ${String(payload.state).padEnd(14)} ${payload.detail ?? ""}`);
    }
  };

  const server = http.createServer((req, res) => {
    const cors = corsFor(req);
    // Harnesses that can run a shell hook push their own events here. The
    // adapter decides what an event means; the transport only carries it.
    if (req.method === "POST" && req.url === "/event") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => {
        try {
          const ev = JSON.parse(body);
          if (onEvent) onEvent(ev);
          else if (ev && typeof ev.state === "string") pushed = { state: ev.state, detail: ev.detail, id: ev.id, ts: Date.now() };
        } catch (err) {
          console.error(`${tag} event dropped:`, err.message);
        }
        res.writeHead(204, cors);
        res.end();
      });
      return;
    }
    if (req.url === "/state") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(latest ?? { state: "idle", ts: Date.now() }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        ...cors,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write("retry: 1000\n\n");
      if (latest) res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, cors);
    res.end("dafeiyu hook: try /state or /events" + (onEvent ? " (POST /event for hooks)" : "") + "\n");
  });

  server.on("error", (err) => {
    console.error(`${tag} HTTP ${port}: ${err.message}`);
    if (err.code === "EADDRINUSE") process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`${tag} http://127.0.0.1:${port}/state`);
  });

  const tick = () => {
    try {
      // A pushed state wins for one minute, then the adapter's own sampling
      // takes over again. Push is an accelerator, never a dependency.
      if (pushed && Date.now() - pushed.ts < 60000) {
        const base = sample(smoother);
        // Cells read their own agent state, so the override has to reach the
        // agent too — the pushed one by id, otherwise the first live one.
        const agents = Array.isArray(base.agents)
          ? base.agents.map((a) => ({ ...a }))
          : base.agents;
        if (Array.isArray(agents) && agents.length) {
          let i = pushed.id ? agents.findIndex((a) => a.id === pushed.id) : 0;
          if (i < 0) i = 0;
          agents[i] = { ...agents[i], state: pushed.state, running: true };
        }
        publish({ ...base, state: pushed.state, detail: pushed.detail ?? base.detail, agents, pushed: true });
      } else {
        publish(sample(smoother));
      }
    } catch (err) {
      console.error(`${tag} tick failed:`, err.message);
    }
  };

  tick();
  setInterval(tick, pollMs);
  return { publish, server };
}

module.exports = { corsFor, writeAtomic, runWatch };
