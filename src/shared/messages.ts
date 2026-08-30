// Message contracts between layers. Every message carries a `kind`
// discriminator so unknown kinds are ignored (forward compatibility).
//
// After the Phase 1 pivot to the Chrome Side Panel API, the panel and the
// page live in DIFFERENT contexts (no shared window), so the panel <->
// content channel uses chrome message passing instead of window.postMessage:
//
//   panel -> content: chrome.tabs.sendMessage(tabId, message)
//   content -> panel: chrome.runtime.sendMessage(message)
//                     + chrome.runtime.onMessage filtered by sender.tab.id

import type { FieldEntry } from './types';

// Re-export so callers can import types alongside messages without reaching
// into the types module separately.
export type { FieldEntry };
export type { FieldType, FieldGroup } from './types';

// ---------------------------------------------------------------------------
// Side panel -> Content script  (chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

export type PanelToContentMessage =
  // Phase 2 — element picker
  | { kind: 'PANEL_START_PICKER' }
  | { kind: 'PANEL_CANCEL_PICKER' }
  // Phase 3 — field fill
  | { kind: 'PANEL_FILL_GROUP'; group_id: string }
  // Phase 4 — service invocation (routed via SW, but content script
  // intercepts this and forwards context to the SW)
  | { kind: 'PANEL_INVOKE_SERVICE'; service_id: string };

// ---------------------------------------------------------------------------
// Content script -> Side panel  (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export type ContentToPanelMessage =
  | {
      kind: 'CONTENT_TOAST';
      level: 'info' | 'success' | 'error';
      text: string;
      detail?: string;
    }
  // Phase 2 — picker results
  | { kind: 'CONTENT_FIELD_CAPTURED'; entry: FieldEntry }
  | { kind: 'CONTENT_PICKER_CANCELLED'; reason?: string }
  // Phase 3 — fill results
  | {
      kind: 'CONTENT_FILL_RESULT';
      ok: boolean;
      filled_count: number;
      detail?: string;
    }
  // Phase 4 — service invocation result (forwarded from SW)
  | {
      kind: 'CONTENT_SERVICE_RESULT';
      service_id: string;
      ok: boolean;
      status?: number;
      body?: unknown;
      error?: string;
    };

// ---------------------------------------------------------------------------
// Content script <-> Service worker (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export type ToServiceWorkerMessage =
  // Phase 4
  | {
      kind: 'SW_INVOKE_SERVICE';
      service_id: string;
      context: {
        sys_id?: string;
        field_values?: Record<string, string>;
        current_user?: string;
      };
    };

export type FromServiceWorkerMessage =
  | {
      kind: 'SW_INVOKE_RESULT';
      ok: boolean;
      status?: number;
      body?: unknown;
      error?: string;
    };

// ---------------------------------------------------------------------------
// Helpers (shared storage + uuid; not message-related but commonly needed
// alongside message types)
// ---------------------------------------------------------------------------

export * from './storage-helpers';
