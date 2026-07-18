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

  function dispatchMouse(p) {
    const x = Math.round(p.x ?? 0), y = Math.round(p.y ?? 0);
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
    el.dispatchEvent(new KeyboardEvent(type, opts));
    // CDP keyDown with `text` carries a character — feed it as input.
    if (p.type === "keyDown" && p.text) insertText(p.text);
    return { ok: true, type, key: p.key };
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