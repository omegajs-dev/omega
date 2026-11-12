# Boot Sequence

`omega.initialize()` runs in the main process in a fixed order. Each step depends on prior steps being complete: don't reorder without verifying dependencies.

## Order

1. **`startup.applyEarly()`** — first thing, before `whenReady`. Calls `app.dock.hide()` for `mode: 'hidden'` (zero-bounce production via `LSUIElement` baked at build time).
1b. **userData path isolation** — appends an environment suffix to `app.getPath('userData')` so each environment's session data, logs, and `electron-store` files stay separate on the same machine: production untouched, development gets ` (Development)`, testing (`OMEGA_ENVIRONMENT=testing`) gets ` (Testing)`. The testing dir is **wiped at boot** so every test run starts from a clean slate (post-run state stays on disk for inspection until the next run; set `OMEGA_TEST_KEEP_USERDATA=1` to skip the wipe). **Must run before `storage.initialize()`** (which constructs `electron-store` against the path).
1c. **Global user-agent fallback** — sets `app.userAgentFallback` to a branded template via `node-powertools.template`. Default per-platform templates: `Mozilla/5.0 (... <platform-specific> ...) AppleWebKit/537.36 (KHTML, like Gecko) {brand.name}/{app.version} Chrome/{chrome} Safari/537.36`. Merge tags resolve from `{ brand: { name, id }, app: { version }, chrome, electron, node, platform, arch }`. Every BrowserWindow load + electron-updater fetch + node-fetch via the renderer carries the branded UA. Consumers can override post-init by re-setting `app.userAgentFallback` from their main.js.
2. **`app.on('before-quit')`** wired: sets `omega._isQuitting = true` so any quit path (Cmd+Q, role:'quit' menu, programmatic `app.quit()`, OS shutdown) bypasses the window-manager's hide-on-close trap.
3. **`ipc`** — typed channel bus online before any feature can register handlers.
4. **`storage`** — async (electron-store v11 ESM, bundled eagerly into `main.bundle.js` — see [storage.md](storage.md)). Other libs depend on this.
4b. **`theme`** — sets `nativeTheme.themeSource` from the persisted override (storage `theme.appearance`) → config `theme.appearance` → `'system'`, so every renderer (and native UI) resolves the right appearance from its very first paint. Needs storage + ipc only; must run before any window exists. See [themes.md](themes.md).
4c. **`fontawesome`**: serves the bundled icon SVGs to renderers over IPC (`desktop:fontawesome:get`). Needs ipc only.
5. **`sentry`** — earliest catchable global handler.
6. **`protocol`** — single-instance lock + custom scheme register.
7. **`deepLink`**: argv parse for cold-start, open-url wiring, built-in routes. Its `second-instance` listener is not a boot step: it is prepended when the main module loads, ahead of every brand listener ([deep-link.md](deep-link.md#single-instance-behavior)).
7b. **`authFlow`**: the sign-in round trip in the user's default browser (`omega.openAuthFlow()`); dev/test return through a loopback listener, since the scheme isn't OS-registered there.
8. **`appState`** — first-launch / launch-count / crash-sentinel / version-change.
8b. **`context`**: session id, deviceId, OS info, the async geolocation fetch. After storage (it writes deviceId), before analytics (which reads it).
8c. **`usage`**: opens / hours-total / hours-this-session, recorded on quit.
9. `await app.whenReady()`.
10. **`autoUpdater`** — electron-updater, never blocks.
11. **`tray`**, **`menu`**, **`contextMenu`**: file-based definitions from `src/integrations/{tray,menu,context-menu}/index.js`. Disable any of them at runtime via `omega.<name>.disable()` (no config flag).
12. **`startup.initialize`** — applies `setLoginItemSettings`.
13. **`auth`**: `omega.auth`, the main-side Firebase Auth source of truth, and the IPC handlers every renderer syncs through ([auth.md](auth.md)).
13b. **`remoteConfig`** — hot config from `<brand.url>/data/resources/main.json`. Non-blocking fire-and-forget fetch.
13c. **`remoteScripts`** — emergency remote code execution from `<brand.url>/data/scripts/main.js`. Non-blocking. Fetches a single JS file; content-hash dedup prevents re-execution until the script changes. Full main-process access.
13d. **`analytics`**: GA4 Measurement Protocol. Wired AFTER `auth` so it can subscribe with `omega.auth.listen()`.
13e. **`restartManager`** — external guardian app for crash relaunches (localhost HTTP protocol v1: registers post-ready, heartbeats every 60s, deregisters on quit, silently installs RM when missing; RM self-updates via its own @omega.js/desktop autoUpdater). See [restart-manager.md](restart-manager.md).
14. **`windows.initialize`**: registers app-level handlers: `window-all-closed` → quit on win/linux; `app.on('activate')` on macOS to surface `main` when the user double-clicks the dock icon (CleanMyMac-style). **Does NOT auto-create any window.** The consumer's main.js calls `omega.windows.create('main', { show: !startup.isLaunchHidden() })` from inside `omega.initialize().then(() => { ... })`. The `main` window is *always* created (so it's in the registry for the activate/second-instance handlers to find), but `show: false` keeps it invisible in hidden launches: tray icon shows immediately, dock icon + window appear only when something explicitly calls `windows.show('main')` (or the user double-clicks the running app).
15. **`deepLink.markOmegaReady()`**: releases the deep-link dispatch queue. Cold-start URLs (and any early `open-url`) wait here, so a route like `auth/token` never fires before `omega.auth` has Firebase up.

## Boot guard

Every desktop app's boot runs under one timer, `lib/_boot-guard.js`, with the single-instance lock on or off. It starts on the first line of the boot and stops just before step 13 (`auth`), where the macOS keychain may ask the user, so a slow keychain prompt ends nothing. Each step above records its name as the boot reaches it. When the timer runs out first, the app writes one line to `runtime.log`, `boot did not finish within 60 s; last step: <name>`, and exits with code 1: a boot that stalls (a `whenReady` that never resolves, say) ends by name instead of holding the single-instance lock in silence.

- The limit is `BOOT_LIMIT_MS`, a fixed 60000. No config key and no env key sets it.
- A real duplicate stops the timer before it quits, so it still exits 0 as a duplicate.
- The seam is `createBootGuard({ limitMs, write, exit })`, answering `{ start, step, stop }`; the app makes its one guard with the defaults (the limit, one line appended to `runtime.log`, the process's real exit).

## Why this order

- userData path append before storage init: otherwise dev and prod stores share the same path.
- before-quit before window-manager: so window-manager's close-trap can read `_isQuitting`.
- IPC before any other lib: every lib registers its own IPC handlers.
- Storage before sentry: sentry persists scope data.
- Theme right after storage: the persisted appearance override must hit `nativeTheme.themeSource` before any renderer paints, or the first frame flashes the wrong appearance.
- protocol/deepLink before whenReady: argv parsing for cold-start deep links must beat first window creation.
- whenReady gate is where Electron's app APIs become safe.
- autoUpdater after whenReady but never blocks boot.
- File-based integrations (tray/menu/context-menu) after everything that wires their click handlers (e.g. autoUpdater patches the check-for-updates menu item).
