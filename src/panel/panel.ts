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

import type { ContentToPanelMessage, FieldEntry, PanelToContentMessage } from '../shared/messages';
import { abbrevSysId } from '../shared/messages';
import {
  mutateStorage,
  onStorageChanged,
  readStorage,
  type StorageShape,
} from '../shared/storage';

// ==========================================================================
// Toast
// ==========================================================================
let toastTimer: number | null = null;
function showToast(
  level: 'info' | 'success' | 'error',
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
    case 'CONTENT_FILL_RESULT':
      // Phase 3
      break;
    case 'CONTENT_SERVICE_RESULT':
      // Phase 4
      break;
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
  showToast(
    'success',
    summary,
    entry.field_type === 'reference'
      ? `${entry.ref_display_value || '—'} · sys_id ${abbrevSysId(entry.ref_sys_id || '')}`
      : truncate(entry.value ?? '', 80),
  );
}

async function deleteEntry(entryId: string): Promise<void> {
  await mutateStorage((current) => {
    const next = { ...current.fields };
    delete next[entryId];
    return { storage: { ...current, fields: next }, result: undefined };
  });
}

// ==========================================================================
// Rendering
// ==========================================================================

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function renderFieldLibrary(shape: StorageShape): void {
  const root = document.getElementById('fields-root');
  const empty = document.getElementById('fields-empty');
  if (!root || !empty) return;

  const entries = Object.values(shape.fields);
  if (entries.length === 0) {
    empty.hidden = false;
    root.hidden = true;
    root.replaceChildren();
    return;
  }
  empty.hidden = true;
  root.hidden = false;

  // Group entries by field_name.
  const byName = new Map<string, FieldEntry[]>();
  for (const e of entries) {
    const list: FieldEntry[] = byName.get(e.field_name) ?? [];
    list.push(e);
    byName.set(e.field_name, list);
  }
  // Sort groups by label or field_name.
  const groups = Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b));

  root.replaceChildren(
    ...groups.map(([name, list]: [string, FieldEntry[]]) => {
      const label = list[0]?.label || name;
      const card = document.createElement('div');
      card.className = 'panel-field-group';

      const head = document.createElement('div');
      head.className = 'panel-field-group-head';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'panel-field-group-name';
      nameSpan.textContent = name;
      const labelSpan = document.createElement('span');
      labelSpan.className = 'panel-field-group-label';
      labelSpan.title = label;
      labelSpan.textContent = label !== name ? label : '';
      const meta = document.createElement('div');
      meta.className = 'panel-field-group-meta';
      const badge = document.createElement('span');
      badge.className = 'panel-field-count-badge';
      badge.textContent = list.length > 1 ? `${list.length} entries` : '1 entry';
      meta.appendChild(badge);
      head.append(nameSpan, labelSpan, meta);
      card.appendChild(head);

      // Most-recent first.
      const sorted = [...list].sort((a, b) => b.captured_at - a.captured_at);
      for (const e of sorted) {
        card.appendChild(renderEntry(e));
      }
      return card;
    }),
  );
}

function renderEntry(e: FieldEntry): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'panel-field-entry';

  const row1 = document.createElement('div');
  row1.className = 'panel-field-entry-row';
  const typeTag = document.createElement('span');
  typeTag.className = `panel-field-type-tag panel-field-type-tag--${e.field_type}`;
  typeTag.textContent = e.field_type;
  row1.appendChild(typeTag);

  if (e.field_type === 'reference') {
    const primary = document.createElement('span');
    primary.className = 'panel-field-value-primary';
    primary.textContent = e.ref_display_value || '(no display)';
    row1.appendChild(primary);
    if (e.ref_sys_id) {
      const meta = document.createElement('span');
      meta.className = 'panel-field-value-meta';
      meta.textContent = `sys_id ${abbrevSysId(e.ref_sys_id)}`;
      row1.appendChild(meta);
    }
  } else {
    const primary = document.createElement('span');
    primary.className = 'panel-field-value-primary';
    primary.textContent =
      e.value === '' || e.value === undefined ? '(empty)' : truncate(e.value, 48);
    row1.appendChild(primary);
    if (e.value !== undefined && e.value.length > 48) {
      primary.title = e.value;
    }
  }

  const actions = document.createElement('div');
  actions.className = 'panel-field-entry-actions';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'panel-danger-button';
  del.title = 'Remove this entry from the library';
  del.textContent = 'Delete';
  del.addEventListener('click', () => {
    if (confirm(`Delete this entry for ${e.field_name}?`)) {
      void deleteEntry(e.id);
    }
  });
  actions.appendChild(del);
  row1.appendChild(actions);

  wrapper.appendChild(row1);

  // Secondary info line: table sys_id capture context, capture time.
  if (e.table_sys_id) {
    const row2 = document.createElement('div');
    row2.className = 'panel-field-entry-row';
    const captured = document.createElement('span');
    captured.className = 'panel-field-value-meta';
    captured.textContent = `captured from ${abbrevSysId(e.table_sys_id)} · ${new Date(
      e.captured_at,
    ).toLocaleString()}`;
    row2.appendChild(captured);
    wrapper.appendChild(row2);
  } else {
    const row2 = document.createElement('div');
    row2.className = 'panel-field-entry-row';
    const captured = document.createElement('span');
    captured.className = 'panel-field-value-meta';
    captured.textContent = `captured ${new Date(e.captured_at).toLocaleString()}`;
    row2.appendChild(captured);
    wrapper.appendChild(row2);
  }

  return wrapper;
}

// ==========================================================================
// Picker button wiring
// ==========================================================================

let pickerBusy = false;
function setPickerBusy(b: boolean): void {
  pickerBusy = b;
  const headerBtn = document.getElementById('btn-add-field') as HTMLButtonElement | null;
  const sectionBtn = document.getElementById('btn-picker') as HTMLButtonElement | null;
  [headerBtn, sectionBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = b;
    btn.title = b
      ? 'Picker active on the page — click a field or press Esc to cancel'
      : btn.id === 'btn-add-field'
        ? 'Add a field from the page (element picker)'
        : 'Start element picker and click a ServiceNow form field';
    if (btn.id === 'btn-picker') {
      btn.textContent = b ? 'Picker active…' : 'Add Field';
    }
  });
}

function wirePickerButtons(): void {
  const headerBtn = document.getElementById('btn-add-field');
  const sectionBtn = document.getElementById('btn-picker');
  const start = async () => {
    if (pickerBusy) return;
    setPickerBusy(true);
    try {
      await sendToContent({ kind: 'PANEL_START_PICKER' });
      showToast('info', 'Picker active', 'Click a ServiceNow form field, or press Esc to cancel');
    } catch (err) {
      setPickerBusy(false);
      showToast('error', 'Picker failed', String(err));
    }
  };
  headerBtn?.addEventListener('click', () => void start());
  sectionBtn?.addEventListener('click', () => void start());
}

function wireSettingsButton(): void {
  const btn = document.getElementById('btn-settings');
  btn?.addEventListener('click', () => {
    if (chrome.runtime?.openOptionsPage) {
      void chrome.runtime.openOptionsPage();
    }
  });
}

// ==========================================================================
// Init
// ==========================================================================

async function init(): Promise<void> {
  wireSettingsButton();
  wirePickerButtons();
  const initial = await readStorage();
  renderFieldLibrary(initial);
  onStorageChanged(renderFieldLibrary);
}

void init();
