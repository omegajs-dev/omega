# Tray

File-based tray/menubar. @omega.js/desktop looks for `src/integrations/tray/index.js`; if it exists, the exported function is called during boot with a builder API + id-path API. If absent, @omega.js/desktop ships a default tray template (see ids below).

## Config

No config block. Path is conventional: `src/integrations/tray/index.js`. To opt out, call `omega.tray.disable()` from your main entry: idempotent, tears down any existing Tray.

## Definition file

- The file is an ES module with one default export, loaded through `require()` once at boot. A `module.exports` file is refused, and boot throws `<file> must be an ES module with one default export (export default async (...) => {})`.
- The body uses a top-level `import`, and `import.meta.dirname` for the file's folder. An edit shows on the next launch.
- No top-level `await`: the file is loaded by `require()`, which refuses an async module. The default export is called without `await`, so it builds its items before any `await` of its own.

```js
// src/integrations/tray/index.js
export default ({ omega, tray }) => {
  // @omega.js/desktop auto-resolves the tray icon from config/icons/<platform>/tray.png at build
  // time, so explicit tray.icon() is OPTIONAL. Call it only to override.
  // Note: on macOS, if you pass your own path, the filename MUST end in
  // `Template.png` for the OS to auto-invert it in dark mode.
  // tray.icon('src/assets/icons/my-trayTemplate.png');
  tray.tooltip(omega.config?.app?.productName);

  // Easiest: start from @omega.js/desktop's default template.
  tray.useDefaults();

  // Then customize by id (flat — no `tray/` prefix needed):
  tray.insertAfter('open', {
    id: 'dashboard',
    label: 'Open Dashboard',
    click: () => omega.windows.show('dashboard'),
  });
  tray.update('open', { label: 'Show Window' });
  tray.remove('website');
  tray.hide('check-for-updates');
};
```

## Builder API (during definition)

```js
tray.icon(path)                // sets the tray icon (relative paths resolved from cwd)
tray.tooltip(text)
tray.item(descriptor)          // see "Item descriptors" below
tray.separator()
tray.submenu(label, items)
tray.useDefaults()             // populate with @omega.js/desktop's default template (id-tagged)
tray.clear()                   // start over
```

## Id-path API

Same shape across menu / tray / context-menu. Available **during definition** (on the `tray` builder arg) AND **at runtime** on `omega.tray`:

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

Tray ids are **flat** — no `tray/` prefix (the lib namespace is implicit). For nested submenus you can address children by `parent/child` paths (the resolver walks `submenu` arrays).

## Default template ids

| ID | Item |
|---|---|
| `title` | Disabled label showing the app name |
| `open` | "Open `<app>`": calls `omega.windows.show('main')` |
| `check-for-updates` | Wired to `omega.autoUpdater` (label updates dynamically) |
| `website` | Visit `brand.url` (only present if configured) |
| `quit` | Quit the app |

## Submenus

Submenus work the same as Electron's. The id-path resolver walks `submenu` arrays so children are addressable as `parent/child`:

```js
tray.item({ id: 'account', label: 'Account', submenu: [
  { id: 'sign-in',  label: 'Sign in',  click: () => {} },
  { id: 'sign-out', label: 'Sign out', click: () => {} },
]});

omega.tray.find('account/sign-out');
omega.tray.update('account/sign-out', { enabled: false });
omega.tray.appendTo('account', { id: 'profile', label: 'Profile' });
```

## Item descriptors

Mirror Electron's [`MenuItemConstructorOptions`](https://www.electronjs.org/docs/latest/api/menu#menubuildfromtemplatetemplate), with these additions:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Used for id-path lookups (`open`, `quit`, `account/sign-out`, …) |
| `label` | string \| `() => string` | Function form re-evaluated on every `refresh()` |
| `enabled` | boolean \| `() => boolean` | Same |
| `visible` | boolean \| `() => boolean` | Same |
| `checked` | boolean \| `() => boolean` | Same |
| `click` | function | Wrapped to swallow errors so a bad handler can't kill the menu |
| `submenu` | array | Recursively resolved with the same conveniences |

## Runtime API on `omega.tray`

```js
omega.tray.refresh()                   // re-evaluate dynamic state and re-render
omega.tray.define(fn)                  // replace the whole definition at runtime
omega.tray.disable()                   // tear down + stop responding (idempotent)
omega.tray.setIcon(path)
omega.tray.setTooltip(text)
omega.tray.addItem(descriptor)         // append (preserves existing items)
omega.tray.clearItems()
omega.tray.destroy()                   // tear down (mostly for tests)

// Id-path API — same as listed above.
omega.tray.find('quit')
omega.tray.update('quit', { label: 'Goodbye' })
omega.tray.remove('website')
omega.tray.insertAfter('open', { id: 'preferences', label: 'Preferences...', click: ... })
omega.tray.hide('check-for-updates')

// Inspection
omega.tray.getItems()                  // shallow copy of raw descriptors
omega.tray.getIcon()
omega.tray.getTooltip()
omega.tray.isRendered()
```

## Common patterns

### Update label after auth state changes

```js
// in your renderer/main code, after sign-in:
omega.storage.set('user', { ... });
omega.tray.refresh();    // dynamic-label functions re-evaluate
```

### Hide updater item if you ship without auto-update

```js
// src/integrations/tray/index.js
export default ({ tray }) => {
  tray.icon('...');
  tray.useDefaults();
  tray.remove('check-for-updates');
};
```

### Replace the entire tray at runtime

```js
omega.tray.define(({ omega, tray }) => {
  tray.icon('icons/dark-mode.png');
  tray.item({ id: 'x', label: 'New layout', click: ... });
});
```

## Default scaffold

The scaffold every verb runs ships `src/integrations/tray/index.js` calling `tray.useDefaults()` so you start with the same items the framework would supply on its own — plus commented-out examples covering insertAfter, update, remove, hide, enable, and submenus.
