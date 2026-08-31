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
  const rawFieldName = root.getAttribute('name');
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
    // Fallback: try the sys_display. prefixed visible input (ServiceNow
    // reference fields expose a visible display input with this prefix).
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
