// Side panel UI. Hosted by the Chrome Side Panel API (Chrome 114+).
//
// Communication with the page content script:
//   panel -> SW -> content: chrome.runtime.sendMessage(PANEL_*)
//     (SW routes to the active tab and ensures the content script is
//     injected before forwarding)
//   content -> panel: chrome.runtime.sendMessage(CONTENT_*)
//     (content runs in isolated world so chrome.runtime is available;
//     the panel filters messages by sender.tab.id to isolate the active
//     tab)

import type {
  AssertStep,
  ContentToPanelMessage,
  DictEntry,
  FieldEntry,
  InputDef,
  PanelToContentMessage,
  PatchStep,
  Playbook,
  PlaybookStep,
  WaitStep,
} from '../shared/messages';
import {
  mutateStorage,
  onStorageChanged,
  readStorage,
  type StorageShape,
} from '../shared/storage';
import {
  interpolateString,
  preparePatchPayload,
  seedBuiltinPlaybooks,
  type InterpolateContext,
} from '../shared/playbook-engine';
import { uuid } from '../shared/storage-helpers';

// ---------------------------------------------------------------------------
// Per-site information snapshot (populated by the content script's
// CONTENT_INFO_UPDATED messages, e.g. access token / WO id / service id
// on globe.com.ph).
// ---------------------------------------------------------------------------
type SiteInfo = {
  access_token?: string;
  work_order_id?: string;
  service_id?: string;
};
let latestSiteInfo: SiteInfo = {};

// Playbook engine cache: populated by CONTENT_FORM_CONTEXT message before
// a run starts so the engine can resolve trigger checks + ${current.*}.
type FormContextSnapshot = {
  on_servicenow: boolean;
  table_name?: string;
  sys_id?: string;
  user_name?: string;
  user_display?: string;
  values?: Record<string, string>;
  displays?: Record<string, string>;
};
let _cachedFormContext: FormContextSnapshot = { on_servicenow: false };
// Stores the latest step result message until the Playbook runner consumes it.
let _pendingStepResult: {
  run_id: string;
  step_index: number;
  ok: boolean;
  stopped?: boolean;
  skipped?: boolean;
  status?: number;
  duration_ms: number;
  body?: unknown;
  error?: string;
} | null = null;
// Accessors so downstream consumers can still swap implementation without
// touching the above storage variable names directly.
export function getFormContext(): FormContextSnapshot { return _cachedFormContext; }
export function setFormContext(c: FormContextSnapshot): void { _cachedFormContext = c; }
export function takePendingStepResult(): typeof _pendingStepResult {
  const r = _pendingStepResult;
  _pendingStepResult = null;
  return r;
}

// ==========================================================================
// Toast
// ==========================================================================
let toastTimer: number | null = null;
function showToast(
  level: 'info' | 'success' | 'error' | 'warning',
  text: string,
  detail?: string,
): void {
  const area = document.getElementById('toast-area');
  if (!area) return;
  area.replaceChildren();
  const toast = document.createElement('div');
  toast.className = `panel-toast panel-toast--${level}`;
  toast.textContent = text;
  if (detail) {
    const d = document.createElement('div');
    d.className = 'panel-toast-detail';
    d.textContent = detail;
    toast.appendChild(d);
  }
  area.appendChild(toast);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    area.replaceChildren();
    toastTimer = null;
  }, 4000);
}
(window as unknown as { __snHelperShowToast: typeof showToast }).__snHelperShowToast = showToast;

// ==========================================================================
// Sending messages to the content script (via SW routing)
// ==========================================================================

async function sendToContent<T = unknown>(msg: PanelToContentMessage): Promise<T> {
  const resp = await chrome.runtime.sendMessage(msg);
  if (!resp || resp.ok === false) {
    const detail = resp?.error || 'unknown routing error';
    throw new Error(detail);
  }
  return resp.reply as T;
}

// ==========================================================================
// Receiving messages from the content script (filtered by active tab)
// ==========================================================================

chrome.runtime.onMessage.addListener(
  (message: ContentToPanelMessage, sender, _sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    // Only react to messages from tab-based content scripts.
    const fromTabId = sender.tab?.id;
    if (fromTabId === undefined) return false;
    // Ignore messages from tabs that aren't the user's active window/active tab.
    void (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active || active.id !== fromTabId) return;
      handleContentMessage(message, fromTabId);
    })();
    return false;
  },
);

async function handleContentMessage(
  msg: ContentToPanelMessage,
  _tabId: number | undefined,
): Promise<void> {
  switch (msg.kind) {
    case 'CONTENT_TOAST':
      showToast(msg.level, msg.text, msg.detail);
      break;
    case 'CONTENT_FIELD_CAPTURED':
      await handleFieldCaptured(msg.entry);
      setPickerBusy(false);
      break;
    case 'CONTENT_PICKER_CANCELLED':
      setPickerBusy(false);
      if (msg.reason) {
        showToast('info', 'Picker cancelled', msg.reason);
      }
      break;
    case 'CONTENT_FILL_RESULT': {
      const successes = msg.success_count;
      const errors = msg.error_count;
      const level = errors === 0 ? 'success' : msg.success_count === 0 ? 'error' : 'error';
      const title =
        errors === 0
          ? `Filled group "${msg.group_name}" (${successes}/${successes})`
          : `Group "${msg.group_name}" had ${errors} error${errors === 1 ? '' : 's'}`;
      const detail = msg.results
        .filter((r) => !r.ok)
        .map((r) => `- ${r.display} (${r.field_name}): ${r.error ?? 'failed'}`)
        .join('\n');
      showToast(level as 'success' | 'error' | 'info', title, detail || undefined);
      break;
    }
    case 'CONTENT_SERVICE_RESULT':
      // Phase 4
      break;
    case 'CONTENT_FORM_CONTEXT':
      setFormContext({
        on_servicenow: msg.on_servicenow,
        table_name: msg.table_name,
        sys_id: msg.sys_id,
        user_name: msg.user_name,
        user_display: msg.user_display,
        values: msg.values,
        displays: msg.displays,
      });
      break;
    case 'CONTENT_PLAYBOOK_STEP_RESULT':
      _pendingStepResult = {
        run_id: msg.run_id,
        step_index: msg.step_index,
        ok: msg.ok,
        stopped: msg.stopped,
        skipped: msg.skipped,
        status: msg.status,
        duration_ms: msg.duration_ms,
        body: msg.body,
        error: msg.error,
      };
      break;
    case 'CONTENT_INFO_UPDATED': {
      // Track the latest snapshot and re-render the Information section.
      latestSiteInfo = {
        access_token: msg.access_token,
        work_order_id: msg.work_order_id,
        service_id: msg.service_id,
      };
      renderInformation();
      break;
    }
    default: {
      // Exhaustiveness check; TS errors if a new kind is not handled.
      const _n: never = msg;
      void _n;
    }
  }
}

// ==========================================================================
// Field capture + storage + rendering
// ==========================================================================

async function handleFieldCaptured(entry: FieldEntry): Promise<void> {
  // De-dupe: if we already have an entry with the same (field_name, type,
  // ref_sys_id / value) as an existing one, reuse it; otherwise add as
  // new. Same field name + same ref_sys_id → same record, no need to
  // duplicate.
  const inserted = await mutateStorage<{ was_duplicate: boolean; entry: FieldEntry }>(
    (current) => {
      const existing = Object.values(current.fields);
      const isDuplicate = (e: FieldEntry) => {
        if (e.field_name !== entry.field_name || e.field_type !== entry.field_type) return false;
        if (e.field_type === 'reference') {
          if (entry.ref_sys_id && e.ref_sys_id === entry.ref_sys_id) return true;
          if (!entry.ref_sys_id && entry.ref_display_value &&
              e.ref_display_value === entry.ref_display_value) return true;
          return false;
        }
        return e.value === entry.value;
      };
      const dup = existing.find(isDuplicate);
      if (dup) {
        // Update captured_at and merge any newly-populated fields.
        const merged: FieldEntry = {
          ...dup,
          captured_at: entry.captured_at,
          label: entry.label || dup.label,
          ref_sys_id: entry.ref_sys_id ?? dup.ref_sys_id,
          ref_display_value: entry.ref_display_value ?? dup.ref_display_value,
          value: entry.value ?? dup.value,
          display_value: entry.display_value ?? dup.display_value,
          table_sys_id: entry.table_sys_id ?? dup.table_sys_id,
        };
        return {
          storage: { ...current, fields: { ...current.fields, [dup.id]: merged } },
          result: { was_duplicate: true, entry: merged },
        };
      }
      return {
        storage: { ...current, fields: { ...current.fields, [entry.id]: entry } },
        result: { was_duplicate: false, entry },
      };
    },
  );
  const summary =
    inserted.was_duplicate
      ? `Updated existing entry for ${entry.field_name}`
      : `Added ${entry.field_name}`;
  // Toast detail: for reference fields use ref_display_value; for other
  // fields prefer readable display_value (choice labels) over raw indices.
  const detailRaw = entry.field_type === 'reference'
    ? entry.ref_display_value || '—'
    : (entry.display_value ?? entry.value ?? '');
  showToast(
    'success',
    summary,
    truncate(detailRaw, 80),
  );
}

// ==========================================================================
// Rendering helpers (shared with options page later)
// ==========================================================================

/**
 * Display name for a field entry, respecting user alias. Priority:
 *   1. `entry.alias` (user-editable custom name, e.g. "Customer")
 *   2. `entry.label` (ServiceNow form label, e.g. "Caller")
 *   3. `entry.field_name` (raw field sys_name, e.g. "caller_id")
 */
export function displayFieldName(entry: {
  alias?: string;
  label?: string;
  field_name: string;
}): string {
  return (entry.alias && entry.alias.trim()) ||
    (entry.label && entry.label.trim()) ||
    entry.field_name;
}

/** Tooltip text showing the full name trio (alias/label/field_name). */
export function fieldNameTitle(entry: {
  alias?: string;
  label?: string;
  field_name: string;
}): string {
  const parts: string[] = [];
  if (entry.alias && entry.alias.trim()) parts.push(`alias: ${entry.alias.trim()}`);
  if (entry.label && entry.label.trim() && entry.label.trim() !== entry.alias?.trim()) {
    parts.push(`label: ${entry.label.trim()}`);
  }
  parts.push(`field: ${entry.field_name}`);
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

// ==========================================================================
// Picker button wiring
// ==========================================================================

let _pickerBusy = false;
function setPickerBusy(b: boolean): void {
  _pickerBusy = b;
  void _pickerBusy; // silence unused-var; kept for future picker concurrency checks
  const sectionBtn = document.getElementById('btn-picker') as HTMLButtonElement | null;
  if (!sectionBtn) return;
  sectionBtn.disabled = b;
  sectionBtn.title = b
    ? 'Picker active on the page — click a field or press Esc to cancel'
    : 'Start element picker and click a ServiceNow form field';
  sectionBtn.textContent = b ? 'Picker active…' : '+ Field';
}

// ==========================================================================
// Information section: per-site fields (tokens, WO ids, SIDs, …) rendered
// from the latest CONTENT_INFO_UPDATED snapshot.
//
// Rendering rules:
//   - Each row has a label, truncated value (mono), and a Copy button.
//   - Fields that are currently unavailable are hidden (not rendered) so
//     unrelated sites show an empty-state note instead of dead rows.
//   - "access token" copies the "Bearer …" string verbatim.
//   - "work order id" and "service id" both copy `wo: xxx\nsid: xxx` per
//     the user's existing bookmarklet workflow.
// ==========================================================================

/**
 * Copy text to the system clipboard. Uses navigator.clipboard.writeText
 * (available only in secure contexts, which Chrome extension panels are).
 * Falls back to a textarea + execCommand trick when the modern API is not
 * reachable (e.g. dev machines running on http), and reports success via
 * the toast system so users see feedback.
 */
async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
    showToast('success', `Copied ${label}`, 'Ready to paste.');
  } catch (err) {
    showToast('error', `Copy failed for ${label}`, String(err));
  }
}

function buildWoSidPayload(info: SiteInfo): string {
  // Matches the user's bookmarklet output exactly:
  //   wo: <wo>\nsid: <sid>
  // Uses "N/A" placeholder for whichever side is currently missing so the
  // output is still a well-formed pair.
  const wo = info.work_order_id?.trim() || 'N/A';
  const sid = info.service_id?.trim() || 'N/A';
  return `wo: ${wo}\nsid: ${sid}`;
}

/**
 * Construct one row element for the Information section.
 *
 * @param label Visible label on the left (e.g. "access token").
 * @param value Current value string — shown truncated, full content in
 *              the hover tooltip + copied verbatim by the button.
 * @param copyText Optional override of what gets copied (used when the
 *                 button payload differs from the visible text, e.g. the
 *                 combined wo:\nsid: string on the WO/SID rows). When
 *                 omitted the raw value is copied.
 * @param copyLabel Short label used in the success/failure toast so the
 *                  user sees which button fired. Also used as the button
 *                  title for accessibility.
 */
function renderInfoRow(
  label: string,
  value: string,
  copyText: string | undefined,
  copyLabel: string,
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'panel-info-row';

  const lbl = document.createElement('span');
  lbl.className = 'panel-info-row-label';
  lbl.textContent = label;

  const val = document.createElement('span');
  val.className = 'panel-info-row-value';
  // Truncate long tokens — user can hover or copy to see the full thing.
  const maxLen = 28;
  val.textContent = value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  val.title = value;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'panel-info-copy-btn';
  btn.textContent = 'Copy';
  btn.title = `Copy ${copyLabel}`;
  btn.addEventListener('click', () => {
    const payload = copyText !== undefined ? copyText : value;
    void copyToClipboard(payload, copyLabel);
  });

  li.append(lbl, val, btn);
  return li;
}

function renderInformation(): void {
  const root = document.getElementById('info-list') as HTMLUListElement | null;
  if (!root) return;
  root.replaceChildren();

  const info = latestSiteInfo;
  const rows: HTMLLIElement[] = [];

  // 1. access token — "Bearer <jwt>". Copy exact Bearer string.
  if (info.access_token && info.access_token.trim()) {
    rows.push(renderInfoRow(
      'access token',
      info.access_token,
      info.access_token,
      'access token (Bearer format)',
    ));
  }

  // 2. work order id. Visible value is just the WO id; copy payload is the
  //    combined "wo:\nsid:" string so it matches the user's workflow.
  if (info.work_order_id && info.work_order_id.trim()) {
    rows.push(renderInfoRow(
      'work order id',
      info.work_order_id,
      buildWoSidPayload(info),
      'work order id + service id (wo: / sid: format)',
    ));
  }

  // 3. service id. Same combined payload on Copy (single id alone is rarely
  //    useful without its WO context).
  if (info.service_id && info.service_id.trim()) {
    rows.push(renderInfoRow(
      'service id',
      info.service_id,
      buildWoSidPayload(info),
      'work order id + service id (wo: / sid: format)',
    ));
  }

  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'panel-info-empty';
    empty.textContent =
      'No site info available yet. Visit globe.com.ph to see access token / WO / SID here.';
    root.appendChild(empty);
    return;
  }
  root.append(...rows);
}


// ==========================================================================
// Playbook runner + UI (core new UX)
// ==========================================================================

type StepUiStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';
interface StepUiState {
  status: StepUiStatus;
  meta?: string;   // "320ms", "HTTP 200 · 450ms", "Timed out · 6000ms"
  error?: string;
}
type PlaybookRunState = {
  run_id: string;
  started_at: number;
  stepStates: StepUiState[];  // length === playbook.steps.length
  finished: boolean;
  summary?: string;
  ok: boolean;
  onDone: Promise<boolean>;
};

/** Keyed by playbook.id — only one concurrent run per playbook. */
const activeRuns = new Map<string, PlaybookRunState>();

// ----- Modal helper (reused for inputs dialog + confirmation prompts) -----
type ModalCloseHandler = () => void;
function openModal(params: {
  title: string;
  body: HTMLElement | DocumentFragment;
  footer?: HTMLElement;
  onClose?: ModalCloseHandler;
  allowBackdropClose?: boolean;
}): { close: ModalCloseHandler; dialog: HTMLElement } {
  const root = document.getElementById('modal-root') as HTMLDivElement | null;
  const titleEl = document.getElementById('modal-title') as HTMLHeadingElement | null;
  const bodyEl = document.getElementById('modal-body') as HTMLDivElement | null;
  const footerEl = document.getElementById('modal-footer') as HTMLDivElement | null;
  const dialog = document.querySelector('.panel-modal-dialog') as HTMLDivElement | null;
  if (!root || !titleEl || !bodyEl || !footerEl || !dialog) {
    return { close: () => {}, dialog: dialog ?? document.body };
  }
  titleEl.textContent = params.title;
  bodyEl.replaceChildren(params.body);
  if (params.footer) {
    footerEl.replaceChildren(params.footer);
    footerEl.style.display = '';
  } else {
    footerEl.replaceChildren();
    footerEl.style.display = 'none';
  }
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');

  const closeables = root.querySelectorAll<HTMLElement>('[data-modal-close]');
  const onCloseClick = () => close();
  const allowBackdrop = params.allowBackdropClose ?? true;
  closeables.forEach((el) => {
    if (!allowBackdrop && el.classList?.contains('panel-modal-backdrop')) return;
    el.addEventListener('click', onCloseClick, { once: true });
  });
  const rootRef = root as HTMLDivElement;
  const titleRef = titleEl as HTMLHeadingElement;
  const bodyRef = bodyEl as HTMLDivElement;
  const footerRef = footerEl as HTMLDivElement;
  function close() {
    rootRef.hidden = true;
    rootRef.setAttribute('aria-hidden', 'true');
    titleRef.textContent = '';
    bodyRef.replaceChildren();
    footerRef.replaceChildren();
    closeables.forEach((el) => el.removeEventListener('click', onCloseClick));
    params.onClose?.();
  }
  return { close, dialog };
}

// ------------------- Inputs modal: returns user-filled values -------------------
interface ResolvedInput {
  value: string;
  /** For select-type inputs, mirrors the selected option label. */
  label?: string;
}
type InputsResult = Record<string, ResolvedInput>;

/**
 * Show the inputs modal (if the playbook actually declares any inputs).
 * Returns the resolved values (with defaults applied). Skips the modal
 * entirely when there are no inputs and resolves with an empty map.
 */
async function showInputsModal(
  playbook: Playbook,
  dict: Record<string, DictEntry>,
  scopeTable?: string,
): Promise<InputsResult | null> {
  const defs = playbook.inputs ?? [];
  // Resolve select options eagerly: expand options_from_dict using global
  // dict + scopeTable, so the dropdown shows group/user/state labels from
  // the dictionary directly.
  const preparedDefs = await Promise.all(defs.map(async (def) => {
    if (def.type !== 'select') return def;
    if (def.options && def.options.length > 0) return def;
    if (!def.options_from_dict) return def;
    const { category, table } = def.options_from_dict;
    const candidates = Object.values(dict).filter((d) => d.category === category);
    const scoped = table
      ? candidates.filter((d) => (d.table ?? '').toLowerCase() === table.toLowerCase() || !d.table)
      : candidates;
    // Filter by playbook trigger table if no explicit table in source.
    const prefixed = !table && scopeTable
      ? scoped.filter((d) => !d.table || d.table.toLowerCase() === scopeTable.toLowerCase())
      : scoped;
    return {
      ...def,
      options: prefixed.map((d) => ({ label: d.label ?? d.value, value: d.value })),
    } as InputDef;
  }));

  if (preparedDefs.length === 0) return {};

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '0';

  // Input field elements: indexed parallel to preparedDefs.
  const fields: Array<{ wrap: HTMLElement; input: HTMLElement; def: InputDef; errEl: HTMLElement | null }> = [];
  preparedDefs.forEach((def) => {
    const wrap = document.createElement('div');
    wrap.className = 'panel-input-row';
    const label = document.createElement('label');
    label.className = 'panel-input-label';
    label.htmlFor = `pb-input-${def.key}`;
    label.textContent = def.label;
    if (def.required) {
      const mark = document.createElement('span');
      mark.className = 'required-mark';
      mark.textContent = '*';
      label.appendChild(mark);
    }
    wrap.appendChild(label);

    let input: HTMLElement;
    if (def.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'panel-input-select';
      sel.id = `pb-input-${def.key}`;
      (def.options ?? []).forEach((op) => {
        const opt = document.createElement('option');
        opt.value = op.value;
        opt.textContent = op.label || op.value;
        sel.appendChild(opt);
      });
      if (def.default !== undefined) {
        sel.value = def.default;
      }
      input = sel;
    } else if (def.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'panel-input-textarea';
      ta.id = `pb-input-${def.key}`;
      ta.rows = def.rows ?? 4;
      if (def.placeholder) ta.placeholder = def.placeholder;
      if (def.default !== undefined) ta.value = def.default;
      input = ta;
    } else {
      const ip = document.createElement('input');
      ip.className = 'panel-input-field';
      ip.id = `pb-input-${def.key}`;
      ip.type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
      if (def.placeholder) ip.placeholder = def.placeholder;
      if (def.default !== undefined) ip.value = def.default;
      input = ip;
    }
    wrap.appendChild(input);
    body.appendChild(wrap);
    fields.push({ wrap, input, def, errEl: null });
  });

  // Submit + Cancel buttons in footer
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'panel-ghost-button';
  cancelBtn.textContent = 'Cancel';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'panel-primary-button';
  submitBtn.textContent = 'Run';
  footer.append(cancelBtn, submitBtn);

  return new Promise<InputsResult | null>((resolve) => {
    const { close } = openModal({
      title: `Parameters: ${playbook.name}`,
      body,
      footer,
      allowBackdropClose: true,
      onClose: () => resolve(null),
    });
    cancelBtn.addEventListener('click', () => { close(); resolve(null); });
    submitBtn.addEventListener('click', () => {
      const result: InputsResult = {};
      let hasError = false;
      fields.forEach(({ input, def, wrap, errEl: prevErr }) => {
        if (prevErr) prevErr.remove();
        const v = readInputValue(input);
        if (def.required && (v === '' || v === undefined)) {
          hasError = true;
          const err = document.createElement('div');
          err.className = 'panel-input-error';
          err.textContent = `${def.label} is required.`;
          wrap.appendChild(err);
        } else {
          result[def.key] = { value: v ?? '' };
          if (def.type === 'select' && input instanceof HTMLSelectElement) {
            const opt = input.options[input.selectedIndex];
            result[def.key]!.label = opt?.text?.trim();
          }
        }
      });
      if (hasError) return;
      close();
      resolve(result);
    });
  });
}

function readInputValue(el: HTMLElement): string | undefined {
  if (el instanceof HTMLSelectElement) return el.value;
  if (el instanceof HTMLInputElement) return el.value;
  if (el instanceof HTMLTextAreaElement) return el.value;
  return undefined;
}

// --------------- Active form context: refreshes before each run -------------
async function refreshFormContext(): Promise<void> {
  try {
    const res = await sendToContent({ kind: 'PANEL_GET_FORM_CONTEXT' });
    if (res && typeof res === 'object' && 'on_servicenow' in res) {
      const asAny = res as any;
      setFormContext({
        on_servicenow: !!asAny.on_servicenow,
        table_name: asAny.table_name,
        sys_id: asAny.sys_id,
        user_name: asAny.user_name,
        user_display: asAny.user_display,
        values: asAny.values,
        displays: asAny.displays,
      });
    }
  } catch {
    // Non-SN pages or the content script not yet injected: fall back to
    // whatever cached value we had (defaults to not-on-SN).
  }
}

// --------------- Interpolation context builder -----------------------------
function buildInterpolateCtx(
  shape: StorageShape,
  playbook: Playbook,
  inputs: InputsResult,
): InterpolateContext {
  const ctx = getFormContext();
  const warnings: string[] = [];
  const ipCtx: InterpolateContext = {
    inputs,
    inputDefs: playbook.inputs,
    playbookInlineDict: playbook.inline_dict,
    globalDict: shape.dict_entries,
    scopeTable: playbook.trigger?.table ?? ctx.table_name,
    currentValues: ctx.values,
    currentDisplays: ctx.displays,
    userName: ctx.user_name,
    userDisplay: ctx.user_display,
    fields: shape.fields,
    groups: shape.groups,
    onWarning: (m) => warnings.push(m),
  };
  // Keep warnings accessible from caller via leaked reference.
  (ipCtx as any).__warnings = warnings;
  return ipCtx;
}

// --------------- Per-playbook card rendering --------------------------------
function renderPlaybookCard(playbook: Playbook, shape: StorageShape): HTMLElement {
  const card = document.createElement('article');
  card.className = 'panel-playbook-card';
  card.dataset.playbookId = playbook.id;

  const head = document.createElement('div');
  head.className = 'panel-playbook-head';
  const left = document.createElement('div');
  left.style.minWidth = '0';
  left.style.flex = '1 1 auto';

  const title = document.createElement('h3');
  title.className = 'panel-playbook-title';
  title.textContent = playbook.name;
  left.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'panel-playbook-meta';
  const parts: string[] = [];
  if (playbook.trigger?.table) parts.push(playbook.trigger.table);
  parts.push(`${playbook.steps.length} step${playbook.steps.length === 1 ? '' : 's'}`);
  if (playbook.builtin) parts.unshift('builtin');
  meta.textContent = parts.join(' · ');
  left.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'panel-playbook-actions';
  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'panel-primary-button';
  runBtn.textContent = 'Run ▶';
  runBtn.addEventListener('click', () => {
    void runPlaybook(playbook, shape).catch((e) => showToast('error', `Failed to start ${playbook.name}`, String(e?.message ?? e)));
  });
  actions.appendChild(runBtn);
  head.append(left, actions);
  card.appendChild(head);

  if (playbook.description) {
    const desc = document.createElement('p');
    desc.className = 'panel-playbook-desc';
    desc.textContent = playbook.description;
    card.appendChild(desc);
  }

  // Step list
  const stepsEl = document.createElement('ol');
  stepsEl.className = 'panel-playbook-steps';
  playbook.steps.forEach((step, idx) => {
    const li = document.createElement('li');
    li.className = 'panel-pb-step pending';
    li.dataset.stepIndex = String(idx);
    const glyph = document.createElement('span');
    glyph.className = 'panel-pb-step-glyph';
    glyph.textContent = String(idx + 1);
    const name = document.createElement('span');
    name.className = 'panel-pb-step-name';
    name.textContent = step.name ?? `${capitalizeStepType(step.type)} step`;
    const metaEl = document.createElement('span');
    metaEl.className = 'panel-pb-step-meta';
    metaEl.textContent = 'pending';
    li.append(glyph, name, metaEl);
    stepsEl.appendChild(li);
  });
  card.appendChild(stepsEl);

  // Summary row
  const summary = document.createElement('div');
  summary.className = 'panel-playbook-summary';
  const leftSum = document.createElement('span');
  leftSum.textContent = playbook.inputs && playbook.inputs.length > 0
    ? `${playbook.inputs.length} parameter${playbook.inputs.length === 1 ? '' : 's'}`
    : 'No parameters';
  const rightSum = document.createElement('span');
  rightSum.textContent = 'Ready';
  rightSum.dataset.role = 'summary-right';
  summary.append(leftSum, rightSum);
  card.appendChild(summary);

  // Apply any already-active run state to the freshly-rendered card (keeps
  // UI consistent across storage re-renders while a run is in flight).
  const run = activeRuns.get(playbook.id);
  if (run) applyRunStateToCard(card, playbook, run);
  return card;
}

function capitalizeStepType(t: PlaybookStep['type']): string {
  return t === 'patch' ? 'Patch' : t === 'wait' ? 'Wait' : 'Assert';
}

function applyRunStateToCard(card: HTMLElement, pb: Playbook, run: PlaybookRunState): void {
  card.classList.toggle('is-running', !run.finished);
  pb.steps.forEach((_step, idx) => {
    const li = card.querySelector<HTMLElement>(`.panel-pb-step[data-step-index="${idx}"]`);
    const state = run.stepStates[idx];
    if (!li || !state) return;
    li.classList.remove('pending', 'running', 'success', 'error', 'skipped');
    li.classList.add(state.status);
    const glyph = li.querySelector<HTMLElement>('.panel-pb-step-glyph');
    if (glyph) {
      if (state.status === 'success') glyph.textContent = '✓';
      else if (state.status === 'error') glyph.textContent = '!';
      else if (state.status === 'skipped') glyph.textContent = '–';
      else glyph.textContent = String(idx + 1);
    }
    const metaEl = li.querySelector<HTMLElement>('.panel-pb-step-meta');
    if (metaEl) metaEl.textContent = state.meta ?? state.status;
    // Clear + re-add error message
    let errEl = li.querySelector<HTMLElement>('.panel-pb-step-error');
    if (state.error) {
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'panel-pb-step-error';
        li.appendChild(errEl);
      }
      errEl.textContent = state.error;
    } else if (errEl) {
      errEl.remove();
    }
  });
  const sumRight = card.querySelector<HTMLElement>('[data-role="summary-right"]');
  if (run.finished && sumRight) {
    const total = run.stepStates.reduce((a, s) => a + parseDurationSuffix(s.meta), 0);
    sumRight.textContent = run.ok
      ? `OK · ${total}ms`
      : `Failed · ${total}ms`;
  } else if (!run.finished && sumRight) {
    const done = run.stepStates.filter((s) => s.status !== 'pending').length;
    sumRight.textContent = `Running · ${done}/${pb.steps.length}`;
  }
}

function parseDurationSuffix(m?: string): number {
  if (!m) return 0;
  const r = /(\d+)ms/.exec(m);
  return r ? parseInt(r[1], 10) : 0;
}

// --------------- Render all playbook cards ----------------------------------
function renderPlaybooks(shape: StorageShape): void {
  const root = document.getElementById('playbooks-root') as HTMLDivElement | null;
  const empty = document.getElementById('playbooks-empty') as HTMLParagraphElement | null;
  if (!root) return;
  const list = Object.values(shape.playbooks).sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (empty) empty.style.display = list.length === 0 ? '' : 'none';
  root.replaceChildren(...list.map((p) => renderPlaybookCard(p, shape)));
}

// --------------- Core: run a single playbook end-to-end --------------------
async function runPlaybook(playbook: Playbook, shape: StorageShape): Promise<void> {
  if (activeRuns.has(playbook.id)) {
    showToast('warning', `${playbook.name} is already running`, 'Wait for it to finish before starting another run.');
    return;
  }

  // 1. Refresh form context (table / sys_id / current values / display names)
  //    from the MAIN world probe so trigger validation + interpolate ${current.*} are fresh.
  await refreshFormContext();
  const ctx = getFormContext();

  // 2. Validate trigger.table/state against current form.
  if (playbook.trigger?.table && ctx.table_name && playbook.trigger.table.toLowerCase() !== ctx.table_name.toLowerCase()) {
    showToast('error', `${playbook.name} skipped`, `Playbook requires table "${playbook.trigger.table}", current form is "${ctx.table_name}".`);
    return;
  }
  if (playbook.trigger?.require_state_in && ctx.values) {
    const cur = ctx.values['state'];
    if (cur !== undefined && !playbook.trigger.require_state_in.includes(cur)) {
      showToast('warning', `${playbook.name}: state mismatch`, `Current state="${cur}". Playbook requires one of: [${playbook.trigger.require_state_in.join(', ')}]. Proceeding anyway.`);
    }
  }

  // 3. Prompt for inputs (may return null on cancel).
  const inputs = await showInputsModal(playbook, shape.dict_entries, playbook.trigger?.table ?? ctx.table_name);
  if (inputs === null) return; // user cancelled

  const runId = `pb_${Date.now().toString(36)}${uuid().slice(0, 6)}`;
  const startedAt = performance.now();

  // 4. Build interpolation context + interpolate each step patch payload.
  const ipCtx = buildInterpolateCtx(shape, playbook, inputs);

  // 5. Set up run UI state.
  const stepStates: StepUiState[] = playbook.steps.map(() => ({ status: 'pending', meta: 'pending' }));
  let runOk = true;
  let stoppedEarly = false;
  // Manual Promise.withResolvers replacement (tsconfig targets < ES2024).
  let resolveDone: (ok: boolean) => void = () => {};
  const onDone = new Promise<boolean>((r) => { resolveDone = r; });
  const run: PlaybookRunState = {
    run_id: runId,
    started_at: Date.now(),
    stepStates,
    finished: false,
    ok: true,
    onDone,
  };
  activeRuns.set(playbook.id, run);

  // Repaint the card to pick up 'is-running' class + running states.
  const maybeRepaint = () => {
    const card = document.querySelector<HTMLElement>(`[data-playbook-id="${playbook.id}"]`);
    if (card) applyRunStateToCard(card, playbook, run);
  };
  maybeRepaint();

  const toastOnEachError = true; // single-step failures use their own toast via policy below

  // 6. Iterate steps.
  let lastWarnings: string[] = [];
  for (let i = 0; i < playbook.steps.length; i++) {
    if (stoppedEarly) { stepStates[i].status = 'skipped'; stepStates[i].meta = 'skipped'; continue; }
    const rawStep = playbook.steps[i];
    stepStates[i] = { status: 'running', meta: 'running' };
    maybeRepaint();

    let stepMsg: { kind: 'PANEL_PLAYBOOK_RUN_STEP'; run_id: string; step_index: number; step: PlaybookStep };
    if (rawStep.type === 'patch') {
      // Interpolate payload (+ merge from_group, strip ?skip_empty empties).
      const warnings: string[] = [];
      const localCtx: InterpolateContext = { ...ipCtx, onWarning: (m) => warnings.push(m) };
      const { payload, warnings: warns } = preparePatchPayload(rawStep as PatchStep, localCtx);
      lastWarnings = warns.concat(warnings);
      // Inject the *already-interpolated* payload into the step object we send
      // (content script patch mock just echo's it back; live uses it verbatim).
      const sentStep: PatchStep = { ...(rawStep as PatchStep), payload };
      stepMsg = { kind: 'PANEL_PLAYBOOK_RUN_STEP', run_id: runId, step_index: i, step: sentStep };
    } else {
      // For wait/assert we need to interpolate equals / not_equals / one_of / match / equals_ref_sys_id strings
      // so dictionary references resolve.
      const base = { ...rawStep } as WaitStep | AssertStep;
      const localCtx: InterpolateContext = { ...ipCtx };
      if (base.type === 'wait') {
        const w = base as WaitStep;
        w.equals = w.equals !== undefined ? interpolateString(w.equals, localCtx).value : undefined;
        w.not_equals = w.not_equals !== undefined ? interpolateString(w.not_equals, localCtx).value : undefined;
        w.one_of = w.one_of?.map((s) => interpolateString(s, localCtx).value);
        w.match = w.match !== undefined ? interpolateString(w.match, localCtx).value : undefined;
      } else {
        const a = base as AssertStep;
        a.equals = a.equals !== undefined ? interpolateString(a.equals, localCtx).value : undefined;
        a.not_equals = a.not_equals !== undefined ? interpolateString(a.not_equals, localCtx).value : undefined;
        a.equals_ref_sys_id = a.equals_ref_sys_id !== undefined ? interpolateString(a.equals_ref_sys_id, localCtx).value : undefined;
        a.match = a.match !== undefined ? interpolateString(a.match, localCtx).value : undefined;
      }
      stepMsg = { kind: 'PANEL_PLAYBOOK_RUN_STEP', run_id: runId, step_index: i, step: base };
    }

    const res = await sendStepMessageAndGetResult(runId, i, stepMsg, 180_000 /* 3 min */);
    const metaParts: string[] = [];
    if (res.status) metaParts.push(`HTTP ${res.status}`);
    metaParts.push(`${res.duration_ms}ms`);
    if (res.ok) {
      stepStates[i] = { status: 'success', meta: metaParts.join(' · ') };
    } else if (res.skipped) {
      stepStates[i] = { status: 'skipped', meta: `skipped · ${metaParts.join(' · ')}`, error: res.error };
    } else {
      stepStates[i] = { status: 'error', meta: `failed · ${metaParts.join(' · ')}`, error: res.error };
      runOk = false;
      if (toastOnEachError) {
        showToast('error', `${playbook.name} · step ${i + 1} failed`, res.error ?? `Step "${rawStep.name ?? capitalizeStepType(rawStep.type)}" failed.`);
      }
      if (res.stopped) { stoppedEarly = true; }
    }
    maybeRepaint();
  }

  run.finished = true;
  run.ok = runOk && !stoppedEarly;
  resolveDone(run.ok);
  maybeRepaint();
  activeRuns.delete(playbook.id);

  const totalMs = Math.round(performance.now() - startedAt);
  const n = playbook.steps.length;
  if (run.ok) {
    showToast('success', `${playbook.name} — done`, `All ${n} step${n === 1 ? '' : 's'} OK in ${totalMs}ms.`);
  } else {
    showToast('error', `${playbook.name} — ${stoppedEarly ? 'stopped' : 'failed'}`, `${run.stepStates.filter(s => s.status === 'error').length} failed / ${n} total (${totalMs}ms).`);
  }
  // If there were interpolation warnings (unknown expressions etc.) surface them
  // on the last run to avoid spamming toasts per step.
  if (lastWarnings.length > 0) {
    showToast('warning', 'Playbook interpolation warnings', lastWarnings.slice(0, 5).join('; '));
  }
}

/**
 * Send PANEL_PLAYBOOK_RUN_STEP, then wait for the matching
 * CONTENT_PLAYBOOK_STEP_RESULT message back (filtered by run_id + step_index).
 * Falls back to polling `takePendingStepResult()` every 50ms to handle the
 * global message listener path, with a safety timeout for tab-inactive hangs.
 */
async function sendStepMessageAndGetResult(
  run_id: string,
  step_index: number,
  msg: any,
  timeoutMs: number,
): Promise<{ ok: boolean; stopped?: boolean; skipped?: boolean; status?: number; duration_ms: number; body?: unknown; error?: string }> {
  const timeoutAt = Date.now() + timeoutMs;
  // Send the step.
  try {
    await sendToContent(msg);
  } catch (e: any) {
    return { ok: false, stopped: true, duration_ms: 0, error: String(e?.message ?? e) };
  }
  // Poll via the pending-slot the global onMessage listener fills.
  while (Date.now() < timeoutAt) {
    const pending = takePendingStepResult();
    if (pending && pending.run_id === run_id && pending.step_index === step_index) {
      return {
        ok: pending.ok,
        stopped: pending.stopped,
        skipped: pending.skipped,
        status: pending.status,
        duration_ms: pending.duration_ms,
        body: pending.body,
        error: pending.error,
      };
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { ok: false, stopped: true, duration_ms: timeoutMs, error: `Timed out waiting for step ${step_index + 1} result.` };
}

// ==========================================================================
// Init (rewritten: groups/services UI removed, only playbooks + information)
// ==========================================================================

function wireSettingsButton(): void {
  // Keep existing behavior: opens Settings page.
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage?.();
  });
  document.getElementById('btn-manage-playbooks')?.addEventListener('click', async () => {
    try { await chrome.storage.session.set({ __options_tab_hint: 'playbooks' }); } catch {/* session storage opt */}
    void chrome.runtime.openOptionsPage?.();
  });
  document.getElementById('btn-refresh-form-context')?.addEventListener('click', () => {
    void (async () => {
      await refreshFormContext();
      const c = getFormContext();
      if (!c.on_servicenow) {
        showToast('warning', 'Form context: not on a ServiceNow form', 'State/table info unavailable.');
      } else {
        showToast('success', 'Form context refreshed', `${c.table_name ?? '(no table)'} · ${c.sys_id ? `sys_id ${truncate(c.sys_id, 8)}` : 'no sys_id'}`);
      }
    })();
  });
}

function wirePickerButtons(): void {
  // Picker kept for future Dictionary/Field shortcuts; button has been
  // removed from the panel title bar in the new layout, so only hook if it
  // comes back (safe no-op for now).
  const picker = document.getElementById('btn-picker');
  picker?.addEventListener('click', () => {
    void (async () => {
      try {
        await sendToContent({ kind: 'PANEL_START_PICKER' });
      } catch (err) {
        showToast('error', 'Cannot start field picker', String(err));
      }
    })();
  });
}

function renderAll(shape: StorageShape): void {
  renderPlaybooks(shape);
  renderInformation();
}

async function init(): Promise<void> {
  wireSettingsButton();
  wirePickerButtons();

  // Seed builtin YAML playbooks (reassign + close) into storage on every
  // startup. This idempotently creates or refreshes the bundled examples.
  try {
    await mutateStorage((current) => ({ storage: seedBuiltinPlaybooks(current), result: undefined as void }));
  } catch (e) {
    showToast('warning', 'Failed to seed builtin playbooks', String(e));
  }

  renderInformation();
  // Kick off a first form-context refresh so trigger.table badges and
  // ${current.*} values are populated before the user clicks Run.
  void refreshFormContext();

  const initial = await readStorage();
  renderAll(initial);
  onStorageChanged(renderAll);
}

void init();
