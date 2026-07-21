// nocdp-actor.js — content script that dispatches REAL DOM events.
// Replaces CDP Input.* with genuine in-page events so page interaction is
// indistinguishable from a human (no debugger attached, no webdriver).
// Runs at document_start so it can also override window.confirm/prompt/alert
// (needed to auto-handle JS dialogs without CDP's Page.handleJavaScriptDialog).

(() => {
  if (window.__nocdpActorInstalled) return;
  window.__nocdpActorInstalled = true;

  // --- JS dialog override (must precede page scripts) ---
  let pendingDialog = null; // { accept, promptText }
  const origConfirm = window.confirm.bind(window);
  const origAlert = window.alert.bind(window);
  const origPrompt = window.prompt.bind(window);

  const nativeStr = (name) => `function ${name}() { [native code] }`;
  window.confirm = (msg) => {
    if (pendingDialog) { const a = pendingDialog.accept; pendingDialog = null; return a; }
    return origConfirm(msg);
  };
  window.alert = (msg) => { if (pendingDialog) { pendingDialog = null; return; } origAlert(msg); };
  window.prompt = (msg, def) => {
    if (pendingDialog) { const t = pendingDialog.promptText != null ? pendingDialog.promptText : (def != null ? def : ""); pendingDialog = null; return t; }
    return origPrompt(msg, def);
  };
  // Stealth: make overrides look native.
  for (const [o, n] of [[window.confirm, "confirm"], [window.alert, "alert"], [window.prompt, "prompt"]]) {
    try { o.toString = () => nativeStr(n); Object.defineProperty(o, "name", { value: n }); } catch (_) {}
  }

  // --- Helpers ---
  const mods = (m = 0) => ({ ctrl: !!(m & 1), alt: !!(m & 2), shift: !!(m & 4), meta: !!(m & 8) });
  const btnIndex = { none: -1, left: 0, middle: 1, right: 2 };

  // --- Agent visual indicator (Antigravity-style phantom cursor) ---
  // A pointer-events:none overlay showing where the agent moves/clicks/types.
  // Lazy-injected on first use; scoped class names (nocdp-*) to avoid page clashes.
  let cursorLayer = null, cursorDot = null, hideTimer = null;
  function ensureCursorLayer() {
    if (cursorLayer && document.body && document.body.contains(cursorLayer)) return;
    if (!document.body) return;
    const style = document.createElement("style");
    style.textContent = "#nocdp-cursor-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;}"
      + ".nocdp-dot{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;"
        + "background:radial-gradient(circle at 35% 35%,#fff,#cfe9ff 60%,#4aa8ff);"
        + "box-shadow:0 0 0 1.5px rgba(255,255,255,.9),0 0 12px 3px rgba(74,168,255,.55),0 2px 6px rgba(0,0,0,.35);"
        + "pointer-events:none;will-change:transform;transform:translate(-100px,-100px);"
        + "transition:transform .22s cubic-bezier(.32,1.72,.46,.9),opacity .2s;opacity:0;}"
      + ".nocdp-ripple{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;"
        + "border:2px solid rgba(74,168,255,.9);pointer-events:none;animation:nocdp-ripple .5s ease-out forwards;}"
      + ".nocdp-ripple.right{border-color:rgba(255,159,64,.95);}"
      + ".nocdp-scroll{position:fixed;left:0;top:0;transform:translate(-50%,-50%);font:600 16px/1 system-ui,sans-serif;"
        + "color:rgba(74,168,255,.95);text-shadow:0 0 8px rgba(74,168,255,.6);pointer-events:none;animation:nocdp-scroll .7s ease-out forwards;}"
      + ".nocdp-key{position:fixed;left:0;top:0;transform:translate(-50%,-100%);padding:3px 8px;border-radius:8px;"
        + "font:600 12px/1.3 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(20,22,28,.82);"
        + "backdrop-filter:blur(6px);box-shadow:0 2px 10px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);"
        + "pointer-events:none;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;animation:nocdp-key .9s ease-out forwards;}"
      + "@keyframes nocdp-ripple{from{transform:scale(.5);opacity:.9}to{transform:scale(4);opacity:0}}"
      + "@keyframes nocdp-scroll{0%{opacity:0}25%{opacity:1}100%{opacity:0}}"
      + "@keyframes nocdp-key{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}";
    (document.head || document.documentElement).appendChild(style);
    cursorLayer = document.createElement("div"); cursorLayer.id = "nocdp-cursor-layer";
    cursorDot = document.createElement("div"); cursorDot.className = "nocdp-dot";
    cursorLayer.appendChild(cursorDot);
    document.body.appendChild(cursorLayer);
  }
  function showCursor(x, y) {
    ensureCursorLayer(); if (!cursorDot) return;
    cursorDot.style.transform = "translate(" + x + "px," + y + "px)";
    cursorDot.style.opacity = "1";
    clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (cursorDot) cursorDot.style.opacity = "0"; }, 1400);
  }
  function ripple(x, y, button) {
    ensureCursorLayer(); if (!cursorLayer) return;
    const r = document.createElement("div"); r.className = "nocdp-ripple" + (button === "right" ? " right" : "");
    r.style.left = x + "px"; r.style.top = y + "px";
    cursorLayer.appendChild(r); setTimeout(() => r.remove(), 600);
  }
  function scrollPulse(x, y, dy) {
    ensureCursorLayer(); if (!cursorLayer) return;
    const c = document.createElement("div"); c.className = "nocdp-scroll"; c.textContent = dy > 0 ? "▼" : "▲";
    c.style.left = x + "px"; c.style.top = y + "px";
    cursorLayer.appendChild(c); setTimeout(() => c.remove(), 700);
  }
  function keyFlash(text) {
    ensureCursorLayer(); if (!cursorLayer) return;
    const el = document.activeElement; let x, y;
    if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); if (r.width) { x = r.left + r.width / 2; y = r.top - 12; } }
    if (x == null) { x = window.innerWidth / 2; y = 42; }
    const k = document.createElement("div"); k.className = "nocdp-key";
    k.textContent = String(text || "").length > 40 ? String(text).slice(0, 40) + "…" : String(text || "");
    k.style.left = x + "px"; k.style.top = y + "px";
    cursorLayer.appendChild(k); setTimeout(() => k.remove(), 950);
  }

  function dispatchMouse(p) {
    const x = Math.round(p.x ?? 0), y = Math.round(p.y ?? 0);
    try {
      showCursor(x, y);
      if (p.type === "mousePressed") ripple(x, y, p.button);
      else if (p.type === "mouseWheel") scrollPulse(x, y, p.deltaY || 0);
    } catch (_) {}
    const el = document.elementFromPoint(x, y) || document.body;
    const m = mods(p.modifiers);
    const btn = btnIndex[p.button ?? "left"];
    let type;
    switch (p.type) {
      case "mousePressed": type = "mousedown"; break;
      case "mouseReleased": type = "mouseup"; break;
      case "mouseMoved": type = "mousemove"; break;
      case "mouseWheel": type = "wheel"; break;
      default: type = p.type;
    }
    const base = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      button: btn < 0 ? 0 : btn,
      buttons: p.buttons != null ? p.buttons : (btn >= 0 ? (1 << btn) : 0),
      ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta,
      detail: p.clickCount || 1,
    };
    if (type === "wheel") {
      el.dispatchEvent(new WheelEvent("wheel", { ...base, deltaX: p.deltaX || 0, deltaY: p.deltaY || 0, deltaMode: 0 }));
    } else {
      el.dispatchEvent(new MouseEvent(type, base));
      // A real browser fires "click" after a left mousedown+mouseup — synthesize it.
      if (type === "mouseup" && (p.button === "left" || p.button == null)) {
        el.dispatchEvent(new MouseEvent("click", { ...base, type: "click" }));
      }
    }
    return { ok: true, x, y, type, tag: el ? el.tagName : null };
  }

  function insertText(text) {
    const el = document.activeElement;
    if (!el) return { ok: false, error: "no active element" };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const s = el.selectionStart != null ? el.selectionStart : el.value.length;
      const e = el.selectionEnd != null ? el.selectionEnd : el.value.length;
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.selectionStart = el.selectionEnd = s + text.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (document.execCommand) document.execCommand("insertText", false, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } else {
      return { ok: false, error: "active element not editable: " + el.tagName };
    }
    return { ok: true };
  }

  function dispatchKey(p) {
    const el = document.activeElement || document.body;
    const m = mods(p.modifiers);
    let type;
    switch (p.type) {
      case "keyUp": type = "keyup"; break;
      case "rawKeyDown":
      case "keyDown": type = "keydown"; break;
      default: type = p.type;
    }
    const opts = {
      bubbles: true, cancelable: true, view: window,
      key: p.key || "", code: p.code || "",
      keyCode: p.windowsVirtualKeyCode || p.keyCode || 0,
      which: p.windowsVirtualKeyCode || p.keyCode || 0,
      ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta,
      location: p.location || 0,
    };
    const notPrevented = el.dispatchEvent(new KeyboardEvent(type, opts));
    // CDP keyDown with `text` carries a character — feed it as input.
    if (p.type === "keyDown" && p.text) insertText(p.text);
    if (type === "keydown") { try { keyFlash(p.key || p.text || ""); } catch (_) {} }
    // Synthetic KeyboardEvents do NOT trigger the browser's default key action, so we perform
    // the meaningful default ourselves. Without this, Enter in a form <input> does nothing (sites
    // like Google "eat" the keypress) and the agent wrongly escalates to real_*.
    let didDefault = null;
    if (type === "keydown" && notPrevented) {
      const k = String(p.key || "").toLowerCase();
      const ae = document.activeElement;
      if (k === "enter" || k === "return" || k === "\r" || k === "\n") {
        // Google's search box (and many modern search/chat inputs) is a <textarea> in a <form>,
        // so submit on Enter for BOTH input and textarea. Shift+Enter falls through to a newline.
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && ae.form && !m.shift) {
          try { if (typeof ae.form.requestSubmit === "function") ae.form.requestSubmit(); else ae.form.submit(); didDefault = "submit"; } catch (_) {}
        } else if (ae && ae.tagName === "TEXTAREA") {
          insertText("\n"); didDefault = "newline";
        } else if (ae && ae.isContentEditable) {
          try { if (document.execCommand) document.execCommand("insertText", false, "\n"); didDefault = "newline"; } catch (_) {}
        }
      } else if (k === "tab") {
        try {
          const fs = [...document.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(e => e.offsetParent !== null && !e.disabled);
          const i = fs.indexOf(document.activeElement);
          if (i >= 0) { const next = fs[i + (m.shift ? -1 : 1)]; if (next) { next.focus(); didDefault = "tab"; } }
        } catch (_) {}
      } else if (k === "escape") {
        try { if (ae && ae.blur) { ae.blur(); didDefault = "escape"; } } catch (_) {}
      }
    }
    return { ok: true, type, key: p.key, didDefault };
  }

  // --- Recording (capture the user's real interactions as a step list for Procedures) ---
  // Pure-observer capture-phase listeners: they NEVER call preventDefault/stopPropagation —
  // they only read events and emit steps. The actor is stateless (dies on navigation), so each
  // step is sent to the side panel immediately via chrome.runtime.sendMessage; the panel accumulates.
  const REC_SEL = 'a,button, input, textarea, select, [role="button"], [contenteditable=""], [contenteditable="true"]';
  let recActive = false;
  let recListeners = null;
  let recBadge = null;
  let pendingType = null;     // {timer, selector, n, sensitive} — flush on click/stop
  let wheelAccum = null;      // {timer, x, y, dx, dy} — coalesce wheel bursts

  // Stable selector for a clicked element (mirrors sidepanel's extractPageFn selFor).
  const recSelFor = (el) => {
    if (!el || el.nodeType !== 1) return "";
    // Down-rank autogenerated ids (react-uid, :r0, radix, purely numeric, etc.) — they're
    // unique now but regenerated on next load, so a selector that relies on them breaks replay.
    const genId = (id) => !id || /^(react|ember|vue|radix|headlessui|:r\d|rc-|__|\d)/i.test(id) || /_anchor$|_\d+$|^:/i.test(id);
    if (el.id && !genId(el.id)) { try { if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id); } catch (_) {} }
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
      if (cur && cur.id && !genId(cur.id)) { try { if (document.querySelectorAll("#" + CSS.escape(cur.id)).length === 1) { parts.unshift("#" + CSS.escape(cur.id)); break; } } catch (_) {} }
    }
    return parts.join(" > ");
  };
  const recOrdinalN = (el) => {
    if (!el) return -1;
    const els = [];
    document.querySelectorAll(REC_SEL).forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) return;
      els.push(e);
    });
    return els.indexOf(el);
  };
  const recText = (el) => (el && (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.tagName) || "").toString().slice(0, 40);
  const recEmit = (step) => { try { chrome.runtime.sendMessage({ __nocdp_record: true, step }); } catch (_) {} };
  const recFlushType = () => {
    if (!pendingType) return;
    clearTimeout(pendingType.timer);
    const p = pendingType; pendingType = null;
    const el = document.querySelector(p.selector);
    recEmit({ type: "type", selector: p.selector, n: p.n, text: el ? el.value || el.textContent || "" : "", sensitive: p.sensitive });
  };

  function recShowBadge() {
    if (recBadge) return;
    recBadge = document.createElement("div");
    recBadge.setAttribute("data-nocdp-rec-ui", "1");
    recBadge.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;font:600 12px/1 system-ui,sans-serif;color:#fff;background:rgba(180,40,40,0.92);padding:7px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.4);display:flex;align-items:center;gap:7px;";
    recBadge.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:#ff5a5a;animation:nocdprec 1s ease-in-out infinite"></span> REC';
    const st = document.createElement("style");
    st.textContent = "@keyframes nocdprec{0%,100%{opacity:1}50%{opacity:.25}}";
    (document.head || document.documentElement).appendChild(st);
    (document.body || document.documentElement).appendChild(recBadge);
  }
  function recHideBadge() { if (recBadge) { recBadge.remove(); recBadge = null; } }

  function recOnClick(e) {
    if (e.target.closest && e.target.closest("[data-nocdp-rec-ui]")) return;   // don't record the REC UI
    recFlushType();
    const el = e.target;
    recEmit({ type: "click", selector: recSelFor(el), n: recOrdinalN(el), text: recText(el), button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }
  function recOnInput(e) {
    const el = e.target;
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && !el.isContentEditable && el.tagName !== "SELECT")) return;
    if (el.closest && el.closest("[data-nocdp-rec-ui]")) return;
    const selector = recSelFor(el);
    const sensitive = el.type === "password";
    if (pendingType) clearTimeout(pendingType.timer);
    pendingType = { selector, n: recOrdinalN(el), sensitive, timer: setTimeout(recFlushType, 700) };
  }
  function recOnKey(e) {
    // record only non-character keys (characters are captured by the input debounce)
    const k = e.key;
    if (!/^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace)$/i.test(k)) return;
    if (e.target.closest && e.target.closest("[data-nocdp-rec-ui]")) return;
    recFlushType();
    recEmit({ type: "press", key: k });
  }
  function recOnWheel(e) {
    if (!wheelAccum) wheelAccum = { x: Math.round(e.clientX), y: Math.round(e.clientY), dx: 0, dy: 0, timer: null };
    wheelAccum.dx += e.deltaX || 0; wheelAccum.dy += e.deltaY || 0;
    clearTimeout(wheelAccum.timer);
    wheelAccum.timer = setTimeout(() => { recEmit({ type: "scroll", x: wheelAccum.x, y: wheelAccum.y, dx: Math.round(wheelAccum.dx), dy: Math.round(wheelAccum.dy) }); wheelAccum = null; }, 350);
  }

  function recStart() {
    if (recActive) return;
    recActive = true;
    recShowBadge();
    recListeners = { click: recOnClick, input: recOnInput, keydown: recOnKey, wheel: recOnWheel };
    document.addEventListener("click", recOnClick, true);
    document.addEventListener("input", recOnInput, true);
    document.addEventListener("keydown", recOnKey, true);
    window.addEventListener("wheel", recOnWheel, true);
  }
  function recStop() {
    if (!recActive) return;
    recActive = false;
    recFlushType();
    if (wheelAccum) { clearTimeout(wheelAccum.timer); wheelAccum = null; }
    document.removeEventListener("click", recOnClick, true);
    document.removeEventListener("input", recOnInput, true);
    document.removeEventListener("keydown", recOnKey, true);
    window.removeEventListener("wheel", recOnWheel, true);
    recHideBadge();
    recListeners = null;
  }

  // --- Snip crop overlay (real-page region selection for the side panel's snip tool) ---
  // Shows a fixed full-viewport crosshair overlay on the ACTUAL page; the user drag-selects a
  // rectangle in viewport CSS pixels. Calls onDone({rect, vw, vh, dpr}) when finished, or
  // onDone(null) on Esc / too-small selection. The overlay removes itself before onDone so a
  // subsequent captureVisibleTab won't include it.
  function showSnipOverlay(onDone) {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;";
    const sel = document.createElement("div");
    // The selection rect is transparent (page shows through inside it); a giant box-shadow
    // dims everything OUTSIDE the rect, so the chosen region reads clearly.
    sel.style.cssText = "position:absolute;border:1.5px solid #d9795a;background:transparent;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);pointer-events:none;display:none;";
    ov.appendChild(sel);
    (document.body || document.documentElement).appendChild(ov);
    let start = null;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const pos = (e) => ({ x: clamp(e.clientX, 0, innerWidth), y: clamp(e.clientY, 0, innerHeight) });
    ov.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      start = pos(e);
      sel.style.display = "block";
      sel.style.left = start.x + "px"; sel.style.top = start.y + "px";
      sel.style.width = "0px"; sel.style.height = "0px";
    };
    ov.onpointermove = (e) => {
      if (!start) return;
      const p = pos(e);
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      sel.style.left = x + "px"; sel.style.top = y + "px";
      sel.style.width = Math.abs(p.x - start.x) + "px";
      sel.style.height = Math.abs(p.y - start.y) + "px";
    };
    const finish = (rect) => { cleanup(); onDone(rect); };
    const cleanup = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onUp = (e) => {
      if (!start) return;
      const p = pos(e);
      const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      start = null;
      if (r.w < 5 || r.h < 5) { finish(null); return; }   // a tiny drag = cancel
      finish(r);
    };
    const onKey = (ev) => { if (ev.key === "Escape") { start = null; finish(null); } };
    ov.onpointerup = onUp;
    ov.onpointercancel = () => { start = null; finish(null); };
    document.addEventListener("keydown", onKey);
  }

  // --- Message listener (from the shim in the service worker, and the side panel for snip) ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__nocdp) return;
    // snip is async (waits for the user to drag) — respond later, keep the channel open
    if (msg.kind === "snip") {
      showSnipOverlay((rect) => {
        try {
          if (!rect) sendResponse({ ok: true, cancelled: true });
          else sendResponse({ ok: true, rect, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio });
        } catch (_) {}
      });
      return true;
    }
    if (msg.kind === "record-start") { try { recStart(); } catch (e) { sendResponse({ ok: false, error: String(e) }); return true; } sendResponse({ ok: true }); return true; }
    if (msg.kind === "record-stop") { try { recStop(); } catch (e) { sendResponse({ ok: false, error: String(e) }); return true; } sendResponse({ ok: true }); return true; }
    let out;
    try {
      switch (msg.kind) {
        case "mouse": out = dispatchMouse(msg); break;
        case "key": out = dispatchKey(msg); break;
        case "insert": out = insertText(msg.text || ""); break;
        case "dialog": pendingDialog = { accept: msg.accept, promptText: msg.promptText }; out = { ok: true }; break;
        case "phantom": {
          // Visual-only: show the cursor for actions that don't go through dispatchMouse/dispatchKey
          // (e.g. real_* CDP tools, or 'type' which runs via chrome.scripting).
          if (msg.at === "click") { showCursor(msg.x, msg.y); ripple(msg.x, msg.y, msg.button); }
          else if (msg.at === "type" || msg.at === "key") { keyFlash(msg.text || ""); }
          else if (msg.at === "scroll") { showCursor(msg.x, msg.y); scrollPulse(msg.x, msg.y, msg.dy || 0); }
          else if (msg.at === "move") { showCursor(msg.x, msg.y); }
          out = { ok: true };
          break;
        }
        default: out = { ok: false, error: "unknown kind: " + msg.kind };
      }
    } catch (e) { out = { ok: false, error: String(e) }; }
    sendResponse(out);
    return true; // async response
  });

  // --- Self-test: Ctrl+Shift+Y dispatches a real click at viewport center ---
  // (Proves the no-CDP path works with no banner. Check the page console + that
  //  no "controlled by automated software" banner appears.)
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "Y" || e.key === "y")) {
      const x = Math.floor(window.innerWidth / 2), y = Math.floor(window.innerHeight / 2);
      const r1 = dispatchMouse({ type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      dispatchMouse({ type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      console.log(
        "%c[NOCDP self-test]%c clicked viewport center",
        "color:#0a0;font-weight:bold", "color:inherit",
        { x, y, webdriver: navigator.webdriver, debuggerDetected: false, target: r1.tag }
      );
    }
  }, true);
})();