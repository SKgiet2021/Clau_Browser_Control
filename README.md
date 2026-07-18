# NOCDP Browser Agent

A Chrome extension + local brain that drives your browser **like a human** — clicking, typing, reading, navigating — with **no "Chrome is being controlled by automated software" banner** and **no bot-detection trip**. You bring your own API key (any OpenAI- or Anthropic-style provider). It runs as a Claude-style chat sidebar and can also be driven externally as an MCP server.

It was built by reverse-engineering two extensions:
- **Anthropic's "Claude in Chrome"** — kept its sidebar + tool-execution engine as the body.
- **Google's Antigravity Browser Extension** — took its no-CDP control trick (real DOM events from a content script, never `chrome.debugger`).

The result: Anthropic's polished body + Antigravity's invisible hands, powered by **your** key.

---

## Why no banner?

Tools like Puppeteer, Playwright, and the Chrome DevTools MCP control Chrome via the **Chrome DevTools Protocol (CDP)** — attaching a debugger to the tab. That triggers the "controlled by automated software" banner and sets the signals bot detectors look for. There is no quiet way to use CDP.

This project never touches CDP. The extension's content script (`nocdp-actor.js`) dispatches **real `MouseEvent`/`KeyboardEvent`** at page coordinates, screenshots via `chrome.tabs.captureVisibleTab`, and evaluates JS via `chrome.scripting` — all extension APIs that leave no automation trace. Verified clean on `bot.sannysoft.com` and `pixelscan.net` (both report "Definitely a Human", CDP/webdriver clear).

---

## Architecture

```
┌──────────────────────── Chrome ────────────────────────┐
│  Side panel (build/claude-ext)                          │
│   ├─ Claude-style chat UI (Anthropic Serif, streaming)  │
│   ├─ Provider config (any OpenAI/Anthropic endpoint)    │
│   ├─ Conversation history + new chat                    │
│   └─ No-CDP tool executor (content-script DOM events,   │
│       captureVisibleTab, chrome.scripting, cookies,    │
│       webRequest, declarativeNetRequest)               │
│         ▲ SSE /api/events  ▼ POST /api/start,           │
│           /api/tool_result, /api/stop                  │
│         ▲▼ http://127.0.0.1:7878                        │
│  Local brain (build/brain/brain.js — zero-dep Node)    │
│   ├─ Agent loop (true streaming, tool-use)             │
│   ├─ Calls YOUR API key (OpenAI or Anthropic style)     │
│   └─ MCP bridge (/api/mcp_*)                           │
│         ▲ stdio JSON-RPC                                │
│  build/brain/mcp.js  ← external clients (Claude Code)   │
└─────────────────────────────────────────────────────────┘
```

The brain is the LLM loop; the side panel is the body that executes tools in Chrome. Keys live in `chrome.storage.local` (plaintext, on-device, never synced).

---

## Install & run

### 1. Load the extension
- `chrome://extensions` → **Developer mode** on → **Load unpacked** → select `build/claude-ext/`.
- Disable the official "Claude" extension if installed (avoids ID clash).

### 2. Start the brain
```bash
bash build/brain/start.sh        # background, logs to build/brain/brain.log
# or: node build/brain/brain.js   (foreground)
# stop:  bash build/brain/stop.sh
# auto-start at login (optional): bash build/brain/install.sh
```

### 3. Configure a provider
Open the side panel (click the extension icon or **Cmd+E**) → **Providers** → **＋ Add provider**:
- Pick **OpenAI-style** (OpenAI, OpenRouter, GLM, MiniMax, DeepSeek, Ollama local/cloud, vLLM, LM Studio…) or **Anthropic-style** (Anthropic Messages API).
- Base URL (with or without `/v1`), API key → **Test connection** → **Fetch models**.
- Edit each model's display name + tick **vision** if it supports images. Save → pick it as the **Active model**.

### 4. Chat
Type a prompt or click a quick-prompt chip ("Solve all questions on this page", "Read & summarize", "Fill the form"). The agent reads the active tab and acts.

### (Optional) Drive from Claude Code
Add to your MCP config:
```json
"nocdp-browser": { "command": "node", "args": ["/abs/path/build/brain/mcp.js"] }
```
Keep the side panel open while an external client drives it.

---

## Tools the agent can use

**Page (accept optional `tabId` to target a specific tab):**
`read_page`, `click`, `type`, `press_key`, `scroll`, `navigate`, `get_text`, `eval`, `upload_file`

**Tabs:** `list_tabs`, `new_tab`, `switch_tab`, `close_tab`

**Files:** `attached_file` (metadata + extracted text for text files), `upload_file` (set a site's `<input type=file>` to the attached file — e.g. upload a resume)

**DevTools (observe + modify):** `get_cookies`, `set_cookie`, `delete_cookie`, `list_network`, `get_network_request`, `set_request_header`, `block_url`, `clear_net_rules`

Vision models may use screenshots; non-vision models (e.g. GLM) use text tools (`read_page`/`get_page_text`) instead — so every model works.

---

## Project layout

```
Extention_rev/
├── build/
│   ├── claude-ext/            # the modified extension (load this)
│   │   ├── manifest.json
│   │   ├── sidepanel.html / sidepanel.js / sidepanel.css
│   │   ├── nocdp-shim.js       # monkey-patches chrome.debugger -> no-CDP (no banner)
│   │   ├── nocdp-actor.js      # content script: real DOM events, dialogs
│   │   └── assets/             # Anthropic fonts + original tool engine (mcpPermissions…)
│   └── brain/
│       ├── brain.js            # local brain: SSE+POST server, agent loop (streaming)
│       ├── mcp.js              # stdio MCP server for external clients
│       ├── start.sh / stop.sh  # manual control
│       └── install.sh / uninstall.sh  # optional launchd auto-start
├── fcoeoabgfenejglbffodgkkbkcdhcgfn/   # original Claude extension (RE source)
├── eeijfnjmjelapkebgockoeaadonbchdd/    # original Antigravity extension (RE source)
├── claude_ui_clone_spec.md    # chat UI spec the side panel follows
└── README.md
```

---

## Current state

Working end-to-end: drove YouTube (search → click → play), passed bot-detection sweeps. Features live: no-CDP stealth, universal provider config, streaming Claude-style chat, conversation history, multi-tab, file upload, DevTools tools, MCP bridge, homework task-loop prompt + quick chips, manual start/stop scripts.

## Known limitations / next

- **History trimming** — long tasks keep every `read_page` result in context; very long sessions (and the planned research mode) can blow the model's context. Next: drop old tool-result bodies, keep summaries.
- **Research / Deep Research + `.md` output** (the 50–60-site mode) — parked until history trimming lands.
- **PDF text extraction** — `attached_file` extracts text for text files only; PDFs give metadata (upload works, reading content does not). Next: pdf.js or brain-side lib.
- **Thinking animation** — currently a 3-step rotating sunburst. The real claude.ai sprite can be dropped in if fetched.

## Scope

Built for personal automation, accessibility, testing your own sites, and avoiding false-positive bot blocks on legitimate browsing. Not a scraping fleet or a generalized anti-bot-evasion toolkit.

## Credits

Reverse-engineered from Anthropic's "Claude in Chrome" and Google's Antigravity Browser extensions. Reuses their bundled Anthropic Serif/Sans/Mono fonts and design tokens; the no-CDP control approach is Antigravity's. Chat UI follows `claude_ui_clone_spec.md`.