// Context Menu: the file-based right-click menu. The consumer's
// src/integrations/context-menu/index.js is an ES module whose default export runs on
// every context-menu event as ({ omega, menu, params, webContents }). The builder, the
// id-path API, the default ids and attach/disable: docs/desktop/context-menu.md.

const path = require('path');
const fs   = require('fs');
const LoggerLite = require('./logger-lite.js');
const sanitizeURL = require('../utils/sanitize-url.js');
const { buildIdApi } = require('./_menu-mixin.js');

const logger = new LoggerLite('context-menu');

const contextMenu = {
  _initialized:  false,
  _omega:        null,
  _electron:     null,
  _definitionFn: null,
  _attached:     new WeakSet(), // webContents that already have the listener

  initialize(omega) {
    if (contextMenu._initialized) {
      return;
    }

    contextMenu._omega = omega;

    if (contextMenu._disabled) {
      logger.log('initialize — disabled via omega.contextMenu.disable() called pre-init');
      contextMenu._initialized = true;
      return;
    }

    contextMenu._electron = require('electron');

    // Conventional path. No config knob — disable() at runtime if you don't want a context menu.
    // appRoot resolves to project dir in dev and asar mount in packaged apps — both contain
    // src/integrations/* (electron-builder's `files: ['**/*']` packs the consumer's src/
    // into the asar), so the existsSync + require below works in both modes.
    const absPath = path.join(require('../utils/app-root.js')(), 'src', 'integrations', 'context-menu', 'index.js');

    if (fs.existsSync(absPath)) {
      const loadConsumerFile = require('../utils/load-consumer-file.js');
      contextMenu._definitionFn = loadConsumerFile(absPath);
    } else {
      logger.log(`no context-menu definition at ${absPath} — using default (copy/paste based on params).`);
    }

    logger.log(`initialize — definition=${contextMenu._definitionFn ? 'consumer' : 'default'}`);
    contextMenu._initialized = true;
  },

  // Attach the context-menu listener to a webContents (idempotent per webContents).
  attach(webContents) {
    if (!webContents || contextMenu._attached.has(webContents)) {
      return;
    }
    if (!contextMenu._electron) {
      return;
    }

    contextMenu._attached.add(webContents);

    webContents.on('context-menu', (event, params) => {
      contextMenu._popup(webContents, params);
    });
  },

  // Build the menu for the given (webContents, params) and pop it up.
  _popup(webContents, params) {
    if (contextMenu._disabled) return;             // disabled at runtime → no menu
    const { Menu } = contextMenu._electron;

    const items = contextMenu._buildItemsForEvent(params, webContents);
    if (items.length === 0) return; // suppress popup

    const template = items.map((item) => contextMenu._resolveItem(item));
    const builtMenu = Menu.buildFromTemplate(template);
    builtMenu.popup({ window: webContents.getOwnerBrowserWindow() || undefined });
  },

  // Construct the per-event builder + run the consumer's (or default) definition fn.
  // Returns the items array (live — but per-event, so post-event mutations are pointless).
  _buildItemsForEvent(params, webContents) {
    const items = [];

    const idApi = buildIdApi({
      getItems: () => items,
      // Per-event: nothing to re-render. The popup happens after definition returns.
      render: () => {},
      logger,
    });

    const builder = {
      item:        (d)            => { items.push(d); },
      separator:   ()             => { items.push({ type: 'separator' }); },
      submenu:     (label, subs)  => { items.push({ label, submenu: subs }); },
      useDefaults: ()             => { contextMenu._populateDefaults(items, params); },
      clear:       ()             => { items.length = 0; },
      ...idApi,
    };

    const fn = contextMenu._definitionFn || contextMenu._defaultFn;
    try {
      fn({ omega: contextMenu._omega, menu: builder, params, webContents });
    } catch (e) {
      logger.error('context-menu definition fn threw:', e);
      return [];
    }

    return items;
  },

  // Populate `items` with @omega.js/desktop's default template based on context-menu params.
  // Used by both `_defaultFn` (when no consumer file) and `menu.useDefaults()` (consumer opt-in).
  // Item set + visibility gates mirror the legacy @omega.js/desktop context-menu behavior:
  // undo/redo gated on canUndo/canRedo, edit ops gated on params.isEditable, etc.
  _populateDefaults(items, params) {
    const omega = contextMenu._omega;
    const flags = params.editFlags || {};

    // Undo / redo — only when applicable. Hidden when canUndo/canRedo is false (matches legacy).
    if (flags.canUndo) {
      items.push({ id: 'undo', role: 'undo' });
    }
    if (flags.canRedo) {
      items.push({ id: 'redo', role: 'redo' });
    }
    if (flags.canUndo || flags.canRedo) {
      items.push({ type: 'separator' });
    }

    if (params.isEditable) {
      items.push({ id: 'cut',                   role: 'cut',                enabled: flags.canCut   !== false });
      items.push({ id: 'copy',                  role: 'copy',               enabled: flags.canCopy  !== false });
      items.push({ id: 'paste',                 role: 'paste',              enabled: flags.canPaste !== false });
      items.push({ id: 'paste-and-match-style', role: 'pasteAndMatchStyle', enabled: flags.canPaste !== false });
      items.push({ id: 'select-all',            role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ id: 'copy', role: 'copy' });
    }

    if (params.linkURL) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({
        id: 'open-link',
        label: 'Open Link in Browser',
        click: () => {
          const { shell } = require('electron');
          const safe = sanitizeURL(params.linkURL);
          if (safe) shell.openExternal(safe);
        },
      });
      items.push({
        id: 'copy-link',
        label: 'Copy Link Address',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(params.linkURL);
        },
      });
    }

    // Reload — useful for both dev and prod. Separator only if there's already content above.
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ id: 'reload', role: 'reload' });

    if (omega.isDevelopment()) {
      items.push({ type: 'separator' });
      items.push({ id: 'inspect',         role: 'inspectElement' });
      items.push({ id: 'toggle-devtools', role: 'toggleDevTools' });
    }
  },

  // Default behavior when no consumer definition exists — sensible baseline.
  _defaultFn({ menu, params }) {
    menu.useDefaults();
  },

  // Same resolver pattern as tray/menu — supports dynamic label/enabled/etc.
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
      out.submenu = item.submenu.map((sub) => contextMenu._resolveItem(sub));
    }

    if (typeof item.click === 'function') {
      out.click = (menuItem, browserWindow, event) => {
        try { item.click(menuItem, browserWindow, event); }
        catch (e) { logger.error('item.click handler threw:', e); }
      };
    }

    return out;
  },

  // Public runtime API — replace the definition fn at runtime.
  define(fn) {
    if (typeof fn !== 'function') {
      throw new Error('contextMenu.define: fn must be a function');
    }
    contextMenu._definitionFn = fn;
  },

  // Test/inspection helpers — build the items list for given params without popping a menu.
  buildItems(params, webContents) {
    return contextMenu._buildItemsForEvent(params || {}, webContents);
  },

  hasCustomDefinition() {
    return Boolean(contextMenu._definitionFn);
  },

  // Disable the context menu entirely. Idempotent. Safe pre- or post-init.
  // After this, _popup() short-circuits — already-attached webContents stop
  // showing menus on right-click. No way to re-enable; call omega.contextMenu.define()
  // and clear _disabled if you really need to.
  disable() {
    contextMenu._disabled = true;
    contextMenu._definitionFn = null;
    if (contextMenu._initialized) {
      logger.log('disabled at runtime — context-menu events will be ignored');
    }
  },

  isDisabled() { return Boolean(contextMenu._disabled); },
};

module.exports = contextMenu;
