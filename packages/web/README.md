# @omega.js/web

The OMEGA web framework — the UJM (Jekyll) successor, built on **Eleventy 3 +
LiquidJS + [@omega.js/template-kit](../template-kit)** per the Phase 2 bake-off
decision (2026-07-06: Eleventy 4.70 vs Astro 3.55 weighted; its facts are in the
CHANGELOG's Phase 2 Task 2.3, 2.3b, 2.4 and 2.5 entries). B1 promoted the engine core from the
winning spike; **B2 ported the REAL UJM content** — the full blueprint layout
set, 3 Liquid themes + the bootstrap asset layer, ~60 default pages, and the
real core chrome (head/body/foot) — through the B4 codemod rules. **B3 added
the `omega` CLI, consumer scaffolding, the ESM boot runtime, and the Ruby-free
CI template. B4 made the conversion plan executable: `omega migrate` (legacy
configs → omega.json5, the codemod rule table over `src/**`, the liquid-lint
scanner, legacy-file removal) — live-proven on real consumers (somiibo:
migrate → 2,556 pages, ~3.2× the whole Jekyll pipeline).**

```bash
# In a consumer project (scaffolded scripts call these):
npx omega dev       # dev server: Eleventy watch/serve + in-place asset rebuilds
                    #   port: website convention 4000, auto-bumps +1 when taken (N7);
                    #   --port=N or config ports.website PINS it (busy = hard error)
                    #   HTTPS by default via mkcert (https://localhost:4000; Eleventy
                    #   serves an internal port behind the TLS proxy, live-reload WS
                    #   tunneled; plain http://localhost:4000 307s to https) —
                    #   --no-https or no mkcert falls back to plain http
                    #   and site.url follows the scheme (canonical/og stay honest)
                    #   dev pages auto-connect the REAL Auth+Firestore SDKs to the local
                    #   emulators (zero flags; never live Firebase) — start them from the
                    #   brand's backend app: `npx omega emulator`. A live backend's
                    #   resolved (possibly bumped) ports reach the page via the injected
                    #   dev.ports chrome, so the browser always targets THIS brand's stack
                    #   --local: first link every @omega.js dep brand-wide from the local
                    #   Omega monorepo + start its src→dist watch (docs/shared/local-dev.md there)
npx omega build     # production: assets (hashed, @dev-only blocks stripped) → Eleventy → PurgeCSS → Firebase auth helpers (/__/auth/*) → dist/
                    # the auth-helper fetch fails the build loudly on error (demo-*/projectless brands skip); escape hatch: OMEGA_SKIP_FIREBASE_AUTH=true
npx omega test      # PROJECT scope: production build, then ONE devkit runner run: the five
                    #   smoke cases, then consumer test/ (defineCases files, a process each,
                    #   side by side; test/_init.js setup first; every verb scaffolds
                    #   test/README.md, web's one layer build (its build/ and pages/
                    #   directories a convention), and the _init.js hook)
                    #   --filter --layer --lane --extended --reporter=pretty|json; a path
                    #   filter is a contains match; logs/test.log holds the run
                    #   framework:/omega:/web: = @omega.js/web's own suite; full: = both
                    #   (C5 scoping — docs/shared/testing.md in the Omega repo)
npx omega deploy    # THE publish verb (D13): sync (push triggers nothing) → dispatch
                    #   build.yml so CI builds + publishes; --dry-run prints the exact
                    #   POST, --local builds only (docs/shared/deploys.md in the Omega repo)
npx omega update    # dependency freshness (npu semantics): installed/wanted/latest +
                    #   patch/minor/major per dep; releases < 7 days old QUARANTINED;
                    #   installs the non-breaking non-quarantined set via npu (--dry-run
                    #   only reports)
                    #   (--major explicit; --min-age N / --force-fresh tune the hold;
                    #   file: specs skipped — docs/shared/updates.md in the Omega repo)
npx omega customize <url>  # materialize a default page into src/pages/ (spec §8):
                    #   composition-wrapped pages prefill the theme's section
                    #   one-liners (no copy inlined — sections keep flowing),
                    #   everything else copies the thin default verbatim for
                    #   frontmatter-args customization; no URL lists every
                    #   customizable URL + lane (docs/web/sections.md in the Omega repo)
npx omega customize --list # the layered override map: every shadowable file
                    #   (sections, includes, css, pages), its owning layer
                    #   (framework / theme:<id> / consumer), and whether you
                    #   already shadow it
npx omega customize <path> # materialize ONE shadowable file at the path that
                    #   shadows it (`_includes/…`, `_sections/…`, `assets/css/…`
                    #   — exactly what --list prints), with a provenance header
                    #   comment naming the source layer; never overwrites
npx omega clean     # remove dist/ + .omega/
npx omega version   # framework version
npx omega help      # command listing (also -h/--help; router built-in — never
                    #   falls through to setup like the old flag handling did)
npx omega migrate --target=<name>            # at the BRAND ROOT (the manager's verb, this CLI has none):
                                             #   report the UJM → @omega.js/web conversion, zero writes
npx omega migrate --target=<name> --execute  #   convert in place
npx omega translate         # translate dist/ into translation.languages (committed cache;
                            #   `omega build` runs it automatically when enabled — see
                            #   docs/shared/translation.md in the Omega repo)
npx omega audit            # production build → dist/ served on an ephemeral port →
                           #   Lighthouse on the home page; report-only. Each page
                           #   prints the four scores plus LCP, CLS and the form
                           #   factor the run emulated (Lighthouse's default is
                           #   mobile on Slow 4G, the shape PSI reports)
npx omega audit /pricing --min-performance=90
                           # extra pages as args; --min-<category> arms the gate
                           #   (performance/accessibility/best-practices/seo) —
                           #   any score under its minimum exits 1
npx omega audit --max-lcp=1300
                           # the 1.3 s perceived-usability bar (the end of the hero fade):
                           #   any page whose LCP is over the stated ms fails and exits 1

npm test    # engine slice + assets/ESM + CLI/scaffold + migrate + ports + theme contract + translate
```

A bare consumer (`omega build` in an empty dir, edit brand in
config/omega.json5) builds the full ~56-page default set in under 2 s.

The corpus bench harness retired with the bake-off spike trees. With the REAL
content its corpus (1,135 docs → 1,397 pages incl. the full default set) built
in ~20 s total.

## Module map (`src/`)

| Module | Owns |
|--------|------|
| [engine.js](src/engine.js) | `configureOmega()` — turns an Eleventy instance into the OMEGA engine: Liquid options + template-kit registration, layered layouts, frontmatter preprocessor, `resolved`/`paginator`/`pageAssets` computed data, site collections, default pages, globals |
| [collections.js](src/collections.js) | posts / alternatives / team / updates collections + taxonomy aggregation (deterministic date-desc, slug tie-break order), and the same registration for the brand's own collections |
| [dynamic-pages.js](src/dynamic-pages.js) | Dynamic pages, the jekyll-uj-powertools dynamic-pages successor: `targets.web.collections` declares a brand's own collection (`docs: { field: 'doc.category', size, title, description, permalink }`), its documents live in `_docs/` and publish at `/docs/<slug>`, and the engine generates the paginated listing (`/docs`, `/docs/2…`) plus one page per category of `field` (`/docs/categories/<slug>`) as virtual templates on the default-page lane — a consumer page at any of those permalinks takes that URL over. The documents are consumer FILES, so they are served at data time instead: each one gets the same `collection` block its generated siblings carry, plus its own `meta.title` (`<Document> - <Collection> - <Brand>`) and `meta.description` derived from the document's own frontmatter, and `blueprint/collection/document` is the layout that renders it (masthead h1 + prose, the listing/category siblings' shape) |
| [social-pages.js](src/social-pages.js) | Social shortlinks (#429), legacy UJM's per-social redirect pages: every entry of the `socials` config block generates a redirect page at `/<platform>` on the `modules/utilities/redirect` layout, as a virtual template on the default-page lane — so a consumer page at `/<platform>` takes that URL over, and the layout's own noindex + sitemap exclusion apply. The string form is a handle whose profile URL (template-kit's platform patterns, the same ones `omega_social` and JSON-LD `sameAs` read) IS the destination; the object form `{ handle, redirect }` sends the shortlink somewhere else while the handle keeps naming the profile. Nowhere to point (blank handle, or an unknown platform with no `redirect`) generates nothing; a malformed entry is a hard error |
| [markdown-images.js](src/markdown-images.js) | Markdown `![alt](src)` renders through template-kit's `buildImageHtml` (the `omega_image` builder — one image-markup SSOT): responsive `<picture>` + lazy placeholder for local raster images, the plain lazy `<img>` lane for external or non-raster sources. `@post/<file>` resolves to `/assets/images/blog/post-<post.id>/<file>`; used off a post it FAILS the build naming the file. Note: feeds embed the rendered (lazy) markup, so feed readers see the placeholder — legacy parity |
| [limit-collections.js](src/limit-collections.js) | Dev-mode collection sampling (`targets.web.dev.limitCollections`, the jekyll-uj-powertools limit-collections successor): first-N in collection order, or a random sample with `randomize: true`; the sampled-out documents are skipped before render, so they cost no pages, collection entries or taxonomy terms. Development builds only, loud on every build; the config is validated in production too, where nothing is ever sampled |
| [layouts.js](src/layouts.js) | Layered layout delivery, zero copying: virtual templates (build) / symlink farm (dev, watchable) |
| [layers.js](src/layers.js) | `collectLayered()` — first-layer-wins file resolution (themes, page modules, default pages) — over `collectProviders()`, which keeps every layer that provides a path (what the override map reports as shadowed) |
| [language-flags.js](src/language-flags.js) | The language-named flag aliases in the emitted icon set (`assets/icons/flags/lang/en.svg` = the us flag; their own namespace because `ar`/`ca` name both a language and a country), so the client-side footer language switcher fetches a flag by the row's own hreflang code. Every supported language gets one; a language whose country has no flag gets the neutral `lang-fallback.svg` — the language→country map stays `@omega.js/template-kit`'s |
| [frontmatter-liquid.js](src/frontmatter-liquid.js) | Frontmatter-value Liquid — a value's variable ROOTS pick its lane (cached site-scope renders; page-scoped values, the page's pagination alias included, defer to a per-page copy-on-write pass; everything else renders uncached against the template's own cascade, so the consumer's `_data` globals resolve; a `meta:` ref with an undefined root fails the build; the context-free `omega_*` filters are registered, since LiquidJS drops an unknown filter silently) |
| [consumer-scan.js](src/consumer-scan.js) | Consumer permalink scan → default-page suppression |
| [sections.js](src/sections.js) | The section/component library: `{% section %}`/`{% component %}` tags (layered resolution, json5 schemas/defaults, data bridge, call-site liquification), `buildSectionLibrary()` (the showcase/docs collector), `collectSectionAssets()` (§7 lanes), and the `{% composition %}` page-body guard (docs/web/sections.md in the Omega repo) |
| [customize.js](src/customize.js) | `omega customize <url>` mechanics (spec §8): default-URL → materialization plan (composition lane prefills the theme's wrapped one-liners, shell lane copies the thin default verbatim), idempotent writes, `listCustomizable()` |
| [overrides.js](src/overrides.js) | The layered override map (#94): `buildOverrideMap()` — every shadowable section/include/css/page with its owning layer and the consumer's shadows, read out of the SAME layer chains the build resolves through (`collectProviders`), and `materializeOverride()` — one file copied to its shadow path with a provenance header. The css lane lists ONLY what sass layers by — `main.scss` and the page sheets (`isPageEntry`, base bucket) — never the partials a bare relative `@use` resolves against the importing file, which a consumer copy could never win |
| [assets.js](src/assets.js) | esbuild page modules + main bundle over LAYER ROOTS (boot stubs, `@omega.js/client` → @omega.js/client dir alias, `__main_assets__`/`__theme__` resolution), layered sass (`omega:theme`), page css namespaces, layered `fonts/` → `/assets/fonts` copy, PurgeCSS post-pass (content scan = `dist/**/*.html` + `dist/**/*.js`, so classes that live only in JS-built markup survive — #66), critical-css extraction (the first-paint subset the head inlines so the main sheet stops render-blocking, #750) |
| [entry-outputs.js](src/entry-outputs.js) | `readEntryOutputs()`: esbuild's metafile into the manifest's js block, each entry's URL and `js.imports` (every chunk an entry's STATIC import chain reaches; a dynamic `import()` ends the walk) |
| [page-assets.js](src/page-assets.js) | What one page loads, registered by the engine as computed data: `pageAssets` (by URL), `layoutAssets` (by layout chain), `modulePreloads` (entry URL → the chunks to preload beside it, each shared chunk once) |
| [live-manifest.js](src/live-manifest.js) | `refreshLiveManifest()`: `omega dev` folds a rebuild's content lists (the font preloads, `js.imports`) into the live manifest the engine renders from |
| [path-prefix.js](src/path-prefix.js) | Base-path support (#355): `resolvePathPrefix()` normalizes the publisher's `OMEGA_PATH_PREFIX`, and the emit lanes mount root-relative URLs under it — `prefixHtml()` (the engine's `omega-path-prefix` transform: href/src/srcset/action plus the `<html data-omega-path-prefix>` stamp the browser half reads) and `prefixCss()` (the theme sheets' `url()` targets). Unset = no pass runs |
| [service-worker.js](src/service-worker.js) | `buildServiceWorker()` — esbuild iife bundle of the consumer's `src/service-worker.js` (or the packaged `sw/entry.js`) to dist root `/service-worker.js`; `writeBuildMeta()` — the build manifest at `/build.js` (JSONP config transport for the worker) + `/build.json` (page-side; the client version check reads `timestamp`, the `/status` page shows the rest: theme, package versions, repo, commit) |
| [build.js](src/build.js) | `buildSite()` — assets → service worker/meta → static → imagemin → Eleventy → PurgeCSS orchestration with per-phase timings (what `omega build` runs) |
| [imagemin.js](src/imagemin.js) | Responsive image matrix (the UJM imagemin successor): 320/640/1024 + original × source-format + webp @ q80 over `dist/assets/images` (favicon dir exempt), content-addressed cache at the brand `.omega`, `devImageFallback()` dev-server middleware |
| [inline-icons.js](src/inline-icons.js) | Build-time icon inlining ([#619](https://github.com/Omega-JS-Stack/omega/issues/619)): the engine's `omega-inline-icons` transform fills every empty `<i>` whose classes name an icon — Font Awesome or the `omega-flag-*` namespace — with that icon's SVG, in markup byte-identical to what the runtime watcher (`runtime/icons.js`) would produce, so static chrome costs zero fetches and no icon renders two ways. A name the set has no file for is left empty and marked `data-omega-icon-missing` |
| [minify-html.js](src/minify-html.js) | Production HTML minification (UJM minifyHtml successor) — Rust minifier with the legacy extraction dance (JSON-LD minified as JSON, inline scripts esbuild-minified, IE conditionals preserved); engine mounts it as a transform for `environment: 'production'`, .html outputs only |
| [purge.js](src/purge.js) | Cloudflare cache purge (UJM cloudflare-purge successor, de-ITW'd — direct API, brand's own `CLOUDFLARE_TOKEN`): zone from config `cloudflare.zone` or brand-url apex lookup; `omega purge` command, auto after `omega deploy --direct`, CI workflow step when the secret exists |
| [paths.js](src/paths.js) | Packaged content locations (themes/core/defaults/scaffold/runtime/translations) + `resolveClientEntry()` |
| [cli.js](src/cli.js) + [commands/](src/commands) | The `omega` CLI: devkit's shared router (bin/omega → cli.js → commands/<name>.js), with dotenv from the consumer root |
| [index.js](src/index.js) | The package export: the engine entry points plus the build-side environment surface, `getEnvironment()` → `'development' \| 'testing' \| 'production'` (mutually exclusive) and `isDevelopment()` / `isProduction()` / `isTesting()` deriving from it, re-exported from `@omega.js/config/environment`: the same four calls `@omega.js/backend`, `@omega.js/desktop`, `@omega.js/extension` and the browser runtime instance answer. The verbs name the environment (`omega build` → production, `omega dev` → development, `omega test` → testing) and the build lanes read it back |
| [consumer.js](src/consumer.js) | Consumer layout (`src/`, `dist/`, `.omega/`) + omega.json5 → site data (loadConfig + toSiteGlobal) |
| [scaffold.js](src/scaffold.js) | `scaffoldDefaults()` — devkit defaults engine + the web FILE_MAP over `scaffold/` (marker merges, JSON5 config merge, CI/nvmrc templating) |
| [migrate/](src/migrate) | `migrateTarget()` (the `@omega.js/web/migrate` entry the brand root's `omega migrate` runs) over `runMigration()`: [config-convert.js](src/migrate/config-convert.js) (_config.yml + ultimate-jekyll-manager.json → omega.json5, mapping in [docs/shared/config.md](../../docs/shared/config.md)), [brand-config.js](src/migrate/brand-config.js) (inside a brand, the merge into the root `config/omega.json5`: the root value wins, web-only sections under `targets.<name>`, and a target's own config file, its override layer, is never touched), [rules.js](src/migrate/rules.js) (the DECISION.md codemod table as pure text transforms), [codemod.js](src/migrate/codemod.js) (src/** walker), [lint.js](src/migrate/lint.js) (liquid-lint — known names derived from the REAL registration path: registerLiquid plus the framework's own `{% section %}`/`{% component %}`/`{% composition %}` tags, so a fully converted tree lints clean), [consumer-assets.js](src/migrate/consumer-assets.js) (seed main.js removal, `omega:main` scss rewrite, page-css self-@use drop) |
| [runtime/](runtime) | The BROWSER boot runtime (ESM, bundled into every build): `boot.js` bootMain/bootPage/bootLayout/bootSections handshake, `omega.js` the web runtime instance (`import omega from '@omega.js/web/runtime'`: the `@omega.js/client` base class plus `appearance`, `shell`, `motion` and `exitPopup`), `icons.js` the icon watcher's transport (`/assets/icons/<style>/<name>.svg`, flags one namespace over): loud on a miss in development, silent in production |

## Packaged content (the real UJM port, B2)

- `themes/base/` — the structural markup layer every theme chain terminates
  at: frontend + backend + admin layouts, includes, sections, and components
  in the neutral `omega-*` BEM vocabulary. Themes are skins over these
  selectors and fork markup only for identity surfaces (the ladder: tokens →
  component scss → bounded forks); convention in
  [docs/web/sections.md](../../docs/web/sections.md).
- `themes/classy/` — the flagship skin, classy v2 (css, js, vendored
  webfonts over base's markup): warm-paper/charcoal
  token-driven skin, zero gradients, ink primaries, serif marketing display
  (Newsreader) over an Inter UI, `.omega-shell` app chrome — see
  [docs/shared/theming.md](../../docs/shared/theming.md). Every default frontend page ships
  in the v2 language (page-hero/prose/timeline/post-card/person/facts
  vocabulary in `css/marketing/_content.scss` + the cp147 compositional set:
  hero-split, duo, statement, numbered, channel, band, form-panel — pages are
  COMPOSED asymmetrically, not centered; the shared blog card is ONE
  include, `_includes/frontend/components/post-card.html`). The footer is the
  draft-2 pattern (brand block + auto-fit link columns + ONE matched-scale
  base row with legal links, language pill, segmented appearance control).
  Per-page THEME
  css lives at `css/pages/<page>/index.scss` — it loads LAST on its page
  (after core page css), which makes it the override slot for core page rules
  (status/feedback use this to repaint JS-toggled `bg-*` state classes in the
  hairline language);
  `themes/neobrutalism/` and `themes/newsflash/` — skins with bounded
  identity forks that fall back to base per file (fork lists in each
  theme's README); `themes/bootstrap/` — the vendored Bootstrap 5
  scss/js the themes build on (sibling imports); `themes/_template/` — the
  theme-starter skeleton.
- `core/` — the theme-agnostic layer: `_layouts/blueprint/**` (45 page-type
  contracts), `_layouts/core/root.html` (the document shell),
  `_layouts/modules/` (redirect utility), `_includes/` (head/body/foot chrome,
  price-per-unit pricing math, default
  nav/footer/account + app sidebar/topbar data JSONs), `css/` (main.scss +
  the `--omega-*` token sheet, `.omega-shell` mechanics, the motion library,
  core styles, per-page css), `js/` (the UJM runtime: main module, core
  modules incl. the motion boot, libs, per-page modules), `icons/`.
- `defaults/pages/**` — ~60 default pages at their real URLs (about, pricing,
  contact, auth, legal, payment, portal, team, updates, alternatives, admin,
  test pages) + the blog set: paginated index (`/blog/page/N.html`, size 6;
  `generatePageOnEmptyData` keeps `/blog` alive with an empty state for
  post-less brands),
  category/tag index pages, and per-category/per-tag generator pages
  (pagination over the aggregated taxonomy — replaces dynamic-pages.rb) + the
  site meta-files (sitemap.xml, `/feeds/posts.{xml,json}` RSS + JSON feeds,
  robots.txt, ads.txt, humans.txt, opensearch.xml, the pages.json search
  index, `/.well-known/security.txt`) — default pages like any other, so a
  consumer file at the same URL overrides. sitemap.xml and pages.json emit
  entries in URL byte order (deterministic across builds). JSON outputs are
  valid by construction (`omega_json_escape` + first-emitted-comma pattern); ads.txt
  renders the configured `advertising.providers.adsense.client` or an
  honest comment — that client id is the ONE adsense switch, the same
  presence that renders the ad units and has the manager manage the account
  ([#527](https://github.com/Omega-JS-Stack/omega/issues/527)).
- `defaults/sample-posts/**`, `sample-team/**`, `sample-updates/**` — the
  shared sample-content corpus (spec §8: 11 posts, 4 teammates, 4 updates),
  injected as virtual collection templates in **development builds only**,
  per collection only while the brand owns zero files there (nested
  `_posts/<year>/` dirs count) — a content-less brand still gets a living
  blog/team/updates locally. Dates ROLL: each file's authored date is a
  rhythm relative to the corpus epoch (2026-07-18), re-anchored to the
  build day (post filenames shift — Eleventy `page.date`; `update.date`
  frontmatter lines rewrite) so a virgin blog always looks alive, never
  "6 months stale". The anchor pins via `options.sampleAnchor` /
  `OMEGA_SAMPLE_ANCHOR` — the test harness pins the epoch, making
  generation an identity transform for fixtures and goldens. `omega dev`
  also materializes the generated set under the target's
  `.omega/sample-content/` (self-`.gitignore`d, regenerated every boot,
  removed per collection once the consumer owns it) so the filler can be
  read and copied — never committed, never mixed with real content. The
  first consumer file in a collection — or any production build — removes
  that collection's samples entirely. Every generated document is MARKED:
  the generator writes `generated: true` into the frontmatter (never the
  corpus files, so a newly authored sample cannot forget it), and the base
  theme renders a `--omega-warn` TEST pill wherever such a document shows —
  the post page, the blog listing's featured lead, and every post card
  (`core/css/core/_generated-badge.scss`, `#208`). The templates key off the
  flag ALONE, with no environment check, because samples never inject into a
  production build. The two oldest posts carry
  `post.image: false` + no author, exercising the designed no-media panel
  (serif category monogram) and the brand-byline author fallback; both
  contracts apply to real posts too (`post.image: false` → no-media panel,
  a path → that image, absent → the legacy id-path convention).
- `sw/`: the service worker. `omega.js` is the worker's one instance
  (`import omega from '@omega.js/web/service-worker'; await omega.initialize();`):
  FCM background messaging, notification clicks, the `update-cache` command,
  brand+build-named caches with foreign-cache eviction. `entry.js` (the consumer-less default entry; the scaffold seeds
  `src/service-worker.js` with the same import for custom worker code).

## URL shape — flat `.html`, no trailing slashes (legacy parity)

Pages write **flat files** (`/signin` → `signin.html`, never
`signin/index.html`) and `page.url` is **extensionless with no trailing
slash** (`/signin`) — exactly legacy UJM/Jekyll. A page under `src/pages/`
with no `permalink` serves at its file path (`pages/guides/intro.md` is
`/guides/intro`, an `index` file its folder); an explicit permalink wins. Mechanics: the computed
`permalink` appends `.html` to extensionless permalinks (a REAL-extension
whitelist, not `path.extname` — dotted slugs like `/updates/v1.0.0` are page
URLs), an Eleventy `addUrlTransform` strips `.html` back off `page.url`, and
Liquid-carrying permalinks (blog pagination, taxonomy generators) spell their
full shape explicitly. Serving: the dev server's `devCleanUrls` middleware
resolves `/signin` (and a stray `/signin/`) to `signin.html` — the legacy
serve.js contract — and GitHub Pages resolves extensionless paths against
`.html` files natively, so production behaves identically.

## Serving under a URL path (`OMEGA_PATH_PREFIX`)

Everything a build emits is root-relative, so a site mounted under a URL path
instead of a domain root — a GitHub Pages **project** site at
`https://<user>.github.io/<repo>/` — would ask the domain root for its assets
and 404. Set `OMEGA_PATH_PREFIX` around `omega build` and every emitted URL
moves under it:

```bash
OMEGA_PATH_PREFIX=/workkit npx omega build
```

The value is a **publisher** input, not an end-user one: whatever machinery
publishes the site knows its mount point (workkit's publish reads it off the
Pages API), and hosts that serve at the domain root — Netlify, Vercel, a custom
domain — pass nothing. It is normalized defensively (leading slash added,
trailing slash stripped); `/` and unset both mean the domain root, and then no
pass runs at all, so the output is byte-for-byte what it has always been.

**`omega deploy` fills it for you** ([#358](https://github.com/Omega-JS-Stack/omega/issues/358)), so an ordinary
gh-pages brand never types the variable: a `brand.url` naming a domain of your
own means the site serves at that domain's root (the CNAME both lanes publish
cannot carry a path) → `/`; a `brand.url` naming a `*.github.io` address means
the path IT carries is the mount → `/<name>/` ([#366](https://github.com/Omega-JS-Stack/omega/issues/366));
`brand.url` unset resolves, in the config loader, to that default project
address `https://<owner>.github.io/<name>`, so it mounts the same way →
`/<name>/` ([#1145](https://github.com/Omega-JS-Stack/omega/issues/1145)). `--direct` sets it around the build it runs itself; the
scaffolded CI workflow derives it remotely through the same function
(`@omega.js/web/deploy`'s `targetPathPrefix()`, which reads the repo from the
config alone). An explicitly exported value always
wins, and `omega dev` / a bare `omega build` stay at the root.

The direct lane deploys **both** Pages shapes ([#361](https://github.com/Omega-JS-Stack/omega/issues/361)): with a
`brand.url` naming your own domain it writes the CNAME and reports that domain;
without one it publishes a project site at the derived
`https://<owner>.github.io/<name>/`, mounted under the matching base path, with
no CNAME step at all. Plan address and build prefix come from one derivation,
and the repo is config-only: `websiteRepo(config, <target name>)`, never
`GITHUB_REPOSITORY` or a git remote, which name the repo the checkout sits in;
a config with no `repo.owner` refuses and names the key to set. A project site needs no `brand.url` at all: the
loader fills an unset one with its Pages address (`https://<owner>.github.io/<name>`,
no trailing slash), so the absolute URLs build from it, and the edge, domain and
cache-purge steps (and every other domain-managing service) skip it as no
domain to manage. Buying a domain later is one
line: `brand.url` becomes that domain.
A `*.github.io` host is **never** a custom domain: neither the deploy plan nor
the production build's `dist/CNAME` step reads one as such, so setting that
value keeps the project shape instead of flipping the site to the domain root.

Three lanes carry it ([path-prefix.js](src/path-prefix.js)): the rendered HTML
(`href`/`src`/`srcset`/`action`, which covers asset URLs, favicons, config-sourced
brand images and every internal link), the emitted CSS (`url()` targets — the
theme sheets' `@font-face` sources), and the runtime, which reads the value off
`<html data-omega-path-prefix>` through `core/js/libs/path-prefix.js` rather
than baking it into a bundle. Page IDENTITY stays site-relative:
`data-page-path` is the route, which is what the client's route checks compare
against. `omega dev` serves at the root and never sets one. ABSOLUTE URLs
(canonical, `og:url`, the sitemap) are built from `brand.url`, which for a
project site already carries the path — nothing prefixes them twice. Pinned by
`test/path-prefix.test.js`.

The translation pass reads the same stamp and composes **prefix, then
language** ([#359](https://github.com/Omega-JS-Stack/omega/issues/359)): a mounted link's route is read from
underneath the base path — which is also the route the exclusion list is
matched on — and the language segment mounts after it, `/workkit/es/pricing`.
Pinned by `test/translate.test.js`.

## Service worker (dev AND production)

Every build emits `/service-worker.js` + `/build.js` + `/build.json`;
@omega.js/client registers the worker at scope `/` on every page load
(`updateViaCache: 'none'`). Under a base path ([#360](https://github.com/Omega-JS-Stack/omega/issues/360)) it
registers `<prefix>/service-worker.js` at scope `<prefix>/` — the only scope a
script served from there can claim — and hands the prefix to the worker as the
`omega-path-prefix` query param on that URL, since a worker has no document to
read the `data-omega-path-prefix` stamp from. The worker mounts every site URL
it builds (`/build.js`, the default notification icon, the default click
target) under it; at the domain root nothing changes. Pinned by
`test/service-worker-mount.test.js`. Its `/build.js` import carries the same
`?cb=` stamp as the page's head tag, baked into the worker at build
(`__OMEGA_BUILD_STAMP__`), which is why the edge can cache `/build.js` for a
year. Pinned by `test/service-worker-stamp.test.js`. Push (FCM background messages) rides it —
`notifications.getToken({ serviceWorkerRegistration })` uses THIS
registration. **Cross-project safety on one localhost port**: registering
replaces whatever worker last claimed the origin (one registration per
scope), the fresh `/build.js` bytes force the update, `skipWaiting` +
`clients.claim` take over immediately, and the worker's boot evicts every
cache not named `<brand>-<cacheBreaker>`. A project that explicitly disables
the SW (`serviceWorker.enabled: false`) gets the origin swept clean instead
(`unregisterAll()`).

## The page paint contract

Every page this framework ships, and every page a brand builds on it, obeys one
contract about its first frame ([#637](https://github.com/Omega-JS-Stack/omega/issues/637)):
static content paints immediately and no page hides its DOM waiting for auth
(the global auth policy owns redirects); user data arrives through
`data-omega-bind` with skeletons, filled by @omega.js/client at auth settle; an
answer the visitor acts on — trial eligibility, the current plan, the price
being charged — keeps a skeleton on that spot alone and resolves ONCE, never
flipping between two answers; every network wait behind visible copy has a
deadline and a named fallback state; and every form's submit control stays
disabled until its `FormManager` gates resolve. The rules, the worked checkout
example, and the four questions to read a page against them:
[docs/web/page-contract.md](../../docs/web/page-contract.md).

## Architecture

- **Layered layouts** — layer chain `consumer _layouts → active theme →
  base → core`; the winning `_layouts/**` file per relative path is
  registered as an Eleventy v3 **virtual template** (build) or composed as a
  **symlink farm** (dev). Consumer-local layouts (sweet-saucy's recipe) are
  first-class; consumer `_layouts` is ignored as content (cwd-relative glob —
  `../`-relative input dirs miss bare `**/` globs).
- **Blueprint dispatch, plain names** — `layout: blueprint/pricing` →
  (core) blueprint carries the page-type defaults → `layout:
  frontend/pages/pricing` resolves through the theme layers (active wins,
  base fills). Plain names are the ONLY accepted form: the legacy bracket
  idiom (`themes/[ site.theme.id ]/…`) and hardcoded `themes/<id>/…` prefixes
  fail the build loudly — the B4 codemod rewrites them at migration
  (#148 removed the alias table).
- **Includes layering** — LiquidJS `root:` array over consumer `_includes`
  first, then theme layers, then core — EXISTING dirs only — with
  `jekyllInclude: true` and `cache: true` (without the parsed-template cache,
  re-parsing the 885-line core chrome per render was the corpus bottleneck).
- **`resolved`** — inject-properties.rb parity: `site config ← layout chain ←
  page data` (the site seed carries brand/theme/analytics/client/…;
  site collections and bulk keys excluded). Frontmatter values that reference
  `page.*` / `resolved.*` render per page, copy-on-write (layout defaults
  template on merged data — classy alternative's hero does this).
- **Jekyll site emulation** — `site.posts/team/updates/alternatives` are real
  arrays synced in place when collections compute (Eleventy captures the site
  object at data-init, so replacement or lazy getters would be invisible);
  `site.data._includes.*` is built from `.json` files in the layered include
  roots (UJM's json-data system: nav/footer/account/sidebar/topbar data);
  `paginator` compat maps Eleventy pagination to Jekyll's shape; `jekyll.
  environment` global.
- **Default pages, no copying** — `defaults/pages/**` registered as virtual
  templates UNLESS the consumer owns the same URL. The 404 lands at literal
  `/404.html` (static hosts need the file).
- **Assets** — every layer root follows one convention (`js/main.js`,
  `js/pages/**`, `js/layouts/**`, `css/main.scss`, `css/pages/**`,
  `css/layouts/**`, theme roots add `_theme.scss`/`_theme.js`).
  `__main_assets__/*` resolves to the core layer / themes dir, `__theme__/*` to
  the active theme (base fallback), `omega:<name>` to the same name from the
  layers below the importing file, `@omega.js/client` (subpaths included) to
  @omega.js/client. Every package the framework declares as a dependency
  resolves from the FRAMEWORK's installation for whoever imports it, so a
  consumer page module writes `import { defineChart } from '@tanstack/charts'` bare and
  shares one copy (one chunk) with core's own users of the library — the
  framework's copy wins even if the consumer declares its own; anything the
  framework does not declare the consumer declares itself. Manifest:
  `{ js: { main, firstPaint, pages, layouts, imports }, css: { main, critical, pages, layouts }, fontPreloads }`
  (`js.imports`: each entry URL → the chunks its static import chain loads, the page's modulepreload list); each `css.pages`/`css.layouts` entry is `{ inline }` (a sheet of 8 KB or less, printed as a `<style>` block) or `{ href }`.
  **One rule for page and layout assets, JS and CSS alike: every layer's file
  loads, in layer order** (core → theme → consumer), so each key holds a LIST —
  a framework page script always runs, the theme decorates, the consumer adds,
  and nothing replaces anything. The engine's `pageAssets` computed resolves
  each page's entries from the URL alone (the `asset_path` frontmatter override
  is dead — spec §7): exact key, then the per-page-dir `<key>/index` spelling,
  then `[name]` wildcard filenames (Next.js convention —
  `js/pages/blog/[slug].js` serves every `/blog/<slug>` post; a wildcard segment
  matches exactly one URL segment, exact beats wildcard, most-literal wildcard
  wins). `layoutAssets` does the same keyed by layout name, across the page's
  whole layout chain. Underscore basenames under `pages/` and `layouts/` are
  shared partials in both languages, never entries
  (`js/pages/legal/_document.js` backs the flat `terms`/`cookies`/`privacy`
  entries). `main.js` / `main.scss` are the exception: first layer wins, and it
  extends the layers below with `import coreMain from 'omega:main'` /
  `@use 'omega:main'`. Dev mode (`omega dev`): stable un-hashed names + no
  minify, so in-place asset rebuilds keep their URLs without an HTML re-render.
- **Boot runtime (ESM + code splitting)**: all bundles come out of ONE
  esbuild call with `splitting: true`, so `runtime/boot.js` and the web
  runtime instance it imports (`runtime/omega.js`, the `@omega.js/client` base
  class plus web's page chrome) land in a shared chunk the browser evaluates
  ONCE per page. Every `import omega from '@omega.js/web/runtime'`, in the
  main bundle, a page module or anywhere else, is the SAME initialized
  instance (one module graph, with `<script type="module">` semantics; both
  scripts are deferred and execute in document order). The handshake: main
  stub → `bootMain(mod)` (omega.initialize(window.OMEGA_BUILD_JSON.config) →
  dev lib in development → global module), page stub → `bootPage(mod)`
  (awaits the main boot, then `mod({ omega, options })`, the page-module
  contract every layout, page, section and theme module shares), layout
  stub → `bootLayout(mod)` (the layout module's NAMESPACE, whose default export
  is optional: the redirect layout hops at import time and exports nothing, so
  no stub may name a `default` esbuild can prove undefined, #742).
- **Scaffolding (`ensureTarget()`, every verb)** — devkit's defaults engine over
  `scaffold/`: marker-section merges live-sync .gitignore and .gitattributes
  (Custom sections preserved verbatim, a pre-marker file converging once), config/omega.json5 seeds then
  JSON5-defaults-merges (consumer values win), the Ruby-free CI workflow +
  .nvmrc re-template every run, `src/**` is consumer-owned after seeding.
  Inside a brand monorepo that CI workflow is composed into the BRAND ROOT
  as `.github/workflows/<app>-build.yml` — scoped to the app's dir, its own
  concurrency group — because GitHub runs workflows from the repo root only.
  NO pages are copied — the default set stays virtual. package.json scripts
  sync to the omega commands.
- **Migration (the web leg of the brand root's `omega migrate`)** converts a UJM consumer in
  place: legacy configs → omega.json5 keys the strict schema declares (shared sections
  with unified spellings: `analytics.providers.<p>.id`, `cloud.{provider,config}`,
  `payment` at the top level; the legacy `web_manager` blob renamed to the
  `client` client-settings key, and build settings under `targets.<name>`).
  Inside a brand that config merges into the brand root's `config/omega.json5`
  (an existing root value wins, each key kept or added is a report line) and
  a target's own `config/omega.json5` override layer is left alone; the
  manager's config pass judges the result. The codemod rule table over
  `src/**` templates (starting with `legacy-prefix`: `uj_*` tags/filters →
  `omega_*`, `site.uj` → `site.omega`, `uj-*` classes → `omega-*` — #44 retired
  those spellings with no aliases), seed `main.js` removal (the core main + boot runtime
  replace it), the `@use 'omega:main' with (…)` rewrite for theme-variable
  customization (the layered sass importer skips the requesting file, so a
  consumer main.scss configures the layers below it), page-css self-@use
  drops, liquid-lint, and legacy-file removal (Gemfile & co). It runs as the
  brand-root verb: `npx omega migrate --target=web` reports in memory and writes
  nothing, `--execute` converts. Nothing composes a runtime shape back (#894): the build
  writes the browser subset of the resolved config as `OMEGA_BUILD_JSON.config`
  into `/build.js` (@omega.js/config's `clientConfig`, the same file desktop's
  renderer and every extension context load, #743), and @omega.js/client maps the
  canonical homes onto its own contract: one home per value, one mapping for all
  three surfaces.

## Design tokens (C3)

[core/css/tokens/_index.scss](core/css/tokens/_index.scss) is the runtime
contract every theme consumes: `--omega-*` CSS custom properties (color,
radius, motion) defined light-first, redefined at the token level for
`prefers-color-scheme: dark`, and overridden in BOTH directions by the
`data-bs-theme` stamp appearance.js manages. Themes restyle by redefining
tokens — components read `var(--omega-*)`, never hardcoded values. The
sheet emits before the theme in main.scss (themes win at equal
specificity) and is pinned to ZERO sass deprecations — the bar for all
new core css. `brand.color` drives the accent family: the engine derives
a ramp ([@omega.js/devkit/brand-tokens](../devkit/src/brand-tokens.js): hover/active shifts,
WCAG-picked on-accent ink, subtle/ring alphas) and head.html emits it
inline AFTER the bundles so the brand wins the cascade. No/invalid color
→ the sheet's neutral placeholder stands. Token VALUES are C3 scaffolding
until Ian's direction notes land; the names + plumbing are the contract.

The categorical ramp (`--omega-chart-1`…`-6`) serves three surfaces from one
palette: chart series ([core/js/libs/charts.js](core/js/libs/charts.js) — the
framework's TanStack Charts, lazily split into its own chunks, so a chartless
page pays nothing), diagram slots ([core/js/libs/graph.js](core/js/libs/graph.js) —
the framework's mermaid on the same terms, mapped onto its `cScale`/`pie`
slots) and the `.omega-tone-<n>` / `.omega-badge-tone` chips
([core/css/core/_tones.scss](core/css/core/_tones.scss)), so the same thing is
the same color wherever it appears. A surface that means a STATUS passes the
status tokens instead (`colors: ['var(--omega-ok)', …]`) — semantics beat
categories. `.omega-interactive` (+ `--lift`) is the shared whole-surface
click affordance. All are core, so every theme inherits them:
[docs/shared/theming.md](../../docs/shared/theming.md).

The status hues (`--omega-ok`/`-warn`/`-danger`) each carry an `-rgb` channel
twin, and every theme's root bridge points Bootstrap's `--bs-success`/
`-warning`/`-danger` (and their `-rgb`) at them, so `bg-success`, `.text-success`
and a token-painted glyph are ONE color in both modes.

## Theming — two consumer tiers (C3)

**Tier 1 — restyle the stock theme.** Ship `src/assets/css/main.scss` in the
brand website app: the consumer layer leads the chain, so your entry wins
the layered `main.scss` lookup. Open with `@use 'omega:main' with (…)` — the
self-skipping `omega:` importer resolves to the next layer's entry, core
`@forward`s the active theme's variables (so `with (…)` configures them),
and your own rules land last to win the cascade. This is the migrated form
of UJM's `@use 'ultimate-jekyll-manager' with (…)` customization.

**Tier 2 — ship a full theme.** Put `themes/<id>/` in the brand website app
(own `_theme.scss`, `_layouts/`, `css/`, `js/`) and set `theme.id: "<id>"` —
consumer-local themes beat packaged ones ([resolveThemeLayers](src/layers.js)),
`omega dev` watches them, and anything the theme doesn't cover falls through
to `themes/base` (base's `_theme.scss` forwards classy's theme as the
default skin css).
A theme's script is its `_theme.js`, whose default export is
`async ({ omega, options }) => { }`: the site-wide wiring imports the active
theme's file (`__theme__/_theme.js`) and calls it with the page's instance,
the same shape as every page module.
Legacy `themes/<id>/…` layout spellings alias for consumer ids too.

## App shell (C3)

[core/css/shell/_index.scss](core/css/shell/_index.scss) is the
skin-independent structure for backend/admin surfaces: regions
(`.omega-shell__sidebar/topbar/main/scrim`, with `__topbar-start/-end`
slots and the `__sidebar-scroll` region that carries the nav's scrolling —
the rail itself clips nothing, so its popovers can escape) and states — desktop rail collapse (`data-shell-collapsed`,
persisted under `shell.collapsed`; `.omega-shell__label` text hides in the
rail), mobile drawer below 1200px (`data-shell-open` + scrim, matching
classy's xl cutover), and a `.omega-shell--locked` variant whose main never
scrolls (calendar/studio-style pages). Geometry only — every painted value
is a `var(--omega-*)` token, dimensions are `--omega-shell-*` custom
properties, and motion respects `prefers-reduced-motion`. Main pins its own
grid row, so a page that turns the topbar off (`theme.topbar.enabled: false`)
still scrolls inside main; `theme.sidebar.enabled: false` drops the rail and
the two topbar toggles that drive it. A topbar-off page that KEEPS its rail
renders `.omega-shell__drawer-toggle` instead, a floating control on the same
`data-shell-toggle="drawer"` handler, so the drawer is still reachable on a
narrow viewport (#719); and classy's content card reads the topbar's presence
(`:has(> .omega-shell__topbar)`) rather than assuming it, so main draws its
full frame when it is the whole card.
[core/js/core/app-shell.js](core/js/core/app-shell.js) drives it
declaratively (`[data-shell-toggle="collapse|drawer"]`,
`[data-shell-dismiss]`, Escape closes the drawer, `aria-expanded` synced)
and is the instance's `omega.shell`. The full contract markup is documented
at the top of the sheet; theme layouts emit it (one tree — no duplicated
mobile nav like classy's offcanvas). Because the state attributes are
stamped at runtime, `purgeCss` safelists `/omega-shell/`. Classy keeps its
Bootstrap shell untouched; the D10 skin's layouts adopt this contract.

## Pricing from config (C2)

`payment.products` in omega.json5 is the ONLY pricing source. The engine
composes `site.pricing` ([src/pricing.js](src/pricing.js)) — subscription
plans (config order), one-time products (own section, no billing cadence),
billing-toggle availability (both cadences must exist), an HONEST savings
badge (computed from real prices), and the feature-comparison matrix (tiers
inherit earlier plans' features) — and it surfaces as `resolved.pricing` in
every theme's pricing layout. Optional presentation fields per product:
`tagline`, `popular`, `url`, `hidden` (drops the product from every pricing
lane while checkout still resolves it by id), `features [{ id, name, icon,
definition, value }]` (value falls back to `limits[id]`; `-1` renders
Unlimited). Free plan = no prices → anchors to `/signup`. Empty catalog —
bare, or every product `hidden` — → an explicit `#pricing-empty` state + an
`omega build` warning — never fictional plans.
Consumer page frontmatter still overrides presentation per-page (hero copy,
`faqs`, `social_proof`, `pricing.enterprise`, `pricing.promo`,
`pricing.guarantee`, `pricing.price_per_unit`); the framework ships NO
fictional defaults (the dispersal-era `### ALL PAGES ###` marker convention
is dead — pinned by a contract test).

Trial and refund claims are GATED — the framework states neither on its own
([#273](https://github.com/Omega-JS-Stack/omega/issues/273)). A trial is
catalog data: `resolved.pricing.trialDays` is the one number a page may speak
UNIVERSALLY ("every paid plan starts with an N-day free trial"), so it exists
only when every PAID plan agrees on it — a catalog whose paid plans carry
different trials, or one selling no trial, resolves `0` and every universal
trial sentence (the pricing FAQ, the alternatives index and detail pages, the
checkout) renders empty and drops out, taking its FAQ accordion row and
FAQPage schema entry with it. Free plans have nothing to disagree with, and
each card still states its own `plan.trialDays`. A refund window is NOT
catalog data: money-back copy renders only from the brand's own
`pricing.guarantee`, so an absent guarantee means no window is promised
anywhere. Neither number is ever a framework default — the checkout's trial
sentence and renewal date read the product's real `trial.days`, never a
constant.

## Responsive images (the imagemin successor)

`omega build` re-encodes every jpg/jpeg/png under `dist/assets/images` into
the legacy UJM matrix — widths 320/640/1024 + the original size, each in the
source format AND webp, quality 80, metadata stripped, upscaling allowed so
every variant name always exists (`hero.jpg` → `hero-320px.jpg`,
`hero-320px.webp`, … `hero.webp` — `@srcset` markup never 404s). The original
NAME survives (re-encoded, so URL contracts hold), svg/gif/webp pass through
verbatim, the minted `favicon/` dir is exempt (exact-name mint contract), and
an undecodable file warns and ships verbatim — never a failed build.
`targets.web.imagemin.enabled: false` opts a brand out.

Outputs are reproducible binaries and NEVER commit: the content-addressed
cache lives at the brand's `.omega/cache/imagemin` (source or settings
changes re-process exactly what changed; stale entries prune every run), and
CI restores it via `actions/cache` in the scaffolded build workflow — the
`cache-uj-imagemin` branch successor. Dev never processes: `omega dev`
middleware rewrites missing `-NNNpx`/`.webp` variant URLs to the verbatim
original, so build-time markup resolves in dev too.

## Engine facts worth knowing (test-pinned)

1. LiquidJS has NO `forloop.parentloop` (renders empty) — hoist outer-loop
   values into `{% assign %}` vars (B4 codemod rule).
2. `{{ }}` inside QUOTED tag args is a silent no-op (upstream Jekyll too) —
   `{% capture %}` hoist.
3. Include paths must not lead with `/` (resolves outside LiquidJS roots).
4. Layout values resolve BEFORE preprocessors — a legacy bracket layout is a
   loud missing-layout error (the codemod rewrites it; nothing aliases it).
   `layout: none` must be dropped entirely (`null` breaks layout
   chains, `none` is a missing-layout error).
5. Same-process multi-builds need `setUseTemplateCache(false)` (tests only;
   the CLI is per-process).
6. `--incremental` doesn't narrow under collection-paginated templates —
   acceptable dev loop; B-phase optimization if it hurts.
7. Foreign cascade objects can carry throwing getters (Eleventy collection
   items' `templateContent` pre-render) — the copy-on-write renderer checks
   `'templateContent' in node` WITHOUT touching the getter (constructing
   those errors per item per page was ~19% of corpus CPU).
8. Eleventy's computed-data dependency pass probes with EMPTY-STRING proxies
   that persist into data — `permalink: ''` must count as absent, or every
   collection doc collides at `/index.html`.
9. Block-tag bodies must render LAZILY: a falsy `{% iftruthy %}` around a
   re-`{% assign %}` would otherwise clobber the outer value (side effects
   run even when output is discarded) — template-kit's adapter probes first,
   renders the body only when the tag asks for it.
10. Eleventy keeps global-data OBJECT REFERENCES but captures the key set at
    data-init: mutate arrays in place (site collections), never reassign.
11. Site-wide front-matter defaults: a root directory data file
    (`<srcDir>/<srcDirName>.11tydata.json`) sits ABOVE layout front matter and
    BELOW each page's own front matter — the one-place override for
    layout/blueprint sample content (jekyll-uj-powertools 1.8.1's `defaults:`
    layer; pinned in slice.test.js).

The bake-off's findings and scorecard are summarized in the CHANGELOG's Phase 2
Task 2.3, 2.3b, 2.4 and 2.5 entries. The codemod rule table from that decision
is EXECUTABLE as of B4: [src/migrate/rules.js](src/migrate/rules.js),
semantically proven in the suite (the capture hoist renders byte-identical to
a literal arg; the parentloop hoist renders the right outer indexes). B4 also
killed two real-data bugs: taxonomy terms now dedupe by slug (somiibo mixes
"Marketing" ×673 / "marketing" ×11 — Jekyll silently last-write-won, Eleventy
hard-errors), and the live somiibo interpolated-icon bug
(`class="fa text- display-4"`) is fixed in the packaged classy layouts (12
latent copies) AND forward in consumer files by the codemod.

## Not here yet (B5 + follow-ups)

`omega verify --against <jekyll-dist>` parity harness (B5 — the per-site
migration gate; the real somiibo URL-set diff, 2,556 vs Jekyll's 2,608 files,
is its first job) · the audit's HTML/spelling half (`omega audit` ports the
Lighthouse pass; the legacy html-validate + spellcheck sweep is still out) · UJM-setup post dedupe · named css
bundles, full icon set (B-phase pipeline) · engine consumption of
`targets.web.collections`/`defaults`/`generators` (migrate carries the config;
custom collections land with the sweet-saucy wave) · dev-loop re-render
narrowing + browser live-reload on asset rebuilds.

## License

[Elastic License 2.0](LICENSE). The source is free to use and modify; a
license key unlocks payments in production deploys and removes the
attribution (local dev and test payments are always free); and you may not
offer `@omega.js/web` to third parties as a hosted or managed service.
