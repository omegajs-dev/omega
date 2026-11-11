# Build System

@omega.js/extension uses **gulp + esbuild + sass + custom HTML templating + an electron-builder-style packaging step** to compile extension source into a Chrome-loadable, multi-browser-ready build.

## Pipeline overview

`src/` (consumer authored) → `dist/` (intermediate) → `packaged/<browser>/raw/` (Chrome-loadable) → `packaged/<browser>/<name>.zip` (store upload).

```
src/
├── manifest.json                            # JSON5 source — comments, single quotes OK
├── views/<component>/index.html             # HTML templates
├── _locales/en/messages.json                # i18n catalog source
├── assets/
│   ├── js/components/<component>/index.js   # entry points (esbuild bundles these)
│   ├── css/main.scss + components/          # SCSS
│   └── images/icon.png                      # source icon (1024×1024)
└── ...
        ↓ gulp build (OMEGA_BUILD_MODE=true)
dist/
├── manifest.json                            # still JSON5 — used by serve, not Chrome
├── views/<component>/index.html             # templated
├── assets/
│   ├── js/components/<component>.bundle.js  # esbuild output
│   ├── css/components/<component>.bundle.css # sass output
│   └── images/                              # icons (multiple sizes)
└── _locales/<lang>/messages.json            # auto-translated (see docs/extension/translations.md)
        ↓ packaging step
packaged/
├── chrome/
│   ├── raw/                                 # strict-JSON manifest, Chrome-loadable
│   │   ├── manifest.json                    # comments stripped, valid JSON
│   │   └── ...                              # everything from dist/
│   └── <ExtensionName>.zip                  # store upload
└── firefox/raw/ + .zip
```

## Gulp tasks

Auto-loaded from [src/gulp/tasks/](../../packages/extension/src/gulp/tasks/) via [src/gulp/main.js](../../packages/extension/src/gulp/main.js).

| Task | Source | Purpose |
|---|---|---|
| `defaults` | [tasks/defaults.js](../../packages/extension/src/gulp/tasks/defaults.js) | Copy framework defaults from `dist/defaults/` to consumer project on first run / setup. See [defaults.md](defaults.md). |
| `distribute` | [tasks/distribute.js](../../packages/extension/src/gulp/tasks/distribute.js) | Copy consumer's `src/` files (HTML, manifest, locales, **static images**, etc.) to `dist/` |
| `sass` | [tasks/sass.js](../../packages/extension/src/gulp/tasks/sass.js) | Compile SCSS → CSS bundles with the load-path system (see [css.md](css.md)) |
| `bundle` | [tasks/bundle.js](../../packages/extension/src/gulp/tasks/bundle.js) | Bundle JS per component entry point with esbuild |
| `html` | [tasks/html.js](../../packages/extension/src/gulp/tasks/html.js) | Run views through the two-step templating system (see [templating.md](templating.md)) |
| `icons` | [tasks/icons.js](../../packages/extension/src/gulp/tasks/icons.js) | Generate icon variants from `src/assets/images/icon.png` |
| `translate` | [tasks/translate.js](../../packages/extension/src/gulp/tasks/translate.js) | Auto-translate `config/messages.json` and `config/description.md` to the configured `translation.languages`; cache-only on a CI runner or with `omega build --cached-only`, which the build verb hands to gulp as `--cached-only` (see [translations.md](translations.md)) |
| `package` | [tasks/package.js](../../packages/extension/src/gulp/tasks/package.js) | Bundle dist/ into packaged/<browser>/raw + zip; runs `build:pre` / `build:post` hooks ([hooks.md](hooks.md)) |
| `serve` | [tasks/serve.js](../../packages/extension/src/gulp/tasks/serve.js) | Dev server: WebSocket-based live reload, watches `src/` |
| `audit` | [tasks/audit.js](../../packages/extension/src/gulp/tasks/audit.js) | Build-pipeline-specific checks (icons exist, manifest is valid, etc.) |

### Static assets

`distribute` copies everything under `src/` EXCEPT what another task owns: `.js` (bundle), `.css/.scss/.sass` (sass), and `src/views/**/*.html` (the html task). Static images (`.png`, `.jpg`, `.svg`, `.webp`, …) copy as-is, byte-for-byte — this framework ships no imagemin task, so nothing else would carry them to `dist/` ([#259](https://github.com/Omega-JS-Stack/omega/issues/259)). Consumers never need a `hooks/build/pre.js` copy step for images.

## Bundling

[src/gulp/tasks/bundle.js](../../packages/extension/src/gulp/tasks/bundle.js) discovers component entry points (`src/assets/js/components/<name>/index.js`) and bundles each to `dist/assets/js/components/<name>.bundle.js`.

The bundler is esbuild through @omega.js/devkit's ONE `bundle()` wrapper ([#738](https://github.com/Omega-JS-Stack/omega/issues/738) — webpack, `babel-loader` and `@babel/preset-env` left with it, and the gulp task, the file and the log tag were renamed off `webpack` at the same time). The wrapper supplies what every framework shares: the framework-deps resolve hook ([#87](https://github.com/Omega-JS-Stack/omega/issues/87)), the production `@dev-only` strip ([#18](https://github.com/Omega-JS-Stack/omega/issues/18)), minify by mode with a source map in every mode, and one timing line per build.

### One call, every lane

Background service worker, content scripts, popup / options / sidepanel / pages all take the same options: `format: 'iife'`, `platform: 'browser'`, no code splitting. webpack needed three configs precisely to switch splitting OFF per lane (MV3's CSP lets neither a service worker nor a content script fetch a chunk); esbuild's iife format has no splitting at all, so each bundle is one self-contained file. No bundle carries a config copy any more (#743): the snapshot is the one `build.js` the pages and the service worker load, so a content script (which loads neither) never publishes the config onto a host page, `world: 'MAIN'` included.

### Syntax floor — the manifest answers it

esbuild's `target` replaces preset-env's browserslist guess, and it is READ from the manifest rather than hardcoded: `minimum_chrome_version` and `browser_specific_settings.gecko.strict_min_version` are where a project already declares which browsers it supports, so raising either moves the bundler with it. Undeclared, each side falls back to its MV3 minimum — Chrome 88 (where MV3 shipped) and Firefox 91 (the `strict_min_version` the framework's default manifest ships) — which is the `chrome88, firefox91` a scaffolded project compiles to. esbuild compiles SYNTAX to that floor and never polyfills a runtime API.

### Node built-ins

Browser bundles answer `fs` / `path` / `crypto` / `os` / `util` / `assert` / `stream` / `buffer` / `process` with an empty module (@omega.js/devkit's `emptyModulesPlugin`, the esbuild answer to webpack's `resolve.fallback`): libraries bundled through @omega.js/client import them on code paths their browser builds never take.

### The build snapshot: `OMEGA_BUILD_JSON`, one `build.js`

The snapshot is ONE file at the artifact's root. `bundle.js` composes it once per build (`composeBuildJson()`) and writes `dist/build.js` through `@omega.js/devkit/build-json`, the same writer web and @omega.js/desktop use ([#743](https://github.com/Omega-JS-Stack/omega/issues/743)); `package.js` copies it into every `packaged/<browser>/raw/` with the rest of `dist`. Two plain statements, `self.OMEGA_BUILD_JSON = {…};` and `self.OMEGA_BUILD_JSON.config.dev = {…}|null;`, and two consumers:

- **every page context** loads it with `<script src="/build.js">`, the page template's FIRST script, ahead of the page's own bundle, and reads `window.OMEGA_BUILD_JSON`.
- **the service worker** loads it with `importScripts('/build.js')` on `background.js`'s first line (the manifest declares a classic service worker, so importScripts is legal) and reads `self.OMEGA_BUILD_JSON`.

An extension's own pages fetch their own origin, so no `web_accessible_resources` entry is needed for either.

What it holds is the ONE wrapper every OMEGA browser surface bakes ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)), desktop's names: `{ config, package, mode, license, builtAt }`. `package` is the project's own manifest, `mode` the build's verdict (`{ build, publish, environment }`), `license` the license check's answer and `builtAt` the stamp, all facts about the BUILD, never inside `config`.

`config` is `clientConfig(resolved)` from `@omega.js/config` ([docs/shared/config.md](../shared/config.md) → "The browser subset"): the sections the schema's per-section `client` flag marks browser-visible (brand, cloud's public half, theme, analytics, advertising, company, listings, …) plus this build's facts (`runtime`, `environment`, `version`, `buildTime`, `target`, and in non-production builds the resolved `dev` map, `ports` / `origin` / `liveReloadPort`, the only channel a browser context has to a bumped local stack). The legacy `omega` block is gone ([#896](https://github.com/Omega-JS-Stack/omega/issues/896)): its three readers take `config.environment`, `config.buildTime` and `config.dev.liveReloadPort`. The hand-written allow list this task used to keep is gone: what goes public is one schema row, shared with web and desktop. The Measurement Protocol secret (`GOOGLE_ANALYTICS_SECRET`) is added to `analytics.providers.google.secret` AFTER that gate, the one `.env` value sanctioned into the artifact (`publicAtRest`) and the one the gate itself would refuse.

Between #743's first pass and its rework the blob rode INSIDE every bundle (an esbuild `define` plus a banner), which put one config into 21 files; that is retired, and so is the `build.json` sidecar nothing read. Inspecting a built artifact means running its `build.js` the way a browser does (`src/gulp/tasks/utils/build-json.js` `readBakedBuildJson()`).

### Template replacement

A post-emit pass over the bundles replaces these markers at build time:
- `%%% version %%%` → `package.json#version`
- `%%% brand.name %%%` → config brand name
- `%%% brand.url %%%` → config brand URL
- `%%% environment %%%` → `'production'` or `'development'`
- `%%% liveReloadPort %%%` → WebSocket port (35729 default)

A key nothing answers is left INTACT rather than emptied, so unrelated `%%%` text in consumer code survives. The pass runs over the EMITTED files (not the sources) because the tokens reach the bundle from vendored and `@omega.js/client` code too, which a source-level hook would never see; the one cost is that in a DEV build a line carrying a replaced token has shifted source-map columns after the token — production builds ship no maps at all.

### Dev-only blocks

Production bundles drop everything between `/* @dev-only:start */` and `/* @dev-only:end */`. The markers and the cut live in ONE home (`@omega.js/devkit/strip-dev-blocks`) and the wrapper registers the esbuild plugin for production builds only; dev builds keep the blocks. "Production" here is `build.actLikeProduction()`, so an `OMEGA_AUDIT_FORCE=true` audit run strips too: it inspects the artifact a release would ship.

### Aliases

esbuild `alias` in bundle.js:
```js
alias: {
  '__main_assets__':    '<framework>/dist/assets',
  '__project_assets__': '<project>/src/assets',
  '__theme__':          '<framework>/dist/assets/themes/<active-theme>',
}
```

## Sass

[src/gulp/tasks/sass.js](../../packages/extension/src/gulp/tasks/sass.js) compiles per-component SCSS bundles. Load-path resolution lets consumer SCSS `@use 'omega-extension'`, `@use 'theme'`, and `@use 'components/popup'` resolve through a search chain. Full details in [css.md](css.md).

## HTML templating

Views in `src/views/<component>/index.html` go through two passes of `{{ }}` token replacement. See [templating.md](templating.md).

## Packaging

[tasks/package.js](../../packages/extension/src/gulp/tasks/package.js):

1. **Pre-hook** — runs `hooks/build/pre.js` if present (the flat `hooks/build:pre.js` still resolves as a transition fallback)
2. **Per-browser manifest normalization** — converts JSON5 → strict JSON for Chrome/Edge/Opera (Firefox tolerates JSON5 but normalized anyway)
3. **Per-browser asset copy** to `packaged/<browser>/raw/`: `dist/build.js` rides along with everything else, so the package lane composes no snapshot of its own and writes no `build.json` sidecar ([#743](https://github.com/Omega-JS-Stack/omega/issues/743)). Source maps stay behind ([#1064](https://github.com/Omega-JS-Stack/omega/issues/1064)): every bundle's `.map` sits beside it in `dist` for local reading, and the raw copy drops `**/*.map`, because a map carries the remote-script URLs the redaction strips from the `.js` and its positions predate the post-build rewrites
4. **Zip** to `packaged/<browser>/<name>.zip`
5. **Post-hook** — runs `hooks/build/post.js`
6. **Auto-publish** (if `OMEGA_IS_PUBLISH=true`) — uploads to Chrome Web Store / Firefox Add-ons / Edge Add-ons stores. See [publishing.md](publishing.md).

### Manifest compilation rules

The compiled manifest is the source manifest merged with the framework defaults ([src/config/manifest.json](../../packages/extension/src/config/manifest.json)), then adjusted per target:

- **Config tokens resolve first.** Every string in `src/manifest.json` renders the same `{{ }}` syntax a view speaks ([templating.md](templating.md)), against the whole resolved `config/omega.json5` (a view sees only its page variables): `matches: ['{{ brand.url }}/*']` follows `brand.url` instead of pinning a literal host that drifts when the config moves ([#958](https://github.com/Omega-JS-Stack/omega/issues/958)). A token nothing resolves fails the build naming it, since a literal token in a match pattern is a manifest Chrome refuses to load.
- **Match patterns are checked next.** Every string under `content_scripts[].matches`, `content_scripts[].exclude_matches`, `host_permissions`, `optional_host_permissions` and `web_accessible_resources[].matches` must be `<all_urls>` or `<scheme>://<host><path>`: scheme `*`, `http`, `https`, `ws`, `wss`, `ftp` or `file` (`file` takes an empty host, `file:///*`), host `*`, `*.<name>` or `<name>`, an optional port (`:8080` or `:*`), and a path starting `/`. Any other stops the build naming each one (`src/manifest.json carries illegal match pattern(s): ...`) and writes no manifest ([#957](https://github.com/Omega-JS-Stack/omega/issues/957)).
- **Declared beats default.** The defaults only fill keys your `src/manifest.json` never wrote — including arrays. An array you declare REPLACES the default (an empty array ships nothing), which is the only way to drop a framework default such as `externally_connectable`'s dev origin from a production build ([#260](https://github.com/Omega-JS-Stack/omega/issues/260)).
- **`externally_connectable` defaults to your BRAND origin.** The default `matches` is `<brand.url origin>/*`, plus the resolved dev-website origin in a dev build only. A packaged build used to ship the localhost dev origin alone, so the live brand site could not message the published extension ([#583](https://github.com/Omega-JS-Stack/omega/issues/583)). With no `brand.url`, a build-mode build declares no origin and says so. The scaffolded boot test `test/boot/externally-connectable.test.js` asserts the brand origin against the real packaged manifest.
- **`homepage_url` is baked from `brand.url`** on every target — the store listing's developer-site link, which nothing emitted before ([#576](https://github.com/Omega-JS-Stack/omega/issues/576)). A value you declare wins; with no `brand.url` the key ships absent.
- **Icons are pruned to what the build minted** — a manifest pointing at an icon that isn't there is an extension Chrome refuses to load.
- **chrome**: `background.scripts` dropped (MV3 service worker). Edge and every other Chromium browser installs this build.
- **firefox**: `background.service_worker` becomes `background.scripts`; `side_panel` becomes `sidebar_action` (Firefox has no side panel key), and every Chrome-only permission Firefox rejects at install (`sidePanel`, `offscreen`: one list in the package task) is dropped ([#957](https://github.com/Omega-JS-Stack/omega/issues/957)); `browser_specific_settings.gecko.id` is DERIVED when you declare none: `extension@<brand.url host>`, or `extension@<brand.id>.extension` with no url, and packaging fails only when there are no brand facts at all to derive from ([#264](https://github.com/Omega-JS-Stack/omega/issues/264)). Firefox cannot identify, sign, or update an add-on without an id, so a fresh scaffold builds out of the box, but **declare your own id before the first publish** ([#574](https://github.com/Omega-JS-Stack/omega/issues/574)): it must stay stable across every release, and `brand.url` can change.

## Build modes

Env vars that drive the pipeline:

- `OMEGA_BUILD_MODE=true`: production build (minified, dev-blocks stripped; source maps beside the bundles in `dist`, as in every mode)
- `OMEGA_IS_PUBLISH=true` — also publish to extension stores after packaging
- `OMEGA_LIVERELOAD_PORT=35729` — WebSocket port for `serve` task (override if 35729 collides)
- `OMEGA_LOG_FILE` — override the stdout/stderr tee path, or set to `false` to disable it (see [Log files](#log-files)).

## Live reload

`npm start` (= `gulp` with no args, by default invokes `serve`) watches `src/` and recompiles on change. A WebSocket server on `OMEGA_LIVERELOAD_PORT` (35729) notifies the extension's contexts. Background SW reloads itself via `chrome.runtime.reload()`; other contexts reload via `window.location.reload()`.

## Log files

The gulp pipeline tees all output to `logs/dev.log` (`npm start`) / `logs/build.log` (`npm run build`), and `npx omega test` tees to `logs/test.log`. Full reference — file table, capture behavior, `OMEGA_LOG_FILE` controls: [logging.md](logging.md).

## Output for Chrome's "Load unpacked"

Point Chrome at `packaged/chrome/raw/`: that's the strict-JSON, fully-assembled Chrome-loadable build. NOT `dist/` (which has JSON5 manifest mid-pipeline). The test framework's boot layer auto-targets `packaged/chrome/raw/` for the same reason, see [test-boot-layer.md](test-boot-layer.md).

## See also

- [components.md](components.md) — the seven component contexts
- [templating.md](templating.md) — `{{ }}` token replacement
- [css.md](css.md) — SCSS load paths
- [defaults.md](defaults.md) — `src/defaults/` template system
- [hooks.md](hooks.md) — `build:pre` / `build:post`
- [translations.md](translations.md) — auto-translate `_locales/`
- [publishing.md](publishing.md) — store auto-publishing
- [test-boot-layer.md](test-boot-layer.md) — verify the packaged extension actually boots in Chromium
