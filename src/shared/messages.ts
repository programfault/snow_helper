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

import type { FieldEntry, FieldGroup, PlaybookStep } from './types';

// Re-export so callers can import types alongside messages without reaching
// into the types module separately.
export type { FieldEntry };
export type {
  FieldType,
  FieldGroup,
  FieldGroupItem,
  DictEntry,
  DictCategory,
  Playbook,
  PlaybookStep,
  InputDef,
  InputSelectOption,
  PatchStep,
  WaitStep,
  AssertStep,
  PlaybookTrigger,
  PlaybookInlineDict,
} from './types';

// ---------------------------------------------------------------------------
// Side panel -> Content script  (chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

export type PanelToContentMessage =
  // Phase 2 — element picker
  | { kind: 'PANEL_START_PICKER' }
  | { kind: 'PANEL_CANCEL_PICKER' }
  // Phase 3 — field fill
  // The panel sends the expanded group + fields snapshot so the content
  // script does not need to (and can not directly, from isolated world)
  // read the extension's chrome.storage.local.
  | {
      kind: 'PANEL_FILL_GROUP';
      group: FieldGroup;
      fields: Record<string, FieldEntry>;
    }
  // Phase 4 — service invocation (routed via SW, but content script
  // intercepts this and forwards context to the SW)
  | { kind: 'PANEL_INVOKE_SERVICE'; service_id: string }
  // --- Playbook engine: panel asks content script to fetch current form
  // context (table/sysId/g_user + all field values) used before running
  // steps, so the panel can resolve ${current.*} / trigger.table checks.
  | { kind: 'PANEL_GET_FORM_CONTEXT' }
  // --- Playbook engine: runs a single step on the MAIN world.
  // The panel has already interpolated variables into patch payloads so
  // the content script just forwards raw payloads to MAIN-world fetch/wait
  // /assert callables. Mock-mode patch never hits a real URL.
  | {
      kind: 'PANEL_PLAYBOOK_RUN_STEP';
      run_id: string;
      step_index: number;
      step: PlaybookStep;
    };

// ---------------------------------------------------------------------------
// Content script -> Side panel  (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export type ContentToPanelMessage =
  | {
      kind: 'CONTENT_TOAST';
      level: 'info' | 'success' | 'error' | 'warning';
      text: string;
      detail?: string;
    }
  // Phase 2 — picker results
  | { kind: 'CONTENT_FIELD_CAPTURED'; entry: FieldEntry }
  | { kind: 'CONTENT_PICKER_CANCELLED'; reason?: string }
  // Phase 3 — fill results. Per-item success + errors allow the panel to
  // build an actionable success/error toast (including template-variable
  // failures, DOM-fallback "no element found", and orphan entries).
  | {
      kind: 'CONTENT_FILL_RESULT';
      group_id: string;
      group_name: string;
      /** True if every item was filled without errors. */
      success: boolean;
      /** Number of items that filled successfully. */
      success_count: number;
      /** Number of items that failed to fill. */
      error_count: number;
      results: Array<{
        field_name: string;
        display: string;
        ok: boolean;
        error?: string;
      }>;
    }
  // Phase 4 — service invocation result (forwarded from SW)
  | {
      kind: 'CONTENT_SERVICE_RESULT';
      service_id: string;
      ok: boolean;
      status?: number;
      body?: unknown;
      error?: string;
    }
  // Per-site information pushed by the content script whenever it detects
  // meaningful values on the active page. The panel renders these rows in
  // the Information section with copy buttons.
  //   - Sending undefined / empty string means "field not available on
  //     this page". The panel hides unavailable fields so the UI stays
  //     clean on unrelated sites.
  //   - Fields are re-transmitted periodically (and on SPA navs / DOM
  //     mutations) so re-login always surfaces the latest token/WO/SID.
  | {
      kind: 'CONTENT_INFO_UPDATED';
      /** Bearer-formatted token for globe.com.ph — "Bearer <jwt...>" */
      access_token?: string;
      /** Work Order identifier for globe.com.ph work-order detail pages. */
      work_order_id?: string;
      /** Service ID extracted from the WO detail summary ("Service ID" h6). */
      service_id?: string;
    }
  // Playbook engine: snapshot of the current form (table/sysId/fields) so
  // the panel can perform trigger checks and ${current.*} interpolation
  // before sending any steps to the content script.
  | {
      kind: 'CONTENT_FORM_CONTEXT';
      on_servicenow: boolean;
      table_name?: string;
      sys_id?: string;
      user_name?: string;
      user_display?: string;
      values?: Record<string, string>;
      displays?: Record<string, string>;
    }
  // Playbook engine: single step result forwarded from MAIN world. The
  // panel stitches these into the per-playbook progress card, and uses
  // the ok flag to decide whether to continue to the next step.
  | {
      kind: 'CONTENT_PLAYBOOK_STEP_RESULT';
      run_id: string;
      step_index: number;
      ok: boolean;
      stopped?: boolean;      // true when stop-on-error is reached (panel should abort the run)
      skipped?: boolean;      // true on_error=skip / on_timeout=skip / on_fail=skip
      status?: number;        // HTTP status for patch (mock: 200)
      duration_ms: number;
      body?: unknown;
      error?: string;         // Human readable error message, shown in toast
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
