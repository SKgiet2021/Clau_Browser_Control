// sidepanel.js — Claude.ai-style chat + provider config (per claude_ui_clone_spec.md)
// Brain = local Node server (SSE /api/events, POST /api/start /api/tool_result /api/stop).
// True SSE streaming from the brain. Tool execution here via no-CDP APIs.

const KEY = "nocdp_providers";
const THEME_KEY = "nocdp_theme";
const CONV_KEY = "nocdp_conversations";
const EFFORT_KEY = "nocdp_effort";
const BRAIN = "http://127.0.0.1:7878";

const uid = () => "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let state = { providers: [], activeProviderId: null, activeModelId: null };
let theme = "dark";
let editing = null;
let secOpen = false;
let view = "chat";

let chat = { messages: [], busy: false, sessionId: null, evtSource: null, coreSession: null, attachment: null, effort: "off", ctx: null, usage: null };
let thinkingEl = null;
let convs = { list: [], currentId: null };
const pageCache = new Map();   // tabId -> { url, sig, text, elements } for read_page DOM-diff

// ---------- scheduled tasks ----------
// Stored under nocdp_tasks; alarms "nocdp_task_<id>" fire in nocdp-scheduler.js (service
// worker), which opens a work window + this panel as a popup runner (?task=<id>&tabId=<n>).
const TASKS_KEY = "nocdp_tasks";
let tasks = { list: [] };      // { id, name, prompt, url, kind:"interval"|"daily", every, at, enabled, lastRun, lastStatus }
let taskEditing = null;        // task object being edited in the Tasks view (null = closed)
let scheduledRun = null;       // the task driving THIS panel instance (runner mode)
let schedError = false;        // did the scheduled run hit an error event?
async function saveTasks() { await chrome.storage.local.set({ [TASKS_KEY]: tasks }); }
// Keep this schedule math in sync with nocdpRescheduleAll() in nocdp-scheduler.js.
async function scheduleTaskAlarm(t) {
  const name = "nocdp_task_" + t.id;
  try { await chrome.alarms.clear(name); } catch {}
  if (!t.enabled) return;
  try {
    if (t.kind === "daily") {
      const [h, m] = String(t.at || "09:00").split(":").map(Number);
      const next = new Date(); next.setHours(h || 0, m || 0, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 1440 });
    } else {
      const every = Math.max(1, +t.every || 30);   // chrome.alarms minimum is 1 minute
      await chrome.alarms.create(name, { periodInMinutes: every, delayInMinutes: every });
    }
  } catch (e) { console.error("[tasks] alarm failed:", e); }
}

// ---------- key vault (passphrase-based AES-GCM encryption at rest) ----------
// Providers' apiKeys are encrypted in chrome.storage.local with a key derived (PBKDF2) from a
// passphrase the user sets. The passphrase is held in chrome.storage.session (per-extension,
// cleared on browser restart) so keys stay decrypted in memory for a session; on restart the
// panel shows an unlock screen. The brain always receives the plaintext key at /api/start time.
const VAULT_KEY = "nocdp_vault";
const SESSION_KEY = "nocdp_passphrase";
let vault = { enabled: false, salt: null, canary: null };
let vaultKey = null;     // derived CryptoKey, in-memory when unlocked
let locked = false;      // vault enabled but not yet unlocked this session
const b64enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64dec = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const encU8 = (s) => new TextEncoder().encode(s);
async function deriveVaultKey(passphrase, saltB64) {
  const baseKey = await crypto.subtle.importKey("raw", encU8(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64dec(saltB64), iterations: 210000, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function vaultEncrypt(plaintext, key) {
  const k = key || vaultKey; if (!k) return String(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, encU8(String(plaintext)));
  return b64enc(iv.buffer) + ":" + b64enc(ct);
}
async function vaultDecrypt(blob, key) {
  const k = key || vaultKey; if (!k) return String(blob);
  const parts = String(blob).split(":"); if (parts.length !== 2) return String(blob);   // plaintext (not encrypted)
  try { const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(parts[0]) }, k, b64dec(parts[1]).buffer); return new TextDecoder().decode(pt); }
  catch { return null; }
}
async function decryptedApiKey(p) {
  if (!p || !p.apiKey) return "";
  if (!vault.enabled) return p.apiKey;
  if (!vaultKey) return "";
  return (await vaultDecrypt(p.apiKey)) ?? "";
}

const root = document.getElementById("root");

// ---------- storage ----------
async function load() {
  const got = await chrome.storage.local.get([KEY, THEME_KEY, CONV_KEY, EFFORT_KEY, VAULT_KEY, TASKS_KEY]);
  state = got[KEY] || { providers: [], activeProviderId: null, activeModelId: null };
  if (!state.providers) state.providers = [];
  theme = got[THEME_KEY] || "dark";
  convs = got[CONV_KEY] || { list: [], currentId: null };
  if (!convs.list) convs.list = [];
  convs.currentId = null; // always open to a fresh New Chat; previous conversations stay in History
  chat.messages = [];
  chat.effort = got[EFFORT_KEY] || "off";
  tasks = got[TASKS_KEY] || { list: [] };
  if (!tasks.list) tasks.list = [];
  vault = got[VAULT_KEY] || { enabled: false, salt: null, canary: null };
  locked = false; vaultKey = null;
  if (vault.enabled && vault.salt) {
    try {
      const sess = await chrome.storage.session.get([SESSION_KEY]);
      const pp = sess && sess[SESSION_KEY];
      if (pp) vaultKey = await deriveVaultKey(pp, vault.salt);
    } catch {}
    locked = !vaultKey;
  }
  applyTheme();
}
async function persist() { await chrome.storage.local.set({ [KEY]: state }); }
async function persistVault() { await chrome.storage.local.set({ [VAULT_KEY]: vault }); }
async function persistConvs() { await chrome.storage.local.set({ [CONV_KEY]: convs }); }
async function setTheme(t) { theme = t; applyTheme(); await chrome.storage.local.set({ [THEME_KEY]: t }); render(); }
function applyTheme() { const d = document.documentElement; if (theme === "system") delete d.dataset.theme; else d.dataset.theme = theme; }

function activePair() {
  const p = state.providers.find(x => x.id === state.activeProviderId);
  const m = p && p.models.find(x => x.id === state.activeModelId);
  return p && m ? { p, m } : null;
}

// ---------- provider config helpers ----------
function ensureV1(base) { let b = (base || "").trim().replace(/\/+$/, ""); if (!b) return ""; if (/\/v\d+$/i.test(b)) return b; return b + "/v1"; }
function modelsUrl(p) { return ensureV1(p.baseUrl) + "/models"; }
function authHeaders(p) {
  if (p.style === "anthropic") return { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  return { Authorization: "Bearer " + p.apiKey, "content-type": "application/json" };
}
async function fetchProviderModels(p) {
  const res = await fetch(modelsUrl(p), { headers: authHeaders(p) });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
  const json = await res.json();
  return (Array.isArray(json?.data) ? json.data : []).map(m => m.id || m.name).filter(Boolean).sort();
}
async function getModels(p) {
  let reached = false;
  try {
    const r = await fetch(`${BRAIN}/api/fetch_models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ style: p.style, baseUrl: p.baseUrl, apiKey: p.apiKey }) });
    reached = true;
    const j = await r.json();
    if (j.ok) return j.models;
    throw new Error(j.error || "provider rejected the request");
  } catch (e) {
    if (reached) throw e;
    try { return await fetchProviderModels(p); }
    catch (e2) { throw new Error("Could not reach the brain (" + e.message + ") and direct fetch blocked (" + e2.message + "). Start the brain: node build/brain/brain.js"); }
  }
}

// ---------- markdown + sunburst ----------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function cleanForHistory(content) { return String(content || "").replace(/\[\[tool:[^\]]+\]\]/g, "").replace(/\n{3,}/g, "\n\n").trim(); }
const CB = String.fromCharCode(0xE000); // private-use sentinel that survives esc() and never appears in prose
function mdToHtml(src) {
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre class="code"><div class="code-head"><span>${esc(lang || "code")}</span><button class="copy" data-act="copy-code">Copy</button></div><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return CB + (blocks.length - 1) + CB;
  });
  let h = esc(src);
  h = h.replace(new RegExp(CB + "(\\d+)" + CB, "g"), (_m, i) => blocks[i]);
  h = h.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/^###\s?(.*)$/gm, '<h3>$1</h3>').replace(/^##\s?(.*)$/gm, '<h2>$1</h2>').replace(/^#\s?(.*)$/gm, '<h1>$1</h1>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>(?:(?!<li>)[\s\S])*<\/li>)/g, m => `<ul>${m}</ul>`);
  h = h.replace(/\n/g, "<br>");
  h = h.replace(/<br>(<\/?(?:h\d|ul|pre))/g, "$1").replace(/(<\/(?:h\d|ul|pre)>)<br>/g, "$1");
  return h;
}
function renderAssistant(content, tools) {
  const parts = content.split(/(\[\[tool:[^\]]+\]\])/);
  let html = "";
  for (const part of parts) {
    const tm = part.match(/^\[\[tool:([^\]]+)\]\]$/);
    if (tm) html += renderToolCardMarker(tm[1], tools);
    else html += mdToHtml(part);
  }
  return html;
}
// ---- tool-call activity cards ----
// Tool calls are embedded in the assistant content as `[[tool:name#idx]]` markers
// (preserves streaming order + history persistence). The structured data lives in a
// `tools` array on the assistant message; the marker's idx points into it. If the
// array is missing (old history), we fall back to the legacy `.tooltag` pill.
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const fmtK = (n) => { n = Math.max(0, Math.floor(n || 0)); return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n); };
const ctxColor = (pct) => pct > 85 ? "#d4604a" : pct > 60 ? "#d4a84a" : "#6a9a7a";
const ctxPctOf = (ctx) => ctx && ctx.limit ? Math.min(100, Math.round(ctx.used / ctx.limit * 100)) : 0;
function ctxRingHTML(ctx) {
  const pct = ctxPctOf(ctx);
  return `<div class="ctx-ring" data-act="ctx" style="--ctx-pct:${pct};--ctx-col:${ctxColor(pct)}" title="Context window: ${ctx ? fmtK(ctx.used) + " / " + fmtK(ctx.limit) + " tokens (" + pct + "%)" : "Context usage will appear here once the agent starts"}"><div class="ctx-ring-inner"><span class="ctx-pct">${ctx ? pct + "%" : ""}</span></div></div>`;
}
function updateCtxRing() {
  const el = root.querySelector(".ctx-ring");
  if (!el) return;
  const pct = ctxPctOf(chat.ctx);
  el.style.setProperty("--ctx-pct", pct);
  el.style.setProperty("--ctx-col", ctxColor(pct));
  el.title = chat.ctx ? "Context window: " + fmtK(chat.ctx.used) + " / " + fmtK(chat.ctx.limit) + " tokens (" + pct + "%)" : "Context usage will appear here once the agent starts";
  const span = el.querySelector(".ctx-pct");
  if (span) span.textContent = chat.ctx ? pct + "%" : "";
}
function usageHudHTML(u) {
  if (!u || (!u.total && !u.turns)) return `<span class="usage-hud muted" title="Real token usage will appear here once the agent starts">—</span>`;
  const parts = [];
  if (u.turns) parts.push(u.turns + " turn" + (u.turns > 1 ? "s" : ""));
  if (u.toolCalls) parts.push(u.toolCalls + " action" + (u.toolCalls > 1 ? "s" : ""));
  if (u.total) parts.push(fmtK(u.total) + " tok");
  return `<span class="usage-hud" title="Real token usage this session (from the provider): ` + fmtK(u.input || 0) + ` in · ` + fmtK(u.output || 0) + ` out">` + parts.join(" · ") + `</span>`;
}
function updateUsageHud() {
  const el = root.querySelector(".usage-hud");
  if (!el) return;
  const u = chat.usage;
  if (!u || (!u.total && !u.turns)) { el.textContent = "—"; el.classList.add("muted"); el.title = "Real token usage will appear here once the agent starts"; return; }
  const parts = [];
  if (u.turns) parts.push(u.turns + " turn" + (u.turns > 1 ? "s" : ""));
  if (u.toolCalls) parts.push(u.toolCalls + " action" + (u.toolCalls > 1 ? "s" : ""));
  if (u.total) parts.push(fmtK(u.total) + " tok");
  el.textContent = parts.join(" · ");
  el.classList.remove("muted");
  el.title = "Real token usage this session (from the provider): " + fmtK(u.input || 0) + " in · " + fmtK(u.output || 0) + " out";
}
const TC_ICON = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const CHEV_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const SHIELD = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>';
const TOOL_META = {
  read_page:        { name: "Read page",     icon: TC_ICON('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/>') },
  get_text:         { name: "Get text",      icon: TC_ICON('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>') },
  screenshot:       { name: "Screenshot",   icon: TC_ICON('<path d="M3 7h3l2-3h8l2 3h3v12H3z"/><circle cx="12" cy="13" r="3.5"/>') },
  click:            { name: "Click",         icon: TC_ICON('<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>') },
  type:             { name: "Type",         icon: TC_ICON('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>') },
  press_key:        { name: "Press key",    icon: TC_ICON('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>') },
  scroll:           { name: "Scroll",        icon: TC_ICON('<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>') },
  navigate:         { name: "Navigate",     icon: TC_ICON('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>') },
  new_tab:          { name: "New tab",      icon: TC_ICON('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>') },
  switch_tab:       { name: "Switch tab",   icon: TC_ICON('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>') },
  close_tab:        { name: "Close tab",    icon: TC_ICON('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>') },
  list_tabs:        { name: "List tabs",    icon: TC_ICON('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>') },
  attached_file:    { name: "Attached file",icon: TC_ICON('<path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>') },
  upload_file:      { name: "Upload file",  icon: TC_ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/>') },
  eval:             { name: "Run JS",       icon: TC_ICON('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>') },
  real_move:        { name: "Move · trusted",icon: TC_ICON('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>') },
  real_click:       { name: "Click · trusted",icon: TC_ICON(SHIELD + '<path d="m9 6 3 5 4-2-2 7 5 1-9 2-3-5-4 2 2-7z"/>') },
  real_type:        { name: "Type · trusted",icon: TC_ICON(SHIELD) },
  real_key:         { name: "Key · trusted",icon: TC_ICON(SHIELD) },
  real_scroll:      { name: "Scroll · trusted",icon: TC_ICON(SHIELD + '<rect x="9" y="3" width="6" height="14" rx="3"/>') },
  get_cookies:      { name: "Get cookies",  icon: TC_ICON('<path d="M21 12a9 9 0 1 1-9-9 4 4 0 0 0 4 4 4 4 0 0 0 4 4z"/><circle cx="9" cy="11" r="1"/><circle cx="14" cy="14" r="1"/>') },
  set_cookie:       { name: "Set cookie",   icon: TC_ICON('<path d="M21 12a9 9 0 1 1-9-9 4 4 0 0 0 4 4 4 4 0 0 0 4 4z"/><path d="M9 12l2 2 4-4"/>') },
  delete_cookie:    { name: "Delete cookie",icon: TC_ICON('<path d="M21 12a9 9 0 1 1-9-9 4 4 0 0 0 4 4 4 4 0 0 0 4 4z"/><path d="m14 9-4 6M10 9l4 6"/>') },
  list_network:     { name: "Network log",  icon: TC_ICON('<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>') },
  get_network_request:{ name: "Get request",icon: TC_ICON('<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>') },
  set_request_header:{name: "Set header",   icon: TC_ICON('<path d="M4 7h16M4 12h16M4 17h10"/>') },
  block_url:        { name: "Block URL",    icon: TC_ICON('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>') },
  clear_net_rules:  { name: "Clear rules",  icon: TC_ICON('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>') },
};
const TOOL_META_DEFAULT = { name: "Tool", icon: TC_ICON('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>') };
function toolArgsSummary(tool, args) {
  const a = args || {};
  const t = String(a.text ?? "");
  switch (tool) {
    case "click": case "real_click": {
      if (a.n != null) return "#" + a.n + (a.text ? " " + trunc('"' + a.text + '"', 22) : "");
      if (a.selector) return trunc(a.selector, 32);
      return `(${a.x}, ${a.y})${a.button && a.button !== "left" ? " " + a.button : ""}`;
    }
    case "real_move": return `(${a.x}, ${a.y})`;
    case "type": return a.selector ? `${a.selector} = "${trunc(t, 28)}"` : `"${trunc(t, 28)}"`;
    case "real_type": return `"${trunc(t, 28)}"`;
    case "press_key": case "real_key": return a.key || "";
    case "scroll": case "real_scroll": return `dx=${a.dx || 0} dy=${a.dy || 0}`;
    case "navigate": case "new_tab": return trunc(a.url || "", 38);
    case "switch_tab": case "close_tab": return `tab ${a.tabId ?? ""}`;
    case "get_text": return a.selector || "";
    case "eval": return trunc(a.code || "", 38);
    case "upload_file": return a.selector || "input[type=file]";
    case "set_cookie": case "delete_cookie": return a.name || "";
    case "get_cookies": return a.url || a.domain || "";
    case "set_request_header": return a.header || "";
    case "block_url": return a.urlFilter || "";
    case "get_network_request": return a.id != null ? String(a.id) : "";
    case "read_page": case "screenshot": case "attached_file":
    case "list_tabs": case "list_network": case "clear_net_rules": return "";
    default: return "";
  }
}
function renderToolCardMarker(marker, tools) {
  const m = marker.match(/^([^#]+)#(\d+)$/);
  if (m) {
    const tc = tools && tools[+m[2]];
    if (tc) return renderToolCard(tc);
  }
  return `<div class="tooltag"><span class="dot">●</span> ${esc(marker.split("#")[0])}</div>`;
}
function renderToolCard(tc) {
  const meta = TOOL_META[tc.tool] || TOOL_META_DEFAULT;
  const args = toolArgsSummary(tc.tool, tc.args);
  const dur = tc.durMs != null ? (tc.durMs < 1000 ? tc.durMs + "ms" : (tc.durMs / 1000).toFixed(1) + "s") : "";
  const statusLabel = tc.status === "running" ? "running" : tc.status === "error" ? "error" : "done";
  const result = tc.result || "";
  const resultShort = result.length > 1200 ? result.slice(0, 1200) + "\n… (" + result.length + " chars)" : result;
  const shot = tc.image ? `<img class="tc-shot" data-act="shot-zoom" src="${tc.image}" alt="screenshot">` : "";
  const hasArgs = tc.args && typeof tc.args === "object" && Object.keys(tc.args).length;
  const body = tc.open ? `<div class="tc-body">
    ${hasArgs ? `<div class="tc-args-full">${esc(JSON.stringify(tc.args, null, 2))}</div>` : ""}
    ${result ? `<div class="tc-result ${tc.status === "error" ? "error" : ""}">${esc(resultShort)}</div>` : ""}
    ${shot}
  </div>` : "";
  return `<div class="toolcard ${tc.open ? "open" : ""}">
    <div class="tc-head" data-act="tc-toggle" data-tc="${esc(tc.id)}">
      <span class="tc-ico">${meta.icon}</span>
      <span class="tc-name">${esc(meta.name)}</span>
      ${args ? `<span class="tc-args">${esc(args)}</span>` : ""}
      <span class="tc-spacer"></span>
      ${dur ? `<span class="tc-dur">${dur}</span>` : ""}
      <span class="tc-status ${tc.status}"><span class="tc-dot"></span>${statusLabel}</span>
      <span class="tc-chev">${CHEV_SVG}</span>
    </div>
    ${body}
  </div>`;
}
function findToolCard(id) {
  for (const m of chat.messages) if (m.tools) for (const tc of m.tools) if (tc.id === id) return tc;
  return null;
}
function sunburstSVG(size) {
  let s = "";
  for (let i = 0; i < 12; i++) {
    const a = (i * 30) * Math.PI / 180;
    const x1 = (12 + 4 * Math.cos(a)).toFixed(2), y1 = (12 + 4 * Math.sin(a)).toFixed(2);
    const x2 = (12 + 9 * Math.cos(a)).toFixed(2), y2 = (12 + 9 * Math.sin(a)).toFixed(2);
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return `<svg class="sunburst" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${s}</svg>`;
}
// Figma prototype icons (figma-icons/, exported from the user's design)
const ICON = (name, size, cls) =>
  `<img class="ficon ${cls || ""}" src="figma-icons/figma-${name}.png" width="${size}" height="${size}" alt="${name}">`;

// ============================================================
//  RENDERING
// ============================================================
function render() {
  if (locked) { root.innerHTML = ""; root.appendChild(renderUnlock()); const pi = root.querySelector('[data-act="pp-input"]'); if (pi) { pi.focus(); pi.addEventListener("keydown", (e) => { if (e.key === "Enter") root.querySelector('[data-act="unlock"]')?.click(); }); } return; }
  // preserve chat scroll across the rebuild (prevents the top->bottom flash on long convos)
  const oldLog = root.querySelector(".chat-log");
  let saveScroll = null;
  if (oldLog) {
    const atBottom = oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 80;
    saveScroll = atBottom ? "bottom" : oldLog.scrollTop;
  }
  root.innerHTML = "";
  root.appendChild(renderNav());
  const v = document.createElement("div");
  v.className = "view " + view;
  v.appendChild(view === "providers" ? renderProvidersView() : view === "history" ? renderHistoryView() : view === "tasks" ? renderTasksView() : renderChatView());
  root.appendChild(v);
  if (view === "chat") {
    const ta = v.querySelector('[data-chat="input"]'); if (ta && !chat.busy) ta.focus();
    const newLog = v.querySelector(".chat-log");
    if (newLog && saveScroll != null) newLog.scrollTop = saveScroll === "bottom" ? newLog.scrollHeight : saveScroll;
  }
}

function renderUnlock() {
  const el = document.createElement("div");
  el.className = "chat-view";
  el.innerHTML = `<div class="chat-empty" style="gap:14px">
    <div class="hero">${ICON("clawd", 52)}</div>
    <h1 class="serif">Keys are locked</h1>
    <p>Enter your passphrase to decrypt your provider API keys for this session.</p>
    <div class="unlock-box glass">
      <input data-act="pp-input" type="password" placeholder="Passphrase" autocomplete="current-password">
      <div class="row" style="justify-content:center;gap:8px;margin-top:10px">
        <button class="btn good" data-act="unlock">Unlock</button>
      </div>
      <div data-status style="min-height:16px;margin-top:8px;font-size:11px"></div>
      <button class="linkish" data-act="reset-vault" style="margin-top:6px">Forgot passphrase? Reset vault (re-enter keys)</button>
    </div>
  </div>`;
  return el;
}

function renderNav() {
  const el = document.createElement("div");
  el.className = "topbar";
  const mid = view === "providers"
    ? `<div class="providers-pill glass"><span>Providers</span></div>`
    : view === "tasks"
    ? `<div class="providers-pill glass"><span>Scheduled Tasks</span></div>`
    : `<div class="seg" data-sel="${view === "history" ? 1 : 0}">
        <div class="lens glass"></div>
        <button class="opt" data-nav="chat">Chat</button>
        <button class="opt" data-nav="history">History</button>
      </div>`;
  el.innerHTML = `
    <button class="logo-blob glass pressable" data-act="logo" title="${view === "providers" ? "Back to chat" : "Provider settings"}">${ICON("claude", 28)}</button>
    ${mid}
    <button class="icon-btn pressable" data-act="new-chat" title="New chat">${ICON("add-green", 34)}</button>`;
  return el;
}

// ---------- Providers view ----------
function renderProvidersView() {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const head = document.createElement("div");
  head.className = "between";
  head.innerHTML = `
    <div class="sec-pill glass"><span>Providers</span></div>
    <div class="row">
      <div class="theme-switch">
        <button data-act="theme" data-theme="light" class="${theme === "light" ? "active" : ""}">☀</button>
        <button data-act="theme" data-theme="dark" class="${theme === "dark" ? "active" : ""}">☾</button>
        <button data-act="theme" data-theme="system" class="${theme === "system" ? "active" : ""}">Auto</button>
      </div>
      <button class="icon-btn glass pressable" data-act="add" title="Add provider">${ICON("plus", 18)}</button>
      <button class="icon-btn glass pressable ${vault.enabled ? "on" : ""}" data-act="sec" title="Key encryption: ${vault.enabled ? "ON — click to manage" : "off — click to enable"}">${TC_ICON('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="15.5" r=".8"/>')}</button>
      <button class="icon-btn glass pressable" data-act="tasks-view" title="Scheduled tasks">${TC_ICON('<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2"/><path d="M5.2 3.2 3 5.4M18.8 3.2 21 5.4"/>')}</button>
    </div>`;
  wrap.appendChild(head);
  wrap.appendChild(renderActiveBar());
  wrap.appendChild(renderProviderList());
  if (secOpen) wrap.appendChild(renderSecurity());
  if (editing) wrap.appendChild(renderEditor());
  return wrap;
}
function renderActiveBar() {
  const el = document.createElement("div");
  el.className = "card glass";
  const pairs = [];
  for (const p of state.providers) for (const m of p.models) pairs.push([p, m]);
  if (!pairs.length) { el.innerHTML = `<div class="muted" style="font-size:12px">No model active. Add a provider and fetch models, then pick one.</div>`; return el; }
  el.innerHTML = `
    <label>Active model (this session)</label>
    <select data-act="active">
      ${pairs.map(([p, m]) => `<option value="${p.id}|${m.id}" ${state.activeProviderId === p.id && state.activeModelId === m.id ? "selected" : ""}>${esc(p.name)} · ${esc(m.displayName || m.id)}${m.vision ? " 👁" : ""}</option>`).join("")}
    </select>`;
  return el;
}
function renderProviderList() {
  const el = document.createElement("div");
  el.className = "col";
  if (!state.providers.length) {
    el.innerHTML = `<div class="card glass empty">No providers yet.<br><span class="muted">Tap ＋ above — Anthropic, OpenAI, OpenRouter, GLM, MiniMax, Ollama… any OpenAI- or Anthropic-style endpoint.</span></div>`;
  } else for (const p of state.providers) {
    const isActive = state.activeProviderId === p.id;
    const card = document.createElement("div");
    card.className = "card glass";
    card.innerHTML = `
      <div class="between">
        <div class="row"><strong>${esc(p.name) || "(unnamed)"}</strong></div>
        <div class="row"><button class="btn small good" data-act="edit" data-id="${p.id}">Edit</button><button class="btn small warn" data-act="del" data-id="${p.id}">Delete</button></div>
      </div>
      <div class="row" style="flex-wrap:wrap">
        <span class="badge">${p.style === "anthropic" ? "Anthropic-style" : "OpenAI-style"}</span>
        <span class="badge">${p.models.length} model${p.models.length === 1 ? "" : "s"}</span>
        ${isActive ? '<span class="badge active">Active</span>' : ""}
      </div>`;
    el.appendChild(card);
  }
  return el;
}
function renderSecurity() {
  const el = document.createElement("div");
  el.className = "card glass editor";
  if (vault.enabled) {
    el.innerHTML = `
    <div class="between"><h1 style="font-size:14px">🔒 Key encryption <span class="badge good">ON</span></h1><button class="btn small warn" data-act="sec-close">✕</button></div>
    <p class="muted" style="font-size:12px">API keys are encrypted at rest. You'll enter your passphrase once per browser restart to unlock.</p>
    <div class="field"><label>Current passphrase <span class="muted" style="font-weight:400">(required)</span></label><input data-sec="cur" type="password" placeholder="Current passphrase" autocomplete="current-password"></div>
    <div class="field"><label>New passphrase</label><input data-sec="pp" type="password" placeholder="New passphrase" autocomplete="new-password"></div>
    <div class="field"><label>Confirm</label><input data-sec="pp2" type="password" placeholder="Repeat new passphrase" autocomplete="new-password"></div>
    <div data-status style="min-height:16px;font-size:11px"></div>
    <div class="row" style="justify-content:center;gap:8px;margin-top:6px">
      <button class="btn good" data-act="sec-change">Change passphrase</button>
      <button class="btn warn" data-act="sec-disable">Turn off</button>
    </div>`;
  } else {
    el.innerHTML = `
    <div class="between"><h1 style="font-size:14px">🔒 Key encryption</h1><button class="btn small warn" data-act="sec-close">✕</button></div>
    <p class="muted" style="font-size:12px">Set a passphrase to encrypt your provider API keys at rest (AES-GCM + PBKDF2, 210k iterations). You'll enter it once per browser restart to unlock.</p>
    <div class="field"><label>Passphrase</label><input data-sec="pp" type="password" placeholder="Choose a passphrase" autocomplete="new-password"></div>
    <div class="field"><label>Confirm</label><input data-sec="pp2" type="password" placeholder="Repeat passphrase" autocomplete="new-password"></div>
    <div data-status style="min-height:16px;font-size:11px"></div>
    <div class="row" style="justify-content:center;gap:8px;margin-top:6px">
      <button class="btn good" data-act="sec-enable">Enable encryption</button>
    </div>`;
  }
  return el;
}
function renderEditor() {
  const p = editing;
  const el = document.createElement("div");
  el.className = "card glass editor";
  el.innerHTML = `
    <div class="between"><h1 style="font-size:14px">Provider</h1><button class="btn small warn" data-act="close">✕</button></div>
    <div class="ptype" data-sel="${p.style === "anthropic" ? 1 : 0}">
      <div class="lens glass"></div>
      <button class="opt" data-act="tab" data-tab="openai">OpenAI</button>
      <button class="opt" data-act="tab" data-tab="anthropic">Anthropic</button>
    </div>
    <div class="field"><label>Display name <span style="opacity:.55;font-weight:400">(shown in chat)</span></label><input data-f="name" placeholder="E.g; My OpenAI" value="${esc(p.name)}"></div>
    <div class="field"><label>Base URL</label><input data-f="baseUrl" placeholder="${p.style === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}" value="${esc(p.baseUrl)}"></div>
    <div class="field"><label>API KEY <button class="reveal-btn" data-act="reveal-key" type="button" title="Show / hide">👁</button></label><input data-f="apiKey" type="password" placeholder="E.g; sk-****" value="${esc(p.apiKey)}"></div>
    <div class="row" style="justify-content:center;margin-top:2px">
      <button class="btn small warn" data-act="test">Test Connection</button>
      <button class="btn small good" data-act="fetch">Fetch Models</button>
      <button class="btn small good" data-act="manual" title="Add model manually">${ICON("plus", 14)}</button>
    </div>
    <div data-status></div>
    <hr>
    <div class="between"><strong>Models</strong><span class="muted" style="font-size:11px">id · name · vision</span></div>
    <div data-models class="col" style="gap:6px"></div>
    <hr>
    <div class="row" style="justify-content:center">
      <button class="btn good row" data-act="save" style="gap:6px">${ICON("done", 15)} Save</button>
      <button class="btn warn row" data-act="cancel" style="gap:6px">${ICON("close", 13)} Cancel</button>
    </div>`;
  renderModels(el);
  return el;
}
function renderModels(editorEl) {
  const p = editing, box = editorEl.querySelector("[data-models]");
  if (!p.models.length) { box.innerHTML = `<div class="muted" style="font-size:11px">No models yet — click "Fetch Models" or ＋ to add manually.</div>`; return; }
  box.innerHTML = p.models.map((m, i) => `<div class="model-row"><input data-mi="id" data-idx="${i}" placeholder="model id" value="${esc(m.id)}"><input data-mi="displayName" data-idx="${i}" placeholder="display name" value="${esc(m.displayName)}"><input data-mi="ctxWindow" data-idx="${i}" type="number" min="1000" step="1000" class="ctx-input" placeholder="ctx 200000" value="${m.ctxWindow ? esc(m.ctxWindow) : ""}" title="Context window (tokens) — the ring in the composer fills against this"><label class="check" title="Vision"><input type="checkbox" data-mi="vision" data-idx="${i}" ${m.vision ? "checked" : ""}></label><button class="btn small warn" data-act="rm-model" data-idx="${i}">✕</button></div>`).join("");
}

// ---------- Chat view ----------
function renderChatView() {
  const wrap = document.createElement("div");
  wrap.className = "chat-view";
  const pair = activePair();
  if (!pair) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    e.innerHTML = `<div class="hero">${ICON("clawd", 52)}</div><h1 class="serif">No provider set up</h1><p>Tap the logo (top-left) to open <strong data-act="logo">Providers</strong> and add one.</p>`;
    wrap.appendChild(e);
    wrap.appendChild(renderComposer(null));
    return wrap;
  }
  if (!chat.messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML = `<div class="hero">${ICON("clawd", 52)}</div><h1 class="serif">How can I help you today?</h1><p>Read the page, click, type, run JS, navigate your current tab — like a human.</p>
      <div class="chips">
        <button class="chip glass pressable" data-act="quick-prompt" data-prompt="Solve all the questions on this page. For each coding question: read it, analyze, write the code into the site's editor, click Run, check the output matches the expected output shown in the question, then click Submit and click Next. For MCQs: pick the appropriate option, click Submit, then Next. Do this for every question without stopping to ask me. Track which question you're on and report progress between questions.">Solve the questions</button>
        <button class="chip glass pressable" data-act="quick-prompt" data-prompt="Read this page and give me a concise summary of what it's about.">Summarize this page</button>
        <button class="chip glass pressable" data-act="quick-prompt" data-prompt="Fill out the form on this page with reasonable values, then stop and tell me what you entered.">Fill the form</button>
      </div>`;
    wrap.appendChild(empty);
  } else {
    const log = document.createElement("div");
    log.className = "chat-log";
    for (const msg of chat.messages) log.appendChild(renderMessage(msg));
    wrap.appendChild(log);
    log.scrollTop = log.scrollHeight;
  }
  wrap.appendChild(renderComposer(pair));
  return wrap;
}
function assistantMeta() {
  const pair = activePair();
  const name = pair ? esc(pair.m.displayName || pair.m.id) : "";
  return `<div class="meta">${name ? `<span class="tag">${name}</span>` : ""}<button class="copy-mini" data-act="copy" title="Copy">${ICON("copy", 15)}</button></div>`;
}
function renderMessage(msg) {
  const el = document.createElement("div");
  el.className = "msg " + msg.role;
  if (msg.role === "user")
    el.innerHTML = `${ICON("batman", 25, "avatar")}<div class="bubble glass">${esc(msg.content)}</div>`;
  else
    el.innerHTML = `${ICON("clawd", 22, "avatar")}<div class="content">${renderAssistant(msg.content, msg.tools)}</div>${assistantMeta()}`;
  return el;
}
const SNIP_ICON = ICON("control", 22);
const ATTACH_ICON = ICON("add-circle", 24);
function renderComposer(pair) {
  const w = document.createElement("div");
  w.className = "composer-wrap";
  const modelChip = pair ? `<div class="model-chip glass" data-act="logo" title="Switch model">${esc(pair.m.displayName || pair.m.id)} ⌄</div>` : `<div class="model-chip glass" data-act="logo">No model ⌄</div>`;
  const stop = chat.busy;
  const sendClass = stop ? "send stop" : "send send-off";
  const sendAct = stop ? 'data-act="stop"' : 'data-act="send"';
  const icon = stop
    ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : ICON("claude", 18);
  const attachChip = chat.attachment ? `<div class="attach-chip glass" title="${esc(chat.attachment.name)}">${chat.attachment.image ? "🖼" : "📎"} ${esc(chat.attachment.name)} <button class="attach-x" data-act="remove-attach">✕</button></div>` : "";
  const thinkOn = chat.effort !== "off";
  const think = `<div class="think ${thinkOn ? "on" : ""}" data-act="think" title="Extended thinking on/off"><span class="tl">Thinking</span><div class="tswitch"><div class="tthumb glass"></div></div></div>`;
  w.innerHTML = `${attachChip ? `<div class="attach-row">${attachChip}</div>` : ""}
    <div class="composer glass">
      <textarea data-chat="input" placeholder="How can I help u today..?" rows="1"></textarea>
      <div class="c-row">
        ${ctxRingHTML(chat.ctx)}
        <button class="icon-glyph" data-act="snip" title="Snip a screen region">${SNIP_ICON}</button>
        ${modelChip}
        ${think}
        <button class="icon-glyph" data-act="attach" title="Attach a file">${ATTACH_ICON}</button>
        <button class="${sendClass}" ${sendAct}>${icon}</button>
      </div>
    </div>
    <input type="file" data-act="attach-input" hidden>
    <div class="composer-hint"><span class="trusted-badge ${attachedTabs.size ? "on" : ""}" data-act="trusted" title="${attachedTabs.size ? "Trusted control ACTIVE — Chrome debugger attached (real_* mode). Chrome shows a 'debugging' banner on those tabs. Click for details." : "Stealth mode — real DOM events, no debugger, no banner. Lights up if the agent escalates to trusted (real_*) input."}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SHIELD}<path d="m9 12 2 2 4-4"/></svg></span><span class="hint-left">Enter to send · Shift+Enter for newline${chat.attachment ? " · " + (chat.attachment.image ? "🖼 image attached" : "📎 attached") : ""}</span>${usageHudHTML(chat.usage)}</div>`;
  return w;
}

// ---------- History view ----------
function renderHistoryView() {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  if (!convs.list.length) {
    const e = document.createElement("div");
    e.className = "card glass empty";
    e.innerHTML = `No conversations yet.<br><span class="muted">Start a chat and it'll be saved here automatically.</span>`;
    wrap.appendChild(e);
    return wrap;
  }
  convs.list.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "card glass conv-row";
    card.dataset.act = "load-conv";
    card.dataset.id = c.id;
    card.style.animationDelay = Math.min(i * 60, 420) + "ms";
    const isActive = c.id === convs.currentId;
    card.innerHTML = `
      <div class="between">
        <strong>${esc(c.title || "(untitled)")}</strong>
        <button class="icon-glyph" data-act="del-conv" data-id="${c.id}" title="Remove">${ICON("remove", 20)}</button>
      </div>
      <div class="muted" style="font-size:11px">${new Date(c.updatedAt || c.createdAt || Date.now()).toLocaleString()} · ${c.messages.length} msg${c.messages.length === 1 ? "" : "s"}${isActive ? ' · <span style="color:var(--accent-h)">current</span>' : ""}</div>`;
    wrap.appendChild(card);
  });
  return wrap;
}

// ---------- Scheduled Tasks view ----------
function describeSchedule(t) {
  if (t.kind === "daily") return "daily at " + (t.at || "09:00");
  const every = Math.max(1, +t.every || 30);
  return every >= 60 && every % 60 === 0 ? "every " + (every / 60) + "h" : "every " + every + "m";
}
function renderTasksView() {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const head = document.createElement("div");
  head.className = "between";
  head.innerHTML = `
    <div class="sec-pill glass"><span>Scheduled Tasks</span></div>
    <button class="icon-btn glass pressable" data-act="task-add" title="New scheduled task">${ICON("plus", 18)}</button>`;
  wrap.appendChild(head);
  const note = document.createElement("div");
  note.className = "muted";
  note.style.cssText = "font-size:11px;padding:0 4px";
  note.textContent = "Runs while Chrome is open: opens the page in a background window, runs the prompt with the agent (no confirmations), saves the transcript to History, and notifies you.";
  wrap.appendChild(note);
  if (!tasks.list.length && !taskEditing) {
    const e = document.createElement("div");
    e.className = "card glass empty";
    e.innerHTML = `No scheduled tasks yet.<br><span class="muted">Tap ＋ to schedule a prompt — e.g. "every morning, open HN and summarize the top 5".</span>`;
    wrap.appendChild(e);
  }
  tasks.list.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "card glass conv-row";
    card.style.animationDelay = Math.min(i * 60, 420) + "ms";
    card.innerHTML = `
      <div class="between">
        <strong>${esc(t.name || "(untitled task)")}</strong>
        <div class="row" style="gap:6px">
          <button class="btn small good" data-act="task-run" data-id="${t.id}" title="Run now">▶</button>
          <button class="btn small ${t.enabled ? "good" : "warn"}" data-act="task-toggle" data-id="${t.id}" title="${t.enabled ? "On — click to pause" : "Paused — click to enable"}">${t.enabled ? "On" : "Off"}</button>
          <button class="icon-glyph" data-act="task-edit" data-id="${t.id}" title="Edit">✎</button>
          <button class="icon-glyph" data-act="task-del" data-id="${t.id}" title="Delete">${ICON("remove", 20)}</button>
        </div>
      </div>
      <div class="muted" style="font-size:11px">${describeSchedule(t)} · ${esc(trunc(t.url || "current page", 34))}${t.lastRun ? " · last: " + new Date(t.lastRun).toLocaleString() + (t.lastStatus === "error" ? ' · <span class="bad">failed</span>' : " ✓") : ""}</div>
      <div class="muted" style="font-size:11px;opacity:.75">${esc(trunc(t.prompt || "", 90))}</div>`;
    wrap.appendChild(card);
  });
  if (taskEditing) wrap.appendChild(renderTaskEditor());
  return wrap;
}
function renderTaskEditor() {
  const t = taskEditing;
  const el = document.createElement("div");
  el.className = "card glass editor";
  el.innerHTML = `
    <div class="between"><h1 style="font-size:14px">Scheduled Task</h1><button class="btn small warn" data-act="task-close">✕</button></div>
    <div class="field"><label>Name</label><input data-tf="name" placeholder="E.g; Morning HN digest" value="${esc(t.name)}"></div>
    <div class="field"><label>Prompt <span style="opacity:.55;font-weight:400">(what the agent should do)</span></label><textarea data-tf="prompt" rows="3" placeholder="E.g; Read this page and summarize the top 5 stories.">${esc(t.prompt)}</textarea></div>
    <div class="field"><label>Start URL <span style="opacity:.55;font-weight:400">(page to open first — optional)</span></label><input data-tf="url" placeholder="https://news.ycombinator.com" value="${esc(t.url)}"></div>
    <div class="ptype" data-sel="${t.kind === "daily" ? 1 : 0}">
      <div class="lens glass"></div>
      <button class="opt" data-act="task-kind" data-kind="interval">Every N min</button>
      <button class="opt" data-act="task-kind" data-kind="daily">Daily at</button>
    </div>
    ${t.kind === "daily"
      ? `<div class="field"><label>Time (24h)</label><input data-tf="at" type="time" value="${esc(t.at || "09:00")}"></div>`
      : `<div class="field"><label>Interval (minutes, min 1)</label><input data-tf="every" type="number" min="1" placeholder="30" value="${esc(String(t.every || 30))}"></div>`}
    <div class="row" style="justify-content:center">
      <button class="btn good row" data-act="task-save" style="gap:6px">${ICON("done", 15)} Save</button>
      <button class="btn warn row" data-act="task-cancel" style="gap:6px">${ICON("close", 13)} Cancel</button>
    </div>`;
  return el;
}

// ---------- chat actions ----------
function setStatus(cls, msg) { const s = root.querySelector("[data-status]"); if (s) s.innerHTML = `<div class="status ${cls}">${esc(msg)}</div>`; }
async function doTest() {
  if (!editing.baseUrl || !editing.apiKey) return setStatus("bad", "Enter base URL and API key first.");
  setStatus("busy", "Testing…");
  try { const ids = await getModels(editing); setStatus("ok", `Connected — ${ids.length} models reachable.`); }
  catch (e) { setStatus("bad", "Failed: " + e.message); }
}
async function doFetch() {
  if (!editing.baseUrl || !editing.apiKey) return setStatus("bad", "Enter base URL and API key first.");
  setStatus("busy", "Fetching models…");
  try {
    const ids = await getModels(editing);
    const known = new Set(editing.models.map(m => m.id));
    for (const id of ids) if (!known.has(id)) editing.models.push({ id, displayName: id, vision: guessVision(id), ctxWindow: guessCtx(id) });
    setStatus("ok", `Fetched ${ids.length} models. Review names + vision below.`);
    render();
  } catch (e) { setStatus("bad", "Fetch failed: " + e.message + " (you can add models manually)"); }
}
async function doSave() {
  editing.models = editing.models.filter(m => m.id);
  // If the vault is enabled, encrypt the apiKey before persisting (stored as "iv:ct" blob).
  if (vault.enabled && vaultKey && editing.apiKey) {
    try { editing.apiKey = await vaultEncrypt(editing.apiKey); } catch {}
  }
  const existing = state.providers.find(x => x.id === editing.id);
  if (existing) Object.assign(existing, editing); else state.providers.push({ ...editing });
  if (!state.activeProviderId) { state.activeProviderId = editing.id; if (editing.models[0]) state.activeModelId = editing.models[0].id; }
  await persist(); editing = null; render();
}
function guessVision(id) { const s = (id || "").toLowerCase(); return /(gpt-4o|gpt-4-vision|gpt-4o-mini|vision|claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku|gemini|glm-4v|glm-4\.6v|minimax|abab|qwen-vl|llava|internvl)/.test(s); }

// Enable encryption (first time) or change the passphrase. Encrypts every provider's plaintext key.
async function enableOrChangeVault() {
  const pp = root.querySelector('[data-sec="pp"]')?.value || "";
  const pp2 = root.querySelector('[data-sec="pp2"]')?.value || "";
  const st = root.querySelector('.editor [data-status]') || root.querySelector('[data-status]');
  const bad = (m) => { if (st) st.innerHTML = `<span class="bad">${m}</span>`; };
  // Changing an EXISTING passphrase requires proving you know the current one —
  // an unlocked panel alone must not be enough to re-key the vault.
  if (vault.enabled) {
    const cur = root.querySelector('[data-sec="cur"]')?.value || "";
    if (!cur) return bad("Enter your current passphrase first.");
    const curKey = await deriveVaultKey(cur, vault.salt);
    if (await vaultDecrypt(vault.canary, curKey) !== "valid") return bad("Current passphrase is wrong.");
    vaultKey = curKey;   // decrypt below with the verified key
  }
  if (!pp) return bad("Enter a passphrase.");
  if (pp.length < 4) return bad("Use at least 4 characters.");
  if (pp !== pp2) return bad("Passphrases don't match.");
  const salt = b64enc(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const newKey = await deriveVaultKey(pp, salt);
  for (const p of state.providers) {
    if (!p.apiKey) continue;
    const plain = vault.enabled && vaultKey ? await vaultDecrypt(p.apiKey, vaultKey) : p.apiKey;
    if (plain != null) p.apiKey = await vaultEncrypt(plain, newKey);
  }
  vault = { enabled: true, salt, canary: await vaultEncrypt("valid", newKey) };
  vaultKey = newKey; locked = false;
  await persist(); await persistVault();
  try { await chrome.storage.session.set({ [SESSION_KEY]: pp }); } catch {}
  secOpen = false; render();
}
// Turn encryption off: decrypt every key back to plaintext and clear the vault.
// Also gated on the current passphrase — same reasoning as changing it.
async function disableVault() {
  const st = root.querySelector('.editor [data-status]') || root.querySelector('[data-status]');
  const cur = root.querySelector('[data-sec="cur"]')?.value || "";
  if (!cur) { if (st) st.innerHTML = `<span class="bad">Enter your current passphrase first.</span>`; return; }
  const curKey = await deriveVaultKey(cur, vault.salt);
  if (await vaultDecrypt(vault.canary, curKey) !== "valid") { if (st) st.innerHTML = `<span class="bad">Current passphrase is wrong.</span>`; return; }
  vaultKey = curKey;
  if (!confirm("Turn off encryption? Your API keys will be stored in plaintext again.")) return;
  for (const p of state.providers) {
    if (!p.apiKey) continue;
    const plain = await vaultDecrypt(p.apiKey, vaultKey);
    if (plain != null) p.apiKey = plain;
  }
  vault = { enabled: false, salt: null, canary: null };
  vaultKey = null; locked = false;
  try { await chrome.storage.session.remove(SESSION_KEY); } catch {}
  await persist(); await persistVault();
  secOpen = false; render();
}
// Unlock screen: derive a candidate key, verify the canary, then keep it for the session.
async function tryUnlock() {
  const inp = root.querySelector('[data-act="pp-input"]');
  const st = root.querySelector('[data-status]');
  const pp = inp ? inp.value : "";
  if (!pp) { if (st) st.innerHTML = `<span class="bad">Enter your passphrase.</span>`; return; }
  const key = await deriveVaultKey(pp, vault.salt);
  const canary = await vaultDecrypt(vault.canary, key);
  if (canary === "valid") {
    vaultKey = key; locked = false;
    try { await chrome.storage.session.set({ [SESSION_KEY]: pp }); } catch {}
    render();
  } else {
    if (st) st.innerHTML = `<span class="bad">Wrong passphrase — try again.</span>`;
    if (inp) inp.select();
  }
}
function guessCtx(id) {
  const s = (id || "").toLowerCase();
  if (/(opus-4-8|opus-4\.8|\[1m\]|1m|1000k|gemini.*1\.5|gemini-2)/.test(s)) return 1000000;
  if (/(gpt-5|gpt-4\.1|gpt-4o)/.test(s)) return 128000;
  if (/(sonnet|haiku|claude-4|claude-3|o1|o3|o4)/.test(s)) return 200000;
  if (/deepseek/.test(s)) return 128000;
  return 200000;
}

async function getTabId() {
  const p = new URLSearchParams(location.search).get("tabId");
  if (p && !isNaN(+p)) return +p;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id;
}

async function sendPrompt() {
  const ta = root.querySelector('[data-chat="input"]');
  const prompt = (ta?.value || "").trim();
  if (!prompt || chat.busy) return;
  const pair = activePair();
  if (!pair) return;
  const tabId = await getTabId();

  // ensure a conversation exists and bind chat.messages to it
  let conv = convs.list.find(c => c.id === convs.currentId);
  if (!conv) {
    conv = { id: uid(), title: prompt.slice(0, 42), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    convs.list.unshift(conv);
    convs.currentId = conv.id;
  }
  conv.messages.push({ role: "user", content: prompt });
  conv.updatedAt = Date.now();
  chat.messages = conv.messages;
  // build conversation history for the brain (multi-turn memory); strip tool chips from assistant text.
  // If an image (snip or image file) is attached, embed it in the last user message (vision models see it).
  const hasImage = !!(chat.attachment && chat.attachment.image && chat.attachment.dataUrl);
  const messages = chat.messages.map((m, i) => {
    const isLast = i === chat.messages.length - 1;
    if (m.role === "user" && isLast && hasImage) return { role: "user", content: { text: m.content, image: chat.attachment.dataUrl } };
    return { role: m.role, content: m.role === "assistant" ? cleanForHistory(m.content) : m.content };
  });
  if (hasImage) chat.attachment = null; // image consumed into the message; file attachments persist for upload_file
  chat.busy = true;
  ta.value = "";
  persistConvs();
  render();

  const isNewBrainSession = !conv.brainSessionId;
  if (isNewBrainSession) { conv.brainSessionId = crypto.randomUUID(); persistConvs(); }
  const sessionId = conv.brainSessionId;
  chat.sessionId = sessionId;

  // Preferred path: the agent loop runs INSIDE the extension (agent-core.js) — no local
  // server needed. Falls back to the legacy Node brain over SSE if AgentCore isn't loaded.
  if (window.AgentCore) {
    chat.coreSession = sessionId;
    try {
      const apiKey = await decryptedApiKey(pair.p);
      await window.AgentCore.start({
        sessionId, resume: !isNewBrainSession, messages, prompt,
        effort: chat.effort,
        provider: { name: pair.p.name, style: pair.p.style, baseUrl: pair.p.baseUrl, apiKey },
        model: { id: pair.m.id, displayName: pair.m.displayName, vision: pair.m.vision, ctxWindow: pair.m.ctxWindow || 200000 },
        onEvent: (e) => handleCoreEvent(sessionId, e),
        onTool: async (e) => { const tc = appendToolCall(e); return await runToolLocally(e, tc); },
      });
    } catch (e) {
      appendAssistant("⚠️ " + (e && e.message ? e.message : String(e)));
      finishChat();
    }
    return;
  }

  let started = false;
  const es = new EventSource(`${BRAIN}/api/events?sessionId=${sessionId}`);
  chat.evtSource = es;
  es.onmessage = (ev) => handleBrainEvent(sessionId, JSON.parse(ev.data));
  es.onopen = async () => {
    started = true;
    try {
      const apiKey = await decryptedApiKey(pair.p);
      const r = await fetch(`${BRAIN}/api/start`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, resume: !isNewBrainSession, messages, prompt, tabId, effort: chat.effort, provider: { name: pair.p.name, style: pair.p.style, baseUrl: pair.p.baseUrl, apiKey }, model: { id: pair.m.id, displayName: pair.m.displayName, vision: pair.m.vision, ctxWindow: pair.m.ctxWindow || 200000 } }),
      });
      const j = await r.json();
      if (!j.ok) { appendAssistant("⚠️ Brain refused the task: " + (j.error || "")); finishChat(); }
    } catch (e) {
      appendAssistant("⚠️ Could not reach the brain. Start it first:  node build/brain/brain.js\n\n(" + e.message + ")");
      finishChat();
    }
  };
  es.onerror = () => { if (!started) { appendAssistant("⚠️ Could not reach the brain. Is it running? (node build/brain/brain.js)"); finishChat(); } /* else auto-reconnect */ };
}

// Local (in-extension) event handler. Same events as the brain, except a `tool_call` event
// here is display-only (the stuck-loop guard's skipped call) — real execution happens via onTool.
function handleCoreEvent(sessionId, ev) {
  if (sessionId !== chat.sessionId) return;
  if (ev.type === "tool_call") {
    const tc = appendToolCall(ev);
    tc.status = "error"; tc.result = "skipped (stuck-loop guard)"; tc.endedAt = Date.now(); tc.durMs = 0;
    updateLiveAssistant();
    return;
  }
  handleBrainEvent(sessionId, ev);
}

function handleBrainEvent(sessionId, ev) {
  if (sessionId !== chat.sessionId) return;
  if (ev.type === "thinking") showThinking();
  else if (ev.type === "text") { clearThinking(); appendAssistant(ev.delta); }
  else if (ev.type === "tool_call") {
    clearThinking();
    const tc = appendToolCall(ev);
    executeToolAndReply(sessionId, ev, tc);
  }
  else if (ev.type === "done") { clearThinking(); finishChat(); }
  else if (ev.type === "stuck") { clearThinking(); if (scheduledRun) schedError = true; appendAssistant("\n⏸️ Paused — the agent was repeating the same action without progress. Tell it what to try next, or rephrase the task.\n"); finishChat(); }
  else if (ev.type === "error") { clearThinking(); if (scheduledRun) schedError = true; appendAssistant("\n⚠️ " + ev.message + "\n"); finishChat(); }
  else if (ev.type === "context") { chat.ctx = { used: ev.used || 0, limit: ev.limit || 1 }; updateCtxRing(); }
  else if (ev.type === "usage") { chat.usage = ev; updateUsageHud(); }
}

function showThinking() {
  clearThinking();
  let log = root.querySelector(".chat-log");
  if (!log) { log = document.createElement("div"); log.className = "chat-log"; root.querySelector(".chat-view")?.insertBefore(log, root.querySelector(".composer-wrap")); }
  thinkingEl = document.createElement("div");
  thinkingEl.className = "msg assistant thinking-row";
  thinkingEl.innerHTML = `<div class="thinking"><span class="think-spark">${sunburstSVG(18)}</span><span class="think-text"><span class="base">Thinking…</span><span class="shimmer">Thinking…</span></span></div>`;
  log.appendChild(thinkingEl);
  log.scrollTop = log.scrollHeight;
}
function clearThinking() {
  if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
  thinkingEl = null;
}

function appendAssistant(delta) {
  let last = chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
  if (!last || last.role !== "assistant") chat.messages.push({ role: "assistant", content: delta });
  else last.content += delta;
  updateLiveAssistant();
}
// Append a structured tool-call record to the current assistant message and drop a
// `[[tool:name#idx]]` marker into the content so the renderer places the card inline.
// Returns the record so executeToolAndReply can update its status on completion.
function appendToolCall(ev) {
  let msg = chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
  if (!msg || msg.role !== "assistant") { msg = { role: "assistant", content: "", tools: [] }; chat.messages.push(msg); }
  if (!msg.tools) msg.tools = [];
  const idx = msg.tools.length;
  const tc = { id: ev.id || uid(), tool: ev.tool, args: ev.args || {}, status: "running", result: "", image: null, startedAt: Date.now(), endedAt: null, durMs: null, open: false };
  msg.tools.push(tc);
  msg.content += `\n[[tool:${ev.tool}#${idx}]]\n`;
  updateLiveAssistant();
  return tc;
}
function renderPlain(content, tools) {
  const parts = content.split(/(\[\[tool:[^\]]+\]\])/);
  let html = "";
  for (const part of parts) {
    const tm = part.match(/^\[\[tool:([^\]]+)\]\]$/);
    if (tm) html += renderToolCardMarker(tm[1], tools);
    else html += esc(part).replace(/\n/g, "<br>");
  }
  return html;
}
function updateLiveAssistant() {
  const log = root.querySelector(".chat-log");
  if (!log) return;
  let bubble = log.lastElementChild;
  if (!bubble || !bubble.classList.contains("assistant") || bubble.classList.contains("thinking-row")) {
    bubble = document.createElement("div");
    bubble.className = "msg assistant";
    log.appendChild(bubble);
  }
  const msg = chat.messages[chat.messages.length - 1];
  // While streaming: plain text + cursor (no markdown re-parse => no scroll jumps).
  // When done: full markdown (applied on render()).
  const body = chat.busy ? renderPlain(msg.content, msg.tools) + '<span class="cursor"></span>' : renderAssistant(msg.content, msg.tools);
  bubble.innerHTML = `${ICON("clawd", 22, "avatar")}<div class="content">${body}</div>${chat.busy ? "" : assistantMeta()}`;
  // Only auto-scroll if the user is already near the bottom (don't yank if they scrolled up).
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function finishChat() {
  chat.busy = false;
  try { chat.evtSource && chat.evtSource.close(); } catch {}
  chat.evtSource = null;
  chat.coreSession = null;
  persistConvs();
  render();
  if (scheduledRun) finalizeScheduledRun();   // runner mode: notify + close windows
}
async function stopChat() {
  if (window.AgentCore && chat.coreSession) { try { window.AgentCore.stop(chat.coreSession); } catch {} }
  else { try { await fetch(`${BRAIN}/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: chat.sessionId }) }); } catch {} }
  appendAssistant("\n_(stopped)_");
  finishChat();
}
function newChat() { convs.currentId = null; chat.messages = []; chat.attachment = null; chat.ctx = null; chat.usage = null; persistConvs(); view = "chat"; render(); }
function loadConv(id) {
  const c = convs.list.find(x => x.id === id); if (!c) return;
  convs.currentId = id; chat.messages = c.messages; chat.ctx = null; chat.usage = null; view = "chat"; persistConvs(); render();
}
function deleteConv(id) {
  convs.list = convs.list.filter(c => c.id !== id);
  if (convs.currentId === id) { convs.currentId = null; chat.messages = []; }
  persistConvs(); render();
}
async function handleAttach(input) {
  const file = input.files && input.files[0]; if (!file) return;
  input.value = "";
  let dataUrl = null, base64 = null;
  try { dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(file); }); } catch {}
  if (dataUrl == null) return;
  base64 = dataUrl.split(",")[1];
  const isImage = file.type.startsWith("image/");
  let text = null;
  if (!isImage && (file.type.startsWith("text/") || /\.(txt|md|json|csv|js|ts|py|java|c|cpp|html|xml|yml|yaml|log)$/i.test(file.name))) {
    try { text = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsText(file); }); } catch {}
  }
  chat.attachment = { name: file.name, type: file.type || (isImage ? "image/png" : "application/octet-stream"), size: file.size, base64, text, image: isImage, dataUrl: isImage ? dataUrl : null };
  render();
}

// ---------- screen snip (region screenshot -> image attachment for vision models) ----------
async function handleSnip() {
  const pair = activePair(); if (!pair) return;
  const tabId = await getTabId();
  if (tabId == null) { alert("No active tab to snip."); return; }
  const tab = await chrome.tabs.get(tabId);
  let fullUrl;
  try { fullUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }); }
  catch (e) { alert("Screen capture failed: " + e.message); return; }
  showSnipOverlay(fullUrl);
}
function showSnipOverlay(dataUrl) {
  const ov = document.createElement("div");
  ov.className = "snip-overlay";
  ov.innerHTML = `<div class="snip-bar">Drag to select a region · Esc to cancel</div><div class="snip-stage"><img class="snip-img"><div class="snip-rect"></div></div>`;
  root.appendChild(ov);
  const img = ov.querySelector(".snip-img"); img.src = dataUrl;
  const rect = ov.querySelector(".snip-rect");
  let start = null;
  const pos = (e) => { const r = img.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  img.onpointerdown = (e) => { e.preventDefault(); img.setPointerCapture(e.pointerId); start = pos(e); rect.style.display = "block"; rect.style.left = start.x + "px"; rect.style.top = start.y + "px"; rect.style.width = "0px"; rect.style.height = "0px"; };
  img.onpointermove = (e) => { if (!start) return; const p = pos(e); const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y); rect.style.left = x + "px"; rect.style.top = y + "px"; rect.style.width = Math.abs(p.x - start.x) + "px"; rect.style.height = Math.abs(p.y - start.y) + "px"; };
  img.onpointerup = async (e) => { if (!start) return; const p = pos(e); const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; start = null; ov.remove(); if (r.w < 5 || r.h < 5) return; await doCrop(dataUrl, img, r); };
  const esc = (ev) => { if (ev.key === "Escape") { ov.remove(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}
async function doCrop(dataUrl, imgEl, r) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const scaleX = img.naturalWidth / imgEl.clientWidth, scaleY = img.naturalHeight / imgEl.clientHeight;
  const sx = r.x * scaleX, sy = r.y * scaleY, sw = r.w * scaleX, sh = r.h * scaleY;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(r.w)); canvas.height = Math.max(1, Math.round(r.h));
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL("image/png");
  chat.attachment = { name: "snip.png", type: "image/png", size: Math.round(out.length * 0.75), base64: out.split(",")[1], image: true, dataUrl: out };
  render();
}

// ---------- tool executor (no-CDP) ----------
// Confirmation gate — pause for a human OK before irreversible / destructive tool calls.
// Lives in the extension so it survives the brain→extension fold. Autonomous runs
// (scheduled tasks) set confirmGate=false to skip prompting.
let confirmGate = true;
function confirmMessage(name, a) {
  a = a || {};
  switch (name) {
    case "navigate":      return "Navigate this tab to:\n" + (a.url || "(unknown url)");
    case "close_tab":     return "Close tab " + (a.tabId ?? "(active)") + "?";
    case "eval":          return "Run this JavaScript on the page?\n\n" + String(a.code || "").slice(0, 300);
    case "set_cookie":    return "Set cookie \"" + (a.name || "") + "\" on " + (a.url || a.domain || "this site") + "?";
    case "delete_cookie": return "Delete cookie \"" + (a.name || "") + "\"?";
    default:              return null;
  }
}
// Run one tool locally: confirmation gate → execute → update its activity card. Returns the result.
// Shared by both the in-extension AgentCore path (onTool) and the legacy brain path.
async function runToolLocally(ev, tc) {
  const tabId = await getTabId();
  let result = { content: "", isError: false };
  console.log("[tool] ->", ev.tool, "tabId:", tabId, "args:", ev.args);
  const gateMsg = confirmGate ? confirmMessage(ev.tool, ev.args) : null;
  if (gateMsg && !confirm("The agent wants to:\n\n" + gateMsg)) {
    result = { content: "User declined this action at the confirmation prompt. Do not retry it — ask the user how they'd like to proceed instead.", isError: true };
  } else if (tabId == null) {
    result = { content: "no target tab — the side panel could not resolve an active tab. Click on a normal web page tab, then retry.", isError: true };
  } else {
    try { result = await executeTool(ev.tool, ev.args || {}, tabId); }
    catch (e) { result = { content: "tool error: " + (e && e.message ? e.message : String(e)), isError: true }; }
  }
  console.log("[tool] <-", ev.tool, result.isError ? "ERROR" : "ok", ":", String(result.content).slice(0, 200), result.image ? "(+image)" : "");
  if (tc) {
    tc.status = result.isError ? "error" : "done";
    tc.result = String(result.content ?? "");
    tc.image = result.image || null;
    tc.endedAt = Date.now();
    tc.durMs = tc.endedAt - tc.startedAt;
    updateLiveAssistant();
  }
  return result;
}
async function executeToolAndReply(sessionId, ev, tc) {
  const result = await runToolLocally(ev, tc);
  try {
    await fetch(`${BRAIN}/api/tool_result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, id: ev.id, content: result.content, imageData: result.image || null, isError: result.isError }) });
  } catch (e) { console.error("[tool] failed to POST result:", e); }
}
// Fast stable hash of a read_page result so we can detect "page unchanged" without deep-comparing.
function pageSig(r) {
  let s = (r && r.url || "") + "|" + (r && r.text || "");
  const els = (r && r.elements) || [];
  for (const e of els) s += "|" + (e.selector || "") + ":" + (e.text || "") + "@" + e.x + "," + e.y + "," + e.w + "x" + e.h;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}
function extractPageFn() {
  const SEL = 'a,button, input, textarea, select, [role="button"], [contenteditable=""], [contenteditable="true"]';
  const selFor = (el) => {
    if (el.id) { try { if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id); } catch (_) {} }
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
    if (tid) { try { return '[data-testid="' + CSS.escape(tid) + '"]'; } catch (_) {} }
    const parts = []; let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length === 1 ? tag : tag + ":nth-of-type(" + (Array.prototype.indexOf.call(sibs, cur) + 1) + ")");
      cur = parent; depth++;
      if (cur && cur.id) { try { if (document.querySelectorAll("#" + CSS.escape(cur.id)).length === 1) { parts.unshift("#" + CSS.escape(cur.id)); break; } } catch (_) {} }
    }
    return parts.join(" > ");
  };
  const text = (document.body && document.body.innerText || "").slice(0, 6000);
  const els = [];
  document.querySelectorAll(SEL).forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) return;
    const t = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.value || e.tagName).toString().slice(0, 40);
    els.push({ n: els.length, tag: e.tagName, role: e.getAttribute("role") || null, text: t, selector: selFor(e), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    if (els.length >= 60) return;
  });
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, text, elements: els };
}
// Resolve a click target (by read_page index `n` and/or `selector`) to its live center,
// re-measured in-page at click time so scroll/layout shifts are handled. `text` verifies.
// KEEP THE SEL SELECTOR + FILTER IN SYNC WITH extractPageFn ABOVE.
function resolveClickFn(n, selector, text) {
  const SEL = 'a,button, input, textarea, select, [role="button"], [contenteditable=""], [contenteditable="true"]';
  let el = null;
  if (selector) { try { el = document.querySelector(selector); } catch (_) { el = null; } }
  if (!el && n != null) {
    const els = [];
    document.querySelectorAll(SEL).forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) return;
      els.push(e);
    });
    el = els[n];
  }
  if (!el) return { ok: false, error: "element not found (n=" + n + ", selector=" + selector + ")" };
  const r = el.getBoundingClientRect();
  const got = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.tagName).toString().slice(0, 40);
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName, text: got, match: !text || text === got || got.includes(text) || text.includes(got) };
}
function typeIntoFn(selector, text) {
  const e = document.querySelector(selector);
  if (!e) return "element not found: " + selector;
  e.focus();
  if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") {
    // Use the native value setter so React/Angular/Vue-controlled inputs see the change
    // (assigning e.value directly bypasses their change tracking on controlled inputs).
    const proto = e.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(e, text); else e.value = text;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  else if (e.isContentEditable) { e.textContent = text; e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }
  else { e.setAttribute("value", text); e.dispatchEvent(new Event("input", { bubbles: true })); }
  return "typed into " + selector;
}
function uploadFileFn(selector, name, mime, base64) {
  const input = document.querySelector(selector);
  if (!input) return "file input not found: " + selector;
  try {
    const bin = atob(base64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true })); input.dispatchEvent(new Event("input", { bubbles: true }));
    return "set file " + name + " (" + bytes.length + " bytes) on " + selector;
  } catch (e) { return "upload error: " + e.message; }
}
// ---------- network + cookie + DNR (DevTools-grade) ----------
const netLog = new Map();
const netList = [];
let netStarted = false;
let dnrSeq = 100;
const ALL_RES_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "other", "script", "image", "stylesheet", "media", "font", "websocket"];
function initNetworkLogging() {
  if (netStarted) return; netStarted = true;
  try {
    chrome.webRequest.onBeforeRequest.addListener((d) => {
      const entry = { id: d.requestId, url: d.url, method: d.method, type: d.type, tabId: d.tabId, timestamp: Date.now(), reqBody: null, status: null, resHeaders: null };
      if (d.requestBody) {
        if (d.requestBody.raw && d.requestBody.raw[0] && d.requestBody.raw[0].bytes) { try { entry.reqBody = new TextDecoder().decode(d.requestBody.raw[0].bytes).slice(0, 4000); } catch {} }
        else if (d.requestBody.formData) entry.reqBody = JSON.stringify(d.requestBody.formData).slice(0, 4000);
      }
      netLog.set(d.requestId, entry); netList.push(entry);
      if (netList.length > 300) { const old = netList.shift(); if (old) netLog.delete(old.id); }
    }, { urls: ["<all_urls>"] }, ["requestBody"]);
    chrome.webRequest.onCompleted.addListener((d) => {
      const e = netLog.get(d.requestId); if (!e) return;
      e.status = d.statusCode;
      if (d.responseHeaders) e.resHeaders = d.responseHeaders.map(h => h.name + ": " + h.value).join("\n").slice(0, 4000);
    }, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  } catch (e) { console.warn("net logging init failed", e); }
}
// Send a no-CDP message to the actor content script; if the actor isn't present
// (e.g. tab was open before the extension loaded/reloaded), inject it then retry.
async function sendToActor(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const em = String((e && e.message) || e);
    if (!/Receiving end does not exist|Could not establish connection/i.test(em)) throw e;
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["nocdp-actor.js"] }); }
    catch (e2) { throw new Error("actor not present and injection failed (page may block extensions): " + String((e2 && e2.message) || e2)); }
    await new Promise((r) => setTimeout(r, 50));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}
async function executeTool(name, args, tabId) {
  const tid = args.tabId != null ? args.tabId : tabId;
  switch (name) {
    case "read_page": {
      let result;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: extractPageFn });
        result = r.result;
      } catch (e) {
        // Chrome blocks extension scripting on some pages (the Web Store gallery, chrome:// pages).
        // Fall back to CDP Runtime.evaluate via the debugger — it runs in the page's main world and
        // bypasses the extension-scripting policy. (Attaches the debugger → banner appears.)
        const msg = String((e && e.message) || e);
        try { result = await cdpEval(tid, "(" + extractPageFn.toString() + ")()"); }
        catch (e2) { return { content: "read_page blocked on this page (extension scripting disabled and CDP fallback failed): " + msg + " | " + String((e2 && e2.message) || e2), isError: true }; }
      }
      if (!result) return { content: "read_page returned no result", isError: true };
      // DOM-diff: if the page (same URL) is byte-for-byte unchanged since the last read of this tab,
      // drop the large `text` field and flag unchanged. The element list is still returned in full so
      // click-by-n indices stay valid; only the redundant page text is omitted to save context tokens.
      const sig = pageSig(result);
      const cached = pageCache.get(tid);
      if (cached && cached.url === result.url && cached.sig === sig) {
        return { content: JSON.stringify({ url: result.url, title: result.title, viewport: result.viewport, unchanged: true, text: "(page unchanged since last read — element list below is identical to the previous read_page; reuse it)", elements: result.elements }) };
      }
      pageCache.set(tid, { url: result.url, sig, text: result.text, elements: result.elements });
      return { content: JSON.stringify(result) };
    }
    case "click": {
      const b = args.button || "left";
      let x = args.x, y = args.y, label = `(${x},${y})`;
      if (args.n != null || args.selector) {
        let resolved;
        try {
          const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: resolveClickFn, args: [args.n ?? null, args.selector ?? null, args.text ?? null] });
          resolved = r.result;
        } catch (e) {
          try { resolved = await cdpEval(tid, "(" + resolveClickFn.toString() + ")(" + JSON.stringify(args.n ?? null) + "," + JSON.stringify(args.selector ?? null) + "," + JSON.stringify(args.text ?? null) + ")"); }
          catch (e2) { return { content: "click: resolve failed (page may block scripting): " + String((e2 && e2.message) || e), isError: true }; }
        }
        if (!resolved || !resolved.ok) return { content: "click: " + (resolved && resolved.error || "element not found") + " — call read_page to refresh the element list", isError: true };
        x = resolved.x; y = resolved.y;
        label = (args.n != null ? "#" + args.n + " " : "") + (args.selector || "") + ' "' + resolved.text + '" → (' + x + "," + y + ")" + (resolved.match === false ? " [text mismatch — verify]" : "");
      }
      if (x == null || y == null) return { content: "click: provide n, selector, or x,y", isError: true };
      await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mousePressed", x, y, button: b, clickCount: 1, buttons: b === "right" ? 2 : b === "middle" ? 4 : 1 });
      await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mouseReleased", x, y, button: b, clickCount: 1, buttons: 0 });
      return { content: `clicked ${label} (${b})` };
    }
    case "type": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: typeIntoFn, args: [args.selector, args.text] }); try { await sendToActor(tid, { __nocdp: true, kind: "phantom", at: "type", text: args.text }); } catch (_) {} return { content: r.result || "typed" }; }
    case "press_key": {
      const k = parseKeyCombo(args.key);
      const def = (CDP_KEYS && CDP_KEYS[k.key.toLowerCase()]) || {};
      const down = { __nocdp: true, kind: "key", type: "keyDown", key: k.key, code: def.code || "", modifiers: k.modifiers, windowsVirtualKeyCode: def.keyCode || 0 };
      await sendToActor(tid, down);
      // keyup may be lost if keydown submitted a form and the page navigated — that's fine.
      try { await sendToActor(tid, { ...down, type: "keyUp" }); } catch (_) {}
      return { content: "pressed " + args.key };
    }
    case "scroll": {
      let sx = args.x, sy = args.y;
      if (sx == null || sy == null) { try { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }) }); sx = r.result.x; sy = r.result.y; } catch (_) { sx = 200; sy = 200; } }
      await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mouseWheel", x: sx, y: sy, deltaX: args.dx || 0, deltaY: args.dy || 0 });
      return { content: `scrolled dx=${args.dx || 0} dy=${args.dy || 0} at (${sx},${sy})` };
    }
    case "navigate": { pageCache.delete(tid); await chrome.tabs.update(tid, { url: args.url }); return { content: "navigating to " + args.url }; }
    case "get_text": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: (s) => { const e = document.querySelector(s); return e ? e.innerText : null; }, args: [args.selector] }); return { content: r.result == null ? "element not found" : r.result }; }
    case "eval": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, world: "MAIN", func: (c) => { try { return eval(c); } catch (e) { return String(e); } }, args: [args.code] }); return { content: JSON.stringify(r.result) }; }
    case "list_tabs": { const tabs = await chrome.tabs.query({}); return { content: JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId })).slice(0, 50)) }; }
    case "new_tab": { const t = await chrome.tabs.create({ url: args.url, active: args.active !== false }); return { content: "opened tab " + t.id + " -> " + args.url }; }
    case "switch_tab": { await chrome.tabs.update(args.tabId, { active: true }); try { const t = await chrome.tabs.get(args.tabId); if (t.windowId) await chrome.windows.update(t.windowId, { focused: true }); } catch {} return { content: "switched to tab " + args.tabId }; }
    case "close_tab": { pageCache.delete(args.tabId); await chrome.tabs.remove(args.tabId); return { content: "closed tab " + args.tabId }; }
    case "attached_file": { if (!chat.attachment) return { content: "no file attached", isError: true }; const a = chat.attachment; return { content: JSON.stringify({ name: a.name, type: a.type, size: a.size, text: a.text || null }) }; }
    case "upload_file": {
      if (!chat.attachment) return { content: "no file attached", isError: true };
      const a = chat.attachment;
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: uploadFileFn, args: [args.selector || "input[type=file]", a.name, a.type, a.base64] });
      return { content: r.result || "upload failed" };
    }
    case "real_move": { await cdpMouseMove(tid, args.x, args.y); return { content: `real-moved to ${args.x},${args.y}` }; }
    case "real_click": {
      const btn = args.button || "left";
      let x = args.x, y = args.y;
      if (args.n != null || args.selector) {
        try { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: resolveClickFn, args: [args.n ?? null, args.selector ?? null, args.text ?? null] }); if (r.result && r.result.ok) { x = r.result.x; y = r.result.y; } }
        catch (e) { /* fall back to provided x,y */ }
      }
      if (x == null || y == null) return { content: "real_click: provide n, selector, or x,y", isError: true };
      try { await sendToActor(tid, { __nocdp: true, kind: "phantom", at: "click", x, y, button: btn }); } catch (_) {}
      await cdpMouseClick(tid, x, y, btn);
      return { content: `real-clicked (${x},${y}) (${btn})` };
    }
    case "real_type": {
      // Focus the field first (by selector DOM.focus, or by coordinate click), then trusted
      // select-all + delete + insertText so existing content is replaced (works on anti-cheat sites).
      if (args.selector != null && args.x == null) {
        await chrome.scripting.executeScript({ target: { tabId: tid }, func: (s) => { const e = document.querySelector(s); if (e) e.focus(); }, args: [args.selector] });
      } else if (args.x != null && args.y != null) {
        await cdpMouseClick(tid, args.x, args.y, "left");
      }
      await cdpTypeIntoFocused(tid, args.text);
      return { content: `real-typed ${String(args.text).length} chars` };
    }
    case "real_key": { await cdpKeyPress(tid, args.key); return { content: "real-pressed " + args.key }; }
    case "real_scroll": {
      let sx = args.x, sy = args.y;
      if (sx == null || sy == null) {
        const [vr] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }) });
        if (sx == null) sx = vr.result.x;
        if (sy == null) sy = vr.result.y;
      }
      await cdpSend(tid, "Input.dispatchMouseEvent", { type: "mouseWheel", x: sx, y: sy, deltaX: args.dx || 0, deltaY: args.dy || 0, button: "none", clickCount: 0 });
      return { content: `real-scrolled dx=${args.dx || 0} dy=${args.dy || 0} at (${sx},${sy})` };
    }
    case "screenshot": { return await captureScreenshot(tid); }
    case "get_cookies": {
      const f = {}; if (args.url) f.url = args.url; else if (args.domain) f.domain = args.domain; else return { content: "provide url or domain", isError: true };
      const cs = await chrome.cookies.getAll(f);
      return { content: JSON.stringify(cs.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate }))) };
    }
    case "set_cookie": { await chrome.cookies.set({ url: args.url, name: args.name, value: args.value, domain: args.domain, path: args.path || "/" }); return { content: "cookie set" }; }
    case "delete_cookie": { await chrome.cookies.remove({ url: args.url, name: args.name }); return { content: "cookie deleted" }; }
    case "list_network": { return { content: JSON.stringify(netList.slice(-60).map(e => ({ id: e.id, method: e.method, url: e.url, status: e.status, type: e.type }))) }; }
    case "get_network_request": { const e = netLog.get(args.id); return { content: e ? JSON.stringify(e) : "not found" }; }
    case "set_request_header": {
      const id = ++dnrSeq;
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: args.header, operation: "set", value: args.value }] }, condition: { urlFilter: args.urlFilter, resourceTypes: ALL_RES_TYPES } }] });
      return { content: "header rule added (id " + id + ")" };
    }
    case "block_url": {
      const id = ++dnrSeq;
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id, priority: 1, action: { type: "block" }, condition: { urlFilter: args.urlFilter, resourceTypes: ALL_RES_TYPES } }] });
      return { content: "block rule added (id " + id + ")" };
    }
    case "clear_net_rules": {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id) });
      return { content: "cleared " + rules.length + " rules" };
    }
    default: return { content: "unknown tool: " + name, isError: true };
  }
}
function parseKeyCombo(s) {
  const parts = String(s || "").split("+").map(p => p.trim());
  const key = parts[parts.length - 1]; let m = 0;
  for (const p of parts.slice(0, -1)) { const l = p.toLowerCase(); if (l === "ctrl" || l === "control") m |= 1; else if (l === "alt" || l === "option") m |= 2; else if (l === "shift") m |= 4; else if (l === "meta" || l === "cmd" || l === "command") m |= 8; }
  return { key, modifiers: m };
}
// ---------- browser-level trusted input via chrome.debugger + CDP ----------
// Like Perplexity Comet: attach the debugger to a tab and drive Input.dispatch*
// (mouse / key / insertText). Events are isTrusted:true — sites can't tell them
// from a human, so this is the fallback for anti-cheat/exam sites that block the
// synthetic (isTrusted:false) no-CDP events. Tradeoff: Chrome shows a "debugging"
// banner on the tab while attached (expected, harmless).
const attachedTabs = new Set();
// Reflect real_* (CDP debugger) state in the top-bar trusted-mode badge without a full re-render.
function updateTrustedIndicator() {
  const b = root.querySelector(".trusted-badge");
  if (!b) return;
  const on = attachedTabs.size > 0;
  b.classList.toggle("on", on);
  b.title = on
    ? "Trusted control ACTIVE — Chrome debugger attached (real_* mode). Chrome shows a 'debugging' banner on those tabs. Click for details."
    : "Stealth mode — real DOM events, no debugger, no banner. Lights up if the agent escalates to trusted (real_*) input.";
}
try {
  chrome.debugger.onDetach.addListener((src) => { if (src && src.tabId != null) attachedTabs.delete(src.tabId); updateTrustedIndicator(); });
  chrome.tabs.onRemoved.addListener((id) => {
    // Only detach if WE had a debugger on that tab; reading lastError in the callback
    // keeps Chrome from logging "Unchecked runtime.lastError: No tab with given id".
    if (attachedTabs.delete(id)) { try { chrome.debugger.detach({ tabId: id }, () => { void chrome.runtime.lastError; }); } catch {} }
    updateTrustedIndicator();
  });
} catch {}
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try { await chrome.debugger.attach({ tabId }, "1.3"); attachedTabs.add(tabId); updateTrustedIndicator(); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (!/already|another debugger/i.test(msg)) throw new Error("debugger attach failed: " + msg);
    // "already attached" — either by us (sendCommand works) or by another debugger (it won't).
    // Tentatively mark; cdpSend clears the flag again if sendCommand then fails, so the next
    // call retries (recoverable once the other debugger detaches).
    attachedTabs.add(tabId); updateTrustedIndicator();
  }
}
async function cdpSend(tabId, method, params) {
  await ensureAttached(tabId);
  try { return await chrome.debugger.sendCommand({ tabId }, method, params || {}); }
  catch (e) {
    // We're not actually attached (another debugger holds the tab, or it auto-detached on
    // navigation). Drop the flag so the next call re-attaches instead of failing forever.
    attachedTabs.delete(tabId); updateTrustedIndicator();
    throw e;
  }
}
async function cdpMouseMove(tabId, x, y) {
  await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
}
// CDP Runtime.evaluate — runs JS in the page's main world via the debugger. Bypasses Chrome's
// "extensions gallery cannot be scripted" block, so read_page works on the Web Store etc.
async function cdpEval(tabId, code) {
  const r = await cdpSend(tabId, "Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: false });
  if (r && r.exceptionDetails) throw new Error("eval error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "unknown"));
  return r && r.result && r.result.value;
}
async function cdpMouseClick(tabId, x, y, button) {
  const btn = button === "right" ? "right" : "left";
  await cdpMouseMove(tabId, x, y);
  if (button === "double") {
    // Two full click cycles (clickCount 1 then 2) — Chrome only fires dblclick after seeing both.
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2, buttons: 1 });
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2, buttons: 0 });
  } else {
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: 1, buttons: btn === "right" ? 2 : 1 });
    await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: 1, buttons: 0 });
  }
}
async function cdpInsertText(tabId, text) {
  // CDP insertText carries trusted text into the focused element.
  await cdpSend(tabId, "Input.insertText", { text: String(text) });
}
const IS_MAC = (() => { try { return /mac/i.test(navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || ""); } catch { return false; } })();
async function cdpTypeIntoFocused(tabId, text) {
  // Replace existing field content with trusted key input: select-all, delete, then insertText.
  await cdpKeyPress(tabId, IS_MAC ? "Meta+a" : "Control+a");
  await cdpKeyPress(tabId, "Backspace");
  await cdpInsertText(tabId, text);
}
// CDP modifier bitmask: 1=Alt, 2=Control, 4=Meta, 8=Shift
const CDP_KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 }, return: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 }, backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 }, "fwd-delete": { key: "Delete", code: "Delete", keyCode: 46 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 }, escape: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32 },
  "arrow-up": { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  "arrow-down": { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }, down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  "arrow-left": { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  "arrow-right": { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }, right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 }, end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 }, pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
function parseCdpKeyCombo(s) {
  const parts = String(s || "").split("+").map(p => p.trim()).filter(Boolean);
  const main = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  let modMask = 0;
  for (const m of mods) { const l = m.toLowerCase(); if (l === "ctrl" || l === "control") modMask |= 2; else if (l === "alt" || l === "option") modMask |= 1; else if (l === "shift") modMask |= 8; else if (l === "meta" || l === "cmd" || l === "command") modMask |= 4; }
  const named = CDP_KEYS[String(main).toLowerCase()];
  if (named) return { key: named.key, code: named.code, keyCode: named.keyCode, modifiers: modMask };
  // literal character key (e.g. 'a', 'F', '5'). Windows virtual-key codes: A-Z = 65-90, 0-9 = 48-57.
  const ch = String(main);
  let keyCode;
  if (/^[a-z]$/i.test(ch)) keyCode = ch.toUpperCase().charCodeAt(0);
  else if (/^[0-9]$/.test(ch)) keyCode = ch.charCodeAt(0);
  else keyCode = 0; // punctuation OEM codes vary; let key/code drive instead of a wrong keyCode
  const code = /^[a-z]$/i.test(ch) ? "Key" + ch.toUpperCase() : (/^[0-9]$/.test(ch) ? "Digit" + ch : "");
  return { key: ch, code, keyCode, modifiers: modMask };
}
async function cdpKeyPress(tabId, keyStr) {
  const k = parseCdpKeyCombo(keyStr);
  const down = { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await cdpSend(tabId, "Input.dispatchKeyEvent", down);
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers });
}
// ---------- screenshot (vision / computer-use) ----------
function loadImg(dataUrl) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; }); }
async function captureScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab captures the currently ACTIVE tab of the window, not tabId — so if the
  // target isn't active, activate it first (so the image and the measured viewport match the tab
  // we're actually operating on). This keeps screenshots debugger-free (no banner).
  if (!tab.active) { await chrome.tabs.update(tabId, { active: true }); await new Promise((r) => setTimeout(r, 200)); }
  const fullUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ w: window.innerWidth, h: window.innerHeight }) });
  const w = r.result.w, h = r.result.h;
  // Downscale the retina capture to 1:1 CSS pixels so image coords == viewport coords.
  const img = await loadImg(fullUrl);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/png");
  return { content: `screenshot ${w}x${h} (coordinates are image pixels, top-left origin 0,0; click tools use the same coordinate space)`, image: dataUrl };
}

// ============================================================
//  delegated events
// ============================================================
root.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const seg = nav.closest(".seg");
    const target = nav.dataset.nav;
    if (seg && view !== target) {
      // slide the lens in place first (gel squish), then switch views mid-flight
      seg.dataset.sel = target === "history" ? 1 : 0;
      const lens = seg.querySelector(".lens");
      if (lens) { lens.classList.remove("gel"); void lens.offsetWidth; lens.classList.add("gel"); }
      setTimeout(() => { view = target; render(); }, 230);
    } else { view = target; render(); }
    return;
  }
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const { act, id, tab, idx, theme: th } = t.dataset;
  switch (act) {
    case "logo": view = (view === "providers") ? "chat" : "providers"; render(); break;
    case "tasks-view": view = (view === "tasks") ? "chat" : "tasks"; taskEditing = null; render(); break;
    case "task-add": taskEditing = { id: "t_" + Math.random().toString(36).slice(2, 10), name: "", prompt: "", url: "", kind: "interval", every: 30, at: "09:00", enabled: true }; render(); break;
    case "task-edit": { const t2 = tasks.list.find(x => x.id === id); if (t2) { taskEditing = { ...t2 }; render(); } break; }
    case "task-kind": { if (taskEditing) { taskEditing.kind = t.dataset.kind; render(); } break; }
    case "task-close": case "task-cancel": taskEditing = null; render(); break;
    case "task-save": {
      if (!taskEditing) break;
      if (!taskEditing.prompt.trim()) { alert("Give the task a prompt — that's what the agent will do."); break; }
      if (!taskEditing.name.trim()) taskEditing.name = trunc(taskEditing.prompt.trim(), 36);
      const i2 = tasks.list.findIndex(x => x.id === taskEditing.id);
      if (i2 >= 0) tasks.list[i2] = taskEditing; else tasks.list.push(taskEditing);
      await saveTasks();
      await scheduleTaskAlarm(taskEditing);
      taskEditing = null; render();
      break;
    }
    case "task-del": {
      if (!confirm("Delete this scheduled task?")) break;
      try { await chrome.alarms.clear("nocdp_task_" + id); } catch {}
      tasks.list = tasks.list.filter(x => x.id !== id);
      await saveTasks(); render();
      break;
    }
    case "task-toggle": {
      const t2 = tasks.list.find(x => x.id === id); if (!t2) break;
      t2.enabled = !t2.enabled;
      await saveTasks();
      await scheduleTaskAlarm(t2);
      render();
      break;
    }
    case "task-run": {
      try {
        const r = await chrome.runtime.sendMessage({ type: "NOCDP_RUN_TASK", id });
        if (!r || !r.ok) alert("Could not launch the task runner: " + (r && r.error || "no response from service worker — reload the extension"));
      } catch (e2) { alert("Could not launch the task runner: " + e2.message); }
      break;
    }
    case "think": {
      // Figma spec: thinking on/off liquid switch (replaces the effort dropdown).
      if (chat.effort === "off") chat.effort = chat.lastEffort || "medium";
      else { chat.lastEffort = chat.effort; chat.effort = "off"; }
      chrome.storage.local.set({ [EFFORT_KEY]: chat.effort });
      t.classList.toggle("on", chat.effort !== "off");
      const th2 = t.querySelector(".tthumb");
      if (th2) { th2.classList.remove("gel"); void th2.offsetWidth; th2.classList.add("gel"); }
      break;
    }
    case "theme": await setTheme(th); break;
    case "add": editing = { id: uid(), name: "", style: "openai", baseUrl: "", apiKey: "", models: [] }; render(); break;
    case "edit": { const orig = state.providers.find(p => p.id === id); editing = JSON.parse(JSON.stringify(orig)); editing.apiKey = await decryptedApiKey(orig); render(); break; }
    case "del": if (confirm("Delete provider '" + (state.providers.find(p => p.id === id)?.name || "") + "'?")) { state.providers = state.providers.filter(p => p.id !== id); if (state.activeProviderId === id) { state.activeProviderId = null; state.activeModelId = null; } await persist(); render(); } break;
    case "tab": if (editing && editing.style !== tab) {
      editing.style = tab;
      const pt = t.closest(".ptype");
      if (pt) {
        pt.dataset.sel = tab === "anthropic" ? 1 : 0;
        const lens = pt.querySelector(".lens");
        if (lens) { lens.classList.remove("gel"); void lens.offsetWidth; lens.classList.add("gel"); }
        setTimeout(render, 260);
      } else render();
    } break;
    case "test": await doTest(); break;
    case "fetch": await doFetch(); break;
    case "manual": if (editing) { editing.models.push({ id: "", displayName: "", vision: false, ctxWindow: "" }); render(); } break;
    case "save": await doSave(); break;
    case "close": case "cancel": editing = null; render(); break;
    case "reveal-key": { const inp = root.querySelector('[data-f="apiKey"]'); if (inp) inp.type = inp.type === "password" ? "text" : "password"; break; }
    case "sec": secOpen = !secOpen; render(); break;
    case "sec-close": secOpen = false; render(); break;
    case "sec-enable": case "sec-change": { await enableOrChangeVault(); break; }
    case "sec-disable": { await disableVault(); break; }
    case "unlock": { await tryUnlock(); break; }
    case "reset-vault": {
      if (!confirm("Reset the key vault? Your encrypted API keys will be cleared and you'll need to re-enter them.")) break;
      for (const p of state.providers) p.apiKey = "";
      vault = { enabled: false, salt: null, canary: null };
      try { await chrome.storage.session.remove(SESSION_KEY); } catch {}
      vaultKey = null; locked = false;
      await persist(); await persistVault(); render();
      break;
    }
    case "trusted": { alert(attachedTabs.size ? ("Trusted control ACTIVE on " + attachedTabs.size + " tab(s). The agent escalated to real_* (Chrome debugger / CDP) input — Chrome shows a 'debugging' banner on those tabs. This is expected while real_* is in use and clears when the tab closes.") : "Trusted (real_*) mode is off. The agent is driving pages with no-CDP stealth — real DOM events, no debugger, no banner."); break; }
    case "rm-model": if (editing) { editing.models.splice(+idx, 1); render(); } break;
    case "send": await sendPrompt(); break;
    case "stop": await stopChat(); break;
    case "attach": root.querySelector('[data-act="attach-input"]')?.click(); break;
    case "snip": await handleSnip(); break;
    case "remove-attach": chat.attachment = null; render(); break;
    case "new-chat": newChat(); break;
    case "quick-prompt": { const ta = root.querySelector('[data-chat="input"]'); if (ta) { ta.value = t.dataset.prompt; await sendPrompt(); } break; }
    case "load-conv": loadConv(id); break;
    case "del-conv": if (confirm("Delete this conversation?")) deleteConv(id); break;
    case "copy": { const m = t.closest(".msg"); const src = m?.querySelector(".content, .bubble"); if (src) { const c = src.cloneNode(true); c.querySelectorAll(".toolcard").forEach(el => el.remove()); const txt = c.innerText; try { await navigator.clipboard.writeText(txt); const o = t.textContent; t.textContent = "Copied"; setTimeout(() => { t.textContent = o; }, 900); } catch {} } break; }
    case "copy-code": { const pre = t.closest(".code"); const txt = pre?.querySelector("code")?.innerText || ""; try { await navigator.clipboard.writeText(txt); t.textContent = "Copied"; setTimeout(() => { t.textContent = "Copy"; }, 900); } catch {} break; }
    case "tc-toggle": {
      const card = t.closest(".toolcard"); if (!card) break;
      const tc = findToolCard(t.dataset.tc || "");
      if (tc) tc.open = !tc.open;
      if (tc) card.outerHTML = renderToolCard(tc);
      break;
    }
    case "shot-zoom": {
      const src = t.getAttribute("src"); if (!src) break;
      const lb = document.createElement("div");
      lb.className = "shot-lightbox";
      lb.innerHTML = `<img src="${src}" alt="screenshot">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
      break;
    }
  }
});
root.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.chat === "input") {
    const send = t.closest(".composer")?.querySelector(".send");
    if (send && !chat.busy) { const on = t.value.trim().length > 0; send.classList.toggle("send-on", on); send.classList.toggle("send-off", !on); }
    t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px";
    return;
  }
  if (t.dataset.tf !== undefined) { if (taskEditing) { const f = t.dataset.tf; taskEditing[f] = f === "every" ? (parseInt(t.value, 10) || "") : t.value; } return; }
  if (!editing) return;
  if (t.dataset.f) editing[t.dataset.f] = t.value;
  if (t.dataset.mi !== undefined && t.dataset.idx !== undefined) { const m = editing.models[+t.dataset.idx]; if (m) { const mi = t.dataset.mi; m[mi] = mi === "ctxWindow" ? (t.value === "" ? "" : (parseInt(t.value, 10) || "")) : (t.type === "checkbox" ? t.checked : t.value); } }
});
root.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.act === "active") { const [pid, mid] = t.value.split("|"); state.activeProviderId = pid; state.activeModelId = mid; persist(); }
  else if (t.dataset.act === "attach-input") { handleAttach(t); }
  else if (t.dataset.act === "effort") { chat.effort = t.value; chrome.storage.local.set({ [EFFORT_KEY]: chat.effort }); }
});
root.addEventListener("keydown", (e) => {
  if (e.target.dataset.chat === "input" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});

// ---------- boot ----------
// Inject the liquid-glass backdrop once, into <body> (survives #root re-renders):
//  · SVG displacement filter used by .glass backdrop-filter: url(#liquid-lens)
//  · four drifting glow orbs behind everything
(function installGlassBackdrop() {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  defs.setAttribute("class", "defs");
  defs.innerHTML = `<filter id="liquid-lens" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="2" seed="7" result="noise"/>
    <feGaussianBlur in="noise" stdDeviation="2" result="soft"/>
    <feDisplacementMap in="SourceGraphic" in2="soft" scale="70" xChannelSelector="R" yChannelSelector="G"/>
  </filter>`;
  document.body.insertBefore(defs, document.body.firstChild);
  const orbs = document.createElement("div");
  orbs.className = "orbs";
  orbs.innerHTML = `<div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div><div class="orb o4"></div>`;
  document.body.insertBefore(orbs, document.body.firstChild);
})();

// Runner mode: nocdp-scheduler.js opened us as a popup with ?task=<id>&tabId=<n> —
// run that task's prompt autonomously against the tab, then notify + close.
const __taskParam = new URLSearchParams(location.search).get("task");
load().then(async () => {
  render();
  if (__taskParam) await startScheduledRun(__taskParam);
});
initNetworkLogging();

async function startScheduledRun(taskId) {
  const t = tasks.list.find(x => x.id === taskId);
  const fail = async (msg) => {
    try { chrome.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: "Scheduled task could not run", message: msg }); } catch {}
    if (t) { t.lastRun = Date.now(); t.lastStatus = "error"; await saveTasks(); }
    setTimeout(closeRunnerWindow, 1500);
  };
  if (!t) return fail("Task not found (id " + taskId + ").");
  if (locked) return fail('"' + t.name + '": API keys are locked by your passphrase vault. Open the side panel and unlock once per browser session.');
  if (!activePair()) return fail('"' + t.name + '": no active model configured in Providers.');
  scheduledRun = t; schedError = false;
  confirmGate = false;                       // autonomous run — nobody is present to answer confirm() popups
  // wait for the work tab (opened by the scheduler just before us) to finish loading
  const tid = await getTabId();
  scheduledRun.workTabId = tid;
  if (tid != null) {
    for (let i = 0; i < 30; i++) {
      try { const tab = await chrome.tabs.get(tid); if (tab.status === "complete") break; } catch { break; }
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 800));   // small settle for JS-heavy pages
  }
  newChat();
  const ta = root.querySelector('[data-chat="input"]');
  if (!ta) return fail("Runner UI failed to boot.");
  ta.value = "[Scheduled task: " + t.name + "]\n" + t.prompt;
  await sendPrompt();
}
async function closeRunnerWindow() {
  try { const w = await chrome.windows.getCurrent(); if (w && w.id != null) { await chrome.windows.remove(w.id); return; } } catch {}
  try { window.close(); } catch {}
}
async function finalizeScheduledRun() {
  const name = scheduledRun.name, workTabId = scheduledRun.workTabId, runId = scheduledRun.id;
  scheduledRun = null;
  const t = tasks.list.find(x => x.id === runId);
  if (t) { t.lastRun = Date.now(); t.lastStatus = schedError ? "error" : "ok"; await saveTasks(); }
  const lastA = [...chat.messages].reverse().find(m => m.role === "assistant");
  const bodyText = trunc(String(lastA && lastA.content || "").replace(/\[\[tool:[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim(), 120);
  try {
    chrome.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: (schedError ? "⚠ " : "✓ ") + name, message: bodyText || (schedError ? "Run hit an error — transcript in History." : "Done — transcript saved to History."), priority: schedError ? 2 : 0 });
  } catch {}
  // On success close the work window too (it fires every N min — don't pile up windows);
  // on error leave the page open so the user can see what went wrong.
  if (!schedError && workTabId != null) { try { const tab = await chrome.tabs.get(workTabId); if (tab && tab.windowId != null) await chrome.windows.remove(tab.windowId); } catch {} }
  setTimeout(closeRunnerWindow, 1200);
}

// external MCP control channel: lets MCP clients (e.g. Claude Code) drive this browser
const mcpES = new EventSource(`${BRAIN}/api/mcp_control`);
mcpES.onmessage = async (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type !== "mcp_tool_call") return;
  const tabId = await getTabId();
  let result = { content: "", isError: false };
  try { result = await executeTool(m.tool, m.args || {}, tabId); }
  catch (e) { result = { content: "error: " + e.message, isError: true }; }
  try {
    await fetch(`${BRAIN}/api/mcp_result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: m.id, content: typeof result.content === "string" ? result.content : JSON.stringify(result.content), imageData: result.image || null, isError: result.isError }) });
  } catch {}
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY]) { state = changes[KEY].newValue || state; if (!editing) render(); }
});