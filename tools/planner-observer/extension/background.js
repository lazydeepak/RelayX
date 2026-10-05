/**
 * RelayX Planner Observer — service worker (the loopback bridge client).
 *
 * ## Why the worker exists
 *
 * A content script on chatgpt.com cannot reach 127.0.0.1: a page origin is not allowed to make
 * arbitrary cross-origin requests, and asking chatgpt.com's page for a fetch would mean running
 * in the page's world. The extension service worker CAN, because host_permissions grant the
 * extension cross-origin privileges. So the content script sends structured observations to this
 * worker, and this worker is the only thing that ever talks to the loopback bridge.
 *
 * ## What this worker must never do
 *
 * It never calls chrome.tabs.update, chrome.windows.*, chrome.tabs.create, chrome.tabs.remove
 * or chrome.tabs.move. Monitoring has no browser-churn path at all: the only tab API used is
 * chrome.tabs.query (a read) and chrome.scripting.executeScript (runs in an existing tab's
 * background, does not activate or scroll it). Those are the ONLY two tab-touching calls in the
 * entire extension, and both are non-mutating.
 *
 * Loopback HTTP was chosen over Chrome Native Messaging on purpose: Native Messaging needs a
 * manifest entry in the host OS and a long-lived host process, which is real infrastructure for
 * a proof that only has to move a few hundred bytes between two processes on one machine.
 */

const BRIDGE_ORIGIN = 'http://127.0.0.1:8791';
const CHATGPT_MATCH = 'https://chatgpt.com/*';

const CONTENT_SCRIPT = 'content.js';

/**
 * Make sure the observer content script is present in every already-open chatgpt.com tab.
 *
 * A content script declared in the manifest only runs on pages loaded AFTER the extension is
 * installed. A Planner tab that was already open would otherwise never get one. Injecting by
 * file runs the script in the tab's existing renderer without activating it, focusing it,
 * scrolling it, or touching its history — the tab is not brought to the front and the user is
 * not interrupted. content.js guards against double injection, so this is safe to call often.
 */
async function ensureInjectedIntoOpenPlannerTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: CHATGPT_MATCH });
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
      } catch (err) {
        // A tab we are not permitted to script (e.g. a chrome:// page) is not an error worth
        // escalating; the observer simply is not present there and will report nothing.
        console.debug('[planner-observer] injection skipped for tab', tab.id, String(err));
      }
    }
    return tabs.length;
  } catch (err) {
    console.debug('[planner-observer] ensureInjected failed:', String(err));
    return 0;
  }
}

async function postObservation(payload) {
  const res = await fetch(`${BRIDGE_ORIGIN}/observation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

async function getNextCommand(conversationId) {
  const url = `${BRIDGE_ORIGIN}/next?conversationId=${encodeURIComponent(conversationId ?? '')}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return { ok: false, reason: `bridge HTTP ${res.status}` };
  return await res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || msg.target !== 'relayx-planner-observer') {
      sendResponse({ ok: false, reason: 'not for this worker' });
      return;
    }

    switch (msg.type) {
      case 'observation': {
        // First contact also proves whether the content script made it into the tabs that were
        // already open before the extension loaded.
        await ensureInjectedIntoOpenPlannerTabs();
        const ok = await postObservation(msg.payload);
        sendResponse({ ok });
        return;
      }

      case 'next-command': {
        const cmd = await getNextCommand(msg.conversationId);
        sendResponse(cmd);
        return;
      }

      case 'ensure-injected': {
        const count = await ensureInjectedIntoOpenPlannerTabs();
        sendResponse({ ok: true, count });
        return;
      }

      default:
        sendResponse({ ok: false, reason: `unknown message type ${String(msg.type)}` });
    }
  })();
  return true; // keep the message channel open for the async reply
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureInjectedIntoOpenPlannerTabs();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureInjectedIntoOpenPlannerTabs();
});