// Context-menu definition. Called by @omega.js/desktop EVERY time the user right-clicks.
//
// `omega`: the running @omega.js/desktop main-process instance.
// `menu`:         per-event builder API + id-path API.
// `params`:       Electron's context-menu params (selectionText, isEditable, linkURL,
//                 srcURL, mediaType, editFlags, x, y, etc.).
// `webContents`:  the webContents that fired the event.
//
// This file is OPTIONAL: delete it and @omega.js/desktop still ships a working context menu.
//
// @omega.js/desktop ships a default template (built per-event from params) with these ids (flat):
//   undo, redo:                                    when params.editFlags allow
//   cut, copy, paste, paste-and-match-style,
//   select-all:                                    when params.isEditable
//   copy:                                           when params.selectionText (read-only)
//   open-link, copy-link:                           when params.linkURL
//   reload:                                         always
//   inspect, toggle-devtools:                       dev mode only

export default ({ omega, menu, params, webContents }) => {
  // Start from @omega.js/desktop's default template. Don't add anything by default: leave it
  // identical to what the framework would do without this file.
  menu.useDefaults();

  // ───────── Examples (uncomment to use) ─────────
  //
  // // Add "Search Google" when text is selected (with `import { shell } from 'electron';`
  // // at the top of this file):
  // if (params.selectionText) {
  //   menu.insertAfter('copy', {
  //     id: 'search-google',
  //     label: `Search "${params.selectionText.slice(0, 20)}"`,
  //     click: () => shell.openExternal(`https://google.com/search?q=${encodeURIComponent(params.selectionText)}`),
  //   });
  // }
  //
  // // Remove the dev-tools entry (even in development):
  // menu.remove('toggle-devtools');
  //
  // // Hide instead of remove (visible:false):
  // menu.hide('inspect');
  //
  // // Disable Paste without removing it:
  // menu.enable('paste', false);
  //
  // // Add an "Open in External Editor" item only on links:
  // if (params.linkURL) {
  //   menu.insertAfter('open-link', {
  //     id: 'open-in-editor',
  //     label: 'Open in External Editor',
  //     click: () => { /* ... */ },
  //   });
  // }
  //
  // // Build entirely from scratch instead of useDefaults():
  // menu.clear();
  // menu.item({ id: 'custom', label: 'Custom Action', click: () => {} });
};
