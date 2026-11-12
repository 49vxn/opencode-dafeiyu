#!/usr/bin/env node
// dafeiyu say — let any agent drive the pet without reading its database,
// and without knowing which port its harness is on.
//
//   node say.js running-cmd
//   node say.js long-think --detail "reading the repo"
//   node say.js success --port 8792
//
// The state holds for one minute, then the adapter's own sampling takes over
// again. That is deliberate: push is an accelerator, never a dependency.

const http = require("http");

const PORTS = [8791, 8792, 8793];

function parse(argv) {
  const out = { state: null, detail: null, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--detail" || a === "-d") out.detail = argv[++i];
    else if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (!a.startsWith("-") && !out.state) out.state = a;
  }
  return out;
}

function post(port, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/event", method: "POST", timeout: 1200,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

(async () => {
  const { state, detail, port } = parse(process.argv.slice(2));
  if (!state) {
    console.error("usage: node say.js <state> [--detail text] [--port 8791]");
    process.exit(2);
  }
  const payload = { state };
  if (detail) payload.detail = detail;

  const candidates = port ? [port] : PORTS;
  for (const p of candidates) {
    if (await post(p, payload)) {
      console.log(`said ${state}${detail ? ` (${detail})` : ""} on ${p}`);
      process.exit(0);
    }
  }
  console.error("no dafeiyu hook answered on " + candidates.join(", "));
  process.exit(1);
})();
