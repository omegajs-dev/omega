<p align="center">
  <a href="https://itwcreativeworks.com">
    <img src="https://cdn.itwcreativeworks.com/assets/itw-creative-works/images/logo/itw-creative-works-brandmark-black-x.svg" width="100px">
  </a>
</p>

<p align="center">
  <strong>OMEGA Desktop</strong>: all-in-one development framework for Electron apps. Sister project to
  <a href="../extension/">@omega.js/extension</a> and
  <a href="../web/">@omega.js/web</a>.
</p>

## What it does

- **One ready-made `omega` per Electron process**: `const omega = require('@omega.js/desktop/main'); omega.initialize()`, and the same for `/preload` and `/renderer`. Main carries every lib as a property (`omega.windows`, `omega.tray`, `omega.auth`, ...); the renderer extends @omega.js/client and carries `omega.desktop`, the bridge to main.
- **Modular feature library** — storage, IPC, theme, tray, menu, context menu, window manager, startup, app-state, deep-link, auto-updater, @omega.js/client auth, Sentry, **analytics, context, usage, remote-config, restart-manager**. Each feature is its own module with documented API.
- **System-aware dynamic theme.** `omega.theme` follows the OS light/dark preference **live** by default (`'system'`), with `'light'`/`'dark'` overrides persisted across boots. Every renderer (windows AND embedded views) keeps `<html data-bs-theme>` in sync automatically; consumers drop plain `<button data-omega-theme-set="dark">` controls and @omega.js/desktop wires them.
- **Cross-platform analytics identity.** GA4 Measurement Protocol with `client_id = uuidv5(deviceId, projectIdNamespace)` and `user_id = uuidv5(firebaseUid, projectIdNamespace)`. Same Firebase project ID in @omega.js/backend, @omega.js/web, @omega.js/client, and @omega.js/desktop produces identical `user_id` outputs everywhere → unified events for one human across desktop + web + backend, no manual stitching.
- **"Hot config"** fetched from your brand site (`<brand.url>/data/resources/main.json`) and polled hourly: flip a force-update version, default user-agent, ad rotation, etc. without re-releasing. `omega.remoteConfig.get('versionRequired')`. Cached to storage so offline boots still have last-known values.
- **File-based feature definitions** — trays, menus, and context-menus are JS files (full power, no DSL): `src/integrations/{tray,menu,context-menu}/index.js`. All three ship sensible **id-tagged defaults** (legacy-framework-style: about, preferences, check-for-updates, dev menu w/ inspector + log folders, etc.) and share the same **id-path mutation API**: `find`, `update`, `remove`, `enable`, `show`, `hide`, `insertBefore`, `insertAfter`, `appendTo`. Any default item is one line away from removal, customization, or repositioning.
- **Lazy windows + Discord-style hide-on-close.** @omega.js/desktop doesn't auto-create any windows — your `main.js` calls `windows.create('main', { show: !startup.isLaunchHidden() })`. The `main` window's X button hides instead of quitting on every platform; real quit only via Cmd+Q / menu Quit / tray Quit / auto-update install. Inset titlebar by default (mac `hiddenInset` traffic lights / win native overlay buttons / linux native frame) with a draggable topbar in the page template.
- **Zero-bounce hidden-launch on macOS.** `startup.mode = 'hidden'` bakes `LSUIElement: true` into Info.plist at build time → app launches completely invisible (no dock icon, no Cmd+Tab, no taskbar). Tray + notifications + networking still work. When the user double-clicks the running app's icon, @omega.js/desktop's `app.on('activate')` (macOS) / `app.on('second-instance')` (win/linux) handler surfaces the `main` window and the dock icon appears alongside it. CleanMyMac-style "tray-only at login, full window when manually opened" is the default.
- **Auto-update background install.** When a download finishes from a background poll (not user-initiated), @omega.js/desktop auto-relaunches into the new version after 5s — apps update overnight without bothering the user. User-initiated checks skip this so your UI can prompt instead.
- **Vert (ad) units with zero JS.** Drop `<div data-omega-vert></div>` into any view — the renderer auto-binds it (live, MutationObserver) to the shared OMEGA verts module: house/company inventory only (no AdSense in desktop surfaces), lazy near-viewport loading, sandboxed iframe, no-fill collapse. See [verts](../../docs/desktop/verts.md).
- **esbuild-bundled** main / preload / renderer for source protection.
- **Built-in test framework**: Jest-like syntax, four layers: `build` (plain Node), `main` (spawned Electron), `renderer` (hidden BrowserWindow), and `boot` (spawns the consumer's actual built `dist/main.bundle.js` for end-to-end smoke tests against the live `omega`, no `npm start && sleep && kill` shell hacks). Boot layer always rebuilds the bundle first so tests never see stale code.
- **Schema-validated config.** One `config/omega.json5` (the OMEGA-wide format: shared brand/analytics/payment/firebase sections + desktop settings under `targets.desktop`), validated against the canonical schema in the bundled `@omega.js/config`. Validation runs at app boot AND during `gulp audit` — a misconfigured app never reaches the "white window of confusion" stage; it tells you exactly which field is broken with a numbered list. Simple flag model — `required: true | false | (config) => bool` — and `match` / `enum` / `type` only fire on field presence so consumers never see a flood of redundant errors for the same field. Pure-JS validator, no Ajv/Joi/Zod dep. See [config-schema](../../docs/desktop/config-schema.md).
- **Multi-platform build/release** via GitHub Actions — macOS sign + notarize, Linux (deb + AppImage + optional Snap), Windows EV-token signing (self-hosted runner now, cloud-signing pluggable). Sensible installer defaults out of the box: NSIS one-click install on Windows (desktop + start menu shortcut, launch on finish), universal mac binary (one .dmg for Intel + Apple Silicon), `app.category` automatically mapped to per-platform values, copyright `{YEAR}` token always current. Snap Store publishing is on by default, under the snap name `brand.id`: a Linux package or release refuses without `SNAPCRAFT_STORE_CREDENTIALS` (`npx omega manage --service publishing` asks for it and registers the name; `npx omega deploy` flows it to CI), and `platforms.linux.formats.snap: false` drops the snap. See [installer-options](../../docs/desktop/installer-options.md).

## Quick start (consumer)

@omega.js/desktop auto-syncs your system Node version to match whatever Node Electron's bundled runtime ships with. The postinstall `sync-nvmrc` step queries the official Electron releases feed using your installed Electron version, then writes the corresponding Node major to `.nvmrc`; every verb seeds a missing `.nvmrc` the same way. Run `nvm use` afterward to switch your shell.

```bash
npm install @omega.js/desktop --save-dev
nvm use                  # switch to the Node version Electron uses (one-time per shell)
npm start                # dev: gulp → esbuild → electron .
OMEGA_CDP_PORT=9222 npm start  # dev + expose Chrome DevTools Protocol for Claude/MCP debugging
npx omega cdp status       # drive the running dev app over CDP: status|eval|shot|capture|theme|relaunch|quit (docs/desktop/cdp-debugging.md)
npm run build            # local production build (bundles only, no installer)
npm run package:quick    # fast packaged build for host platform/arch (.app/.exe-folder/linux-unpacked, ~20-30s) — for smoke-testing packaged behavior
npm run package          # full local production package (DMG/zip/universal-mac, NSIS-win, deb+AppImage-linux)
npx omega release        # signed + published release via GitHub Actions
npx omega test             # YOUR project tests only (C5 scoping — docs/shared/testing.md)
npx omega test framework:  # the framework's own suite (aliases: omega:, mgr:, desktop:, em:; add a path to narrow)
npx omega test full:       # both sources
npx omega test --extended  # opt into tests that hit real external services (or TEST_EXTENDED_MODE=true)
```

## Icons

Convention-only. Drop PNGs at:

```
config/icons/
  global/             ← used by any platform with no platform-specific override
    icon.png
    tray.png
  macos/              ← macOS overrides (beats global)
    icon.png
    tray.png          ← 32×32 — @omega.js/desktop renames to trayTemplate.png in dist for OS dark-mode magic
    dmg.png           ← 1080×760 DMG background
  windows/            ← Windows overrides
    icon.png
    tray.png
  linux/              ← Linux overrides (otherwise falls back to global → windows)
    icon.png
    tray.png
```

Resolution per slot/platform (most specific wins): `<platform>/<slot>` → `global/<slot>` → (Linux only) `windows/<slot>` → @omega.js/desktop bundled default. Tray missing falls back to app icon.

**Ship native (@2x) size only — @omega.js/desktop downscales the @1x sibling automatically.** macOS tray must be 32×32; macOS DMG must be 1080×760. @omega.js/desktop emits both `<slot>.png` and `<slot>@2x.png` into `dist/config/icons/<platform>/`. No `app.icons` config block — files are the source of truth.

## Logs

Five logs in `<projectRoot>/logs/`, each with its own purpose:

| File | What | Lifetime |
|---|---|---|
| `runtime.log` | Your packaged app's runtime: main + preload + renderer all converge here via electron-log | With the single-instance lock on (the default), the launch that holds the lock empties it of earlier launches' lines and a duplicate launch leaves it alone; with `protocol.singleInstance: false` every launch appends and tags its lines `[pid <n>]`. Rotates at 10 MB |
| `dev.log` | Gulp pipeline output — sass, bundle, html, electron child stdout from `npm start` | Truncated each `npm start` |
| `build.log` | Gulp pipeline output for production builds/packages (`npm run build` / `package` / `publish`, i.e. `OMEGA_BUILD_MODE=true`) | Truncated each build |
| `test.log` | `npx omega test` runner output (suite names, pass/fail, harness boot lines) | Truncated each test run |
| `deploy.log` | `omega deploy` and `omega release`, the whole deploy: the scaffold, the precheck, the dispatch, then the streamed GH Actions run | Truncated each deploy |

```bash
npx omega logs                  # tail last 50 of runtime.log
npx omega logs --tail           # follow runtime.log live
npx omega logs dev --tail       # follow dev.log (runtime|dev|build|test)
grep -i error logs/runtime.log
```

In production, `runtime.log` lives at `app.getPath('logs')`:
- macOS: `~/Library/Logs/<AppName>/runtime.log`
- Windows: `%APPDATA%\<AppName>\logs\runtime.log`
- Linux: `~/.config/<AppName>/logs/runtime.log`

See [docs/desktop/logging.md](../../docs/desktop/logging.md) for the full picture (renderer forwarding, log levels, programmatic path access).

Override gulp's `dev.log` path via `OMEGA_LOG_FILE=<path>`; disable entirely via `OMEGA_LOG_FILE=false`. The default `.gitignore` includes `logs/`.

## Design tokens (C4)

The cross-target `--omega-*` token contract (defined once in
`@omega.js/web`'s `core/css/tokens/_index.scss`) is vendored into
`dist/assets/css/tokens/` at prepare (package.json `omega.vendorAssets`)
and emitted by the `omega-desktop` entry BEFORE the theme — theme rules
override at equal specificity, and consumer scss can read
`var(--omega-*)` directly. First consumer: `body { accent-color:
var(--omega-accent) }`. The full component migration onto tokens lands
with the C3/D10 skin.

## Per-process imports

Each entry exports ONE ready-made instance, `omega`; a consumer never writes `new`.

```js
// src/main.js
const omega = require('@omega.js/desktop/main');
omega.initialize().then(() => { const { logger, windows } = omega; });

// src/preload.js
const omega = require('@omega.js/desktop/preload');
omega.initialize();

// src/assets/js/components/<view>/index.js
import omega from '@omega.js/desktop/renderer';
omega.initialize().then(() => { const { logger, desktop } = omega; });
```

## Documentation

Each subsystem has its own API reference under [`docs/desktop/`](../../docs/desktop):

- [storage](../../docs/desktop/storage.md) — KV store, sync in main, async (via IPC) in renderer, dot-notation paths, change broadcasts
- [ipc](../../docs/desktop/ipc.md) — typed channel bus, `handle` / `invoke` / `broadcast`
- [windows](../../docs/desktop/windows.md) — lazy named-window registry (no auto-create), bounds persistence, inset titlebar, hide-on-close
- [tray](../../docs/desktop/tray.md) — file-based tray definition, dynamic items, runtime mutators
- [menu](../../docs/desktop/menu.md) — file-based application menu, platform-aware default template
- [context-menu](../../docs/desktop/context-menu.md) — file-based right-click menus, called per-event with `params`
- [startup](../../docs/desktop/startup.md) — launch modes (`normal` / `hidden`), LSUIElement on macOS, login-item handling
- [app-state](../../docs/desktop/app-state.md) — first-launch / launch-count / crash-sentinel flags
- [deep-link](../../docs/desktop/deep-link.md) — cross-platform deep links, single-instance, pattern routing, built-in routes
- [auth](../../docs/desktop/auth.md): `omega.auth`, Firebase auth state synchronized across main + every renderer
- [auto-updater](../../docs/desktop/auto-updater.md) — startup + periodic checks, 30-day max-age gate, dev simulation
- [analytics](../../docs/desktop/analytics.md) — GA4 Measurement Protocol with cross-platform `uuidv5` identity (same human → same `user_id` across desktop/web/backend)
- [context](../../docs/desktop/context.md) — runtime info block (geolocation, client, session, app) — @omega.js/backend-shaped
- [usage](../../docs/desktop/usage.md) — opens / hoursTotal / hoursThisSession; clean-exit accumulation
- [remote-config](../../docs/desktop/remote-config.md) — "hot config" fetched from brand site for runtime flag flips without re-releases
- [restart-manager](../../docs/desktop/restart-manager.md) — auxiliary helper app for relaunches; auto-installs via signed mac.zip / NSIS exe / browser-opened .deb
- [config-schema](../../docs/desktop/config-schema.md) — canonical schema + validator for `config/omega.json5`. Hard-fails boot AND `gulp audit` on missing required fields, regex mismatches, enum violations, type mismatches. Single source of truth in the bundled `@omega.js/config`
- [templating](../../docs/desktop/templating.md) — `{{ var }}` token replacement, page template, body-only views
- [themes](../../docs/desktop/themes.md): classy + bootstrap themes, `@use 'omega-desktop' as * with (...)` overrides, per-page CSS bundles, system-aware appearance (`omega.theme`)
- [sentry](../../docs/desktop/sentry.md) — error/crash reporting, dev-mode gating, auto auth attribution, release tagging
- [hooks](../../docs/desktop/hooks.md) — lifecycle hooks (build/pre, build/post, release/pre, release/post, notarize)
- [installer-options](../../docs/desktop/installer-options.md) — installer/distribution config: NSIS one-click defaults, ia32 inclusion, app.category mapping, `{YEAR}` copyright token, snap publishing (default-on, named `brand.id`, a Linux package or release refuses without its key, `false` drops it), MAS roadmap
- [signing](../../docs/desktop/signing.md) — macOS + Windows code signing reference, cert files, env vars
- [releasing](../../docs/desktop/releasing.md) — end-to-end release walkthrough (`.env` → GitHub Release)
- [runner](../../docs/desktop/runner.md) — Windows EV-token signing runner — `npx omega runner start`, which onboards new GH orgs, `npx omega runner monitor` for a live signing event tail
- [test-framework](../../docs/desktop/test-framework.md) — writing tests, running them, layers
- [test-boot-layer](../../docs/desktop/test-boot-layer.md) — boot test layer (spawns the consumer's actual built bundle for end-to-end smoke tests)
- [build-system](../../docs/desktop/build-system.md) — gulp, esbuild, electron-builder pipeline

## Status

Active development on `v1`.

## License

[Elastic License 2.0](LICENSE). The source is free to use and modify; a license key unlocks payments in production deploys and removes the attribution (local dev and test payments are always free); and you may not offer `@omega.js/desktop` to third parties as a hosted or managed service.
