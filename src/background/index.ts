// Service worker (MV3). Owns cross-origin fetch and message routing.
//
// Phase 1: Chrome Side Panel API toggle — `openPanelOnActionClick: true`.
// Phase 2: side-panel → content-script message routing. The content
//          script is now STATICALLY registered via manifest
//          `content_scripts`, so it's present on every matching page by
//          the time the user clicks Add Field; we no longer need the
//          on-demand ping+inject logic that was trying to execute
//          `files: ["src/content/index.ts"]` (which Chrome rejects
//          because it wants a compiled .js, not a .ts source path).

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
// The side panel sends PANEL_* via chrome.runtime.sendMessage without a
// target tab id; the SW resolves the active tab and forwards with
// chrome.tabs.sendMessage.
// Content scripts reply via chrome.runtime.sendMessage and both the side
// panel and SW receive them. The side panel filters by sender.tab.id to
// ignore messages from other tabs.
// ---------------------------------------------------------------------------

const PANEL_KINDS = new Set<string>([
  'PANEL_START_PICKER',
  'PANEL_CANCEL_PICKER',
  'PANEL_FILL_GROUP',
  'PANEL_INVOKE_SERVICE',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  const kind = message?.kind as string | undefined;
  if (!kind) return false;

  if (PANEL_KINDS.has(kind)) {
    void (async () => {
      const tabId = message?.tabId ?? (await resolveActiveTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message);
        sendResponse({ ok: true, reply });
      } catch (err) {
        console.error('[sn-helper] tabs.sendMessage failed for kind', kind, err);
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true; // async response
  }

  if (kind === 'SW_INVOKE_SERVICE') {
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
