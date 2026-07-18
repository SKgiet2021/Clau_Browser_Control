# Design Brief — "Browser Agent" Chrome Side-Panel AI Chat

## 0. What this product is

This is a **Chrome extension side panel**: a tall, narrow vertical pane that docks to the right edge of the Chrome browser window (roughly the width of a phone screen — narrow and tall, not a wide desktop app). Design everything for a **narrow, vertical, single-column layout** that can stretch to any height. This is a hard structural constraint, not a stylistic choice.

Inside this panel lives an **AI chat assistant that autonomously controls the user's web browser** — it can read the current web page, click buttons, type into fields, scroll, navigate to URLs, take screenshots, run JavaScript, manage browser tabs, and handle cookies/network. The user chats with it in plain language ("solve all the questions on this page", "fill out this form", "find me the cheapest flight") and the AI performs the actions live in the user's real browser tab, showing its progress in the chat.

The user supplies their **own AI provider and API key** (it works with any OpenAI-style or Anthropic-style API — OpenAI, Anthropic, OpenRouter, GLM, MiniMax, Ollama, etc.), so there is a configuration area for managing providers, keys, and models.

The overall feeling should be that of a **premium, calm, focused AI writing/assistant tool** — an editorial, trustworthy, "intelligent companion" product, not a noisy developer dashboard. It is used for real work (homework, forms, research, automation), sometimes for long autonomous multi-step runs the user watches unfold.

There are **three top-level screens**: **Chat**, **Providers** (API/model configuration), and **History** (past conversations). Plus a full-screen **Snip** overlay for capturing a screen region. Below is every element on every screen and exactly what it does.

---

## 1. Global chrome (persistent top bar)

A slim header bar is always visible at the top of the panel. It contains, as distinct controls:

- **Menu / Conversations toggle** — icon button (currently a "≡" hamburger/list glyph). Opens the History screen (list of past conversations). Toggles back to Chat when tapped again.
- **New chat** — icon button (currently a "＋" plus glyph). Clears the current conversation and starts a fresh one.
- **Screen switcher** — two text tabs: **"Chat"** and **"Providers"**. Switches the main area between the conversation and the API/model configuration screen. The active one is visually indicated.
- **Theme switcher** — a small 3-way segmented control: **Light**, **Dark**, **System**. Sets the color theme. The active option is indicated. (The product must support both a light and a dark theme fully.)

---

## 2. Chat screen

This is the primary screen. It has three possible states: **empty (no provider configured)**, **empty (ready, no messages yet)**, and **active conversation**. It always has the **composer** (input area) pinned at the bottom.

### 2a. Empty state — no provider configured
Shown when the user hasn't set up any AI provider/model yet. Contains:
- A **spark / sunburst emblem** — a 12-ray radiating asterisk/sparkle icon that is the product's signature mark (it also appears in the thinking animation). 
- A **headline**: "No provider set up".
- A **short line** prompting the user to go to the **Providers** screen to add one (the word "Providers" is a tappable link that switches screens).
- The composer is still shown but effectively inert until a provider exists.

### 2b. Empty state — ready, no messages
Shown when a provider/model is configured but the conversation is empty. Contains:
- The **spark / sunburst emblem** (larger, as a hero element).
- A **welcoming headline**: "How can I help you today?"
- A **one-line subtitle** describing the capability, e.g. "Read the page, click, type, run JS, navigate your current tab — like a human."
- A row of **quick-prompt chips** — tappable pill-shaped suggestion buttons that pre-fill and send a ready-made prompt. The current three are:
  - **"Solve all questions on this page"** (a long automation prompt for homework/quiz pages)
  - **"Read & summarize"**
  - **"Fill the form"**
  These are shortcuts; the set may grow. Design the chip system to hold 3–6 such suggestions gracefully.

### 2c. Active conversation
A vertically scrolling **message log**. Two kinds of messages:

- **User message** — the person's text. Shown as a distinct chat bubble aligned to represent "the user's turn". Plain text, preserves line breaks.
- **Assistant message** — the AI's reply. Full-width, **richly formatted markdown**: headings, paragraphs, **bold**, *italic*, bulleted lists, hyperlinks (open in a new tab), inline `code`, and multi-line **code blocks**. 
  - Each **code block** has a small header showing the language label and a **Copy** button that copies the code.
  - The assistant reply should feel like readable, book-quality prose (this is a text-heavy assistant).

**Message hover actions:** hovering a message reveals a small **Copy** button to copy that message's text. (Assistant and user both.)

**Streaming:** assistant replies stream in token-by-token in real time. While streaming, a small **blinking cursor** trails the text.

**Thinking indicator:** between sending and the first token, show a **"thinking" animation** — the spark/sunburst emblem gently rotating in stepped increments, next to the word **"Thinking…"** with a light left-to-right **shimmer** sweeping across the text. This reassures the user the agent is working.

**Tool-call display (VERY IMPORTANT — this is the heart of the product and the current weakest part):**
As the agent works, it calls "tools" (browser actions). Each tool call must be shown inline in the conversation as a distinct **tool activity item**. Today it is only a tiny line like "● read_page" with a colored dot — this is not enough. The redesigned tool item should be able to communicate, for each action:
- **Which tool ran** (a human-friendly name + ideally a distinct icon per tool category — see the tool list in §5).
- **Its key arguments** in a readable way — e.g. a click shows its coordinates `(382, 52)`; a "type" shows the text typed; a "navigate" shows the destination URL; an "eval" shows the code.
- **A live status**: running (in progress) → succeeded → failed. Each state visually distinct (e.g. a spinner while running, a check when done, a warning when errored).
- **The result / return value**, available but not overwhelming — ideally collapsed by default and expandable, since results can be long (a full page's text, a network dump, etc.).
- **Screenshots rendered as images**: when the agent calls the **screenshot** tool (or the user snips a region), the returned image should be shown **as an actual thumbnail image inline in the chat**, tappable to view larger — not as a text line. This is central to a browser agent: the user wants to see what the agent saw.
- Because an autonomous run can chain **many** tool calls in a row (dozens), design the tool items to be **compact and scannable** when stacked, and ideally **groupable/collapsible** so a long run doesn't bury the actual answer. Consider a way to visually tie a sequence of tool calls to the assistant turn that produced them.

**Error display:** when something fails (can't reach the AI backend, provider rejected the request, a tool errored, turn limit reached), show a clear, non-alarming **inline error notice** with a warning glyph and the message text.

### 2d. Composer (input area, pinned to bottom of Chat)
A single input container holding, as distinct controls:
- **Model chip** — a small pill showing the **currently active model's name** with a dropdown affordance ("⌄"). Tapping it jumps to the Providers screen to switch models. It should truncate gracefully for long model names.
- **Effort selector** — a small control (currently a dropdown) for the AI's **reasoning effort**, with four levels labeled: **⚡Off**, **⚡Low**, **⚡Med**, **⚡High**. This controls how hard the model "thinks" before answering. Persists across sessions.
- **Attach file** — icon button (currently "＋"). Opens a file picker; the user can attach a file (e.g. a resume to upload into a form, an image for a vision model, a text file to read). 
- **Snip** — icon button (currently "✂" scissors). Launches the full-screen **Snip overlay** (see §4) to capture a rectangular region of the current web page as an image to send to the AI.
- **Text input** — a multi-line, auto-growing text area with placeholder "How can I help you today?". Grows as the user types up to a max height, then scrolls.
- **Send / Stop button** — a prominent round action button. In its **Send** state it shows an **upward arrow** and is emphasized when there is text to send (dimmed/disabled when empty). While the agent is running it becomes a **Stop** button showing a **square/stop glyph** — tapping it aborts the current run.
- **Hint line** — tiny helper text beneath: "Enter to send · Shift+Enter for newline".
- **Attachment chip** — when a file or image is attached, a small pill appears above the input showing a **📎 (file)** or **🖼 (image)** glyph, the filename, and an **✕** to remove it. Snipped regions and attached images show here too.

---

## 3. Providers screen (API / model configuration)

Where the user manages AI providers, API keys, and models. It scrolls vertically. Contains, top to bottom:

- **Screen title** "Providers", accompanied by the product's brand mark (currently a simple "C" tile).
- **Active model selector** — a card with a dropdown listing every configured **provider · model** combination. The user picks which one is active for the session. Models capable of image understanding show a **👁 (eye / vision)** indicator. If nothing is configured yet, this card shows a short "no model active — add a provider" message instead.
- **Provider list** — one **card per configured provider**, each showing:
  - The provider's **display name**.
  - A **style badge**: either **"Anthropic-style"** or **"OpenAI-style"** (which API format it speaks).
  - An **"active" badge** if this provider holds the currently active model.
  - The **base URL** and a **model count** ("3 models").
  - **Edit** and **Delete** buttons.
  - If there are no providers yet, an **empty-state card** explains what a provider is and gives examples ("Anthropic, OpenAI, OpenRouter, GLM, MiniMax, Ollama… any OpenAI- or Anthropic-style endpoint").
- **"＋ Add provider"** — primary button that opens the provider editor.

### 3a. Provider editor (add / edit a provider)
Appears as a focused card/panel when adding or editing. Contains, as distinct controls:
- A **title** ("Provider") and a **close ✕** button.
- **API style tabs** — two options: **"OpenAI-style"** and **"Anthropic-style"**. Selects which API format this provider uses.
- **Display name** field — free text, the friendly name shown in chat (e.g. "My OpenAI").
- **Base URL** field — the API endpoint (e.g. `https://api.openai.com/v1` or `https://api.anthropic.com`), with example placeholder text.
- **API key** field — a **masked/password** input for the secret key. (A **show/hide reveal toggle** on this field would be a valuable addition — it does not exist yet.)
- **"Test connection"** button — checks the key/URL work and reports how many models are reachable.
- **"Fetch models"** button — pulls the provider's available model list automatically.
- **Status line** — a small inline message area showing **busy / success / error** states for the test/fetch actions (e.g. "Connected — 42 models reachable." or "Fetch failed: HTTP 401").
- **Models list** — the models under this provider. Each **model row** has:
  - A **model id** field (the API's model identifier).
  - A **display name** field (what shows in chat).
  - A **vision** checkbox — marks whether the model can understand images (enables image/snip/screenshot features for it).
  - A **remove ✕** button.
  - If empty, a hint: "No models yet — click 'Fetch models' or add manually."
- **"＋ Add model manually"** — adds a blank model row for endpoints that don't support auto-listing.
- **"Save provider"** (primary) and **"Cancel"** buttons.

---

## 4. Snip overlay (full-screen region capture)

Triggered by the **✂ Snip** button in the composer. A full-screen overlay on top of everything:
- A **dark dimming backdrop** over the whole screen.
- An **instruction bar** telling the user to drag to select a region.
- The **captured screenshot** of the current browser tab, shown to fit.
- The user **drags a rectangle** (crosshair cursor) to select a region; a **selection rectangle** with a highlighted fill tracks the drag.
- On release, the selected region is cropped and becomes an **image attachment** in the composer (shown as a 🖼 chip), ready to send to a vision-capable model. Pressing Escape cancels.

---

## 5. The agent's tools (context for designing tool-call items and per-tool icons)

The AI can call these browser-control tools. This list is provided so the designer understands what the **tool-call items in the chat (§2c)** must represent, and can design a coherent **icon set / visual language** grouping them by category. Each tool, its category, and what it does:

**Page reading / perception**
- **read_page** — reads the visible text of the page and a list of clickable elements with their positions. (The agent's "eyes" for text.)
- **get_text** — reads the text of one specific element.
- **screenshot** — captures the page as an image and shows it to the AI (vision models). Its result should render as an **inline image** in chat.

**Page interaction — standard (stealthy, looks human, default)**
- **click** — clicks at a coordinate on the page.
- **type** — types text into a form field.
- **press_key** — presses a key or key combo (Enter, Tab, Ctrl+Enter…).
- **scroll** — scrolls the page.

**Page interaction — "real"/trusted mode (for sites that block normal automation, e.g. CAPTCHAs, exam portals)**
- **real_click**, **real_move**, **real_type**, **real_key**, **real_scroll** — the same actions but driven at a deeper browser level that websites cannot distinguish from a genuine human. **Design note:** when the agent uses this mode, the browser shows a small "this tab is being debugged" banner, and this is a distinct, more powerful mode worth signaling in the UI (e.g. a subtle "trusted control / debug mode active" indicator). A per-tab indicator of **which tab the agent is controlling** and **whether trusted mode is on** would be a genuinely useful addition that does not exist yet.

**Navigation & tabs**
- **navigate** — go to a URL.
- **new_tab**, **switch_tab**, **close_tab**, **list_tabs** — open / focus / close / list browser tabs. (The agent can drive multiple tabs; a multi-tab awareness cue in the UI could help.)

**JavaScript**
- **eval** — runs arbitrary JavaScript in the page and returns the result.

**Files**
- **attached_file** — reads the file the user attached in the composer.
- **upload_file** — uploads that file into a web form's file input.

**Developer / network / cookies (advanced)**
- **get_cookies**, **set_cookie**, **delete_cookie** — read/modify cookies.
- **list_network**, **get_network_request** — inspect the page's network requests/responses.
- **set_request_header**, **block_url**, **clear_net_rules** — modify or block network requests.

A well-designed product would let these tool categories read at a glance in the chat stream (perception vs. interaction vs. navigation vs. advanced), so the user can follow a long autonomous run without reading every line.

---

## 6. States & feelings to cover (checklist for the designer)

Make sure the design accounts for **all** of these:
- First-run / **no provider configured**.
- **Ready but empty** chat (hero + quick-prompt chips).
- **Active conversation** with mixed user text, streamed assistant markdown, and many tool-call items.
- **Thinking** (rotating spark + shimmering text) and **streaming** (blinking cursor) states.
- **Tool call** in its **running / success / error** states, with **collapsible args + results** and **inline screenshot images**.
- **Long autonomous run** — dozens of stacked tool items that stay scannable and don't bury the final answer.
- **Errors** — backend unreachable, provider rejected, tool failed, turn-limit reached.
- **Attachment present** (file and image variants) and the **snip** capture flow.
- **Providers screen**: empty, populated, and the **editor** open (with test/fetch busy/ok/error status).
- **History screen**: empty and populated with conversation cards (title, timestamp, message count, "current" marker, delete).
- Full **light and dark** themes.
- Everything must work and look right in a **narrow, tall, single-column side panel**.

---

## 7. What NOT to constrain
This brief intentionally does **not** specify colors, spacing, fonts, exact placement, or visual styling — those are the designer's decisions. It defines only **what the product is, what every element is, what icons/controls exist, and what each does.** Design it to feel like a premium, calm, trustworthy AI assistant that a person is comfortable watching operate their browser for long stretches.
