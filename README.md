# SN Helper

A Chrome extension (MV3) that automates ServiceNow ticket workflows:

* **Right-side panel** that pushes the page aside (does not overlay).

* **Element picker** (DevTools-style) to capture form fields on demand into a
  reusable field library. Same field name can be captured multiple times
  with different `sys_id` / `display_value`.

* **Business groups** built from field library entries; click a group to fill
  a form via `g_form.setValue` (reference fields use the 3-arg form).

* **Remote services** invoked from the panel; the background service worker
  performs the request and toasts the result back to the page.

* **Token capture**: configured `(domain, localStorage key)` pairs are watched
  while you browse; captured tokens are auto-injected as request headers when
  services fire.

## Status

Phase 0 — project skeleton. See `docs/PROGRESS.md`.

## Tech

* Manifest V3

* Vite + `@crxjs/vite-plugin` (HMR for content script + service worker)

* TypeScript

* Vanilla UI (no framework)

* `chrome.storage.local` for config, token cache, audit log

## Project layout

```
plugin/
├── manifest.json              # MV3 manifest (CRXJS consumes it)
├── vite.config.ts             # Vite + CRXJS build config
├── tsconfig.json
├── docs/                      # all long-form docs
│   ├── PROGRESS.md            # progress anchor + resume hints
│   ├── ARCHITECTURE.md        # three-layer data flow + data structures
│   └── PLAN.md                # per-phase plan + done-definitions
└── src/
    ├── background/index.ts    # service worker: fetch + token inject + msg routing
    ├── content/index.ts       # activeTab injection: panel host iframe + body shift
    ├── panel/                 # right-side panel UI (hosted in iframe)
    ├── options/               # options page (fields library, groups, services, tokens)
    └── shared/                # types, chrome.storage wrapper, message contracts
```

## Getting started

```bash
# install deps
npm install

# dev build with HMR; load ./dist as unpacked extension
npm run dev

# production build
npm run build

# type-check
npm run typecheck
```

### Load the unpacked extension

1. `npm run dev`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the `dist/` folder
5. Pin the extension, click its icon on a ServiceNow form page

## Permissions

| Permission                     | Why                                                                |
| ------------------------------ | ------------------------------------------------------------------ |
| `activeTab`                    | Inject the content script only when the user clicks the icon       |
| `storage`                      | Persist field library, groups, services, token config, audit log   |
| `scripting`                    | `chrome.scripting.executeScript` to inject the panel host on click |
| `host_permissions` (localhost) | Call local services (`http://localhost:*`)                         |

Remote ServiceNow domains and remote service hosts are added to
`host_permissions` dynamically via `chrome.permissions.request` from the
options page (added in Phase 5).

## Documentation

* `docs/PROGRESS.md` — what is done, what is next, open questions

* `docs/ARCHITECTURE.md` — three-layer data flow, data structures, key decisions

* `docs/PLAN.md` — phase-by-phase tasks and done-definitions

