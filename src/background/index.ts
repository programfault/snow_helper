// Service worker (MV3). Owns cross-origin fetch and message routing.
//
// Phase 1: Chrome Side Panel API toggle — `openPanelOnActionClick: true`.
// Phase 2: side-panel → content-script message routing. Content script is
//          STATICALLY registered via manifest `content_scripts` so it is
//          present on every matching page after a navigation. As a
//          FALLBACK, if tabs.sendMessage fails with "Receiving end does
//          not exist" (happens right after extension reload before the
//          user refreshes the page, or on CRXJS HMR mid-session restarts
//          where the content script listener was torn down), we inject
//          via chrome.scripting.executeScript using the manifest's
//          ALREADY-RESOLVED .js file paths (not the raw .ts source path
//          that Chrome refuses to load).

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
        const reply = await sendToTabOrInject(tabId, message);
        sendResponse({ ok: true, reply });
      } catch (err) {
        console.error('[sn-helper] send failed for kind', kind, err);
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

/**
 * Send a message to a tab's content script; if there is no listener,
 * forcibly (re-)inject the content script via scripting.executeScript
 * (using the manifest-resolved .js file paths, never raw .ts) and then
 * retry the message. This handles the "Receiving end does not exist"
 * failure mode that appears immediately after an extension reload
 * before the user navigates/refreshes the page.
 */
async function sendToTabOrInject<T = unknown>(
  tabId: number,
  message: unknown,
): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const connectionMissing =
      /Receiving end does not exist/i.test(msg) ||
      /Could not establish connection/i.test(msg) ||
      /no listener/i.test(msg);
    if (!connectionMissing) throw firstErr;

    console.log(
      '[sn-helper] no content script on tab',
      tabId,
      '; forcing (re-)inject via scripting',
    );
    await forceInjectContentScript(tabId);
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  }
}

/**
 * Read the already-resolved JS file paths for the first content_scripts
 * entry from the manifest (CRXJS compiled .ts → .js at this point),
 * then executeScript with those files.
 */
async function forceInjectContentScript(tabId: number): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const scripts = manifest.content_scripts?.[0]?.js as string[] | undefined;
  if (!scripts || scripts.length === 0) {
    throw new Error(
      'manifest has no content_scripts[0].js — cannot force content injection',
    );
  }
  for (const file of scripts) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
    });
    console.log('[sn-helper] force-injected content file', file, 'into tab', tabId);
  }
}

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
