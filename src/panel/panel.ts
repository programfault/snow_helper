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

import type { ContentToPanelMessage, FieldEntry, FieldGroup, PanelToContentMessage } from '../shared/messages';
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

let pickerBusy = false;
function setPickerBusy(b: boolean): void {
  pickerBusy = b;
  const sectionBtn = document.getElementById('btn-picker') as HTMLButtonElement | null;
  if (!sectionBtn) return;
  sectionBtn.disabled = b;
  sectionBtn.title = b
    ? 'Picker active on the page — click a field or press Esc to cancel'
    : 'Start element picker and click a ServiceNow form field';
  sectionBtn.textContent = b ? 'Picker active…' : '+ Field';
}

function wirePickerButtons(): void {
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
// Groups: rendering and Fill buttons
// ==========================================================================

function renderGroups(shape: StorageShape): void {
  const root = document.getElementById('groups-root');
  const empty = document.getElementById('groups-empty') as HTMLElement | null;
  if (!root) return;
  const groups = Object.values(shape.groups).sort(
    (a, b) => b.updated_at - a.updated_at,
  );
  if (empty) empty.hidden = groups.length !== 0;
  root.replaceChildren(
    ...groups.map((g) => renderGroupCard(g, shape)),
  );
}

function renderGroupCard(group: FieldGroup, shape: StorageShape): HTMLElement {
  const card = document.createElement('article');
  card.className = 'panel-group-card';

  // --- Header: title + count + Fill button + collapse toggle ---
  const head = document.createElement('div');
  head.className = 'panel-group-card-head';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'panel-collapse-toggle';
  toggle.title = 'Collapse/expand';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '▶';

  const title = document.createElement('h3');
  title.className = 'panel-group-card-title';
  title.textContent = group.name;

  // Description: always shown inline after the title, truncated with
  // ellipsis. Full text in title attribute for hover tooltip.
  let descInline: HTMLSpanElement | null = null;
  if (group.description) {
    descInline = document.createElement('span');
    descInline.className = 'panel-group-card-desc-inline';
    descInline.textContent = group.description;
    descInline.title = group.description;
  }

  const pill = document.createElement('span');
  pill.className = 'panel-meta';
  pill.textContent = `${group.items.length}`;

  const fillBtn = document.createElement('button');
  fillBtn.type = 'button';
  fillBtn.className = 'panel-primary-button panel-group-fill-btn';
  fillBtn.textContent = 'Fill';
  fillBtn.disabled = group.items.length === 0;
  fillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void runFillGroup(group, shape);
  });

  head.append(toggle, title);
  if (descInline) head.appendChild(descInline);
  head.append(pill, fillBtn);
  card.appendChild(head);

  // --- Collapsible items body (default collapsed) ---
  const items = document.createElement('ul');
  items.className = 'panel-group-items';
  items.hidden = true;
  if (group.items.length === 0) {
    const li = document.createElement('li');
    li.className = 'panel-meta';
    li.textContent = '(empty — Manage Groups to add fields)';
    items.appendChild(li);
  } else {
    for (const it of group.items) {
      const entry = shape.fields[it.entry_ref];
      const li = document.createElement('li');
      li.className = 'panel-group-item';

      const label = document.createElement('span');
      label.className = 'panel-group-item-name';
      if (!entry) {
        label.textContent = `(removed: ${it.entry_ref.slice(0, 8)})`;
        label.classList.add('panel-error');
      } else {
        label.textContent = displayFieldName(entry);
      }

      const val = document.createElement('span');
      val.className = 'panel-group-item-value';
      if (entry && entry.field_type === 'reference') {
        // Show only display value — sys_id is internal, not user-visible.
        const disp = entry.ref_display_value ?? '(no display)';
        val.textContent = disp;
        val.title = disp;
      } else if (entry) {
        const rawValue = it.override_value ?? entry.value ?? '';
        // For choice/select fields: prefer the readable display_value (if
        // available and no override was set — overrides are user-entered so
        // we show them verbatim).
        const shown = it.override_value
          ? rawValue
          : (entry.display_value || rawValue);
        // Truncate to 40 chars; full content in hover tooltip.
        const maxLen = 40;
        val.textContent = shown.length > maxLen ? shown.slice(0, maxLen) + '…' : (shown || '(blank)');
        // Tooltip: display_value + actual submission value if different.
        const parts = [shown || '(blank)'];
        if (entry.display_value && rawValue !== '' && entry.display_value !== rawValue) {
          parts.push(`\n(value: ${rawValue})`);
        }
        val.title = parts.join('');
      }

      li.append(label, val);
      items.appendChild(li);
    }
  }
  card.appendChild(items);

  // --- Collapse wiring ---
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.textContent = !expanded ? '▼' : '▶';
    items.hidden = expanded;
  });

  return card;
}

async function runFillGroup(group: FieldGroup, shape: StorageShape): Promise<void> {
  if (group.items.length === 0) return;
  try {
    await sendToContent({
      kind: 'PANEL_FILL_GROUP',
      group,
      fields: shape.fields,
    });
  } catch (err) {
    showToast(
      'error',
      `Failed to start fill for "${group.name}"`,
      String(err),
    );
  }
}

// ==========================================================================
// Init
// ==========================================================================

function wireGroupsShortcuts(): void {
  const btn = document.getElementById('btn-groups-settings');
  btn?.addEventListener('click', () => {
    if (chrome.runtime?.openOptionsPage) {
      // openOptionsPage opens the options page; to auto-switch to the
      // Groups tab we pass a query param via chrome.storage.session as
      // a "next tab" hint that the options page reads on init.
      void (async () => {
        try {
          await chrome.storage.session.set({ __options_tab_hint: 'groups' });
        } catch {
          /* session storage may be unavailable; options falls back to Field Library */
        }
        await chrome.runtime.openOptionsPage();
      })();
    }
  });
}

/** Wire the Collapse All button — collapses every group card's item list. */
function wireCollapseAllButton(): void {
  const btn = document.getElementById('btn-collapse-all');
  btn?.addEventListener('click', () => {
    const cards = document.querySelectorAll<HTMLElement>('#groups-root .panel-group-card');
    cards.forEach((card) => {
      const toggle = card.querySelector<HTMLButtonElement>('.panel-collapse-toggle');
      const items = card.querySelector<HTMLElement>('.panel-group-items');
      if (!toggle || !items) return;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = '▶';
      items.hidden = true;
    });
  });
}

function renderAll(shape: StorageShape): void {
  renderGroups(shape);
}

async function init(): Promise<void> {
  wireSettingsButton();
  wirePickerButtons();
  wireGroupsShortcuts();
  wireCollapseAllButton();
  const initial = await readStorage();
  renderAll(initial);
  onStorageChanged(renderAll);
}

void init();
