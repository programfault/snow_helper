# Plan

> Phase-by-phase execution plan. Each phase has a single user-visible
> outcome and a done-definition. Do not start the next phase until the
> current done-definition is verified on a real ServiceNow page.

## Phase 0 — Project skeleton

**Outcome**: an unpackable extension that loads without errors.

**Tasks**
- `package.json`, `manifest.json` (MV3), `vite.config.ts` (CRXJS), `tsconfig.json`
- Directory layout: `src/{background,content,panel,options,shared}`, `docs/`
- Shared modules: `types.ts`, `messages.ts`, `storage.ts`
- Minimal `background/index.ts`, `content/index.ts`, `panel/`, `options/`
- Docs: `README.md`, `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`
- `npm install` + `npm run build` succeeds; load `dist/` in Chrome

**Done when**
- [ ] `npm install` exits 0
- [ ] `npm run build` exits 0 with `dist/manifest.json`, `dist/background.js`,
      `dist/src/panel/index.html`, `dist/src/options/index.html`
- [ ] Loading `dist/` in `chrome://extensions` shows no errors in the
      extension card
- [ ] Clicking the icon logs `action clicked` in the service worker console

## Phase 1 — Right-side panel

**Outcome**: clicking the icon on any page opens a panel on the right that
pushes page content left and survives SPA navigation.

**Tasks**
- `chrome.action.onClicked` handler in `background/index.ts`:
  `chrome.scripting.executeScript` to inject `content/index.ts` (activeTab).
- Content script injects an `<iframe src=chrome-extension://.../panel/index.html>`
  fixed to the right edge, sets `document.body.style.marginRight = panelWidth`.
- `ResizeObserver` on `document.body` + `MutationObserver` on body attributes
  re-asserts the margin shift (ServiceNow workspace resets inline styles).
- Panel shell: header (title + settings button), placeholder sections
  (groups, services, token status), toast area at the bottom.
- Message channel: panel ↔ content via `window.postMessage` with a
  `kind` discriminator. Toast messages route content → panel.

**Done when**
- [ ] On a ServiceNow Classic form, clicking the icon opens the panel; page
      content shifts left by exactly the panel width, not overlapped
- [ ] On a ServiceNow workspace form, navigating between records does not
      reset the panel and does not overlap page content
- [ ] Closing the panel restores `body.margin-right` to its original value
- [ ] Panel `settings` button opens the options page in a new tab

## Phase 2 — Element picker + field library

**Outcome**: pick any ServiceNow field on the page and store it as a library
entry; same `field_name` can be stored multiple times with different values.

**Tasks**
- "Add field" button in panel → content script enters picker mode
- `mouseover` outlines the hovered element (only form inputs/labels match)
- `click` selects; prevent default; resolve field metadata:
  - `field_name`: reverse-lookup via `g_form` element map; fallback parse
    `input.id` (e.g. `incident.short_description` → `short_description`)
  - `label`: associated `<label for>` or sibling label text
  - `field_type`: `g_form.getFieldType(name)` if available; else
    `reference` when a hidden sys_id input exists alongside display input,
    else `string`
  - `ref_sys_id` / `ref_display_value`: `g_form.getValue(name)` returns
    sys_id for references; `g_form.getDisplayValue(name)` returns the
    visible text. For simple types, store under `value`.
  - `table_sys_id`: `g_form.getSysId()`
- Library UI in panel: list grouped by `field_name`, type tag chip
  (REF/STR/INT/JNL), display value bold, sys_id abbreviated, delete button.
- Persist to `chrome.storage.local` via `shared/storage.ts`.

**Done when**
- [ ] Pick `caller_id` with different users → library shows 3 entries
      under `caller_id`, distinguishable by display value + sys_id
- [ ] Pick a plain text field (`short_description`) → entry stored with
      `value` and no `ref_sys_id`
- [ ] Reloading the extension keeps the library populated
- [ ] Deleting an entry removes it from both UI and storage

## Phase 3 — Business groups + fill

**Outcome**: build a group from library entries; click the group to fill the
current form.

**Tasks**
- Options page group CRUD: name, pick library entries, edit per-item
  `override_value` (only editable for non-reference types — reference items
  show their sys_id+display read-only).
- Panel group list: one card per group; click → fill action.
- Fill pipeline in content script:
  - Resolve `g_form` per UI variant (Classic/Portal/Workspace)
  - For each `FieldGroupItem`, render template vars in `override_value`
  - reference: `g_form.setValue(name, ref_sys_id, ref_display_value)`
  - other: `g_form.setValue(name, value)`
  - DOM fallback path with dispatch `change`/`input` events
- Toast: `filled N fields, M failed` with a details expander
- Dry-run toggle deferred (not in MVP)

**Done when**
- [ ] A group with a reference field (`caller_id`) and two text fields
      fills all three correctly; saving the ServiceNow form persists the
      reference value (i.e. `g_form` path actually marked the field dirty)
- [ ] A group with `{{today}}` in a text field resolves to today's date
- [ ] Failed field fills surface in the toast, not as silent skips

## Phase 4 — Remote services

**Outcome**: configure a service; click it from the panel; result toasts on
the page.

**Tasks**
- Options page service CRUD: name, endpoint, method, body template,
  token ref dropdown.
- Panel service list: card per service; click → invoke.
- Service worker handler:
  - read service config + referenced TokenConfig + cached token
  - render template vars (`{{sys_id}}`, `{{field:...}}`) in body
  - `fetch(endpoint, { method, headers: {Authorization: prefix+token, 'Content-Type': 'application/json'}, body })`
  - return `{ok, status, body}` to the content script
- Content script routes result → panel → toast
- Errors (network, non-2xx, missing token) surface as red toasts with the
  status text

**Done when**
- [ ] A local service at `http://localhost:3000/echo` echoes back the
      request body as a toast on the page
- [ ] A service with a missing token shows a clear "token not captured"
      toast rather than a generic fetch error
- [ ] `{{sys_id}}` in the body template resolves to the current form sys_id

## Phase 5 — Token capture

**Outcome**: visiting a configured domain caches its localStorage token;
services automatically use it.

**Tasks**
- Options page token config CRUD: name, domain pattern, localStorage key,
  header name, header prefix.
- Content script: on load, if `location.hostname` matches any config's
  domain pattern, read `localStorage[key]`, write to
  `chrome.storage.local.token_cache[configId]` with timestamp.
- Also re-check on `storage` events of the page's localStorage.
- Service worker: before fetch, read
  `token_cache[service.token_ref]`; if missing, return early with the
  "token not captured" error from Phase 4.
- Panel token status bar: green dot per config whose cache is fresh
  (< 8h), yellow when stale, red when missing.

**Done when**
- [ ] Configure `localhost:3000` + key `accessToken`; visit
      `localhost:3000`; the panel shows the token as ready
- [ ] Trigger a service bound to that token; the request actually carries
      `Authorization: Bearer <token>` (verified via the local service log)
- [ ] Removing the token config clears the cache entry

## Deferred (post-MVP)

- Dry-run preview before group fill
- Audit log UI (writes can land earlier; viewer comes later)
- `chrome.commands` global shortcuts
- `response_jsonpath` extraction in services
- Config import/export (JSON)
- Multi-instance (dev/test/prod) config isolation
