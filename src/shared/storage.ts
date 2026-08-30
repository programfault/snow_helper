// Typed wrapper around chrome.storage.local. Reads merge the on-disk shape
// with the empty default so new fields are forward-compatible.

import { emptyStorage, type StorageShape } from './types';

export type { StorageShape } from './types';

const STORAGE_KEY = 'sn-helper:storage';

/** Read the entire storage root; merges with defaults. */
export async function readStorage(): Promise<StorageShape> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (result[STORAGE_KEY] ?? {}) as Partial<StorageShape>;
  const base = emptyStorage();
  return {
    schema_version: raw.schema_version ?? base.schema_version,
    fields: raw.fields ?? base.fields,
    groups: raw.groups ?? base.groups,
    services: raw.services ?? base.services,
    tokens: raw.tokens ?? base.tokens,
    token_cache: raw.token_cache ?? base.token_cache,
  };
}

/** Persist the entire storage root. */
export async function writeStorage(next: StorageShape): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/** Apply a pure transform to the on-disk storage and persist. */
export async function mutateStorage<T>(
  transform: (current: StorageShape) => { storage: StorageShape; result: T },
): Promise<T> {
  const current = await readStorage();
  const { storage, result } = transform(current);
  await writeStorage(storage);
  return result;
}

/** Subscribe to storage changes; receives the next full shape. */
export function onStorageChanged(handler: (next: StorageShape) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as StorageShape;
    if (next) handler(next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// uuid is in storage-helpers.ts now (shared with content script).
export { uuid } from './storage-helpers';
