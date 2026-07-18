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
let view = "chat";

let chat = { messages: [], busy: false, sessionId: null, evtSource: null, attachment: null, effort: "off" };
let thinkingEl = null;
let convs = { list: [], currentId: null };

const root = document.getElementById("root");

// ---------- storage ----------
async function load() {
  const got = await chrome.storage.local.get([KEY, THEME_KEY, CONV_KEY, EFFORT_KEY]);
  state = got[KEY] || { providers: [], activeProviderId: null, activeModelId: null };
  if (!state.providers) state.providers = [];
  theme = got[THEME_KEY] || "dark";
  convs = got[CONV_KEY] || { list: [], currentId: null };
  if (!convs.list) convs.list = [];
  chat.effort = got[EFFORT_KEY] || "off";
  applyTheme();
}
async function persist() { await chrome.storage.local.set({ [KEY]: state }); }
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
function renderAssistant(content) {
  const parts = content.split(/(\[\[tool:[^\]]+\]\])/);
  let html = "";
  for (const part of parts) {
    const tm = part.match(/^\[\[tool:([^\]]+)\]\]$/);
    if (tm) html += `<div class="tooltag"><span class="dot">●</span> ${esc(tm[1])}</div>`;
    else html += mdToHtml(part);
  }
  return html;
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

// ============================================================
//  RENDERING
// ============================================================
function render() {
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
  v.appendChild(view === "providers" ? renderProvidersView() : view === "history" ? renderHistoryView() : renderChatView());
  root.appendChild(v);
  if (view === "chat") {
    const ta = v.querySelector('[data-chat="input"]'); if (ta && !chat.busy) ta.focus();
    const newLog = v.querySelector(".chat-log");
    if (newLog && saveScroll != null) newLog.scrollTop = saveScroll === "bottom" ? newLog.scrollHeight : saveScroll;
  }
}

function renderNav() {
  const el = document.createElement("div");
  el.className = "topbar";
  el.innerHTML = `
    <div class="row">
      <button class="icon-btn" data-act="toggle-history" title="Conversations">≡</button>
      <button class="icon-btn" data-act="new-chat" title="New chat">＋</button>
    </div>
    <div class="nav-tabs">
      <button data-nav="chat" class="${view === "chat" ? "active" : ""}">Chat</button>
      <button data-nav="providers" class="${view === "providers" ? "active" : ""}">Providers</button>
    </div>
    <div class="theme-switch">
      <button data-act="theme" data-theme="light" class="${theme === "light" ? "active" : ""}">Light</button>
      <button data-act="theme" data-theme="dark" class="${theme === "dark" ? "active" : ""}">Dark</button>
      <button data-act="theme" data-theme="system" class="${theme === "system" ? "active" : ""}">System</button>
    </div>`;
  return el;
}

// ---------- Providers view ----------
function renderProvidersView() {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const head = document.createElement("div");
  head.className = "between";
  head.innerHTML = `<div class="brand"><div class="mark">C</div><h1>Providers</h1></div>`;
  wrap.appendChild(head);
  wrap.appendChild(renderActiveBar());
  wrap.appendChild(renderProviderList());
  if (editing) wrap.appendChild(renderEditor());
  return wrap;
}
function renderActiveBar() {
  const el = document.createElement("div");
  el.className = "card";
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
    el.innerHTML = `<div class="card empty">No providers yet.<br><span class="muted">Add one — Anthropic, OpenAI, OpenRouter, GLM, MiniMax, Ollama… any OpenAI- or Anthropic-style endpoint.</span></div>`;
  } else for (const p of state.providers) {
    const isActive = state.activeProviderId === p.id;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="between">
        <div class="row"><strong>${esc(p.name) || "(unnamed)"}</strong><span class="badge">${p.style === "anthropic" ? "Anthropic-style" : "OpenAI-style"}</span>${isActive ? '<span class="badge active">active</span>' : ""}</div>
        <div class="row"><button class="small ghost" data-act="edit" data-id="${p.id}">Edit</button><button class="small ghost" data-act="del" data-id="${p.id}">Delete</button></div>
      </div>
      <div class="muted" style="font-size:11px;word-break:break-all">${esc(p.baseUrl) || "—"} · ${p.models.length} model${p.models.length === 1 ? "" : "s"}</div>`;
    el.appendChild(card);
  }
  const add = document.createElement("button");
  add.className = "primary"; add.dataset.act = "add"; add.textContent = "＋ Add provider";
  el.appendChild(add);
  return el;
}
function renderEditor() {
  const p = editing;
  const el = document.createElement("div");
  el.className = "card editor";
  el.innerHTML = `
    <div class="between"><h1 style="font-size:14px">Provider</h1><button class="small ghost" data-act="close">✕</button></div>
    <div class="tabs"><button data-act="tab" data-tab="openai" class="${p.style === "openai" ? "active" : ""}">OpenAI-style</button><button data-act="tab" data-tab="anthropic" class="${p.style === "anthropic" ? "active" : ""}">Anthropic-style</button></div>
    <div class="field"><label>Display name (shown in chat)</label><input data-f="name" placeholder="e.g. My OpenAI" value="${esc(p.name)}"></div>
    <div class="field"><label>Base URL</label><input data-f="baseUrl" placeholder="https://api.openai.com/v1  or  https://api.anthropic.com" value="${esc(p.baseUrl)}"></div>
    <div class="field"><label>API key</label><input data-f="apiKey" type="password" placeholder="sk-..." value="${esc(p.apiKey)}"></div>
    <div class="row"><button data-act="test">Test connection</button><button data-act="fetch">Fetch models</button></div>
    <div data-status></div>
    <hr>
    <div class="between"><strong>Models</strong><span class="muted" style="font-size:11px">id · display name · vision</span></div>
    <div data-models></div>
    <button data-act="manual" class="ghost small" style="align-self:flex-start">＋ Add model manually</button>
    <hr>
    <div class="row"><button class="primary" data-act="save">Save provider</button><button class="ghost" data-act="cancel">Cancel</button></div>`;
  renderModels(el);
  return el;
}
function renderModels(editorEl) {
  const p = editing, box = editorEl.querySelector("[data-models]");
  if (!p.models.length) { box.innerHTML = `<div class="muted" style="font-size:11px">No models yet — click "Fetch models" or add manually.</div>`; return; }
  box.innerHTML = p.models.map((m, i) => `<div class="model-row"><input data-mi="id" data-idx="${i}" placeholder="model id" value="${esc(m.id)}"><input data-mi="displayName" data-idx="${i}" placeholder="display name" value="${esc(m.displayName)}"><label class="check"><input type="checkbox" data-mi="vision" data-idx="${i}" ${m.vision ? "checked" : ""}>vision</label><button class="small ghost" data-act="rm-model" data-idx="${i}">✕</button></div>`).join("");
}

// ---------- Chat view ----------
function renderChatView() {
  const wrap = document.createElement("div");
  wrap.className = "chat-view";
  const pair = activePair();
  if (!pair) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    e.innerHTML = `${sunburstSVG(44)}<h1 class="serif">No provider set up</h1><p>Go to <strong data-nav="providers">Providers</strong> to add one.</p>`;
    wrap.appendChild(e);
    wrap.appendChild(renderComposer(null));
    return wrap;
  }
  if (!chat.messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML = `${sunburstSVG(44)}<h1 class="serif">How can I help you today?</h1><p>Read the page, click, type, run JS, navigate your current tab — like a human.</p>
      <div class="chips">
        <button class="chip" data-act="quick-prompt" data-prompt="Solve all the questions on this page. For each coding question: read it, analyze, write the code into the site's editor, click Run, check the output matches the expected output shown in the question, then click Submit and click Next. For MCQs: pick the appropriate option, click Submit, then Next. Do this for every question without stopping to ask me. Track which question you're on and report progress between questions.">Solve all questions on this page</button>
        <button class="chip" data-act="quick-prompt" data-prompt="Read this page and give me a concise summary of what it's about.">Read &amp; summarize</button>
        <button class="chip" data-act="quick-prompt" data-prompt="Fill out the form on this page with reasonable values, then stop and tell me what you entered.">Fill the form</button>
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
function renderMessage(msg) {
  const el = document.createElement("div");
  el.className = "msg " + msg.role;
  if (msg.role === "user") el.innerHTML = `<div class="bubble">${esc(msg.content)}</div><div class="actions"><button data-act="copy">Copy</button></div>`;
  else el.innerHTML = `<div class="content">${renderAssistant(msg.content)}</div><div class="actions"><button data-act="copy">Copy</button></div>`;
  return el;
}
function renderComposer(pair) {
  const w = document.createElement("div");
  w.className = "composer-wrap";
  const modelChip = pair ? `<div class="model-chip" data-nav="providers" title="Switch model">${esc(pair.m.displayName || pair.m.id)} ⌄</div>` : "";
  const stop = chat.busy;
  const sendClass = stop ? "send stop" : "send send-off";
  const sendAct = stop ? 'data-act="stop"' : 'data-act="send"';
  const icon = stop
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  const attachChip = chat.attachment ? `<div class="attach-chip" title="${esc(chat.attachment.name)}">${chat.attachment.image ? "🖼" : "📎"} ${esc(chat.attachment.name)} <button class="attach-x" data-act="remove-attach">✕</button></div>` : "";
  const effortSel = `<select class="effort-sel" data-act="effort" title="Reasoning effort"><option value="off" ${chat.effort === "off" ? "selected" : ""}>⚡Off</option><option value="low" ${chat.effort === "low" ? "selected" : ""}>⚡Low</option><option value="medium" ${chat.effort === "medium" ? "selected" : ""}>⚡Med</option><option value="high" ${chat.effort === "high" ? "selected" : ""}>⚡High</option></select>`;
  w.innerHTML = `${attachChip ? `<div class="attach-row">${attachChip}</div>` : ""}<div class="composer">${modelChip}${effortSel}<button class="icon-btn" data-act="attach" title="Attach a file">＋</button><button class="icon-btn" data-act="snip" title="Snip a screen region">✂</button><textarea data-chat="input" placeholder="How can I help you today?" rows="1"></textarea><button class="${sendClass}" ${sendAct}>${icon}</button></div><input type="file" data-act="attach-input" hidden><div class="composer-hint">Enter to send · Shift+Enter for newline${chat.attachment ? " · " + (chat.attachment.image ? "🖼 image attached" : "📎 attached") : ""}</div>`;
  return w;
}

// ---------- History view ----------
function renderHistoryView() {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const head = document.createElement("div");
  head.className = "between";
  head.innerHTML = `<h1>Conversations</h1><button class="primary small" data-act="new-chat">＋ New chat</button>`;
  wrap.appendChild(head);
  if (!convs.list.length) {
    const e = document.createElement("div");
    e.className = "card empty";
    e.innerHTML = `No conversations yet.<br><span class="muted">Start a chat and it'll be saved here automatically.</span>`;
    wrap.appendChild(e);
    return wrap;
  }
  for (const c of convs.list) {
    const card = document.createElement("div");
    card.className = "card conv-row";
    card.dataset.act = "load-conv";
    card.dataset.id = c.id;
    const isActive = c.id === convs.currentId;
    card.innerHTML = `
      <div class="between">
        <strong>${esc(c.title || "(untitled)")}</strong>
        <button class="small ghost" data-act="del-conv" data-id="${c.id}">Delete</button>
      </div>
      <div class="muted" style="font-size:11px">${new Date(c.updatedAt || c.createdAt || Date.now()).toLocaleString()} · ${c.messages.length} msg${c.messages.length === 1 ? "" : "s"}${isActive ? ' · <span style="color:var(--accent)">current</span>' : ""}</div>`;
    wrap.appendChild(card);
  }
  return wrap;
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
    for (const id of ids) if (!known.has(id)) editing.models.push({ id, displayName: id, vision: guessVision(id) });
    setStatus("ok", `Fetched ${ids.length} models. Review names + vision below.`);
    render();
  } catch (e) { setStatus("bad", "Fetch failed: " + e.message + " (you can add models manually)"); }
}
async function doSave() {
  editing.models = editing.models.filter(m => m.id);
  const existing = state.providers.find(x => x.id === editing.id);
  if (existing) Object.assign(existing, editing); else state.providers.push({ ...editing });
  if (!state.activeProviderId) { state.activeProviderId = editing.id; if (editing.models[0]) state.activeModelId = editing.models[0].id; }
  await persist(); editing = null; render();
}
function guessVision(id) { const s = (id || "").toLowerCase(); return /(gpt-4o|gpt-4-vision|gpt-4o-mini|vision|claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku|gemini|glm-4v|glm-4\.6v|minimax|abab|qwen-vl|llava|internvl)/.test(s); }

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

  const sessionId = crypto.randomUUID();
  chat.sessionId = sessionId;
  let started = false;
  const es = new EventSource(`${BRAIN}/api/events?sessionId=${sessionId}`);
  chat.evtSource = es;
  es.onmessage = (ev) => handleBrainEvent(sessionId, JSON.parse(ev.data));
  es.onopen = async () => {
    started = true;
    try {
      const r = await fetch(`${BRAIN}/api/start`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messages, prompt, tabId, effort: chat.effort, provider: { name: pair.p.name, style: pair.p.style, baseUrl: pair.p.baseUrl, apiKey: pair.p.apiKey }, model: { id: pair.m.id, displayName: pair.m.displayName, vision: pair.m.vision } }),
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

function handleBrainEvent(sessionId, ev) {
  if (sessionId !== chat.sessionId) return;
  if (ev.type === "thinking") showThinking();
  else if (ev.type === "text") { clearThinking(); appendAssistant(ev.delta); }
  else if (ev.type === "tool_call") {
    clearThinking();
    appendAssistant(`\n[[tool:${ev.tool}]]\n`);
    executeToolAndReply(sessionId, ev);
  }
  else if (ev.type === "done") { clearThinking(); finishChat(); }
  else if (ev.type === "error") { clearThinking(); appendAssistant("\n⚠️ " + ev.message + "\n"); finishChat(); }
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
function renderPlain(content) {
  const parts = content.split(/(\[\[tool:[^\]]+\]\])/);
  let html = "";
  for (const part of parts) {
    const tm = part.match(/^\[\[tool:([^\]]+)\]\]$/);
    if (tm) html += `<div class="tooltag"><span class="dot">●</span> ${esc(tm[1])}</div>`;
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
  const body = chat.busy ? renderPlain(msg.content) + '<span class="cursor"></span>' : renderAssistant(msg.content);
  bubble.innerHTML = `<div class="content">${body}</div><div class="actions"><button data-act="copy">Copy</button></div>`;
  // Only auto-scroll if the user is already near the bottom (don't yank if they scrolled up).
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function finishChat() {
  chat.busy = false;
  try { chat.evtSource && chat.evtSource.close(); } catch {}
  chat.evtSource = null;
  persistConvs();
  render();
}
async function stopChat() {
  try { await fetch(`${BRAIN}/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: chat.sessionId }) }); } catch {}
  appendAssistant("\n_(stopped)_");
  finishChat();
}
function newChat() { convs.currentId = null; chat.messages = []; chat.attachment = null; persistConvs(); view = "chat"; render(); }
function loadConv(id) {
  const c = convs.list.find(x => x.id === id); if (!c) return;
  convs.currentId = id; chat.messages = c.messages; view = "chat"; persistConvs(); render();
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
async function executeToolAndReply(sessionId, ev) {
  const tabId = await getTabId();
  let result = { content: "", isError: false };
  console.log("[tool] ->", ev.tool, "tabId:", tabId, "args:", ev.args);
  if (tabId == null) {
    result = { content: "no target tab — the side panel could not resolve an active tab. Click on a normal web page tab, then retry.", isError: true };
  } else {
    try { result = await executeTool(ev.tool, ev.args || {}, tabId); }
    catch (e) { result = { content: "tool error: " + (e && e.message ? e.message : String(e)), isError: true }; }
  }
  console.log("[tool] <-", ev.tool, result.isError ? "ERROR" : "ok", ":", String(result.content).slice(0, 200), result.image ? "(+image)" : "");
  try {
    await fetch(`${BRAIN}/api/tool_result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, id: ev.id, content: result.content, imageData: result.image || null, isError: result.isError }) });
  } catch (e) { console.error("[tool] failed to POST result:", e); }
}
function extractPageFn() {
  const text = (document.body && document.body.innerText || "").slice(0, 6000);
  const els = [];
  document.querySelectorAll('a,button, input, textarea, select, [role="button"], [contenteditable=""], [contenteditable="true"]').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) return;
    const t = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.value || e.tagName).toString().slice(0, 40);
    els.push({ i: els.length, tag: e.tagName, text: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    if (els.length >= 60) return;
  });
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, text, elements: els };
}
function typeIntoFn(selector, text) {
  const e = document.querySelector(selector);
  if (!e) return "element not found: " + selector;
  e.focus();
  if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") { e.value = text; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }
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
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: extractPageFn });
        return { content: JSON.stringify(r.result) };
      } catch (e) {
        // Chrome blocks extension scripting on some pages (the Web Store gallery, chrome:// pages).
        // Fall back to CDP Runtime.evaluate via the debugger — it runs in the page's main world and
        // bypasses the extension-scripting policy. (Attaches the debugger → banner appears.)
        const msg = String((e && e.message) || e);
        try {
          const val = await cdpEval(tid, "(" + extractPageFn.toString() + ")()");
          return { content: JSON.stringify(val) };
        } catch (e2) {
          return { content: "read_page blocked on this page (extension scripting disabled and CDP fallback failed): " + msg + " | " + String((e2 && e2.message) || e2), isError: true };
        }
      }
    }
    case "click": {
      const b = args.button || "left";
      await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mousePressed", x: args.x, y: args.y, button: b, clickCount: 1, buttons: b === "right" ? 2 : b === "middle" ? 4 : 1 });
      await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mouseReleased", x: args.x, y: args.y, button: b, clickCount: 1, buttons: 0 });
      return { content: `clicked ${args.x},${args.y} (${b})` };
    }
    case "type": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: typeIntoFn, args: [args.selector, args.text] }); return { content: r.result || "typed" }; }
    case "press_key": {
      const k = parseKeyCombo(args.key);
      await sendToActor(tid, { __nocdp: true, kind: "key", type: "keyDown", key: k.key, modifiers: k.modifiers });
      await sendToActor(tid, { __nocdp: true, kind: "key", type: "keyUp", key: k.key, modifiers: k.modifiers });
      return { content: "pressed " + args.key };
    }
    case "scroll": { await sendToActor(tid, { __nocdp: true, kind: "mouse", type: "mouseWheel", x: 200, y: 200, deltaX: args.dx || 0, deltaY: args.dy || 0 }); return { content: "scrolled" }; }
    case "navigate": { await chrome.tabs.update(tid, { url: args.url }); return { content: "navigating to " + args.url }; }
    case "get_text": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: (s) => { const e = document.querySelector(s); return e ? e.innerText : null; }, args: [args.selector] }); return { content: r.result == null ? "element not found" : r.result }; }
    case "eval": { const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, world: "MAIN", func: (c) => { try { return eval(c); } catch (e) { return String(e); } }, args: [args.code] }); return { content: JSON.stringify(r.result) }; }
    case "list_tabs": { const tabs = await chrome.tabs.query({}); return { content: JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId })).slice(0, 50)) }; }
    case "new_tab": { const t = await chrome.tabs.create({ url: args.url, active: args.active !== false }); return { content: "opened tab " + t.id + " -> " + args.url }; }
    case "switch_tab": { await chrome.tabs.update(args.tabId, { active: true }); try { const t = await chrome.tabs.get(args.tabId); if (t.windowId) await chrome.windows.update(t.windowId, { focused: true }); } catch {} return { content: "switched to tab " + args.tabId }; }
    case "close_tab": { await chrome.tabs.remove(args.tabId); return { content: "closed tab " + args.tabId }; }
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
      await cdpMouseClick(tid, args.x, args.y, btn);
      return { content: `real-clicked ${args.x},${args.y} (${btn})` };
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
try {
  chrome.debugger.onDetach.addListener((src) => { if (src && src.tabId != null) attachedTabs.delete(src.tabId); });
  chrome.tabs.onRemoved.addListener((id) => { attachedTabs.delete(id); try { chrome.debugger.detach({ tabId: id }, () => {}); } catch {} });
} catch {}
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try { await chrome.debugger.attach({ tabId }, "1.3"); attachedTabs.add(tabId); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (!/already|another debugger/i.test(msg)) throw new Error("debugger attach failed: " + msg);
    // "already attached" — either by us (sendCommand works) or by another debugger (it won't).
    // Tentatively mark; cdpSend clears the flag again if sendCommand then fails, so the next
    // call retries (recoverable once the other debugger detaches).
    attachedTabs.add(tabId);
  }
}
async function cdpSend(tabId, method, params) {
  await ensureAttached(tabId);
  try { return await chrome.debugger.sendCommand({ tabId }, method, params || {}); }
  catch (e) {
    // We're not actually attached (another debugger holds the tab, or it auto-detached on
    // navigation). Drop the flag so the next call re-attaches instead of failing forever.
    attachedTabs.delete(tabId);
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
  if (nav) { view = nav.dataset.nav; render(); return; }
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const { act, id, tab, idx, theme: th } = t.dataset;
  switch (act) {
    case "theme": await setTheme(th); break;
    case "add": editing = { id: uid(), name: "", style: "openai", baseUrl: "", apiKey: "", models: [] }; render(); break;
    case "edit": editing = JSON.parse(JSON.stringify(state.providers.find(p => p.id === id))); render(); break;
    case "del": if (confirm("Delete provider '" + (state.providers.find(p => p.id === id)?.name || "") + "'?")) { state.providers = state.providers.filter(p => p.id !== id); if (state.activeProviderId === id) { state.activeProviderId = null; state.activeModelId = null; } await persist(); render(); } break;
    case "tab": if (editing) { editing.style = tab; render(); } break;
    case "test": await doTest(); break;
    case "fetch": await doFetch(); break;
    case "manual": if (editing) { editing.models.push({ id: "", displayName: "", vision: false }); render(); } break;
    case "save": await doSave(); break;
    case "close": case "cancel": editing = null; render(); break;
    case "rm-model": if (editing) { editing.models.splice(+idx, 1); render(); } break;
    case "send": await sendPrompt(); break;
    case "stop": await stopChat(); break;
    case "attach": root.querySelector('[data-act="attach-input"]')?.click(); break;
    case "snip": await handleSnip(); break;
    case "remove-attach": chat.attachment = null; render(); break;
    case "new-chat": newChat(); break;
    case "quick-prompt": { const ta = root.querySelector('[data-chat="input"]'); if (ta) { ta.value = t.dataset.prompt; await sendPrompt(); } break; }
    case "toggle-history": view = (view === "history") ? "chat" : "history"; render(); break;
    case "load-conv": loadConv(id); break;
    case "del-conv": if (confirm("Delete this conversation?")) deleteConv(id); break;
    case "copy": { const m = t.closest(".msg"); const txt = m?.querySelector(".content, .bubble")?.innerText || ""; try { await navigator.clipboard.writeText(txt); const o = t.textContent; t.textContent = "Copied"; setTimeout(() => { t.textContent = o; }, 900); } catch {} break; }
    case "copy-code": { const pre = t.closest(".code"); const txt = pre?.querySelector("code")?.innerText || ""; try { await navigator.clipboard.writeText(txt); t.textContent = "Copied"; setTimeout(() => { t.textContent = "Copy"; }, 900); } catch {} break; }
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
  if (!editing) return;
  if (t.dataset.f) editing[t.dataset.f] = t.value;
  if (t.dataset.mi !== undefined && t.dataset.idx !== undefined) { const m = editing.models[+t.dataset.idx]; if (m) m[t.dataset.mi] = t.type === "checkbox" ? t.checked : t.value; }
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
load().then(render);
initNetworkLogging();

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