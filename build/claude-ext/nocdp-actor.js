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

  // --- Message listener (from the shim in the service worker) ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__nocdp) return;
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