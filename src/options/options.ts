// Options page.
// Phase 2.5: Field Library tab with per-row alias editor + delete + raw columns.
// Phase 3.1: Groups tab with create/edit/delete dialog, alias-fuzzy entry searchable picker,
//            per-item override_value textarea for non-reference fields.

import type { FieldEntry, FieldGroup, FieldGroupItem } from '../shared/types';
import { mutateStorage, onStorageChanged, readStorage, type StorageShape, uuid } from '../shared/storage';
import { abbrevSysId } from '../shared/messages';

// ==========================================================================
// Tab wiring
// ==========================================================================

function wireTabs(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.options-tab'),
  );
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.options-panel'));
  const activate = (targetTab: HTMLButtonElement) => {
    for (const t of tabs) t.classList.toggle('is-active', t === targetTab);
    for (const panel of panels) {
      const active = panel.id === `tab-${targetTab.dataset.tab}`;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    }
  };
  for (const tab of tabs) tab.addEventListener('click', () => activate(tab));
  if (tabs[0]) activate(tabs[0]);
}

// ==========================================================================
// Utilities
// ==========================================================================

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`#${id} not found in options document`);
  return el as T;
};

export function displayFieldName(entry: {
  alias?: string;
  label?: string;
  field_name: string;
}): string {
  return (entry.alias && entry.alias.trim()) ||
    (entry.label && entry.label.trim()) ||
    entry.field_name;
}

function fuzzyScore(query: string, entry: FieldEntry): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const hay = [entry.alias, entry.label, entry.field_name, entry.ref_display_value]
    .filter((x): x is string => !!x && x.trim().length > 0)
    .join(' ')
    .toLowerCase();
  if (!hay.includes(q)) return 0;
  // Prefer alias/label matches over field_name matches.
  let score = 0;
  if (entry.alias?.toLowerCase().includes(q)) score += 5;
  if (entry.label?.toLowerCase().includes(q)) score += 3;
  if (entry.field_name.toLowerCase().includes(q)) score += 2;
  if (entry.ref_display_value?.toLowerCase().includes(q)) score += 2;
  return score;
}

// ==========================================================================
// Field Library tab (Phase 2.5)
// ==========================================================================

function renderFieldLibrary(shape: StorageShape): void {
  const root = $<HTMLTableSectionElement>('fields-tbody');
  const empty = $<HTMLElement>('fields-empty');
  const entries = Object.values(shape.fields).sort(
    (a, b) => b.captured_at - a.captured_at,
  );
  empty.hidden = entries.length !== 0;
  root.innerHTML = '';
  for (const entry of entries) root.appendChild(renderFieldRow(entry));
}

function renderFieldRow(entry: FieldEntry): HTMLTableRowElement {
  const tr = document.createElement('tr');

  const aliasTd = document.createElement('td');
  const aliasInput = document.createElement('input');
  aliasInput.type = 'text';
  aliasInput.value = entry.alias ?? '';
  aliasInput.placeholder = `(fallback: ${entry.label || entry.field_name})`;
  aliasInput.className = 'options-input options-input--alias';
  aliasInput.title = `Alias overrides label/field name across the panel UI.\nOriginal label: ${entry.label}\nServiceNow field_name: ${entry.field_name}`;
  const commitAlias = () => {
    const next = aliasInput.value.trim() || undefined;
    if (next === entry.alias) return;
    void mutateStorage((cur) => {
      const existing = cur.fields[entry.id];
      if (!existing) return { storage: cur, result: undefined };
      return {
        storage: {
          ...cur,
          fields: {
            ...cur.fields,
            [entry.id]: { ...existing, alias: next },
          },
        },
        result: undefined,
      };
    });
  };
  aliasInput.addEventListener('blur', commitAlias);
  aliasInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitAlias();
      aliasInput.blur();
    }
  });
  aliasTd.appendChild(aliasInput);

  const typeTd = document.createElement('td');
  const typeTag = document.createElement('span');
  typeTag.className = `options-type-tag options-type-tag--${entry.field_type}`;
  typeTag.textContent = entry.field_type;
  typeTd.appendChild(typeTag);

  const labelTd = document.createElement('td');
  labelTd.className = 'options-mono';
  labelTd.textContent = entry.label || '(none)';
  labelTd.title = entry.label || '';

  const fieldTd = document.createElement('td');
  fieldTd.className = 'options-mono options-strong';
  fieldTd.textContent = entry.field_name;
  fieldTd.title = entry.field_name;

  const valueTd = document.createElement('td');
  valueTd.className = 'options-cell-value';
  if (entry.field_type === 'reference') {
    const disp = document.createElement('div');
    disp.textContent = entry.ref_display_value ?? '(no display)';
    disp.title = entry.ref_display_value ?? '';
    const sys = document.createElement('div');
    sys.className = 'options-meta';
    sys.textContent = entry.ref_sys_id
      ? `sys_id ${abbrevSysId(entry.ref_sys_id)}`
      : '(no sys_id)';
    sys.title = entry.ref_sys_id ?? '';
    valueTd.append(disp, sys);
  } else {
    const v = entry.value ?? '';
    if (v === '') {
      valueTd.textContent = '(empty)';
      valueTd.classList.add('options-dim');
    } else if (v.length > 80) {
      valueTd.textContent = v.slice(0, 80) + '…';
      valueTd.title = v;
    } else {
      valueTd.textContent = v;
    }
  }

  const capturedTd = document.createElement('td');
  capturedTd.className = 'options-meta';
  capturedTd.textContent = new Date(entry.captured_at).toLocaleString();

  const actionTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'options-danger-button';
  delBtn.textContent = 'Delete';
  delBtn.title = 'Permanently remove this entry from the field library';
  delBtn.addEventListener('click', () => {
    const disp = entry.alias?.trim() || entry.label || entry.field_name;
    if (!confirm(`Delete entry "${disp}" (${entry.field_type})? This cannot be undone.`)) return;
    void mutateStorage((cur) => {
      const next = { ...cur.fields };
      delete next[entry.id];
      // Also remove references from any groups that include this entry.
      const groups: StorageShape['groups'] = {};
      for (const [gid, g] of Object.entries(cur.groups)) {
        const filtered = g.items.filter((i) => i.entry_ref !== entry.id);
        groups[gid] = { ...g, items: filtered, updated_at: Date.now() };
      }
      return { storage: { ...cur, fields: next, groups }, result: undefined };
    });
  });
  actionTd.appendChild(delBtn);

  tr.append(aliasTd, typeTd, labelTd, fieldTd, valueTd, capturedTd, actionTd);
  return tr;
}

// ==========================================================================
// Groups tab (Phase 3.1): grid of cards, +New/Edit/Delete actions, dialog
// ==========================================================================

/** Live dialog state; null = dialog closed. */
let dialogState:
  | { mode: 'new'; name: string; description: string; items: FieldGroupItem[] }
  | { mode: 'edit'; id: string; name: string; description: string; items: FieldGroupItem[] }
  | null = null;

function renderGroups(shape: StorageShape): void {
  const grid = $<HTMLDivElement>('groups-grid');
  const empty = $<HTMLElement>('groups-empty');
  const groups = Object.values(shape.groups).sort((a, b) => b.updated_at - a.updated_at);
  empty.hidden = groups.length !== 0;
  grid.innerHTML = '';
  for (const g of groups) grid.appendChild(renderGroupCard(g, shape));
}

function renderGroupCard(group: FieldGroup, shape: StorageShape): HTMLElement {
  const card = document.createElement('article');
  card.className = 'group-card';

  const head = document.createElement('header');
  head.className = 'group-card-head';
  const name = document.createElement('h4');
  name.className = 'group-card-name';
  name.textContent = group.name;
  const meta = document.createElement('span');
  meta.className = 'options-meta';
  meta.textContent = `${group.items.length} item${group.items.length === 1 ? '' : 's'} · updated ${new Date(group.updated_at).toLocaleString()}`;
  const actions = document.createElement('div');
  actions.className = 'group-card-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'options-ghost-button';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => openGroupDialog({ mode: 'edit', id: group.id, name: group.name, description: group.description ?? '', items: group.items.slice() }));
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'options-ghost-button';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Duplicate this group';
  copyBtn.addEventListener('click', async () => {
    const id = uuid();
    const now = Date.now();
    await mutateStorage((cur) => ({
      storage: {
        ...cur,
        groups: {
          ...cur.groups,
          [id]: {
            id,
            name: `${group.name} (copy)`,
            description: group.description,
            items: group.items.slice(),
            created_at: now,
            updated_at: now,
          },
        },
      },
      result: undefined,
    }));
  });
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'options-danger-button';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete group "${group.name}"? This cannot be undone.`)) return;
    await mutateStorage((cur) => {
      const next = { ...cur.groups };
      delete next[group.id];
      return { storage: { ...cur, groups: next }, result: undefined };
    });
  });
  actions.append(editBtn, copyBtn, delBtn);
  head.append(name, meta, actions);
  card.appendChild(head);

  // Show description below the header if present.
  if (group.description) {
    const desc = document.createElement('p');
    desc.className = 'group-card-description';
    desc.textContent = group.description;
    card.appendChild(desc);
  }

  const itemsList = document.createElement('ol');
  itemsList.className = 'group-card-items';
  if (group.items.length === 0) {
    const li = document.createElement('li');
    li.className = 'options-dim';
    li.textContent = 'No items yet — click Edit to add fields.';
    itemsList.appendChild(li);
  } else {
    for (const it of group.items) {
      const entry = shape.fields[it.entry_ref];
      const li = document.createElement('li');
      li.className = 'group-card-item';
      const left = document.createElement('div');
      const primary = document.createElement('div');
      primary.className = 'group-card-item-name';
      primary.textContent = entry
        ? displayFieldName(entry)
        : `(entry removed: ${it.entry_ref.slice(0, 8)})`;
      if (!entry) primary.classList.add('options-dim');
      const sub = document.createElement('div');
      sub.className = 'options-meta';
      if (entry) {
        const tag = document.createElement('span');
        tag.className = `options-type-tag options-type-tag--${entry.field_type}`;
        tag.textContent = entry.field_type;
        sub.appendChild(tag);
        sub.append(`  ${entry.field_name}`);
      }
      left.append(primary, sub);
      const right = document.createElement('div');
      right.className = 'group-card-item-value';
      if (entry && entry.field_type !== 'reference' && it.override_value !== undefined) {
        right.textContent = it.override_value || '(blank override)';
        right.classList.add('options-cell-value');
        if (it.override_value.length > 60) right.title = it.override_value;
      } else if (entry && entry.field_type === 'reference') {
        right.innerHTML = `<em>${entry.ref_display_value ?? '(no display)'}</em>`;
        right.classList.add('options-meta');
      } else if (entry) {
        right.textContent = entry.value ?? '';
        right.classList.add('options-cell-value', 'options-dim');
      }
      li.append(left, right);
      itemsList.appendChild(li);
    }
  }
  card.appendChild(itemsList);

  return card;
}

// ==========================================================================
// Group dialog
// ==========================================================================

function openGroupDialog(state: NonNullable<typeof dialogState>): void {
  dialogState = state;
  const dlg = $<HTMLDialogElement>('group-dialog');
  const title = $<HTMLHeadingElement>('group-dialog-title');
  const nameInput = $<HTMLInputElement>('group-name');
  const descInput = $<HTMLTextAreaElement>('group-description');
  const itemsList = $<HTMLOListElement>('group-items');
  title.textContent = state.mode === 'new' ? 'New Group' : `Edit Group: ${state.name}`;
  nameInput.value = state.name;
  nameInput.required = true;
  descInput.value = state.description;
  renderGroupItemsList(itemsList, state.items);
  // Reset search box and populate the "Available" pane.
  const search = $<HTMLInputElement>('entry-search');
  search.value = '';
  // Trigger the input handler so the available list renders immediately
  // (even with an empty query — the handler shows all entries when empty).
  search.dispatchEvent(new Event('input', { bubbles: true }));
  if (!dlg.open) dlg.showModal();
}

function closeGroupDialog(): void {
  dialogState = null;
  const dlg = $<HTMLDialogElement>('group-dialog');
  if (dlg.open) dlg.close();
}

function renderGroupItemsList(root: HTMLOListElement, items: FieldGroupItem[]): void {
  root.innerHTML = '';
  // Update the "In this group" count badge.
  const countEl = document.getElementById('selected-count');
  if (countEl) countEl.textContent = `${items.length}`;
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'group-items-empty';
    li.textContent = 'No items yet — pick entries from the left pane.';
    root.appendChild(li);
    return;
  }
  void readStorage().then((shape) => {
    for (const it of items) root.appendChild(renderGroupItemRow(it, shape, items));
  });
}

function renderGroupItemRow(
  it: FieldGroupItem,
  shape: StorageShape,
  items: FieldGroupItem[],
): HTMLLIElement {
  const entry = shape.fields[it.entry_ref];
  const li = document.createElement('li');
  li.className = 'group-form-item';
  if (!entry) {
    li.classList.add('group-form-item--orphan');
    const left = document.createElement('div');
    left.className = 'group-form-item-main';
    left.innerHTML = `<strong>Missing entry</strong> <span class="options-meta">(${it.entry_ref.slice(0, 8)}…)</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'options-danger-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const idx = items.indexOf(it);
      if (idx >= 0) items.splice(idx, 1);
      renderGroupItemsList(
        document.getElementById('group-items') as HTMLOListElement,
        items,
      );
    });
    li.append(left, remove);
    return li;
  }

  const main = document.createElement('div');
  main.className = 'group-form-item-main';
  const top = document.createElement('div');
  top.className = 'group-form-item-top';
  const disp = document.createElement('span');
  disp.className = 'group-form-item-name';
  disp.textContent = displayFieldName(entry);
  const tag = document.createElement('span');
  tag.className = `options-type-tag options-type-tag--${entry.field_type}`;
  tag.textContent = entry.field_type;
  const fieldMeta = document.createElement('span');
  fieldMeta.className = 'options-mono options-meta';
  fieldMeta.textContent = entry.field_name;
  top.append(disp, tag, fieldMeta);

  const bottom = document.createElement('div');
  bottom.className = 'group-form-item-bottom';
  if (entry.field_type === 'reference') {
    const preset = document.createElement('em');
    preset.className = 'options-meta';
    preset.textContent =
      `Preset: ${entry.ref_display_value ?? '(no display)'} · ${entry.ref_sys_id ? abbrevSysId(entry.ref_sys_id) : 'n/a'}`;
    bottom.appendChild(preset);
  } else {
    const ta = document.createElement('textarea');
    ta.className = 'options-input options-textarea options-textarea-compact';
    ta.rows = entry.field_type === 'journal' ? 2 : 1;
    ta.placeholder = `Preset: ${truncateForTitle(entry.value ?? '(empty)')}`;
    ta.title = 'Override value. Templates: {{today}} {{now}} {{sys_id}} {{current_user}}';
    ta.value = it.override_value ?? '';
    ta.addEventListener('input', () => {
      it.override_value = ta.value.length === 0 ? undefined : ta.value;
    });
    bottom.appendChild(ta);
  }
  main.append(top, bottom);

  const actions = document.createElement('div');
  actions.className = 'group-form-item-actions';
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'options-icon-button';
  up.title = 'Move up';
  up.textContent = '▲';
  up.addEventListener('click', () => {
    const idx = items.indexOf(it);
    if (idx > 0) {
      [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
      renderGroupItemsList(
        document.getElementById('group-items') as HTMLOListElement,
        items,
      );
    }
  });
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'options-icon-button';
  down.title = 'Move down';
  down.textContent = '▼';
  down.addEventListener('click', () => {
    const idx = items.indexOf(it);
    if (idx >= 0 && idx < items.length - 1) {
      [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
      renderGroupItemsList(
        document.getElementById('group-items') as HTMLOListElement,
        items,
      );
    }
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'options-danger-button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    const idx = items.indexOf(it);
    if (idx >= 0) items.splice(idx, 1);
    renderGroupItemsList(
      document.getElementById('group-items') as HTMLOListElement,
      items,
    );
    // Refresh the Available pane so the removed entry reappears there.
    const search = document.getElementById('entry-search') as HTMLInputElement | null;
    search?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  actions.append(up, down, remove);

  li.append(main, actions);
  return li;
}

function truncateForTitle(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// ==========================================================================
// Entry search (picking entries to add to a group)
// ==========================================================================

function wireEntrySearch(): void {
  const input = $<HTMLInputElement>('entry-search');
  const results = $<HTMLDivElement>('entry-search-results');
  let debounce: number | null = null;
  const run = async () => {
    if (!dialogState) return;
    const shape = await readStorage();
    const q = input.value.trim();
    // Entries already picked in the right pane — hide them from "Available".
    const currentRefs = new Set(dialogState.items.map((it) => it.entry_ref));
    const allEntries = Object.values(shape.fields)
      .filter((e) => !currentRefs.has(e.id))
      .sort((a, b) => b.captured_at - a.captured_at);
    const entries =
      q.length === 0
        ? allEntries
        : allEntries
            .map((e) => ({ entry: e, score: fuzzyScore(q, e) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || b.entry.captured_at - a.entry.captured_at)
            .map((x) => x.entry);
    results.innerHTML = '';
    // The Available list is always visible.
    results.hidden = false;
    const availableCount = document.getElementById('available-count');
    if (availableCount) availableCount.textContent = `${entries.length}`;
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'options-meta';
      empty.textContent =
        q.length > 0
          ? 'No entries match. Try a different query.'
          : currentRefs.size > 0
            ? 'All field library entries are already in this group.'
            : 'Field library is empty. Capture fields from a ServiceNow form first.';
      results.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entry-search-row';
      row.title = `Double-click to add "${displayFieldName(entry)}" to the group`;
      const left = document.createElement('div');
      left.className = 'entry-search-row-main';
      const name = document.createElement('span');
      name.className = 'entry-search-row-name';
      name.textContent = displayFieldName(entry);
      const tag = document.createElement('span');
      tag.className = `options-type-tag options-type-tag--${entry.field_type}`;
      tag.textContent = entry.field_type;
      const meta = document.createElement('span');
      meta.className = 'options-meta options-mono';
      meta.textContent = entry.field_name;
      left.append(name, tag, meta);
      const right = document.createElement('div');
      right.className = 'entry-search-row-value';
      if (entry.field_type === 'reference') {
        right.textContent = entry.ref_display_value ?? '';
        if (entry.ref_sys_id) {
          const small = document.createElement('span');
          small.className = 'options-meta';
          small.textContent = ` · sys_id ${abbrevSysId(entry.ref_sys_id)}`;
          right.appendChild(small);
        }
      } else {
        right.textContent = truncateForTitle(entry.value ?? '');
      }
      row.append(left, right);
      // Double-click to add (per user spec). On add, re-render both panes:
      // the entry disappears from Available (it's now "used"), and appears
      // in the right pane.
      row.addEventListener('dblclick', () => {
        if (!dialogState) return;
        dialogState.items.push({ entry_ref: entry.id });
        // Re-render right pane.
        renderGroupItemsList(
          document.getElementById('group-items') as HTMLOListElement,
          dialogState.items,
        );
        // Re-render Available list (removes the just-added entry).
        void run();
      });
      results.appendChild(row);
    }
  };
  input.addEventListener('focus', () => void run());
  input.addEventListener('input', () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(run, 80);
  });
  // Close the search results when the dialog closes.
  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (results.hidden) return;
    if (results.contains(target) || input.contains(target)) return;
    results.hidden = true;
  });
}

// ==========================================================================
// Groups dialog save / cancel
// ==========================================================================

function wireGroupDialog(): void {
  const form = $<HTMLFormElement>('group-form');
  const nameInput = $<HTMLInputElement>('group-name');
  form.addEventListener('submit', async (e) => {
    if (!dialogState) return;
    const submitter = (e.submitter as HTMLButtonElement | null);
    if (submitter?.value === 'cancel') {
      e.preventDefault();
      closeGroupDialog();
      return;
    }
    if (!nameInput.validity.valid) {
      e.preventDefault();
      nameInput.reportValidity();
      return;
    }
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.reportValidity();
      return;
    }
    const descInput = $<HTMLTextAreaElement>('group-description');
    const description = descInput.value.trim();
    const items = dialogState.items.slice();
    if (dialogState.mode === 'new') {
      const id = uuid();
      const now = Date.now();
      await mutateStorage((cur) => ({
        storage: {
          ...cur,
          groups: {
            ...cur.groups,
            [id]: { id, name, description, items, created_at: now, updated_at: now },
          },
        },
        result: undefined,
      }));
    } else {
      await mutateStorage((cur) => {
        const g = cur.groups[dialogState!.mode === 'edit' ? dialogState!.id : ''];
        if (!g) return { storage: cur, result: undefined };
        return {
          storage: {
            ...cur,
            groups: {
              ...cur.groups,
              [g.id]: { ...g, name, description, items, updated_at: Date.now() },
            },
          },
          result: undefined,
        };
      });
    }
    closeGroupDialog();
  });
  $<HTMLButtonElement>('btn-new-group').addEventListener('click', () =>
    openGroupDialog({ mode: 'new', name: '', description: '', items: [] })
  );
}

// ==========================================================================
// Init
// ==========================================================================

let lastShape: StorageShape | null = null;
function renderAll(shape: StorageShape): void {
  lastShape = shape;
  void lastShape; // Silence TS6133; retained for future inline-diff / quick actions.
  renderFieldLibrary(shape);
  renderGroups(shape);
}

async function init(): Promise<void> {
  wireTabs();
  // Check for a "next tab" hint left by the side panel's "Manage Groups"
  // button (or any other caller that wants to deep-link into a tab).
  let initialTab = 'fields';
  try {
    const hint = await chrome.storage.session.get('__options_tab_hint');
    if (hint?.__options_tab_hint) {
      initialTab = String(hint.__options_tab_hint);
      await chrome.storage.session.remove('__options_tab_hint');
    }
  } catch {
    /* session storage may be unavailable */
  }
  // Activate the requested tab if it exists.
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.options-tab'),
  );
  const targetTab = tabs.find((t) => t.dataset.tab === initialTab) ?? tabs[0];
  if (targetTab) {
    for (const t of tabs) t.classList.toggle('is-active', t === targetTab);
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.options-panel'))) {
      const active = panel.id === `tab-${targetTab.dataset.tab}`;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    }
  }
  const initial = await readStorage();
  lastShape = initial;
  renderAll(initial);
  onStorageChanged(renderAll);
  wireEntrySearch();
  wireGroupDialog();
}

void init();
