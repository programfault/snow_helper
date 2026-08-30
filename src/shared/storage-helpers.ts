// Small helpers that are needed both by the content script (isolated world)
// and by the panel/options pages. Separated from storage.ts because the
// content script cannot safely import chrome.storage-local helpers if the
// user has not granted the storage permission to the page-level execution
// context — though they are, keep the concerns separate.

/** Generate a uuid v4. Uses crypto.randomUUID when available. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Abbreviate a sys_id to the first 6 and last 4 chars. */
export function abbrevSysId(sysId: string): string {
  if (sysId.length <= 10) return sysId;
  return `${sysId.slice(0, 6)}…${sysId.slice(-4)}`;
}
