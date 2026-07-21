#!/usr/bin/env node
// mcp.js — MCP stdio server. Bridges external MCP clients (Claude Code, etc.) to the
// browser through the local relay (brain.js at http://127.0.0.1:7878). Tool execution
// happens in the extension side panel via the no-CDP engine.
//
// SELF-STARTING (Antigravity model): when your MCP client (Claude Code) launches this
// script, it AUTO-STARTS the relay (brain.js) itself if it isn't already running — so you
// never run `node brain.js` by hand. The ONLY thing you must do is keep the extension side
// panel OPEN (the browser is the "hands"; nothing outside Chrome can open it for you).
//
// Add to your MCP client config (e.g. Claude Code ~/.claude.json or .mcp.json):
//   "nocdp-browser": {
//     "command": "node",
//     "args": ["/absolute/path/to/Extention_rev/build/brain/mcp.js"]
//   }
// Then just open the extension side panel — CC boots the rest.

const cp = require("child_process");
const path = require("path");

const BRAIN = "http://127.0.0.1:7878";
const BRAIN_SCRIPT = path.join(__dirname, "brain.js");
const log = (...a) => process.stderr.write("[mcp] " + a.join(" ") + "\n");

// ---- ensure the relay (brain.js) is running; start it ourselves if not ----
let brainChild = null;                 // the brain process WE spawned (null if one was already up)
async function brainAlive() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch(`${BRAIN}/api/mcp_tools`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
async function ensureBrain() {
  if (await brainAlive()) { log("relay already running at " + BRAIN); return; }
  log("starting relay:", BRAIN_SCRIPT);
  // stdout ignored (brain never writes to it — keeps OUR stdout clean for JSON-RPC);
  // stderr inherited so the brain's [brain] logs surface in the MCP client's server log.
  try {
    brainChild = cp.spawn(process.execPath, [BRAIN_SCRIPT], { stdio: ["ignore", "ignore", "inherit"] });
    brainChild.on("error", (e) => log("failed to start relay:", e.message));
    brainChild.on("exit", (code) => { log("relay exited (" + code + ")"); brainChild = null; });
  } catch (e) { log("could not spawn relay:", e.message); return; }
  for (let i = 0; i < 25; i++) {                 // wait up to ~5s for it to accept connections
    await new Promise((r) => setTimeout(r, 200));
    if (await brainAlive()) { log("relay is up"); return; }
  }
  log("relay did not become reachable in ~5s — is the port blocked?");
}
// Kick off startup immediately; tool handlers await this before touching the relay.
const ready = ensureBrain();
// If WE started the relay, take it down with us so we don't leave an orphan process.
function killOurBrain() { if (brainChild) { try { brainChild.kill(); } catch {} brainChild = null; } }
process.on("exit", killOurBrain);
process.on("SIGINT", () => { killOurBrain(); process.exit(0); });
process.on("SIGTERM", () => { killOurBrain(); process.exit(0); });

async function brainTools() {
  await ready;
  const r = await fetch(`${BRAIN}/api/mcp_tools`);
  if (!r.ok) throw new Error("relay /api/mcp_tools HTTP " + r.status + " — is the side panel open?");
  const j = await r.json();
  return j.tools || [];
}
async function brainCall(tool, args) {
  await ready;
  const r = await fetch(`${BRAIN}/api/mcp_call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args: args || {} }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "relay call failed");
  return j.result;
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(e => { if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }); });
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nocdp-browser", version: "1.0" } } });
  } else if (method === "notifications/initialized") {
    /* no response */
  } else if (method === "tools/list") {
    const tools = await brainTools();
    send({ jsonrpc: "2.0", id, result: { tools } });
  } else if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    let result;
    try { result = await brainCall(name, args); }
    catch (e) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "error: " + e.message }], isError: true } }); return; }
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const content = [{ type: "text", text }];
    // If the tool returned an image (e.g. screenshot), emit it as an MCP image content block too.
    if (result.imageData) {
      const data = String(result.imageData).replace(/^data:image\/[a-z]+;base64,/, "");
      const mimeType = (String(result.imageData).match(/data:(image\/[a-z]+);/) || [])[1] || "image/png";
      content.push({ type: "image", data, mimeType });
    }
    send({ jsonrpc: "2.0", id, result: { content, isError: !!result.isError } });
  } else if (method === "resources/list" || method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: method === "resources/list" ? { resources: [] } : { prompts: [] } });
  } else if (id != null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
  }
}

log("MCP stdio server ready — will auto-start the relay at " + BRAIN + " if needed");
