// Surface: the application menu (a file-based definition): a "Notes" menu, and
// the Preferences item opening the settings window
// Doc: node_modules/@omega.js/manager/docs/desktop/menu.md
//
// Application menu definition. Called by @omega.js/desktop during boot.
//
// `omega`: the running @omega.js/desktop main-process instance.
// `menu`     — builder API + id-path API (find/update/remove/insertAfter/etc.).
// `defaults` — the platform-aware default template (an array you can mutate manually if needed).
//
// This file is OPTIONAL — delete it and @omega.js/desktop still ships a working application menu.
//
// @omega.js/desktop ships a default menu template with stable id paths. Highlights:
//   main/about, main/check-for-updates, main/preferences (hidden), main/services,
//     main/hide, main/relaunch, main/quit                                          (mac)
//   file/close (mac), file/preferences, file/relaunch, file/quit                   (win/linux)
//   edit/undo, edit/redo, edit/cut, edit/copy, edit/paste, edit/select-all
//   view/reload, view/zoom-in, view/zoom-out, view/toggle-fullscreen
//   view/developer/{toggle-devtools, inspect-elements, force-reload}               (dev only)
//   window/minimize, window/zoom (mac), window/close (win/linux)
//   help/check-for-updates (win/linux), help/website (when brand.url configured)
//   development/{open-exe-folder, open-user-data, open-logs, open-app-config,
//                test-error}                                                       (dev only)

import { sendToNotes } from '../../lib/notes.js';

export default ({ omega, menu, defaults }) => {
  // Start from the platform-appropriate default template, then customize below.
  menu.useDefaults();

  // "New note" brings the main window forward and focuses its composer
  menu.menu('Notes', [
    { id: 'notes/new', label: 'New note', accelerator: 'CommandOrControl+N', click: () => sendToNotes(omega, 'notes:focus') },
  ]);

  // Preferences ships hidden; this app has a settings window, so show it.
  // create() is single-instance: a second click focuses the open window.
  const preferences = process.platform === 'darwin' ? 'main/preferences' : 'file/preferences';
  menu.show(preferences);
  menu.update(preferences, { click: () => omega.windows.create('settings') });

  // ───────── Examples (uncomment to use) ─────────
  //
  // // Insert your own item right after Check for Updates:
  // menu.insertAfter('main/check-for-updates', {
  //   id: 'main/account',
  //   label: 'Account...',
  //   click: () => omega.windows.show('account'),
  // });
  //
  // // Rename an existing item:
  // menu.update('main/check-for-updates', { label: 'Get Latest Version' });
  //
  // // Remove an item entirely:
  // menu.remove('view/reload');
  //
  // // Hide without removing (sets visible:false):
  // menu.hide('main/services');
  //
  // // Add an entire new top-level menu:
  // menu.menu('Tools', [
  //   { id: 'tools/sync', label: 'Sync Now', click: () => {} },
  //   { type: 'separator' },
  //   { id: 'tools/export', label: 'Export...', click: () => {} },
  // ]);
  //
  // // Append into an existing submenu:
  // menu.appendTo('view', { id: 'view/custom-zoom', label: 'Custom Zoom...', click: () => {} });
};
