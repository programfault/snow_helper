# Progress

> Anchor for what is done, what is next, and what is open. Update this file
> at the end of every working session so the next session can resume without
> re-reading the whole conversation.

## Current phase

**Phase 3 — Business groups + form fill** — status: **ready to start.**

## Phase status

| Phase                              | Status      | Notes                                                                   |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------- |
| 0 — Project skeleton               | done        | build verified, dev server runs, loadable                               |
| 1 — Side panel                     | done        | Chrome Side Panel API (browser-native, no overlap)                      |
| 2 — Element picker + field library | done        | DevTools-style overlay rect, MAIN-world g_form probe, dedupe, static content_scripts + force-inject fallback, user-verified |
| 2.5 — Field aliases                | done        | `FieldEntry.alias` added; panel uses alias-or-label-or-field_name display with hover title; options Field Library tab has per-row alias editor + delete + raw columns |
| 3 — Business groups + fill         | ready       | group CRUD in options, panel fill via g_form.setValue 3-arg             |
| 4 — Remote services                | pending     | options CRUD, SW fetch with token header injection                      |
| 5 — Token capture                  | pending     | dynamic (domain, localStorage key) config, content→storage→SW           |

---

## Done in Phase 2.5 (Aliases)

* [x] `src/shared/types.ts` — added optional `FieldEntry.alias?: string`
      with semantic comment (display priority chain: alias → label →
      field_name; editable only in options Field Library tab). Kept
      `table_sys_id` name for backwards compatibility with existing data.
* [x] `src/panel/panel.ts` — added two pure helpers (`displayFieldName`,
      `fieldNameTitle`) that encapsulate the alias/label/field_name
      priority + tooltip. Applied them to the Field Library group card
      header (bold primary display uses alias; pill uses alias if set;
      row-level entry tooltips show all three names on hover).
* [x] `src/options/options.ts` — rewrote options page:
      * `wireTabs()` now guarantees panel.hidden state matches CSS active
        class (fixes previous bug where `is-active` only set the class
        and relied on CSS without actually hiding/showing panels).
      * Added `renderFieldLibrary()` that renders a full HTML table
        (columns: **Alias** (editable input), **Type** (colorized tag),
        **Label**, **Field name** (mono bold), **Preset value** (disp +
        sys_id for refs, truncated with tooltip for strings, **dim
        (empty)** for blanks), **Captured** date, **Delete** button).
      * `alias` input commits on blur or Enter key; writes single-field
        mutation via `mutateStorage`.
      * Delete button uses confirm(); display name for confirm prompt
        falls back alias→label→field_name.
      * All rendered rows re-render on storage change (live update when
        panel-side library changes too).
* [x] `src/options/index.html` — replaced the Field Library tab's empty
      placeholder `<ul>` with hint + `<div><table><thead>7 cols</thead>
      <tbody id="fields-tbody"></tbody></table></div>`.
* [x] `src/options/options.css` — added table styles (sticky header,
      zebra-less, hover row highlight), mono/strong/meta/dim utility
      classes, `.options-cell-value` ellipsis, `.options-input`
      (focus ring with brand box-shadow), `.options-type-tag` palette
      (same per-type colors as the panel + dark theme variants), and
      `.options-danger-button` Delete button with hover→red fill.
* [x] `npm run typecheck` exits 0.
* [x] Pushed to origin/main (commit `fb67a8c`).

### Phase 2.5 user test checklist

* [ ] Open side panel → Field Library → add 2+ real entries (e.g.
      caller_id + assigned_to + short_description)
* [ ] Observe group card header shows the label/display-name NOT the
      raw field_name as main title; raw field_name appears as the
      muted pill subtitle
* [ ] Click ⚙ → options opens on Field Library tab → see a real 7-col
      table, each row has an Alias text input, a Type tag, Label,
      Field name, Value, date, Delete
* [ ] Type an alias into caller_id row (e.g. "Customer"), blur input
      → save happens silently
* [ ] Go back to side panel (do NOT reload extension; storage changes
      push live) → the `caller_id` group card now shows "Customer" as
      its primary title; hover on the title → tooltip shows
      `alias: Customer \n label: Caller \n field: caller_id`
* [ ] In options, delete the `short_description` row → confirm →
      table row disappears; side panel also reflects the deletion
* [ ] Side panel entries still have per-entry Delete buttons + work
      exactly as before

---

## Hotfix recap (Phase 2 runtime issues)

Two Phase 2 runtime bugs were fixed before Phase 2 could be considered
user-verified:

1. **Cannot load .ts** — tried `chrome.scripting.executeScript({ files:
   ["src/content/index.ts"] })`. Chrome only accepts compiled `.js` file
   paths in `files:`. Resolution: statically registered
   `manifest.content_scripts` with `matches: ["<all_urls>"], js:
   ["src/content/index.ts"]` — CRXJS resolves the .ts to a compiled .js
   at build/dev time, so Chrome gets a real .js.
2. **Cannot establish connection / Receiving end does not exist** —
   appears immediately after an extension reload on tabs that haven't
   been refreshed. Resolution: SW `sendToTabOrInject()` catches those
   error strings, then calls `forceInjectContentScript(tabId)` which
   reads `chrome.runtime.getManifest().content_scripts[0].js` (the
   RESOLVED real asset paths, never raw .ts source paths) and calls
   `chrome.scripting.executeScript({ files: [resolved.js] })`, then
   retries the original message.

Both fixes are in the codebase and pushed.

---

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
* [x] `src/content/index.ts` — real content script:
  1. `chrome.runtime.onMessage` PANEL_START_PICKER / PANEL_CANCEL_PICKER.
  2. `startPicker()` — DevTools-style overlay rect + tooltip +
     picker badge, `requestAnimationFrame` sync on scroll/mousemove.
  3. `findFieldRoot()` — walks 8 levels for `<input[name]>/<select[name]>/<textarea[name]>`.
  4. `captureFromElement()` — label via `label[for=<id>]` / `.control-label` fallback,
     type classification, `_display` siblings, MAIN-world g_form probe.
  5. `tryGformProbe(fieldName)` — `chrome.scripting.executeScript({ world: 'MAIN' })`
     for authoritative type/value/display/record_sys_id via `g_form.get*`.
  6. `postToPanel()` — CONTENT_FIELD_CAPTURED / CONTENT_PICKER_CANCELLED.
* [x] `src/background/index.ts` — PANEL_* → active tab routing via
      `tabs.sendMessage` with `sendToTabOrInject` fallback (connection
      errors → force-inject via resolved manifest paths).
* [x] `src/panel/index.html` — Field Library section with Add Field
      section-head primary button + header `+` quick-add.
* [x] `src/panel/panel.ts` — `sendToContent`, `handleFieldCaptured`
      dedupe, `renderFieldLibrary` groups entries by field_name,
      `setPickerBusy`/`wirePickerButtons`, `onStorageChanged` live
      re-render.
* [x] `src/panel/panel.css` — section-head / primary-button /
      field-lib card / per-type colorized tags / danger button.
* [x] Deleted obsolete `src/content/host.ts` (was iframe host).
* [x] `npm run typecheck` exits 0.

## Phase 2 verification (user done)

* [x] Chrome loads extension without "Cannot load .ts" manifest errors
* [x] Click Add Field — does NOT produce "cannot establish connection"
      on a freshly-reloaded page (force-inject fires if needed)
* [x] Hovering over ServiceNow fields shows DevTools-style blue
      selection rect + alias/type tooltip
* [x] Clicking caller_id / assigned_to / short_description /
      description entries correctly populates the field library with
      sys_ids for reference fields.
* [x] Esc cancels picker, toast shows "Picker cancelled"

---

## Phase 1 (done)

Chrome Side Panel API replaces iframe injection. `openPanelOnActionClick: true`.

---

## Done in Phase 0

* [x] `package.json` / `manifest.json` / `vite.config.ts` /
      `tsconfig.json` / `.gitignore` / docs scaffold / TypeScript
      shared modules (types, messages, storage) / panel shell +
      options shell + content placeholder + background shell.
* [x] `npm install` runs clean; `npm run build` produces loadable
      `dist/`.

---

## Resume hints (next session / another machine)

1. Clone: `git clone https://github.com/programfault/snow_helper.git`
2. `cd snow_helper ; npm install ; npm run build` (test) or `npm run dev`
   (dev with HMR).
3. Chrome `chrome://extensions` → Developer mode → Load unpacked →
   choose `snow_helper/dist`.
4. If you see "Receiving end does not exist" or "Cannot establish
   connection" right after a reload without navigating: the SW
   force-inject fallback is supposed to handle this. If the fallback
   fails, the error will contain the manifest-resolved file list; if
   it says "manifest has no content_scripts[0].js", the manifest build
   step was skipped (rerun `npm run dev` or `npm run build`).
5. CRXJS HMR can break the statically-registered content script
   mid-session. A page refresh or extension reload + page refresh
   always recovers. The force-inject fallback covers the extension
   reload case; page refresh covers the HMR case.

## Build artifacts summary

```
dist/
├── manifest.json                  # MV3, content_scripts: src/content/index.ts (resolved)
├── service-worker-loader.js       # CRXJS wrapper for background
├── src/
│   ├── panel/index.html           # /assets/panel-*.js + .css
│   └── options/index.html         # /assets/options-*.js + .css
└── assets/  (bundled hashed JS/CSS)
```

## Known backlog

1. Workspace (Next Experience) support untested — Classic `.do` is the
   target. Open workspace and inspect a field's outer HTML if capture
   fails, then we add workspace selectors.
2. `table_sys_id` key is misleading; rename to `record_sys_id` with
   one-time storage migration in Phase 3 (safest time, since no real
   stored data yet or storage can be reset).
3. Reference dedupe uses `ref_sys_id` first then `ref_display_value`.
   On workspace DOM (no sys_id via DOM-only), this could create
   duplicates.
4. Click capture only. Per spec we never auto-scan forms.
