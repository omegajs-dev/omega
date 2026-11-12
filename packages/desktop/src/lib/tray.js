// Tray: the file-based tray. The consumer's src/integrations/tray/index.js is an ES
// module whose default export runs once at boot as ({ omega, tray }). The builder, the
// id-path API, the default ids and disable(): docs/desktop/tray.md.

const path = require('path');
const fs   = require('fs');
const LoggerLite = require('./logger-lite.js');
const sanitizeURL = require('../utils/sanitize-url.js');
const { buildIdApi } = require('./_menu-mixin.js');

const logger = new LoggerLite('tray');

const tray = {
  _initialized: false,
  _omega:       null,
  _tray:        null,    // electron Tray instance
  _items:       [],      // raw item descriptors
  _icon:        null,    // resolved abs path
  _tooltip:     null,
  _electron:    null,
  _definitionFn: null,   // consumer's exported fn (or null)

  initialize(omega) {
    if (tray._initialized) {
      return;
    }

    tray._omega = omega;

    if (tray._disabled) {
      logger.log('initialize — disabled via omega.tray.disable() called pre-init');
      tray._initialized = true;
      return;
    }

    tray._electron = require('electron');

    // Conventional path. No config knob — disable() at runtime if you don't want a tray.
    // appRoot resolves to project dir in dev and asar mount in packaged apps — both contain
    // src/integrations/* (electron-builder's `files: ['**/*']` packs the consumer's src/
    // into the asar), so the existsSync + require below works in both modes.
    const absPath = path.join(require('../utils/app-root.js')(), 'src', 'integrations', 'tray', 'index.js');

    if (fs.existsSync(absPath)) {
      const loadConsumerFile = require('../utils/load-consumer-file.js');
      tray._definitionFn = loadConsumerFile(absPath);
    } else {
      logger.log(`no tray definition at ${absPath} — using default template.`);
    }

    // Build the API object the consumer calls.
    const builder = tray._buildBuilder();

    if (tray._definitionFn) {
      try {
        tray._definitionFn({ omega, tray: builder });
      } catch (e) {
        logger.error('tray definition fn threw:', e);
      }
    } else {
      // No file → ship the default template as a sensible baseline.
      tray._items = tray._defaultTemplate();
    }

    // Apply defaults for any field the consumer didn't explicitly set. These ALL fall
    // back to sensible framework defaults so a consumer file is truly optional —
    // someone with no `src/integrations/tray/index.js` still gets a working tray.
    if (!tray._icon)    tray._icon    = tray._defaultIconPath();
    if (!tray._tooltip) tray._tooltip = omega.config.app?.productName || omega.config.brand.name;

    // Create the Tray now that items/icon/tooltip are in place.
    tray._render();

    // Reflect current auto-updater state into the tray check-for-updates item if present.
    if (omega.autoUpdater._updateTrayItem) {
      omega.autoUpdater._updateTrayItem();
    }

    logger.log(`initialize — items=${tray._items.length} icon=${tray._icon || '(none)'}`);
    tray._initialized = true;
  },

  // Builder exposed to the consumer's tray/index.js. Includes both construction helpers
  // and the full id-path API (so mutations during definition work).
  _buildBuilder() {
    const idApi = buildIdApi({
      getItems: () => tray._items,
      // During definition, render is a no-op — initialize() will render once at the end.
      render: () => {
        if (tray._initialized) tray._render();
      },
      logger,
    });

    return {
      icon:       (p) => { tray._icon = path.isAbsolute(p) ? p : path.join(require('../utils/app-root.js')(), p); },
      tooltip:    (t) => { tray._tooltip = t; },
      item:       (descriptor) => { tray._items.push(descriptor); },
      separator:  () => { tray._items.push({ type: 'separator' }); },
      submenu:    (label, items) => { tray._items.push({ label, submenu: items }); },
      useDefaults: () => { tray._items = tray._defaultTemplate(); },
      clear:      () => { tray._items = []; },
      ...idApi,
    };
  },

  // The runtime tray icon: what gulp/build-config resolved into dist/config/icons/<platform>/
  // (config/icons/<platform>/, then config/icons/global/, then the bundled default), so nothing
  // re-walks that order here, where `__dirname` is unreliable in the bundle. A run that skipped
  // the build falls back to config/icons/<platform>/<file>. Null when nothing is found.
  _defaultIconPath() {
    // The icon dirs are OMEGA's vocabulary (mac/windows/linux), so the OS is
    // read through the one translation point (#867). Electron runs nowhere else,
    // so an unknown OS falling back to linux is the safe read.
    const platform = require('../utils/platform.js').desktopPlatform() || 'linux';
    // INPUT name (what consumers ship in config/icons/<platform>/ or global/) is always tray.png.
    // OUTPUT name (what gulp/build-config writes into dist/config/icons/mac/) is
    // trayTemplate.png on mac: the `Template` suffix is a macOS magic marker that
    // makes the OS auto-invert the icon in dark mode.
    const inFile  = 'tray.png';
    const outFile = platform === 'mac' ? 'trayTemplate.png' : 'tray.png';
    const fallbackFile = 'icon.png'; // tray → app icon if absent

    const projectRoot = require('../utils/app-root.js')();

    // 1. dist/config/icons — populated by gulp/build-config (which already resolved
    // the platform/global/bundled waterfall at build time).
    const linuxFallbackPlatform = platform === 'linux' ? 'windows' : platform;
    const tryDistBuild = (plat, name) => path.join(projectRoot, 'dist', 'config', 'icons', plat, name);
    if (fs.existsSync(tryDistBuild(linuxFallbackPlatform, outFile))) {
      return tryDistBuild(linuxFallbackPlatform, outFile);
    }
    // tray slot missing → fall back to app icon.
    if (fs.existsSync(tryDistBuild(linuxFallbackPlatform, fallbackFile))) {
      return tryDistBuild(linuxFallbackPlatform, fallbackFile);
    }

    // 2. Consumer convention waterfall (skipped-build fallback — rare, testing scenarios).
    //    platform/<file> → global/<file> → [linux only] windows/<file> → platform/icon.png → global/icon.png.
    const tryConv = (subdir, name) => path.join(projectRoot, 'config', 'icons', subdir, name);
    if (fs.existsSync(tryConv(platform, inFile))) return tryConv(platform, inFile);
    if (fs.existsSync(tryConv('global', inFile))) return tryConv('global', inFile);
    if (platform === 'linux' && fs.existsSync(tryConv('windows', inFile))) return tryConv('windows', inFile);
    // Tray fallback to app icon.
    if (fs.existsSync(tryConv(platform, fallbackFile))) return tryConv(platform, fallbackFile);
    if (fs.existsSync(tryConv('global', fallbackFile))) return tryConv('global', fallbackFile);

    return null;
  },

  // Default template — id-tagged so consumers can target each item.
  _defaultTemplate() {
    const omega = tray._omega;
    const productName = omega.config.app?.productName || omega.config.brand.name;
    const brandUrl    = omega.config.brand.url || null;

    const items = [
      { id: 'title', label: productName, enabled: false },
      { type: 'separator' },
      {
        id: 'open',
        label: `Open ${productName}`,
        click: () => {
          omega.windows.show('main');
        },
      },
      {
        id: 'check-for-updates',
        label: 'Check for Updates...',
        click: () => {
          if (!omega || !omega.autoUpdater) return;
          const status = omega.autoUpdater.getStatus();
          if (status.code === 'downloaded') omega.autoUpdater.installNow();
          else omega.autoUpdater.checkNow({ userInitiated: true });
        },
      },
    ];

    if (brandUrl) {
      items.push({
        id: 'website',
        label: 'Visit Website',
        click: () => {
          const { shell } = require('electron');
          // Route through getWebsiteUrl() so dev runs open localhost:4000 instead
          // of punching out to the live brand site.
          const safe = sanitizeURL(omega.getWebsiteUrl());
          if (safe) shell.openExternal(safe);
        },
      });
    }

    items.push({ type: 'separator' });
    items.push({
      id: 'quit',
      label: 'Quit',
      accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Alt+F4',
      click: () => {
        const { app } = require('electron');
        app.quit();
      },
    });

    return items;
  },

  // Render or re-render the Tray + ContextMenu from the current item list.
  _render() {
    if (!tray._electron) return;

    const { Tray, Menu, nativeImage } = tray._electron;
    if (!Tray || !Menu) {
      logger.warn('Tray / Menu not available in this electron build.');
      return;
    }

    if (!tray._icon) {
      logger.warn('no icon set — tray will not be rendered. Call tray.icon(path) in your tray definition.');
      return;
    }

    if (!fs.existsSync(tray._icon)) {
      logger.warn(`tray icon file not found at ${tray._icon} — tray will not be rendered.`);
      return;
    }

    if (!tray._tray) {
      const image = nativeImage.createFromPath(tray._icon);
      tray._tray = new Tray(image);
    } else {
      // Re-render: just swap the icon + menu in place.
      tray._tray.setImage(nativeImage.createFromPath(tray._icon));
    }

    if (tray._tooltip) {
      tray._tray.setToolTip(tray._tooltip);
    }

    const template = tray._items.map((item) => tray._resolveItem(item));
    const ctxMenu = Menu.buildFromTemplate(template);
    tray._tray.setContextMenu(ctxMenu);
  },

  // Resolve a raw descriptor into an Electron MenuItemConstructorOptions.
  // Functions for label / enabled / visible / checked are evaluated *now*
  // (so refresh() re-evaluates dynamic state).
  _resolveItem(item) {
    if (item.type === 'separator') {
      return { type: 'separator' };
    }

    const out = { ...item };

    if (typeof item.label === 'function') {
      try { out.label = String(item.label()); }
      catch (e) { logger.error('item.label() threw:', e); out.label = ''; }
    }
    if (typeof item.enabled === 'function') {
      try { out.enabled = Boolean(item.enabled()); } catch (e) { out.enabled = true; }
    }
    if (typeof item.visible === 'function') {
      try { out.visible = Boolean(item.visible()); } catch (e) { out.visible = true; }
    }
    if (typeof item.checked === 'function') {
      try { out.checked = Boolean(item.checked()); } catch (e) { out.checked = false; }
    }

    if (Array.isArray(item.submenu)) {
      out.submenu = item.submenu.map((sub) => tray._resolveItem(sub));
    }

    if (typeof item.click === 'function') {
      out.click = (menuItem, browserWindow, event) => {
        try { item.click(menuItem, browserWindow, event); }
        catch (e) { logger.error('item.click handler threw:', e); }
      };
    }

    return out;
  },

  // Public runtime API --------------------------------------------------------

  // Re-evaluate dynamic labels/enabled/visible and re-render the context menu.
  refresh() {
    tray._render();
  },

  // Replace the entire definition at runtime (e.g. after auth state change).
  define(fn) {
    if (typeof fn !== 'function') {
      throw new Error('tray.define: fn must be a function');
    }
    tray._items = [];
    fn({ omega: tray._omega, tray: tray._buildBuilder() });
    tray._render();
  },

  // Direct mutators — handy for incremental updates.
  setIcon(p) {
    tray._icon = path.isAbsolute(p) ? p : path.join(require('../utils/app-root.js')(), p);
    tray._render();
  },
  setTooltip(t) {
    tray._tooltip = t;
    if (tray._tray) tray._tray.setToolTip(t);
  },
  addItem(descriptor) {
    tray._items.push(descriptor);
    tray._render();
  },
  clearItems() {
    tray._items = [];
    tray._render();
  },

  // Inspection helpers (used by tests + consumer diagnostics).
  getItems()   { return tray._items.slice(); },
  getIcon()    { return tray._icon; },
  getTooltip() { return tray._tooltip; },
  isRendered() { return Boolean(tray._tray); },

  // Tear down (used by tests + by `disable()` below).
  destroy() {
    if (tray._tray && !tray._tray.isDestroyed()) {
      tray._tray.destroy();
    }
    tray._tray = null;
    tray._items = [];
    tray._icon = null;
    tray._tooltip = null;
  },

  // Disable the tray entirely. Idempotent. Safe to call before OR after initialize:
  //   - Pre-init: marks the lib as disabled, initialize() short-circuits.
  //   - Post-init: tears down the live Tray + clears items.
  // No way to re-enable after disable(): call omega.tray.define() if you want a fresh
  // tray, then it'll re-render on next refresh.
  disable() {
    tray._disabled = true;
    tray._definitionFn = null;
    if (tray._initialized) {
      tray.destroy();
      logger.log('disabled at runtime — Tray torn down');
    }
  },

  isDisabled() { return Boolean(tray._disabled); },
};

// Mix the id-path API onto the singleton so `omega.tray.update(...)` works at runtime.
Object.assign(tray, buildIdApi({
  getItems: () => tray._items,
  render:   () => tray._render(),
  logger,
}));

module.exports = tray;
