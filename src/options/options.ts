// Options page. Phase 0: render the current storage state per tab and wire
// tab switching. CRUD forms land in later phases (Phase 3+).

import { readStorage } from '../shared/storage';

async function renderCurrentState(): Promise<void> {
  const storage = await readStorage();
  const fieldCount = Object.keys(storage.fields).length;
  const groupCount = Object.keys(storage.groups).length;
  const serviceCount = Object.keys(storage.services).length;
  const tokenCount = Object.keys(storage.tokens).length;
  console.log('[sn-helper] options loaded', {
    fields: fieldCount,
    groups: groupCount,
    services: serviceCount,
    tokens: tokenCount,
  });
}

function wireTabs(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.options-tab'),
  );
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.options-panel'));

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.classList.toggle('is-active', t === tab);
      for (const panel of panels) {
        const active = panel.id === `tab-${tab.dataset.tab}`;
        panel.classList.toggle('is-active', active);
        if (active) {
          panel.removeAttribute('hidden');
        } else {
          panel.setAttribute('hidden', '');
        }
      }
    });
  }
  void panels;
}

// Init --------------------------------------------------------------------
wireTabs();
void renderCurrentState();
