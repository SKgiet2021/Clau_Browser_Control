// brain.js — the agent brain. Zero-dependency Node (18+ for fetch).
// Architecture (Antigravity-style, no CDP, no native messaging):
//   sidepanel (chat + tool executor) <--SSE/POST--> brain (LLM loop)
// Brain calls the LLM with your key, decides actions, asks the sidepanel to
// execute them (no-CDP), gets results, loops, streams the answer back.
//
// Run:  node build/brain/brain.js
// Then open the extension side panel, configure a provider, and chat.

const http = require("http");
const crypto = require("crypto");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 7878;

// sessionId -> { history, provider, model, pendingTools:Map(id->resolve), abort }
const sessions = new Map();
// sessionId -> SSE response
const sse = new Map();
// external MCP relay: side-panel control channel + pending tool calls
let mcpClient = null;
const mcpPending = new Map();

const log = (...a) => console.error("[brain]", ...a);

function sendEvent(sessionId, obj) {
  const res = sse.get(sessionId);
  if (res) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} }
}

// ---------- our no-CDP tool definitions ----------
const TOOLS = [
  { name: "read_page", desc: "Get the visible text content of a page (and a simplified element list with indices). Use to see what's on the page.",
    schema: { type: "object", properties: { tabId: { type: "number", description: "optional: target tab. Defaults to the side panel's attached tab." } }, additionalProperties: false } },
  { name: "click", desc: "Click at coordinates (x,y) in the viewport. button: left|right|middle (default left).",
    schema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, tabId: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "type", desc: "Type text into a form field. Provide a CSS selector for the input/textarea/contenteditable element, and the text to type (replaces existing content).",
    schema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "text"], additionalProperties: false } },
  { name: "press_key", desc: "Press a key or key combo, e.g. 'Enter', 'Tab', 'Control+Enter', 'Backspace'.",
    schema: { type: "object", properties: { key: { type: "string" }, tabId: { type: "number" } }, required: ["key"], additionalProperties: false } },
  { name: "scroll", desc: "Scroll a page. dx,dy are pixel deltas (dy positive = down).",
    schema: { type: "object", properties: { dx: { type: "number" }, dy: { type: "number" }, tabId: { type: "number" } }, additionalProperties: false } },
  { name: "navigate", desc: "Navigate a tab to a URL. Use tabId to target a specific tab; otherwise the attached tab.",
    schema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "number" } }, required: ["url"], additionalProperties: false } },
  { name: "get_text", desc: "Get the innerText of an element matching a CSS selector.",
    schema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"], additionalProperties: false } },
  { name: "eval", desc: "Run JavaScript in a page (MAIN world) and return the JSON-serializable result. Use for clicking site-specific buttons (Run/Submit/Next), reading results, or driving editors.",
    schema: { type: "object", properties: { code: { type: "string" }, tabId: { type: "number" } }, required: ["code"], additionalProperties: false } },
  { name: "list_tabs", desc: "List all open browser tabs (id, title, url, active, windowId). Use to discover tabs to read/control.",
    schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "new_tab", desc: "Open a new tab and load a URL. Returns the new tab id. active:false opens it in the background.",
    schema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean" } }, required: ["url"], additionalProperties: false } },
  { name: "switch_tab", desc: "Focus/activate a tab by id.",
    schema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"], additionalProperties: false } },
  { name: "close_tab", desc: "Close a tab by id.",
    schema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"], additionalProperties: false } },
  { name: "attached_file", desc: "Get metadata (and extracted text for text files) of the file the user attached in the composer. No args.",
    schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "upload_file", desc: "Set a page's <input type=file> (matching a CSS selector, default 'input[type=file]') to the attached file, then dispatch change. Use after confirming a file is attached.",
    schema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, additionalProperties: false } },
  // Browser-level trusted input via chrome.debugger + CDP (Input.dispatch*). These fire
  // isTrusted:true events — indistinguishable from a real human at the browser level, so
  // anti-cheat/exam sites CANNOT block them. No OS Accessibility, no cliclick. Fallback for
  // when the no-CDP 'click'/'type' (synthetic, isTrusted:false) has no effect.
  // NOTE: first real_* call attaches the debugger and Chrome shows a "debugging" banner
  // on that tab — expected, and the tradeoff for trusted input. It stays until the tab
  // is closed or you stop using real_*.
  { name: "real_click", desc: "Trusted browser-level mouse click at viewport (x,y). Uses real DevTools (CDP) input — isTrusted:true, so sites can't block it. Fallback when 'click' has no effect. button: left|right|double (default left).",
    schema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, tabId: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "real_move", desc: "Move the trusted (CDP) mouse cursor to viewport (x,y) without clicking.",
    schema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "real_type", desc: "Type text into a form field using trusted (CDP) keyboard input (isTrusted:true). Focus the field by selector (or by x,y coordinate), select-all + delete to REPLACE existing content, then type the text. Unblocks sites that block synthetic input.",
    schema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["text"], additionalProperties: false } },
  { name: "real_key", desc: "Press a key/combo using trusted (CDP) keyboard: 'Enter','Tab','Backspace','Esc','arrow-up','Cmd+V','Control+Enter'. isTrusted:true.",
    schema: { type: "object", properties: { key: { type: "string" }, tabId: { type: "number" } }, required: ["key"], additionalProperties: false } },
  { name: "real_scroll", desc: "Trusted (CDP) mouse-wheel scroll. dx,dy are pixel deltas (dy positive = down). Optional x,y is the scroll anchor (default viewport center).",
    schema: { type: "object", properties: { dx: { type: "number" }, dy: { type: "number" }, x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, additionalProperties: false } },
  { name: "screenshot", desc: "Capture the current page as an image and return it to you (vision models only). Coordinates are image pixels, top-left origin (0,0); the image width/height are returned with the image. Use this to SEE the page, find elements by sight, and click by coordinates. Call it before and after acting to verify results.",
    schema: { type: "object", properties: { tabId: { type: "number" } }, additionalProperties: false }, image: true },
  { name: "get_cookies", desc: "List cookies for a URL or domain. Provide either 'url' or 'domain'.",
    schema: { type: "object", properties: { url: { type: "string" }, domain: { type: "string" } }, additionalProperties: false } },
  { name: "set_cookie", desc: "Set a cookie. Requires url, name, value; optional domain, path.",
    schema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, value: { type: "string" }, domain: { type: "string" }, path: { type: "string" } }, required: ["url", "name", "value"], additionalProperties: false } },
  { name: "delete_cookie", desc: "Delete a cookie by url + name.",
    schema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" } }, required: ["url", "name"], additionalProperties: false } },
  { name: "list_network", desc: "List recent network requests observed (method, url, status, type). No args.",
    schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_network_request", desc: "Get details of one network request by id (request body, response headers).",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "set_request_header", desc: "Set/override a request header on matching requests. urlFilter is a wildcard pattern e.g. '*example.com*'.",
    schema: { type: "object", properties: { urlFilter: { type: "string" }, header: { type: "string" }, value: { type: "string" } }, required: ["urlFilter", "header", "value"], additionalProperties: false } },
  { name: "block_url", desc: "Block requests matching a urlFilter wildcard pattern.",
    schema: { type: "object", properties: { urlFilter: { type: "string" } }, required: ["urlFilter"], additionalProperties: false } },
  { name: "clear_net_rules", desc: "Clear all custom network rules (headers/blocks) added this session. No args.",
    schema: { type: "object", properties: {}, additionalProperties: false } },
];

function toolsForLLM(style, vision) {
  const usable = TOOLS.filter(t => !t.image || vision);
  if (style === "anthropic") return usable.map(t => ({ name: t.name, description: t.desc, input_schema: t.schema }));
  return usable.map(t => ({ type: "function", function: { name: t.name, description: t.desc, parameters: t.schema } }));
}

const SYSTEM_PROMPT = `You are an autonomous browser agent operating inside a Chrome side panel. You control the user's current tab via tools — clicking, typing, reading the page, running JS. You drive the page like a human (real DOM events, no debugger attached), so act naturally.
For multi-step tasks (e.g. "solve all 15 questions"), work through them one at a time: read the page, decide the next action, call ONE tool, observe the result, repeat. Don't try to do everything in one tool call.
For coding questions: read the question, write the code into the site's code editor (use 'type' with the editor's selector, or 'eval' to drive Monaco/CodeMirror), click the site's Run button (use 'eval' to find and click it, e.g. document.querySelector('button.run').click()), read the output, match it to the expected output shown in the question, then click Submit, then Next. For MCQs: pick the option and click Submit.
You also have DevTools tools: get_cookies/set_cookie/delete_cookie for cookies, list_network/get_network_request to inspect network traffic, and set_request_header/block_url/clear_net_rules to intercept or modify requests. Use them when the task needs cookies or network control.
When solving a series of questions on a test/homework page: after Submitting one question and clicking Next, immediately call read_page to load the next question and keep going — do NOT stop to ask the user until every question is done or you hit an unrecoverable error. If code output doesn't match the expected output shown in the question, fix the code and re-run before submitting. If Run/Submit/Next buttons have unusual selectors, find them with eval (e.g. [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Submit')). Keep track of which question number you are on and report progress briefly between questions.
You can control MULTIPLE tabs: use list_tabs to see open tabs, new_tab to open a URL in a new tab, switch_tab to focus one, close_tab to close one. Most page tools (read_page, click, type, press_key, scroll, navigate, get_text, eval, upload_file) accept an optional tabId to target a specific tab; if omitted they act on the side panel's attached tab. Use multiple tabs to compare pages or research across sites.
The user can attach a file (e.g. a resume) in the composer — use attached_file to read its metadata and extracted text, and upload_file to set a site's <input type=file> to it (e.g. uploading a resume to a job application form). Then submit the form normally.
The user can also snip a screen region (✂) or attach an image — for vision models it is sent as an image to you; for non-vision models it is noted as text.
VISION / COMPUTER-USE: if your model has vision, call 'screenshot' to see the current page as an image. Coordinates are image pixels from the top-left (0,0); the image width/height come back with the image. Use it to find elements by sight, then click by coordinates with 'click' (or 'real_click' for stubborn sites), then screenshot again to verify. 'read_page' also returns the viewport size and a list of interactive elements with their (x,y) centers — use either. For non-vision models, rely on 'read_page' instead of screenshots.
TRUSTED-INPUT FALLBACK: 'click'/'type'/'press_key' use synthetic DOM events (isTrusted:false), which some sites (exam/anti-cheat) ignore. If a click/type has no visible effect, fall back to the real_* tools — real_click / real_type / real_key / real_scroll / real_move. They drive Chrome at the DevTools (CDP) level with genuine isTrusted:true mouse & keyboard events that sites CANNOT distinguish from a human. To type this way: real_click the field (focuses it), then real_type the text (or pass a selector to real_type). real_* take viewport (x,y) like 'click'. The first real_* call attaches the debugger and Chrome shows a "debugging" banner on that tab — that is expected and harmless. Try DOM tools first; fall back to real_* only when they don't work.
Always use 'read_page' first to see the current state. Prefer 'eval' for site-specific buttons (Run/Submit/Next) when you know the selector. Be concise.
HARD-BLOCKED PAGES (Chrome Web Store at chromewebstore.google.com, and chrome:// pages): Chrome forbids ALL extension control on these pages — content scripts, chrome.scripting, AND the chrome.debugger/CDP layer are all refused by the browser. That means click/type/eval/read_page/screenshot AND real_click/real_type/real_scroll will ALL fail here. This is a Chrome security restriction that NO extension can bypass (only a full browser like Comet can). If you detect you are on the Web Store or a chrome:// page and a tool reports it's blocked, DO NOT keep retrying other tools — briefly tell the user this page is hard-blocked by Chrome for extensions and ask them to test on a normal site (or use browser-level CDP mode if available). Everywhere else (normal websites) all tools work.`;

// ---------- LLM call (streaming) ----------
// Streams text deltas to the sidepanel via sendEvent; returns assembled assistant message + tool uses.
async function callLLMStream(sessionId, provider, model, history, tools, effort) {
  const base = ensureV1(provider.baseUrl);
  const headers = provider.style === "anthropic"
    ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { Authorization: "Bearer " + provider.apiKey, "content-type": "application/json" };
  const vision = !!model.vision;

  if (provider.style === "anthropic") {
    const url = base + "/messages";
    const body = { model: model.id, max_tokens: 8192, system: SYSTEM_PROMPT, messages: history.map(m => ({ role: m.role, content: fmtContent(m, "anthropic", vision) })), tools, stream: true };
    applyEffort(body, "anthropic", model.id, effort);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("Anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", cur = null; const content = []; const toolUses = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (!d || d === "[DONE]") continue;
        let ev; try { ev = JSON.parse(d); } catch { continue; }
        if (ev.type === "content_block_start") { const b = ev.content_block; cur = { type: b.type, id: b.id, name: b.name, text: "", input: "" }; }
        else if (ev.type === "content_block_delta") {
          const dt = ev.delta;
          if (dt.type === "text_delta") { cur.text += dt.text; sendEvent(sessionId, { type: "text", delta: dt.text }); }
          else if (dt.type === "input_json_delta") cur.input += dt.partial_json;
        }
        else if (ev.type === "content_block_stop") {
          if (!cur) continue;
          if (cur.type === "text") content.push({ type: "text", text: cur.text });
          else if (cur.type === "tool_use") { let input = {}; try { input = JSON.parse(cur.input || "{}"); } catch {} toolUses.push({ id: cur.id, tool: cur.name, args: input }); content.push({ type: "tool_use", id: cur.id, name: cur.name, input }); }
          cur = null;
        }
      }
    }
    return { assistantMsg: { role: "assistant", content }, toolUses };
  } else {
    const url = base + "/chat/completions";
    const body = { model: model.id, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.map(m => { const out = { role: m.role, content: fmtContent(m, "openai", vision) }; if (m.tool_calls) out.tool_calls = m.tool_calls; if (m.tool_call_id) out.tool_call_id = m.tool_call_id; return out; })], tools, tool_choice: "auto", stream: true };
    applyEffort(body, "openai", model.id, effort);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("OpenAI HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", contentText = ""; const tcMap = new Map();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (!d || d === "[DONE]") continue;
        let ev; try { ev = JSON.parse(d); } catch { continue; }
        const delta = ev.choices?.[0]?.delta; if (!delta) continue;
        if (delta.content) { contentText += delta.content; sendEvent(sessionId, { type: "text", delta: delta.content }); }
        if (delta.tool_calls) for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0; let e = tcMap.get(idx); if (!e) { e = { id: tc.id, tool: "", args: "" }; tcMap.set(idx, e); }
          if (tc.function?.name) e.tool = tc.function.name;
          if (tc.function?.arguments) e.args += tc.function.arguments;
        }
      }
    }
    const toolUses = [...tcMap.values()].map(e => { let args = {}; try { args = JSON.parse(e.args || "{}"); } catch {} return { id: e.id, tool: e.tool, args }; });
    const assistantMsg = { role: "assistant", content: contentText, ...(toolUses.length ? { tool_calls: toolUses.map(tc => ({ id: tc.id, type: "function", function: { name: tc.tool, arguments: JSON.stringify(tc.args) } })) } : {}) };
    return { assistantMsg, toolUses };
  }
}

function pushToolResult(history, style, toolUse, content, imageData) {
  if (style === "anthropic") {
    const trContent = imageData
      ? [{ type: "image", source: { type: "base64", media_type: (String(imageData).match(/data:(image\/[a-z]+);/) || [])[1] || "image/png", data: String(imageData).replace(/^data:image\/[a-z]+;base64,/, "") } }, { type: "text", text: String(content) }]
      : content;
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: trContent }] });
  } else {
    history.push({ role: "tool", tool_call_id: toolUse.id, content: String(content) });
    // OpenAI tool messages can't carry images; runLoop appends a single user(image) message
    // AFTER all tool results of this turn so tool messages stay contiguous (else OpenAI 400s).
  }
}

// ---------- agent loop ----------
async function runLoop(sessionId) {
  const sess = sessions.get(sessionId);
  const { provider, model, effort } = sess;
  if (!provider || !model) { sendEvent(sessionId, { type: "error", message: "No provider/model configured." }); return; }
  const vision = !!model.vision;
  const tools = toolsForLLM(provider.style, vision);
  let turns = 0;
  while (!sess.abort && turns++ < 120) {
    sendEvent(sessionId, { type: "thinking" });
    let resp;
    try { resp = await callLLMStream(sessionId, provider, model, sess.history, tools, effort); }
    catch (e) { sendEvent(sessionId, { type: "error", message: "LLM error: " + e.message }); break; }
    sess.history.push(resp.assistantMsg);
    if (!resp.toolUses.length) { sendEvent(sessionId, { type: "done" }); break; }
    const turnImages = [];
    for (const tu of resp.toolUses) {
      sendEvent(sessionId, { type: "tool_call", id: tu.id, tool: tu.tool, args: tu.args });
      const result = await new Promise(res => sess.pendingTools.set(tu.id, res));
      const content = (typeof result.content === "string" ? result.content : JSON.stringify(result.content));
      const img = vision ? result.imageData : null;
      pushToolResult(sess.history, provider.style, tu, content, img);
      if (img) turnImages.push(img);
    }
    // After all tool results are contiguous, append one combined user(image) turn for OpenAI vision
    // so the model sees any screenshots before the next assistant turn.
    if (provider.style !== "anthropic" && turnImages.length) {
      sess.history.push({ role: "user", content: [{ type: "text", text: "(screenshot image(s) returned by the tool call(s) above)" }, ...turnImages.map(d => ({ type: "image_url", image_url: { url: String(d) } }))] });
    }
  }
  if (turns > 120) sendEvent(sessionId, { type: "error", message: "Turn limit reached (120). Task may be incomplete." });
}

function ensureV1(b) { b = (b || "").trim().replace(/\/+$/, ""); if (/\/v\d+$/i.test(b)) return b; return b + "/v1"; }
function modelsUrlOf(p) { return ensureV1(p.baseUrl) + "/models"; }
function authHeadersOf(p) {
  if (p.style === "anthropic") return { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  return { Authorization: "Bearer " + p.apiKey, "content-type": "application/json" };
}
async function fetchProviderModels(p) {
  const res = await fetch(modelsUrlOf(p), { headers: authHeadersOf(p) });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
  const json = await res.json();
  return (Array.isArray(json?.data) ? json.data : []).map(m => m.id || m.name).filter(Boolean).sort();
}

// ---------- reasoning effort (Low/Medium/High) ----------
function applyEffort(body, style, modelId, level) {
  if (!level || level === "off") return body;
  const m = String(modelId || "").toLowerCase();
  if (style === "anthropic") {
    if (/(opus-4-[678]|sonnet-4-6|sonnet-5|fable-5)/.test(m)) { body.thinking = { type: "adaptive" }; body.output_config = { effort: level }; }
    else if (/(opus-4-(1|5)|haiku-4-5|sonnet-4|3-7-sonnet)/.test(m)) {
      const budgets = { low: 2048, medium: 10000, high: 31999 };
      const b = budgets[level] || 10000;
      body.thinking = { type: "enabled", budget_tokens: b };
      body.max_tokens = Math.max(body.max_tokens || 8192, b + 8192);
    }
  } else {
    if (/^(o1|o3|o4|gpt-5)/.test(m)) body.reasoning_effort = level;
  }
  return body;
}

// ---------- image content formatting (snip / image attachments) ----------
function fmtContent(msg, style, vision) {
  const c = msg.content;
  if (c && typeof c === "object" && !Array.isArray(c) && c.image) {
    const text = c.text || "";
    if (!vision) return text + "\n\n[Attached image omitted — selected model has no vision.]";
    if (style === "anthropic") {
      const mt = (String(c.image).match(/data:(image\/[a-z]+);/) || [])[1] || "image/png";
      return [{ type: "image", source: { type: "base64", media_type: mt, data: String(c.image).replace(/^data:image\/[a-z]+;base64,/, "") } }, { type: "text", text }];
    }
    return [{ type: "text", text }, { type: "image_url", image_url: { url: String(c.image) } }];
  }
  return c;
}

// ---------- OS-level input (cliclick on macOS) ----------
const BROWSER_APP = "Google Chrome";
const SCROLL_SWIFT = path.join(__dirname, "scroll.swift");
const SCROLL_BIN = path.join(__dirname, "scroll_bin");
function cliclick(cmds) {
  try { return cp.execFileSync("cliclick", cmds, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error("cliclick not installed. Install with: brew install cliclick");
    const stderr = String(e.stderr || "");
    if (/Accessibility privileges not enabled/.test(stderr)) throw new Error("macOS Accessibility permission missing. Grant it: System Settings > Privacy & Security > Accessibility > add the app running the brain (Terminal/iTerm/etc.), then retry.");
    throw new Error("cliclick failed: " + (stderr || e.message));
  }
}
function focusChrome() { try { cp.execFileSync("osascript", ["-e", `tell application "${BROWSER_APP}" to activate`], { stdio: "ignore" }); } catch {} }
const CLICLICK_KEYS = { enter: "return", return: "return", tab: "tab", backspace: "delete", delete: "fwd-delete", esc: "esc", escape: "esc", space: "space", up: "arrow-up", down: "arrow-down", left: "arrow-left", right: "arrow-right", home: "home", end: "end", pageup: "pageup", pagedown: "pagedown" };
function keyToCliclick(key) {
  const parts = String(key || "").split("+").map(p => p.trim());
  const main = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const modMap = { cmd: "cmd", command: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };
  const modNames = mods.map(m => modMap[m.toLowerCase()]).filter(Boolean);
  const named = CLICLICK_KEYS[String(main).toLowerCase()];
  const cmds = [];
  for (const m of modNames) cmds.push("kd:" + m);
  if (named) cmds.push("kp:" + named); else cmds.push("t:" + main);
  for (let i = modNames.length - 1; i >= 0; i--) cmds.push("ku:" + modNames[i]);
  return cmds;
}
function ensureScrollBin() {
  try { if (!fs.existsSync(SCROLL_BIN) && fs.existsSync(SCROLL_SWIFT)) cp.execFileSync("swiftc", [SCROLL_SWIFT, "-o", SCROLL_BIN], { stdio: "ignore" }); } catch {}
}
function osScroll(dy) {
  const arg = String(-(dy || 0));
  try { if (fs.existsSync(SCROLL_BIN)) cp.execFileSync(SCROLL_BIN, [arg], { stdio: "ignore" }); else cp.execFileSync("swift", [SCROLL_SWIFT, arg], { stdio: "ignore" }); }
  catch (e) { throw new Error("scroll failed (needs Xcode Command Line Tools / 'swift'): " + e.message); }
}
function osExec(body) {
  const op = body.op;
  if (op === "move") { cliclick([`m:${body.x},${body.y}`]); return "moved to " + body.x + "," + body.y; }
  if (op === "click") { const c = body.button === "right" ? "rc" : body.button === "double" ? "dc" : "c"; cliclick([`${c}:${body.x},${body.y}`]); return `os-clicked ${body.x},${body.y} (${body.button || "left"})`; }
  if (op === "type") { focusChrome(); cliclick(["t:" + body.text]); return "typed " + String(body.text).length + " chars"; }
  if (op === "key") { focusChrome(); cliclick(keyToCliclick(body.key)); return "pressed " + body.key; }
  if (op === "scroll") { osScroll(body.dy); return "scrolled " + body.dy; }
  throw new Error("unknown os op: " + op);
}

// ---------- HTTP server (SSE + POST) ----------
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/events" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("retry: 3000\n\n");
    sse.set(sessionId, res);
    req.on("close", () => { if (sse.get(sessionId) === res) sse.delete(sessionId); });
    return;
  }

  const readBody = () => new Promise(ok => { let b = ""; req.on("data", c => b += c); req.on("end", () => ok(b)); });

  if (url.pathname === "/api/start" && req.method === "POST") {
    readBody().then(async raw => {
      const body = JSON.parse(raw || "{}");
      const sessionId = body.sessionId || crypto.randomUUID();
      // Seed history from the conversation the side panel sent (multi-turn memory).
      const seed = Array.isArray(body.messages) && body.messages.length
        ? body.messages.map(m => ({ role: m.role, content: String(m.content || "") }))
        : [{ role: "user", content: body.prompt || "" }];
      const sess = { history: seed, provider: body.provider, model: body.model, pendingTools: new Map(), abort: false, effort: body.effort || "off" };
      sessions.set(sessionId, sess);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessionId }));
      const lastUser = [...seed].reverse().find(m => m.role === "user");
      log("session", sessionId, "history:", seed.length, "msgs, prompt:", (lastUser?.content || "").slice(0, 80));
      runLoop(sessionId).catch(e => { log("loop error", e); sendEvent(sessionId, { type: "error", message: String(e) }); });
    });
    return;
  }

  if (url.pathname === "/api/tool_result" && req.method === "POST") {
    readBody().then(raw => {
      const body = JSON.parse(raw || "{}");
      const sess = sessions.get(body.sessionId);
      if (sess) { const r = sess.pendingTools.get(body.id); if (r) { sess.pendingTools.delete(body.id); r({ content: body.content, imageData: body.imageData, isError: body.isError }); } }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    return;
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    readBody().then(raw => { const body = JSON.parse(raw || "{}"); const sess = sessions.get(body.sessionId); if (sess) sess.abort = true; res.writeHead(200); res.end('{"ok":true}'); });
    return;
  }

  if (url.pathname === "/api/fetch_models" && req.method === "POST") {
    readBody().then(async raw => {
      const body = JSON.parse(raw || "{}");
      log("fetch_models", body.style, body.baseUrl);
      try {
        const ids = await fetchProviderModels({ style: body.style, baseUrl: body.baseUrl, apiKey: body.apiKey });
        log("  -> ok", ids.length, "models");
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, models: ids }));
      } catch (e) {
        log("  -> error", e.message);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---- OS-level input (cliclick) ----
  if (url.pathname === "/api/os_exec" && req.method === "POST") {
    readBody().then(raw => {
      const body = JSON.parse(raw || "{}");
      try { ensureScrollBin(); const out = osExec(body); log("os_exec", body.op, "->", out); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, result: out })); }
      catch (e) { log("os_exec error", e.message); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // ---- external MCP bridge ----
  if (url.pathname === "/api/mcp_tools" && req.method === "GET") {
    const tools = TOOLS.map(t => ({ name: t.name, description: t.desc, inputSchema: t.schema }));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ tools }));
    return;
  }
  if (url.pathname === "/api/mcp_control" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("retry: 5000\n\n");
    mcpClient = res;
    log("mcp control channel connected by a side panel");
    req.on("close", () => { if (mcpClient === res) mcpClient = null; });
    return;
  }
  if (url.pathname === "/api/mcp_call" && req.method === "POST") {
    readBody().then(async raw => {
      const body = JSON.parse(raw || "{}");
      if (!mcpClient) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no browser connected — open the extension side panel" })); return; }
      const callId = crypto.randomUUID();
      mcpPending.set(callId, (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); });
      mcpClient.write(`data: ${JSON.stringify({ type: "mcp_tool_call", id: callId, tool: body.tool, args: body.args || {} })}\n\n`);
      log("mcp_call", body.tool, "->", callId);
      setTimeout(() => { const r = mcpPending.get(callId); if (r) { mcpPending.delete(callId); r({ content: "timeout waiting for browser to execute", isError: true }); } }, 60000);
    });
    return;
  }
  if (url.pathname === "/api/mcp_result" && req.method === "POST") {
    readBody().then(raw => {
      const body = JSON.parse(raw || "{}");
      const r = mcpPending.get(body.id);
      if (r) { mcpPending.delete(body.id); r({ content: body.content, imageData: body.imageData, isError: body.isError }); }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => log("listening on http://localhost:" + PORT + " (SSE /api/events, POST /api/start /api/tool_result /api/stop)"));
process.on("SIGINT", () => { log("shutting down"); process.exit(0); });