<div align="center">

# 🌿 NOCDP Browser Agent

**A Chrome extension that drives your browser like a human — no automation banner, no bot-detection trip, powered by your own API key.**

Reads pages · clicks · types · navigates · fills forms · solves tasks — all through a **Liquid Glass** chat sidebar, or driven headlessly as an MCP server.

<sub>Anthropic's "Claude in Chrome" body · Antigravity's invisible hands · your key · a hand-built Apple-style UI</sub>

</div>

---

## What it is

Most browser-automation tools (Puppeteer, Playwright, Selenium, the Chrome DevTools MCP) drive Chrome through the **Chrome DevTools Protocol** — they attach a debugger to the tab. That instantly raises the *"Chrome is being controlled by automated software"* banner and flips every signal a bot detector looks for. There is no quiet way to use CDP.

**This project never touches CDP for its default input.** The extension dispatches real `MouseEvent`/`KeyboardEvent` from a content script at page coordinates, screenshots via `chrome.tabs.captureVisibleTab`, and evaluates JS via `chrome.scripting` — ordinary extension APIs that leave no automation trace. The result reads as **"Definitely a Human"** on `bot.sannysoft.com`, `pixelscan.net`, and `fingerprint.com` (webdriver `false`, suspect-score `0`).

It was built by reverse-engineering two extensions:

| Source | What was kept |
|--------|---------------|
| **Anthropic — "Claude in Chrome"** | the side panel + tool-execution engine (the *body*) |
| **Google — Antigravity Browser Extension** | the no-CDP control trick — real DOM events, never `chrome.debugger` (the *hands*) |

Anthropic's polished body + Antigravity's invisible hands, wearing a bespoke **Liquid Glass** interface, and thinking with **your** model.

---

## ✨ Highlights

- 🕵️ **Invisible control** — synthetic-but-real DOM events, no debugger banner, passes bot detection.
- 🔑 **Bring your own key** — any OpenAI-style *or* Anthropic-style endpoint: OpenAI, Anthropic, OpenRouter, GLM, MiniMax, DeepSeek, Groq, Ollama (local/cloud), vLLM, LM Studio, and more. Keys stay in `chrome.storage.local`, on-device, never synced.
- 💬 **Liquid Glass UI** — Apple-inspired frosted-glass side panel: gel-spring segmented toggles, drifting glow orbs, real refraction (SVG displacement in `backdrop-filter`), Anthropic Serif Display type, true SSE token streaming, light + dark themes.
- 🧠 **Real agent loop** — the local brain runs a proper tool-use loop with your model; the panel executes tools in the live tab and streams results back.
- 🖼️ **Vision-aware** — vision models get downscaled screenshots (image px == click coords); text-only models fall back to `read_page`, so every model works.
- 🛡️ **Trusted-mode fallback** — anti-cheat / exam sites that ignore synthetic events? A `real_*` tool set escalates to genuine `chrome.debugger` CDP (`isTrusted:true`) — used only on demand, with Chrome's debugger banner as the honest tell.
- 🔌 **MCP bridge** — expose the same browser to external clients (e.g. Claude Code) over stdio JSON-RPC.
- 📎 **Batteries included** — conversation history, multi-tab control, file upload into page inputs, region-snip screenshots, cookie/network/DevTools tools, quick-prompt chips.

---

## 🏗️ Architecture

```
┌───────────────────────────── Chrome ─────────────────────────────┐
│  Side panel  (build/claude-ext)                                   │
│   ├─ Liquid Glass chat UI — streaming, history, providers, themes │
│   └─ No-CDP tool executor — content-script DOM events,            │
│      captureVisibleTab, chrome.scripting, cookies, webRequest,    │
│      declarativeNetRequest, + real_* CDP escalation on demand     │
│                                                                   │
│        ▲ SSE  /api/events            ▼ POST /api/start            │
│        │      /api/mcp_control              /api/tool_result       │
│        │                                    /api/stop  /api/…      │
│        ▼▲  http://127.0.0.1:7878                                   │
│                                                                   │
│  Local brain  (build/brain/brain.js — zero-dependency Node)       │
│   ├─ Agent loop: true token streaming + tool-use                  │
│   ├─ Talks to YOUR provider (OpenAI- or Anthropic-style)          │
│   └─ MCP bridge  (/api/mcp_*)                                     │
│                                                                   │
│        ▲ stdio JSON-RPC                                           │
│  build/brain/mcp.js  ← external MCP clients (Claude Code, …)      │
└───────────────────────────────────────────────────────────────────┘
```

The **brain** is the LLM loop (it holds no browser powers). The **side panel** is the body that executes every tool in Chrome. They talk over SSE + POST on `127.0.0.1:7878`.

---

## 🚀 Quick start

### 1 · Load the extension
1. Open `chrome://extensions` → toggle **Developer mode** on.
2. **Load unpacked** → select `build/claude-ext/`.
3. If the official "Claude" extension is installed, disable it to avoid an ID clash.

### 2 · Start the brain
```bash
bash build/brain/start.sh          # runs in background, logs → build/brain/brain.log
# foreground:  node build/brain/brain.js
# stop:        bash build/brain/stop.sh
# auto-start at login (optional):  bash build/brain/install.sh
```

### 3 · Add a provider
Open the side panel (extension icon or **Cmd+E**) → tap the **logo** (top-left) → **＋**:
- Choose **OpenAI** or **Anthropic** style (the toggle swaps the Base URL hint).
- Enter Base URL (with or without `/v1`) + API key → **Test Connection** → **Fetch Models**.
- Tune each model's display name, tick **vision** where supported → **✓ Save**.
- Pick one as the **Active model**.

### 4 · Chat
Back on **Chat**, type a prompt or tap a quick chip — *Solve the questions*, *Summarize this page*, *Fill the form*. The agent reads the active tab and acts. Flip the **Thinking** switch for extended reasoning.

### 5 · (Optional) Drive from Claude Code
```json
"nocdp-browser": { "command": "node", "args": ["/abs/path/build/brain/mcp.js"] }
```
Keep the side panel open while an external client drives it.

---

## 🧰 Tools the agent can use

**Page perception** — `read_page`, `get_text`, `screenshot`
**Standard (stealth) interaction** — `click`, `type`, `press_key`, `scroll`
**Trusted interaction** *(escalates to CDP; shows debugger banner)* — `real_click`, `real_move`, `real_type`, `real_key`, `real_scroll`
**Navigation & tabs** — `navigate`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`
**Scripting** — `eval`
**Files** — `attached_file`, `upload_file` *(set a site's `<input type=file>` — e.g. upload a résumé)*
**DevTools** — `get_cookies`, `set_cookie`, `delete_cookie`, `list_network`, `get_network_request`, `set_request_header`, `block_url`, `clear_net_rules`

Every page tool accepts an optional `tabId` to target a specific tab.

---

## 🎨 The Liquid Glass UI

The side panel is a hand-written, framework-free UI (`sidepanel.js` string templates + `sidepanel.css`) implementing an Apple **Liquid Glass** material system designed in Figma:

- **Glass material** — `backdrop-filter: blur + saturate + url(#liquid-lens)` (an SVG `feDisplacementMap` for true edge refraction, Chrome-only, with a graceful frosted fallback) + specular rim lighting via inset shadows.
- **Motion** — an iOS gel-spring curve (`cubic-bezier(.32,1.72,.46,.9)`); segmented toggles slide with a squish-stretch "gel" keyframe.
- **Depth** — four drifting radial-gradient glow orbs float behind everything.
- **Type** — Anthropic Serif Display (bundled woff2), true SSE streaming with a live caret.
- **Chat** — Clawd + Batman avatars, glass message bubbles, an always-visible model-name + copy row under each reply.
- **Themes** — full dark + light, plus system-follow.

Icons are exported from the Figma prototype and shipped as PNGs in `build/claude-ext/figma-icons/`. A standalone reference prototype lives in `liquid-glass-demo/index.html`.

---

## 📁 Project layout

```
Extention_rev/
├── build/
│   ├── claude-ext/              # the extension you load
│   │   ├── manifest.json
│   │   ├── sidepanel.html / .js / .css   # Liquid Glass UI + no-CDP tool executor
│   │   ├── nocdp-shim.js         # monkey-patches chrome.debugger → no-CDP (no banner)
│   │   ├── nocdp-actor.js        # content script: real DOM events + dialogs
│   │   ├── figma-icons/          # UI icons exported from the Figma prototype
│   │   └── assets/               # Anthropic fonts + original tool engine
│   └── brain/
│       ├── brain.js              # local brain: SSE+POST server, streaming agent loop
│       ├── mcp.js                # stdio MCP server for external clients
│       ├── start.sh / stop.sh    # manual control
│       └── install.sh / uninstall.sh   # optional launchd auto-start
├── liquid-glass-demo/           # standalone UI reference prototype (index.html)
├── fcoeoabgfenejglbffodgkkbkcdhcgfn/   # original Claude extension (RE source)
├── eeijfnjmjelapkebgockoeaadonbchdd/    # original Antigravity extension (RE source)
├── claude_ui_clone_spec.md
├── design-brief-for-open-design.md
└── README.md
```

---

## ✅ Status & 🔭 roadmap

**Working end-to-end** — no-CDP stealth (bot-sweep verified), universal provider config, streaming chat, conversation history, multi-tab, file upload, vision/screenshot, DevTools tools, `real_*` trusted fallback, MCP bridge, and the full Liquid Glass UI.

**Next up:**
- 🗂️ **Tool-call activity stream** — render tool calls as rich collapsible cards (name · args · status · folded result) with inline screenshot thumbnails, instead of plain chips.
- 🔐 **API-key reveal toggle** & **trusted-mode indicator** in the panel.
- ✂️ **History trimming** — drop old `read_page` bodies to keep long sessions inside the context window.
- 🔬 **Research / Deep-Research mode** (multi-site → `.md` report) — gated on history trimming.
- 📄 **PDF text extraction** — currently metadata-only for PDFs.

---

## 🔒 Scope & responsible use

Built for **personal automation, accessibility, testing your own sites, and avoiding false-positive bot blocks on legitimate browsing** — with your own credentials and your own API key. It is not a scraping fleet, a credential-stuffing tool, or a generalized anti-detection service. Use it on sites and tasks you're authorized to automate.

---

## 🙏 Credits

Reverse-engineered from **Anthropic's "Claude in Chrome"** (side panel + tool engine) and **Google's Antigravity Browser Extension** (the no-CDP control approach). Reuses their bundled Anthropic Serif / Sans / Mono fonts and design tokens. The Liquid Glass interface was designed by the author in Figma and hand-ported into the panel; the reference prototype is in `liquid-glass-demo/`.
