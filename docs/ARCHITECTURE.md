# Architecture

> Stable design reference for future sessions. Captures the data flow, data
> structures, and the decisions that drove them. Change this file only when a
> decision changes, not when an implementation detail moves.

## Three-layer data flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Browser tab                                │
│  ┌────────────────────────────┐      ┌─────────────────────────────┐    │
│  │  ServiceNow page           │      │  Side panel (hosted iframe)  │   │
│  │  ┌─────────────────────┐    │     │  ┌────────────────────────┐  │   │
│  │  │ content script       │    │     │  │  panel.ts UI           │  │   │
│  │  │ - panel host inject   │    │     │  │  - group list          │  │   │
│  │  │ - picker (P2)         │    │     │  │  - service list        │  │   │
│  │  │ - g_form.setValue     │    │     │  │  - token status       │  │   │
│  │  │ - localStorage token  │    │     │  │  - toast area         │  │   │
│  │  │   capture (P5)        │    │     │  └────────────────────────┘  │   │
│  │  └─────────┬─────────────┘    │     └────────────┬────────────────┘   │
│  └────────────┼──────────────────┘                  │                    │
│                │ window.postMessage / custom events │                    │
│                └──────────────────────────────────────┘                    │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │ chrome.runtime.sendMessage / port
                              ▼
                  ┌───────────────────────────┐
                  │  Service worker (MV3)     │
                  │  - fetch() remote services │
                  │  - inject Authorization   │
                  │  - body template render   │
                  │  - message routing        │
                  └─────────────┬─────────────┘
                                │ chrome.storage.local
                                ▼
                  ┌───────────────────────────┐
                  │  chrome.storage.local     │
                  │  - field library         │
                  │  - groups                │
                  │  - services              │
                  │  - token config + cache  │
                  │  - audit log (future)    │
                  └───────────────────────────┘
```

## Why these layers

- **Content script + hosted iframe**: the panel must look like part of the
  page without overlaying it. The iframe hosts the panel UI; the content
  script shifts `body.margin-right` to make room and re-asserts the shift
  via `ResizeObserver` + `MutationObserver` because ServiceNow workspace
  (SPA, custom elements) resets layout during navigation.
- **activeTab + scripting API**: avoids a permanent `<all_urls>` host
  permission. The content script is injected only when the user clicks the
  icon — privacy-preserving and MV3-friendly.
- **Service worker owns `fetch`**: bypasses page CORS, can attach
  Authorization headers from `chrome.storage.local` without exposing tokens
  to the page. MV3 service workers are short-lived; do not hold state in
  module scope — read everything from storage per request.
- **`chrome.storage.local`**: capacity 10 MB (vs 100 KB for `sync`); the
  field library + groups + audit log will exceed `sync` quickly.

## Channel contracts

| Direction | Transport | Purpose |
|---|---|---|
| Panel ↔ content script | `window.postMessage` on a shared `window` | Panel asks content to fill a group, content toasts back |
| Content script ↔ service worker | `chrome.runtime.sendMessage` | Service invocation, result return |
| Options page ↔ storage | `chrome.storage.local` directly | CRUD on field library, groups, services, token config |
| Content script → storage | `chrome.storage.local.set` | Token capture on matching domain |

All messages carry a discriminated `kind` field; unknown kinds are ignored
(forward compatibility).

## Data structures

### `FieldEntry` (field library, allows duplicates of `field_name`)

```ts
type FieldType =
  | 'reference' | 'string' | 'integer' | 'boolean'
  | 'journal' | 'datetime' | 'decimal';

interface FieldEntry {
  id: string;                 // library-unique uuid
  field_name: string;         // e.g. 'caller_id' — may repeat across entries
  label: string;              // visible label, e.g. 'Caller'
  field_type: FieldType;
  // reference fields
  ref_sys_id?: string;        // referenced record sys_id
  ref_display_value?: string; // e.g. 'Alice Zhang'
  // simple-typed fields
  value?: string;
  // capture context
  table_sys_id?: string;      // the form record sys_id at capture time (reference only)
  captured_at: number;        // epoch ms
}
```

### `FieldGroup` (business group)

```ts
interface FieldGroupItem {
  entry_ref: string;          // FieldEntry.id
  // override only applies to simple-typed fields; reference items reuse the
  // library entry's sys_id + display_value as-is
  override_value?: string;
}

interface FieldGroup {
  id: string;
  name: string;               // e.g. 'Standard close'
  items: FieldGroupItem[];
  created_at: number;
  updated_at: number;
}
```

### `RemoteService`

```ts
interface RemoteService {
  id: string;
  name: string;               // e.g. 'complete order'
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body_template?: string;     // supports {{sys_id}} {{field:caller_id}}
  token_ref?: string;         // TokenConfig.id
  response_jsonpath?: string; // optional, deferred past MVP
}
```

### `TokenConfig`

```ts
interface TokenConfig {
  id: string;
  name: string;               // human label for selection in services
  domain_pattern: string;     // e.g. '*.service-now.com' or 'localhost:8080'
  localstorage_key: string;   // e.g. 'accessToken'
  header_name: string;         // e.g. 'Authorization'
  header_prefix: string;       // e.g. 'Bearer '
}
```

### Storage root

```ts
interface StorageShape {
  schema_version: number;     // bump on incompatible changes
  fields: Record<string, FieldEntry>;
  groups: Record<string, FieldGroup>;
  services: Record<string, RemoteService>;
  tokens: Record<string, TokenConfig>;
  token_cache: Record<string, { value: string; captured_at: number }>;
}
```

## Field-fill semantics

When a group is clicked, the content script iterates `group.items` and writes
each field via `g_form`:

| Field type | Call | Fallback (DOM) |
|---|---|---|
| reference | `g_form.setValue(name, ref_sys_id, ref_display_value)` | set hidden sys_id input + display input + dispatch change |
| other | `g_form.setValue(name, override_value ?? entry.value)` | set `input.value` + dispatch `input`/`change` |

`g_form` is resolved per UI variant:
- Classic (`*.do`): `window.g_form`
- Service Portal: walk shadow roots / iframe content
- Workspace (Now Experience): read from the `now-uicomponent` host element

If `g_form` cannot be resolved, fall back to DOM. The fallback is best-effort
and logged for the audit log.

## Template variables (Phase 3 onward)

- `{{today}}` — local date `YYYY-MM-DD`
- `{{now}}` — local datetime `YYYY-MM-DDTHH:mm`
- `{{sys_id}}` — current form record sys_id
- `{{current_user}}` — current ServiceNow user display name (best-effort)
- `{{field:<name>}}` — current value of another form field

## Why `chrome.sidePanel` API was rejected

`chrome.sidePanel` (Chrome 114+) is more stable but it is a browser-level
rail, not a page-level one — the user wanted the panel to *push the page
aside*, not float over the browser viewport. The injected-iframe approach
matches the requested UX at the cost of extra observer bookkeeping.
