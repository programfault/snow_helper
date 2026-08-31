// Options page. Phase 2.5: Field Library tab with per-row alias editor,
// per-row delete, and raw field_name / label / type / value columns so the
// user has full visibility on what's stored. Groups / Services / Tokens
// tabs stay as placeholders until Phase 3/4/5.

import type { FieldEntry } from '../shared/types';
import { mutateStorage, onStorageChanged, readStorage, type StorageShape } from '../shared/storage';
import { abbrevSysId } from '../shared/messages';

// Tab wiring ---------------------------------------------------------------

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
  // Activate the first tab by default (covers case where CSS class is-active
  // doesn't match any panel's aria-hidden state).
  if (tabs[0]) activate(tabs[0]);
}

// Field Library rendering + editing ---------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`#${id} not found in options document`);
  return el as T;
};

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
  // Commit alias on blur OR on Enter. Debounce not necessary for small
  // single-field writes.
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
      return { storage: { ...cur, fields: next }, result: undefined };
    });
  });
  actionTd.appendChild(delBtn);

  tr.append(aliasTd, typeTd, labelTd, fieldTd, valueTd, capturedTd, actionTd);
  return tr;
}

// Init ---------------------------------------------------------------------

async function init(): Promise<void> {
  wireTabs();
  const initial = await readStorage();
  renderFieldLibrary(initial);
  onStorageChanged(renderFieldLibrary);
}

void init();
