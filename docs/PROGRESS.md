# Progress

> Anchor for what is done, what is next, and what is open. Update this file
> at the end of every working session so the next session can resume without
> re-reading the whole conversation.

## Current phase

**Phase 4 — Remote services (SW fetch + options CRUD + panel invocation UI + result toast)** — status: **ready to start.**

## Phase status

| Phase                              | Status  | Notes                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Project skeleton               | done    | build verified, dev server runs, loadable                                                                                                                                                                                                                                    |
| 1 — Side panel                     | done    | Chrome Side Panel API (browser-native, no overlap)                                                                                                                                                                                                                           |
| 2 — Element picker + field library | done    | DevTools-style overlay rect, MAIN-world g\_form probe, dedupe, static content\_scripts + force-inject fallback, user-verified                                                                                                                                                |
| 2.5 — Field aliases                | done    | `FieldEntry.alias` added; panel uses alias-or-label-or-field\_name display with hover title; options Field Library tab has per-row alias editor + delete + raw columns                                                                                                       |
| 3 — Business groups + fill         | done    | options Group CRUD with dialog, alias-fuzzy entry searcher, fill engine with g\_form.setValue (3-arg refs) + DOM fallback, template vars {{today}}/{{now}}/{{current\_user}}/{{sys\_id}}/{{host}}, panel group list with Fill + Manage Groups shortcut, per-item error toast |
| 4 — Remote services                | ready   | options CRUD, SW fetch with token header injection, message routing                                                                                                                                                                                                          |
| 5 — Token capture                  | pending | dynamic (domain, localStorage key) config, content→storage→SW                                                                                                                                                                                                                |

***

## Done in Phase 3 (business groups + form fill)

### Options page Groups tab (`src/options/index.html`, `src/options/options.ts`, `src/options/options.css`)

* [x] `<dialog id="group-dialog">` (native `<dialog method="dialog" + showModal />`), with header (title + close ✕), body (name input + entry-search adder + items list), footer (Cancel / Save).

* [x] **Groups grid** (`groups-grid`) — 1-col, ≥860px 2-col responsive cards.
  * Each card: header (name · item-count · Edit/Delete), ordered list of items (field name alias-or-label, per-type color tag, value/override preview, orphan entry warning in red if the library entry was deleted).

  * Delete field entry → all groups that referenced the entry auto-drop the item **and** the orphan warning fires on the next group render if the ref remains in the stored shape but the entry was concurrently removed elsewhere.

* [x] **Create / Save flow.** `dialogState` is a discriminated union of `{mode:'new'|'edit', name, items}`. Name is required via HTML5 validation + manual trim. Save writes `created_at:now / updated_at:now` into storage and closes dialog.

* [x] **Fuzzy alias/label/field\_name/ref\_display entry searcher**: debounced 80ms search, rows are clickable buttons with colorized type tags and value previews. Rows already in the current group are dimmed with a striped background (tooltip: "already in this group — click again to add a duplicate"). Clicking a row appends a fresh `{entry_ref}` to `dialogState.items`, re-renders the items list, and refocuses/selects the search box for fast chaining.

* [x] **Per-item form controls**:
  * Non-reference fields → `override_value` textarea (rows=2 default, journal gets rows=4). Placeholder shows the library preset. Help text advertises `{{today}} {{now}} {{sys_id}} {{current_user}}`.

  * Reference fields → read-only line showing display + sys\_id with a reminder that reference values are always from the entry (never overrideable — matches the spec).

  * Each row has ▲/▼ reorder buttons and Remove. Orphan rows render with a red warning box.

* [x] When a Field Library entry is deleted, group items referencing it are automatically stripped (`renderFieldRow → Delete handler` mutates `cur.groups` too) — prevents dangling refs.

### Content script fill engine (`src/content/index.ts`)

* [x] `PANEL_FILL_GROUP` message now carries fully-expanded `group: FieldGroup` and `fields: Record<string, FieldEntry>` snapshot from the panel (content script can't directly read `chrome.storage.local` from isolated world without an extra round-trip; this avoids one SW detour per fill).

* [x] `fillGroup`:
  * Early-gate on non-ServiceNow URLs (`CONTENT_TOAST error`).

  * Empty-group `CONTENT_TOAST warning`.

  * Iterates items in stored order, builds a per-item `{display, ok, error?}` report.

  * Orphan entries (entry\_ref missing from `fields` snapshot) show "Entry no longer exists…" without attempting to fill.

* [x] `readTemplateGlobals` — MAIN-world `g_user.userName` + `g_form.getUniqueValue()` via `scripting.executeScript({world:'MAIN'})`, composes `today` (yyyy-MM-dd), `now` (yyyy-MM-dd HH:mm), `host`, all in user's browser local tz.

* [x] `applyTemplateVars` — replaces `{{today}}`, `{{now}}`, `{{current_user}}`, `{{sys_id}}`, `{{host}}`.

* [x] `fillOneItem` — dispatch:
  * **reference** → requires `entry.ref_sys_id`; tries `g_form.setValue(name, sys_id, display_value)` first (3-arg form that sets both the hidden sys\_id and the visible display so the saved value is correct and no re-query is triggered); falls back to writing `<input name=field_name>` (sys\_id) + `<input name=sys_display.field_name>` or `#field_name_display` (display) with React-setter bypass via prototype value descriptor + `input` and `change` events dispatched.

  * **simple types (string / integer / decimal / boolean / journal / datetime)** → uses `override_value ?? entry.value`, then runs `applyTemplateVars`; tries `g_form.setValue(name, value)` first; falls back to prototype-set + events on the matched `<input|textarea|select>[name=field_name]`.

* [x] `CONTENT_FILL_RESULT` is the new rich-result message shape with counts and per-item `{field_name, display, ok, error?}`.

### Panel side UI + routing (`src/panel/panel.ts`, `src/panel/index.html`, `src/panel/panel.css`)

* [x] Groups section header now has `Field Groups` + **Manage Groups** button (ghost style). Button opens the options page; users click the Groups tab.

* [x] `renderGroups` + `renderGroupCard` build a card-per-group. Each card:
  * Head (group name · item count pill).

  * Item list (alias display name, per-type color tag, right-side value preview with 32-char truncation + tooltip for full override value).

  * Fill button (disabled when no items) — sends `PANEL_FILL_GROUP` with the expanded group + fields snapshot (captured at click time from current storage).

* [x] `CONTENT_FILL_RESULT` handler:
  * 0 errors → success toast: `Filled group "<name>" (N/N)`.

  * ≥1 error → error toast: `Group "<name>" had X error(s)` + detail bullets listing every failed field with its display name, raw field name, and error text.

* [x] Toast level `warning` added to union + CSS stripe (`panel-toast--warning` amber) for empty-group / DOM-gated failures.

### Message contracts (`src/shared/messages.ts`)

* [x] `export type { FieldGroup, FieldGroupItem }` added to re-exports; `FieldGroup` imported locally so the new message can reference it.

* [x] `PANEL_FILL_GROUP` rewritten from `{group_id:string}` to `{group:FieldGroup, fields:Record<string, FieldEntry>}`.

* [x] `CONTENT_FILL_RESULT` rewritten with `group_id`, `group_name`, `success`, `success_count`, `error_count`, and per-item `results[]`.

* [x] `CONTENT_TOAST.level` union expanded to include `'warning'`.

### Tests: type-check

* [x] `npm run typecheck` exits 0.

### Push

* [x] Committed and pushed to `origin/main` (commit `f3849c1`).

***

## Phase 3 user test checklist

1. Open a ServiceNow `.do` form and capture \~4 entries: caller\_id **(reference)**, assigned\_to (reference, also grab 2 different users so the same field has 2 entries), short\_description (string), description (journal).
2. Give the entries aliases on the Options Field Library tab: e.g. caller\_id → "Customer", assigned\_to first user → "Me", assigned\_to 2nd user → "Sam", short\_description → "Title", description → "Details".
3. **Options → Groups tab → + New Group**. Name it "Escalate to Sam".

   1. In the entry search, type `sam` → "Sam" reference result appears; click it to add.
   2. Type `t` (or `title`) → the Title entry appears; add it.
   3. In the Title row, open the override textarea and write `Escalation on {{today}}: {{sys_id}} assigned to Sam for triage by {{now}} (owner was {{current_user}})`.
   4. Add "Details" (journal). Override textarea rows=4 will appear. Write a 2-line close-note template that uses `{{today}}` somewhere.
   5. Click Save group.
4. **Grid of groups** shows the new card. Click Edit on the card — confirm dialog re-opens with the name, items, and overrides exactly as you saved them. Add one more field (e.g. "Customer") then Save.
5. **Side panel → Field Groups** section shows the card with 4 items (or 5) listed, alias names first, and "Me"/"Sam" display values for reference items. Click Fill.
6. **Toast success**: Side panel shows green `Filled group "Escalate to Sam" (N/N)`. The ServiceNow form shows:

   * assigned\_to = Sam (correct user; display shows Sam not sys\_id).

   * short\_description = The template-filled string. Today date matches your locale, sys\_id matches the URL `sys_id=`, now matches the current time, and `{{current_user}}` becomes your SN login name.

   * description = The close-note template with filled today date.

   * Save the ServiceNow ticket (click Update) and confirm: **all 3 fields persist correctly, especially assigned\_to didn't lose its value.**
7. **DOM fallback sanity check**: Temporarily try to fill a simple group from a blank `about:blank` page (not ServiceNow). Expect red error toast from `fillGroup`:
   `Fill only works on a ServiceNow page.` — confirms the URL gate works.
8. **Delete orphan entry test**: In Field Library, delete "Sam". Go back to groups grid → the group card now renders a red "(removed: …)" line next to the formerly-Sam item (auto-drop already stripped the ref during the delete mutation; this tests that the UI handles the edge case cleanly).
9. **Delete group**: In groups grid → Delete the new group → confirm → card disappears.

***

## Resume hints (Phase 4 kickoff)

Goal: allow users to define named HTTP services (name + method + endpoint + body template with `{{…}}` vars + optional token config ref), invoke them by clicking in the panel, route the invocation through the SW so we can:

1. Inject Authorization headers from captured tokens via domain match.
2. Avoid any page Content Security Policy blocking XHR.
3. Send the result back as a formatted toast (success with JSON preview body, error with status + text).

Options Services tab needs: create/edit/delete dialog similar to groups, method dropdown, endpoint text, raw JSON-or-string body template textarea, token ref `<select>` (maps to Phase 5's `tokens` map — for now the select can be empty + a Phase 5 todo note).

Background SW needs a new branch on `chrome.runtime.onMessage`:

```
SW_INVOKE_SERVICE(service: RemoteService, context: { sys_id, current_user, field_values })
  → resolve tokens to inject via token configs matching request origin
  → fetch(endpoint, { method, headers: {...}, body: template(body_template, context) })
  → return { ok, status, body_json_or_text, error? } via sendResponse
```

Content script can stay thin for Phase 4; the panel can send PANEL\_INVOKE\_SERVICE with a pre-resolved context snapshot read via a new MAIN-world probe function (`g_form.getUniqueValue()`, `g_user.userName`, plus any currently selected item field values from the panel). The panel is already reading storage and can send the full service record + context snapshot to the SW without going through the content script.

### Known backlog

1. Workspace (Next Experience) support untested — Classic `.do` is the target.
2. `table_sys_id` key is misleading; rename to `record_sys_id` with one-time storage migration.
3. Reference dedupe uses `ref_sys_id` first then `ref_display_value`. On workspace DOM (no sys\_id via DOM-only), this could create duplicates.
4. Click capture only. Per spec we never auto-scan forms.
5. Panel "Manage Groups" opens options but does not automatically switch to the Groups tab (add URL params + options page initial tab resolver for a nice polish item — can do in Phase 4).

