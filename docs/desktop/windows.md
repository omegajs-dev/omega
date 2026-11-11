# Windows

**Lazy named-window registry.** @omega.js/desktop does NOT auto-create any window. Your `main.js` calls `omega.windows.create('main', { show: !startup.isLaunchHidden() })` from inside `omega.initialize().then(() => { ... })`. Always create `main`: its presence in the registry is what lets @omega.js/desktop's `app.on('activate')` (macOS dock click) and `app.on('second-instance')` (win/linux re-launch) handlers surface UI when the user double-clicks the running app. In hidden launches, pass `show: false` to keep the window invisible until something explicitly calls `windows.show('main')`. Use the registry for the common case (named, persistent, integrated windows). For one-off windows (a toast, a print preview), use `new BrowserWindow()` directly, `window-manager` doesn't get in the way.

## Re-surface on user re-launch

When the user double-clicks a running app (or clicks its dock icon on macOS), @omega.js/desktop transparently shows the main window — no consumer wiring needed.

- **macOS** → `app.on('activate')` calls `windows.show('main')` if `main` is in the registry.
- **Windows / Linux** → `app.on('second-instance')` does the same. (The OS spawns a duplicate process, the single-instance lock kills it, and the original instance receives the activation.)

Both handlers are no-ops if `main` isn't in the registry. So consumers who genuinely never want a window can omit `windows.create('main', ...)`. Otherwise, the canonical pattern (`windows.create('main', { show: !isLaunchHidden() })`) gives CleanMyMac-style behavior: tray-only at login, full window when the user manually opens the app.

## API

```js
await omega.windows.create('main', overrides?)        // canonical entry point
await omega.windows.createNamed('main', mgr, opts?)   // identical; .create() is sugar
omega.windows.get('main')                              // BrowserWindow | null
omega.windows.show('main')                             // show + focus + auto app.dock.show()
omega.windows.hide('main')
omega.windows.close('main')                            // force-close (bypasses hideOnClose)
omega.windows.list()                                   // string[] of currently-open names
```

`create()` is single-instance: a second call with the same name returns the existing window and focuses it (no double-create).

## Defaults

No JSON config required. @omega.js/desktop bakes in sensible defaults so `omega.windows.create('main')` "just works":

| Window | Defaults |
|---|---|
| `main`         | `{ width: 1024, height: 720, hideOnClose: true,  view: 'main' }` |
| any other name | `{ width: 800,  height: 600, hideOnClose: false, view: name   }` |

Override at the call site:

```js
omega.windows.create('main',     { width: 1280, height: 800 });
omega.windows.create('settings', { width: 600,  height: 480 });
```

## Config (optional)

If you want to override defaults persistently (without typing them at every `create()` call), add a `windows:` block to `config/omega.json5`:

```jsonc
"windows": {
  "main": { "width": 1280, "height": 800 }
}
```

Merge order: **framework defaults < JSON config < call-site overrides**.

Per-window keys:

| Key | Default (main) | Default (other) | Description |
|---|---|---|---|
| `view` | `main` | `<name>` | Folder under `src/views/`. Loads `dist/views/<view>/index.html`. |
| `width` / `height` | 1024 / 720 | 800 / 600 | Initial size (overridden by saved bounds if `persistBounds: true`). |
| `minWidth` / `minHeight` | 400 / 300 | 400 / 300 | |
| `show` | `true` | `true` | Auto-show on `ready-to-show`. `false` keeps the window hidden until `omega.windows.show()`. |
| `hideOnClose` | `true` | `false` | Discord-style: X click hides instead of closes. See "Hide-on-close" below. |
| `title` | `app.productName` | `app.productName` | Window title. |
| `backgroundColor` | `#ffffff` | `#ffffff` | Background color before the page loads. |
| `persistBounds` | `true` | `true` | Remember position+size across launches (see below). |
| `skipTaskbar` | `false` | `false` | Suppress taskbar/dock entry for THIS window. |
| `titleBar` | `'inset'` | `'inset'` | `'inset'` (mac/win native overlay) or `'native'` (full system frame). |
| `titleBarOverlay` | platform default | platform default | Override Windows overlay color/symbolColor/height. |
| `trafficLightPosition` | OS inset default | OS inset default | macOS only: `{ x, y }` custom position for the traffic lights (e.g. to center them inside a floating chrome panel). Only applies in `'inset'` mode. |

## Inset titlebar (default)

@omega.js/desktop ships an inset titlebar by default — the OS draws all the window controls and @omega.js/desktop adds a draggable strip in the page template:

| Platform | Behavior |
|---|---|
| **macOS** | `titleBarStyle: 'hiddenInset'` — traffic lights inset into the chrome region. Reposition them via `config.windows.<name>.trafficLightPosition = { x, y }` (e.g. when the app draws a floating chrome panel and the lights should sit inside it). |
| **Windows** | `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 36 }` — native min/max/close buttons drawn by the OS |
| **Linux** | Native frame (full system title bar) |

The page template (`<em>/src/config/page-template.html`, framework-internal — not consumer-overrideable) ships an `.omega-titlebar` div with `-webkit-app-region: drag`. Per-platform spacing is handled by `themes/classy/css/components/_titlebar.scss`, which keys off `html[data-platform]` (set by @omega.js/client during init):

- **mac** → `padding-left: 70px` (clear the traffic lights)
- **windows** → `padding-right: 140px` (clear the native overlay)
- **linux** → `display: none` (native frame draws title bar)

Override per-window via `config.windows.<name>.titleBar = 'native'` to opt out and get a full system frame on every platform.

## Hide-on-close (Discord-style)

The `main` window's X button **hides instead of closes** by default. Real quit only via:

- `Cmd+Q` (macOS standard `role: 'quit'` accelerator)
- Menu Quit (`main/quit` on mac, `file/quit` on win/linux)
- Tray Quit (`quit` item)
- Auto-updater install (`autoUpdater.installNow()`)
- Programmatic `omega.quit({ force: true })`

The window-manager close handler checks three flags before deciding to swallow vs let through:

| Flag | Set by | Means |
|---|---|---|
| `omega._allowQuit` | `omega.quit({ force: true })`, `autoUpdater.installNow()` | Programmatic force: let the close go through. |
| `omega._isQuitting` | `app.on('before-quit')` (every quit path Electron knows about) | App is quitting: let close events flow naturally. |
| `win._emForceClose` | `omega.windows.close(name)` | Per-window override. |

Other named windows default to `hideOnClose: false` (X actually closes). Override per window via config or call-site overrides.

## Bounds persistence

Every named window's position and size persist to storage on resize / move / maximize / unmaximize / fullscreen-enter / fullscreen-leave / close. Restored on next `create()`.

- Storage key: `windows.<name>.bounds`
- Saves debounced 250ms; close flushes synchronously.
- Off-screen detection: if a saved position has less than 100×50px overlap with any current display's `workArea`, position is dropped (size kept). Handles "monitor unplugged" gracefully.
- Maximized / fullscreen state is stored separately and restored via `win.maximize()` / `win.setFullScreen(true)`.
- Sanity floor: saved entries with `width < 100` or `height < 100` are ignored.
- Opt out per-window: `persistBounds: false`.

## macOS dock auto-show

When `LSUIElement: true` is baked at build time (`startup.mode: 'hidden'`), the app launches with **no dock icon, no Cmd+Tab, no taskbar**. The first time `omega.windows.create()` or `omega.windows.show()` runs, @omega.js/desktop calls `app.dock.show()` automatically: the dock icon appears alongside the window.

**And the inverse**: for `startup.mode: 'hidden'` apps, when the LAST visible named window hides (hide-on-close X, `windows.hide()`, any consumer `win.hide()`), @omega.js/desktop calls `app.dock.hide()` again: the app returns to its fully-invisible posture, dock and UI appearing and vanishing together. Normal-mode apps keep their dock icon for life; quit paths are untouched (`omega._isQuitting` guard).

This means agent / menubar apps can stay completely invisible until the user explicitly asks for UI:

```js
omega.initialize().then(() => {
  // Don't call windows.create() here — app stays invisible.
  // Surface UI later when something warrants it:
  omega.tray.update('open', { click: () => omega.windows.create('main') });
});
```

## Auto-attach context-menu

Every window created via `omega.windows.create()` is automatically wired up with the consumer's `src/integrations/context-menu/index.js` (see [context-menu.md](context-menu.md)). Idempotent per webContents (uses a WeakSet). For windows you create directly with `new BrowserWindow()`, call `omega.contextMenu.attach(win.webContents)` manually.

## Testing mode: stealth surfacing

When `omega.isTesting()` (i.e. under `npx omega test`), every surfacing path in this lib (`ready-to-show`, `windows.show()`, the create-dedup focus) goes **stealth** instead of `win.show()`: `_surface()` applies the shared recipe from `src/utils/stealth-window.js` and surfaces via `showInactive()`, with no `win.focus()`/dock surfacing. **The full stealth story lives in [test-framework.md](test-framework.md) (SSOT)**: the recipe and why it's not `hide()`/`minimize()`, the raw-window `browser-window-created` hook, `webContents.focus()` suppression, macOS app-level activation suppression, and the **`OMEGA_TEST_SHOW=1`** opt-out. Covered by `suites/main/stealth-window.test.js`.

## Platform behavior

- `window-all-closed` → `omega.quit()` on Windows/Linux only, so a last window closed inside a `second-instance` handler still waits for the forwarding duplicate to exit ([deep-link.md](deep-link.md#quitting-from-a-second-instance-handler)). macOS apps are sticky (stay running with no windows).
- All event listeners (`close` / `closed` / `resize` / `move` / `ready-to-show` / etc.) are attached **before** `await loadFile()` resolves, so the window is fully observable the moment it lands in the registry.
