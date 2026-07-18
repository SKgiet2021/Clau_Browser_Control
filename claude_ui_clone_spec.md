# CLAUDE.AI CHAT UI — COMPLETE REPLICA SPECIFICATION
> Feed this entire document to your coding agent (Claude Code / Cursor / Copilot) as a single system prompt.
> Goal: pixel-accurate clone of claude.ai chat interface including the "thinking" loader.

---

## 1. DESIGN TOKENS (Claude.ai Design System)

### 1.1 Color Palette — Light Mode
| Token | Hex | Usage |
|---|---|---|
| bg-canvas | #F0ECE0 / #faf9f5 | Page background (warm cream, NOT pure white) |
| bg-composer | #FFFFFF | Input box surface |
| bg-card | #efe9de | Cream cards / secondary surfaces |
| border-subtle | #E5E0D6 | Composer border, dividers, mode-tab chips |
| user-bubble-bg | #E5E0D6 | User message bubble background |
| text-primary | #1a1a18 / #141413 | Main body/headline text (warm ink, not pure black) |
| text-muted | #5b5950 | Secondary/meta text, placeholders |
| accent-primary | #C96442 / #CC785C | Coral/terracotta — send button, links, active states, sparkle icon |
| dark-navy-surface | #181715 | Dark mode product surfaces / code blocks |

### 1.2 Color Palette — Dark Mode
| Token | Hex |
|---|---|
| bg-canvas | #2b2a27 |
| bg-composer | #1f1e1b |
| border-subtle | #3d3a35 |
| user-bubble-bg | #393937 |
| text-primary | #eeeeee |
| text-muted | #a3a098 |
| accent-primary | #C96442 (same in both modes) |

### 1.3 Typography
- Display / headings: serif font family "Copernicus" (fallback: Georgia, "Times New Roman", serif) — weight 400, tracking -1.5px
- Body / UI text: sans-serif "StyreneB" (fallback: -apple-system, "Inter", sans-serif) OR serif is used for chat message text on claude.ai (font-serif utility) for the editorial "typewriter/book" feel
- Assistant message line-height: 1.65rem (calm reading rhythm)
- 15 total type scale styles ranging from small caption to large serif display

### 1.4 Spacing & Shape
- Corner radii: 7 values ranging small (4px, chips) to large (24px, user bubble = rounded-2xl)
- Card padding: 32px
- Section rhythm: 96px vertical spacing on marketing pages (less relevant to chat UI itself)
- No box-shadows anywhere — flat design relies purely on 1px borders (#E5E0D6 light / #3d3a35 dark)

---

## 2. LAYOUT STRUCTURE

### 2.1 Empty State (new chat)
- Vertically + horizontally centered column containing:
  1. Sparkle icon (coral #C96442) + heading "How can I help you today?" (serif font)
  2. Composer box directly below heading
  3. Row of "Mode tabs" below composer: Write / Learn / Code / From Drive / From Calendar
     - Each tab: `rounded-lg border border-[#E5E0D6] bg-transparent`, blends into cream background, becomes active/filled on click

### 2.2 Active Chat State
- Sticky composer pinned to bottom of viewport
- Fade-out gradient overlay above composer (cream color fading to transparent) so text scrolls "under" it smoothly
- Message list scrolls above; no avatars shown for assistant, full-width plain text sitting directly on canvas (no bubble)
- User messages: right-aligned bubble, `rounded-2xl bg-[#E5E0D6] max-w-[80%]`

### 2.3 Composer (input box)
- No shadow, single 1px border `#E5E0D6`, background white (light) / #1f1e1b (dark)
- Rounded corners (large radius, ~16-20px)
- Left: "+" attach button, model-picker dropdown (e.g. Sonnet 4.5 / Opus 4.7 / Haiku 4.5 + "More options")
- Right: primary action button — CYCLES THROUGH 4 STATES depending on context:
  1. Dictate (mic icon) — default empty state
  2. Send (up-arrow, coral bg) — when text is typed
  3. Stop/Cancel (square icon) — while assistant is generating
  4. StopDictation — while voice input active

### 2.4 Message Action Bars (hover-only)
- User message: Edit + Copy icons appear only on `group-hover`, opacity transition
- Assistant message: Copy, thumbs-up, thumbs-down, Reload icons appear only on hover
- Implementation: wrap message in `group` class, action bar uses `opacity-0 group-hover:opacity-100 transition-opacity`

---

## 3. THE "THINKING" LOADER (core requirement)

Claude.ai shows two related but distinct loading affordances:

### 3.1 Shimmer text loader ("Thinking...")
Pure CSS/React shimmer sweep across muted text — used while waiting for first token or during extended thinking.

```jsx
"use client";
export default function ThinkingShimmer({ text = "Thinking...", className = "" }) {
  return (
    <div className={`inline-block ${className} select-none`}>
      <div className="relative overflow-hidden">
        {/* base dim text */}
        <span className="text-primary/30">{text}</span>
        {/* shimmering brighter overlay sweeping left-to-right */}
        <div
          className="absolute bg-clip-text text-transparent bg-gradient-to-r from-transparent via-black to-transparent z-10 top-0 left-0 right-0 bg-[length:50%_100%] bg-no-repeat"
          style={{ animation: "wave 1.4s linear infinite" }}
        >
          {text}
        </div>
      </div>
      <style jsx>{`
        @keyframes wave {
          0%   { background-position: -150% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}
```
For dark mode swap `via-black` to `via-white`.

### 3.2 Animated sparkle/orb sprite (the icon next to "Thinking")
Claude uses a small looping sprite-sheet animation (a pulsing/morphing star or orb icon) beside the shimmer text.

```jsx
"use client";
export default function ThinkingOrb() {
  return (
    <>
      <img
        src="/claude-sprite.svg"
        className="w-8 h-8 object-cover"
        alt="thinking indicator"
        style={{ animation: "spriteStep 2.5s steps(15, jump-none) infinite" }}
      />
      <style jsx>{`
        @keyframes spriteStep {
          from { object-position: 0% 0%; }
          to   { object-position: 0% 100%; }
        }
      `}</style>
    </>
  );
}
```
If you don't have a sprite sheet, substitute a CSS-only pulsing gradient circle (radial-gradient coral -> transparent) scaling 0.9→1.1 with `animation: pulse 1.6s ease-in-out infinite`.

### 3.3 Collapsible "Thinking" panel (extended thinking mode)
When Claude uses extended/step-by-step reasoning, the raw thought process renders in a collapsed, muted, monospace/serif-italic block above the final answer:
- Header row: small chevron toggle + "Thought for {n}s" label (muted text, clickable to expand/collapse)
- Body (when expanded): italic or slightly smaller muted-color text, scrollable, contained in a subtly bordered box, streams in token-by-token exactly like final answer
- Auto-collapses once the final answer begins streaming

### 3.4 Streaming answer text
- NOT a typewriter/fake-delay effect — implemented via true token streaming (Server-Sent Events / ReadableStream) from the Anthropic API `stream: true` parameter
- Each SSE chunk is appended to state and re-rendered; markdown re-parses incrementally
- Time-to-first-token should feel instant (<1s); perceived "thinking" time is filled by the shimmer loader in 3.1 before first token arrives, then loader is replaced by the streaming text

---

## 4. REFERENCE OPEN-SOURCE IMPLEMENTATIONS (give your agent these repos to study/fork)

| Project | Stack | What to copy |
|---|---|---|
| assistant-ui Claude Clone (assistant-ui.com/examples/claude) | React + Tailwind + assistant-ui lib | Full color palette, hover action bars, mode tabs, composer states — closest 1:1 clone |
| shadcn.io/design/claude | DESIGN.md spec file | Full 24 color tokens, 15 type styles, 7 radii, 9 spacing values, 30 component specs — downloadable and feedable directly to an AI agent |
| 13point5/open-artifacts (GitHub) | Next.js | Artifacts side-panel pattern |
| chihebnabil/claude-ui (GitHub) | Nuxt.js | Dark/light mode toggle, conversation storage |
| crfloyd/Anthropic-UI (GitHub) | Next.js 14 + Tailwind + shadcn/ui | Token counting, file attachments, conversation persistence |
| assistant-ui/assistant-ui (GitHub, core library) | TypeScript/React | Underlying primitives: Thread, Composer, MessagePrimitive components that power the Claude/ChatGPT/Gemini clones |

---

## 5. IMPLEMENTATION CHECKLIST FOR YOUR AGENT

1. Scaffold Next.js + Tailwind + shadcn/ui project
2. Install assistant-ui core (`@assistant-ui/react`) as the headless chat primitive layer, OR build Thread/Composer/Message components from scratch using the tokens above
3. Configure Tailwind theme with exact tokens from section 1.1–1.4 (light + dark)
4. Load "Copernicus" serif alternative (e.g. self-host or use "Source Serif 4" / "Lora" as free substitute) for headings; use system sans or "Inter" for UI chrome
5. Build Composer component with 4-state action button (section 2.3)
6. Build ThinkingShimmer + ThinkingOrb components (section 3.1–3.2)
7. Build collapsible ThoughtProcess component (section 3.3)
8. Wire Anthropic SDK `stream: true` → SSE → incremental markdown render (section 3.4)
9. Add hover-only action bars via group/group-hover pattern (section 2.4)
10. Add empty-state layout with mode tabs (section 2.1)
11. Test both light (#F0ECE0/#faf9f5 canvas) and dark (#2b2a27 canvas) themes
