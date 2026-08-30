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

import type { ContentToPanelMessage, FieldEntry, FieldType, PanelToContentMessage } from '../shared/messages';
import { uuid } from '../shared/messages';

let pickerActive = false;
let highlighted: Element | null = null;
let pickerMask: HTMLElement | null = null;
let pickerBadge: HTMLElement | null = null;
let teardownHandlers: Array<() => void> = [];

const PICKER_HIGHLIGHT_BORDER = '2px solid #3b82f6';
const PICKER_HIGHLIGHT_BG = 'rgba(59,130,246,0.12)';

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
          // Phase 3
          sendResponse({ ok: true });
          return false;
        case 'PANEL_INVOKE_SERVICE':
          // Phase 4
          sendResponse({ ok: true });
          return false;
        default:
          return false;
      }
    },
  );
  console.log('[sn-helper] content script injected at', location.href);
}

// ===========================================================================
// Element picker
// ===========================================================================

async function startPicker(): Promise<void> {
  if (pickerActive) return;
  pickerActive = true;
  pickerMask = document.createElement('div');
  pickerMask.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:2147483646',
    ].join(';'),
  );
  document.documentElement.appendChild(pickerMask);

  pickerBadge = document.createElement('div');
  pickerBadge.textContent = 'SN Helper picker active — click a field, Esc to cancel';
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
    ].join(';'),
  );
  document.documentElement.appendChild(pickerBadge);

  const onMouseOver = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    highlight(target);
  };
  const onMouseOut = () => clearHighlight();
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
  window.addEventListener('mouseout', onMouseOut, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  teardownHandlers.push(
    () => window.removeEventListener('mouseover', onMouseOver, true),
    () => window.removeEventListener('mouseout', onMouseOut, true),
    () => window.removeEventListener('click', onClick, true),
    () => window.removeEventListener('keydown', onKey, true),
  );
}

function stopPicker(reason: string): void {
  if (!pickerActive) return;
  pickerActive = false;
  clearHighlight();
  teardownHandlers.forEach((h) => h());
  teardownHandlers = [];
  pickerMask?.remove();
  pickerMask = null;
  pickerBadge?.remove();
  pickerBadge = null;
  console.log('[sn-helper] picker stopped:', reason);
}

function highlight(el: Element): void {
  clearHighlight();
  highlighted = el;
  const prevBorder = getComputedStyle(el).outline;
  (el as HTMLElement).style.outline = PICKER_HIGHLIGHT_BORDER;
  (el as HTMLElement).style.outlineOffset = '-1px';
  (el as HTMLElement).style.backgroundColor = PICKER_HIGHLIGHT_BG;
  (el as HTMLElement).setAttribute('data-sn-helper-picker-prev-border', prevBorder || '');
}

function clearHighlight(): void {
  if (!highlighted) return;
  (highlighted as HTMLElement).style.outline = (
    highlighted as HTMLElement
  ).getAttribute('data-sn-helper-picker-prev-border') || '';
  (highlighted as HTMLElement).style.backgroundColor = '';
  (highlighted as HTMLElement).removeAttribute('data-sn-helper-picker-prev-border');
  highlighted = null;
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
  const fieldName = root.getAttribute('name');
  if (!fieldName) return null;
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

  const base: Omit<FieldEntry, 'id' | 'captured_at'> = {
    field_name: fieldName,
    label,
    field_type: fieldType,
    table_sys_id: gFormInfo?.table_sys_id,
  };

  // Fill value/display/sys_id
  if (fieldType === 'reference') {
    base.ref_sys_id = gFormInfo?.ref_sys_id || undefined;
    base.ref_display_value = gFormInfo?.ref_display_value ||
      (root as HTMLInputElement).value ||
      undefined;
    // reference lookup often stores the real display in a separate
    // text node — the lookup <input id="xxx_display"> sibling
    const displayInput = document.getElementById(`${rootId || fieldName}_display`) as
      | HTMLInputElement
      | null;
    if (displayInput && !base.ref_display_value) {
      base.ref_display_value = displayInput.value;
    }
    // If the name-matching input holds the sys_id as its value, use that
    const sysIdInput = rootId
      ? (document.getElementById(rootId) as HTMLInputElement | null)
      : null;
    if (sysIdInput && sysIdInput.value && !base.ref_sys_id) {
      const v = sysIdInput.value;
      if (isLikelySysId(v)) base.ref_sys_id = v;
    }
  } else {
    base.value = (root as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value ?? '';
  }
  // If both MAIN world and DOM gave us something, prefer MAIN world
  // values — they are the authoritative g_form representation.
  if (gFormInfo?.ref_sys_id) base.ref_sys_id = gFormInfo.ref_sys_id;
  if (gFormInfo?.ref_display_value) base.ref_display_value = gFormInfo.ref_display_value;
  if (gFormInfo?.value !== undefined && gFormInfo.value !== null && fieldType !== 'reference') {
    base.value = String(gFormInfo.value);
  }

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
          return {
            field_type: fieldType,
            ref_sys_id: isRef && typeof rawValue === 'string' ? rawValue : undefined,
            ref_display_value: isRef ? display : undefined,
            value: typeof rawValue === 'string' ? rawValue : rawValue,
            table_sys_id: tableId,
          } as {
            field_type?: FieldType;
            ref_sys_id?: string;
            ref_display_value?: string;
            value?: unknown;
            table_sys_id?: string;
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
