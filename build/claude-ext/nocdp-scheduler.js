// nocdp-scheduler.js — service-worker side of Scheduled Tasks.
// Alarms named "nocdp_task_<id>" are created by the side panel (Tasks view). When one
// fires we can't open the side panel (MV3 needs a user gesture), so we do what the
// original extension's scheduler does: open the task's start URL in an unfocused normal
// window, then open sidepanel.html as a small popup "runner" pointed at that tab
// (?task=<id>&tabId=<n> — getTabId() in the panel already honors ?tabId=). The runner
// executes the prompt through the in-extension agent loop, saves the transcript to
// History, notifies, and closes itself.
const NOCDP_TASK_PREFIX = "nocdp_task_";
const NOCDP_PROC_PREFIX = "nocdp_proc_";

async function nocdpLaunchTask(id) {
  const got = await chrome.storage.local.get("nocdp_tasks");
  const task = ((got.nocdp_tasks && got.nocdp_tasks.list) || []).find(t => t.id === id);
  if (!task || !task.enabled) return;
  // 1) the page the agent will work on — unfocused so it doesn't yank the user around
  const win = await chrome.windows.create({ url: task.url || "about:blank", type: "normal", focused: false, width: 1100, height: 800 });
  let tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
  if (tabId == null && win && win.id != null) {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    tabId = tabs[0] && tabs[0].id;
  }
  // 2) the runner panel, bound to that tab
  await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel.html?task=" + encodeURIComponent(id) + (tabId != null ? "&tabId=" + tabId : "")),
    type: "popup", focused: false, width: 430, height: 720,
  });
}
// Launch a scheduled procedure: open its start URL in an unfocused window, then the runner
// popup (?proc=<id>&tabId=<n>). The runner runs replayMacro (no LLM) or replayAI (AgentCore).
async function nocdpLaunchProc(id) {
  const got = await chrome.storage.local.get("nocdp_procs");
  const proc = ((got.nocdp_procs && got.nocdp_procs.list) || []).find(p => p.id === id);
  if (!proc || !(proc.schedule && proc.schedule.enabled)) return;
  const win = await chrome.windows.create({ url: proc.url || "about:blank", type: "normal", focused: false, width: 1100, height: 800 });
  let tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
  if (tabId == null && win && win.id != null) { const tabs = await chrome.tabs.query({ windowId: win.id }); tabId = tabs[0] && tabs[0].id; }
  await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel.html?proc=" + encodeURIComponent(id) + (tabId != null ? "&tabId=" + tabId : "")),
    type: "popup", focused: false, width: 430, height: 720,
  });
}

// Scheduled-task alarm listener. Guarded: if the 'alarms' permission isn't active in the
// installed copy (e.g. manifest.json wasn't reloaded after adding it), chrome.alarms is
// undefined here — without the guard this throws an uncaught TypeError that breaks the
// whole service worker. With the guard we degrade to "tasks won't auto-fire" + a clear
// console warning instead of a crash.
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith(NOCDP_TASK_PREFIX)) {
      try { await nocdpLaunchTask(alarm.name.slice(NOCDP_TASK_PREFIX.length)); }
      catch (e) { try { chrome.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: "Scheduled task failed to launch", message: String(e && e.message || e) }); } catch (_) {} }
    } else if (alarm.name.startsWith(NOCDP_PROC_PREFIX)) {
      try { await nocdpLaunchProc(alarm.name.slice(NOCDP_PROC_PREFIX.length)); }
      catch (e) { try { chrome.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: "Scheduled procedure failed to launch", message: String(e && e.message || e) }); } catch (_) {} }
    }
  });
} else {
  console.warn("[nocdp] chrome.alarms unavailable — scheduled tasks/procs won't fire automatically. Reload the extension after ensuring 'alarms' is in manifest.json permissions.");
}

// "Run now" from the Tasks / Procedures views (fires the same launch path as an alarm).
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return;
  if (msg.type === "NOCDP_RUN_TASK") {
    nocdpLaunchTask(msg.id).then(() => respond({ ok: true })).catch(e => respond({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "NOCDP_RUN_PROC") {
    nocdpLaunchProc(msg.id).then(() => respond({ ok: true })).catch(e => respond({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});

// Chrome doesn't GUARANTEE alarms survive a browser restart — re-register all enabled
// tasks + procedures on startup/install so the schedule is never silently lost.
async function nocdpRescheduleAll() {
  try {
    const got = await chrome.storage.local.get(["nocdp_tasks", "nocdp_procs"]);
    const tasks = (got.nocdp_tasks && got.nocdp_tasks.list) || [];
    for (const t of tasks) {
      const name = NOCDP_TASK_PREFIX + t.id;
      try { await chrome.alarms.clear(name); } catch (_) {}
      if (!t.enabled) continue;
      if (t.kind === "daily") {
        const [h, m] = String(t.at || "09:00").split(":").map(Number);
        const next = new Date(); next.setHours(h || 0, m || 0, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 1440 });
      } else {
        const every = Math.max(1, +t.every || 30);
        await chrome.alarms.create(name, { periodInMinutes: every, delayInMinutes: every });
      }
    }
    const procs = (got.nocdp_procs && got.nocdp_procs.list) || [];
    for (const p of procs) {
      if (!p.schedule || !p.schedule.enabled) continue;
      const name = NOCDP_PROC_PREFIX + p.id;
      try { await chrome.alarms.clear(name); } catch (_) {}
      if (p.schedule.kind === "daily") {
        const [h, m] = String(p.schedule.at || "09:00").split(":").map(Number);
        const next = new Date(); next.setHours(h || 0, m || 0, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 1440 });
      } else {
        const every = Math.max(1, +p.schedule.every || 30);
        await chrome.alarms.create(name, { periodInMinutes: every, delayInMinutes: every });
      }
    }
  } catch (_) {}
}
chrome.runtime.onStartup.addListener(nocdpRescheduleAll);
chrome.runtime.onInstalled.addListener(nocdpRescheduleAll);
