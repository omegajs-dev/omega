# Application Menu

File-based application menu (the macOS menu bar / Windows + Linux menu). Same builder + id-path API as [tray](tray.md) and [context-menu](context-menu.md).

## Config

No config block. Path is conventional: `src/integrations/menu/index.js`. To opt out, call `omega.menu.disable()` from your main entry.

## Definition file

- The file is an ES module with one default export, loaded through `require()` once at boot. A `module.exports` file is refused, and boot throws `<file> must be an ES module with one default export (export default async (...) => {})`.
- The body uses a top-level `import`, and `import.meta.dirname` for the file's folder. An edit shows on the next launch.
- No top-level `await`: the file is loaded by `require()`, which refuses an async module. The default export is called without `await`, so it builds its items before any `await` of its own.

```js
// src/integrations/menu/index.js
export default ({ omega, menu, defaults }) => {
  // Easiest: start from the platform-aware default template.
  menu.useDefaults();

  // Mutate by id-path:
  menu.show('main/preferences');                // @omega.js/desktop ships this hidden by default
  menu.update('main/check-for-updates', { label: 'Get Latest Version' });
  menu.insertAfter('main/check-for-updates', {
    id: 'main/account', label: 'Account...', click: () => omega.windows.show('account'),
  });
  menu.remove('view/reload');
  menu.hide('main/services');

  // Or add a whole new top-level menu:
  menu.menu('Tools', [{ id: 'tools/sync', label: 'Sync Now', click: () => {} }]);
};
```

## Builder API (during definition)

```js
menu.menu(label, items)        // add a top-level menu bar entry
menu.useDefaults()             // populate with the platform-appropriate default template
menu.append(item)              // append a top-level descriptor (rare; prefer menu())
menu.clear()                   // start over
```

## Id-path API

Same shape across menu / tray / context-menu. Available **during definition** (on the `menu` builder arg) AND **at runtime** on `omega.menu`:

```js
.find(idPath)                  // live descriptor or null
.has(idPath)                   // bool
.update(idPath, patch)         // Object.assign + re-render. returns true if found.
.remove(idPath)                // splice + re-render. returns true if removed.
.enable(idPath, bool = true)   // sugar over update({enabled})
.show(idPath, bool = true)     // sugar over update({visible})
.hide(idPath)                  // visible:false
.insertBefore(idPath, item)    // splice in a sibling
.insertAfter(idPath, item)     // splice in a sibling
.appendTo(idPath, item)        // push into a submenu (creates submenu if absent)
```

Menu ids are **paths** because menus actually nest (`main/check-for-updates`, `view/developer/toggle-devtools`). @omega.js/desktop matches by full id field first; if that misses it walks the path treating each segment as the last component of an id.

## Default template ids

Every item in @omega.js/desktop's default template carries a stable id you can target.

### macOS App menu (the one labeled with your app name)

| ID | Item | Notes |
|---|---|---|
| `main/about` | About | |
| `main/check-for-updates` | Check for Updates… | Auto-updater wired |
| `main/preferences` | Preferences… | `visible:false` by default — use `menu.show('main/preferences')` |
| `main/services` | Services submenu | |
| `main/hide` | Hide | |
| `main/hide-others` | Hide Others | |
| `main/show-all` | Show All | |
| `main/relaunch` | Relaunch | Restarts the app |
| `main/quit` | Quit | |

### File menu (win/linux equivalents of the App menu)

| ID | Item | Notes |
|---|---|---|
| `file/close` | Close (mac only) | |
| `file/preferences` | Preferences… (win/linux) | `visible:false` by default |
| `file/relaunch` | Relaunch (win/linux) | |
| `file/quit` | Exit | |

### Cross-platform

| ID | Item |
|---|---|
| `edit/undo`, `edit/redo`, `edit/cut`, `edit/copy`, `edit/paste`, `edit/select-all`, `edit/delete` | Edit submenu |
| `edit/paste-and-match-style` | mac only |
| `view/reload`, `view/reset-zoom`, `view/zoom-in`, `view/zoom-out`, `view/toggle-fullscreen` | View submenu |
| `view/developer` | Submenu (dev mode only) |
| `view/developer/toggle-devtools` | Toggle Developer Tools |
| `view/developer/inspect-elements` | Inspect Element |
| `view/developer/force-reload` | Force Reload |
| `view/developer/simulate-update` | Simulate update submenu (see [docs/desktop/auto-updater.md](auto-updater.md)) |
| `view/developer/simulate-update/available`, `.../unavailable`, `.../error` | Run the update simulator for one scenario |
| `window/minimize`, `window/zoom`, `window/front` | Window submenu (mac) |
| `window/minimize`, `window/close` | Window submenu (win/linux) |

### Help menu

| ID | Item | Notes |
|---|---|---|
| `help/check-for-updates` | Check for Updates… (win/linux only) | Auto-updater wired |
| `help/website` | "`<brandName>` Home" | Only when `brand.url` configured |

### Development menu (dev mode only)

Top-level, only visible when `omega.isDevelopment()`. Mirrors legacy @omega.js/desktop's developer utilities.

| ID | Item | Action |
|---|---|---|
| `development/open-exe-folder` | Open exe folder | Reveals `app.getPath('exe')` |
| `development/open-user-data` | Open user data folder | Reveals `app.getPath('userData')` |
| `development/open-logs` | Open logs folder | Reveals `app.getPath('logs')` |
| `development/open-app-config` | Open app config folder | Reveals `app.getPath('appData')` |
| `development/test-error` | Throw test error | Throws an uncaught error (verifies sentry / error handling) |

## Built-in framework items

`main/check-for-updates` (mac) and `help/check-for-updates` (win/linux) are **wired to `omega.autoUpdater`**:
- Label updates dynamically: *Checking…*, *Downloading 42%*, *Restart to Update v1.2.3*, *You're up to date*.
- Click triggers `autoUpdater.checkNow()` or `autoUpdater.installNow()` depending on state.

The same hook also patches the tray's `check-for-updates` item if present, so both UIs stay in lockstep.

Patch or remove either as needed — the auto-updater hook is a no-op when the item is missing.

## Item descriptors

Same dynamic conveniences as tray:
- `label` / `enabled` / `visible` / `checked` may be functions, evaluated on every `refresh()`
- `click` wrapped to catch errors
- `submenu` recursively resolved

## Runtime API on `omega.menu`

```js
omega.menu.refresh()                         // re-evaluate dynamic state
omega.menu.define(fn)                        // replace the whole definition at runtime
omega.menu.destroy()                         // tear down (mostly for tests)
omega.menu.disable()                         // turn the menu off entirely (idempotent)

// Id-path API — same as listed above.
omega.menu.find('main/check-for-updates')
omega.menu.update('main/check-for-updates', { label: 'Updates...' })
omega.menu.remove('view/reload')
omega.menu.insertAfter('main/check-for-updates', { id: 'main/account', label: 'Account...' })

// Inspection
omega.menu.getItems()                        // top-level descriptors (shallow copy)
omega.menu.isRendered()                      // bool
omega.menu.getMenu()                         // the underlying Electron Menu instance
```

## Default scaffold

The scaffold every verb runs ships `src/integrations/menu/index.js` calling `menu.useDefaults()` plus commented-out examples (show preferences, insertAfter, update, remove, hide, add a Tools menu, appendTo).
