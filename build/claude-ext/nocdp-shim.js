// nocdp-shim.js — No-CDP stealth layer (service-worker side)
// Monkey-patches chrome.debugger BEFORE the extension bundle loads, so the
// "computer" tool drives the page WITHOUT attaching a debugger:
//   - no "Chrome is being controlled by automated software" banner
//   - no webdriver/debugger signals for bot detectors
// Every CDP command the computer tool uses is routed to a no-CDP extension API
// or to the content-script DOM-event actor (nocdp-actor.js).
// Loaded first via service-worker-loader.js.

(() => {
  const dbg = chrome.debugger;
  if (!dbg) return;

  // Pretend-attached set (we never really attach a debugger).
  const attached = new Set();

  dbg.attach = (target, _version, cb) => {
    if (target && target.tabId != null) attached.add(target.tabId);
    if (cb) { try { cb(); } catch (_) {} }
    return Promise.resolve();
  };

  dbg.detach = (target, cb) => {
    if (target && target.tabId != null) attached.delete(target.tabId);
    if (cb) { try { cb(); } catch (_) {} }
    return Promise.resolve();
  };

  // Route CDP commands to no-CDP implementations.
  dbg.sendCommand = async (target, method, params, cb) => {
    const tabId = target && target.tabId;
    params = params || {};
    let result, err;
    try {
      switch (method) {
        case "Input.dispatchMouseEvent":
          await chrome.tabs.sendMessage(tabId, { __nocdp: true, kind: "mouse", ...params });
          result = {};
          break;

        case "Input.dispatchKeyEvent":
          await chrome.tabs.sendMessage(tabId, { __nocdp: true, kind: "key", ...params });
          result = {};
          break;

        case "Input.insertText":
          await chrome.tabs.sendMessage(tabId, { __nocdp: true, kind: "insert", text: params.text || "" });
          result = {};
          break;

        case "Page.handleJavaScriptDialog":
          await chrome.tabs.sendMessage(tabId, {
            __nocdp: true, kind: "dialog",
            accept: params.accept !== false, promptText: params.promptText,
          });
          result = {};
          break;

        case "Page.captureScreenshot": {
          const tab = await chrome.tabs.get(tabId);
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: params.format || "png" });
          const base64 = dataUrl.startsWith("data:") ? dataUrl.split(",")[1] : dataUrl;
          result = { data: base64 };
          break;
        }

        case "Runtime.evaluate": {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (code) => { try { return eval(code); } catch (e) { return { __error: String(e) }; } },
            args: [params.expression || ""],
          });
          const val = res && res[0] && res[0].result;
          result = { result: { value: val, type: typeof val } };
          break;
        }

        // Event subscriptions that no longer fire via CDP — acknowledge and move on.
        // (Console/network capture is reimplemented via webRequest + in-page hooks in a later step.)
        case "Page.enable":
        case "Runtime.enable":
        case "Page.frameNavigated":
        case "Page.javascriptDialogOpening":
        case "Runtime.consoleAPICalled":
        case "Runtime.exceptionThrown":
          result = {};
          break;

        default:
          result = {};
      }
    } catch (e) {
      err = e;
    }
    if (cb) { try { cb(result, err); } catch (_) {} }
    if (err) throw err;
    return result;
  };
})();