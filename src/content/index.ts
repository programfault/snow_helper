// Content script. Loaded on-demand by the service worker when the side
// panel sends PANEL_START_PICKER (not on every page load — keeps page perf
// clean).
//
// Phase 2: Chrome-style element picker. Hover → highlight, click → capture
// ServiceNow field metadata, send CONTENT_FIELD_CAPTURED via
// chrome.runtime.sendMessage.
//
// The content script runs in the isolated world, so it shares DOM but not
// JS globals with the page. To reach the page's g_form we use
// `chrome.scripting.executeScript({ world: 'MAIN', ... })` — the panel does
// NOT have a direct MAIN-world execution path, so the content script
// handles both the isolated-world DOM work and proxies MAIN-world reads
// by re-injecting a MAIN-world shim via chrome.scripting when needed.

import type { ContentToPanelMessage, FieldEntry, FieldGroup, FieldGroupItem, FieldType, PanelToContentMessage } from '../shared/messages';
import { uuid } from '../shared/messages';

let pickerActive = false;
let highlighted: Element | null = null;
let pickerMask: HTMLElement | null = null;      // fixed overlay container (no pointer events)
let pickerBadge: HTMLElement | null = null;     // bottom status pill
let pickerRect: HTMLElement | null = null;      // DevTools-style selection highlight rect
let pickerTooltip: HTMLElement | null = null;  // DevTools-style field name / type label
let teardownHandlers: Array<() => void> = [];
let rafPending: number | null = null;

// ---- Globe.com.ph per-site information extractor ----
// SRE workflow: whenever the active page sits on *.globe.com.ph we
// continuously pull:
//   1. accessToken from localStorage (MAIN world) → formatted as "Bearer …"
//   2. work order id → first <h6> within main.body-content / .body-content
//   3. service id → the numeric text following the "Service ID" <h6> header
// Values are broadcast to the side panel via CONTENT_INFO_UPDATED (with
// undefined / empty string marking "not available on this page"). We
// refresh on a short cadence to catch SPA navigations (no page reloads)
// and new tokens issued after re-login.
let globeInfoInterval: number | null = null;
let globeInfoMo: MutationObserver | null = null;
// Remember last-sent snapshot so we only push messages when something
// actually changed. Cuts noise for the panel and avoids wasted renders.
type GlobeSnapshot = {
  access_token?: string;
  work_order_id?: string;
  service_id?: string;
};
let lastGlobeSent: GlobeSnapshot | null = null;

async function ensureGlobeInfoWatcher(): Promise<void> {
  if (!location.hostname.toLowerCase().includes('globe.com.ph')) return;
  if (globeInfoInterval !== null) return; // already running

  // Fire an initial snapshot immediately so the panel doesn't wait for the
  // full interval tick on page load / side panel open.
  void sendGlobeInfoSnapshot();

  // 2 second poll is cheap and guarantees that re-auth + SPA route changes
  // surface new values within a reasonable window without needing to hook
  // framework internals.
  globeInfoInterval = window.setInterval(() => {
    void sendGlobeInfoSnapshot();
  }, 2000);

  // MutationObserver covers large DOM updates (SPA render completes,
  // tab switches, form navigations) with lower latency than the 2s tick.
  try {
    globeInfoMo = new MutationObserver(() => {
      void sendGlobeInfoSnapshot();
    });
    globeInfoMo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch {
    globeInfoMo = null;
  }
  // Also re-check when the tab regains visibility (e.g. user comes back
  // from another tab after 10 minutes) — visibilitychange is free.
  const onVis = () => {
    if (document.visibilityState === 'visible') void sendGlobeInfoSnapshot();
  };
  document.addEventListener('visibilitychange', onVis, true);
  teardownHandlers.push(() => {
    document.removeEventListener('visibilitychange', onVis, true);
  });
}

async function sendGlobeInfoSnapshot(): Promise<void> {
  const [accessToken, workOrderId, serviceId] = await Promise.all([
    readGlobeAccessToken(),
    Promise.resolve(extractGlobeWorkOrderId()),
    Promise.resolve(extractGlobeServiceId()),
  ]);
  // Bearer format requested by user — "Bearer xxx" exactly.
  const access_token = accessToken ? `Bearer ${accessToken}` : undefined;
  const snap: GlobeSnapshot = {
    access_token: access_token || undefined,
    work_order_id: workOrderId || undefined,
    service_id: serviceId || undefined,
  };
  // Only post when something differs from the last push.
  if (!snapshotsEqual(snap, lastGlobeSent)) {
    lastGlobeSent = snap;
    postToPanel({
      kind: 'CONTENT_INFO_UPDATED',
      access_token: snap.access_token,
      work_order_id: snap.work_order_id,
      service_id: snap.service_id,
    } as ContentToPanelMessage);
  }
}

function snapshotsEqual(a: GlobeSnapshot | null, b: GlobeSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.access_token === b.access_token &&
    a.work_order_id === b.work_order_id &&
    a.service_id === b.service_id;
}

/**
 * Read the accessToken key from the PAGE's localStorage (MAIN world).
 * Content scripts run in an "isolated world" that does NOT share storage
 * with the page — only MAIN-world JS can see the real localStorage values.
 * Uses chrome.scripting.executeScript({world:'MAIN'}) via the same tab-id
 * shim used by the g_form probe.
 *
 * Returns the raw token string (e.g. a JWT), or undefined when not found.
 * Caller wraps it with "Bearer " prefix before display / clipboard copy.
 */
async function readGlobeAccessToken(): Promise<string | undefined> {
  if (!chrome.scripting?.executeScript) return undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return undefined;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'MAIN',
      func: () => {
        try {
          const raw = (window as unknown as { localStorage?: Storage }).localStorage
            ?.getItem('accessToken');
          if (typeof raw === 'string' && raw.length > 0) return raw;
          return undefined;
        } catch {
          return undefined;
        }
      },
    });
    return (result as string | undefined)?.trim() || undefined;
  } catch {
    // Scripting failures are non-fatal: the panel simply shows N/A until
    // the next successful read.
    return undefined;
  }
}

/**
 * Extract the Work Order identifier following the user's reference script:
 *   const body = document.querySelector('main.body-content, .body-content');
 *   const firstH6 = body ? body.querySelector('h6') : null;
 *   return firstH6?.textContent?.trim()
 *
 * The user also refers to this field as "work order id". Returns undefined
 * when the container/h6 is missing, which the panel treats as "not on a
 * work order detail page right now".
 */
function extractGlobeWorkOrderId(): string | undefined {
  const bodyEl = document.querySelector<HTMLElement>('main.body-content, .body-content');
  const firstH6 = bodyEl?.querySelector?.('h6') as HTMLElement | null | undefined;
  const txt = firstH6?.textContent?.trim();
  if (!txt) return undefined;
  return txt;
}

/**
 * Extract the Service ID per the user's bookmarklet: find the <h6> whose
 * text content is exactly "Service ID", climb to its parent, scan all
 * descendant text nodes, and pull the first text that either matches a
 * number or is the first non-header piece of text. Then prefer the
 * numeric portion (match(/\d+/)) when one exists.
 *
 * Errors / missing elements are swallowed and return undefined — the user
 * explicitly asked "no errors".
 */
function extractGlobeServiceId(): string | undefined {
  try {
    const h6Els = Array.from(document.querySelectorAll('h6'));
    const target = h6Els.find((el) => el.textContent?.trim() === 'Service ID');
    if (!target) return undefined;
    const parent = target.parentElement;
    if (!parent) return undefined;
    const allTexts = Array.from(parent.querySelectorAll('*'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t && t !== 'Service ID');
    if (allTexts.length === 0) return undefined;
    // Prefer first text that actually contains digits (most likely the
    // Service ID number); otherwise fall back to whatever else is there.
    const digitText = allTexts.find((t) => /\d+/.test(t)) ?? allTexts[0];
    if (!digitText) return undefined;
    const numericMatch = digitText.match(/\d+/);
    return numericMatch ? numericMatch[0] : digitText;
  } catch {
    return undefined;
  }
}

// (Colors for the DevTools-style selection rect are now baked inline into
// the overlay element styles in drawRect / startPicker so they don't need
// a separate named constant.)

function ensureInjected(): void {
  // This file IS the content script; just wire the chrome message listener.
  chrome.runtime.onMessage.addListener(
    (message: PanelToContentMessage, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      switch (message.kind) {
        case 'PANEL_START_PICKER':
          void startPicker();
          sendResponse({ ok: true });
          return false;
        case 'PANEL_CANCEL_PICKER':
          stopPicker('cancelled by panel');
          sendResponse({ ok: true });
          return false;
        case 'PANEL_FILL_GROUP':
          void fillGroup(message.group, message.fields);
          sendResponse({ ok: true });
          return false;
        case 'PANEL_INVOKE_SERVICE':
          // Phase 4
          sendResponse({ ok: true });
          return false;
        case 'PANEL_GET_FORM_CONTEXT':
          // Async MAIN-world probe; return true so Chrome keeps the channel.
          void probeFormContext().then((ctx) => {
            try { sendResponse(ctx); } catch { /* channel closed */ }
          });
          return true;
        case 'PANEL_PLAYBOOK_RUN_STEP':
          // Execute a single playbook step on MAIN world.
          void runPlaybookStep(
            message.run_id,
            message.step_index,
            message.step,
          ).then((res) => {
            try {
              // CONTENT_PLAYBOOK_STEP_RESULT message back to the panel.
              postToPanel({
                kind: 'CONTENT_PLAYBOOK_STEP_RESULT',
                run_id: res.run_id,
                step_index: res.step_index,
                ok: res.ok,
                stopped: res.stopped,
                skipped: res.skipped,
                status: res.status,
                duration_ms: res.duration_ms,
                body: res.body,
                error: res.error,
              });
              sendResponse({ ok: true });
            } catch { /* panel disconnected: ignore */ }
          });
          return true;
        default:
          return false;
      }
    },
  );
  console.log('[sre-helper] content script injected at', location.href);
}

// ==========================================================================
// Playbook step execution (MAIN world)
// ==========================================================================

type StepResult = {
  run_id: string;
  step_index: number;
  ok: boolean;
  stopped?: boolean;
  skipped?: boolean;
  status?: number;
  duration_ms: number;
  body?: unknown;
  error?: string;
};

/**
 * Returns a structured snapshot of the current SN form by probing MAIN world
 * (g_form + g_user). Always responds synchronously with on_servicenow=false
 * when the probe fails (so the panel can show "not on a SN form" context).
 */
async function probeFormContext(): Promise<{
  on_servicenow: boolean;
  table_name?: string;
  sys_id?: string;
  user_name?: string;
  user_display?: string;
  values?: Record<string, string>;
  displays?: Record<string, string>;
}> {
  const t0 = performance.now();
  const fallback = { on_servicenow: false };
  if (!chrome.scripting?.executeScript) return fallback;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return fallback;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'MAIN',
      func: () => {
        const w = window as unknown as {
          g_form?: {
            getTableName?: () => string;
            getUniqueValue?: () => string;
            getFieldNames?: () => string[];
            getValue?: (f: string) => string;
            getDisplayValue?: (f: string) => string;
          };
          g_user?: {
            userName?: string;
            userID?: string;
            getUserName?: () => string;
            getDisplayName?: () => string;
            firstName?: string;
            lastName?: string;
          };
        };
        const onSN = typeof w.g_form?.getUniqueValue === 'function';
        if (!onSN) return { on_servicenow: false };
        const gf = w.g_form!;
        const gu = w.g_user;
        const table = gf.getTableName?.();
        const sysId = gf.getUniqueValue?.();
        const fields = gf.getFieldNames?.() ?? [];
        const values: Record<string, string> = {};
        const displays: Record<string, string> = {};
        for (const f of fields) {
          try {
            const v = gf.getValue?.(f);
            if (typeof v === 'string') values[f] = v;
            const d = gf.getDisplayValue?.(f);
            if (typeof d === 'string') displays[f] = d;
          } catch { /* noop */ }
        }
        const userName = gu?.userName ?? (typeof gu?.getUserName === 'function' ? gu.getUserName() : undefined);
        let userDisplay: string | undefined;
        if (typeof gu?.getDisplayName === 'function') userDisplay = gu.getDisplayName();
        else if (gu?.firstName && gu?.lastName) userDisplay = `${gu.firstName} ${gu.lastName}`;
        return {
          on_servicenow: true,
          table_name: table,
          sys_id: sysId,
          user_name: userName,
          user_display: userDisplay,
          values,
          displays,
        };
      },
    });
    void t0;
    return (result as
      | {
          on_servicenow: boolean;
          table_name?: string;
          sys_id?: string;
          user_name?: string;
          user_display?: string;
          values?: Record<string, string>;
          displays?: Record<string, string>;
        }
      | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

async function runPlaybookStep(
  run_id: string,
  step_index: number,
  step: ContentToPanelMessage extends infer _R ? any : any,
): Promise<StepResult> {
  const t0 = performance.now();
  const nowMs = (delay = 0) => Math.round(performance.now() - t0 + delay);
  if (!step || !step.type) {
    return {
      run_id, step_index, ok: false, stopped: true,
      duration_ms: nowMs(), error: `Unknown step.type: ${String(step?.type)}`,
    };
  }

  // Apply delay_before_ms before the actual step.
  if (typeof step.delay_before_ms === 'number' && step.delay_before_ms > 0) {
    await new Promise((r) => setTimeout(r, step.delay_before_ms));
  }

  let retriesLeft = 0;
  let retryInterval = 0;
  if (step.retry && typeof step.retry.times === 'number') {
    retriesLeft = Math.max(0, step.retry.times | 0);
    retryInterval = Math.max(0, (step.retry.interval_ms ?? 250) | 0);
  }
  const onErrorPolicy: 'stop' | 'skip' | 'retry_and_skip' = step.on_error ?? 'stop';

  let lastErr: string | undefined;
  let lastStatus: number | undefined;
  let lastBody: unknown;
  let attemptOk = false;
  // wait/assert never trigger retry on_error semantics (they're reads, not writes).
  const canRetry = step.type === 'patch';

  do {
    lastErr = undefined;
    try {
      switch (step.type) {
        case 'patch': {
          const patchRes = await executePatchStepInMain(step as any);
          attemptOk = patchRes.ok;
          lastStatus = patchRes.status;
          lastBody = patchRes.body;
          if (!attemptOk) lastErr = patchRes.error ?? `PATCH failed with status ${patchRes.status}`;
          break;
        }
        case 'wait': {
          const waitRes = await executeWaitStepInMain(step as any);
          attemptOk = waitRes.ok;
          lastStatus = 200;
          lastBody = waitRes.body;
          if (!attemptOk) {
            const policy: 'stop' | 'skip' = (step as any).on_timeout ?? 'stop';
            return {
              run_id, step_index,
              ok: false,
              stopped: policy === 'stop',
              skipped: policy === 'skip',
              duration_ms: nowMs(),
              error: waitRes.error ?? 'Wait timed out.',
            };
          }
          break;
        }
        case 'assert': {
          const assertRes = await executeAssertStepInMain(step as any);
          attemptOk = assertRes.ok;
          lastStatus = 200;
          lastBody = assertRes.body;
          if (!attemptOk) {
            const policy: 'stop' | 'skip' = (step as any).on_fail ?? 'stop';
            return {
              run_id, step_index,
              ok: false,
              stopped: policy === 'stop',
              skipped: policy === 'skip',
              duration_ms: nowMs(),
              error: assertRes.error ?? 'Assertion failed.',
            };
          }
          break;
        }
        default:
          return {
            run_id, step_index, ok: false, stopped: true, duration_ms: nowMs(),
            error: `Unsupported step.type: ${String(step.type)}`,
          };
      }
    } catch (e: any) {
      attemptOk = false;
      lastErr = String(e?.message ?? e);
    }

    if (attemptOk) break;
    if (!canRetry || retriesLeft <= 0) break;
    retriesLeft -= 1;
    await new Promise((r) => setTimeout(r, retryInterval));
  } while (!attemptOk && retriesLeft >= 0);

  // delay_after_ms
  if (typeof step.delay_after_ms === 'number' && step.delay_after_ms > 0) {
    await new Promise((r) => setTimeout(r, step.delay_after_ms));
  }

  if (!attemptOk) {
    // Determine stopped vs skipped.
    const skipped = onErrorPolicy === 'skip' || onErrorPolicy === 'retry_and_skip';
    const stopped = !skipped; // stop is the default
    return {
      run_id, step_index,
      ok: false,
      stopped, skipped,
      status: lastStatus,
      duration_ms: nowMs(),
      body: lastBody,
      error: lastErr ?? 'Step failed.',
    };
  }
  return {
    run_id, step_index,
    ok: true,
    status: lastStatus,
    duration_ms: nowMs(),
    body: lastBody,
  };
}

// -- MAIN-world helpers for each step type ---------------------------------

interface PatchOutcome { ok: boolean; status: number; body?: unknown; error?: string; }

async function executePatchStepInMain(step: any): Promise<PatchOutcome> {
  const payload: Record<string, string> | undefined = step.payload;
  // Mock phase: do not issue real HTTP call. Simulate 450ms latency and a
  // deterministic 200 with the echo'd payload back so the panel can
  // visualise the full round-trip. Switch the commented block below on to
  // enable real Table API calls.
  await new Promise((r) => setTimeout(r, 450));
  return {
    ok: true,
    status: 200,
    body: {
      mock: true,
      message: 'PATCH simulation OK. Switch to real fetch in content/index.ts:executePatchStepInMain for live writes.',
      payload_sent: payload ?? {},
    },
  };
  /*
  // ---------- REAL Table API PATCH (enable after mock verification) ----------
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, status: 0, error: 'No active tab.' };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [payload ?? {}],
    func: (body: Record<string, string>) => new Promise<PatchOutcome>((resolve) => {
      try {
        const w = window as any;
        const table = w.g_form?.getTableName?.();
        const sysId = w.g_form?.getUniqueValue?.();
        if (!table || !sysId) {
          resolve({ ok: false, status: 0, error: 'No g_form table/sys_id available on this page.' });
          return;
        }
        fetch(`/api/now/table/${table}/${sysId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-UserToken': String(w.g_ck ?? ''),
          },
          body: JSON.stringify(body),
        })
        .then(async (r) => {
          try {
            const j = await r.json();
            resolve({ ok: r.ok, status: r.status, body: j });
          } catch {
            resolve({ ok: r.ok, status: r.status, error: `HTTP ${r.status}: Non-JSON response` });
          }
        })
        .catch((e) => resolve({ ok: false, status: 0, error: String(e?.message ?? e) }));
      } catch (e: any) {
        resolve({ ok: false, status: 0, error: String(e?.message ?? e) });
      }
    }),
  });
  return (result as PatchOutcome | undefined) ?? { ok: false, status: 0, error: 'No result from MAIN world.' };
  */
}

async function executeWaitStepInMain(step: any): Promise<{ ok: boolean; body?: unknown; error?: string; }> {
  const field: string = step.field;
  const equals = typeof step.equals === 'string' ? step.equals : undefined;
  const notEquals = typeof step.not_equals === 'string' ? step.not_equals : undefined;
  const oneOf: string[] | undefined = Array.isArray(step.one_of) ? step.one_of.map(String) : undefined;
  const match: string | undefined = typeof step.match === 'string' ? step.match : undefined;
  const timeoutMs = Math.max(1, Number(step.timeout_ms ?? 5000) | 0);
  const pollMs = Math.max(250, Number(step.poll_interval_ms ?? 500) | 0);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [field, equals, notEquals, oneOf, match, timeoutMs, pollMs],
      func: (fld, eq, neq, oneOfArr, matchRe, tMs, pMs) => new Promise<{ ok: boolean; body?: unknown; error?: string; }>((resolve) => {
        const w = window as any;
        if (!w.g_form || typeof w.g_form.getValue !== 'function') {
          resolve({ ok: false, error: 'g_form not available.' });
          return;
        }
        const deadline = Date.now() + tMs;
        const check = () => {
          try {
            const v: string = w.g_form.getValue(fld) ?? '';
            let pass = false;
            if (eq !== undefined) pass = v === eq;
            else if (neq !== undefined) pass = v !== neq;
            else if (oneOfArr !== undefined) pass = oneOfArr.includes(v);
            else if (matchRe !== undefined) pass = new RegExp(matchRe).test(v);
            if (pass) { resolve({ ok: true, body: { field: fld, value: v, matched: true } }); return; }
            if (Date.now() >= deadline) { resolve({ ok: false, error: `Wait timeout: field "${fld}" current="${v}".`, body: { current_value: v } }); return; }
            setTimeout(check, pMs);
          } catch (e: any) { resolve({ ok: false, error: String(e?.message ?? e) }); }
        };
        check();
      }),
    });
    return (result as any) ?? { ok: false, error: 'No MAIN result.' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function executeAssertStepInMain(step: any): Promise<{ ok: boolean; body?: unknown; error?: string; }> {
  const field: string = step.field;
  const equals = typeof step.equals === 'string' ? step.equals : undefined;
  const equalsRef = typeof step.equals_ref_sys_id === 'string' ? step.equals_ref_sys_id : undefined;
  const notEquals = typeof step.not_equals === 'string' ? step.not_equals : undefined;
  const match: string | undefined = typeof step.match === 'string' ? step.match : undefined;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [field, equals, equalsRef, notEquals, match],
      func: (fld, eq, refEq, neq, matchRe) => {
        const w = window as any;
        if (!w.g_form || typeof w.g_form.getValue !== 'function') {
          return { ok: false, error: 'g_form not available.' };
        }
        const v: string = w.g_form.getValue(fld) ?? '';
        let expected = eq;
        // equals_ref_sys_id is used when comparing reference fields; the raw
        // value is the sys_id itself, so we compare directly after unifying
        // with refEq if provided.
        if (expected === undefined && refEq !== undefined) expected = refEq;
        let pass = false;
        if (expected !== undefined) pass = v === expected;
        else if (neq !== undefined) pass = v !== neq;
        else if (matchRe !== undefined) pass = new RegExp(matchRe).test(v);
        if (pass) return { ok: true, body: { field: fld, value: v } };
        return {
          ok: false,
          body: { field: fld, current_value: v, expected, neq, matchRe },
          error: `Assert failed on "${fld}": got "${v}"`,
        };
      },
    });
    return (result as any) ?? { ok: false, error: 'No MAIN result.' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ===========================================================================
// Element picker
// ===========================================================================

async function startPicker(): Promise<void> {
  if (pickerActive) return;
  pickerActive = true;

  // Fixed container for overlay assets (rect, tooltip). pointer-events:none
  // so hover/click pass through to the real page.
  pickerMask = document.createElement('div');
  pickerMask.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:2147483646',
      'contain:layout style paint',
    ].join(';'),
  );
  document.documentElement.appendChild(pickerMask);

  // DevTools-style selection rect (the actual "selection box").
  pickerRect = document.createElement('div');
  pickerRect.setAttribute(
    'style',
    [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'box-sizing:border-box',
      'border:2px solid #3b82f6',
      'background:rgba(59,130,246,0.12)',
      'box-shadow:0 0 0 1px rgba(255,255,255,0.6) inset, 0 0 0 4000px rgba(15,23,42,0.12)',
      'border-radius:2px',
      'transition:all 40ms linear',
      'display:none',
    ].join(';'),
  );
  pickerMask.appendChild(pickerRect);

  // DevTools-style tooltip showing field name + type.
  pickerTooltip = document.createElement('div');
  pickerTooltip.setAttribute(
    'style',
    [
      'position:fixed',
      'top:0',
      'left:0',
      'max-width:320px',
      'padding:4px 8px',
      'background:#0b1324',
      'color:#e5edf3',
      'border-radius:4px',
      'font:400 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'box-shadow:0 6px 16px rgba(15,23,42,0.35)',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'display:none',
    ].join(';'),
  );
  pickerMask.appendChild(pickerTooltip);

  // Status pill at the bottom of the viewport.
  pickerBadge = document.createElement('div');
  pickerBadge.textContent = 'SRE Helper picker active — click a field, Esc to cancel';
  pickerBadge.setAttribute(
    'style',
    [
      'position:fixed',
      'bottom:12px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(15,23,42,0.9)',
      'color:#fff',
      'padding:6px 12px',
      'border-radius:999px',
      'font:12px/1.4 -apple-system,system-ui,sans-serif',
      'z-index:2147483647',
      'backdrop-filter:blur(6px)',
      'pointer-events:none',
    ].join(';'),
  );
  document.documentElement.appendChild(pickerBadge);

  // ---- Event handlers (capture phase so the page cannot stop us). ----
  const onMouseOver = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    const root = findFieldRoot(target);
    highlight(root ?? target);
  };
  const onMouseMove = (e: MouseEvent) => {
    // If highlight is anchored to a scrollable container, re-sync rect on
    // every frame; mouseMove triggers that re-sync.
    void e;
    if (highlighted) scheduleRectSync();
  };
  const onScroll = () => {
    if (highlighted) scheduleRectSync();
  };
  const onClick = async (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = await captureFromElement(target);
    stopPicker(entry ? 'captured' : 'not a form field');
    if (entry) {
      postToPanel({ kind: 'CONTENT_FIELD_CAPTURED', entry });
    } else {
      postToPanel({
        kind: 'CONTENT_PICKER_CANCELLED',
        reason: 'clicked element is not a recognized ServiceNow field',
      });
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopPicker('Esc pressed');
      postToPanel({ kind: 'CONTENT_PICKER_CANCELLED', reason: 'Escape pressed' });
    }
  };

  window.addEventListener('mouseover', onMouseOver, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  teardownHandlers.push(
    () => window.removeEventListener('mouseover', onMouseOver, true),
    () => window.removeEventListener('mousemove', onMouseMove, true),
    () => window.removeEventListener('scroll', onScroll, true),
    () => window.removeEventListener('click', onClick, true),
    () => window.removeEventListener('keydown', onKey, true),
  );
}

function stopPicker(reason: string): void {
  if (!pickerActive) return;
  pickerActive = false;
  if (rafPending !== null) cancelAnimationFrame(rafPending);
  rafPending = null;
  clearHighlight();
  teardownHandlers.forEach((h) => h());
  teardownHandlers = [];
  pickerRect?.remove();
  pickerRect = null;
  pickerTooltip?.remove();
  pickerTooltip = null;
  pickerMask?.remove();
  pickerMask = null;
  pickerBadge?.remove();
  pickerBadge = null;
  console.log('[sn-helper] picker stopped:', reason);
}

/**
 * Throttled rect/layout sync. Scrolls and mousemoves fire fast; we only
 * need to update the overlay rect once per frame.
 */
function scheduleRectSync(): void {
  if (rafPending !== null) return;
  rafPending = requestAnimationFrame(() => {
    rafPending = null;
    if (highlighted) drawRect(highlighted);
  });
}

/**
 * Draw the DevTools-style selection rect and label over the given
 * element. We never mutate the element's own inline styles — the rect
 * and tooltip are sibling overlay nodes in pickerMask.
 */
function highlight(el: Element): void {
  if (highlighted === el) {
    scheduleRectSync();
    return;
  }
  highlighted = el;
  drawRect(el);
}

function drawRect(el: Element): void {
  if (!pickerRect || !pickerTooltip) return;
  const r = el.getBoundingClientRect();
  // Guard against invisible / off-viewport elements.
  if (r.width <= 0 && r.height <= 0) {
    pickerRect.style.display = 'none';
    pickerTooltip.style.display = 'none';
    return;
  }
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const top = Math.max(0, r.top);
  const left = Math.max(0, r.left);
  const width = Math.min(vw - left, r.right - left);
  const height = Math.min(vh - top, r.bottom - top);

  pickerRect.style.display = 'block';
  pickerRect.style.top = `${top}px`;
  pickerRect.style.left = `${left}px`;
  pickerRect.style.width = `${width}px`;
  pickerRect.style.height = `${height}px`;

  // Label: field_name + type. We inspect the element's name attribute and
  // our own shallow classification (cheap — not a full capture).
  const rawName = el.getAttribute('name') || el.getAttribute('data-name') ||
    (el.id ? `#${el.id}` : '(unnamed)');
  // Resolve sys_display. prefix to show the real SN field name in tooltip.
  let name = rawName;
  if (rawName.startsWith('sys_display.original.')) {
    name = rawName.slice('sys_display.original.'.length);
  } else if (rawName.startsWith('sys_display.')) {
    name = rawName.slice('sys_display.'.length);
  }
  const tag = el.tagName.toLowerCase();
  const typeAttr = (el as HTMLInputElement).type?.toLowerCase() || '';
  let cls = 'string';
  if (rawName !== name) cls = 'reference';
  else if (tag === 'textarea') cls = 'journal';
  else if (typeAttr === 'checkbox') cls = 'boolean';
  else if (typeAttr === 'number') cls = 'integer';
  else if (typeAttr === 'date' || typeAttr === 'datetime-local' || typeAttr === 'time') cls = 'datetime';
  else if (el.closest('.reference, .input-group-btn .icon-search, .lookup')) cls = 'reference';

  pickerTooltip.textContent = `${name}  ·  ${cls}`;
  pickerTooltip.style.display = 'block';
  // Position tooltip above the rect; flip below if no room above.
  const labelWidth = Math.min(320, pickerTooltip.offsetWidth || 220);
  const labelHeight = 22;
  let tx = left;
  let ty = top - labelHeight - 4;
  if (ty < 0) ty = top + height + 4;
  if (ty + labelHeight > vh) ty = top - labelHeight - 4;
  if (tx + labelWidth > vw) tx = vw - labelWidth - 4;
  if (tx < 0) tx = 0;
  pickerTooltip.style.top = `${ty}px`;
  pickerTooltip.style.left = `${tx}px`;
}

function clearHighlight(): void {
  highlighted = null;
  if (pickerRect) pickerRect.style.display = 'none';
  if (pickerTooltip) pickerTooltip.style.display = 'none';
}

// ===========================================================================
// Field identification + capture
// ===========================================================================

/**
 * Given an arbitrary clicked element, walk up the DOM to find the nearest
 * ancestor that looks like a ServiceNow input/select. Return null if no
 * field-like element is found.
 */
function findFieldRoot(el: Element): Element | null {
  let current: Element | null = el;
  const INPUT_SELECTORS = ['input', 'select', 'textarea'];
  for (let i = 0; i < 8 && current; i++) {
    const tag = current.tagName.toLowerCase();
    if (INPUT_SELECTORS.includes(tag)) return current;
    // reference lookup wrapper in Classic: `.form-group > .input-group > input[name]`
    // Also try data-name fallback for workspace.
    const namedInput = INPUT_SELECTORS.some((sel) => current?.querySelector?.(`${sel}[name]`))
      ? current.querySelector<Element>(INPUT_SELECTORS.join(','))
      : null;
    if (namedInput) return namedInput;
    current = current.parentElement;
  }
  return null;
}

async function captureFromElement(el: Element): Promise<FieldEntry | null> {
  const root = findFieldRoot(el);
  if (!root) return null;
  const tag = root.tagName.toLowerCase();
  // ServiceNow textareas (journal/description) sometimes use id instead of
  // name. Fall back to id / data-name so we can still capture them.
  const rawFieldName = root.getAttribute('name') || root.id || root.getAttribute('data-name');
  if (!rawFieldName) return null;

  // Resolve ServiceNow reference field name conventions:
  //   Visible display input: name = "sys_display.incident.xxx"
  //   Hidden sys_id input:   name = "incident.xxx"
  //                          OR name = "sys_display.original.incident.xxx"
  // We store with the REAL field name (incident.xxx) so g_form.setValue
  // works correctly and DOM fallback can find the hidden sys_id input.
  let fieldName = rawFieldName;
  if (rawFieldName.startsWith('sys_display.original.')) {
    fieldName = rawFieldName.slice('sys_display.original.'.length);
  } else if (rawFieldName.startsWith('sys_display.')) {
    fieldName = rawFieldName.slice('sys_display.'.length);
  }

  // Grab label: either nearest ancestor with a label[for=<id>] matching the
  // root id, or first .control-label / label-form in the wrapping form-group.
  const rootId = root.id || root.getAttribute('aria-labelledby') || '';
  let label = '';
  if (rootId) {
    const labelEl = document.querySelector<HTMLElement>(`label[for="${CSS.escape(rootId)}"]`);
    label = labelEl?.textContent?.trim() ?? '';
  }
  if (!label) {
    const parentGroup = root.closest('.form-group, .snFormWrapper, [data-uib-type]');
    const labelEl = parentGroup?.querySelector<HTMLElement>('.control-label, .label-text, label');
    label = labelEl?.textContent?.trim() ?? fieldName;
  }

  // Try MAIN-world g_form probe on *.service-now.com / *.com/*.do pages.
  const gFormInfo = await tryGformProbe(fieldName);

  // Classify type based on input characteristics + g_form probe.
  const typeAttr = (root as HTMLInputElement).type?.toLowerCase() || '';
  const fromGform = gFormInfo?.field_type;
  let fieldType: FieldType = fromGform || classifyTypeFromDom(tag, typeAttr, root);

  // If the visible input name had sys_display. prefix, this is definitely
  // a reference field even if g_form/DOM didn't classify it as one.
  if (rawFieldName !== fieldName) {
    fieldType = 'reference';
  }

  const base: Omit<FieldEntry, 'id' | 'captured_at'> = {
    field_name: fieldName,
    label,
    field_type: fieldType,
    table_sys_id: gFormInfo?.table_sys_id,
  };

  // Fill value/display/sys_id
  if (fieldType === 'reference') {
    // The visible display input value (what the user sees on the form).
    const visibleValue = (root as HTMLInputElement).value || undefined;
    base.ref_sys_id = gFormInfo?.ref_sys_id || undefined;
    base.ref_display_value = gFormInfo?.ref_display_value || visibleValue || undefined;

    // Look for the hidden sys_id input(s). ServiceNow stores the real
    // sys_id in a hidden field whose name is either:
    //   - the real field name (e.g. "incident.u_application_service")
    //   - "sys_display.original." + real field name
    const hiddenByName = document.querySelector<HTMLInputElement>(
      `input[name="${fieldName}"]`,
    );
    const hiddenByOriginal = document.querySelector<HTMLInputElement>(
      `input[name="sys_display.original.${fieldName}"]`,
    );
    // Also try the old _display sibling.
    const displayInput = document.getElementById(`${rootId || fieldName}_display`) as
      | HTMLInputElement
      | null;

    // Extract sys_id from hidden fields (g_form is authoritative, but DOM
    // is a fallback when g_form isn't available).
    for (const hidden of [hiddenByName, hiddenByOriginal]) {
      if (!hidden || !hidden.value || base.ref_sys_id) continue;
      if (isLikelySysId(hidden.value)) {
        base.ref_sys_id = hidden.value;
      }
    }

    if (displayInput && !base.ref_display_value) {
      base.ref_display_value = displayInput.value;
    }
    // If the root itself is the hidden sys_id field (user clicked the
    // hidden one), its value IS the sys_id.
    if (!base.ref_sys_id && visibleValue && isLikelySysId(visibleValue)) {
      base.ref_sys_id = visibleValue;
    }
  } else {
    base.value = (root as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value ?? '';
    // Capture display_value for choice/dropdown fields so the UI shows a
    // readable label (e.g. "New") instead of the raw numeric value (e.g. "1").
    // We try several ServiceNow DOM patterns in priority order:
    //   1. Native <select> → selected option text
    //   2. Custom choice wrapper that hides a real <select> (find nearest one)
    //   3. Classic .select2 / .sn-choice visible label spans
    //   4. Next-experience choice: aria-selected="true" or .snc-choice-selected
    //   5. Fallback: walk up to form-group and grab any adjacent display span
    if (!base.display_value) {
      const dv = extractChoiceDisplayFromDom(root, base.value ?? '');
      if (dv) base.display_value = dv;
    }
  }
  // If both MAIN world and DOM gave us something, prefer MAIN world
  // values — they are the authoritative g_form representation.
  if (gFormInfo?.ref_sys_id) base.ref_sys_id = gFormInfo.ref_sys_id;
  if (gFormInfo?.ref_display_value) base.ref_display_value = gFormInfo.ref_display_value;
  if (gFormInfo?.value !== undefined && gFormInfo.value !== null && fieldType !== 'reference') {
    base.value = String(gFormInfo.value);
  }
  // display_value: g_form wins over DOM (it's richer).
  if (gFormInfo?.display_value) base.display_value = gFormInfo.display_value;

  // Skip entries where we captured nothing useful.
  if (
    fieldType === 'reference' &&
    !base.ref_sys_id &&
    !base.ref_display_value
  ) {
    return null;
  }
  if (fieldType !== 'reference' && (base.value === undefined || base.value === '')) {
    // Allow empty strings — user may want to pick a field to fill with a
    // blank preset. But we still need a name.
  }

  return {
    id: uuid(),
    captured_at: Date.now(),
    ...base,
  };
}

function classifyTypeFromDom(tag: string, typeAttr: string, root: Element): FieldType {
  if (tag === 'select') return 'string';
  if (tag === 'textarea') {
    // journals in ServiceNow are typically textareas with role=textbox
    // inside a .journal-field; approximate it.
    if (root.closest('.journal-field')) return 'journal';
    return 'journal';
  }
  // For inputs
  if (typeAttr === 'checkbox') return 'boolean';
  if (typeAttr === 'number') return 'integer';
  // ServiceNow reference fields are text inputs backed by reference lookup
  // markers on the wrapper.
  if (root.closest('.reference, .input-group-btn .icon-search, .lookup')) {
    return 'reference';
  }
  // datetime inputs: typeAttr date / datetime-local / time
  if (typeAttr === 'date' || typeAttr === 'datetime-local' || typeAttr === 'time') {
    return 'datetime';
  }
  return 'string';
}

/**
 * Try to extract the visible display text for a choice/dropdown field
 * from the DOM, since ServiceNow renders choice fields in several ways:
 *
 *   1. Native `<select>` (old forms) — grab selected option text
 *   2. Hidden `<select>` inside a wrapper (classic custom widget) — locate
 *      it via form-group ancestor and read selected option
 *   3. Classic .select2 / .sn-choice wrappers with a visible label span
 *      (e.g. `.select2-chosen`, `.select2-selection__rendered`,
 *      `.sn-choice-label`, `.select2-selection--single [title]`)
 *   4. Next Experience / Workspace: selected item marked with
 *      `[aria-selected="true"]` or class `.snc-choice-selected`
 *   5. Last resort: any sibling span/div whose text content matches a
 *      non-empty value and is visibly different from the raw index.
 *
 * Returns the display text string, or undefined when nothing reliable is
 * found. Caller should still prefer g_form.getDisplayValue() (MAIN-world)
 * over this DOM-derived value when both are available.
 */
function extractChoiceDisplayFromDom(
  root: Element,
  rawValue: string,
): string | undefined {
  const candidateTexts: string[] = [];

  // -- 1. Native <select> on the root itself --
  const tag = root.tagName.toLowerCase();
  if (tag === 'select') {
    const sel = root as HTMLSelectElement;
    const opt = sel.selectedOptions?.[0] ?? sel.options[sel.selectedIndex ?? 0];
    const t = opt?.text?.trim();
    if (t && t !== rawValue) candidateTexts.push(t);
  }

  // -- 2. Walk up to form-group and search for a hidden sibling <select> --
  //    ServiceNow wraps all inputs in .form-group in Classic. Workspace
  //    often uses [data-name] containers. We look up to 6 levels.
  let container: Element | null = root;
  for (let i = 0; i < 6 && container; i++) {
    if (
      container.classList?.contains('form-group') ||
      container.classList?.contains('snFormWrapper') ||
      container.hasAttribute?.('data-uib-type') ||
      container.classList?.contains('snc-form-control-wrapper')
    ) {
      break;
    }
    container = container.parentElement;
  }
  if (container) {
    // Hidden sibling select (classic "custom" choice still uses a real
    // <select> under the hood with display:none, and we read its option).
    const hiddenSelect = container.querySelector<HTMLSelectElement>(
      'select[name], select[id]',
    );
    if (hiddenSelect && hiddenSelect !== root) {
      const hsTag = hiddenSelect.tagName.toLowerCase();
      if (hsTag === 'select') {
        const opt =
          hiddenSelect.selectedOptions?.[0] ??
          hiddenSelect.options[hiddenSelect.selectedIndex ?? 0];
        const t = opt?.text?.trim();
        if (t && t !== rawValue && !candidateTexts.includes(t)) {
          candidateTexts.push(t);
        }
      }
    }

    // -- 3. Classic select2 / sn-choice visible labels --
    const select2Chosen = container.querySelector<HTMLElement>(
      '.select2-chosen, .select2-selection__rendered, .sn-choice-label, .sn-multi-label',
    );
    if (select2Chosen) {
      const t = select2Chosen.textContent?.trim();
      if (t && t !== rawValue && !candidateTexts.includes(t)) {
        candidateTexts.push(t);
      }
    }
    // select2-selection often stores the display in its title attribute.
    const selectionWithTitle = container.querySelector<HTMLElement>(
      '[class*="select2-selection"][title], .sn-choice[title]',
    );
    if (selectionWithTitle) {
      const t = selectionWithTitle.getAttribute('title')?.trim();
      if (t && t !== rawValue && !candidateTexts.includes(t)) {
        candidateTexts.push(t);
      }
    }

    // -- 4. Next Experience / Workspace: look for the selected choice item --
    const nxSelected = container.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"], .snc-choice-selected, .now-label',
    );
    if (nxSelected) {
      const t = nxSelected.textContent?.trim();
      if (t && t !== rawValue && !candidateTexts.includes(t)) {
        candidateTexts.push(t);
      }
    }
    // Also: the visible text input next to a choice arrow may hold display.
    const nxDisplay = container.querySelector<HTMLElement>(
      'input[readonly][class*="display"], span[class*="-display-value"], div[class*="-display"]',
    );
    if (nxDisplay) {
      let t: string | undefined;
      if (nxDisplay.tagName.toLowerCase() === 'input') {
        t = (nxDisplay as HTMLInputElement).value?.trim();
      } else {
        t = nxDisplay.textContent?.trim();
      }
      if (t && t !== rawValue && !candidateTexts.includes(t)) {
        candidateTexts.push(t);
      }
    }
  }

  // Pick the first non-empty candidate that is different from rawValue.
  for (const c of candidateTexts) {
    if (!c) continue;
    // Filter out clearly meaningless strings.
    if (c === rawValue) continue;
    if (c === '-- None --' || c === '--None--') continue;
    return c;
  }
  return undefined;
}

function isLikelySysId(s: string): boolean {
  // ServiceNow sys_ids are always 32-char lowercase hex.
  return /^[0-9a-f]{32}$/.test(s);
}

/**
 * Try to read ServiceNow field data from the page's MAIN world where
 * g_form lives. Returns null if g_form is not present.
 *
 * We use chrome.scripting.executeScript({ world: 'MAIN' }) which is
 * available from content scripts since MV3 Chrome 111.
 */
async function tryGformProbe(fieldName: string): Promise<
  | {
      field_type?: FieldType;
      ref_sys_id?: string;
      ref_display_value?: string;
      value?: unknown;
      table_sys_id?: string;
      display_value?: string;
    }
  | null
> {
  if (!chrome.scripting || !chrome.scripting.executeScript) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'MAIN',
      args: [fieldName],
      func: (fn: string) => {
        // Runs in MAIN world. Only the things we can detect via g_form / globals.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = (window as any).g_form as any | undefined;
        if (!g || typeof g !== 'object') return null;
        try {
          // g_form is a custom class with get/getLabel/getSysId/getReference/getDisplayValue
          const hasField = typeof g.get === 'function' && typeof g.isMandatory === 'function';
          if (!hasField) return null;
          const rawValue: unknown = g.get(fn);
          const display: string | undefined = typeof g.getDisplayValue === 'function'
            ? g.getDisplayValue(fn)
            : undefined;
          const tableId: string | undefined = typeof g.getTableName === 'function'
            ? g.getUniqueValue?.() ?? undefined
            : undefined;
          // Classify from g_form.getField(field).type when available.
          let ft: string | undefined;
          if (typeof g.getField === 'function') {
            const field = g.getField(fn);
            if (field) ft = field.type;
          }
          const typeMap: Record<string, FieldType> = {
            reference: 'reference',
            string: 'string',
            integer: 'integer',
            int: 'integer',
            boolean: 'boolean',
            bool: 'boolean',
            datetime: 'datetime',
            date: 'datetime',
            journal: 'journal',
            journal_input: 'journal',
            decimal: 'decimal',
            float: 'decimal',
            currency: 'decimal',
            choice: 'string',
            lookup: 'reference',
          };
          const fieldType = ft ? (typeMap[ft] ?? 'string') : undefined;
          // For reference fields g.get returns the sys_id; display is separate.
          const isRef = fieldType === 'reference' || (rawValue && typeof rawValue === 'string' && /^[0-9a-f]{32}$/.test(rawValue));
          // Non-reference display (choice/dropdown labels). Only include if
          // the display is meaningfully different from the raw value.
          const displayValue =
            !isRef && typeof display === 'string' &&
            String(rawValue ?? '') !== display
              ? display
              : undefined;
          return {
            field_type: fieldType,
            ref_sys_id: isRef && typeof rawValue === 'string' ? rawValue : undefined,
            ref_display_value: isRef ? display : undefined,
            value: typeof rawValue === 'string' ? rawValue : rawValue,
            table_sys_id: tableId,
            display_value: displayValue,
          } as {
            field_type?: FieldType;
            ref_sys_id?: string;
            ref_display_value?: string;
            value?: unknown;
            table_sys_id?: string;
            display_value?: string;
          };
        } catch {
          return null;
        }
      },
    });
    return (result as unknown) ?? null;
  } catch {
    return null;
  }
}

// ==========================================================================
// Phase 3.2: Fill group (MAIN-world g_form.setValue + DOM fallback)
// ==========================================================================

/**
 * Fill every item of a group into the current ServiceNow form.
 * Priority: MAIN-world `g_form.setValue(...)` → DOM fallback.
 *
 * Reference items always use the FieldEntry's ref_sys_id + ref_display_value
 * (3-arg setValue). Non-reference items use override_value first, then the
 * entry's stored value, and both are run through the template engine before
 * writing.
 *
 * Result is broadcast back as a CONTENT_FILL_RESULT message with counts +
 * field-level errors so the panel can toast it.
 */
async function fillGroup(group: FieldGroup, fields: Record<string, FieldEntry>): Promise<void> {
  if (!window.location.hostname.includes('service-now')) {
    postToPanel({
      kind: 'CONTENT_TOAST',
      level: 'error',
      text: 'Fill only works on a ServiceNow page.',
    });
    return;
  }
  if (group.items.length === 0) {
    postToPanel({
      kind: 'CONTENT_TOAST',
      level: 'warning',
      text: `Group "${group.name}" has no items.`,
    });
    return;
  }

  // Resolve template globals (MAIN-world snapshot). Falls back to DOM-derived
  // values when g_form isn't available.
  const globals = await readTemplateGlobals();

  const results: Array<{
    field_name: string;
    display: string;
    ok: boolean;
    error?: string;
  }> = [];

  for (const item of group.items) {
    const entry = fields[item.entry_ref];
    if (!entry) {
      results.push({
        field_name: `?${item.entry_ref.slice(0, 8)}`,
        display: 'Missing entry',
        ok: false,
        error: 'Entry no longer exists in the field library.',
      });
      continue;
    }
    try {
      const filled = await fillOneItem(entry, item, globals);
      results.push({
        field_name: entry.field_name,
        display: displayFieldName(entry),
        ok: filled.ok,
        error: filled.error,
      });
    } catch (err) {
      results.push({
        field_name: entry.field_name,
        display: displayFieldName(entry),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  postToPanel({
    kind: 'CONTENT_FILL_RESULT',
    group_id: group.id,
    group_name: group.name,
    success: failCount === 0,
    success_count: successCount,
    error_count: failCount,
    results,
  });
}

function displayFieldName(entry: {
  alias?: string;
  label?: string;
  field_name: string;
}): string {
  return (entry.alias && entry.alias.trim()) ||
    (entry.label && entry.label.trim()) ||
    entry.field_name;
}

interface TemplateGlobals {
  today: string;       // yyyy-MM-dd, page's local timezone
  now: string;         // ISO-ish timestamp yyyy-MM-dd HH:mm
  current_user: string;// g_user.userName or ''
  sys_id: string;      // g_form.getUniqueValue() or ''
  host: string;
}

async function readTemplateGlobals(): Promise<TemplateGlobals> {
  let current_user = '';
  let sys_id = '';
  if (chrome.scripting?.executeScript) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            return {
              user: w.g_user?.userName ?? '',
              sys: w.g_form?.getUniqueValue?.() ?? '',
            };
          },
        });
        if (result) {
          current_user = String(result.user ?? '');
          sys_id = String(result.sys ?? '');
        }
      }
    } catch {
      /* ignore */
    }
  }
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = `${today} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    today,
    now,
    current_user,
    sys_id,
    host: location.hostname,
  };
}

function applyTemplateVars(input: string, g: TemplateGlobals): string {
  if (input == null) return input;
  let s = input;
  s = s.replaceAll('{{today}}', g.today);
  s = s.replaceAll('{{now}}', g.now);
  s = s.replaceAll('{{current_user}}', g.current_user);
  s = s.replaceAll('{{sys_id}}', g.sys_id);
  s = s.replaceAll('{{host}}', g.host);
  return s;
}

interface FillResult { ok: boolean; error?: string }

async function fillOneItem(
  entry: FieldEntry,
  item: FieldGroupItem,
  globals: TemplateGlobals,
): Promise<FillResult> {
  if (entry.field_type === 'reference') {
    if (!entry.ref_sys_id) {
      return { ok: false, error: 'reference entry is missing a ref_sys_id' };
    }
    // 3-arg setValue(name, sys_id, display) saves both value + visible text.
    const gformOk = await tryGformSetValue({
      field_name: entry.field_name,
      type: entry.field_type,
      value: entry.ref_sys_id,
      display_value: entry.ref_display_value,
    });
    if (gformOk.ok) return gformOk;
    // DOM fallback: hidden sys_id input + visible display field.
    const refResult = setReferenceByDom(entry.field_name, entry.ref_sys_id, entry.ref_display_value);
    if (refResult.ok) return refResult;
    // Last resort: if no hidden sys_id field exists on the current form
    // (e.g. the field isn't actually a reference, or the hidden input
    // isn't rendered in this form view), fall back to writing the display
    // value into the visible input — same as a simple string field.
    const displayValue = entry.ref_display_value ?? entry.ref_sys_id ?? '';
    return setSimpleByDom(entry.field_name, displayValue, entry.field_type);
  }

  const rawValue = item.override_value !== undefined && item.override_value !== null
    ? item.override_value
    : (entry.value ?? '');
  const value = applyTemplateVars(rawValue, globals);
  const gformOk = await tryGformSetValue({
    field_name: entry.field_name,
    type: entry.field_type,
    value,
  });
  if (gformOk.ok) return gformOk;
  return setSimpleByDom(entry.field_name, value, entry.field_type);
}

async function tryGformSetValue(args: {
  field_name: string;
  type: string;
  value: string;
  display_value?: string;
}): Promise<FillResult> {
  if (!chrome.scripting?.executeScript) return { ok: false, error: 'no scripting API' };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: 'no active tab' };
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [args.field_name, args.value, args.display_value, args.type],
      func: (fn: string, val: string, disp: string | undefined, _type: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = (window as any).g_form as any;
        if (!g || typeof g.setValue !== 'function') {
          return { ok: false, error: 'g_form.setValue not available' };
        }
        try {
          if (disp !== undefined && disp !== null && disp !== '') {
            g.setValue(fn, val, disp);
          } else {
            g.setValue(fn, val);
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
    return (result as FillResult | null) ?? { ok: false, error: 'no result' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function setSimpleByDom(
  fieldName: string,
  value: string,
  _type: string,
): FillResult {
  const input =
    document.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`) ??
    (document.querySelector<HTMLTextAreaElement>(`textarea[name="${fieldName}"]`)) ??
    (document.querySelector<HTMLSelectElement>(`select[name="${fieldName}"]`)) ??
    // Fallback: try id selector (ServiceNow textareas often use id not name)
    document.querySelector(`#${CSS.escape(fieldName)}`) as HTMLElement | null ??
    // Fallback: try sys_display. prefixed visible input
    document.querySelector<HTMLInputElement>(`input[name="sys_display.${fieldName}"]`);
  if (!input) return { ok: false, error: `no DOM element with name="${fieldName}"` };
  try {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(input, value);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (input as any).value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function setReferenceByDom(
  fieldName: string,
  sysId: string,
  displayValue: string | undefined,
): FillResult {
  // ServiceNow reference fields have up to 3 related inputs:
  //   1. <input name="<field>" />                        — hidden, holds sys_id
  //   2. <input name="sys_display.<field>" />             — visible display value
  //   3. <input name="sys_display.original.<field>" />    — hidden, also sys_id
  // All three must be set for SN's save to recognize the change; setting
  // only the visible input is NOT enough (SN's model reads from hidden).
  const hidden = document.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
  const display =
    document.querySelector<HTMLInputElement>(`input[name="sys_display.${fieldName}"]`) ??
    document.querySelector<HTMLInputElement>(`input[id="${fieldName}_display"]`);
  const originalHidden = document.querySelector<HTMLInputElement>(
    `input[name="sys_display.original.${fieldName}"]`,
  );
  if (!hidden && !originalHidden) {
    return { ok: false, error: `no sys_id input for name="${fieldName}"` };
  }
  const fire = (el: HTMLElement, v: string) => {
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(el, v);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else (el as any).value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.warn('[sn-helper] dom fallback set failed', el, err);
    }
  };
  if (hidden) fire(hidden, sysId);
  if (originalHidden) fire(originalHidden, sysId);
  if (display && displayValue !== undefined) fire(display, displayValue);
  return { ok: true };
}

// ===========================================================================
// Helpers
// ===========================================================================

function postToPanel(msg: ContentToPanelMessage): void {
  // Content script → side panel. The side panel's onMessage listener
  // filters by sender.tab.id to avoid picking up messages from unrelated
  // tabs.
  void chrome.runtime.sendMessage(msg);
}

ensureInjected();
// Globe.com.ph per-site info runs regardless of picker state. Called here
// rather than inline at the top of the file so all message wiring is
// guaranteed to be in place before we start sending updates to the panel.
void ensureGlobeInfoWatcher();
