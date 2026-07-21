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

// ---------- session persistence (one JSON file per session in build/brain/sessions/) ----------
// Sessions are otherwise in-memory only, so a brain restart (or crash) lost the accumulated agent
// history (including full tool results the side panel doesn't keep). We persist history (images
// stripped to keep files small) and reload on startup, so a side panel can RESUME an existing session
// by id instead of re-sending the whole conversation — survives restarts + avoids huge re-seed payloads.
const SESSIONS_DIR = path.join(__dirname, "sessions");
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
function stripImg(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map(b => {
    if (!b || typeof b !== "object") return b;
    if (b.type === "image" || b.type === "image_url") return { type: "text", text: "[image omitted in saved state]" };
    if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: stripImg(b.content) };
    return b;
  });
}
const saveTimers = new Map();
function saveSession(sessionId, sess) {
  if (!sessionId || !sess) return;
  clearTimeout(saveTimers.get(sessionId));
  saveTimers.set(sessionId, setTimeout(() => {
    saveTimers.delete(sessionId);
    const data = {
      history: sess.history.map(m => ({ role: m.role, content: stripImg(m.content), ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) })),
      providerName: sess.provider && sess.provider.name, providerStyle: sess.provider && sess.provider.style, providerBaseUrl: sess.provider && sess.provider.baseUrl,
      modelId: sess.model && sess.model.id, effort: sess.effort, updatedAt: Date.now(),
    };
    fs.writeFile(path.join(SESSIONS_DIR, sessionId + ".json"), JSON.stringify(data), () => {});
  }, 500));
}
function loadSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json")); } catch { return; }
  const now = Date.now(), MAX_AGE_MS = 7 * 86400e3;
  for (const f of files) {
    const p = path.join(SESSIONS_DIR, f);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > MAX_AGE_MS) { fs.unlink(p, () => {}); continue; }   // prune sessions older than 7 days
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const id = f.slice(0, -5);
      sessions.set(id, { history: d.history || [], provider: { name: d.providerName, style: d.providerStyle, baseUrl: d.providerBaseUrl, apiKey: "" }, model: { id: d.modelId }, pendingTools: new Map(), abort: true, effort: d.effort || "off" });
    } catch (e) { log("failed to load session", f, e.message); }
  }
  log("loaded", sessions.size, "session(s) from disk");
}
// On resume, a previous run may have been interrupted mid-tool (assistant tool_use with no matching
// tool_result). Inject synthetic results so the model recovers instead of erroring on a dangling call.
function fixDanglingToolUse(history, style) {
  if (!history || !history.length) return;
  const last = history[history.length - 1];
  if (style === "anthropic") {
    if (last.role === "assistant" && Array.isArray(last.content)) {
      const uses = last.content.filter(b => b && b.type === "tool_use");
      if (!uses.length) return;
      const prev = history[history.length - 2];
      const hasResult = prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.some(b => b && b.type === "tool_result");
      if (!hasResult) history.push({ role: "user", content: uses.map(u => ({ type: "tool_result", tool_use_id: u.id, content: "[tool execution was interrupted by a brain restart — retry the action if still needed.]" })) });
    }
  } else {
    if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length) {
      const present = new Set();
      for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === "tool") present.add(history[i].tool_call_id); else if (history[i].role === "assistant") break; }
      const missing = last.tool_calls.map(tc => tc.id).filter(id => !present.has(id));
      for (const id of missing) history.push({ role: "tool", tool_call_id: id, content: "[tool execution was interrupted by a brain restart — retry the action if still needed.]" });
    }
  }
}

// ---------- our no-CDP tool definitions ----------
const TOOLS = [
  { name: "read_page", desc: "Get the visible text content of a page (and a simplified element list with indices). Use to see what's on the page. On re-reads of an unchanged page, returns `unchanged:true` with the same element list but a short text note instead of full text — the elements are still current and click-safe.",
    schema: { type: "object", properties: { tabId: { type: "number", description: "optional: target tab. Defaults to the side panel's attached tab." } }, additionalProperties: false } },
  { name: "click", desc: "Click an element. PREFER passing `n` (the element index from read_page) or `selector` — these resolve to the EXACT element at click time (no coordinate guessing, handles scroll/layout shifts). `text` is optional verification. Use raw x,y ONLY for empty areas with no element (canvas, maps, sliders, spatial UI). button: left|right|middle (default left).",
    schema: { type: "object", properties: { n: { type: "number" }, selector: { type: "string" }, text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, tabId: { type: "number" } }, additionalProperties: false } },
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
  { name: "real_click", desc: "LAST RESORT ONLY — attaches Chrome's debugger and shows a 'debugging' banner (a bot-detection signal). Use ONLY after 'click' had no visible effect on an anti-cheat/exam/captcha page. Trusted CDP mouse click, isTrusted:true. Prefer `n` (read_page index) or `selector` to resolve the exact element; raw x,y only for empty areas. button: left|right|double (default left).",
    schema: { type: "object", properties: { n: { type: "number" }, selector: { type: "string" }, text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, tabId: { type: "number" } }, additionalProperties: false } },
  { name: "real_move", desc: "LAST RESORT ONLY — attaches Chrome's debugger (shows 'debugging' banner, a bot-detection signal). Move the trusted (CDP) mouse cursor to viewport (x,y) without clicking. Only with the other real_* fallbacks.",
    schema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "real_type", desc: "LAST RESORT ONLY — attaches Chrome's debugger (shows 'debugging' banner, a bot-detection signal). Use ONLY after 'type' had no visible effect on an anti-cheat/exam/captcha page. Type text via trusted CDP keyboard (isTrusted:true). Focus by selector (or x,y), select-all + delete to REPLACE, then type. Unblocks sites that block synthetic input.",
    schema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["text"], additionalProperties: false } },
  { name: "real_key", desc: "LAST RESORT ONLY — attaches Chrome's debugger (shows 'debugging' banner, a bot-detection signal). Press a key/combo via trusted CDP keyboard: 'Enter','Tab','Backspace','Esc','arrow-up','Cmd+V','Control+Enter'. isTrusted:true. Only after press_key had no effect.",
    schema: { type: "object", properties: { key: { type: "string" }, tabId: { type: "number" } }, required: ["key"], additionalProperties: false } },
  { name: "real_scroll", desc: "LAST RESORT ONLY — attaches Chrome's debugger (shows 'debugging' banner, a bot-detection signal). Trusted (CDP) mouse-wheel scroll. dx,dy are pixel deltas (dy positive = down). Optional x,y is the scroll anchor (default viewport center). Only after scroll had no effect.",
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
VISION / COMPUTER-USE: if your model has vision, call 'screenshot' to see the current page as an image. Coordinates are image pixels from the top-left (0,0); the image width/height come back with the image. Use it to find elements by sight — then look up that element's index 'n' or 'selector' in read_page and click by THAT (never by guessing pixel coordinates), then screenshot again to verify. 'read_page' also returns the viewport size and a numbered list of interactive elements. For non-vision models, rely on 'read_page' instead of screenshots.
GROUNDING / CLICKING (CRITICAL — do not guess coordinates): To click anything, FIRST call read_page. It returns a numbered list of interactive elements; each entry has an index 'n', a CSS 'selector', its 'text', and its center 'x,y'. Pass that element's 'n' (preferred) or 'selector' to the 'click' tool — this resolves to the EXACT element at click time, so there is no coordinate drift, and it auto-handles scroll/layout shifts because coordinates are re-measured in-page. NEVER estimate x,y by looking at the screenshot; the screenshot only tells you WHICH element to click, then read_page tells you its n/selector. Only pass raw x,y for empty areas with no element (canvas, maps, sliders, spatial UI). If click reports the element was not found or the text didn't match, call read_page again and retry.
TRUSTED-INPUT FALLBACK (READ CAREFULLY): The default tools — click / type / press_key / scroll — fire REAL DOM events with NO debugger attached and NO banner. That stealth is the WHOLE POINT of this agent; ordinary websites should be driven with these only. The real_* tools (real_click / real_type / real_key / real_scroll / real_move) are a LAST RESORT. They attach Chrome's debugger (CDP), which makes Chrome show a visible "debugger is attached / started debugging this site" banner on the tab — that banner is a strong bot-detection signal on many sites and will undo the agent's stealth. Use real_* ONLY when you have already tried the matching default tool (click/type/etc.) and VERIFIED it had no visible effect — typically anti-cheat, exam, or captcha pages that deliberately ignore synthetic (isTrusted:false) events. Never reach for real_* on an ordinary website, and never use them as a first choice. To type via real_*: real_click the field (focuses it), then real_type the text (or pass a selector to real_type). real_* also accept 'n'/'selector' like 'click'.
Always use 'read_page' first to see the current state. Prefer 'eval' for site-specific buttons (Run/Submit/Next) when you know the selector. Be concise.
SUBMITTING / SEARCHING: To submit a form or search box, type the query (or click the field + type), then call press_key 'Enter' — it performs the real default action synthetically: Enter in a form <input> submits the form, Enter in a textarea inserts a newline, Tab moves focus, Esc blurs. This works WITHOUT real_* on ordinary sites including Google. Do NOT escalate to real_key just because a form didn't submit on a synthetic Enter — it submits now. Only use real_key/real_type if a field actively rejects synthetic input (anti-cheat/exam pages).
HARD-BLOCKED PAGES (Chrome Web Store at chromewebstore.google.com, and chrome:// pages): Chrome forbids ALL extension control on these pages — content scripts, chrome.scripting, AND the chrome.debugger/CDP layer are all refused by the browser. That means click/type/eval/read_page/screenshot AND real_click/real_type/real_scroll will ALL fail here. This is a Chrome security restriction that NO extension can bypass (only a full browser like Comet can). If you detect you are on the Web Store or a chrome:// page and a tool reports it's blocked, DO NOT keep retrying other tools — briefly tell the user this page is hard-blocked by Chrome for extensions and ask them to test on a normal site (or use browser-level CDP mode if available). Everywhere else (normal websites) all tools work.`;

// ---------- LLM call (streaming) ----------
// Streams text deltas to the sidepanel via sendEvent; returns assembled assistant message + tool uses.
async function callLLMStream(sessionId, provider, model, history, tools, effort) {
  const base = ensureV1(provider.baseUrl);
  const headers = provider.style === "anthropic"
    ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { Authorization: "Bearer " + provider.apiKey, "content-type": "application/json" };
  const vision = !!model.vision;
  // Inject the current date/time fresh each call so the model knows "today" (the brain runs locally,
  // so this is the user's device time). Without it the model guesses from training data (wrong).
  const sysNow = SYSTEM_PROMPT + "\n\nCURRENT DATE/TIME: " + new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) + " — this is the user's local device time; treat it as 'today/now' for date/time questions, scheduling, and relative-time reasoning.";

  if (provider.style === "anthropic") {
    const url = base + "/messages";
    const body = { model: model.id, max_tokens: 8192, system: sysNow, messages: history.map(m => ({ role: m.role, content: fmtContent(m, "anthropic", vision) })), tools, stream: true };
    applyEffort(body, "anthropic", model.id, effort);
    let res;
    try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }); }
    catch (e) { const err = new Error("Network: " + e.message); err.__pre = true; err.__net = true; throw err; }
    if (!res.ok) { const err = new Error("Anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 300)); err.__pre = true; err.status = res.status; throw err; }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", cur = null; const content = []; const toolUses = [];
    let usageInput = 0, usageOutput = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (!d || d === "[DONE]") continue;
        let ev; try { ev = JSON.parse(d); } catch { continue; }
        if (ev.type === "message_start" && ev.message && ev.message.usage) usageInput = ev.message.usage.input_tokens || 0;
        else if (ev.type === "message_delta" && ev.usage && ev.usage.output_tokens != null) usageOutput = ev.usage.output_tokens;
        else if (ev.type === "content_block_start") { const b = ev.content_block; cur = { type: b.type, id: b.id, name: b.name, text: "", input: "" }; }
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
    return { assistantMsg: { role: "assistant", content }, toolUses, usage: { input: usageInput, output: usageOutput } };
  } else {
    const url = base + "/chat/completions";
    const body = { model: model.id, messages: [{ role: "system", content: sysNow }, ...history.map(m => { const out = { role: m.role, content: fmtContent(m, "openai", vision) }; if (m.tool_calls) out.tool_calls = m.tool_calls; if (m.tool_call_id) out.tool_call_id = m.tool_call_id; return out; })], tools, tool_choice: "auto", stream: true, stream_options: { include_usage: true } };
    applyEffort(body, "openai", model.id, effort);
    let res;
    try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }); }
    catch (e) { const err = new Error("Network: " + e.message); err.__pre = true; err.__net = true; throw err; }
    if (!res.ok) { const err = new Error("OpenAI HTTP " + res.status + ": " + (await res.text()).slice(0, 300)); err.__pre = true; err.status = res.status; throw err; }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", contentText = ""; const tcMap = new Map();
    let usageInput = 0, usageOutput = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (!d || d === "[DONE]") continue;
        let ev; try { ev = JSON.parse(d); } catch { continue; }
        if (ev.usage) { usageInput = ev.usage.prompt_tokens || usageInput; usageOutput = ev.usage.completion_tokens || usageOutput; }
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
    return { assistantMsg, toolUses, usage: { input: usageInput, output: usageOutput } };
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

// ---------- history trimming + token budget ----------
// runLoop appends every assistant message + tool result to history with no ceiling, so long tasks
// blow the context window. We compact OLD messages (truncate tool-result bodies, drop old screenshots,
// trim long assistant text) while keeping the last KEEP_RECENT_MSGS at full fidelity. We never DROP
// messages (that would break tool_use/tool_result pairing for both providers) — compaction alone is
// enough to bound context since read_page/screenshot results dominate and shrink ~6000→320 chars.
const MAX_CTX_TOKENS = 100000;   // conservative ceiling; most modern models support >=128k
const KEEP_RECENT_MSGS = 10;     // never compact the most recent N messages
function estimateTokens(obj) { try { return Math.ceil(JSON.stringify(obj).length / 4); } catch { return 0; } }
function historyTokens(history) { let t = 0; for (const m of history) { t += estimateTokens(m.content) + estimateTokens(m.tool_calls) + 20; } return t; }
// Push the current context-usage to the side panel so it can render a context-window ring.
function emitCtx(sessionId, sess) { sendEvent(sessionId, { type: "context", used: historyTokens(sess.history), limit: sess.ctxWindow || MAX_CTX_TOKENS }); }
// Push cumulative real token usage (captured from the provider stream) to the side panel HUD.
function emitUsage(sessionId, sess) {
  const u = sess.usage || { input: 0, output: 0, toolCalls: 0, turns: 0 };
  sendEvent(sessionId, { type: "usage", input: u.input, output: u.output, total: u.input + u.output, toolCalls: u.toolCalls, turns: u.turns });
}
function trimHistory(history, style, maxTokens) {
  const n = history.length;
  if (n <= KEEP_RECENT_MSGS) return;
  const lastStart = n - KEEP_RECENT_MSGS; // compact everything older than the recent window
  const TRUNC = 320;
  const cut = (s) => { s = String(s ?? ""); return s.length > TRUNC ? s.slice(0, TRUNC) + "\n…[trimmed " + (s.length - TRUNC) + " chars]" : s; };
  let compacted = 0;
  for (let i = 0; i < lastStart; i++) {
    const m = history[i];
    if (style === "anthropic") {
      if (Array.isArray(m.content)) {
        const nc = m.content.map(b => {
          if (b.type === "tool_result") {
            if (typeof b.content === "string") return { ...b, content: cut(b.content) };
            if (Array.isArray(b.content)) {
              let hadImg = false;
              const out = b.content.map(x => {
                if (x.type === "image") { hadImg = true; return null; }
                if (x.type === "text") return { ...x, text: cut(x.text) };
                return x;
              }).filter(Boolean);
              if (hadImg) out.push({ type: "text", text: "[screenshot omitted to save context]" });
              return { ...b, content: out };
            }
          }
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 1000) return { ...b, text: b.text.slice(0, 500) + "\n…[trimmed]" };
          return b;
        });
        history[i] = { ...m, content: nc }; compacted++;
      } else if (typeof m.content === "string" && m.content.length > 1000) { history[i] = { ...m, content: m.content.slice(0, 500) + "\n…[trimmed]" }; compacted++; }
    } else { // openai
      if (m.role === "tool" && typeof m.content === "string") { history[i] = { ...m, content: cut(m.content) }; compacted++; }
      else if (typeof m.content === "string" && m.content.length > 1000) { history[i] = { ...m, content: m.content.slice(0, 500) + "\n…[trimmed]" }; compacted++; }
    }
  }
  if (compacted) log("compacted", compacted, "old msg(s); history ~", historyTokens(history), "tokens,", history.length, "msgs");
}

// ---------- resilient LLM caller (retries + context-compaction fallback) ----------
// A single network blip / 429 / 500 used to abort the whole multi-turn run. We retry transient errors
// with exponential backoff, and on a context-too-long 400 we compact history then retry. Pre-stream
// errors only (fetch throw / !res.ok) are retried; mid-stream breaks are surfaced (no double-stream).
async function callLLMStreamRetry(sessionId, provider, model, history, tools, effort, ctxCeiling) {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callLLMStream(sessionId, provider, model, history, tools, effort);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const status = e && e.status;
      if (!e || !e.__pre) throw e;                              // mid-stream / unknown — don't retry (would double-stream)
      const isAuth = status === 401 || status === 403;
      const isContext = status === 400 && /context|too long|maximum|tokens|too many/i.test(msg);
      const isTransient = e.__net || status === 429 || status === 500 || status === 502 || status === 503 || status === 529 || /overloaded|rate|timeout|ECONN|fetch failed|socket/i.test(msg);
      if (isAuth || attempt === maxAttempts - 1) throw e;
      if (isContext) {
        sendEvent(sessionId, { type: "thinking", note: "Context too long — compacting history and retrying…" });
        trimHistory(history, provider.style, Math.floor((ctxCeiling || MAX_CTX_TOKENS) * 0.7));  // compact harder on a 400
        continue;                                              // retry immediately after compaction
      }
      if (isTransient) {
        const backoff = Math.min(1500 * Math.pow(2, attempt), 8000);
        sendEvent(sessionId, { type: "thinking", note: "Transient error — retrying in " + Math.round(backoff / 1000) + "s (attempt " + (attempt + 2) + "/" + maxAttempts + ")…" });
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw e;                                                  // pre-stream but non-retryable (404, bad model, etc.)
    }
  }
  throw new Error("LLM call failed after " + maxAttempts + " attempts");
}

// ---------- agent loop ----------
async function runLoop(sessionId) {
  const sess = sessions.get(sessionId);
  const { provider, model, effort } = sess;
  if (!provider || !model) { sendEvent(sessionId, { type: "error", message: "No provider/model configured." }); return; }
  const vision = !!model.vision;
  const tools = toolsForLLM(provider.style, vision);
  const ctxCeiling = Math.floor((sess.ctxWindow || MAX_CTX_TOKENS) * 0.9);  // leave 10% headroom for the reply
  trimHistory(sess.history, provider.style, ctxCeiling);   // in case the seeded history is already huge
  emitCtx(sessionId, sess);
  let turns = 0;
  while (!sess.abort && turns++ < 120) {
    sendEvent(sessionId, { type: "thinking" });
    let resp;
    try { resp = await callLLMStreamRetry(sessionId, provider, model, sess.history, tools, effort, sess.ctxWindow || MAX_CTX_TOKENS); }
    catch (e) { sendEvent(sessionId, { type: "error", message: "LLM error: " + e.message }); break; }
    sess.history.push(resp.assistantMsg);
    sess.usage = sess.usage || { input: 0, output: 0, toolCalls: 0, turns: 0 };
    if (resp.usage) { sess.usage.input += resp.usage.input || 0; sess.usage.output += resp.usage.output || 0; }
    sess.usage.turns += 1;
    if (!resp.toolUses.length) { sendEvent(sessionId, { type: "done" }); break; }
    const turnImages = [];
    let stuckStop = false;
    for (const tu of resp.toolUses) {
      // Stuck-loop guard: same tool + identical args 3× in a row → stop burning tokens.
      // Scrolling repeats legitimately (paging down a long page), so it's exempt.
      const repeatable = tu.tool === "scroll" || tu.tool === "real_scroll";
      const sig = tu.tool + ":" + JSON.stringify(tu.args || {});
      if (!repeatable) {
        if (sig === sess.lastSig) sess.sigCount = (sess.sigCount || 1) + 1;
        else { sess.lastSig = sig; sess.sigCount = 1; }
      }
      if (!repeatable && sess.sigCount >= 3) {
        sendEvent(sessionId, { type: "tool_call", id: tu.id, tool: tu.tool, args: tu.args });
        pushToolResult(sess.history, provider.style, tu,
          "STUCK-LOOP GUARD: you called " + tu.tool + " with identical arguments 3 times in a row without progress. This call was NOT executed. Stop repeating it — try a different approach, or tell the user what's blocking you.", null);
        stuckStop = true;
        continue;
      }
      sendEvent(sessionId, { type: "tool_call", id: tu.id, tool: tu.tool, args: tu.args });
      sess.usage.toolCalls += 1;
      const result = await new Promise(res => sess.pendingTools.set(tu.id, res));
      const content = (typeof result.content === "string" ? result.content : JSON.stringify(result.content));
      const img = vision ? result.imageData : null;
      pushToolResult(sess.history, provider.style, tu, content, img);
      if (img) turnImages.push(img);
    }
    if (stuckStop) {
      sess.lastSig = null; sess.sigCount = 0;   // reset so a resume gets a clean slate
      sendEvent(sessionId, { type: "stuck" });
      trimHistory(sess.history, provider.style, ctxCeiling);
      saveSession(sessionId, sess);
      emitCtx(sessionId, sess);
      emitUsage(sessionId, sess);
      break;
    }
    // After all tool results are contiguous, append one combined user(image) turn for OpenAI vision
    // so the model sees any screenshots before the next assistant turn.
    if (provider.style !== "anthropic" && turnImages.length) {
      sess.history.push({ role: "user", content: [{ type: "text", text: "(screenshot image(s) returned by the tool call(s) above)" }, ...turnImages.map(d => ({ type: "image_url", image_url: { url: String(d) } }))] });
    }
    trimHistory(sess.history, provider.style, ctxCeiling);   // bound context growth after each turn
    saveSession(sessionId, sess);                                  // persist (debounced) so a restart can resume
    emitCtx(sessionId, sess);
    emitUsage(sessionId, sess);
  }
  if (turns > 120) sendEvent(sessionId, { type: "error", message: "Turn limit reached (120). Task may be incomplete." });
  saveSession(sessionId, sess);
  emitCtx(sessionId, sess);
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
      const existing = body.resume && sessions.get(sessionId);
      let sess;
      if (existing) {
        // Resume: keep the brain's accumulated history (with full tool results), refresh provider/model/effort
        // from the panel, and recover from any tool that was interrupted by the restart.
        sess = existing;
        sess.provider = body.provider || sess.provider;
        sess.model = body.model || sess.model;
        sess.ctxWindow = (body.model && body.model.ctxWindow) || sess.ctxWindow || MAX_CTX_TOKENS;
        sess.effort = body.effort || sess.effort || "off";
        sess.abort = false; sess.pendingTools = sess.pendingTools || new Map();
        fixDanglingToolUse(sess.history, sess.provider && sess.provider.style);
        if (body.prompt != null && String(body.prompt).length) sess.history.push({ role: "user", content: String(body.prompt) });
        log("resume session", sessionId, "history:", sess.history.length, "msgs");
      } else {
        // Seed history from the conversation the side panel sent (multi-turn memory).
        const seed = Array.isArray(body.messages) && body.messages.length
          ? body.messages.map(m => ({ role: m.role, content: String(m.content || "") }))
          : [{ role: "user", content: body.prompt || "" }];
        sess = { history: seed, provider: body.provider, model: body.model, pendingTools: new Map(), abort: false, effort: body.effort || "off", ctxWindow: (body.model && body.model.ctxWindow) || MAX_CTX_TOKENS, usage: { input: 0, output: 0, toolCalls: 0, turns: 0 } };
        sessions.set(sessionId, sess);
        log("session", sessionId, "history:", seed.length, "msgs (new)");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessionId, resumed: !!existing }));
      saveSession(sessionId, sess);
      const lastUser = [...sess.history].reverse().find(m => m.role === "user");
      log("  prompt:", String(lastUser?.content ?? "").slice(0, 80));
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

loadSessions();
server.listen(PORT, "127.0.0.1", () => log("listening on http://localhost:" + PORT + " (SSE /api/events, POST /api/start /api/tool_result /api/stop)"));
process.on("SIGINT", () => { log("shutting down"); process.exit(0); });