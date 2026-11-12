# Startup

Controls how the app launches: full normal launch vs completely hidden background app. Also handles open-at-login.

## Config

```jsonc
"startup": {
  "mode": "normal",                // user-launch behavior: 'normal' | 'hidden'
  "openAtLogin": {
    "enabled": true,               // OS auto-launches the app at login
    "mode":    "hidden"            // login-launch behavior (defaults to 'hidden')
  }
}
```

`mode` is what happens when **the user launches the app directly** (clicks the dock icon / Start menu / etc.).

`openAtLogin.mode` is what happens when **the OS auto-launches the app at login**. It applies *only* when the launch is detected as a login-launch (macOS: `wasOpenedAtLogin` flag; Windows/Linux: presence of the `--omega-launched-at-login` arg @omega.js/desktop passes when registering the login item).

The default behavior — `mode: 'normal'` + `openAtLogin: { enabled: true, mode: 'hidden' }` — means: the app auto-starts at login but stays out of the way until the user opens it themselves. User-direct launches show the main window like any normal app.

## Modes

### `normal` (default)

Standard app behavior. Your `main.js` calls `windows.create('main', { show: !startup.isLaunchHidden() })` from inside `omega.initialize().then(...)`. In `normal` mode, `show` is `true` so the window appears immediately. Dock visible (macOS), taskbar entry (win/linux).

### `hidden`

App launches **completely invisible**: no dock icon, no Cmd+Tab presence, no taskbar entry. Tray + notifications + networking + IPC + auto-update all still work — only the visible UI is suppressed. Production builds inject `LSUIElement: true` into `Info.plist` (via `gulp/build-config`) so macOS treats the process as a background agent from launch — **zero dock bounce**.

The `main` window is still created (just with `show: false`) so it sits in @omega.js/desktop's window registry. When the user double-clicks the running app's icon, @omega.js/desktop's `app.on('activate')` (macOS) / `app.on('second-instance')` (win/linux) handler finds `main` in the registry and calls `windows.show('main')` — which auto-runs `app.dock.show()` so the dock icon appears alongside the window. Same thing happens when the consumer manually surfaces UI from a tray click / deep-link / IPC event via `windows.show('main')`. The reverse is automatic too: hiding the last visible window (including the hide-on-close X) re-runs `app.dock.hide()`, so a hidden-mode app never strands a dock icon after its UI is dismissed.

Use this for: menubar apps, agent apps (clipboard managers, time trackers, system monitors), apps that should be invisible at boot but available on demand.

**Dev caveat**: in dev (`npm start` / `electron .`), the packaged `Info.plist` isn't in effect, so macOS will still briefly bounce. Production builds (`npm run build` / `npx omega release --target=<name>` at the brand root) get the real zero-bounce behavior.

> **Note:** the deprecated `'tray-only'` mode is no longer valid — its behavior was always identical to `'hidden'`, so they've been folded into one. Old `tray-only` configs fall back to `'normal'` per `getMode()` validation.

## Public API on `omega.startup`

```js
omega.startup.getMode()                  // user-launch mode: 'normal' | 'hidden'
omega.startup.isLaunchHidden()           // true if THIS launch is hidden: combines
                                           //   user-launch mode + login-launch detection.
                                           //   Use this in main.js to gate windows.create().
omega.startup.wasLaunchedAtLogin()       // true if the OS auto-launched us at login
omega.startup.applyEarly()               // calls app.dock.hide() if needed (called by main.js boot)

omega.startup.setOpenAtLogin(true)                            // back-compat boolean form
omega.startup.setOpenAtLogin({ enabled: true, mode: 'hidden' }) // object form
omega.startup.isOpenAtLogin()            // read live OS state
```

## Typical main.js pattern

```js
omega.initialize().then(() => {
  // Always create the main window. In hidden launches, `show: false` keeps it
  // invisible until something explicitly calls windows.show('main') — but it's
  // in the registry, so @omega.js/desktop's activate/second-instance handlers can find and
  // surface it when the user double-clicks the running app.
  omega.windows.create('main', {
    show: !omega.startup.isLaunchHidden(),
  });
});
```

Don't conditionally skip `create()` for hidden launches — without `main` in the registry, the dock-click / re-launch handlers have nothing to surface, and the user double-clicking the running app appears to do nothing.

## Boot order

`startup.applyEarly()` is the **first** call in `omega.initialize()`: before `whenReady`, before any other lib. The goal: spend as little time as possible in the dock-bounce window.

Sequence: applyEarly → before-quit hook → ipc → storage → theme → fontawesome → sentry → protocol → deep-link → auth-flow → app-state → context → usage → whenReady → updater → tray/menu/contextMenu → startup.initialize → auth → remote-config → remote-scripts → analytics → restart-manager → windows.initialize (full list: [boot-sequence.md](boot-sequence.md)). **@omega.js/desktop does not auto-create the main window**: your `main.js` does that inside the `.then()` callback after `initialize()` resolves.

## How zero-bounce works on macOS

`LSUIElement` is an `Info.plist` key that tells macOS *before launch* "this app is a background agent — don't put it in the dock or app switcher." Setting it at runtime (`app.dock.hide()`) is too late — by the time JS runs, the dock-bounce animation has already started.

@omega.js/desktop handles this at build time:
1. `gulp/build-config` reads `config/omega.json5`.
2. If `startup.mode === 'hidden'` **or** `startup.openAtLogin.mode === 'hidden'`, it injects `mac.extendInfo.LSUIElement: true` into the materialized `dist/electron-builder.yml`. (The openAtLogin case matters for `mode: 'normal'` apps that launch hidden at login — without the plist key, the login launch flashes the dock before `applyEarly()`'s `dock.hide()` can run.)
3. `electron-builder` packages the app with that key in the final `Info.plist`.

With the key baked, a MANUAL launch also starts dockless — the dock icon appears the moment the main window surfaces (every surface path runs `_ensureDockVisible()` → `app.dock.show()`), so the visible difference is only that the bounce animation is replaced by the icon appearing when the window is ready.

At runtime, when the consumer first calls `omega.windows.show()` (or the `windows.create()` call resolves with `show: true`), @omega.js/desktop calls `app.dock.show()` so the dock icon appears alongside the window. Reverses cleanly via `app.dock.hide()` if you want to go back to invisible.

The injection is YAML-text-level (preserves comments, idempotent, merges with existing `extendInfo`). See `src/gulp/tasks/build-config.js`.

## Re-surfacing on user re-launch

When the user double-clicks a running hidden-mode app (or clicks its dock icon on macOS), @omega.js/desktop transparently surfaces the main window — no consumer wiring needed. Mechanisms:

- **macOS**: `window-manager.initialize()` registers `app.on('activate')` which calls `windows.show('main')` if `main` is in the registry.
- **Windows / Linux**: the `second-instance` listener `deepLink.listenFirst()` prepends when the main module loads (ahead of every brand listener) does the same once `deep-link.initialize()` has run. (The OS spawns a duplicate process, the single-instance lock kills it, and forwards its argv to the original instance.)

Both handlers are no-ops if `main` isn't in the registry, so consumers who genuinely never want a window can omit `windows.create('main', ...)` entirely. Otherwise, with the canonical pattern (`windows.create('main', { show: !isLaunchHidden() })`), hidden-mode apps come back to life on a second click — like CleanMyMac, Rectangle, etc.

## Testing the login-launch path locally

Pass `--omega-launched-at-login` as a command-line arg when launching the .app; @omega.js/desktop treats it identically to a real OS-driven login launch (`startup.wasLaunchedAtLogin()` returns `true`, with `via:argv-flag` in the boot summary log). Useful for testing hidden-mode behavior without configuring login items + rebooting.

The easiest way is `mgr launch`, which auto-strips `ELECTRON_RUN_AS_NODE` and uses `open -n` under the hood:

```bash
# Auto-discover the most recent `mgr package:quick` build:
npx omega launch --args="--omega-launched-at-login"

# Or pass an explicit path:
npx omega launch /Applications/MyApp.app --args="--omega-launched-at-login"
```

If you'd rather call `open` directly, remember to strip `ELECTRON_RUN_AS_NODE` first (the variable leaks into shells from common host processes like VS Code's Claude Code extension and silently breaks Electron):

```bash
unset ELECTRON_RUN_AS_NODE
open -n /path/to/MyApp.app --args --omega-launched-at-login

# Windows / Linux — direct binary launch
"/path/to/MyApp.exe" --omega-launched-at-login
```

The boot summary log written by the `startup` lib distinguishes a real login launch (`via:macos-wasOpenedAtLogin`) from a flag-based simulation (`via:argv-flag`).

## Pairing with tray/window patterns

Hidden / agent apps usually want:

```jsonc
"startup": { "mode": "hidden" }
```

And in `src/integrations/tray/index.js`:

```js
tray.update('open', { click: () => omega.windows.show('main') });
```

The window is created at boot but invisible. When the user clicks the tray's "Open" item (or double-clicks the app icon), `windows.show('main')` runs, @omega.js/desktop calls `app.dock.show()`, and the user sees both the dock icon and the window appear together.
