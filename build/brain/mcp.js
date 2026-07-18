#!/usr/bin/env node
// mcp.js — MCP stdio server. Bridges external MCP clients (Claude Code, etc.)
// to the browser through the local brain (http://127.0.0.1:7878). Tool execution
// happens in the extension side panel via the no-CDP engine, so the side panel
// must be open while an external client is driving the browser.
//
// Add to your MCP client config (e.g. Claude Code ~/.claude.json or .mcp.json):
//   "nocdp-browser": {
//     "command": "node",
//     "args": ["/absolute/path/to/Extention_rev/build/brain/mcp.js"]
//   }

const BRAIN = "http://127.0.0.1:7878";
const log = (...a) => process.stderr.write("[mcp] " + a.join(" ") + "\n");

async function brainTools() {
  const r = await fetch(`${BRAIN}/api/mcp_tools`);
  if (!r.ok) throw new Error("brain /api/mcp_tools HTTP " + r.status + " — is the brain running?");
  const j = await r.json();
  return j.tools || [];
}
async function brainCall(tool, args) {
  const r = await fetch(`${BRAIN}/api/mcp_call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args: args || {} }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "brain call failed");
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

log("MCP stdio server ready — bridges to brain at " + BRAIN);