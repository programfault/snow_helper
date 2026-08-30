# Progress

> Anchor for what is done, what is next, and what is open. Update this file at
> the end of every working session so the next session can resume without
> re-reading the whole conversation.

## Current phase

**Phase 2 — Element picker + Field Library** — status: **implemented, typecheck passes, awaiting manual test on a ServiceNow form page**

## Phase status

| Phase                              | Status      | Notes                                                                   |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------- |
| 0 — Project skeleton               | done        | build verified, dev server runs, loadable                               |
| 1 — Side panel                     | done        | Chrome Side Panel API (browser-native, no overlap)                      |
| 2 — Element picker + field library | implemented | hover highlight, click capture, g_form MAIN-world probe, dedupe, field library grouped by field_name with type tags + display value + sys_id abbrev, persistent in chrome.storage.local; manual test pending |
| 3 — Business groups + fill         | pending     | group CRUD in options, panel fill via g_form.setValue 3-arg             |
| 4 — Remote services                | pending     | options CRUD, SW fetch with token header injection                      |
| 5 — Token capture                  | pending     | dynamic (domain, localStorage key) config, content→storage→SW           |

## Pivot recap (Phase 1 → 2)

The panel-host iframe approach (Phase 1 first draft) was replaced by the
Chrome Side Panel API (Chrome 114+). This eliminated the body-margin push
problems on ServiceNow workspace (fixed-position full-viewport SPA) and
also changed the panel ↔ content communication channel from
`window.postMessage` to **`chrome.runtime.sendMessage` + SW routing**:

- **panel → content**: `chrome.runtime.sendMessage(PANEL_*)` → SW
  `onMessage` → resolve active tab → `ensureContentScriptInjected` (ping
  + inject via `files: [src/content/index.ts]`) →
  `chrome.tabs.sendMessage(tabId, msg)`
- **content → panel**: `chrome.runtime.sendMessage(CONTENT_*)` → panel
  `onMessage` filtered by `sender.tab.id === activeTabId`

## Done in Phase 2

* [x] `src/shared/messages.ts` — rewrote for new channel;
  `PanelToContentMessage` (PANEL_START_PICKER / PANEL_CANCEL_PICKER /
  PANEL_FILL_GROUP / PANEL_INVOKE_SERVICE) and `ContentToPanelMessage`
  (CONTENT_TOAST / CONTENT_FIELD_CAPTURED /
  CONTENT_PICKER_CANCELLED / CONTENT_FILL_RESULT /
  CONTENT_SERVICE_RESULT); re-exported `FieldEntry`, `FieldType`,
  `FieldGroup` for convenient call-site imports.
* [x] `src/shared/storage-helpers.ts` — `uuid()` (was in storage.ts)
  and `abbrevSysId()` helpers that are safe for the content script's
  isolated world.
* [x] `src/shared/storage.ts` — re-exports `StorageShape`; `uuid` now
  re-exported from storage-helpers.
* [x] `src/content/index.ts` — **real** content script now. Implements:
  1. `chrome.runtime.onMessage` listener handling PANEL_START_PICKER
     / PANEL_CANCEL_PICKER.
  2. `startPicker()` — creates hover highlight, masked overlay +
     floating picker badge, window capture-phase mouseover/click/keydown
     handlers, Esc to cancel.
  3. `findFieldRoot()` — walks the clicked element up 8 levels looking
     for an `<input[name]>/<select[name]>/<textarea[name]>` (works for
     Classic `.do` forms; workspace uses `data-name` or closest
     `[name]` descendant).
  4. `captureFromElement()` — derives label via `label[for=<id>]` or
     `.control-label` fallback, classifies type via DOM markers, reads
     reference `_display` siblings for display_value + `#<id>` sys_id
     input.
  5. `tryGformProbe(fieldName)` — MAIN-world shim via
     `chrome.scripting.executeScript({ world: 'MAIN' })` that consults
     `window.g_form` to get authoritative type, value, display_value,
     and `g_form.getUniqueValue()` as `table_sys_id`. Uses
     `g_form.getField(fn).type` typeMap mapping when available.
  6. `postToPanel()` — sends `CONTENT_FIELD_CAPTURED` /
     `CONTENT_PICKER_CANCELLED` via `chrome.runtime.sendMessage`.
* [x] `src/background/index.ts` — rewrote `onMessage` to route PANEL_*
  messages to the active tab: resolves active tab id,
  `ensureContentScriptInjected(tabId)` does a `__PING__` tabs-send,
  falls back to `chrome.scripting.executeScript({ files:
  [src/content/index.ts] })` if no listener, then forwards the PANEL
  message and returns the content script's synchronous reply. Deferred
  `SW_INVOKE_SERVICE` stub retained for Phase 4.
* [x] `src/panel/index.html` — added "Field Library" section with
  section-head + Add Field primary button, field library root div.
* [x] `src/panel/panel.ts` — rewrote for Phase 2:
  1. `sendToContent()` wraps `runtime.sendMessage` and unwraps
     `{ok, reply}` or throws error.
  2. `onMessage` listener filters content messages by sender.tab.
  3. `handleFieldCaptured()` dedupes by
     `(field_name, field_type, ref_sys_id|display|value)`, merges onto
     existing entries, persists through `mutateStorage`.
  4. `renderFieldLibrary()` groups entries by field_name into cards,
     sorts cards alphabetically, lists each entry with type tag,
     primary value + sys_id abbrev (reference) or truncated value,
     capture-time + table_sys_id context line, and per-entry Delete
     button.
  5. `setPickerBusy()` + `wirePickerButtons()` hook header (`+`) and
     section-head primary buttons into PANEL_START_PICKER flow, with
     pending state and toast on activation.
  6. `onStorageChanged(renderFieldLibrary)` keeps the list live as
     storage changes (options edits, delete clicks, captures).
* [x] `src/panel/panel.css` — added `panel-section-head`,
  `panel-primary-button`, `panel-field-lib`, `panel-field-group` card,
  per-type colorized `panel-field-type-tag` badges, value
  primary/meta rows, `panel-danger-button` delete.
* [x] Deleted obsolete `src/content/host.ts` (was the iframe host from
  Phase 1 first draft).
* [x] `npm run typecheck` exits 0.

## Verification status (Phase 2)

* [x] `npm run typecheck` exits 0
* [ ] **User action required** — reload extension at
      `chrome://extensions` once (SW and content scripts changed
      substantially; CRXJS HMR is usually enough but reload is safer)
* [ ] **User action required** — open a ServiceNow Classic form
      (`*.do`) that has visible `caller_id`, `assigned_to`,
      `short_description`, `description` fields
* [ ] **User action required** — click SN Helper icon → side panel
      opens (should still work from Phase 1)
* [ ] **User action required** — click **Add Field** (either header `+`
      or section-head primary button)
  * Expect: floating badge on the page reads
    "SN Helper picker active — click a field, Esc to cancel"
  * Expect: moving mouse over elements shows a blue highlight on the
    element
* [ ] **User action required** — click the `caller_id` lookup field
      while it has a value assigned
  * Expect: picker stops, panel shows success toast with
    "Added caller_id / [Display Name] · sys_id a1b2c3…x9yz"
  * Expect: Field Library section renders a card grouped under
    `caller_id`, with **reference** blue type tag, display name as
    primary, abbreviated sys_id, and capture context line
* [ ] **User action required** — pick two different values for
      `assigned_to` (one value, then change it, then re-add)
  * Expect: single `assigned_to` group card, **2 entries** badge,
    each entry has its own display value + sys_id
* [ ] **User action required** — click a text field like
      `short_description` (with some text)
  * Expect: **string** purple type tag, truncated content as primary,
    truncation tooltip on hover
* [ ] **User action required** — click a Workspace (Next Experience)
      form field instead of a Classic field
  * Expect: either capture succeeds (if DOM exposes `name` attribute
    or `data-name` on closest ancestor), or panel shows
    "Picker cancelled: clicked element is not a recognized ServiceNow
    field" toast. Workspace DOM is different; if it consistently fails
    we add Workspace-specific selectors next session.
* [ ] **User action required** — press **Esc** during picker mode
  * Expect: picker stops, panel shows "Picker cancelled" toast
* [ ] **User action required** — delete an entry from the library via
      its Delete button
  * Expect: confirm dialog → entry disappears, storage change reflects
    immediately (no page reload needed)

## Known limits / next session backlog

1. **Workspace (Next Experience) support untested.** Classic `.do` is
   the primary target in Phase 2; Workspace captures may fail because
   the field wrappers use `data-name` and a different lookup-input DOM
   pattern. If Workspace capture is important now, open a real
   workspace record, capture the clicked element's outer HTML, and we
   write targeted selectors.
2. **`g_form.getUniqueValue()` returned value is stored under the
   misleading key `table_sys_id`** — actually it's the record's sys_id
   at capture time, not the table name. Renaming it to `record_sys_id`
   in the struct will happen in Phase 3 with a one-time storage
   migration to avoid breaking existing data.
3. **Reference dedupe uses `ref_sys_id` first, falls back to
   `ref_display_value`.** In Classic this is correct; workspace might
   not populate `ref_sys_id` via DOM alone — in that case multiple
   captures of the same reference but different sys_id resolution
   paths can create duplicates. Defer until workspace is tested.
4. **Click capture only, no form scan.** Per design we intentionally
   never auto-scan all form fields.

## Resume hints (next session)

1. If the side panel opens but click Add Field does nothing and SW
   console shows "content script inject failed" about "file not found"
   — check `dist/src/content/` has `index.ts` emitted. The path used is
   `files: ["src/content/index.ts"]`. If CRXJS emits under a different
   asset name, use the `chrome.runtime.getURL()` resolved path.
2. If capture always returns "not a recognized ServiceNow field" even
   on Classic forms, the most likely cause is that `findFieldRoot`
   walked past the input because the clicked element was a wrapper
   inside a lookup bubble. The 8-level walk is generous but not
   infinite; check the actual DOM and extend the walk or add an
   explicit selector for `.input-group > input[name]`.
3. If `tryGformProbe` returns null on a `.do` page that clearly has
   g_form (you can call `g_form.get('number')` in F12), the MAIN-world
   shim may be running before g_form initializes or in the wrong frame.
   Check that `chrome.tabs.query({ active:true, currentWindow:true })`
   resolves to the tab with the form; some ServiceNow pages put the
   form in an iframe inside the tab — in that case pass
   `allFrames:true` to `executeScript` target.
4. The dedupe logic in `handleFieldCaptured` treats identical values
   as duplicates. If you intentionally want to save **two** different
   empty presets for the same text field (e.g. blank vs. placeholder),
   extend the storage key with a user-defined name or add a
   "duplicate intentionally" path in the UI.

---

## Phase 1 (done)

Summary: Chrome Side Panel API replaces iframe-injection host; browser
native sidebar, no overlap. `openPanelOnActionClick: true` handles toggle.
Content-script injection is now on-demand via SW routing ping+inject.

---

## Done in Phase 0

* [x] `package.json` — Vite + `@crxjs/vite-plugin` + TypeScript

* [x] `manifest.json` — MV3, `activeTab`/`storage`/`scripting` + localhost hosts

* [x] `vite.config.ts` — CRXJS plugin, sourcemap, chrome110 target, panel as rollup input

* [x] `tsconfig.json` — strict, `types: ['chrome', 'vite/client']`

* [x] `.gitignore` — node_modules + dist

* [x] Docs scaffold — `README.md`, `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`

* [x] Shared modules — `types.ts`, `messages.ts`, `storage.ts`

* [x] `src/background/index.ts` — service worker skeleton (onInstalled + action.onClicked log)

* [x] `src/content/index.ts` — placeholder, real inject logic in Phase 1

* [x] `src/panel/index.html` + `panel.ts` + `panel.css` — panel shell (header, groups, services, tokens, toast)

* [x] `src/options/index.html` + `options.ts` + `options.css` — options shell (4 tabs)

* [x] `npm install` runs cleanly (49 packages, 0 errors)

* [x] `npm run build` produces loadable `dist/` (12 modules, manifest valid)

## Verification status

* [x] `npm install` exits 0

* [x] `npm run build` exits 0 and `dist/` contains:
  `manifest.json`, `service-worker-loader.js`, `src/panel/index.html`
  (references `/assets/panel-*.js` + `/assets/panel-*.css`),
  `src/options/index.html`, `assets/*`

* [x] Side panel loads on click, page narrows to make room.

## Resume hints (legacy)

1. Phase 0 is build-verified.
2. The chrome `action` has no `default_icon` yet — Chrome shows the default
   puzzle piece. Defer icon set until Phase 1 polish.
3. Phase 1 is the first user-visible milestone. Do not skip to Phase 2.
4. `host_permissions` for ServiceNow domains is intentionally omitted — we
   inject via `activeTab` + `chrome.scripting` (no permanent host grant).
5. After Phase 1, the panel iframe must remain visible across SPA navigation
   in ServiceNow workspace. Verify with both Classic UI (`*.do`) and workspace.
6. The build leaves `dist/src/panel/panel.ts` and `dist/src/panel/panel.css`
   as raw source copies (unused by the built HTML). Cosmetic; can be cleaned
   by narrowing `web_accessible_resources.resources` later if desired.

## Build artifacts summary

```
dist/
├── manifest.json                  # MV3, references SW loader + panel + options
├── service-worker-loader.js       # CRXJS wrapper for src/background/index.ts
├── src/
│   ├── panel/index.html           # references /assets/panel-*.js + .css
│   └── options/index.html         # references /assets/options-*.js + .css
└── assets/
    ├── panel-*.js / panel-*.css    # bundled panel TS+CSS
    ├── index.html-*.js / index-*.css  # bundled options TS+CSS
    └── modulepreload-polyfill-*.js
```

## Open questions / decisions

* [ ] Whether to add a placeholder extension icon set in Phase 0 polish or
  defer to Phase 1.

* [ ] Whether `chrome.commands` global shortcuts ("toggle panel",
  "fill last-used group") land in Phase 1 or a later polish phase.

* [ ] Audit log shape — left intentionally minimal; expand when Phase 4 lands.

* [x] Content script asset path: confirmed via Phase 2 SW routing as
  `src/content/index.ts` in `chrome.scripting.executeScript({files:[]})`.
