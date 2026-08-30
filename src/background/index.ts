// Service worker (MV3). Owns cross-origin fetch and message routing.
//
// Phase 1: Chrome Side Panel API toggle — `openPanelOnActionClick: true`.
// Phase 2: side-panel → content-script message routing with on-demand
//          content script injection (avoid installing a content script
//          on every page load).

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(
    '[sn-helper] onInstalled',
    details.reason,
    details.previousVersion,
  );
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    console.log('[sn-helper] side panel behavior set: open on action click');
  } catch (err) {
    console.error('[sn-helper] sidePanel.setPanelBehavior failed:', err);
  }
});

self.addEventListener('activate', async () => {
  console.log('[sn-helper] service worker activated');
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('[sn-helper] sidePanel.setPanelBehavior failed on activate:', err);
  }
});

// ---------------------------------------------------------------------------
// Message routing
//
// The side panel sends messages via chrome.runtime.sendMessage (it does NOT
// know the active tab); the SW re-dispatches them to the active tab's
// content script via chrome.tabs.sendMessage, ensuring the content script
// is injected first (on-demand via chrome.scripting.executeScript{files:}).
//
// Content scripts reply back through chrome.runtime.sendMessage — those go
// through `chrome.runtime.onMessage` and reach both the side panel and the
// SW. The side panel filters by `sender.tab.id` to only react to messages
// from its page.
// ---------------------------------------------------------------------------

const CONTENT_SCRIPT_URL = 'src/content/index.ts';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages from ourselves (SW → anyone); only react to messages
  // from extension pages (side panel, options) or content scripts.
  if (sender.id !== chrome.runtime.id) return false;

  const kind = message?.kind as string | undefined;
  if (!kind) return false;

  // ---- messages from content scripts (tab-based) ----
  if (sender.tab) {
    // Phase 4 SW_INVOKE_RESULT goes through side panel's onMessage listener
    // as well. Nothing else the SW needs to consume from content scripts
    // right now.
    return false;
  }

  // ---- messages from extension pages (side panel, options) ----
  // Figure out the target tab:
  if (
    kind === 'PANEL_START_PICKER' ||
    kind === 'PANEL_CANCEL_PICKER' ||
    kind === 'PANEL_FILL_GROUP' ||
    kind === 'PANEL_INVOKE_SERVICE'
  ) {
    void (async () => {
      const tabId = message?.tabId ?? (await resolveActiveTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      // Ensure the content script is loaded on the tab before forwarding.
      await ensureContentScriptInjected(tabId);
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message);
        sendResponse({ ok: true, reply });
      } catch (err) {
        console.error('[sn-helper] tabs.sendMessage failed:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async response
  }

  // Phase 4 SW_INVOKE_SERVICE handled here (sent by content script):
  if (kind === 'SW_INVOKE_SERVICE') {
    // Deferred. Phase 4 fills this in.
    sendResponse({ ok: false, error: 'SW_INVOKE_SERVICE not implemented yet' });
    return false;
  }

  return false;
});

async function resolveActiveTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab?.id;
  } catch {
    return undefined;
  }
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  // If the content script is already loaded, sending it a no-op message
  // succeeds quickly. If not, inject via files: first.
  const pinged = await pingContentScript(tabId).catch(() => false);
  if (pinged) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_URL],
    });
    console.log('[sn-helper] content script injected into tab', tabId);
  } catch (err) {
    console.error('[sn-helper] content script inject failed:', err);
    // Propagate so caller fails fast instead of timing out.
    throw err;
  }
}

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { kind: '__PING__' });
    // The isolated-world content script listener ignores unknown kinds
    // (returns undefined from its handler); but Chrome tabs.sendMessage
    // without a response still "succeeds" for the no-listener case by
    // setting chrome.runtime.lastError, which we already catch. So a
    // resolved promise here means a listener acknowledged it — but we
    // only treat `{ok:true}` as truly alive because other extension
    // frames sharing the same runtime may also respond.
    return result && typeof result === 'object' && 'ok' in result
      ? result.ok === true
      : true; // Treat any response as "someone is listening"
  } catch {
    return false;
  }
}
