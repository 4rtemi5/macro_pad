#!/usr/bin/env node
/**
 * Minimal macro-pad JSON-RPC CLI client — also serves as a reference
 * implementation for external scripts (see PROTOCOL.md).
 *
 * Usage:
 *   node scripts/cli.mjs info
 *   node scripts/cli.mjs state
 *   node scripts/cli.mjs press <id>
 *   node scripts/cli.mjs set <id> <jsonPatch>     e.g. set 8 '{"color":"#00c853","glow":"breathing"}'
 *   node scripts/cli.mjs call <method> [jsonParams]
 *   node scripts/cli.mjs listen                   (print notifications until Ctrl-C)
 *
 * Server URL: MACRO_PAD_WS env var, default ws://localhost:8787/rpc
 */
import WebSocket from "ws";

const base = process.env.MACRO_PAD_WS ?? "ws://127.0.0.1:8787/rpc";
const token = process.env.MACRO_PAD_TOKEN;
const url =
  token && !base.includes("token=")
    ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
    : base;
const [cmd, ...args] = process.argv.slice(2);

if (!cmd) {
  console.error("usage: cli.mjs <info|state|press|set|call|listen> ...");
  process.exit(2);
}

const ws = new WebSocket(url);
let nextId = 0;
const pending = new Map();

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.method) {
    console.log(`[notify] ${msg.method} ${JSON.stringify(msg.params)}`);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) {
    console.error(`[error ${msg.error.code}] ${msg.error.message}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(msg.result, null, 2));
  }
  p();
});

ws.on("error", (err) => {
  console.error(`connection failed: ${err.message}`);
  process.exit(1);
});

function call(method, params) {
  return new Promise((done) => {
    const id = ++nextId;
    pending.set(id, done);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? null, id }));
  });
}

ws.on("open", async () => {
  switch (cmd) {
    case "info":
      await call("pad.info");
      break;
    case "state":
      await call("pad.getState");
      break;
    case "press":
      await call("button.press", { id: Number(args[0]) });
      break;
    case "set":
      await call("button.setState", { id: Number(args[0]), ...JSON.parse(args[1] ?? "{}") });
      break;
    case "call":
      await call(args[0], args[1] ? JSON.parse(args[1]) : null);
      break;
    case "listen":
      console.log(`listening on ${url} — Ctrl-C to quit`);
      return; // never resolve; run until killed
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
  // linger briefly so notifications triggered by the call are printed
  setTimeout(() => process.exit(process.exitCode ?? 0), 600);
});
