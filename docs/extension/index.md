# OMEGA Extension (@omega.js/extension)

> **Note for contributors and Claude:** This file is the guide for `@omega.js/extension` — identity, top-level conventions, and a map to the deep references. It lives in the monorepo's `docs/` tree and is loaded on demand (the omega Claude plugin's hooks inject it by context; the map, `docs/omega.md`, is what every AGENTS.md imports, and only the manager ships the docs). The **meat** (per-subsystem APIs, edge cases, behavior tables, defaults lists) lives in the `docs/extension/<topic>.md` files beside this guide. When extending or adding content, write it in the matching `docs/extension/*.md` file and cross-link from here — do NOT inline it. If a topic doesn't have a doc yet, create one.

> **Mirrored structure:** the four framework guides (`docs/web/index.md`, `docs/backend/index.md`, `docs/extension/index.md`, and `docs/desktop/index.md`) mirror each other: shared sections (Supply-Chain Security, Development Workflow, File Conventions, Doc-update parity, etc.) appear in the **same order at the same position** across all four. When adding a section that applies to multiple frameworks, insert it in the same spot in all of them.

## Identity

OMEGA Extension (@omega.js/extension) is a comprehensive framework for building modern cross-browser extensions (Chrome, Firefox, Edge, Opera, Brave), the extension of the OMEGA family beside @omega.js/web, @omega.js/desktop and @omega.js/backend. Each context module's default export is ONE ready-made instance, `omega`. It provides one-line-import bootstrap per extension context, a component-based architecture, a multi-browser build/release pipeline, config-driven auto-translation (`translation.languages`), cross-context auth synchronization, and a built-in four-layer test framework.

## Recommended skills

- **`omega:extension`** — the router skill from the omega Claude plugin. The inject hook loads it automatically in any project with `@omega.js/extension` (and inside `packages/extension` here); it points back to this guide + `docs/` (the SSOT).
- **`js:patterns`** — JavaScript/Node.js conventions: file structure, JSDoc, defensive coding (`?.` usage), template literals, `package.json` conventions. Auto-loads when creating new `.js` files or touching JS module structure.

## 🚨 READ @omega.js/client TOO

**@omega.js/extension's page contexts extend `@omega.js/client`'s base class**: the popup, options, sidepanel and page instances carry the client's modules (`omega.auth`, `omega.storage`, `omega.bindings`, `omega.firestore`, ...) as properties, and background carries its own `omega.auth`. The client powers auth, Firebase, reactive `data-omega-bind` directives, analytics, error tracking, and utilities (`escapeHTML`, etc.). Any task that touches auth flows, Firestore reads/writes, subscription resolution, push notifications, or DOM bindings means you are working with @omega.js/client as much as with @omega.js/extension.

**Required reading:**
- **`docs/client/index.md`** (in the framework monorepo) — the client guide: identity, module list, conventions
- **`node_modules/@omega.js/manager/docs/client/`** — module deep references (Auth, Bindings, Firestore, Notifications, etc.)

## Quick Start

### For Consuming Projects

1. `@omega.js/extension` is the extension target's devDependency (onboard declares it in `targets/<name>/package.json`); `npm install` at the brand root installs it. Every verb below runs at the brand root with `--target=<name>` naming the extension target, and inside `targets/<name>/` the same verbs run in place (`npm start`, `npm test`, `npx omega build`) while a brand-wide verb refuses and prints the root form ([docs/manager/brand.md](../manager/brand.md) § Verbs); a standalone project is its own root, where the same verbs run bare and as its `npm start` / `npm run <script>` package scripts
2. There is no setup step ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)). The project scaffolds itself on the first verb below — `ensureTarget()` copies `src/defaults/` into the project (`src/manifest.json`, `src/views/`, `src/assets/`, `config/omega.json5`, etc.), syncs the project scripts, and checks Node + peer deps, idempotently and silently once the target is converged.
3. `npx omega dev --target=<name>`: the dev loop, what the target's `start` script (`omega dev`) runs: clean, then the gulp default task (serve with live reload, then the watched build). The `--` flags it is given ride to the gulp lane (`npm start -- --debug`)
4. `npx omega build --target=<name>`: production build (compiles `dist/`, packages per-browser into `packaged/<browser>/raw/` + `.zip`); the target's `build` script is a thin alias of the verb, which owns the pipeline
5. `OMEGA_IS_PUBLISH=true npx omega build --target=<name>`: also uploads to Chrome / Firefox / Edge stores (see [docs/shared/publishing.md](publishing.md))
6. `npx omega test --target=<name>`: runs the project's test suites (bare consumer runs never include the framework corpus)
   - `npx omega test --target=<name> build/config`: bare path: run project tests matching a path
   - `npx omega test --target=<name> framework:` / `npx omega test --target=<name> full:`: reach the framework suite (alone, or both sources)
   - `npx omega test --target=<name> mgr:`: run ONLY framework tests (`mgr:` is the universal cross-framework alias; `extension:` / `framework:` are equivalent)
   - `npx omega test --target=<name> extension:build/config`: run only framework tests matching a path
   - The positional target selects which test FILES run (by source + path); `--filter=<substring>` is orthogonal — it matches test NAMES within them
   - Output is teed (ANSI-stripped) to `<projectRoot>/logs/test.log`, truncated fresh each run — `cat logs/test.log` instead of scrolling scrollback
   - Extended mode (off by default): `npx omega test --target=<name> --extended` or `TEST_EXTENDED_MODE=true npx omega test --target=<name>` opts into tests that hit REAL external services (Firebase via @omega.js/client, push, network). `TEST_EXTENDED_MODE` is the shared, unprefixed name across all OMEGA frameworks; it propagates to every spawned test environment

To load the unpacked extension in Chrome: point chrome://extensions → "Load unpacked" at `packaged/chrome/raw/`.

### For Framework Development (This Repository)

> **🚫 NEVER use `npx omega ...` from the framework repo.** `npx omega` is for CONSUMER projects only (where the bin is linked in `node_modules/.bin/`). From the framework repo, use `npm test`, `npm start`, etc. — the `scripts` in `package.json` call the local `bin/` directly. This applies to ALL four OMEGA frameworks.

1. `npm install`
2. `npm start` — watch + compile `src/` → `dist/` via prepare-package
3. Test in the **designated test consumer**: [`brands/playground-omega/targets/extension`](../../brands/playground-omega/targets/extension), the extension target of the standing in-repo test brand, is @omega.js/extension's consumer for validating framework changes end-to-end ([docs/shared/brands.md](../shared/brands.md)). Its `@omega.js/extension` spec is a `file:` path into this monorepo, so it runs this working tree's build with no linking step (the root `npm start` keeps that build current). Run its verbs at the brand root: `cd brands/playground-omega && npx omega test --target=extension`.
4. `npm test` — runs the framework's own suites

## Architecture

### The consumer entry

Each extension context's module exports ONE ready-made instance, `omega`; the class is exported by name (`Omega`) for tests only, and a consumer never writes `new`. Seven contexts, one shape; see [docs/extension/contexts.md](contexts.md):

```js
// src/assets/js/components/popup/index.js
import omega from '@omega.js/extension/popup';
await omega.initialize();

// src/assets/js/components/background/index.js  (service worker)
import omega from '@omega.js/extension/background';
await omega.initialize();

// Same shape for options / sidepanel / page / content / offscreen
```

`initialize()` returns the instance, and `omega.ready` is the same promise, so a module that did not call it can still await it.

The package root, `require('@omega.js/extension')`, is the build-time entry and never a context: `{ version, build }`, the package version and the build module (`@omega.js/extension/build`). `@omega.js/extension/test` is the public test API, `{ defineCases, expect }`: `defineCases` wraps every consumer case file's spec, and `expect` is the same assertion library every suite gets as `ctx.expect` ([docs/extension/test-framework.md](test-framework.md)).

### The instance (`omega`)

Every context's `omega` carries the same core:
- `omega.context`: the context name (`background`, `popup`, `options`, `sidepanel`, `page`, `content`, `offscreen`)
- `omega.extension`: cross-browser `chrome.*` / `browser.*` API wrapper ([docs/extension/extension.md](extension.md))
- `omega.logger`: per-context logger stamping the ONE identity tag, `[@omega.js/extension:<context>]`, with NO timestamp (devtools stamps runtime lines; only the build-time devkit logger prefixes `[HH:MM:SS]`)
- `omega.messenger`: the one lane between contexts, `send({ destination, command, payload })` and `onMessage(handler)` (returns the unsubscribe)
- `omega.config` (the `OMEGA_BUILD_JSON.config` snapshot), `omega.version`, `omega.getApiUrl()`
- `omega.getEnvironment()` / `isDevelopment()` / `isProduction()` / `isTesting()`: cross-context helpers ([docs/extension/environment-detection.md](environment-detection.md))

**The local port chain** (env, then the baked `dev.ports`, then a loud miss, and the host each local URL carries) has one home, `@omega.js/client/modules/dev-ports.js`: [docs/shared/config.md § Port auto-allocation](../shared/config.md#port-auto-allocation-n7).

The four page contexts (popup, options, sidepanel, page) are ONE subclass of `@omega.js/client`'s base class, told apart by the context name, so they also carry `omega.auth`, `omega.storage`, `omega.bindings`, `omega.firestore`, `omega.analytics`, `omega.utilities` and the rest of the client ([client guide](../client/index.md)). `omega.auth.user` is always a `User`, and `omega.auth.openPage()` opens the brand site's sign-in page in a new tab. Background carries its own `omega.auth`, desktop main's `omega.auth` shape (its Firebase app, `.user`, `.listen()`, `.signOut()`, and `.getIdToken()`, the session's fresh ID token or `null` signed out), and `omega.request()`, the page contexts' API fetch on background's own session; content and offscreen have no auth.

### Component architecture

Extensions are organized around **components** — each a browser-extension context bundling a view, styles, and a script. Seven contexts × three parts each:

| Component | Runs in | When |
|---|---|---|
| `background` | MV3 service worker | Always — source of truth for auth + messaging |
| `popup` | Browser-action popup | When the user clicks the toolbar button |
| `options` | Standalone tab | When the user opens settings |
| `sidepanel` | Chrome side panel (114+) | When the user opens the side panel |
| `content` | Each visited web page | Injected by manifest `content_scripts` |
| `pages` | Custom extension page (dashboard, welcome) | Routed via `chrome.tabs.create` |
| `offscreen` | Offscreen document (Chrome 109+) | For WebSocket, DOM parsing, long-running SW-adjacent tasks |

Each component has three parts at conventional paths:
- View: `src/views/<component>/index.html`
- Styles: `src/assets/css/components/<component>/index.scss`
- Script: `src/assets/js/components/<component>/index.js`

On web a page is a file under `src/pages/` and on backend a route is a file under `src/routes/`, so dropping the file is the whole declaration. An extension view folder under `src/views/` is built, but nothing opens it until `src/manifest.json` (popup, options, side panel) or a runtime call (`tabs.create` for a page, `offscreen.createDocument`) names it, because an MV3 surface is a manifest entry or a call, never a bare file, and nothing auto-registers a view.

Compiled output: `dist/views/<component>/index.html`, `dist/assets/css/components/<component>.bundle.css`, `dist/assets/js/components/<component>.bundle.js`. See [docs/extension/components.md](components.md).

### Cross-context auth sync

Background's `omega.auth` is the source of truth for authentication. The page contexts compare their UID with background's on load and sync up, pushing their account document so background's `omega.auth.user` is the same `User`. Sign-ins and sign-outs broadcast across all open contexts over `omega.messenger`, the one lane between contexts. No `chrome.storage` involved; Firebase persists per-context sessions in IndexedDB.

Four flows: sign-in (website `/token` redirect → broadcast), worker boot (background restores its persisted session and account before it answers any message), context-load (`omega:syncAuth`, the catch-up path), sign-out (`omega:signOut` broadcast). Auth-button CSS classes (`.omega-signin`, `.omega-signout`, `.omega-account`) wire UI without writing JS: they are click triggers on @omega.js/client's shared registry ([client guide](../client/index.md#click-triggers-modulestriggersjs)), with the extension registering `omega-signin` and `omega-account` itself. @omega.js/client reactive bindings (`data-omega-bind="@show auth.user.authenticated"`) handle DOM state.

Required setup: `brand.url` in config (background.js watches that host for the /token redirect), `tabs` permission in manifest. See [docs/extension/auth.md](auth.md).

### Build system

`src/` (consumer) → `dist/` (intermediate, JSON5 manifest) → `packaged/<browser>/raw/` (strict-JSON manifest, Chrome-loadable) → `packaged/<browser>/<name>.zip` (store upload). There are TWO builds, `chrome` and `firefox` ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)): `edge` publishes the chrome artifact, and every other Chromium browser installs it. What the extension SHIPS is one declaration, `platforms.<chrome|firefox|edge>.formats.<zip|store>`, the SAME shape the desktop target carries: presence = enabled, both formats default on, `false` drops one.

- **Gulp** auto-loads tasks from `src/gulp/tasks/` via `src/gulp/main.js`. Tasks: `defaults`, `distribute`, `sass`, `bundle`, `html`, `icons`, `translate`, `package`, `serve`, `audit`.
- **esbuild** — bundles each `src/assets/js/components/<name>/index.js` to `dist/assets/js/components/<name>.bundle.js`. The bundler is @omega.js/devkit's ONE `bundle()` wrapper since [#738](https://github.com/Omega-JS-Stack/omega/issues/738) — webpack, babel-loader and `@babel/preset-env` are gone, and the task went with the name: `src/gulp/tasks/bundle.js`, gulp task `bundle`, log tag `[@omega.js/extension:bundle]`. ONE call covers every lane (`iife`, no code splitting anywhere, which is what MV3's CSP requires of a service worker and a content script alike), and esbuild's `target` IS the syntax floor, READ from the manifest (`minimum_chrome_version`, `browser_specific_settings.gecko.strict_min_version`) with the MV3 minimums — chrome88, firefox91 — as the fallback. Custom `__theme__` / `__main_assets__` / `__project_assets__` aliases resolve to the active theme and the vendored assets. A post-emit pass substitutes `%%% version %%%` / `%%% brand.name %%%` / etc.
- **The build snapshot is ONE file.** `bundle.js` composes `OMEGA_BUILD_JSON` once per build and writes it to `dist/build.js` through `@omega.js/devkit/build-json` ([#743](https://github.com/Omega-JS-Stack/omega/issues/743)); `package.js` copies it into every `packaged/<browser>/raw/` with the rest of `dist`. The page template loads it with `<script src="/build.js">` as its first script, and `background.js` with `importScripts('/build.js')` on its first line (the manifest declares a CLASSIC service worker, so importScripts is legal; an extension's own pages need no `web_accessible_resources` entry to fetch their own origin). No bundle carries a copy: the `define` + `banner` bake that put one config into 21 files is retired, and so is the `build.json` sidecar nothing read. The same file and the same load order web and @omega.js/desktop use.
- **The wrapper and the subset are @omega.js/config's, not this framework's** ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)). The wrapper is the ONE shape every OMEGA browser surface bakes, `{ config, package, mode, license, builtAt }`, and `config` is `clientConfig(resolved)`: the sections the schema's `client` flag marks browser-visible plus this build's facts (`runtime`, `environment`, `version`, `buildTime`, `target`, `dev`). The legacy `omega` block is gone ([#896](https://github.com/Omega-JS-Stack/omega/issues/896)): the service worker reads `config.environment`, `config.buildTime` (its cache breaker) and `config.dev.liveReloadPort`, the names every OMEGA surface spells. The hand-written allow list this task used to keep is gone, so a store artifact can no longer carry a brand's provisioning sections and a new public value is one schema row instead of three lists. The Measurement Protocol secret is the one `.env` value sanctioned into the artifact (`publicAtRest`) and is added AFTER that gate, which refuses secret-shaped keys outright. Every context hands the blob to `@omega.js/client` the same way: `const configuration = window.OMEGA_BUILD_JSON?.config;`.
- **Sass** — load-path resolution lets consumer SCSS `@use 'omega-extension'` / `@use 'theme'` / `@use 'components/popup'` without long relative paths. See [docs/extension/css.md](css.md).
- **HTML templating** — two-pass `{{ }}` replacement: view first, then outer page-template. Vars: `brand.name`, `brand.url`, `page.title`, `theme.appearance`, `version`, `cacheBust`. See [docs/extension/templating.md](templating.md).
- **Packaging** ([gulp/package.js](../../packages/extension/src/gulp/tasks/package.js)): per-browser manifest normalization (JSON5 → strict JSON), zip, optional auto-publish. The bundles arrive with the snapshot already baked in, so the package lane writes no config file of its own. A DECLARED consumer value beats the framework default, arrays included: an empty array ships nothing, the only way to drop a default like `externally_connectable`'s dev origin ([#260](https://github.com/Omega-JS-Stack/omega/issues/260)). That default is now the BRAND's own origin (from `brand.url`), with the dev-website origin added in dev builds only: a packaged build shipped the localhost origin alone, so the live site could not message the published extension ([#583](https://github.com/Omega-JS-Stack/omega/issues/583)); the scaffolded `test/boot/externally-connectable.test.js` asserts it against the real packaged manifest. `homepage_url` bakes from `brand.url` on every target: the store listing's developer-site link ([#576](https://github.com/Omega-JS-Stack/omega/issues/576)). Every string in `src/manifest.json` renders the view `{{ }}` config tokens first, so `matches: ['{{ brand.url }}/*']` follows `brand.url`, and a token nothing resolves fails the build ([#958](https://github.com/Omega-JS-Stack/omega/issues/958)). The firefox target translates the chrome-only panel keys (`side_panel` → `sidebar_action`), drops every Chrome-only permission (`sidePanel`, `offscreen`) Firefox rejects at install ([#957](https://github.com/Omega-JS-Stack/omega/issues/957)), and writes `browser_specific_settings.gecko.id` from the ONE home of that id, `targets.<name>.listings.firefox.id` in config ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)): a manifest declaring a DIFFERENT id fails the package naming both, and a brand that declares neither still DERIVES one, `extension@<brand.url host>` falling back to `extension@<brand.id>.extension`, failing loudly only with no brand facts at all ([#264](https://github.com/Omega-JS-Stack/omega/issues/264)). The derived id is not left implicit: the LOCAL scaffold pins it into `config/omega.json5` as `listings.firefox.id` the first time a verb runs in the target, before any push ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)), because it must stay stable across releases and `brand.url` can change ([#574](https://github.com/Omega-JS-Stack/omega/issues/574)).

See [docs/extension/build-system.md](build-system.md).

### Build modes

- `OMEGA_BUILD_MODE=true`: production build (minified, dev-blocks stripped; source maps beside the bundles in `dist`, never in the package)
- `OMEGA_IS_PUBLISH=true`: also publish to Chrome / Firefox / Edge stores after packaging, then attach the per-browser zips to a GitHub release in the brand's ONE public releases repo (`<brand.id>-releases` under `repo.owner`, tag `<target name>-v<version>`, or `extension-v<version>` for the default target, [#883](https://github.com/Omega-JS-Stack/omega/issues/883)). The release is the publish TASK's own work, in node through the devkit `gh` wrapper, so a laptop publish and a CI publish upload the same assets to the same tag and no workflow YAML names a repo. Each store is addressed by the id in its own listing block, `targets.<name>.listings.{chrome,firefox,edge}.id` ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)): the id is public (it is in the listing URL), so it lives in config beside that listing's `url`, never in `.env`, and a lane whose credentials are set but whose id is not refuses naming the config path to paste it into. A FIRST Firefox publish (no `listings.firefox.id`) also writes `.temp/amo-metadata.json` and signs with `--amo-metadata` ([#884](https://github.com/Omega-JS-Stack/omega/issues/884)): addons.mozilla.org will not CREATE a listing without a summary, a category and a license, and the credentials-only call came back `Bad Request` after a green build. The summary is `brand.description` (cut to AMO's 250-character cap, with a warning), the categories are `targets.extension.categories` (AMO slugs, default `['alerts-updates']`, an unknown slug fails the build naming the live list), and the license is the target `package.json` `license` field: absent or `UNLICENSED` lists as `all-rights-reserved`, an SPDX id AMO accepts passes through, anything else fails loudly. Every UPDATE passes nothing, as before: AMO reuses the listing the first version made. AMO's add-on guid IS the manifest's gecko id, so the create is addressed by that id too (web-ext's sign has no `--id` option; it reads the packaged manifest). The publish itself writes NO config (#893): it runs on the runner's throwaway checkout of the mirror, where a write never reached the brand tree and every deploy created the add-on again. The id is the brand's own derived value and the LOCAL scaffold pins it into `config/omega.json5` as `listings.firefox.id`, through @omega.js/config's comment-preserving editor, printing the line it wrote: nothing is left for a consumer to remember, and the next publish reads it and updates

**Which stores a publish talks to is the DECLARATION, not a credential's presence** ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)). `platforms.<chrome|firefox|edge>.formats.store` is the switch, and each store's lane has exactly three outcomes, in the same words the desktop publish uses (both read devkit's `ship-plan`, which reads @omega.js/config's format table):

- **Keys present, listing addressable** (chrome and edge with `listings.<browser>.id` in config, firefox always, since AMO takes the manifest gecko id): published. A store that rejects the upload fails the publish, and its row in the store table printed at the end carries the reason, `Firefox Add-ons: ✗ Failed: <reason>`, as does the thrown `Publish failed for firefox: <reason>` ([#940](https://github.com/Omega-JS-Stack/omega/issues/940)). A store that already holds the version is a failure too, never a pass, and its reason names the fix (`version 0.0.4 already exists on Firefox Add-ons. Bump version in package.json and deploy again.`); any other rejection prints the store's own last line, web-ext's `WebExtError:` line rather than the npm warnings above it.
- **A declared store with a missing developer key**: the publish REFUSES, naming the key, the declaration that requires it (`platforms.edge.formats.store`), and the ONE walk that collects it, `omega manage --service publishing`. Nothing is uploaded to any store. Dropping the store (`platforms.edge.formats.store: false`) is how a brand says it does not ship there; a store that quietly fell off the run because a key was empty is what this replaced.
- **Keys present, no listing id yet**: ONE manual step prints (create the listing at the store's console, upload `extension-<build>.zip` from the release, set `targets.<name>.listings.<browser>.id`, re-run) and the run finishes green. The zips are already on the release by then: that upload runs FIRST, so the file a human uploads by hand is published no matter which stores went through.

- `OMEGA_LIVERELOAD_PORT=35729` — WebSocket port for `serve` task
- `OMEGA_LOG_FILE` — override the gulp stdout/stderr tee path, or `false` to disable it

### Themes

Two themes ship with @omega.js/extension: `bootstrap` (pure Bootstrap 5.3+) and `classy` (Bootstrap + custom design system). Plus `_template/` for new themes. Activate via `config.theme.id`; appearance via `config.theme.appearance` ('dark' / 'light'). Variables overridable from consumer SCSS via `@use 'omega-extension' as * with ($primary: …)`, and `$primary` itself arrives from `brand.color`: the sass task renders `dist/assets/css/_brand.scss` before every compile (`$primary` plus a `ramp` mixin of the runtime `--omega-accent` family), and the scaffold's `main.scss` reads both, `@use 'brand';` above the framework import and `@include brand.ramp;` below it. A deliberate divergence puts a literal back in place of `brand.$primary`. Same mechanism, same renderer, on @omega.js/desktop ([#912](https://github.com/Omega-JS-Stack/omega/issues/912), [shared/theming.md](../shared/theming.md)). `theme.id` is a SHARED config key while the theme SET is per-framework, so both resolve sites (sass load path, the bundler's `__theme__` alias) go through [src/lib/theme.js](../../packages/extension/src/lib/theme.js): an id this framework doesn't ship falls back to `classy` with one warning naming the key, the value, and the valid set; override per target with `targets.extension.theme.id` ([#261](https://github.com/Omega-JS-Stack/omega/issues/261)). See [docs/extension/themes.md](themes.md).

### Defaults system

`src/defaults/` is the starter template — copied to consumer projects by every verb's `ensureTarget()`. File behavior (overwrite/skip/template/rename) is controlled by `FILE_MAP` in [gulp/tasks/defaults.js](../../packages/extension/src/gulp/tasks/defaults.js). Most consumer files default to `overwrite: false` so user code is never clobbered. Inside a brand monorepo the map also skips `.github/**`: GitHub runs workflows from the REPO ROOT only, so the scaffold composes the target's CI into the brand root as `.github/workflows/<target>-publish.yml` — target-scoped, per-target concurrency, regenerated (never duplicated) on every verb, and `omega deploy` dispatches that composed name ([#265](https://github.com/Omega-JS-Stack/omega/issues/265)). See [docs/extension/defaults.md](defaults.md).

The workflow's `env:` carries `GOOGLE_ANALYTICS_SECRET` beside the seven store credentials (the three listing IDS left that block with #893: a public id rides the config snapshot, never a repo secret): a dispatched run has no `.env`, so the Measurement Protocol secret the build bakes into `OMEGA_BUILD_JSON` only reaches it from the repo secrets, and without it every CI-published extension shipped an empty secret and sent no events. A build-mode build of a brand with `analytics.providers.google.id` set now FAILS when the secret is empty ([#582](https://github.com/Omega-JS-Stack/omega/issues/582)).

### Auto-translation

`npm run build` invokes the `translate` gulp task: reads `config/messages.json`, sends only the strings missing from the committed `translations/<lang>/` cache to the provider, and composes `dist/_locales/<lang>/messages.json` per language in `translation.languages` (omega.json5; unset = off). Existing translations are preserved. See [docs/extension/translations.md](translations.md).

- **Cache-only builds**: on a CI runner, or with `omega build --cached-only`, the task reads the committed cache only and never calls a provider, so no AI key is needed. The build verb hands the flag to gulp, and a non-interactive manage run passes it to every extension build.
- **Cold strings**: a message with no saved translation ships in English, a cold store description ships no translated listing, and the build prints one warning per language naming the namespace (`messages` or `description`) and the keys, then exits 0. Translate them with a plain `omega build` on your own machine and commit `translations/`.

The English source is seeded from the brand: the scaffold renders `appName` / `appNameShort` / `btnTooltip` from `brand.name`, and `appDescription` from `brand.description` when it fits the 200-character store cap — otherwise "The official &lt;brand&gt; browser extension." ([#573](https://github.com/Omega-JS-Stack/omega/issues/573)). All four render through ONE escape — each lands inside a single-quoted JSON5 value, and the brand-name paths used to render raw, so a name carrying an apostrophe seeded an unparseable file ([#592](https://github.com/Omega-JS-Stack/omega/issues/592)). `config/messages.json` is copy-once, so the seed is a starting point, never a rewrite.

### Build hooks

Three lifecycle hooks let consumers run custom logic while the extension is packaged and deployed:
- `hooks/build/pre.js` — after `dist/` is built but before `packaged/` is assembled
- `hooks/build/post.js` — after packaging (and after store publishing if `OMEGA_IS_PUBLISH=true`)
- `hooks/deploy/pre.js`: inside `omega deploy`, after the local scaffold and before the network precheck, on both lanes (the dispatch and `--direct`); a dry run skips it, because a hook may act on the world and a dry run promises to send nothing ([#900](https://github.com/Omega-JS-Stack/omega/issues/900): the playground's bumps its patch version and prunes its release family, since a store refuses a version it already holds). Its `mode` is always `'production'`: the verb runs outside a build, and what it is about to publish is a release

The NESTED path is the one the defaults scaffold writes and the extension leg of the brand root's `npx omega migrate --execute` moves flat files to (`@omega.js/extension/migrate`, [#885](https://github.com/Omega-JS-Stack/omega/issues/885); a bare run lists the moves), and the one path devkit's hook runner (`runConsumerHook`, shared with @omega.js/desktop) reads.

- Each hook file is an ES module with one default export (`export default async (ctx) => {}`), its body using `import`, `await import()` and `import.meta.dirname`.
- A `module.exports` hook is refused: `<file> must be an ES module with one default export (export default async (...) => {})`.

All three receive the ONE hook-argument shape every OMEGA framework passes: `{ build, projectRoot, mode }`, the same `ctx` @omega.js/desktop hands its lifecycle hooks ([docs/desktop/index.md](../desktop/index.md)), and everything else comes off `build`, the plain build module (`getManifest()`, `getConfig()`, `getPackage('project')`). Async. See [docs/extension/hooks.md](hooks.md).

### Cross-context helpers

The build module and all seven runtime contexts answer the same helpers from `src/utils/mode-helpers.js`: the build module exports them as plain functions (`require('@omega.js/extension/build').isProduction()`), and every context's `omega` carries them as methods (`omega.isProduction()`):

- `getEnvironment()`: `'development' | 'testing' | 'production'` (mutually exclusive)
- `isDevelopment()` / `isTesting()` / `isProduction()`: each DERIVES from `getEnvironment()`, so exactly one is true and `isProduction()` is a real positive check, NOT `!isDevelopment()`
- `getVersion()` on the build module and `omega.version` in a context: the extension version (`chrome.runtime.getManifest().version` in browser, `package.json#version` in Node)

**The environment four are `@omega.js/config`'s ONE module** ([#817](https://github.com/Omega-JS-Stack/omega/issues/817), the contract in full: [docs/shared/config.md](../shared/config.md)): this file re-exports them beside the extension's own `getVersion()`, so `@omega.js/extension`, `@omega.js/desktop`, `@omega.js/web` and `@omega.js/backend` all hang the identical functions. They read ONE input and never guess: `OMEGA_ENVIRONMENT` in build-time Node, and the baked `OMEGA_BUILD_JSON.config.environment` in an extension context (which has no `process.env`). Nothing sniffs `manifest.update_url` or `NODE_ENV` any more, so what an artifact WAS BUILT AS is what it answers, wherever it is loaded from, and a context with neither input throws by name rather than defaulting. `src/build.js` names the input at load, from the lane: `OMEGA_BUILD_MODE` (the `omega build` flag) is production and wins over an inherited value, the `test` verb names `testing`, and a bare dev boot is `development`.

Gate side effects on the INTENTIONAL check (`isProduction()` for prod-only, `isDevelopment() || isTesting()` for local-or-test); never `!isDevelopment()`. Use these instead of grepping `process.env` ad-hoc. See [docs/extension/environment-detection.md](environment-detection.md).

### Test framework

`npx omega test --target=<name>` discovers + runs:
- `<@omega.js/extension>/dist/test/suites/**/*.test.js`: framework defaults
- `<cwd>/test/**/*.test.js`: consumer suites

It runs them on devkit's one runner ([devkit/index.md](../devkit/index.md#the-case-runner)), in this process, row by row, and ends on one Results block (`--reporter=json`: one JSON document on stdout).

Four layers:
- **build**: plain Node, fast. The build module, config validation, manifest shape, lib utilities.
- **background** — real MV3 service worker via Puppeteer + CDP. Boot sequence, `chrome.runtime` surface, storage round-trips, messaging.
- **view**: Chromium tab loading harness `popup.html` / `options.html` / `sidepanel.html` (picked by `context:`), `ctx.page` its `window`. DOM bindings, the `omega` surface, popup ↔ background messaging.
- **boot**: real headless Chromium loading the **consumer's** `packaged/<browser>/raw/` as an unpacked extension. End-to-end: does the real packaged extension boot? Each case is `run(ctx)` with `ctx.extension` and a fresh Puppeteer `ctx.page`. A suite that declares `layer: 'boot'` and `view: '<name>'` runs inside the project's OWN built `views/<name>/index.html`, `ctx.page` its `window`, the same pair a desktop built-view suite declares ([#959](https://github.com/Omega-JS-Stack/omega/issues/959)), and lives under `test/boot/`; the playground extension target's `test/boot/popup.test.js` and `sidepanel.test.js` are the worked example.

The boot layer SKIPS when the consumer has not built: a candidate directory qualifies only when its `manifest.json` is strict JSON, so the intermediate `dist/` (JSON5, and present after any dev run or `omega clean`) is passed over and named in the skip instead of loading and failing every boot test ([#575](https://github.com/Omega-JS-Stack/omega/issues/575)). An explicitly named `OMEGA_TEST_BOOT_DIR` still fails loudly — that one is a decision, not a fallback.

Every case gets the runner's 30000ms unless its suite or itself declares more. A boot suite declares **`timeout: 45000`** at suite level, sized for the FIRST run after a fresh build, where the extension's Firebase service worker initializes cold (observed 20-30s, [#262](https://github.com/Omega-JS-Stack/omega/issues/262)); the scaffolded boot suite and the framework's own carry it.

Test files export `defineCases({ type, layer, description, tests, cleanup })` (`defineCases` from `@omega.js/extension/test`), every case a `{ name, run(ctx) }` on every layer. Same `ctx.expect` / `waitFor` / `state` / `skip` API as @omega.js/desktop and @omega.js/backend. CSP-safe ([docs/extension/test-framework.md](test-framework.md)): a background or view suite travels as one payload carrying devkit's `run-case.js` and `expect.js` with its bodies inlined as literal functions, never compiled from a string inside the worker.

**NEVER mock: test against the real harness.** Every layer gives you the real runtime (real MV3 SW, real Chromium tab + DOM, real packaged extension), so never hand-roll a mock `omega`, fake `chrome`/`browser`, or stubbed context. Only pure functions (zero I/O) are called directly. Real external APIs (Firebase, etc.) are GATED behind extended mode (`npx omega test --target=<name> --extended` or `TEST_EXTENDED_MODE=true`): normal mode skips them in-source via `ctx.skip(process.env.TEST_EXTENDED_MODE)`, NOT mocked; extended-mode tests must clean up anything they create externally. See [docs/extension/test-framework.md](test-framework.md).

**The live sign-in is the root extension auth lane** (`npm run test:e2e-extension`, tier 2c): it signs in as its own persona the backend emulator seeds, found through the roster with the fixed test password, and asserts the background custom-token relay, a page's rendered signed-in state, and a restarted worker answering a signed-in `notes:count` from its restored session; no suite reads a test credential ([one sign-in mechanism](../shared/testing.md), [#904](https://github.com/Omega-JS-Stack/omega/issues/904)).

See [docs/extension/test-framework.md](test-framework.md) and [docs/extension/test-boot-layer.md](test-boot-layer.md).

### Test coverage

Every feature ships with tests at EVERY layer it has a surface in — logic (`build`/`background`), UI (`view` — real events on the real DOM), and end-to-end (`boot`). Skip a layer ONLY when the feature genuinely has no surface there (a pure build utility has no UI; a CSS-only tweak has no logic). "The logic test already covers it" is NOT a reason to skip the UI test — logic tests prove the logic, UI tests prove the wiring, boot tests prove the built artifact. See [docs/extension/test-framework.md](test-framework.md).

## CLI

At a brand root, `npx omega <command> --target=<name>` (bins `omega`, `omg`, `mgr`, all the same dispatcher): [docs/manager/brand.md](../manager/brand.md) § Verbs is where every verb runs, and a target folder refuses. A standalone project is its own root and drops the picker. Bare `omega` prints the listing. Every verb runs `ensureTarget()` first: the local scaffold the retired `omega setup` used to own ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)): scripts, the Firefox listing-id pin, Node check, peer deps, the defaults tree, the locality warning. The PIN is the derived AMO add-on id written into the brand's `config/omega.json5` as `targets.<name>.listings.firefox.id` when the brand declares none ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)): the id is ours, not the store's, it must stay stable after the first upload, and the scaffold is the one step that runs on the LAPTOP before the deploy's snapshot is pushed, so the value rides that snapshot instead of being written on a runner's throwaway checkout. It writes no `.env` ([#678](https://github.com/Omega-JS-Stack/omega/issues/678)): the brand root's `.env` is the one file humans and the manager edit, and a target `.env` is an optional per-key override you author yourself. The scripts it syncs spell the verb BARE (`omega test`, never `npx omega`): npm already puts `node_modules/.bin` on the path inside a script; the `npx` form stays canonical for docs and the terminal ([#748](https://github.com/Omega-JS-Stack/omega/issues/748)). The gulp lane gets it from the `defaults` task; `test` and `deploy` call it themselves:

| Command | Description |
|---|---|
| `clean` | remove `dist/`, `packaged/`, `.cache/`, `.temp/` |
| `build` | clean + `gulp build`, with `OMEGA_BUILD_MODE=true` set in-process — the production build the consumer's `build` script is now a thin alias of, the same shape desktop's verb has ([#81](https://github.com/Omega-JS-Stack/omega/issues/81)). Aliases `-b`, `--build` |
| `deploy` | dispatch the CI publish workflow (the deliberate-deploy verb; see docs/shared/deploys.md in the Omega repo), or with `--direct` run the ONE command CI runs right here, `npm run build` with `OMEGA_IS_PUBLISH=true` ([#865](https://github.com/Omega-JS-Stack/omega/issues/865)): the local build, the store publish the build series ends in, and the release upload to `<brand.id>-releases` ([#872](https://github.com/Omega-JS-Stack/omega/issues/872), [#883](https://github.com/Omega-JS-Stack/omega/issues/883)). A DISPATCH runs the NETWORK prechecks first: framework freshness, then the secrets push ([#680](https://github.com/Omega-JS-Stack/omega/issues/680)), which is `fatal` ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)): the store credentials and GA secret the schema delivers to extension, published as repo Actions secrets through the shared devkit publisher; `--no-secrets` skips them (the same opt-out name on every target) and `--direct` never reaches them (a local deploy publishes no store credentials to the repo, #872) |
| `version` | print versions |
| `help` | command listing (router built-in; also `-h`/`--help`) |
| `test` | run the project's test suites (`framework:` / `full:` reach the framework suite) |
| `update` | dependency freshness report (installed/wanted/latest + patch/minor/major, < 7-day releases QUARANTINED, the `@omega.js/*` family exempt); a bare run installs the safe set via npu, `--dry-run` only reports, `--major` explicit. Aliases: `-u`, `--update`. See docs/shared/updates.md in the Omega repo |

See [docs/extension/cli.md](cli.md).

## Dependency Resolution

- **Consumer code can `require()` any @omega.js/extension dependency** — the bundler's framework-deps resolve hook re-resolves every name the framework DECLARES from the framework's own installation. Consumer projects do NOT need to `npm install firebase`, `@omega.js/client`, or any other @omega.js/extension dep. If a dep doesn't resolve, the fix is in @omega.js/extension's `package.json` — not the consumer's.
- **The framework's copy wins ([#87](https://github.com/Omega-JS-Stack/omega/issues/87)).** A consumer that declares its own version of a framework dependency still bundles ONE copy — the framework's — the same guarantee @omega.js/web and @omega.js/desktop give, through the same @omega.js/devkit hook since [#738](https://github.com/Omega-JS-Stack/omega/issues/738). The DECLARED set is the list, so — unlike webpack's `resolve.modules` order, which this replaced — a package the framework merely carries TRANSITIVELY no longer wins: it resolves the way node resolves it. Same shape in [docs/desktop/index.md](../desktop/index.md); pinned by `src/test/suites/build/framework-deps.test.js` in both.
- **@omega.js/client owns Firebase.** Consumer code NEVER imports Firebase directly (`require('firebase')` / `import('firebase/app')`). Use the context's instance: `omega.auth`, `omega.firestore`. Same rule on every OMEGA browser surface.
- **Hooks run outside the bundle, so they get the dependency nudge.** A consumer `hooks/**/*.js` file loads under plain node, where a framework dependency the target never declared resolves only by hoisting. Every verb's scaffold scans `hooks/` and prints one warning per such `import` or `require`, at file:line: declare it, or load the framework's copy with `extension.require('<module>')` after `import extension from '@omega.js/extension'`, the same door @omega.js/desktop's build-time entry carries. Never an error, and a version the target declares itself wins. The one rule: [docs/shared/local-dev.md](../shared/local-dev.md#using-what-the-framework-depends-on).

## Development Workflow

- **🚫 NEVER use `npx omega ...` from the framework repo**: `npx omega` is for CONSUMER projects only (where the bin lives in `node_modules/.bin/`). From the framework repo, use `npm test`, `npm start`, etc. The `scripts` in `package.json` call `node bin/omega` directly. This applies to ALL four OMEGA frameworks.
- **🚫 NEVER run `npm start`** (consumer projects): it's the user's long-running dev watcher. Assume it's already running; if it isn't, **instruct the user to run it** rather than running it yourself (running it again kills theirs). To see output, **read the `logs/*.log` files** (`dev.log`, `build.log`, `test.log`), never tail/attach to the process. Running `npx omega test --target=<name>` is fine.
- **Where the output logs live:** the gulp pipeline tees all stdout/stderr to `<projectRoot>/logs/dev.log` (on `npm start`) or `logs/build.log` (on `npm run build`), truncated fresh each run, ANSI-stripped. `cat logs/dev.log` (or `grep` it) instead of scrolling scrollback, never restart the watcher to see output it already wrote. `npx omega test --target=<name>` writes `logs/test.log`. See [docs/extension/build-system.md](build-system.md#log-files); the cross-framework tee contract and the full path table are [docs/shared/logging.md](../shared/logging.md).
- **After editing files**, verify the gulp watcher recompiled successfully. Check for esbuild/sass errors in the console output. A change that breaks the build is not a completed change.
- **Live-test the extension via CDP.** Use the `chrome-devtools-extension` MCP upstream: it launches a per-session Chrome for Testing with the unpacked extension pre-loaded (`OMEGA_CDP_EXTENSION_PATH="$(pwd)/packaged/chrome/raw" claude`, then `router__enable_upstream`; stable Chrome ignores `--load-extension`). Plain web pages (no extension needed): the regular `chrome-devtools` MCP tools; your session auto-launches its own private Chrome on the first tool call. This is the primary way to confirm UI changes: type-checking and test suites verify code correctness, not feature correctness. See [docs/extension/cdp-debugging.md](cdp-debugging.md) + `~/.claude/mcp-server/servers/chrome-devtools-extension/CLAUDE.md`.

## Supply-Chain Security

All `npm install` calls in CLI commands (the peer-dependency step of every verb's `ensureTarget()`) route through the `safeInstall()` helper (`src/lib/safe-install.js`). It prefixes `sfw` (Socket Firewall) when installed, blocking confirmed malware at the network level before packages reach disk. Falls back to plain npm if sfw isn't available. CI workflows get the firewall from Socket's own GitHub Action (`SocketDev/action`, firewall mode, pinned; it downloads the binary with the job's token and caches it, so a hosted runner's shared anonymous API quota never fails the step, [#871](https://github.com/Omega-JS-Stack/omega/issues/871)) and run `sfw npm ci`, the one install step every lane shares ([#938](https://github.com/Omega-JS-Stack/omega/issues/938)). The template carries only the `{{ installFirewall }}` token; the composer renders the step, once, from devkit's one pinned constant ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)). Installs will **fail if sfw detects confirmed malware** in any package in the dependency tree; non-critical CVEs and quality warnings pass through.

## File Conventions

- **CommonJS** (`require()`) for build-time + Node code (gulp, CLI, tests). **ES modules** (`import`/`export default omega`) for the browser-context modules (`background.js`, `popup.js`, etc.): they go through esbuild.
- One `module.exports = ...` per file (CommonJS).
- **Consumer hooks are ES modules** (`export default`, `import`, `import.meta.dirname`), run through devkit's `runConsumerHook`; the framework's own Node code stays CommonJS.
- Logical operators at the **start** of continuation lines.
- Short-circuit early returns rather than nested ifs.
- Prefer **`fs-jetpack`** over `fs-extra`.
- **No backwards compatibility** unless explicitly requested.
- **No paranoid `?.`** — see [the defensive-coding rule](https://anthropic.com/claude-code) (also enforced in `~/.claude/skills/js:patterns`). Framework internals deref directly; `?.` is for genuinely-uncertain values (user config sub-fields, `chrome.*` APIs that may be absent, regex matches, caught exceptions).
- **Browser-context modules are ES-module.** esbuild compiles them. Don't try to `require()` them from Node: they reference `window`, `document`, `chrome` at module-load time. Build-layer tests should target `lib/*.js` (Node-safe) or use @omega.js/extension's build module (`require('@omega.js/extension/build').getConfig()`).
- **Consumer pattern: use the build module in tests.** Don't `require('json5')` or other transitive @omega.js/extension deps directly from consumer test files: they're not in the consumer's `package.json` and resolution is fragile. Use `build.getConfig()` / `build.getManifest()` (`const build = require('@omega.js/extension/build')`).

## Doc-update parity

Whenever you make a behavioral change (new command, new flag, new pattern, removed feature), update:

1. **`README.md`** — user-facing summary
2. **`docs/extension/index.md`** (this file) — architecture overview, one paragraph or cross-link
3. **`docs/extension/<topic>.md`** — the meat. If a topic doesn't have a doc yet, create one.
4. **`CHANGELOG.md`** — if the project keeps one

Don't ship behavioral changes with stale docs. Validate first, then document — write docs that describe shipped reality, not intentions.

**The four framework guides are structurally MIRRORED.** [docs/web/index.md](../web/index.md), [docs/backend/index.md](../backend/index.md), [docs/desktop/index.md](../desktop/index.md), and [docs/extension/index.md](../extension/index.md) keep the same section skeleton in the same order. Never add, rename, or reorder a section in one without making the SAME change in the others in the same pass.

## Documentation

API references for each subsystem live in `docs/extension/`, beside this guide:

### Architecture
- [docs/extension/components.md](components.md) — seven component contexts, three-part structure (view + styles + script), manifest wiring
- [docs/extension/contexts.md](contexts.md): the one instance per context, import paths, `initialize()` flow
- [docs/extension/environment-detection.md](environment-detection.md): `omega.isTesting / isDevelopment / isProduction`, the build module's `getVersion`

### Runtime
- [docs/extension/extension.md](extension.md) — cross-browser `chrome.*` / `browser.*` API wrapper
- [docs/extension/auth.md](auth.md) — cross-context auth sync, sign-in / load / sign-out flows, button CSS classes
- [docs/extension/verts.md](verts.md) — `[data-omega-vert]` auto-bind to @omega.js/client's verts module on page surfaces (live via MutationObserver): house/company lane ONLY (type pinned 'house' — no AdSense; content scripts never bind)
- [docs/extension/affiliatizer.md](affiliatizer.md) — the content script's affiliate-link redirect on matched partner hostnames (a fixed framework-level map, not brand config): default-on, once per partner per 24h, `?affiliatizerStatus=block|allow|reset` control, store-listing disclosure
- [docs/extension/offscreen.md](offscreen.md) — offscreen document lifecycle, creation from background, messaging
- [docs/extension/xss-prevention.md](xss-prevention.md) — escapeHTML/sanitizeURL canonical forms, extension attack vectors

### Build
- [docs/extension/build-system.md](build-system.md) — gulp pipeline, esbuild, sass, html, packaging
- [docs/extension/templating.md](templating.md) — `{{ }}` token replacement, available vars, page template
- [docs/extension/css.md](css.md) — SCSS load paths, framework + theme + project resolution
- [docs/extension/themes.md](themes.md) — bootstrap / classy / `_template`, variable overrides, dark mode
- [docs/shared/icons.md](icons.md): one source icon (`config/icon.*`, else the brand's brandmark) → all generated sizes, manifest wiring
- [docs/extension/defaults.md](defaults.md) — `src/defaults/` system, `FILE_MAP` rules
- [docs/extension/hooks.md](hooks.md) — `build:pre` / `build:post` lifecycle hooks
- [docs/extension/translations.md](translations.md) — auto-translate to the configured `translation.languages`

### Operations
- [docs/extension/cli.md](cli.md) — commands, aliases, env var conventions
- [docs/extension/cdp-debugging.md](cdp-debugging.md) — launching a controllable Chrome (CDP), loading the unpacked extension (persistent agent profile — `--load-extension` is dead on stable Chrome), driving via MCP/CDP
- [docs/extension/logging.md](logging.md) — `dev.log` / `build.log` / `test.log` tee, controls
- [docs/extension/common-mistakes.md](common-mistakes.md) — the canonical "don't do this" list
- [docs/extension/audit.md](audit.md) — full-audit check catalog (U-xx universal / EXT-xx / F-xx IDs with severity + scope), protocol + fix loop
- [docs/shared/publishing.md](publishing.md) — Chrome / Firefox / Edge store auto-publishing, credentials, CI, store listing description format (`config/description.md`)

### Testing
- [docs/extension/test-framework.md](test-framework.md) — writing tests, four layers, `ctx` + `expect` API
- [docs/extension/test-boot-layer.md](test-boot-layer.md) — boot layer (loads consumer's actual packaged extension)
