# Breaking changes — legacy → OMEGA

The register of every contract that changed SHAPE between a legacy framework and
its OMEGA successor, with the by-hand migration step for each. Read it once per
legacy brand: work down the sections that apply and the brand lands on the new
contracts in one pass.

**No framework dual-reads a legacy form.** An old key, an old name, an old file
is not "deprecated but accepted" — it is unknown, and the loud ones fail
validation ([#142](https://github.com/Omega-JS-Stack/omega/issues/142)). The only
sanctioned legacy-reading paths are the one-time converter, the brand root's
`npx omega migrate` (a report by default, `--execute` converts: the brand config
first, then every target's own leg), and the mapping tables in
[config.md](config.md#migration--legacy-configs--omegajson5) for what it does not
convert.

**Legacy to OMEGA is `omega migrate`; OMEGA to newer OMEGA is by hand, here**
([#885](https://github.com/Omega-JS-Stack/omega/issues/885),
[#888](https://github.com/Omega-JS-Stack/omega/issues/888)). A shape OMEGA changes its
own mind about between two versions is a dated section in this register with its
by-hand step, never a migrate rule. Every `omega migrate` report ends on one line
naming this file inside the installed manager, so the by-hand steps sit one path
away from the run. A brand-root `omega update` that moves the manager pin ends on
the dated sections due since the version it moved from, by date and title, then
this file's path ([updates.md](updates.md#brand-root)).

**Boundaries.** What never got PORTED is [#78](https://github.com/Omega-JS-Stack/omega/issues/78)'s
gap tables, not this file. Converter TOOLING is
[#40](https://github.com/Omega-JS-Stack/omega/issues/40) — these rows are its
input, not its implementation. The legacy repos stay read-only reference
(AGENTS.md HARD RULE 1): nothing here asks you to change them.

## 2026-11-11: the web build derives the brand image from the brandmark ([#1066](https://github.com/Omega-JS-Stack/omega/issues/1066))

- No by-hand step: no file moves and no URL changes, and a target's own files keep winning. A fresh deploy is the whole migration.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The web favicon set, `brand/brandmark.svg`, `brand/brandmark.png`, `brand/social.png` | Minted by the manager into `.omega/assets/`, bridged by `MINT_BRIDGE` | The target's own file under `src/assets/images/`, else derived by the build from `assets/logo/brandmark.svg`, each checked on its own | None |
| The desktop app icon (`config/icons/<platform>/icon.png`) | Platform folder, then `global/`, then (Linux) `windows/`, then the bundled default | The same, with the brand's `assets/logo/brandmark.svg`, rasterized to 1024×1024, before the bundled default; the tray and dmg slots are unchanged | None |
| The extension icon (`config/icon.*`) | Every `config/icon.{png,svg}` was processed, and the svg's output landed last, so the svg shipped | `config/icon.svg`, then `config/icon.png`, then the brand's `assets/logo/brandmark.svg`, made into square icons; a target with both own files still ships the svg | None |
| `MINT_BRIDGE`, `mintBridgeSources` (`@omega.js/config`) | Exported | Gone | Drop any import of your own |
| The CI gate on a missing minted set | A CI build with a brandmark and no set failed | Gone: the build makes the set | None |
| The manager's `favicons` operation and `.omega/assets/favicon/` | Ran in the assets service | Gone; a leftover folder is unused cache | Delete the folder if you like |
| The deploy snapshot | Force-added the bridged files under `.omega/assets/` | Nothing under `.omega/` rides | None |

## 2026-11-11: a campaign's `providers` names roles only, and the newsletter generator publishes nothing itself

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A word in a campaign's `settings.providers` (a `marketing-campaigns` doc, `POST`/`PUT /marketing/campaign`, `sendCampaign()`) | A word that is no role (`sendgrid`, `beehiiv`, a typo) was dropped in silence, so the campaign went to the roles left in the list, or to none. The admin calendar's checkboxes wrote `sendgrid` and `beehiiv` | Only the role words `campaigns` and `newsletter`. Any other word fails the campaign with a coded 400 naming it (keyed by that word in the results), and nothing is sent on any role, so the cron marks it `failed` ([marketing-campaigns.md](../backend/marketing-campaigns.md#campaign-types)). It hits a stored campaign, or a caller of your own, still naming a provider | In every pending or recurring `marketing-campaigns` doc and every caller of your own, write `sendgrid` as `campaigns` and `beehiiv` as `newsletter` in `settings.providers`, or drop the key to send through every role that is on |
| The newsletter generator's result (`generators/newsletter.js` `generate()`) | The topical tags came back as `tags`, and the generator created its own Beehiiv post before the campaign send created a second one | The tags come back as `contentTags`, which the campaign send carries as the post's tags, and the result gains `report`, the report email's facts. The generator creates no post: `sendCampaign()` publishes the one post. It hits code of your own that calls `generate()` and reads `tags` | Read `contentTags` where your code read `tags` |
| `assets.beehiivPostId` on a generated `marketing-campaigns` doc | The id of the post the generator created | Gone. The one post's id is the doc's `results.newsletter.id`, written from the campaign send | Read `results.newsletter.id` where you read `assets.beehiivPostId`. Docs already written keep their old field |

## 2026-11-11: the snap is named `brand.id`, and a Linux package or release needs the snap login ([#851](https://github.com/Omega-JS-Stack/omega/issues/851))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The snap's name on the Snap Store | electron-builder's default: the desktop target's package.json `name`, lowercased (`playground-desktop`) | `brand.id` (`@omega.js/config`'s `snapName`), registered by `npx omega manage --service publishing` on the account `SNAPCRAFT_STORE_CREDENTIALS` logs in to. A brand that already published under the old name publishes a new snap, and its users stay on the old one | Run `npx omega manage --service publishing` with `snapcraft` installed. If the old name must stay, tell its users to switch (`snap remove <old>` and `snap install <brand.id>`), or drop the snap with `platforms.linux.formats.snap: false` |
| The Linux executable inside the deb, the AppImage and the snap, when the snap ships | The package.json `name`, lowercased | `brand.id`: electron-builder names the snap after `linux.executableName`, so the build pins it there. A `.desktop` file, script or launcher that calls the old binary name stops finding it | Point anything that runs the binary by name at `brand.id` |
| The Snap Store link (`site.targets.<desktop>.downloads.linux.snap`, `/download/linux/snap`) | `https://snapcraft.io/<the product name, sanitized and lowercased>` | `https://snapcraft.io/<brand.id>`, the same name the build pins and the walk registers | Nothing in config. Update any link to the old slug that you wrote by hand |
| A Linux package or release with the snap on and no `SNAPCRAFT_STORE_CREDENTIALS` | Skipped the snap target with a log line and built the deb and the AppImage | The `package` and `release` tasks FAIL first thing, naming `platforms.linux.formats.snap` and `SNAPCRAFT_STORE_CREDENTIALS`. A plain build, a dev run and a test boot make no installer and do not refuse. A mac or Windows package or release goes on. The generated workflow installs `snapcraft` on the Linux job whenever the snap ships, with no secret check | Set the key (`snapcraft export-login -`, or `npx omega manage --service publishing`), then `npx omega deploy` to flow it to CI, or set `platforms.linux.formats.snap: false` |

## 2026-11-11: the Google analytics provider id is `google` ([#1010](https://github.com/Omega-JS-Stack/omega/issues/1010))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The analytics provider id for Google (the catalog's `providers` keys, a descriptor's `provider`, the `providers` fire option, `@omega.js/analytics`'s `adapters`, the dev fire log) | `ga4`: `event(name, params, { providers: ['ga4', 'meta'] })`, `descriptor.provider === 'ga4'`, `require('@omega.js/analytics/adapters/ga4')`, the fire-log line `page_view → ga4 sent` | `google`, the same id as the config key `analytics.providers.google`, which does not change. Every provider fact lives in one row of `@omega.js/config`'s analytics-providers ([analytics.md](analytics.md#the-provider-rows)). An id no row has selects nothing, and a `providers` list still naming `ga4` says so: the `@omega.js/analytics` facade throws in development and logs a warning in production, and the backend's `deliverConversion` logs a warning and fires to the rest of the list. The old adapter path no longer resolves. It hits a brand whose own code passes a `providers` list naming `ga4`, compares a descriptor's `provider` to it, requires the adapter by path, or filters its logs on the old line | Rename `ga4` to `google` in every `providers` list, `provider` comparison and adapter require of your own, and in any log filter reading the fire line. The brand config needs nothing |

## 2026-11-11: the extension's translated store description is cached in `description.json` ([#905](https://github.com/Omega-JS-Stack/omega/issues/905))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| An extension target's saved translation of `config/description.md` | `translations/<lang>/description.md`: the translated markdown under a first line `<!-- omega:source <hash> -->` naming the source it was translated from | `translations/<lang>/description.json`: `{ "<hash of the source>": "<the translated markdown>" }`, the same per-string cache every other translation uses, filled by the one cached call ([translation.md](translation.md#the-one-cached-call-translatecached)). Nothing reads the old file, so a target still carrying only `description.md` ships no translated store description, and a build on a CI runner warns that `description` is cold for each language | For each `translations/<lang>/description.md` whose marker hash still equals the first 12 hex characters of the sha256 of the current `config/description.md`, write `translations/<lang>/description.json` holding that hash as the key and the file's text below the marker line as the value, then delete the `.md`. Where the hash differs, delete the `.md` and run `npx omega build` on your own machine to retranslate. Commit `translations/` |

## 2026-10-30: a desktop view with a leftover token fails the build; the templating `brackets` option is gone ([#1127](https://github.com/Omega-JS-Stack/omega/issues/1127)); the backend slugifier is the client's ([#1130](https://github.com/Omega-JS-Stack/omega/issues/1130))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A `{{ }}` token nothing resolves in a desktop view (`src/views/**/*.html`) or the page template around it | The desktop html task wrote the token literally into `dist/views/<name>/index.html` and the build passed, so the app shipped a page reading `{{ brand.nmae }}` | The build fails naming the view and every leftover token: `Cannot build src/views/main/index.html: unresolved token(s) {{ brand.nmae }}. Check config/omega.json5 and the token spelling`, the same failure the extension's html task already raised ([desktop/templating.md](../desktop/templating.md)). It hits a desktop target whose views carry a misspelled token, or one naming a config key the brand never set | Run `npx omega build --target=<name>` at the brand root and, for each token the failure names, fix its spelling or set the key it reads in `config/omega.json5` |
| `render(input, vars, opts)` of `@omega.js/desktop/lib/templating` | A third `{ brackets }` argument swapped the token delimiters, so `render('Custom [name]', vars, { brackets: ['[', ']'] })` rendered `[name]` | `render(input, vars)` renders `{{ }}` tokens only, through devkit's one renderer; a third argument is ignored, so other delimiters pass through as written ([desktop/templating.md](../desktop/templating.md)). It hits a brand whose own hook or build code passes `{ brackets }` | Drop the third `{ brackets }` argument from every `render` call of your own, and spell those tokens `{{ name }}` |
| `omega.utilities.slugify(input)` (backend) | The backend's own slugifier split on an apostrophe and answered `''` for a non-string, so admin/post saved a post whose `url` was "Don't Panic" at `/blog/don-t-panic`, and the newsletter's article CTA linked there | It is @omega.js/client's one slugifier ([client/modules.md](../client/modules.md#slugify-slugifyjs)): an apostrophe, straight or typographic, is deleted, so the same post lands at `/blog/dont-panic`, and a non-string is stringified first. It hits a post published with an apostrophe in its `url`: the Ghostii article lane (the newsletter, the blog auto-publisher, marketing campaigns) passes the title as the `url`. A slug the web post editor filled in is already the client's and does not move | For each published post whose stored URL carries a `-t-`-style apostrophe split (a link, a sitemap entry, a sent newsletter), re-save the post at the new slug or add a redirect from the old URL to the new one |

## 2026-10-29: Node 24 is the floor outside Cloud Functions ([#1126](https://github.com/Omega-JS-Stack/omega/issues/1126))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `engines.node` of `@omega.js/web`, `@omega.js/desktop`, `@omega.js/extension`, `@omega.js/manager` and `@omega.js/mcp-router` | `>=22` on every package | `>=24` on every package that never runs inside Cloud Functions; `@omega.js/backend` and `@omega.js/client` keep `>=22`, the runtime the backend's `omega.functionsRuntime` pins ([publishing.md](publishing.md#what-publishes-what-never-does)). It hits a brand whose machine or CI job still runs Node 22 for the brand root, web, desktop or extension: npm warns `EBADENGINE` on every install there, and an extension target's next verb regenerates its `.nvmrc` and its workflow's `NODE_VERSION` to 24 | Move that machine and every such CI job to Node 24 (`nvm install 24`, an `.nvmrc` of `v24`). The backend target stays on 22 and needs nothing |

## 2026-10-20: the auth return param is `returnUrl`, the contact person is gone, desktop sign-out rejects, a brand's own user keys reach `User` ([#831](https://github.com/Omega-JS-Stack/omega/issues/831), [#824](https://github.com/Omega-JS-Stack/omega/issues/824), [#960](https://github.com/Omega-JS-Stack/omega/issues/960), [#955](https://github.com/Omega-JS-Stack/omega/issues/955))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The auth return-destination query param (web, desktop, extension, backend CLI) | `authReturnUrl` on `/signin`, `/signup`, `/reset` and `/token`, in desktop's `getAuthUrl()` chain, in the extension's `omega.auth.openPage({ authReturnUrl })`, and in the URL `npx omega auth:token --return` prints; the web helper `updateAuthReturnUrl()` | `returnUrl` on every hop, the extension option `openPage({ returnUrl })`, the web helper `updateReturnUrl()`. Nothing reads the old name, so an `authReturnUrl` is ignored and the auth page goes to its default ([desktop/environment-detection.md](../desktop/environment-detection.md), [web/libs.md](../web/libs.md)). It hits every brand whose own code builds an auth link or calls either name, and every INSTALLED desktop or extension app built before this release: its baked auth URL carries the old name, so its sign-in never returns to the app | Rename `authReturnUrl` to `returnUrl` in every link, redirect and `openPage()` call of your own, and `updateAuthReturnUrl` to `updateReturnUrl`. Then rebuild and ship the desktop and extension apps on this release alongside the website deploy |
| `brand.contact.person` (config) and the signup emails' signoff | `brand.contact.person` (`name`, `firstName`, `image`, `url`, `urlText`) in `omega.json5`; the welcome, discount-nudge and checkup emails signed off as that person and failed without one | Gone from the config schema: a config still carrying it fails the load as an undeclared key. The three sends sign off as the brand's team, and a send names a person only when its caller passes its own `personal` signoff ([backend/email-system.md](../backend/email-system.md)). It hits every brand whose config carries the block | Run `npx omega migrate --execute` at the brand root: it deletes `brand.contact.person`. By hand, delete the block from `config/omega.json5` |
| Desktop sign-out on a failure (main and renderer) | Main's `omega.auth.signOut()` and the renderer's `omega.signOut()` resolved `{ success: false, error }` when the Firebase sign-out failed, so the `.omega-signout` trigger showed its success notice | Both resolve `{ success: true }` or reject with the Firebase error; a failed sign-out broadcasts nothing, and the trigger shows its failure notice ([desktop/auth.md](../desktop/auth.md#sign-out-flow)). It hits desktop code that reads `success` off either call | Wrap each call your own code makes in `try`/`catch` (or `.catch()`) where it read `success`, and await it, so a failure is never an unhandled rejection |
| A brand's own top-level keys on the user document (account, every surface) | The account schema's root stripped every key it did not declare, so a brand's `users/{uid}.notes` never reached `User`, `ctx.user`, desktop main's or the extension background's `auth.user`, or `toJSON()`; a stored `plan` was ignored | The root passes a brand's own top-level keys through into `User` on every surface ([client/modules.md](../client/modules.md)). A stored key named like a `User` property (`authenticated`, `uid`, `email`, `plan`, `active`, `trialing`, `cancelling`, `everPaid`, `toJSON`, `profile`) throws, naming it, and the framework Firestore rules now deny a client write of any of those names. It hits a brand whose user documents still carry a legacy top-level `plan` (that user's `User` throws), and code that counted on an unknown key being stripped from `toJSON()` or an API response | Run `npx omega manage --migration=users` at the brand root to audit, then `--migration=users --execute`: it deletes a legacy top-level `plan` (folding it into `subscription` when the document has none). Rename any other stored key of your own that carries one of those names, and stop writing a key you never meant to keep |

## 2026-10-19: the Jekyll-era filters take `omega_*` names ([#830](https://github.com/Omega-JS-Stack/omega/issues/830))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The template helper filters (web) | `slugify`, `date_to_xmlschema`, `date_to_rfc822`, `jsonify`, `strip_html`, `number_of_words`, `where_exp`, `group_by_exp`, `relative_url`, `absolute_url`, `markdownify` | `omega_slugify`, `omega_date_xmlschema`, `omega_date_rfc822`, `omega_jsonify`, `omega_strip_html`, `omega_number_of_words`, `omega_where`, `omega_group_by`, `omega_relative_url`, `omega_absolute_url`, `omega_markdownify`, the same behavior. An old name throws at render naming its replacement, so the build fails naming the file and the replacement ([web/template-kit.md](../web/template-kit.md)) | Run `npx omega migrate --target=<name> --execute` at the brand root: its `compat-filters` rule rewrites each `\| <old>` to `\| <new>`, and the report's `jekyll-filter` errors name any leftover. By hand, rename each call from the old form to the new |
| `omega_jsonify`'s default output | Pretty-printed at an indent of 2 | Compact; `omega_jsonify: 2` pretty-prints, and an absent value is `null`. A legacy `uj_jsonify` lands on it through `legacy-prefix`, so it is compact now too | A call that wants pretty output passes the indent: `\| omega_jsonify: 2` |

## 2026-10-19: the chart builders are one `chart()` entry ([#828](https://github.com/Omega-JS-Stack/omega/issues/828))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The charts helper (`__main_assets__/js/libs/charts.js`) | Four builders, `barChart(id, data)`, `stackedBarChart(id, data)`, `doughnutChart(id, data)` and `lineChart(id, data)`, each a function of its own | One entry, `chart(id, kind, data, options)`, `kind` one of `bar`, `stacked`, `doughnut`, `line`; the data grammar is unchanged. A shape the four kinds lack is an `options.definition(lib, colors, data)` function on the page, never a new builder ([web/libs.md](../web/libs.md)) | Replace `barChart(id, data)` with `chart(id, 'bar', data)`; `stackedBarChart` becomes kind `stacked`, `doughnutChart` kind `doughnut` and `lineChart` kind `line` |

## 2026-10-12: a brand's e2e lane is `defineCases` suite files ([#984](https://github.com/Omega-JS-Stack/omega/issues/984))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A brand's own browser lane (`<brandRoot>/test/e2e/`) | ONE entry file, `test/e2e/run.js`, a script the brand-root `omega test` spawned as `node test/e2e/run.js` after the targets; a folder with no `run.js` was skipped in one line | Every `*.test.js` under `test/e2e/` is a `defineCases` suite the brand-root `omega test` runs in-process after the targets, on a bare run only, with a `test/e2e` row in the summary; a failing case fails the run like a target. A `run.js` there is ignored, and a folder with no suite file runs empty and green ([manager/brand.md](../manager/brand.md)) | Rename `test/e2e/run.js` to `test/e2e/<concern>.test.js` and make it `module.exports = defineCases({ type: 'suite', description, timeout: 300000, setup(ctx), cleanup(ctx), tests })` (`require('@omega.js/devkit/test/define-cases')`): `setup` skips on `OMEGA_SKIP_E2E=1` (`ctx.skip('OMEGA_SKIP_E2E=1')`), else builds the harness on `ctx.state` and awaits `boot()`, plus the browser and page; `cleanup` awaits `teardown()` when the harness was built. Each `harness.step(name, fn)` becomes a case `{ name, async run(ctx) { ... } }` in the same order, reading what the steps shared from `ctx.state`. Drop the `try`/`finally`, `harness.exit()`, and any `package.json` script that ran `node test/e2e/run.js` |
| `E2eHarness` (`@omega.js/devkit/test/e2e-harness`) | `boot()`, `launchBrowser()`, `preparePage(page)`, `step(name, fn)`, `failures`, `teardown()`, `exit()`, and a `steps.log` of `PASS` / `FAIL` lines in `test/e2e/.logs/` | `boot()` (rejects naming the leg that failed), `launchBrowser()`, `capturePageConsole(page)`, `preparePage(page)` and `teardown()`; `step`, `failures`, `exit` and `stepsLog` are gone, and no `steps.log` is written. A case's verdict is its line in the run's log (`logs/test.log` at the brand root); `test/e2e/.logs/` keeps `emulator.log`, `dev.log` and `page.log` ([devkit/index.md](../devkit/index.md)) | Move each step body into its case; a script that read `steps.log` greps the run log for `✗` instead |

## 2026-10-11: desktop and extension boot suites take `run(ctx)` ([#984](https://github.com/Omega-JS-Stack/omega/issues/984))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A boot case (desktop and extension `layer: 'boot'`) | `{ description, inspect: async ({ omega, expect, projectRoot, appRoot, frameworkDistRoot, distSnapshotBefore }) => { ... } }` on desktop, `inspect: async ({ extension, page, expect, projectRoot }) => { ... }` on extension, a standalone spec's `inspect` included | `{ name, run: async (ctx) => { ... } }`, the case every other layer takes: the old arguments are `ctx` keys (`ctx.omega`, `ctx.appRoot`, ... on desktop; `ctx.extension`, `ctx.page` on extension) beside `ctx.expect`, `ctx.waitFor`, `ctx.state` and `ctx.skip`. A standalone spec with no `run` fails its file by name, and a case with none fails ([desktop/test-boot-layer.md](../desktop/test-boot-layer.md#test-shape)) | Rename each case's `description` to `name` and its `inspect` to `run`; make the body read `ctx.<key>` for each destructured argument and `ctx.expect` for `expect` (or destructure inside: `const { omega, expect } = ctx;`). A body that runs inside the app is rebuilt from its text, so its parameter list is `(ctx)` or `()`: a destructured `({ omega })` fails that case naming the file. An extension boot suite that needs longer than the 30s default declares `timeout: 45000` at suite level |
| A suite that runs in one of the project's own built views | `layer: 'renderer'` (desktop) or `layer: 'view'` (extension), plus `view: '<name>'`, quietly moved to the boot lane | `layer: 'boot'` plus `view: '<name>'`. `layer: 'renderer'` and `layer: 'view'` always mean the framework's harness page; a `view` left on either fails the file at load, naming it | Change the suite's `layer` to `'boot'` and keep its `view` |
| A page body's view of the page | The page globals only (`window`, `document`); desktop's harness page ran a smaller `expect` of its own | `ctx.page` is the page's `window`, and `ctx.expect` is devkit's one `expect` in every page, every matcher, `.not` and `.rejects` included | None: `window` and `document` still work; `ctx.page` is the portable spelling |
| `npx omega test` output and flags on desktop and extension | `--layer=all` named every layer; `--reporter=json` printed the pretty run plus a `{"event":"summary",...}` line | No `--layer` runs every row (`all` is gone); `--reporter=json` prints one JSON document on stdout, the run's result, and every other line goes to stderr. One Results block for the run | A script that passed `--layer=all` drops the flag; one that parsed the `summary` line reads the document's `passed`, `failed` and `skipped` |

## 2026-10-05: web suites are `defineCases` files ([#984](https://github.com/Omega-JS-Stack/omega/issues/984))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A web suite (`targets/<web>/test/**/*.test.js`) | A plain `node --test` file: `const test = require('node:test')`, `const assert = require('node:assert')` (or `node:assert/strict`), `test('name', () => { assert.ok(x); })`, run by `node --test` after the build and smoke checks | A `defineCases` file run by devkit's case runner, each file in its own process: `const { defineCases } = require('@omega.js/web/test')`, `module.exports = defineCases({ type: 'group', description, tests: [{ name, run: (ctx) => { ctx.expect(x).toBeTruthy(); } }] })`. `node:test` and `node:assert` are gone from every web suite ([web/test-framework.md](../web/test-framework.md#writing-consumer-tests)) | Convert each `test/**/*.test.js` by hand: swap the two requires for `const { defineCases } = require('@omega.js/web/test')`; make each `test('name', fn)` a case `{ name, run: (ctx) => { ... } }` in one `defineCases` group (a `describe` name joins the case name); move a `before`/`after` hook to the group's `setup`/`cleanup`, and a `beforeEach`/`afterEach` body into each case, its teardown as `ctx.after(fn)`; turn each `assert.*` into its `ctx.expect` matcher, as the 2026-10-03 backend entry maps them, with `equal`/`strictEqual` to `toBe` and `deepEqual`/`deepStrictEqual` to the strict `toEqual`. A helper outside a case asserts with the file-level `expect`, so that file requires `{ defineCases, expect }`. A case that fails under the strict matchers is fixed in its expectation, never with a looser matcher |
| The smoke checks | Inline in the verb: one failed check threw `Smoke checks failed` and ended the run before the project suites | Five cases of one `smoke` group, run first, in the same Results block as your suites; a failed case stops no other case, and your suites still run | None |
| A web path target (`npx omega test pages`) | A shell prefix glob: `test/<path>*` for the project, `test/<path>*.test.js` for the framework | The runner's contains match on each suite's root-relative path; it narrows the smoke suite too, so `npx omega test build/notes` runs that suite alone, with no smoke case ([web/test-framework.md](../web/test-framework.md#scope-grammar)) | A target that now selects more than you meant takes a longer path to narrow; `npx omega test smoke` runs the smoke cases alone |
| `npx omega test` flags on web | None of its own: every flag went to the build | `--filter`, `--layer` (`build`, web's one layer), `--lane`, `--extended` and `--reporter=pretty\|json` ride to the runner as on backend; every other flag still reaches the build | None |

## 2026-10-03: backend suites assert with expect ([#984](https://github.com/Omega-JS-Stack/omega/issues/984))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A backend suite's assertions | `run({ assert })` (and a file-level `require('node:assert')`): `assert.ok`, `equal`/`strictEqual`, `deepEqual`/`deepStrictEqual`, `notEqual`/`notStrictEqual`, `match`, `notMatch`/`doesNotMatch`, `isSuccess(r, m?)`, `isError(r, code?, m?)`, `hasProperty(o, p, m?)`, `propertyEquals(o, p, v, m?)`, `isType(v, t, m?)`, `contains(a, v, m?)`, `inRange(v, lo, hi, m?)`, `fail(m)`, `throws`, `doesNotThrow`, `rejects` | `run({ expect })`, devkit's `expect(actual, message?)`: `ok` is `toBeTruthy()`; `equal`/`strictEqual` `toBe`; `deepEqual`/`deepStrictEqual` `toEqual`; `notEqual`/`notStrictEqual` `.not.toBe`; `match` `toMatch`; `notMatch`/`doesNotMatch` `.not.toMatch`; `isSuccess(r, m)` `expect(r, m).toBeSuccess()`; `isError(r, code, m)` `expect(r, m).toBeError(code)`; `hasProperty(o, p)` `toHaveProperty(p)`; `propertyEquals(o, p, v)` `toHaveProperty(p, v)`; `isType(v, t)` `toBeTypeOf(t)`; `contains(a, v)` `toContain(v)`; `inRange(v, lo, hi)` two calls, `toBeGreaterThanOrEqual(lo)` then `toBeLessThanOrEqual(hi)`; `fail(m)` `expect.fail(m)`; `throws`/`doesNotThrow`/`rejects` `toThrow`, `.not.toThrow()`, `.rejects.toThrow()`. A trailing message rides as `expect`'s second argument, and a helper outside a case body takes `expect` from `@omega.js/backend/test`. `ctx.assert` is gone ([backend/test-framework.md](../backend/test-framework.md#expect-matchers)) | Convert each suite by hand with the map in the previous column: swap `run({ assert })` for `run({ expect })`, rewrite each call to its matcher, move a trailing message to `expect`'s second argument, and drop the file-level `require('node:assert')`. A suite-level `auth` stays as it is |
| `test/_init.js` on backend | `module.exports = ({ config, omega }) => ({ accounts, setup })`, read by the backend runner's own loader | devkit's factory, the one desktop, extension and web read: `({ projectRoot, config, omega, ctx }) => ({ accounts?, setup?(ctx) })`, its `setup` called with `{ projectRoot, admin, config, accounts, omega, ctx }`. A file that fails to load, exports a non-function, whose factory throws or returns a non-object, or whose `setup` throws, fails the run naming the file | None for a hook that returns `{ accounts, setup }`. A hook that throws now stops the run, so fix it |
| A custom-server backend's `test/_init.js` `setup` | Never ran: a custom-server run skipped the seed and every hook's `setup` with it | Runs once per run, before the first case, with `accounts: null`, since nothing is seeded on a custom server ([backend/test-framework.md](../backend/test-framework.md#the-runner)) | A setup that reads accounts guards on `null` |
| A backend path target (`npx omega test payments`) | Selected a suite whose path relative to `test/` started with the text, or the one file it named exactly | Selects every suite whose relative path CONTAINS the text, devkit's shared rule: `payments` selects `routes/payments/...` and `helpers/payments-meta...` alike ([backend/test-framework.md](../backend/test-framework.md#filtering-tests)) | A target that now selects more than you meant takes a longer path to narrow |
| How the backend test host boots the instance | `OMEGA_TEST_RUNNER` in the runner's env made `initialize()` skip the Firebase init, the function wiring, the server and Sentry | `initialize({ runnerHost: true })`, a boolean option (default `false`); no env name ([backend/index.md](../backend/index.md#the-consumer-entry)) | Code that set `OMEGA_TEST_RUNNER` to boot the instance as a test host passes `initialize({ runnerHost: true })`. A brand that only runs `npx omega test` needs nothing |

## 2026-10-02: one name says a test run is on ([#931](https://github.com/Omega-JS-Stack/omega/issues/931))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| How a process learns a test run is on | Two env names beside the one environment input: `OMEGA_TEST_MODE=true` (set by the backend test and emulator lanes; `envEnvironment()` resolved it to `testing`) and `OMEGA_TEST_RUNNER` (set by the backend test host and the desktop runner; it killed Sentry) | `OMEGA_ENVIRONMENT=testing`, set by every test lane in the child env it builds, and read by `isTesting()` from `@omega.js/config/environment`. `envEnvironment()` reads no test name: an already-set `OMEGA_ENVIRONMENT`, then `ENVIRONMENT=production`, then the development signals, else production. Sentry's test gate is `isTesting()` ([monitoring.md](monitoring.md#the-switches)) | A script, CI step or shell export that sets either sets `OMEGA_ENVIRONMENT=testing` instead; brand code that reads either calls `isTesting()` (`omega.isTesting()`, `ctx.isTesting()`). The extension test harness no longer sets a `globalThis.OMEGA_TEST_MODE` global: a background suite that read it calls `isTesting()`. A brand that only runs `npx omega test` needs nothing |
| devkit's runner marker | `OMEGA_CASE_RUNNER`, set by a runner so `defineCases()` knew a real runner was loading case files | Gone, with no successor: `defineCases()` reads no env var, and a case file registers its own cases only when it is the main module or runs under `--test`. A runner `require`s the file, so it is never main | None: a script that set it needs nothing, so drop the line |

## 2026-10-02: source maps ship in `dist` ([#1064](https://github.com/Omega-JS-Stack/omega/issues/1064))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A production bundle's source map | None: `bundle()` wrote a map in a dev build only | A `<file>.js.map` beside every bundle and chunk in every mode, each `.js` ending in its `sourceMappingURL` comment. A web deploy publishes them with the site, public; the extension package and the desktop packager leave `*.map` out ([devkit](../devkit/index.md)) | None. A brand whose browser source must stay unreadable on its live site has no switch to turn them off |

## 2026-10-02: a user can link several accounts of one connection provider ([#1061](https://github.com/Omega-JS-Stack/omega/issues/1061))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The stored connection record | `users/{uid}.connections.<provider>`: one record `{ type, token, identity, updated }` per provider | `users/{uid}.connections.<provider>.<identityId>`: the same record one level down, keyed by the account's `identity.id`, so a user can hold up to `connections.<provider>.max` accounts of a provider (default 1) ([connections.md](../backend/connections.md)) | Run the manager's `users` migration (`--execute`) BEFORE or WITH the backend deploy: it moves each one-level record under its `identity.id` and leaves a keyed provider alone. Until it runs, a user still in the old shape shows no linked account and can connect again; the migration keeps an account connected meanwhile, and drops the old record when that account is the same identity. A legacy record with no `identity.id` has nothing to key it under and is dropped, one log line naming the uid and the provider (the audit run lists them first). Brand code that reads `connections.<provider>.token` reads `connections.<provider>.<identityId>.token` |
| `status`, `refresh` and `DELETE` on `/omega/user/connections` | `provider` alone named the one record | `provider` plus `id` (the identity id). Without `id`, the one account a user holds serves the call; several answer a 400 naming `id`, and `status` lists them all as `{ connections: [{ id, identity, status }] }` | A brand page or service that calls these for a provider whose `max` is above 1 passes `id`. One-account brands need nothing |

## 2026-10-02: the edge service owns the zone's Cloudflare Web Analytics ([#1070](https://github.com/Omega-JS-Stack/omega/issues/1070))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Cloudflare Web Analytics on the brand zone | A dashboard switch only; the manager never touched it | `edge.providers.cloudflare.webAnalytics.enabled`, default `true`, reconciled by the edge service's `web-analytics` operation. The first manage run of a brand whose zone has no Web Analytics site CREATES one with automatic install, so the zone starts injecting the beacon, which sits outside the consent gate. Every update sends `auto_install: true`, so a site set up for a hand-installed snippet becomes an automatic one ([edge.md](../manager/edge.md)) | A brand that must not carry the beacon sets `edge.providers.cloudflare.webAnalytics.enabled: false` in `config/omega.json5` before its next manage run. Add "Account Settings Write" to `CLOUDFLARE_TOKEN`, or the operation warns and skips |

## 2026-10-02: the backend refuses a connection provider that is not enabled ([#1071](https://github.com/Omega-JS-Stack/omega/issues/1071))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `connections.<provider>.enabled` | Decided only whether the account page offered the provider's card; the backend never read it, so a brand page could drive `authorize`, `tokenize` and `refresh` for a provider that resolved `false` | The backend refuses `authorize`, `tokenize` and `refresh` with a 400 naming the key to set when the resolved value is `false`, and the five packaged providers (Google, Discord, Spotify, Twitch, Kick) resolve `false` by default. `status` and the delete still answer ([connections.md](../backend/connections.md)). Affects a brand that set a packaged provider's `CONNECTIONS_<PROVIDER>_*` credentials, never set `enabled: true`, and drives the routes from its own page | Set `connections.<name>.enabled: true` in `config/omega.json5` for every packaged provider the brand uses. A brand's own provider needs nothing: it is on unless its entry sets `false` |

## 2026-10-02: Firestore and messaging load on first use ([#1062](https://github.com/Omega-JS-Stack/omega/issues/1062))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The client's Firestore instance | `omega.firebaseFirestore`, a sync getter filled at boot | `await omega.loadFirebaseFirestore()`: one memoized promise of the instance, the SDK imported on the first call (the emulator connected inside it on a local stack). It rejects on a page with no Firebase app, so gate on `omega.firebaseApp` first ([client architecture](../client/architecture.md#what-boot-loads-and-what-waits-for-first-use)) | In page code, replace each `omega.firebaseFirestore` read with `await omega.loadFirebaseFirestore()` inside an async function, and a truthiness check on it with `omega.firebaseApp`. The `omega.firestore` wrapper needs no change |
| The client's Messaging instance | `omega.firebaseMessaging`, a sync getter filled at boot (null without service worker or push support) | `await omega.loadFirebaseMessaging()`: one memoized promise of the instance, null without service worker or push support. `omega.notifications.isSupported()` stays sync | Replace each `omega.firebaseMessaging` read with `await omega.loadFirebaseMessaging()`, gated on `omega.firebaseApp`; a support check reads `omega.notifications.isSupported()` |

## 2026-10-02: a seo item's token is named, never written ([#1059](https://github.com/Omega-JS-Stack/omega/issues/1059))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A seo content item's token override | `author: { token: 'env:GH_SOCK' }` (or a literal token) on an item of `seo.github.content` | `author: { tokenEnv: 'GH_SOCK' }`: the NAME of a `.env` variable, read from the environment by the seo walk, which fails the item when it is unset. The loader reads `config/seo.json5` as the `seo` section, so the strict schema refuses `seo.github.content[<i>].author.token` at load, and the secret check refuses it in either file | Run `npx omega migrate --execute` at the brand root: it moves each `env:` value to `author.tokenEnv` in `config/omega.json5` and `config/seo.json5`. A literal token is refused and left in place: put it in `.env` as a variable and write `author.tokenEnv: "<NAME>"` by hand |

## 2026-10-01: the repo block's owner key is `repo.owner` ([#1041](https://github.com/Omega-JS-Stack/omega/issues/1041))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The repo block's owner | `repo: { provider: 'github', org: 'Acme-Org' }` | `repo: { provider: 'github', owner: 'Acme-Org' }`: a GitHub user or org, GitHub's own word for it. The strict schema refuses `repo.org`, naming `npx omega migrate` | Run `npx omega migrate --execute` at the brand root: it moves `repo.org` to `repo.owner` |
| `omega onboard`'s owner flag | `--org=<owner>` | `--owner=<owner>`; `--org` is no flag at all, so it writes no `repo` block | Type `--owner` where a script passed `--org` |
| The `/brand` payload's `repo` | `{ provider, org }` | `{ provider, owner }` | A client reading `repo.org` from the payload reads `repo.owner` |
| A seo content item's owner override | `org` on an item of `seo.github.content` | `owner` on the item. The strict schema refuses `seo.github.content[<i>].org`, naming `npx omega migrate`, at load, in `config/omega.json5` and in the `config/seo.json5` sidecar alike | Run `npx omega migrate --execute` at the brand root: it moves each item's `org` to `owner`, in `config/omega.json5` and in `config/seo.json5` |

## 2026-10-01: a default desktop format owes its keys ([#1035](https://github.com/Omega-JS-Stack/omega/issues/1035))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `SNAPCRAFT_STORE_CREDENTIALS` on a desktop target | Owed only when the config wrote `platforms.linux.formats.snap`, so a defaulted snap owed nothing and the build skipped it quietly | Owed whenever the target ships the snap, which is on by default: `omega manage` asks for it, and `omega publish` and the deploy's secrets check refuse without it, naming `platforms.linux.formats.snap` | Set the key (`snapcraft export-login -`, or `npx omega manage --service publishing`), or turn the format off with `platforms.linux.formats.snap: false` (or `platforms.linux: false`) |
| `WIN_EV_TOKEN_PATH` and `WIN_CSC_KEY_PASSWORD` on a desktop target | Owed only when the config wrote `platforms.windows.signing.strategy: 'self-hosted'` | Owed whenever the target ships the Windows installer (`platforms.windows.formats.nsis`, on by default) and signs it self-hosted, the default strategy | Set both keys, pick another `platforms.windows.signing.strategy` (and its own keys), or turn the installer off with `platforms.windows.formats.nsis: false` (or `platforms.windows: false`) |

## 2026-10-01: the omega plugin comes from GitHub, never from the manager package ([#1028](https://github.com/Omega-JS-Stack/omega/issues/1028))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A brand's committed `.claude/settings.json` | The `omega` marketplace as a `directory` source at `./node_modules/@omega.js/manager`, `omega@omega` on | The `omega` marketplace as the GitHub source `Omega-JS-Stack/omega` (sparse: `.claude-plugin`, `agent-plugins/claude`) with `autoUpdate`, `omega@omega` on and `omega@omega-local` off ([agent-docs.md](agent-docs.md#the-omega-plugin-reaches-every-machine-from-the-right-place)) | None: the next `npx omega manage` or `npm start` heals the file. Commit the change it makes |
| What the `@omega.js/manager` tarball carries | `claude-plugin/` and `.claude-plugin/marketplace.json`, so a brand's sessions loaded the plugin from `node_modules` | Neither: the package ships `AGENTS.md`, `bin/`, `dist/` and `docs/` only, and a machine installs the plugin from GitHub | Once per machine, accept the onboarding offer, or run `claude plugin marketplace add Omega-JS-Stack/omega && claude plugin install omega@omega`. Any hand-written path into `node_modules/@omega.js/manager/claude-plugin/` no longer resolves |

## 2026-10-01: onboard picks the website alone by default ([#1030](https://github.com/Omega-JS-Stack/omega/issues/1030))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `omega onboard`'s default targets | The website and the backend: Enter, or a run with no `--targets`, wrote both | The website alone; `--targets=none` writes a brand with no target, and a rerun inside a brand adds the targets it lacks | None for an existing brand. A script that runs `omega onboard` and expects a backend passes `--targets=web,backend`; the same rerun inside a brand adds the backend it lacks |

## 2026-09-30: the registrar and mailbox provider sets are closed ([#1015](https://github.com/Omega-JS-Stack/omega/issues/1015))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The mailbox provider key, `domain.email.providers.<id>` | Any key loaded; one the manager did not know built no MX or SPF records and left Email Routing off, silently | Exactly the rows of the manager's registry, `services/domain/lib/providers.js`: `cloudflare`, `squarespace`, `privateemail`. Any other key fails the load naming `npx omega migrate` | Rename the key to the provider that actually serves the domain's mail, or delete the entry to choose none (the MX/SPF records and Email Routing stay off, as the unknown key left them) |
| The registrar key, `domain.providers.<id>` | Only `namecheap` loaded; `squarespace` failed the load | `namecheap` and `squarespace` both load, the registry's two registrars; any other key still fails | None: a brand whose Squarespace registrar failed the load now loads and gets manual nameserver guidance |

## 2026-09-30: a one-time price is `prices.once`, and only that ([#849](https://github.com/Omega-JS-Stack/omega/issues/849))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A product's one-time price in `payment.products[].prices` | `prices.amount` on any product, or a cadence key such as `prices.monthly` on a `type: 'one-time'` product: the checkout page read both as fallbacks, and every backend reader took `once` alone, so the page priced a purchase the backend then refused | `prices: { once: 49.99 }` on a one-time product; a subscription prices its cadences (`daily`, `weekly`, `monthly`, `annually`) and carries no `once`. The config validator refuses `amount` or any cadence key on a one-time product (naming `once`), and `once` or `amount` on a subscription (naming the cadence keys) | Rename the key to `once` on each one-time product. `npx omega migrate --execute` at the brand root moves an `amount` to `once` for you; a cadence key on a one-time product is renamed by hand, and an `amount` on a subscription is deleted by hand (migrate moves it to `once`, which the load then refuses) |

## 2026-09-30: a target's test/README.md is marker-merged ([#843](https://github.com/Omega-JS-Stack/omega/issues/843))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A backend, desktop or extension target's `test/README.md` | Copied once on the first verb and never touched again, so a framework fix to it never reached an existing project | The marked file: the framework's text under `<!-- ========== Default Values ========== -->`, rewritten from the framework's `src/defaults/test/README.md` on every verb; your own notes under `<!-- ========== Custom Values ========== -->`, verbatim. The next verb converges an unmarked copy: a line the framework text carries goes, a line any earlier framework text carried goes, and every other line, your own, lands under Custom in order. A code block or a table of your own lands whole, and a heading stays with a section that is all yours | Before the next verb, move a note you wrote INSIDE a framework paragraph or table (an extra row in the layout table, say) into a paragraph of its own: the converge keeps it, but lifted out of its table |

## 2026-09-30: the backend and the router have exports maps ([#1009](https://github.com/Omega-JS-Stack/omega/issues/1009))

`@omega.js/backend` and `@omega.js/mcp-router` declare an `exports` map in the siblings' shape, so a path the map does not name throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The backend's doors are `.`, `./test`, `./config`, `./lib/email-constants`, `./lib/mcp-utils`, `./cli`, `./ensure-target`, `./migrate` and `./package.json`; any other deep require moves to its door (`dist/mcp/utils.js` is `./lib/mcp-utils`).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A backend case file's `defineCases` | `const defineCases = require('@omega.js/backend/dist/vendor/devkit/test/define-cases.js');` | `const { defineCases } = require('@omega.js/backend/test');`, the public test API, the door desktop and extension have | Rewrite that line in every file under the target's `test/`, the three scaffolded `test/unit/` skeletons included (they are copied once, so the new form reaches only a new project) |
| The backend deploy workflow's `.env` writer | `require("@omega.js/backend/dist/vendor/config/env.js")` | `require("@omega.js/backend/config")` | None: the workflow is framework-owned and re-rendered on the next verb |
| A desktop or extension case file's export | A bare `module.exports = { ... };` | `const { defineCases } = require('@omega.js/desktop/test');` (or `@omega.js/extension/test`), then `module.exports = defineCases({ ... });`, the backend's form | Wrap every case file under the target's `test/` by hand; `test/_init.js` and other `_`-prefixed helpers stay as they are. The extension's scaffolded `test/boot/externally-connectable.test.js` is copied once, so the wrapped form reaches only a new project. A bare file still runs under `omega test`, since the wrapper hands the spec back unchanged; what it lacks is the loud failure when `node --test` loads it, which otherwise reports a hollow pass |

## 2026-09-29: one AGENTS.md shape, and marker sections in every mixed file ([#999](https://github.com/Omega-JS-Stack/omega/issues/999), [#1000](https://github.com/Omega-JS-Stack/omega/issues/1000))

Every framework-written file holding framework lines and your lines speaks the one marker grammar: a `Default Values` section the framework rewrites on every run, then a `Custom Values` section kept verbatim, which is only its marker line in a fresh file.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A project root's `AGENTS.md` (a brand root, or one framework used alone) | A brand root: line 1 imported `node_modules/@omega.js/manager/AGENTS.md`, then a generated `# <name>: brand notes` heading. A standalone project: the framework's long template, marker-merged | The marked file: `<!-- ========== Default Values ========== -->`, the import, then `<!-- ========== Custom Values ========== -->` and your notes. No generated heading. The next verb (the next manage at a brand root) converges any older shape: the heading and the shipped boilerplate go, every other line lands under Custom in order | None at a brand root. A standalone project adds `@omega.js/manager` as a dev dependency so the import reaches the framework docs ([agent-docs.md](agent-docs.md#supported-shape)) |
| A brand target's `AGENTS.md` | None scaffolds; a copy carrying notes is kept with a warning | Unchanged: none scaffolds, a copy with nothing of yours is removed, a copy carrying notes is kept with a warning | Move those notes under the Custom marker of the brand root's `AGENTS.md`, then delete the target's copy |
| The brand root and company tree `.gitignore` | Unmarked; the manage walk only appended the entries it found missing, so a line the framework retired never left | The marked file: the framework's list under `Default Values`, rewritten every manage; your ignores under `Custom Values`. The next manage converges an unmarked file: the framework's lines and their old headers go to Default, every other line lands under Custom, nothing duplicated | None. Afterwards, put an ignore of your own under `Custom Values`: a line typed into the Default section is rewritten away |
| A target's `.gitignore` Custom section | Shipped with boilerplate under the marker (`# Add your custom ignore patterns below this line`, `# ...`, desktop's `# Add your own ignores below. ...`) | Only the marker line. A Custom section holding exactly that boilerplate strips on the next verb; one holding your lines too stays verbatim, boilerplate included | Delete the boilerplate lines by hand if your own lines sit beside them |
| The brand root and company tree `.env` | The canonical groups and `# KEY=` placeholders with no markers; a key the framework retired was never removed | The marked file: the groups and placeholders under `Default Values`, rewritten every manage with every set value kept on its key's line; your keys and notes under `Custom Values`, verbatim. The next manage converges an unmarked file: a key the framework does not know and every comment of yours land under Custom in order, except a comment directly above a framework key, which goes with the Default rewrite | Before the next manage, move any hand comment above a framework key under `Custom Values`. Fix any line manage reports "left as-is" (a line dotenv reads another way, such as `KEY: value`) |
| A web target's `.gitattributes` | Unmarked, written once and never healed | Marker-merged like `.gitignore`: the translation-cache line under Default, your lines under Custom; the next verb converges the old file | None |

## 2026-09-27: one dev verb on every framework, one test entry on the backend ([#983](https://github.com/Omega-JS-Stack/omega/issues/983))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A target's `start` script | web `omega dev`; backend `omega serve`; desktop and extension `omega clean && npm run gulp --` | `omega dev` on every framework target, derived from the verb table's `dev` row. Desktop's and extension's `dev` is clean, then the gulp default task, with the `--` flags forwarded; the backend's is the full emulator suite | None: every verb and the manage walk rewrite `start` |
| The brand-root `omega dev` legs | web `npm run start`, backend `npm run emulator`, desktop and extension `npm run start`, a custom target its `start` | Every target's own `npm run start`; a selected target with no `start` script is skipped in one loud line | None |
| The backend's `emulator` and `test:static` scripts | `emulator` ran `omega emulator`; `test:static` ran `node --test` over `test/_unit` with `test/_helpers/connect-trap.js` preloaded | Gone. `omega emulator` stays a verb, and `npm start` (`omega dev`) boots the same suite. `omega test` is the one test entry: it runs `test/unit/` with the rest, under the runner's own connect trap (loopback only; stood down under `--extended` and `--lane=`) | Delete `emulator` and `test:static` from the backend target's `package.json` (the walk never deletes a key). Move `test/_unit/` to `test/unit/`, convert each file from `node:test` to a runner case file (`module.exports = defineCases({ type: 'group', tests: [{ name, run(context) }] })`, with `defineCases` from `@omega.js/backend/test`; the new skeletons show the shape), and delete `test/_helpers/connect-trap.js` |
| A custom-server backend's `test` and `dev` | `omega test` refused; `test` was a brand-owned script | `omega test` runs the discovered suites with no emulator boot, health check or account setup, and `test` is framework-owned again (`omega test`); `omega dev` refuses, so `start` and `deploy` are the brand's scripts | None: the walk writes `test`. A brand-written `test` is rewritten to `omega test` |

## 2026-09-27: a verb runs in a target of one of its owners ([#985](https://github.com/Omega-JS-Stack/omega/issues/985))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Where a verb runs | Every verb refused below a root; only a child carrying the `OMEGA_ROOT_DISPATCH` env marker ran there | Inside a target, a verb its framework owns runs in place (`npm test`, `npm start`, `npx omega build`); a brand-wide verb, one only the manager owns, refuses there and prints `cd <brandRoot> && npx omega <verb>`, except a verb that needs no brand (`status`, `onboard`), which runs the manager there. Framework source (`packages/*`) is never a target and still refuses every verb. The marker is gone: nothing sets or reads it | Drop `OMEGA_ROOT_DISPATCH` from any script or hand-written workflow; the generated workflows lose it on the next verb |
| The brand-root fan-out | A framework target ran its framework's bin by path; a custom target, and a custom-server backend's `deploy` / `test`, ran `npm run <verb>` with no flags | Every target runs its own `npm run <verb>`. Only the framework's own script, exactly `omega <verb>`, hears the brand's flags and scope after `--` (a deploy's `--snapshot=<sha>` included); a brand-owned script (a custom target's, a custom-server backend's) runs bare, and under `--dry-run` it stops at the plan | None |
| A framework target's scripts | Each framework's hand-typed `projectScripts` | One `"<verb>": "omega <verb>"` per fan-out verb (`fanout: 'each'`) the framework owns, derived from the verb table, with the scripts the table cannot derive merged over them | None to write them: every verb and the manage walk do. The walk never deletes a key, so delete the ones no framework writes any more by hand: `publish` and `release` from a desktop target (`npx omega publish` / `release --target=<name>` at the brand root replace them) |
| A single-target command at the brand root (`firestore:set`, `emulators`, `launch`, ...) | The picked target's framework bin | Unchanged: the picked target's framework CLI with the argv as typed, never a script; on a custom target it steps aside in one line instead of refusing | None |
| The backend's test scripts | `test` was the static lane (`node --test` over `test/_unit`), `test:static` ran `npm test`, `test:emulator` ran `omega test` | `test` is `omega test` like every framework's, `test:static` is the static lane itself, `test:emulator` is gone; `projectScriptsCustomOwned` is gone (the backend derives the list), and in custom mode `test` is the brand's: a custom-server backend with no `test` script of its own is skipped, loudly, by the brand-root `omega test` | Run the static lane as `npm run test:static`; delete `test:emulator` from the target's `package.json` |

## 2026-09-26: two switches, two names ([#946](https://github.com/Omega-JS-Stack/omega/issues/946))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `omega update` | A bare run reported; `--apply` installed the safe set; `outdated` and `out` were aliases | A bare run installs the safe set, like every verb that acts by default; `--dry-run` reports and installs nothing; the `outdated` and `out` aliases are gone | Drop `--apply`; a script that relied on a bare report adds `--dry-run`, and `omega outdated` / `omega out` become `omega update --dry-run` |
| The report and do-it switches | `--apply` (update's install) and `--check` (a web flag nothing read) beside `--dry-run` and `--execute` | Two names: `--dry-run` shows the plan on a verb that acts by default (deploy, manage, build, clean, install, onboard, pipeline, devlog, update), `--execute` does the work on a verb that reports by default (`omega migrate`, the manager's `--migration=<name>` lane) | Spell the switch the verb's way; no CLI declares `--apply` or `--check` any more |

## 2026-09-26: the schema is strict, and `omega migrate` owns every old name ([#859](https://github.com/Omega-JS-Stack/omega/issues/859))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A config key no rule declares | A WARNING on the load ([#636](https://github.com/Omega-JS-Stack/omega/issues/636)), and a retired name was its own error naming the replacement | An ERROR at any level, one line per path, naming `npx omega migrate`; a retired name fails exactly the same way, and a section with typed keys is closed, so a typo inside it fails too. Documented override blocks (`targets.desktop.electronBuilder`, `windows`, `cdp`, `fileAssociations`, `protocols`, `targets.backend.mcp.authUrl`) and the `client` settings bag stay open ([config.md](config.md#validation)) | Run `npx omega migrate` at the brand root and `--execute` what it converts; delete every custom key of your own (a key nothing reads has no place in omega.json5) |
| A retired `.env` key | A `.env` layer still carrying one FAILED the load | The `.env` layer is open: the line is unread, and `omega migrate` names it by NAME (never a value); `--execute` renames an env-side rename in place | Run `npx omega migrate --execute`, then move or delete what it leaves due |
| The retired tables | `@omega.js/config` exported `findRetiredKeys`, `RETIRED_KEYS`, `RETIRED_PATHS`, `RETIRED_ENV_KEYS`, `findRetiredEnvKeys`, `assertNoRetiredEnvKeys` | Gone from config: they are the migrate verb's rule set, `@omega.js/manager`'s `src/migrate/`, and nothing else reads them | A script that imported them runs `npx omega migrate` instead |
| The retired `.omega/company.json` stamp | A run that found one warned once | Nothing reads it and nothing warns: running code carries no legacy check | `rm .omega/company.json` in every brand ([the 2026-09-12 section](#2026-09-12-one-company-key-and-a-company-tree-inside-the-parent-677)) |
| The UJM converter's passthrough | An unrecognized `_config.yml` section, `permalink`, `pagination`, `defaults`, `generators` and the UJM-json `distribute` / `workflows` rode to `targets.web` | Dropped with a note per path, so a converted config always loads | Carry anything that still matters by hand |

## 2026-09-26: one root `omega migrate` ([#885](https://github.com/Omega-JS-Stack/omega/issues/885))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The brand-root `omega migrate` | A bare run deleted the retired config keys; `--dry-run` printed the plan | A bare run REPORTS and writes nothing, exiting 1 while a step is due; `--execute` converts. It converts the brand config first, then runs every target's own migration (`--target=` narrows the walk), and ends on the path of this register | Add `--execute` wherever a script meant to convert; drop `--dry-run` |
| A framework's own `migrate` | `npx omega migrate` (and `--check` / `--dry-run`) in a web, backend or extension project: the UJM conversion, the bare-require report, the hook-layout move | Gone from every framework CLI: each is a leg of the brand-root verb, `npx omega migrate --target=<name>`. The backend's `migrate:rules` and `migrate:markers` are unchanged | Run the brand-root form; a standalone legacy project joins a brand first |
| The web leg's library option | `runMigration(root, { check: true })` reported, `runMigration(root)` wrote | `runMigration(root)` reports, `runMigration(root, { execute: true })` writes; `migrateTarget(root, { execute })` answers `{ due, changed, errors }` | Flip the option in any script that calls the library |

## 2026-09-26: every verb runs at a root ([#863](https://github.com/Omega-JS-Stack/omega/issues/863))

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Where a verb runs | `cd targets/<target> && npx omega <verb>`, or `npx omega test` inside `packages/<framework>` | At the root: `npx omega <verb> --target=<target>` at the brand root, `npx omega test --target=<package> framework:` at the monorepo root; inside any subfolder the verb refuses and prints that root form | Run it from the root with `--target=`; a script or alias that `cd`s into a target first drops the `cd` and adds the picker |
| The link flip | `npx omega i local` / `npx omega i live` in any target: web, backend, desktop and extension each carried an `install` command | `npx omega i local` / `npx omega i live` at the brand root: the manager's own verb, one call for the whole tree; no framework has an `install` command, so a standalone project has no link verb | Run it at the brand root; drop any per-target `i local` from scripts and notes |
| A framework verb the manager has no command for | Run inside the target that owns it (`cd targets/web && npx omega translate`) | Passed through from the brand root: `npx omega translate --target=web`, every arg after the verb forwarded as typed; a single-target verb (`launch`, `emulator`, `firestore:get`, ...) needs exactly one `--target=` | Add the picker at the brand root ([../manager/brand.md](../manager/brand.md) § Verbs lists every verb) |

## 2026-09-25: one runtime shape on every package ([#945](https://github.com/Omega-JS-Stack/omega/issues/945))

Every package's default export is ONE ready-made instance, `omega`, and a consumer never
writes `new`. `initialize(options)` returns that instance on every surface; on the async
surfaces `omega.ready` is the same promise, so a module that did not call it can still await
it. The class is exported by name (`Omega`) for tests only. Accessors are properties, never
zero-arg methods. `auth.user` is always a `User` from `@omega.js/account`: the stored account
document as own fields, the derived facts as getters, and a signed-out `User` (`authenticated`
false, `plan` basic) instead of null. The `@omega.js/manager` package, its `omega manage` verb
and its banners keep their names.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Backend consumer entry (`src/index.js`) | `const Manager = (new (require('@omega.js/backend'))).init(exports, { … });` then `const { functions } = Manager.libraries;` | `const omega = require('@omega.js/backend');`, then `omega.initialize({ … });`, and `module.exports = omega.functions;` as the file's last line | Rewrite the two lines and add the export line. A function of your own joins the map before it: `omega.functions.items = omega.firebase.functions.region(omega.project.resourceZone).https.onRequest((req, res) => omega.routes.run('items', { req, res }));` |
| Desktop consumer entries (`src/main.js`, `src/preload.js`, each `src/assets/js/components/<view>/index.js`) | `new (require('@omega.js/desktop/main'))().initialize()`, or a `manager` instance destructured after `initialize()` | `const omega = require('@omega.js/desktop/main');` (or `/preload`, `/renderer`), then `omega.initialize().then(() => { const { logger, windows } = omega; })` | Rewrite each entry; every `manager.` becomes `omega.` |
| Extension contexts (`background`, `popup`, `sidepanel`, `options`, `page`, `content`, `offscreen`) | `import Manager from '@omega.js/extension/popup'; const manager = new Manager(); await manager.initialize();`, with the client read as `manager.omega` | `import omega from '@omega.js/extension/popup'; await omega.initialize();`: the instance IS the runtime, and the four page contexts carry the client's modules on it (`omega.auth`, `omega.storage`, `omega.bindings`) | Rewrite each context's entry and drop the `omega` destructure. The bare `@omega.js/extension` import is no longer a context (it is the build-time `{ version, build }` entry): import the context entry |
| Web service worker (`src/service-worker.js`) | `import Manager from '@omega.js/web/service-worker'; const manager = new Manager(); manager.initialize()` | `import omega from '@omega.js/web/service-worker'; omega.initialize()`; the framework file is `sw/omega.js` | Rewrite the three lines |
| Web page, layout, section and global modules | `export default ({ manager, options }) => { }`, and `import omega from '@omega.js/client'` for the client | `export default async ({ omega, options }) => { }`; a module that needs the instance outside that call imports `@omega.js/web/runtime` | Rename the argument, and repoint every `@omega.js/client` default import at `@omega.js/web/runtime` |
| A theme's `_theme.js` | A side-effect module: its initializers ran on import | `export default async ({ omega, options }) => { }`, which the host calls with the booted instance | Move the theme's initializers into the default export |
| Web page features | `omega.library().showExitPopup()` and the rest of the `omega.library()` / `omega._library` bag | Properties of the web instance: `omega.appearance`, `omega.shell`, `omega.motion`, `omega.exitPopup.show()` (`exitPopup` is null when the popup is off) | Rewrite each `omega.library()` read to the property |
| Client accessors | `omega.auth()`, `omega.utilities().escapeHTML(x)`, `omega.firestore()`, `omega.bindings()`, `omega.storage()`, `omega.dom()`, `omega.sentry()`, and the rest | `omega.auth`, `omega.utilities.escapeHTML(x)`, `omega.firestore`, `omega.bindings`, `omega.storage`, `omega.dom`, `omega.sentry` | Drop the `()` after every module name; a missed site throws `is not a function` |
| `@omega.js/client` default export | A live singleton, imported anywhere | The base class `Omega` and no instance: web, the extension page contexts and the desktop renderer each export the one instance | Import the instance from the host framework (`@omega.js/web/runtime`, the extension context, `@omega.js/desktop/renderer`), never from `@omega.js/client` |
| The signed-in user | `auth.getUser()` (the Firebase profile, or null), `auth.isAuthenticated()`, `auth.resolveSubscription(account)` | `auth.user`, a `User`: `authenticated`, `uid`, `email`, `plan`, `active`, `trialing`, `cancelling`, `everPaid`, the stored fields (`user.roles`, `user.subscription`), and `user.profile.{displayName,photoURL,emailVerified}` | Replace each call with the property. A `if (user)` check reads `user.authenticated`, since `auth.user` is never null |
| The auth listener state | `auth.listen((state) => …)` with `{ user, account, resolved, accountDenied }` | `{ user, denied }`: `user` is the one `User`, `denied` is true only when rules refused the account read. `auth.reload()` re-reads the account and resolves with the new state | Read `state.account.*` and `state.resolved.*` off `state.user`, and `state.accountDenied` as `state.denied` |
| Bindings | Three roots: `auth.user` (the Firebase profile), `auth.account.*` and `auth.resolved.*` | ONE root, `auth.user`: `auth.user.plan`, `auth.user.active`, `auth.user.roles.admin`, `auth.user.profile.displayName`, `auth.user.profile.photoURL`. `usage` stays its own root | Rewrite each `data-omega-bind`: `auth.account.x` and `auth.resolved.x` read `auth.user.x`, `auth.user.displayName` reads `auth.user.profile.displayName`, and `@show auth.user` reads `@show auth.user.authenticated` |
| `FormManager` | `new FormManager('#form', options)`, the class importing the singleton | `new FormManager(omega, '#form', options)` | Pass the instance first |
| Click triggers | `registerTrigger('name', handler)` from `@omega.js/client/modules/triggers.js` | `omega.triggers.register('name', handler)` | Rewrite each registration; the class stays `omega-<name>` |
| Extension auth page and messaging | `openAuthPage()`; `messenger.onMessage = (message, sender, sendResponse) => { }`; `messenger` absent in background and offscreen | `omega.auth.openPage()`; `messenger.onMessage(handler)`, which returns the unsubscribe; `messenger` on every context, and background's `omega.auth.user` built from the whole account document | Rewrite the call and every `onMessage` assignment |
| Desktop main auth | `manager.omega` (the client bridge): `getCurrentUser()`, `onAuthChange(fn)`, `getResolvedPlan()`, `getResolvedRoles()` | `omega.auth`: `.user` (a `User` built from the whole account document), `.listen(fn)`, `.signOut()`, `.getIdToken()`, `.handleToken()` | `getCurrentUser()` reads `omega.auth.user`, `onAuthChange` is `listen`, and the plan and roles read `omega.auth.user.plan` and `omega.auth.user.roles` |
| Desktop renderer | `manager.omega` for the client; `manager.storage` and `window.desktop.*` for the main process | The renderer instance extends the client (`omega.auth`, `omega.firestore`); everything that crosses to main is `omega.desktop.{ipc,storage,theme,fontawesome,autoUpdater,analytics,context,usage,remoteConfig}`. `omega.storage` is the page store; the app store is `omega.desktop.storage` | Read the client off the instance, and the app store as `omega.desktop.storage` |
| Desktop integrations (`src/integrations/<tray,menu,context-menu>/index.js`) | `module.exports = ({ manager, tray }) => { }` | `module.exports = ({ omega, tray }) => { }` (menu and context menu likewise) | Rename the argument |
| Desktop test harness | Boot `inspect` bodies received `{ manager, expect, … }`; the harness wrote `__EM_TEST__` lines on stdout | `{ omega, expect, … }`; the prefix is `__OMEGA_TEST__` | Rename the argument, and any grep of a run's stdout |
| Desktop logger export | `require('@omega.js/desktop/lib/logger')` | `require('@omega.js/desktop/build').logger(name)` at build time, `omega.logger` at runtime | Repoint the require |
| Build modules (`@omega.js/desktop/build`, `@omega.js/extension/build`) | `const Manager = new (require('@omega.js/extension/build')); Manager.getConfig();`; hook context `{ manager, projectRoot, mode }` | `const build = require('@omega.js/extension/build'); build.getConfig();` (no class, no `new`); hook context `{ build, projectRoot, mode }` | Rewrite each hook's require and its destructure |
| Backend route handler | `async ({ Manager, ctx, analytics, usage, user, settings, libraries, utilities }) => { }` | `async ({ ctx, omega, user, data, usage, analytics }) => { }`; everything in the list is also on `ctx` | Rename `settings` to `data`, `Manager` to `omega`; `libraries.admin` reads `omega.firebase.admin`, `utilities` reads `omega.utilities` |
| Backend event and cron handlers | Events `({ Manager, ctx, libraries, user, context, change, snapshot })`; cron `({ Manager, ctx, context, libraries })` | Events `({ ctx, omega, user, context, change, snapshot })`; cron `({ ctx, omega, context })` | Same renames as a route |
| Backend `ctx` | `RouteContext`: `ctx.Manager`, `ctx.getUser()`, `ctx.request.user`, `ctx.resolvedUser`, `ctx.settings`, `ctx.ref`, `ctx.constant.pastTime` | `Context`: `ctx.omega`, `ctx.user` (a `User`), `ctx.data`, `ctx.req` / `ctx.res`; request services built on first read: `ctx.usage`, `ctx.analytics`, `ctx.email`, `ctx.ai`, `ctx.metadata(doc)` | Rewrite each read. `ctx.constant.pastTime` has no replacement |
| Backend instance | `Manager.libraries.admin` / `.functions`, the factories (`Manager.User()`, `Manager.Usage()`, `Manager.Analytics()`, `Manager.Settings()`, `Manager.Utilities()`, `Manager.AI()`, `Manager.Email()`, `Manager.Metadata()`), `Manager.Middleware(req, res).run('items', options)` | `omega.firebase.admin` / `omega.firebase.functions` (the SDK; `omega.functions` is the exported map); the request services on `ctx` and the process services on `omega` (`omega.utilities`, `omega.email`, `omega.ai`, `omega.storage({ name })`); `omega.routes.run('items', { req, res }, options)` | A route never constructs a service: read it off `ctx` or `omega` |
| Backend events from a consumer's own trigger | `Manager.EventMiddleware(payload).run('users/on-create')` | `omega.events.run('users/on-create', payload)`: the dispatcher the framework's own triggers use; a relative name loads `<cwd>/events/<name>.js`, a leading `/` is verbatim | Rewrite each trigger: `.onCreate((user, context) => omega.events.run('users/on-create', { user, context }))` |
| Backend consumer routes | A consumer route rode `omega_api` at `/omega/<name>` and won over a framework route of the same name; `omega.run(name, req, res, options)` and `omega.runEvent(name, payload)` | `omega_api` and `/omega/*` serve only the framework's routes and the MCP endpoint. A consumer route is its own function, `omega.routes.run(name, { req, res }, options)` in the region `omega.project.resourceZone`, behind its own hosting rewrite at its own path (`/notes`); `omega.events.run(name, payload)` runs a trigger's handler. A consumer MCP tool's `path` is the path as served (`/notes`) | Give each route its own function and a `{ "source": "{/notes,/notes/**}", "function": "notes" }` rewrite after the `omega_api` one, repoint every caller from `/omega/<name>` to `/<name>`, prefix each consumer tool `path` with `/`, and rename `omega.run`/`omega.runEvent` |
| Backend `initialize()` options | `setupFunctionsIdentity`, and the test-runner switches `initialize`, `setupFunctions`, `setupServer`, `log` | `identity`; the switches are gone (the test runner passes `initialize({ runnerHost: true })`) | Rename `setupFunctionsIdentity`; delete the switches |
| Backend pipeline options | `setupSettings`, `includeNonSchemaSettings`, `parseMultipartFormData` | `validate`, `includeUnknown`, `parseMultipart` | Rename each option passed to `omega.routes.run()` |
| Config environment mixin | `attachTo(Manager)` / `attachEnvironment` from `@omega.js/config` | Each instance calls `getEnvironment()` and the three checks directly | Delete the mixin call |
| Removed outright (backend) | `functions/_legacy/` and the `setupFunctionsLegacy` option, `functions/wrappers/mailchimp/addToList.js`, `helpers/api-manager.js` (`ApiManager`), `helpers/roles.js` (`Roles`), `Manager.install()`, `Manager.debug()`, `self.interface`, `libraries.localDatabase` and `initializeLocalStorage`, `fetchStats`, `server-manager.js` | Gone | Delete every reference; `ctx.usage` covers what `ApiManager` counted |
| The `/backend-manager/*` URL alias | The router stripped the prefix, the edge worker forwarded it, and the `omega_api` hosting rewrite listed `/backend-manager` and `/backend-manager/**` | Gone: a call to the old prefix answers 404 | Repoint every caller at `/omega/*`, and drop the two sources from the brand's `firebase.json` rewrite |
| Removed outright (frontends) | Client `omega.library()` / `omega._library`; extension `openAuthPage()`, the `attachTo` mixins; desktop `manager.omega`, `wmBridge`, `./lib/logger`, `__EM_TEST__` | Gone; each row above names its replacement | Rewrite per the rows above |

## 2026-09-25: one request-schema system ([#823](https://github.com/Omega-JS-Stack/omega/issues/823))

A route's schema file exports a function of the request and returns a plain field
declaration. ONE adapter turns that declaration into a zod schema and validates with it, so
zod is the only validator underneath and a schema stays a plain object until it runs: a split
on the plan, the query, the path or any other request fact is ordinary code
(`if (user.plan === 'pro') fields.limit.max = 200;`). Defaults still coerce and never reject.
The hand-rolled engine and the zod builder layer are both gone. The full vocabulary and the
split kinds: [schemas.md](../backend/schemas.md).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The schema function's argument | `({ ctx, user, data, method, headers, geolocation, client })` | `({ user, body, query, path, method, headers, geolocation })`: `user` is the caller's `User`, `body` and `query` are the raw parts (the route still receives their validated merge as `data`) | Read `data.x` as `body.x` or `query.x`, `user.subscription.product.id` as `user.plan`; a schema no longer reaches `ctx` or `client` |
| A field | `{ types: ['string'], default: '' }`, or a builder: `f.string({ default: '' })`, `f.number(…)`, `f.array(…)`, `f.passthrough(…)`, `f.multi(['string', 'number'], …)`, `f.any(…)` | `{ type: 'string', default: '' }`; `type` is one of `string number boolean array object any`, or a list of them | Rewrite each field; `f.passthrough` is `type: 'object'`, `f.multi(list)` is `type: list` |
| Nesting | A nested plain object, or `f.object({ … })` around the whole schema | The function returns the declaration itself; a nested object is `{ type: 'object', fields: { … } }`, array items are `of: { … }` | Return the map directly and wrap each nested group in `fields` |
| `required` | A boolean or a function (`required: () => isPremium`) | A boolean computed in the schema function (`required: isPremium`), never paired with `default` | Compute the condition before the declaration and assign the boolean |
| Path ids | A `default` computed from the request path, plus `min: 1` | `{ type: 'string', path: true }`, filled from the request path's trailing segments in declaration order | Replace the computed default with `path: true` |
| Field keys | `types`, `default`, `value`, `min`, `max`, `required`, `clean`, `sanitize`, `enum` | `type`, `default`, `value`, `min`, `max`, `required`, `clean`, `sanitize`, `enum`, plus `pattern` (a RegExp a sent value must match), `path`, `of` and `fields`; any other key throws, naming its dot-path | Rename `types` to `type`; nothing else to migrate |
| Removed | `helpers/schema-engine.js`, `helpers/schema-zod.js` and its `fields` builders, and a schema file exporting raw zod | Gone: `helpers/schema.js` is the one adapter | Delete the builder require from every schema file |

## 2026-09-14: the companion extension leaves `@omega.js/manager` ([#927](https://github.com/Omega-JS-Stack/omega/issues/927))

The companion extension lived at `@omega.js/manager`'s `extension/`, a whole extension
project inside a published package: it carried another product's identity, shipped to no
store, and was cut from the npm tarball, which meant the router's `omega-extension` upstream
could not start on any install but a monorepo checkout. It is the **OMEGA Companion** now,
the OMEGA brand's own extension target (`omega-omega/targets/extension`, Chrome Web Store
lane), and its MCP bridge ships inside `@omega.js/mcp-router` at `servers/omega-extension/`.
The WebSocket contract is unchanged: port 9876, `OMEGA_EXTENSION_PORT` on the server side.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Where the companion extension comes from | `node_modules/@omega.js/manager/extension/`, built and loaded unpacked from inside the package | The OMEGA Companion on the Chrome Web Store, or `omega-omega/targets/extension/packaged/chrome/raw/` loaded unpacked | Load the new path (or the store listing once it exists) at `chrome://extensions`, and drop any script that built the manager's `extension/` tree. The `omega-extension` MCP upstream needs no manager on disk at all now |

## 2026-09-14: desktop and extension take their accent from `brand.color` ([#912](https://github.com/Omega-JS-Stack/omega/issues/912))

The scaffolded `main.scss` carried a literal `$primary: #2563EB`, so recoloring a
desktop app or an extension meant editing css a brand had already forgotten about,
and neither target emitted the runtime `--omega-accent` ramp web has emitted since
[#272](https://github.com/Omega-JS-Stack/omega/issues/272). The sass task now renders
a partial from the resolved `brand.color` before every compile (`dist/assets/scss/_brand.scss`
on desktop, `dist/assets/css/_brand.scss` on the extension) carrying `$primary` plus a
`ramp` mixin of the accent family, and the scaffold reads both.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The accent in a target's `main.scss` | `@use 'omega-desktop' as * with ($primary: #2563EB, …)` (and the `omega-extension` twin) | `@use 'brand';` above the framework import, `$primary: brand.$primary` inside `with (...)`, `@include brand.ramp;` below it | Replace the literal in `src/assets/scss/main.scss` (desktop) or `src/assets/css/main.scss` (extension), or keep the literal for an accent that DIVERGES from `brand.color` on purpose |

## 2026-09-14: one shape for a link's icon key ([#903](https://github.com/Omega-JS-Stack/omega/issues/903))

The base theme spelled a link's `icon` two ways: the footer took the full Font Awesome
class string and emitted it as-is (the one icon mechanism,
[#619](https://github.com/Omega-JS-Stack/omega/issues/619)), while the rest of the chrome
took a bare NAME and wrapped it as `fa-solid fa-<name>`, which cannot express a brand mark
at all. Every chrome site now emits the authored string verbatim, so one key has one shape
and any family the brand's set carries is reachable from data.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A link's icon key in nav, app sidebar, app topbar, page-header, account-dropdown and account-section-header data | `icon: github` (a bare name, wrapped as `fa-solid`) | `icon: fa-brands fa-github` (the full class string) | Prefix every bare name in your `_data` and config with `fa-solid` (or `fa-brands` for a brand mark); `grep -rn "icon:" src/_data config/` |

The same wrap survived one layer down, and went the same way on 2026-09-14
([#929](https://github.com/Omega-JS-Stack/omega/issues/929)): every `{% section %}` arg,
every page-layout arg, the footer's social row and the runtime builders (account sessions,
the usage bars, the admin calendar) now emit the authored string verbatim too. A section
arg can name a brand mark at last, and the account page's device marks (`apple`,
`windows`, `linux`) render for the first time: the solid family never carried them.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A section or page-layout `icon` arg (`marketing/hero` buttons and cards, `marketing/bento`, `marketing/stats`, `marketing/trusted-by`, `marketing/product-demo`, `about/letter`, newsflash `marketing/desks`, and the download / contact / extension / auth / team / alternatives / account / dashboard layouts) | `icon: bolt` (a bare name, wrapped as `fa-solid`) | `icon: fa-solid fa-bolt` (the full class string) | Prefix every bare name in your pages and section calls: `grep -rn "icon:" src/` |
| The feature catalog's `icon` (`features.<id>.icon` in omega.json5) | `icon: 'feather'` | `icon: 'fa-solid fa-feather'` | Prefix each catalog entry in `config/omega.json5` |
| The footer's social row and a team member's link `id` | a platform key wrapped as `fa-solid fa-<platform>` | unchanged: still the platform key | Nothing to do. A social profile is always a brand mark, so the family is derived for you (`website` stays the solid globe) |

## 2026-09-14: ONE deploy branch, and the deploy stops committing your tree ([#915](https://github.com/Omega-JS-Stack/omega/issues/915))

A deploy used to COMMIT AND PUSH the developer's own branch first (`git add -A`, message
`Deploy`), which swept whatever the tree happened to hold into the brand's history. Ian,
2026-09-14: "I DO NOT WANT the entire local files committed+pushed to main"; "if all we are
pushing to main is the gh workflow files that's fine". So the push lane is retired: every
brand takes the snapshot lane, CI only ever builds `omega-deploy`, and the default branch
receives the composed workflow files alone, in a `chore(ci): compose <names>` commit made
through the git data api and only when one differs. The developer commits their own work on
their own word, as they always should have.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The lane a deploy takes | `push` for a plain brand (its current branch), `snapshot` on `main` for a nested one, `snapshot` on `omega-deploy` for a linked one | ONE lane: `snapshot` on `omega-deploy` for every brand with a repo (`dispatch` for a brand outside git) | None. The first deploy after this creates the branch and pushes the workflows |
| Committing the tree | the lane's own `git add -A` + commit + push | nothing: a deploy never commits | Commit what you mean to keep before deploying (the snapshot still carries the tree as it stands, committed or not) |
| `--no-sync` | skipped that commit and push on any target verb and at the brand root | retired: the flag no longer exists (passing it is an unknown flag) | Drop it from any script or muscle memory that passes it |
| A stale checkout | force-pushed the deploy branch anyway | REFUSED, naming `git pull` | Pull before deploying, which is the whole step |
| Where the admin publish builds from | the repo's default branch ([#919](https://github.com/Omega-JS-Stack/omega/issues/919)) | `omega-deploy`, written and dispatched there | Run `omega deploy` once from the brand so the branch exists; until then the publish says so and dispatches nothing |

## 2026-09-14: the `Default Values` block is completely managed ([#926](https://github.com/Omega-JS-Stack/omega/issues/926))

The marker merge used to MOVE any Default-block line the new framework block no longer
carried into the consumer's `Custom Values` section, so a rule the framework retired or
rewrote (the `config/certs/` case, [#913](https://github.com/Omega-JS-Stack/omega/issues/913))
survived in every existing target as if the consumer had typed it, and defeated the new
rule. The merged Default block is now exactly the new framework block: a retired line and
a line a user typed inside the framework block cannot be told apart, and the block header
has always said it is overwritten on every setup.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A line inside the `Default Values` block of a target's `.gitignore` or `AGENTS.md` that the framework does not carry | Moved down into `Custom Values` on the next setup | Dropped on the next setup | Move any line of your own into the `Custom Values` section before the next verb run; `.env` values are unaffected (a retired key holding a real value still migrates, only an empty one drops) |

## 2026-09-13: the translation route list, and the page's catalog keys ([#858](https://github.com/Omega-JS-Stack/omega/issues/858))

Ian's same-name ruling (2026-09-09) applied to the last two pairs that named one thing two
ways. Both are OMEGA-to-OMEGA, so both are by hand, except the config half, which
`omega migrate` now CONVERTS rather than merely deleting.

`translation.exclude` said what NOT to translate and defaulted to nothing, so a brand that
never thought about it paid a provider for every post it had, and a page could not say
anything at all. `translation.include` says what TO translate: route globs with `!`
negation, read in `.gitignore` order, defaulting to `['**', '!blog/**']`, with a brand list
REPLACING the default and a page overriding it for itself under the same key name
([translation.md](translation.md)).

The page keys `search.include` / `search.category` named the page's entry in `pages.json`
while the config `search` section means Search Console. The page half is `catalog` now,
page-only, with no site-wide default.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The translation route list | `translation: { exclude: ['docs', 'changelog'] }` in omega.json5 | `translation: { include: ['**', '!docs', '!changelog'] }` | Run `npx omega migrate --execute` at the brand root: it writes the converted list and deletes the old key in one run (a bare `npx omega migrate` prints the plan). A brand that wants the new default instead writes `['**', '!blog/**']` by hand |
| The page's catalog entry | `search: { include: false, category: 'Docs' }` in page frontmatter | `catalog: { include: false, category: 'Docs' }` | Rename the block in each page that carries it. `search:` is a bare config section now, so a page still writing it fails the build naming the file |
| A page's translation opt-out | nothing existed | `translation: { include: false }` in page frontmatter | Nothing to migrate: pages that were named in the old `exclude` list ride the converted include list |

## 2026-09-13: the two test-lane env keys retire ([#819](https://github.com/Omega-JS-Stack/omega/issues/819))

A test lane never asks a brand for a credential. Ian, 2026-09-13: "we need to make it so
that extension and desktop don't need any of those test keys and user IDs ... gets whatever
it needs from the back end". Web, desktop and extension each test their own sign-in against
a persona the backend emulator seeds, so the pair that fed desktop's custom-token
integration case is retired outright ([#904](https://github.com/Omega-JS-Stack/omega/issues/904)
owns the mechanism that replaces it). They are `env-retired.js` rows now, with no
replacement of any kind, so a `.env` layer still declaring one FAILS the load telling you to
delete the line (since the strict-schema change the line is unread instead, and `omega migrate`
names it for deletion). The `testing` schema group went with them, and the two `${{ secrets.* }}`
lines came off every generated web and backend workflow.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The test-lane sign-in credentials | `OMEGA_TEST_FIREBASE_ADMIN_KEY` and `OMEGA_TEST_USER_UID` in `.env` (+ repo secrets on the web and backend repos) | Nothing: each suite signs in as a persona the backend emulator seeds (#904) | Delete both lines from every `.env` layer that carries them, and delete the two repo secrets. No value moves anywhere |

## 2026-09-12: one `build.js` on every browser surface ([#743](https://github.com/Omega-JS-Stack/omega/issues/743))

Every browser artifact OMEGA builds now delivers its snapshot the same way: ONE `build.js`
at the artifact's web root, loaded by each HTML shell's first script tag and by each worker's
`importScripts` line. The bundle banners and defines the browser bundles carried retire with
it, and so does web's inline foot script.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Web `/build.js` | The SERVICE WORKER's own transport, written by `writeBuildMeta`: the build MANIFEST (`brand`, `cacheBreaker`, `firebase`, `assets`, `commit`) as `self.OMEGA_BUILD_JSON = {…}` | The one OMEGA wrapper, written by the engine: `self.OMEGA_BUILD_JSON = { config, package, mode, license, builtAt }` plus its `config.dev` line. The service worker reads `config.brand.id`, `config.environment`, `config.buildTime` and `config.cloud.config` off it | Nothing for a page (the head loads it for you). Custom service-worker code reading the old flat keys moves onto `OMEGA_BUILD_JSON.config.*`. `/build.json` is unchanged and still carries the manifest fields (commit, packages, assets, theme) |
| Web page bake | `core/_includes/core/foot.html` emitted the whole wrapper inline in every page | The head loads `/build.js`; a page emits at most one `Object.assign(self.OMEGA_BUILD_JSON.config, <delta>)` line for its own `config:` block | Nothing, unless you overrode `foot.html` and copied the inline bake: delete it, and make sure your `head.html` override keeps the loader tag first |
| Desktop renderer | The snapshot rode in the renderer bundle (esbuild `define` + banner), so consumer renderer code could read the bare `OMEGA_BUILD_JSON` identifier | The view's shell loads `../../build.js`; renderer code reads `window.OMEGA_BUILD_JSON` | Rename a bare `OMEGA_BUILD_JSON` read in your own renderer code to `window.OMEGA_BUILD_JSON`. Main and preload are unchanged |

## 2026-09-12: the web `Configuration` global retires ([#894](https://github.com/Omega-JS-Stack/omega/issues/894))

Every browser surface bakes ONE snapshot under one name now: `OMEGA_BUILD_JSON`, wrapping
`{ config, package, mode, license, builtAt }`, with `config` the browser subset
@omega.js/config decides (its guide's "The browser subset"). Web's page chrome emitted a
`Configuration` global instead, the legacy UJM name, composed key by key in
`core/_includes/core/foot.html` from a subset `src/engine.js` wired together.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The page global | `window.Configuration` (a `var Configuration = {…}` literal the foot include composed) | `window.OMEGA_BUILD_JSON.config`, the same read desktop's renderer and every extension context already used | Rename every read. There is NO alias: a theme, page script or consumer module still reading `Configuration` gets `undefined` and throws on the first property. `grep -rn 'Configuration' src/` in your brand's web target |
| The client blob's keys | The `client` block's keys were SPREAD onto the payload's top level, so a page read `Configuration.consent` | The `client` section rides under its own key, and @omega.js/client flattens it onto its own contract: `omega.config.consent` reads the same as before | Nothing to do if you read config through `omega.config.*`. A template or script reading the BAKE directly spells it `OMEGA_BUILD_JSON.config.client.consent` |
| The composed bridges | The engine composed `cloud.config` → `client.firebase.app.config`, `payment` → `client.payment`, `features` → `client.features`, and the foot composed `monitoring.providers.sentry` → `sentry` | Each rides at its canonical home, and @omega.js/client does the mapping for all three surfaces | A template reading `resolved.config.client.firebase.app.config` reads `resolved.config.cloud.config` instead; `client.payment` / `client.features` become `payment` / `features` |
| What may reach a browser | Desktop baked the WHOLE resolved config; the extension kept a hand-written allow list; web's engine wired its own subset | One per-section `client` flag in the schema, read by all three bakes | Nothing to do for a brand. A framework-level addition is a schema row, not a third list. A section with no row does not reach the browser: if a brand value your page needs is missing, it needs the flag |

## 2026-09-12: one company key, and a company/ tree inside the parent ([#677](https://github.com/Omega-JS-Stack/omega/issues/677))

A brand used to state its relationship to its company in FOUR places: `brand.company`
(the parent's display name, typed by hand), `company.url` (typed by hand),
`parent` (the webhook topology), and the machine-local `.omega/company.json`
stamp `omega company adopt` wrote. One key says it now, OUTSIDE `brand` (Ian
2026-09-12: "brand key is for things about this brand, and the
parent/company/organization key is OUTSIDE of that"):

```json5
company: { id: 'itw-creative-works' },   // a sub-brand: the parent's brand.id
company: { id: 'self' },                 // the company brand itself
```

The loader FILLS that same key at load: `company: { id, name, url, images: { wordmark } }`,
read from the parent's own config. A brand with no `company` key resolves to
`{ id: null, name: brand.name, url: brand.url, images: {} }`, so no reader needs a
fallback. The company's shared files live in a `company/` folder INSIDE the parent
brand's repo (`company/config/omega.json5`, `company/.env`,
`company/.omega/certificates/apple/`), and a brand-level file the child lacks resolves
from there at the same relative path. WHERE that repo is on a given machine comes from
`~/.omega/brands.json`, which every `loadConfig()` refreshes for its own brand: nobody
maintains it, and a parent that has never been loaded on this machine is inheritance-off
with one loud line. Full contract: [../manager/company.md](../manager/company.md).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Naming the company | `brand.company: "ITW Creative Works"` + `company: { url: 'https://itwcreativeworks.com' }` | `company: { id: 'itw-creative-works' }` (the parent's `brand.id`) | Add the one key, delete `brand.company` and the typed `company.url`. Both are validation errors now, and a typed `company.name`/`company.url`/`company.images` in a brand file fails the load naming the key |
| The parent's wordmark in email | `brand.images.companyWordmark` | `company.images.wordmark`, resolved from the parent's own `brand.images.wordmark` | Delete the key; set the wordmark once, in the COMPANY brand's own config |
| The webhook topology | `parent: 'self'` / `parent: 'https://parent.example.com'` | `company: { id: 'self' }` / `company: { id: '<parent brand.id>' }` | Delete `parent` and name the company. The key itself is a retired-key error now, whatever its value |
| The webhook OPT-OUT | `parent: false` | `company: { webhooks: false }` ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)) | Move it into the company block. Typed boolean, default `true`, and the only thing it says is "the provider ACCOUNT is shared and its one account-level webhook is owned elsewhere". The campaigns and newsletter services are its only readers, and the resolved `company` section carries it so neither needs a fallback |
| Signing material in a target | The manager's disperse `certs` operation and every desktop verb COPIED the tree into `targets/<name>/config/certs/`, and `CSC_LINK`/`APPLE_API_KEY` were derived from those copies | The tree is READ IN PLACE, company tier first, and both paths derive ONCE at the desktop env load as ABSOLUTE paths into it ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)) | Delete the copies under `targets/<name>/config/certs/` (a build never reads them again). Nothing else: the derivation finds the tree. On a RUNNER that directory is still the decode target for the pushed secrets |
| The company folder | A separate company workspace repo, joined by `omega company adopt` writing `.omega/company.json` | `company/` inside the parent brand's repo, joined by `company: { id }` | Move the workspace's `config/omega.json5`, `.env` and `.omega/certificates/` into `<parent brand>/company/`, then `rm .omega/company.json` in every brand. The stamp is read by nothing (a run that finds one says so once) |
| Where a brand is, on this machine | The stamp's absolute path | `~/.omega/brands.json`, written by every run | Nothing: run any omega verb inside the parent once and the line appears |
| The directory push's relationship | `parent` names it | `company: { id }` names it | Delete `parent`; a brand with no company skips the push, exactly as no parent did |
| Off-laptop | The runner had no company at all | The dispatching machine resolves and writes `config/company-resolved.json5` beside the brand config; the deploy snapshot carries it | Nothing: it is generated per deploy and removed right after the push. No runner ever reads `company/` |

## 2026-09-11: targets keyed by name ([#886](https://github.com/Omega-JS-Stack/omega/issues/886))

`targets` used to be keyed by TYPE, with a canonical folder per type
(`targets/website` for web) and an ARRAY of id'd instances when a brand ran two of
one type. Every key is a NAME now, the name IS the folder, and every entry declares
its `type`:

```json5
targets: {
  web:       { type: 'web', url: 'https://somiibo.com' },
  community: { type: 'web', url: 'https://community.somiibo.com' },
  backend:   { type: 'backend' },
  desktop:   { type: 'desktop' },
  docs:      { type: 'custom' },
}
```

The name is the folder `targets/<name>`, the `--target=<name>` word, and the derived-repo
suffix. There is no id, no folder key and no name table left: a second web target is a
sibling key, and its NAME is its subdomain (`https://community.<brand host>` unless the
entry names its own `url`). Full contract: [config.md](config.md#targets-every-key-is-a-name-886).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The web target's folder | `targets/website` | `targets/web` | `git mv targets/website targets/web` |
| A target entry | `web: { … }` (the key was the type) | `web: { type: 'web', … }` (the key is the name) | Add `type` to every entry under `targets`; the validator names any entry still missing it |
| A second target of one type | `web: [{ id: 'main' }, { id: 'admin' }]`, folder `targets/website-admin` | `web: { type: 'web' }, admin: { type: 'web' }`, folder `targets/admin` | Turn the array into sibling keys (the ids become the names, `url:` only where the host is not `<name>.<brand host>`), then `git mv targets/website-admin targets/admin`. An array left behind is a validation error naming this row |
| The target picker | `--target=website` | `--target=web` | Update every script, workflow and alias that passes the flag: it takes the NAME |
| Scaffolded workflows + README | Written from the type-keyed folders | Written from the names | Rerun `npx omega manage` at the brand root so the workflows and the README regenerate against the new folders |
| A deploy record from the array form | `.omega/state.json` `deploy` keyed `<type>:<id>` (`web:admin`) | Keyed by the target NAME (`admin`) | Nothing to do: the old key is not carried over, so that target reads "not deployed yet" once and adopts its record on the next live check |

## 2026-09-11: one repo block and the website repo ([#883](https://github.com/Omega-JS-Stack/omega/issues/883))

A brand's repo hosting was spelled in four places (`repo.providers.github`, a separate
top-level `github` identity, a `targets.<name>.github.repo` override, the desktop releases
owner/repo), and the website published to the SOURCE repo's `gh-pages`, so a free org had
to make the whole brand public to serve a site. One block says it now, every repo name
derives, and the built site gets a repo of its own:

```json5
repo: { provider: 'github', org: 'Acme-Org' }
```

| Role | Repo | Visibility |
|---|---|---|
| Source monorepo | `<repo.org>/<brand.id>-omega` | the brand root `package.json` `private` field (absent = private) |
| Releases | `<repo.org>/<brand.id>-releases` | always public |
| Website, one per GitHub-hosted web target | `<repo.org>/<brand.id>-<target name>` | private only when the brand is private AND the org's plan allows private Pages, else public |

Full contract: [config.md](config.md#the-repo-block-and-the-repos-it-derives-883).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The repo block | `repo: { providers: { github: { enabled, org, repo, shared, private } } }` | `repo: { provider: 'github', org }` (`owner` since the 2026-10-01 entry above) | Replace the block: keep the org, drop the rest. Presence is the switch, so a brand the manager should not touch deletes the block |
| The GitHub identity block | `github: { user, website }` | nothing | Delete it. Nothing read `user`, and the website has its own derived repo now |
| A per-target repo override | `targets.backend.github.repo` (the CMS content repo) | nothing | Delete it: the CMS commits to the source repo `<brand.id>-omega` |
| The releases repo | `targets.desktop.releases: { owner, repo }` | nothing | Delete both keys. `releases: {}` stays the presence switch for the site's download links |
| Repo visibility | `repo.providers.github.private` | the brand root `package.json` `private` field | Make sure the brand root says `private: true` (or `false` on purpose): the manage walk reconciles the repo to it in both directions |
| Where a web target is served from | implicit (Pages on the source repo) | `targets.<name>.hosting.provider`, default `github`, web targets only | Nothing to write unless a target is hosted elsewhere later; a non-web target carrying `hosting` is a validation error |
| The website's home | the source repo's `gh-pages` branch + its custom domain | the target's own `<brand.id>-<name>` repo, `gh-pages` force-orphan, Pages with the target's url as the custom domain | 1) `omega manage`: it creates `<brand.id>-<name>` and reports that Pages is still on the home repo. 2) On the HOME repo, remove the custom domain and disable Pages (`gh api -X DELETE repos/<org>/<brand.id>-omega/pages`), then delete its `gh-pages` branch. ORDER MATTERS: a custom domain can be claimed by only one repo, so the home repo has to let go before the website repo can take it. 3) `omega deploy --direct` in `targets/<name>` (or dispatch) so the new repo gets its `gh-pages` branch. 4) `omega manage` again to set the Pages source and the domain |
| The cross-repo token | `GH_TOKEN` on the source repo | unchanged | Rotate nothing: the same secret already has the scope the website and releases pushes need |
| The backend resolved repo (`config.resolved.github`) | `{ owner, name, repo }` with empty strings when unset | `sourceRepo(config)`: `{ owner, name, slug }` or `null` | A consumer reading `.repo` reads `.slug`; a brand with no `repo` block gets `null`, so a route that needs the repo guards on it and names `repo.org` |
| The extension release channel | a release on the SOURCE repo, uploaded with the same-repo Actions token | `<brand.id>-releases`, tag `<target name>-v<version>`, uploaded with `GH_TOKEN` | Nothing to write. The composed `publish.yml` regenerates on the next deploy dry run; delete the old `extension-v*` releases on the home repo when convenient |

## `ultimate-jekyll-manager` → `@omega.js/web`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Build engine | Jekyll 4 + Ruby/Bundler (`Gemfile`, `Gemfile.lock`, `src/_config.yml`) | Eleventy 3 + LiquidJS, Node only | Run `npx omega migrate --target=<web>` at the brand root, then again with `--execute`: it converts the config, runs the codemod, and deletes `src/_config.yml`, `config/ultimate-jekyll-manager.json`, `Gemfile`, `Gemfile.lock`, `.ruby-version`. Drop the Ruby toolchain from CI |
| Package + CLI | `ultimate-jekyll-manager` dependency; `uj` / `ujm` / `ultimate-jekyll` / `mgr` bins | `@omega.js/web`; `omega` / `omg` / `mgr` | Swap the dependency; replace `npx mgr <verb>` with `npx omega <verb>` in every npm script and workflow |
| Config | `src/_config.yml` + `config/ultimate-jekyll-manager.json` | `config/omega.json5` | Key-by-key table in [config.md](config.md#ultimate-jekyll-manager-src_configyml--configultimate-jekyll-managerjson--omega-migrate-b4-checkpoint-32); `omega migrate` writes it for you |
| Client-runtime config key | `web_manager: { … }` | `client` (`targets.web.client`) | Codemod rule `client-frontmatter` renames page-frontmatter blocks; config blocks relocate per the UJM mapping table in [config.md](config.md#migration--legacy-configs--omegajson5) (the SSOT for the key-by-key moves). The old name is a validation error, not a silent no-op |
| Framework file delivery | `distribute.js` COPIED framework layouts/includes/assets into the consumer repo | Layered resolution (consumer → active theme → base → core), first-layer-wins per relative path, zero copying | Delete every copied framework file from the repo; keep only files you truly override, at the same relative path. `npx omega customize --list` prints the override map |
| Layout values | `layout: themes/[ site.theme.id ]/frontend/pages/blog` (or hardcoded `themes/classy/…`) | The plain layout name: `layout: frontend/pages/blog` | Codemod rule `bracket-layout`, or strip the `themes/<id>/` prefix by hand. An unmigrated value fails the build loudly ("Problem creating an Eleventy Layout") — the engine no longer aliases the old spellings |
| Frontmatter refs | Bracket interpolation — `title: [ site.brand.name ]` | Real Liquid — `title: {{ resolved.config.brand.name }}` | Rewrite `[ … ]` to `{{ … }}` in frontmatter by hand (the codemod covers only `layout:` lines). An unmigrated value ships the literal brackets into the output — nothing resolves them anymore |
| Page data reads | `page.<frontmatterKey>`, `page.content`, `page.slug`, `page.resolved.*`, `page.canonical.url` | Bare `<key>`, `content`, `page.fileSlug`, `resolved.*`, `{{ site.url }}{{ page.url }}` | Codemod rules `page-props`, `page-resolved`, `canonical-url`. `page.next` / `page.previous` / `page.collection` have NO mechanical equivalent — port them by hand to the Eleventy collections API |
| Page frontmatter scope | Any frontmatter key fed the templates | META-ONLY allow-list — every key it holds is [docs/web/frontmatter.md](../web/frontmatter.md); other content keys are stripped with a build warning | Move page content out of frontmatter into `{% section %}` entries or a collection document (collection entries and layouts are exempt — their frontmatter IS the document) |
| Config namespace | A page restated omega.json5 keys BARE (`theme:`, `client:`, `inbound:`) and every template read config off the site global (`{{ site.brand.name }}`, `{{ resolved.theme.id }}`) | Three namespaces ([#607](https://github.com/Omega-JS-Stack/omega/issues/607)): a page's overrides go under a `config:` parent, templates read `resolved.config.<section>` (the WHOLE merged config), `meta` is PAGE machinery keeping its bare/flat spelling, and `site.*` is BUILD FACTS only (collections, `omega`, `time`, `pricing`, `targets`, …) | Codemod rules `config-parent` (the frontmatter keys) and `config-reads` (the reads, bodies + frontmatter values + section `.json` descriptors, [#611](https://github.com/Omega-JS-Stack/omega/issues/611)) — `omega migrate` runs both. Nothing dual-reads, and the `config:` rule runs both ways: a bare config section fails the build naming the key, a non-section key under `config:` fails the same way, and a `site.<section>` read fails naming the expression |
| Site-wide page meta | A `meta` block in the config (`_config.yml`, then omega.json5's `meta` section) set the default title/description/index for every page | NO config meta section at all ([#607](https://github.com/Omega-JS-Stack/omega/issues/607), Ian 2026-08-26 — meta never exists in two places). Page frontmatter `meta:` is the only meta; the site-wide default is `brand.name` / `brand.description` ([docs/web/frontmatter.md](../web/frontmatter.md)) | `omega migrate` drops the legacy block with a note; a converted omega.json5 still carrying `meta` (or `targets.web.meta`) is a retired-key error naming the move. Move a real site-wide title/description into `brand.name` / `brand.description`, and anything per-page into that page's own `meta:` |
| Redirects | Hand-maintained redirect pages under `src/defaults/dist/redirects/**` on UJM's `redirects` layout, and TEMPLATED ones (`/c/:id` → `/code?id=:id`, DashQR's QR codes) hand-authored in the Cloudflare dashboard where nothing declared them | Two declared mechanisms, split by whether the URLs can be enumerated ([#466](https://github.com/Omega-JS-Stack/omega/issues/466)): a redirect PAGE — `redirect.url` in frontmatter on the `modules/utilities/redirect` layout, and the build emits meta-refresh + canonical + noindex — and `edge.providers.cloudflare.rules.redirect`, the zone's dynamic-redirect ruleset `omega manage` reconciles | Redirect pages port as pages (the layout name is the only change). Move every dashboard-authored redirect rule into `edge.providers.cloudflare.rules.redirect` so the zone has a declared source; `omega manage` then owns the ruleset and REMOVES any rule config does not name. There is no web-config redirect key: `targets.web.redirects` existed only in 0.45.0–0.49.0 and is now a retired-key error naming this move |
| `append: true` frontmatter | A page body rendered BELOW the layout's default `{% composition %}` when the page declared the flag | Gone ([#607](https://github.com/Omega-JS-Stack/omega/issues/607)) — a page body always REPLACES the composition | Codemod rule `append-flag` drops the key with a finding. To keep the default bands, run `omega customize <url>` to materialize them into the page, then edit them |
| Nested loops | `forloop.parentloop.<prop>` | A hoisted `{% assign omega_parentloop<depth>_<prop> = forloop.<prop> %}` after the parent `{% for %}` (LiquidJS has no parentloop) | Codemod rule `parentloop`; it flags the cases it will not touch (multi-level, same-line) for hand-hoisting |
| Interpolated tag args | `{% uj_icon "{{ page.icon }}" %}` — Jekyll silently no-op'd it | `{% capture omega_migrate_arg_1 %}…{% endcapture %}` hoisted above, the variable passed as the arg | Codemod rule `tag-arg-interpolation`; verify each reported line that it could not rewrite |
| Icons | The `uj_icon`/`omega_icon` TAG, plus a `prerender_icons` frontmatter list that drew hidden copies for JS to clone | Native Font Awesome markup, `<i class="fa-solid fa-rocket"></i>`, everywhere ([#619](https://github.com/Omega-JS-Stack/omega/issues/619)): the build inlines every icon the rendered page names, and a runtime watcher upgrades whatever JS creates afterwards, from `/assets/icons/<style>/<name>.svg`. Country flags are the second namespace, `<i class="omega-flag omega-flag-us">` | Codemod rule `icon-tag-markup` converts every icon tag (both spellings) to markup; drop `prerender_icons` from frontmatter and delete any `getPrerenderedIcon` call in favour of an `<i class="fa-…">` string. A `label=` option has no native equivalent and is dropped — hand-write `role="img" aria-label` where an icon really carries meaning. Contract: [docs/shared/icons.md](icons.md) |
| Includes | `{% include /components/x.html %}` | `{% include components/x.html %}` (no leading slash) | Codemod rule `include-slash` |
| Analytics template reads | `site.analytics.google` | `resolved.config.analytics.providers.google.id` | Codemod rules `analytics-shape` (the provider shape) then `config-reads` (the namespace) |
| Classy gradient utilities | `.gradient-animated` (gradient shimmer) + `.gradient-grain` (noise overlay) on hero markup | `omega-dotgrid` — the masked dot backdrop v2 puts behind every hero — plus `data-omega-dotfield` where the animation was. Classy v2 ships zero gradients, so the old classes are silent no-ops | Codemod rule `gradient-utilities` converts both once ([#296](https://github.com/Omega-JS-Stack/omega/issues/296)); the pair on one element collapses to ONE `omega-dotgrid`. `.bg-gradient-*` names are NOT touched — v2 still neutralizes those to flat token paint |
| Sass entry | `@use 'ultimate-jekyll-manager' as * with (…)` in `src/assets/css/main.scss`; page CSS files `@use`-ing themselves | `@use 'omega:main' with (…)`; the self-`@use` lines are gone (every layer's page sheet already loads, [#624](https://github.com/Omega-JS-Stack/omega/issues/624)) | `omega migrate`'s consumer-assets pass rewrites both; by hand it is a one-line edit plus deleting the self-`@use` lines |
| JS entry | Seeded `src/assets/js/main.js` bootstrapping the manager | Deleted — core main + the boot runtime own it | `omega migrate` deletes an untouched seed and FLAGS a customized one; port custom logic into a page or section module |
| Client bootstrap | `import webManager from 'web-manager'`; `window.Manager` global | `import omega from '@omega.js/web/runtime'`, the web instance; no window global | Replace the import in every module and delete `window.Manager` references. The accessor and auth shapes are in [one runtime shape](#2026-09-25-one-runtime-shape-on-every-package-945) |
| Deploy | `npu sync --message='Deploy'` shell-out | `omega deploy` (plain git sync + `workflow_dispatch`, or the direct lane) | Replace the script; contract in [deploys.md](deploys.md) |
| Version maintenance | Setup-time `ensureManagerVersion()` + peer-dependency auto-install | The explicit `omega update` verb | Stop expecting self-updates; run `npx omega update` (`--dry-run` to only report) — [updates.md](updates.md) |
| Charts | A page imported `chart.js` bare (it was a `@omega.js/web` dependency) and built its own `new Chart(canvas, config)` | `chart.js` is gone — the framework draws with TanStack Charts ([#772](https://github.com/Omega-JS-Stack/omega/issues/772)), reached ONLY through `__main_assets__/js/libs/charts.js` (`loadCharts`, `chartSlot`, `chart`) | Replace the bare import and the hand-built config with the helpers, and the page's `<canvas>` with `chartSlot`'s markup (an SVG chart has no canvas). A page that genuinely needs the raw grammar imports `@tanstack/charts` bare instead — same framework-resolution rule, new name |

## `backend-manager` → `@omega.js/backend`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Package + init | `require('backend-manager')`; `Manager.init({ backendManagerConfigPath: 'backend-manager-config.json' })` | `const omega = require('@omega.js/backend');`, then `omega.initialize({ … });` and `module.exports = omega.functions;`; the config loader discovers the file, so there is no config-path option | Swap the dependency, rewrite the entry to that shape and delete the `backendManagerConfigPath` option. The handler and `ctx` shapes are in [one runtime shape](#2026-09-25-one-runtime-shape-on-every-package-945) |
| Config | `functions/backend-manager-config.json` | `functions/config/omega.json5` | Key-by-key table in [config.md](config.md#backend-manager-functionsbackend-manager-configjson--functionsconfigomegajson5--done-checkpoint-19) |
| Exported Cloud Functions | `bm_api`, `bm_signUpHandler`, `bm_createPost`, `bm_cronDaily`, … | `omega_api`, `omega_signUpHandler`, `omega_createPost`, `omega_cronDaily`, … | Deploy the new names, repoint every trigger/scheduler/webhook that names a function, then DELETE the orphaned `bm_*` functions from the Firebase project (a rename leaves the old ones running) |
| Hosting rewrite | `{ source: '/backend-manager/**', function: 'bm_api' }` | `{ source: '{/omega,/omega/**,/mcp,/mcp/**,/.well-known/oauth-protected-resource,/.well-known/oauth-authorization-server,/authorize,/token,/register}', function: 'omega_api' }` | The next verb's `ensureTarget()` writes it (and removes duplicates); by hand, replace the rewrite and keep it FIRST in the list |
| API dispatch | Command-based: `POST /backend-manager` with `{ command: 'user:sign-up', payload: {…} }` | REST: `POST /omega/user/sign-up` with the payload AS the body | Rewrite each caller: the command's `:` becomes a path segment, `payload` becomes the body. On the client, `omega.request('/omega/user/sign-up', { method: 'POST', body: {…} })` |
| URL prefix | `/backend-manager/*` | `/omega/*` (also `/omega_api/*` on the direct function URL) | Repoint every caller: the old prefix answers 404 |
| Per-request object | `BackendAssistant`; handler signature `module.exports = async ({ assistant, settings, analytics }) => …` | `Context` (`ctx`); handler signature `module.exports = async ({ ctx, omega, user, data, usage, analytics }) => …` | Rename the destructured argument and every `assistant.` call site (`ctx.respond`, `ctx.log`, `ctx.request`) in each custom route, event, and cron handler; `settings` is `data` |
| Environment | `BACKEND_MANAGER_KEY`, `BACKEND_MANAGER_WEBHOOK_KEY`, `BEM_TEST_RUNNER`, `BEM_HTTPS_PORT` | `OMEGA_ADMIN_KEY`, `OMEGA_WEBHOOK_KEY`, `OMEGA_HTTPS_PORT`; `BEM_TEST_RUNNER` has no successor, a test lane names `OMEGA_ENVIRONMENT=testing` ([the 2026-10-02 section](#2026-10-02-one-name-says-a-test-run-is-on-931)) | Rename in `.env`, in CI secrets, and in anything that reads them, and delete `BEM_TEST_RUNNER`. Values carry over unchanged |
| AI provider keys | TWO names per provider: `BACKEND_MANAGER_OPENAI_API_KEY` (the company-wide fallback) beside a bare `OPENAI_API_KEY` (the brand's own), and the same pair for Anthropic. The provider preferred the bare one and fell back to the prefixed; `inferContact` read ONLY the prefixed one | ONE name per provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` ([#639](https://github.com/Omega-JS-Stack/omega/issues/639)). Every reader takes the bare name through the one env reader; the OMEGA-era `OMEGA_OPENAI_API_KEY` / `OMEGA_ANTHROPIC_API_KEY` twins are removed outright, with no dual-read | Rename `BACKEND_MANAGER_OPENAI_API_KEY` (or `OMEGA_OPENAI_API_KEY`) to `OPENAI_API_KEY` in `.env` and CI secrets, same for Anthropic, and delete the old rows. A key that served EVERY brand moves to the COMPANY `.env` under that same bare name — the cascade is the fallback, never a second key. An interactive `npx omega manage` asks for both once (the `ai` service) and writes them for you |
| CLI | `bm` / `bem` / `backend-manager` / `mgr` bins | `omega` / `omg` / `mgr` (one dispatcher; a backend's `functions/` dir resolves to the backend CLI) | Replace the bin name in npm scripts and workflows |
| `test/*` routes | Every route under `routes/test/` served at its production URL | The whole `test/` route folder 404s outside dev/testing, with zero carve-outs; contract in `docs/backend/routes.md` ([#238](https://github.com/Omega-JS-Stack/omega/issues/238)) | Use `/omega/health` for liveness (a real route, public, no input echoed) — not `/omega/test/health`. A brand whose own `routes/test/*` route must serve in production moves it out of the `test/` folder; debug routes belong in `test/` and are gated by default |
| Test discovery | The BEM runner discovered plain `.js` files under `test/` | devkit's discovery matches `*.test.js` only (`findTestFiles` in `packages/devkit/src/test/discovery.js`): a `test/<name>.js` file is invisible, and the run reports zero tests with no error ([#481](https://github.com/Omega-JS-Stack/omega/issues/481)) | Rename every ported test file to `<name>.test.js`; a suite left on the old spelling goes silently dark |
| Marketing prune cron | Ran daily unless `marketing.prune.enabled: false` — a brand with NO `marketing.prune` block was pruning | ON by default again: the config schema's `marketing.prune.enabled: true` default rides the resolved chain ([#478](https://github.com/Omega-JS-Stack/omega/issues/478), superseding #422's opt-in interlude); only an explicit `false` stops it, and the per-provider safety floors bound what a run may delete | A brand that must NOT prune sets `marketing.prune.enabled: false`; everyone else does nothing — matching the legacy default |
| Firestore rules file | `firestore.rules` carried a framework-managed `// ========== OMEGA Rules (vX.Y.Z) ==========` block that `omega setup` regenerated wholesale on every run | `firestore.rules` is the brand's SOURCE — pure rules, no managed block. The framework half ships inside `@omega.js/backend` and compiles in; `firebase.json` points the emulator and `firebase deploy` at the generated `dist/firestore.rules` ([#255](https://github.com/Omega-JS-Stack/omega/issues/255)) | `npx omega migrate:rules` converts the file ONCE (custom region preserved) and retargets `firebase.json`. It is a RUN-ALONE verb, never a side effect of another one ([#522](https://github.com/Omega-JS-Stack/omega/issues/522)) — while `firebase.json` still names your own rules file, the verbs report the deferral and change nothing, because adopting the compiled artifact changes what the LIVE project enforces (see the two rows below). But per-field protection a legacy BEM brand added by HAND-EDITING the managed block is not carried over, because the block is gone: re-declare those keys in your own `match /users/{uid}` block, which merges into the framework's (row below). Keys are TOP-LEVEL — protecting `xp.total` means listing `'xp'` |
| Firestore rules hooks (0.36.0 only) | The compiled model shipped with two brand HOOKS the framework called: `protectedFields()` (a list folded into the user write rule) and `canWriteUser()` (a condition ANDed into it), linted and re-seeded by the compiler | Merge-by-match: a brand match block whose path names a framework block's is MERGED into it, ANDing the brand's condition onto every op both declare. No hooks, no lint, no injection. Rules schema v2.0.0 → v3.0.0 ([#353](https://github.com/Omega-JS-Stack/omega/issues/353)) | `npx omega migrate:rules` migrates ONCE: a hook still carrying its shipped default body is deleted, a CUSTOMIZED one is kept as an ordinary function and reported — nothing calls it any more, so move what it enforced into `match /users/{uid} { allow create, update: if …; }` in your own file and delete it. `protectedFields()` becomes `allow create, update: if !isWritingAny(['xp', …]);` in that block |
| Firestore rules helpers | `belongsTo(identity)`, `emailVerified()`, `isWritingProtectedUserField()`, `authUid()`, `authEmail()`, `existingData()`, `incomingData()`; `existingData()` was `resource.data`, so every field helper ERRORED on a create (which denied the write) | One naming convention, `is*` for predicates and `get*` for values: `isUser(identity)`, `isEmailVerified()`, `isWritingFrameworkField()`, `getAuthUid()`, `getAuthEmail()`, `getExistingData()`, `getIncomingData()`, plus new `isWritingAny(fields)` and `isOwner()`. `getRoles()` keeps its name and stays the one helper that bills a document read. `getExistingData()` reads an absent document as `{}`, so the field helpers mean the same thing on create and update ([#353](https://github.com/Omega-JS-Stack/omega/issues/353)) | The `npx omega migrate:rules` migration renames every one of those calls inside your rules file. Three behaviour changes to know: a signed-in client may now CREATE its own `users/{uid}` document as long as it carries no framework-owned key (before, every client create was denied by the error); `isUser()`'s EMAIL arm now requires a verified token, so an unverified signup claiming an address no longer matches a document keyed by it (the uid arm is unchanged); and `plan` and every other `User` property name are on the framework's protected key list, since a stored one throws when its `User` is built; `npx omega manage --migration=users --execute` deletes a legacy top-level `plan` |
| `isEmailVerified()` source of truth | Read the STORED `users/{uid}.verifications.email` through `getVerifications()`, at one billed document read per call | Reads the AUTH TOKEN: `request.auth != null && request.auth.token.get('email_verified', false) == true`. `getVerifications()` is REMOVED, and `verifications` joins the framework-owned key list ([#353](https://github.com/Omega-JS-Stack/omega/issues/353)) | Nothing to rename — the helper keeps its name and gets honest: nothing in the stack has ever WRITTEN `verifications`, so the old gate was satisfiable only by a client planting the field on its own user document. Rules of yours that called `getVerifications()` must stop (it is gone), and a client write to `users/{uid}.verifications` is denied from now on |
| Framework `match /users/{uid}` ops | `allow read` + `allow write` — and `write` covers delete, where `request.resource` is null, so the field guard ERRORED and an owner deleting their own user document was denied by that error | `allow read` + `allow create, update`. Delete falls through to the admin catch-all and is denied by the RULE ([#353](https://github.com/Omega-JS-Stack/omega/issues/353)) | Only if you TIGHTEN that block from your own `firestore.rules`: ops pair by NAME, so change your `allow write:` to `allow create, update:` or your condition appends as a widening instead of ANDing on. The compiler reports the mismatch loudly rather than letting it look like a tightening |
| Pre-family markers | Four marker shapes with no common grammar: the hand-written `{{ backend-manager }}` placeholder (`firestore.rules`, `database.rules.json`), the `# BEM>>>` … `# <<<BEM` block in `.gitignore`, and the `///---backend-manager---///` … `///---------end---------///` rules block (plus its short-lived `///---omega---///` OMEGA-era flavor) | ONE family grammar, `<comment> ========== <Label> ==========`, everywhere a marker is machine-parsed. Every evergreen verb reads ONLY the family, so a pre-family file converges at no verb | `npx omega migrate:markers` converts all four ONCE, run alone: the `# BEM>>>` block is deleted whole (its lines were framework-owned and the Default zone re-writes them), `firestore.rules` lands on the compiled-rules source shape with your own rules kept, and `database.rules.json`'s block is re-cut to the family markers with its rules untouched. The target checks DEFER on a pre-family file — reported as a warning (not a failure, so nothing auto-fixes it), naming this verb, tree untouched — and the compiler REFUSES to write `dist/firestore.rules` from a source still carrying one, rather than splicing the marker in as if it were a rule ([#40](https://github.com/Omega-JS-Stack/omega/issues/40)) |
| Storage rules scaffold | `templates/storage.rules` granted the whole bucket to any signed-in user (`allow read, write: if request.auth!=null`) | Deny-all (`allow read, write: if false`) — a brand that serves files from Storage opts in per path it actually exposes ([#278](https://github.com/Omega-JS-Stack/omega/issues/278)) | Nothing is rewritten in place: the scaffold writes `storage.rules` only when the file is missing, so a migrated brand keeps whatever it arrived with. Read that file once and narrow it by hand — a bucket-wide grant carried over from the old scaffold stays live until you do |

## `electron-manager` → `@omega.js/desktop`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Package + entries | `require('electron-manager/main' \| '/preload' \| '/renderer' \| '/gulp')` (the scaffold README named a `/test/assert` entry the package never exported) | `require('@omega.js/desktop/main' \| '/preload' \| '/renderer' \| '/gulp')`; no assert entry: a test's `run`/`inspect` receives `expect` on its context ([#812](https://github.com/Omega-JS-Stack/omega/issues/812)) | Swap the dependency and every require path in `src/main.js`, `src/preload.js`, the renderer components, and `gulpfile.js`; in the test files, drop the assert require and use `ctx.expect` |
| CLI | `em` / `electron-manager` / `mgr` bins | `omega` / `omg` / `mgr` | Replace the bin name in npm scripts and workflows |
| Config | `config/electron-manager.json` | `config/omega.json5` | Key-by-key table in [config.md](config.md#electron-manager-configelectron-managerjson--configomegajson5--done-checkpoint-18) — note the per-OS move: `targets.mac` / `.win` / `.linux` → `targets.desktop.platforms.mac` / `.win` / `.linux` |
| Apple signing material | The legacy company store, `omega-manager/.output/_shared/certificates/apple/` (one set for every brand, on one machine) | The TWO-tier signing tree ([#892](https://github.com/Omega-JS-Stack/omega/issues/892)): `<company brand>/company/.omega/certificates/apple/` read FIRST, the brand's own `.omega/certificates/apple/` second, and every WRITE into the company tree when the brand names a company. The layout is byte-for-byte the legacy one | **By hand, once**: copy `AuthKey_*.p8`, `certificates/*.cer` and `csr/*/{private.key,request.csr}` from the legacy store into the company tree, skipping `_backups` and the legacy `.p12` files (the walk re-exports those with the password it mints). The `csr/*/private.key` half is the load-bearing one: without it the walk ERRORS per type instead of minting a second certificate over a valid one. Step 5 of the [migration playbook](../manager/migration.md) |
| Unsigned mac builds | Every rung warned and carried on, so a mac release could publish unsigned and unnotarized on a green run | Each rung is an ERROR that stops the run ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)): the certificates walk, `validate-certs` (strict in the deploy precheck and in `publish`), the precheck's secrets push (`fatal` on all four frameworks), the workflow's mac steps (`exit 1`), and the notarize hooks (which now staple and PROVE with `stapler validate` + `spctl --assess`). There is no per-brand "unsigned mac" switch | Set `CSC_KEY_PASSWORD` and the `APPLE_*` three in the brand or company `.env` and run `omega manage --service certificates`; `CSC_LINK` and `APPLE_API_KEY` are DERIVED from the signing tree, never typed. The env schema marks the set required once `certificates.providers.apple` is declared, and the deploy precheck refuses to publish a half set |
| Windows signing strategy | `config/electron-manager.json` → `signing.windows.strategy` | `config/omega.json5` → `targets.desktop.platforms.win.signing.strategy` | Move the key; the `.env` credential slots (`CSC_LINK`, signtool path, cloud-provider creds) keep their names |
| Windows runner logon account | `WIN_RUNNER_LOGON_ACCOUNT` + `WIN_RUNNER_LOGON_PASSWORD`, plus a DPAPI-encrypted `runner-logon.json` and an `omega runner set-credentials` subcommand, named the account the runner's Windows service ran as | GONE ([#337](https://github.com/Omega-JS-Stack/omega/issues/337)). The signing runner is a Startup-folder `.cmd` in the logged-in user's own session — there is no service and no scheduled task, so there is no second account to name. Nothing read either key | **On the signing box, by hand**: delete `WIN_RUNNER_LOGON_ACCOUNT` and `WIN_RUNNER_LOGON_PASSWORD` from its `.env` (and from GitHub Actions secrets if they were ever pushed), and delete `%APPDATA%\@omega.js/desktop\runner-logon.json`. Nothing replaces them |
| Windows EV cert reference | `WIN_EV_TOKEN_PATH`, with `WIN_CSC_LINK` silently accepted as a fallback alias by the signer and by `validate-certs` | `WIN_EV_TOKEN_PATH` only — the env-schema name, and the ONE name ([#337](https://github.com/Omega-JS-Stack/omega/issues/337)). Nothing reads `WIN_CSC_LINK`, so a box that only sets it now fails loudly naming `WIN_EV_TOKEN_PATH` | **On the signing box, by hand**: rename the key in its `.env` (and in any GitHub Actions secret feeding the `windows-sign` job) from `WIN_CSC_LINK` to `WIN_EV_TOKEN_PATH`. The value — a SHA1 thumbprint or a `.pfx` path — is unchanged. electron-builder's own `WIN_CSC_LINK` is a different variable and is untouched |
| Windows signing runner install | `em runner`: home `%LOCALAPPDATA%\em-runner` (`C:\actions-runners` before v1.2.36), Startup shortcuts and GitHub-side runners named `em-runner-<host>-<org>` | `omega runner`: home `%LOCALAPPDATA%\omega-runner`, shortcuts and runners named `omega-runner-<host>-<org>` ([#337](https://github.com/Omega-JS-Stack/omega/issues/337)). The legacy install is detected: `status` names it, `uninstall` deregisters and removes it, `install` tears it down first | **On the signing box**: `npx omega runner install` with `GH_TOKEN` set (`admin:org`). Nothing to move by hand — the old registrations come off GitHub through their own `config.cmd remove`; if one does not, the summary names it and a later `uninstall` retries |
| Config validation | EM's local validation util | The shared `@omega.js/config` schema, at boot and in the audit task | Nothing to move — but expect boot to report schema findings a legacy config silently carried, and fix them |
| Preload global | `contextBridge.exposeInMainWorld('em', …)` → `window.em` | `window.desktop` | Rename every `window.em.*` call in renderer code |
| Theme controls | `data-em-theme-set="system\|light\|dark"` | `data-omega-theme-set="system\|light\|dark"` | Rename the attribute in every view |
| Client bridge | `web-manager-bridge.js`; `manager.webManager` in renderer entries | The renderer instance extends `@omega.js/client` (`omega.auth`, `omega.firestore`); main reads the account as `omega.auth` | Rewrite every `webManager.` call to `omega.` on the instance; the desktop shapes are in [one runtime shape](#2026-09-25-one-runtime-shape-on-every-package-945) |
| Environment | `BACKEND_MANAGER_KEY` in the app's `.env` | `OMEGA_ADMIN_KEY`, resolved through the `.env` cascade (shell > local > brand root > company) | Rename the key; in a brand monorepo put the value at the brand root and leave the target's placeholder commented |
| Bundler overrides | `config.em.webpack.externals`: an array of extra module names the desktop webpack build marked `commonjs2` external | GONE ([#737](https://github.com/Omega-JS-Stack/omega/issues/737)): the bundler is esbuild and there is no consumer-facing override key. The externals set is the framework's native-module list plus what the consumer's own `package.json` declares from it | Delete the key. Nothing replaces it: ESM-only dependencies BUNDLE (a CommonJS bundle keeps `import.meta.url`, [#906](https://github.com/Omega-JS-Stack/omega/issues/906)), and native modules stay external through the framework's own list. A consumer with a genuinely native module the list does not name raises it upstream: the list lives in `src/gulp/tasks/bundle.js` (`nativeExternals`) and grows there, so every brand gets the fix |
| Gulp task name | `webpack` — `npm run gulp -- webpack`, and `[@omega.js/desktop:webpack]` in the logs | `bundle` — `npm run gulp -- bundle`, `[@omega.js/desktop:bundle]` ([#737](https://github.com/Omega-JS-Stack/omega/issues/737)) | Nothing for a normal consumer: the `build` / `package` / `publish` verbs are unchanged and nobody's npm scripts name the sub-task. Rename it in anything that invokes the gulp task directly, or greps `build.log` for the old tag |
| Downloads mirror | `targets.desktop.downloads: { enabled, owner, repo, tag }`: a second public repo (`download-server`) holding one `installer` tag of fixed-name copies of every artifact, written by the `mirror-downloads` gulp task and by `finalize-release` | GONE ([#799](https://github.com/Omega-JS-Stack/omega/issues/799)): ONE public releases repo per brand, `<brand.id>-releases` by default, whose assets already carry no version ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)), so `/releases/latest/download/<asset>` is the permanent link the mirror existed to provide. All four `downloads.*` keys are retired keys a carrying config now fails validation on | Delete the `downloads` block. Nothing replaces it: the site already links the releases repo, and `targets.desktop.releases` (both keys optional) addresses it. If a published link points at the old mirror repo, redirect it or re-point it at `https://github.com/<owner>/<brand.id>-releases/releases/latest/download/<asset>` |
| Startup config | `startup.openAtLogin: true\|false` — a bare boolean | `startup: { openAtLogin: { enabled, mode } }` (`startup.mode` is a SEPARATE knob: the user-launch mode) | Rewrite the boolean as the object under the same `openAtLogin` key. The boolean is TEMPORARILY still read: the config schema declares only `startup.mode`, so it cannot reject the old shape yet — the acceptance leg retires with the schema entry ([#148](https://github.com/Omega-JS-Stack/omega/issues/148) trail) |

## `browser-extension-manager` → `@omega.js/extension`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Package + entries | `require('browser-extension-manager/build')` (the scaffold README named a `/test/assert` entry the package never exported) | `require('@omega.js/extension/build')`; no assert entry: a test's `run`/`inspect` receives `expect` on its context ([#812](https://github.com/Omega-JS-Stack/omega/issues/812)) | Swap the dependency and the require paths in `hooks/build/pre.js`, `hooks/build/post.js`, and `gulpfile.js`; in the tests, drop the assert require and use `ctx.expect` |
| CLI | `xm` / `bxm` / `ext` / `browser-extension-manager` / `mgr` bins | `omega` / `omg` / `mgr` | Replace the bin name in npm scripts and workflows |
| Config | `config/browser-extension-manager.json` | `config/omega.json5` (`targets.extension: {}` — key presence enables the target) | Key-by-key table in [config.md](config.md#browser-extension-manager-configbrowser-extension-managerjson--configomegajson5--done-checkpoint-20) |
| Analytics secret | `analytics.providers.google.secret` in the config file | `.env` → `GOOGLE_ANALYTICS_SECRET` (the loader hard-fails secret-shaped config keys) | Move the value to `.env`; the build snapshot bakes it exactly as before |
| Runtime singleton | `import webManager from 'web-manager'`; `manager.webManager` | `import omega from '@omega.js/extension/<context>'`: the context's instance carries the client's modules | Swap the import in every context (background, popup, options, sidepanel, content scripts) and read the client off `omega`; the extension shapes are in [one runtime shape](#2026-09-25-one-runtime-shape-on-every-package-945) |
| DOM bindings | `data-wm-bind` | `data-omega-bind` | Rename the attribute in every view |
| Cross-context messages | `{ command: 'bxm:syncAuth' }`, `{ command: 'bxm:signOut' }` | `{ command: 'omega:syncAuth' }`, `{ command: 'omega:signOut' }` | Rename in any custom `runtime.onMessage` handler or sender the extension ships |
| Bundler | webpack 5 + `babel-loader` + `@babel/preset-env`, with per-lane code splitting (`*.chunk.<hash>.js` plus `.LICENSE.txt` sidecars beside every bundle) | esbuild through @omega.js/devkit's `bundle()` wrapper ([#738](https://github.com/Omega-JS-Stack/omega/issues/738)). No consumer-facing bundler override key existed and none was added; there are no chunks and no license sidecars — every entry is ONE self-contained iife — and the syntax floor is esbuild's `target`, `chrome88, firefox91` (the MV3 minimums), not a browserslist guess | Nothing in a normal project: entry filenames (`assets/js/components/<name>.bundle.js`) are unchanged, and the manifest / views ask for the same paths. Two things to check: anything that referenced a chunk file BY NAME (nothing generated does), and any code that imported a package @omega.js/extension merely carries TRANSITIVELY — only the framework's DECLARED dependencies resolve from the framework now, so declare that package yourself or raise it upstream ([#87](https://github.com/Omega-JS-Stack/omega/issues/87)) |
| Gulp task name | `webpack` — `npm run gulp -- webpack`, and `[@omega.js/extension:webpack]` in the logs | `bundle` — `npm run gulp -- bundle`, `[@omega.js/extension:bundle]` ([#738](https://github.com/Omega-JS-Stack/omega/issues/738)) | Nothing for a normal consumer: the `build` / `publish` verbs are unchanged and nobody's npm scripts name the sub-task. Rename it in anything that invokes the gulp task directly, or greps `build.log` for the old tag |
| Build snapshot delivery | `packaged/<browser>/raw/build.js`: a JSONP file of BXM's own shape, plus a `build.json` sidecar beside it | `packaged/<browser>/raw/build.js` again, but the ONE OMEGA wrapper and the one writer every surface uses: `self.OMEGA_BUILD_JSON = { config, package, mode, license, builtAt };` plus its `config.dev` line ([#743](https://github.com/Omega-JS-Stack/omega/issues/743)). The page template loads it first, `background.js` importScripts it first, and no bundle carries a copy. The `build.json` sidecar is gone | Nothing to do if you read `window.OMEGA_BUILD_JSON` / `self.OMEGA_BUILD_JSON`: the wrapper answers as before, and a `<script src="/build.js">` tag or `importScripts('/build.js')` in a template or worker you overrode is CORRECT again. The payload is the OMEGA subset, so a read of BXM's old flat keys moves (`omega.cache_breaker` → `config.buildTime`, `omega.environment` → `config.environment`, `omega.liveReloadPort` → `config.dev.liveReloadPort`). Tooling that read `build.json` runs `build.js` instead (`readBakedBuildJson()` in `src/gulp/tasks/utils/build-json.js`) |

## `web-manager` → `@omega.js/client`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Package + import | `import webManager from 'web-manager'` (npm `web-manager`) | `@omega.js/client`, the browser base class `Omega`; each host framework exports the one instance | Swap the dependency and import the host's instance. The modules read as properties (`omega.auth`, `omega.firestore`, `omega.bindings`), and `initialize(configuration)` carries over: [one runtime shape](#2026-09-25-one-runtime-shape-on-every-package-945) |
| Global | `window.Manager` / a page-attached `webManager` | No window global: import the host framework's instance wherever it is needed | Delete the window assignments and the code that reads them |
| DOM bindings | `data-wm-bind` | `data-omega-bind` | Codemod rule `client-markup` (templates, consumer JS, and section `.json` descriptors alike) |
| Sign-out hook | `.auth-signout-btn` class, hardcoded in the auth module | The generic `omega-signout` click trigger (`registerTrigger('signout', …)` → class `omega-signout`) | Codemod rule `client-markup` renames the class everywhere it appears; custom behavior registers its own trigger instead of patching auth |
| Device module | `webManager.usage()` | `omega.device` | Rename the call sites (`usage.js` became `device.js` verbatim) |
| Configuration payload | The site emitted a `web_manager` block into `window.Configuration` | The `client` section of `OMEGA_BUILD_JSON.config` (#894, the row above) | Config-side rename: see the UJM row and [config.md](config.md); nothing dual-reads the old key |
| Version-check manifest | The client probed `/build.json` then `/@output/build/build.json`, reading `data.timestamp` OR `data['npm-build'].timestamp` | One fetch of the site's `build.json` — mounted under the page's `data-omega-path-prefix` stamp on a site served from a URL path ([#364](https://github.com/Omega-JS-Stack/omega/issues/364)), `/build.json` at the domain root — and one read of `data.timestamp` (the omega web build emits exactly this) | Nothing to do on a migrated site. A site still serving the old path or the `npm-build` wrapper logs "No timestamp found in build.json" and never auto-reloads on a new deploy |

## `jekyll-uj-powertools` → `@omega.js/template-kit`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Delivery | Ruby gem `jekyll-uj-powertools` in the `Gemfile` | JS package `@omega.js/template-kit`, vendored into `@omega.js/web` | Remove the gem line (the whole `Gemfile` goes — see the UJM engine row); nothing to install, the filters and tags are registered by the web engine |
| Tag + filter names | `uj_icon`, `uj_image`, `uj_readtime`, `uj_liquify`, … (`iftruthy`, `iffalsy`, `iffile`, `urlmatches` were already unprefixed) | `omega_image`, `omega_readtime`, `omega_liquify`, … — the four unprefixed names are unchanged, and `uj_icon` becomes MARKUP rather than a renamed tag (the icons row above) | Codemod rules `legacy-prefix` (every registered name) and `icon-tag-markup` (the icon tag); there are NO aliases, so a missed `uj_*` is an undefined tag/filter. Inventory: [docs/web/template-kit.md](../web/template-kit.md) |
| Site namespace | `site.uj.*` (`cache_breaker`, `date.year`, `date.iso`, `placeholder.src`); Jekyll's `site.time` | `site.omega.*`; the build stamp is `site.omega.date.iso`. `site.time` stays, set by the engine to the same instant ([#613](https://github.com/Omega-JS-Stack/omega/issues/613)) | Codemod rule `legacy-prefix` handles `site.uj`; `site.time` needs nothing |
| Markup hooks | `uj-password-show`, `uj-password-hide`, `uj-language-flag`, `uj-language-dropdown`, `uj-schema-*`, `data-uj-no-translate` | `omega-password-show`, `omega-password-hide`, `omega-language-flag`, `omega-language-dropdown`, `omega-schema-*`, `data-omega-no-translate` | Codemod rule `legacy-prefix` renames all of them; check hand-written CSS/JS that selects on the old names |
| Ruby generators + hooks | `variable_resolver.rb`, `blog-taxonomy.rb`, `inject-properties.rb`, `dynamic-pages.rb`, `limit-collections.rb`, `markdown-images.rb`, `parallel-build.rb` | Engine features of `@omega.js/web` (frontmatter Liquid, collections + pagination, the `resolved` cascade) — not template functions | Nothing to migrate: they were never consumer-callable. Which of them exist today and which never got ported is [#78](https://github.com/Omega-JS-Stack/omega/issues/78)'s table, not this register |

## `omega-manager` → `@omega.js/manager`

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Brand config home | Central: `omega-manager/.brands/<id>/config.json` (one repo describing every brand) | The brand's OWN repo: `config/omega.json5` | Convert the brand's config file into the brand repo using the tables in [config.md](config.md) (shared sections at the top level, per-surface settings under `targets.<name>`), then retire the `.brands/<id>/` entry |
| Enabled targets | `targets: ['website', 'backend']` — an array | `targets: { web: {}, backend: {} }` — an object where key PRESENCE enables the target | Rewrite the array as object keys; note the rename `website` → `web` |
| Repo topology | One clone per surface, located by `local.folder` + `github.orgMain` / `orgWebsite` | ONE brand monorepo: npm workspaces, `targets/<target>/` per enabled target ([docs/manager/brand.md](../manager/brand.md)) | Merge the per-surface repos into one brand repo as `targets/web`, `targets/backend`, `targets/desktop`, `targets/extension`; the brand root holds `config/omega.json5`, `.env`, `assets/`, and the workspace `package.json` |
| Durable state | `omega-manager/.output/<id>/state.json` | No durable-state CACHE at all — every provisioned fact lands in the brand's `config/omega.json5`, every secret in its `.env` ([#434](https://github.com/Omega-JS-Stack/omega/issues/434)); the brand's own `.omega/state.json` keeps only per-machine records (the deploy stamps, [#479](https://github.com/Omega-JS-Stack/omega/issues/479)) | Nothing to copy: a manage run resolves the ids from the platform and writes them into their real homes. Never commit `.omega/` |
| Service names (the last eight) | Services still carried their PROVIDER's name: `github` / `cloudflare` / `recaptcha` / `search-console` / `adsense` / `slapform` / `chatsy` / `replyify` ([#418](https://github.com/Omega-JS-Stack/omega/issues/418)) | Every service now matches its config ROLE key: `repo` / `edge` / `captcha` / `search` / `advertising` / `forms` / `chat` / `email`. The provider KEYS underneath are unchanged (`repo.providers.github`, `edge.providers.cloudflare`, `captcha.providers.recaptcha`, `search.providers.searchConsole`, `advertising.providers.adsense`, `forms.providers.slapform`, `inbound.chat.providers.chatsy`, `inbound.email.providers.replyify`) — the service is the role, the provider is a value | Update `--service=<name>` in any script or cron (`--service=cloudflare` is now `--service=edge`, …) and expect the walk's `[NAME]` log tag to change with it |
| AGENTS.md healing | Line 1 imported `@node_modules/@omega.js/manager/AGENTS.md`; the walk rewrote that target and scrubbed the cp244 marker/skeleton lines | Superseded by the marked `AGENTS.md` of the 2026-09-29 section above: the next manage converges the file, every import line and the generated heading dropped, every other line landing under Custom | Delete a leftover cp244 `<!-- ^ OMEGA framework agent guide ... -->` comment from under Custom by hand: the converge keeps it as your line |
| package.json script healing | Script values leading with the `omega-manager` bin token were healed to `omega` on every walk | Missing `manage: "omega"` and `deploy: "omega deploy"` scripts are minted, and exactly one value migrates: the legacy `start: "omega"` becomes `start: "omega dev"` ([#227](https://github.com/Omega-JS-Stack/omega/issues/227)); every other script value, the `omega-manager` token included, is never rewritten | Replace the leading `omega-manager` token with `omega` by hand (arguments unchanged) — unedited, the script fails at run time with command-not-found: no `omega-manager` bin exists (Ian retired the vestigial shim, 2026-08-05) |
| Secrets store | `omega-manager/.output/<id>/secrets/*.json` | The brand's `.omega/secrets/*` plus the `.env` cascade (local → brand → company) | Move the files into the brand's `.omega/secrets/`; secret VALUES belong in `.env`, never in `omega.json5`. The Google OAuth client changed shape (`oauth.json` `{ googleClientId, googleClientSecret }` → `google-oauth.json` `{ clientId, clientSecret }`): carry the legacy file in and `npx omega onboard` converts it ONCE and removes it ([#501](https://github.com/Omega-JS-Stack/omega/issues/501)) — nothing dual-reads the old name |
| Brand assets | `omega-manager/.brands/<id>/assets/` | The brand repo's `assets/` (logo sources, templates); derived variants land in the gitignored `.omega/assets/` | Copy the source assets into the brand repo; a manage cycle regenerates the derived set |
| Entry point | `npm start` inside the omega-manager repo, all brands at once, `--brand <id>` to narrow | `npx omega` (or `npm run manage`) inside the BRAND root — one brand, always; `--service=<name>` still narrows to one service | Run the manage cycle from the brand repo; there is no cross-brand run |
| Retired flags | `--bump`, `--build`, `--sync`, `--deploy`, `--exec`, `--dirty`, `--force-recreate` | Gone with the multi-repo-clone model | Use the per-target verbs instead: `omega deploy` at the brand root fans out (backend → web → extension/desktop), `omega update` handles version bumps. The drop calls are recorded in [#78](https://github.com/Omega-JS-Stack/omega/issues/78) |
| Quick task runner | `npm start -- --quick[=<task>]` in the omega-manager repo: one-off AI prompt tasks under `src/services/_quick/`, run across every brand | Retired; nothing replaced it | Nothing to migrate: a one-off task is a script in the brand, or an issue against the framework |
| Stripe test-flow simulator | `npm run stripe` in the omega-manager repo: the `stripe-cli` flows (cancellation, payment-failure, reset, trial-expiry), run by hand against Stripe test mode | The backend's payment journey tests (`journey-payments-*`: the `test` provider through the full unified pipeline, end to end) and the opt-in `--lane=stripe-live` lane (the pipeline against real Stripe test-mode events, forwarded by `stripe listen`): [docs/backend/payment-system.md](../backend/payment-system.md), [docs/backend/test-framework.md](../backend/test-framework.md) | Run `npx omega test` in the backend target; for real deliveries, `npx omega test --lane=stripe-live` with an `sk_test_` `STRIPE_SECRET_KEY` in `.env.testing` |
| Disperse `products`, `pricing-md` and `cdn` paths | Disperse copied the payment catalog into the backend's `backend-manager-config.json`, stripped hardcoded values from the website's `src/pages/pricing.md`, and copied the derived brand assets into a CDN repo and deployed it | Nothing is copied: every target reads `payment.products[]` in `config/omega.json5` directly. No `pricing.md` is written: pricing renders from that catalog (`site.pricing`, [docs/web/index.md](../web/index.md)). No CDN repo is fed: the derived asset set stays in `.omega/assets/`, and a CDN is a sibling web target ([config.md](config.md)) | Move any plan data a page kept by hand into `payment.products[]` (a page's `pricing.plans` front matter has no successor: [docs/manager/migration.md](../manager/migration.md)); declare a CDN as a sibling `cdn: { type: 'web' }` target |

## Cross-cutting

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Config keys (every framework) | Per-framework key names and homes | The omega.json5 schema | **Do not re-derive them here** — the key-by-key mapping tables are in [config.md](config.md#migration--legacy-configs--omegajson5), one table per legacy framework, and they are the SSOT |
| Config file | One JSON file per framework (`ultimate-jekyll-manager.json`, `backend-manager-config.json`, `electron-manager.json`, `browser-extension-manager.json`) | ONE format everywhere: `config/omega.json5`, merged `defaults ← company ← brand shared ← brand targets.<name> ← local shared ← local targets.<name>` | Convert once, delete the old file. In a brand monorepo the targets carry no config of their own: the brand root's file owns everything |
| Retired key names | Renamed keys used to validate clean and their contents vanished | Retired names FAIL validation wherever they sit, naming their replacement (`web_manager` → `client`, `firebaseConfig` → `cloud`), plus path-based retirements (`slapform` → `forms.providers.slapform`, `cloudflare` → `edge.providers.cloudflare`, …) | Fix what the validator names; the full retired list is [config.md](config.md#migration--legacy-configs--omegajson5) |
| Secrets | Secret values sat in the framework config files | Config hard-fails secret-shaped keys; secrets live in `.env`, resolved through the cascade shell > local > brand root > company | Move every secret out of config into `.env`, brand-root first so the targets inherit it |
| CLI bins | EVERY legacy framework shipped a `mgr` bin (plus `uj`/`bm`/`em`/`bxm`), so in a multi-target repo whichever npm hoisted won | One context-aware dispatcher: `omega` / `omg` / `mgr`, all identical — the nearest `package.json` walking up from cwd names the framework whose CLI runs | Replace legacy bin names in npm scripts and CI; run the verb from the target dir that owns it |
| CLI default | A bare `omega` / `mgr` at a brand root RAN the whole service walk (omega-manager's default command) | Every verb is named: `omega manage` is the walk (one name, no alias), `omega dev` the local stack, `omega deploy` the publish. A bare `omega` prints help and touches nothing ([#229](https://github.com/Omega-JS-Stack/omega/issues/229)) | Replace bare `omega`/`mgr` invocations with `omega manage` in scripts, cron, and CI. A brand still carrying `manage: 'omega'` must be walked ONCE by hand — `npx omega manage` — because its own `npm run manage` would print help; that walk heals the script to `omega manage` |
| Per-target setup | `omega setup`, run BY HAND in every target (`cd targets/<dir> && npx omega setup`), and the default command a bare `omega` ran | The command is gone. Its LOCAL half — node check, defaults scaffold, `package.json` scripts sync, peer-dependency check, locality check — is `ensureTarget()`, which every verb (`dev`/`build`/`test`/`deploy`) runs first, idempotently and offline. Its NETWORK half — secret publication, cert validation, repo provisioning, framework freshness — is a precheck inside `omega deploy`, opted out with `--no-secrets` on all three frameworks (desktop's `--quick` is gone). A bare `omega` prints help ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)) | Delete `npx omega setup` from npm scripts, CI workflows and runbooks — the verb beside it already does it. A scaffolded workflow's `npx omega setup && npm run build` becomes `npm run build`. Extension consumers on a pre-2.0.0 hook layout run `npx omega migrate --target=<extension> --execute` once at the brand root |
| Package script spelling | Backend, desktop and extension wrote `npx omega <verb>` into every framework-owned target script (web already spelled it bare) | Bare `omega <verb>` on all four frameworks ([#748](https://github.com/Omega-JS-Stack/omega/issues/748)) — npm puts `node_modules/.bin` on the path inside a script, so the prefix bought nothing there; `npx omega` stays canonical for docs and the terminal | Nothing by hand: the next verb's `ensureTarget()` rewrites every framework-owned key in place and a second run is a no-op — commit the one-line diff. A script key the framework never declares is yours and is never touched, and `npx omega <verb>` keeps working wherever you spell it yourself |
| Publish | Per-framework release scripts and `npu sync` | `omega deploy` on every target — deliberate, never triggered by a push; at a brand root it fans out (backend → web → extension/desktop) | Replace publish scripts with `omega deploy`; contract in [deploys.md](deploys.md) |
| Dependency updates | Framework self-update + peer-dependency auto-install at setup | The explicit `omega update` verb (installs the safe set, `--dry-run` only reports, majors opt-in). The peer-dependency install still rides every verb's `ensureTarget()` — a satisfied target installs nothing — and the framework self-update moved to the `omega deploy` precheck ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)) | Run it deliberately — [updates.md](updates.md) |
| Environment prefixes | `BACKEND_MANAGER_*`, `BEM_*`, framework-specific names | `OMEGA_*` — except a THIRD-PARTY credential, which keeps the vendor's own name (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`); `OMEGA_*` is for the keys OMEGA itself mints or owns | Rename in `.env`, CI secrets, and every reader. `@omega.js/config`'s env schema is the current list — the brand root's `.env` stub renders from it |
| Default/Custom file markers | The marker grammar in `_.gitignore` (no framework scaffolds a target `.env` any more, and a marker-bearing `AGENTS.md` converges to the one project-root shape on the next verb) | **UNCHANGED: this is not legacy.** The Default/Custom marker grammar is the live defaults-engine mechanism that merges framework-owned lines into consumer-owned files | Leave the markers alone in migrated files; every verb's `ensureTarget()` rewrites the Default block and preserves everything under Custom |

## One provider shape — `role.providers.<provider>` ([#425](https://github.com/Omega-JS-Stack/omega/issues/425))

Not a legacy→OMEGA row: this is an OMEGA-internal config rename, made
deliberately before the first npm publish closes the window. Config sections
carried four shapes for the same idea — a `providers` block, a singular pick
(`provider: 'sentry'`), a bare vendor key (`certificates.apple`) and a fourth
word (`payment.processors`) — so a consumer had to memorise which section used
which. Every role now names its vendors ONE way: `role.providers.<provider>`,
where key PRESENCE is the pick and `false` is the deliberate off switch. The
null = unset / false = disabled tri-state is unchanged; it just moved into the
key. `cloud` is the ratified exception (`cloud.provider` + `cloud.config` — its
discriminator is read by 34 runtime files across every framework's bootstrap
and already delivers no-rename-on-a-second-provider).

Every row below is enforced: the old path FAILS validation naming its
replacement, so nothing is silently lost. There is no dual-read.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Payment providers | `payment.processors.{stripe,paypal,chargebee,coinbase}` | `payment.providers.{stripe,paypal,chargebee,coinbase}` — contents identical | Rename the one key in `config/omega.json5`. The singular `processor` followed one issue later — the whole word is `provider` now, stored data included ([#428](#one-word--provider-everywhere-428) below) |
| Apple signing | `certificates.apple.{bundleIdPrefix,capabilities,profiles,certificates}` | `certificates.providers.apple.{…}` — contents identical | Nest the `apple` block one level under `providers`. Windows signing will sit beside it rather than adding a second bare vendor key. Nothing on disk moves: the signing tree stays `{companyRoot\|\|brandRoot}/.omega/certificates/apple/` |
| Domain registrar | `domain.provider: 'namecheap' \| 'squarespace' \| null` | `domain.providers.<registrar>` — e.g. `providers: { namecheap: {} }` | Replace the string with a keyed entry. **No entry = none chosen** and the domain service skips, exactly what `null` meant |
| Mailbox provider | `domain.email.provider: 'cloudflare' \| 'squarespace' \| 'privateemail' \| null` | `domain.email.providers.<provider>` | Same edit one level down. `domain.email.forwarding` stays role-level — it is provider-agnostic |
| Translation engine | `translation.provider: 'claude' \| 'chatgpt'` | `translation.providers.<name>` — `{ claude: {} }` or `{ chatgpt: {} }` | Replace the string with a keyed entry. An absent block still means `claude` (the no-API-key default), so a brand that never set `provider` needs no edit. `translation.model` stays role-level — it overrides whichever engine is chosen |
| Devlog writer | `devlog.provider: 'ghostii'` plus its settings flat on `devlog` (`lookbackDays`, `orgs`, `excludeRepos`, `excludeCommits`, `excludeTopics`, `includePrivate`, `postPath`, `destinations`, `overrides`) | `devlog.providers.ghostii.{lookbackDays,orgs,excludeRepos,excludeCommits,excludeTopics,includePrivate,postPath,destinations,overrides}` | Move the nine provider-hung keys inside `providers.ghostii` and drop the `provider` string (the key IS the writer). `devlog.enabled` stays role-level — it is the pipeline's switch, not the writer's |
| Error monitoring | `monitoring.provider: 'sentry'` plus its settings flat on `monitoring` (`org`, `dsn`, `environment`, `sampleRate`, `tracesSampleRate`, `scrubEmail`, `attachScreenshot`, `bundlePatterns`) | `monitoring.providers.sentry.{org,dsn,environment,sampleRate,tracesSampleRate,scrubEmail,attachScreenshot,bundlePatterns}` | Move the eight knobs inside `providers.sentry` and drop the `provider` string (the key IS the monitor). `monitoring.enabled` stays role-level. **Per-surface DSNs move too**: `targets.<name>.monitoring.dsn` → `targets.<name>.monitoring.providers.sentry.dsn`: the manager's `monitoring/dsn` operation writes the new path, so a rerun re-lands them. DSN presence is still the runtime enable signal; nothing on Sentry's side changes (same projects, same keys, same release tags) |
| Email marketing | `marketing.campaigns.provider: 'sendgrid'` + `marketing.campaigns.listId` | `marketing.campaigns.providers.sendgrid.listId` | Nest `listId` under `providers.sendgrid` and drop the `provider` string. `marketing.campaigns.enabled` stays role-level. The list itself is untouched — the id is the same SendGrid UUID, and the campaigns service writes the new path on its next run |
| Newsletter | `marketing.newsletter.provider: 'beehiiv'` + `marketing.newsletter.publicationId` | `marketing.newsletter.providers.beehiiv.publicationId` | Nest `publicationId` under `providers.beehiiv` and drop the `provider` string. **`marketing.newsletter.enabled` AND `marketing.newsletter.content` stay role-level** — `content` (sources, categories, tone, template, theme, sponsorships) configures @omega.js/backend's newsletter GENERATOR, not Beehiiv, so it does not move. Beehiiv holds no copy of the id: inbound webhooks are matched against config, so there is no data migration |
| AI blog | `blog.provider: 'ghostii'` | `blog.providers.ghostii` (key presence chooses the writer) | Replace the string with an (empty) `providers.ghostii` entry, or omit the block — an absent `providers` still defaults to ghostii. `blog.enabled` and `blog.content` stay role-level (content is pipeline config) |

Per-target overrides convert on the same terms: a `targets.<name>` block
carrying any of these keys is resolved at the top level, so it fails validation
with the same message and takes the same edit.

Two words the brand files carried but nothing read are simply gone with the
edit: `marketing.campaigns.platform` / `marketing.newsletter.platform` (a
legacy-BEM spelling of the same pick) BECOME the provider key. They are not in
the retired-path guard — they were already dead config, so nothing was lost
before or after — but leaving one behind now buys nothing.

## One word — `provider` everywhere ([#428](https://github.com/Omega-JS-Stack/omega/issues/428))

The other half of #425, and the same window: #425 normalized the config SHAPE
and deliberately left the singular runtime word `processor` standing, which
meant a brand read `payment.providers` in config and wrote `processor` on every
document it produced. Ian's ruling (2026-08-21): consistency wins — ONE word,
`provider`, in code, on the API, and in stored data. Everything below changed
together; there is no dual-read on any of it.

Third-party vocabulary is untouched: where a field name belongs to Stripe,
PayPal, Chargebee or Chargeblast, it is still read verbatim (Chargeblast's
alert payload still sends `processor`, and the route normalizes it onto our
`provider` on the way in).

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Payments API param | `processor` on all eight payments routes (`intent`, `cancel`, `plan`, `portal`, `refund`, `uncancel`, `webhook`, `winback`) — body field or `?processor=` query, per route | `provider` in the same position | Rename it in every caller. A first-party brand gets this from the framework's own frontend; a CUSTOM caller (a mobile client, a server integration, a saved webhook URL at Stripe/PayPal/Chargebee) must be repointed — the webhook and dispute-alert routes read it from the QUERY STRING, so the URL registered at the provider changes too. `npx omega manage` rewrites the webhook URLs it owns; anything registered by hand is a by-hand edit. An unrenamed param is an `Unknown provider: undefined` 400, never a silent default |
| Checkout dev param | `?_dev_cardProcessor=test\|stripe\|chargebee` | `?_dev_cardProvider=…` | Update saved QA links and any script driving a dev checkout. The old param is ignored (the palette control reads only the new name) |
| Email merge field | `user_subscription_payment_processor` (path `subscription.payment.processor`) | `user_subscription_payment_provider` (path `subscription.payment.provider`) | Rename the token in every custom email template. An unrenamed token resolves to nothing — the merge-field table no longer declares the old name |
| Analytics param | `payment_processor` on every commerce event (`purchase`, `refund`, plan changes, trial events) | `payment_provider` | Rename it in saved GA4 explorations, custom dimensions, and any dashboard filtered on the old key. Registered GA4 custom dimensions are per-name: register `payment_provider` alongside, and historical rows keep the old name |
| Stored Firestore field | `processor` on `payments-orders` / `payments-intents` / `payments-webhooks`, `alert.processor` on `payments-disputes`, and `subscription.payment.processor` on `users` | `provider` / `alert.provider` / `subscription.payment.provider` | **This one has DATA.** Deploy the new backend, then run the backfill against the brand's Firestore: `npx omega manage --migration=payment-provider` audits (prints per-collection would-change counts and writes nothing), and `--migration=payment-provider --execute` performs it. Idempotent and re-runnable: a doc already on the new field is skipped, a doc carrying both keeps `provider` and drops the leftover. Order matters only in that the sweep is safe either side of the deploy — a doc written by the new code needs no fix |
| Firestore composite index | `subscription.payment.processor` ASC + `subscription.cancellation.pending` ASC (the PayPal expiry cron's query) | Same index on `subscription.payment.provider` | The next verb's `ensureTarget()` rewrites `firestore.indexes.json`; deploy indexes before the backfill so the cron's query has one when the data lands. The old index is orphaned — delete it in the Firebase console once nothing queries the old field |
| Payment module directory | `libraries/payment/processors/<vendor>.js`, the per-route `<route>/processors/` folders, and `libraries/load-processor.js` (`loadProcessor()`) | `libraries/payment/providers/`, `<route>/providers/`, `libraries/load-provider.js` (`loadProvider()`) | Only a brand that requires a framework payment module by path (a custom route, a custom cron) is affected: repoint the require and rename the call |
| Admin payment sub-handler dir | `<brandRoot>/payment-processors/<productId>.js` — the per-product handler `POST /omega/admin/payment` loads | `<brandRoot>/payment-providers/<productId>.js` | Rename the directory. Nothing else about the handler contract changed; a brand with no such directory (almost all) has nothing to do |

## Two homes, not three — the `.omega/state.json` CACHE retired ([#434](https://github.com/Omega-JS-Stack/omega/issues/434))

omega-manager's three-bucket principle came across intact: user choices in
config, durable derived data in `.omega/state.json`, per-run transients in
`.omega/runs/`. The middle bucket did not earn its keep. Almost everything in
it was a CACHE of what each idempotent ensure re-reads from the platform on
every run anyway, and the handful of facts that were genuinely durable were
sitting in a gitignored per-machine file instead of the two homes the
frameworks actually read — so a fresh clone silently lost them, and a
brand's `omega.json5` could stay `null` for months next to a state file that
had the answer.

The rule now: **a provisioned fact lands in `config/omega.json5`, a secret
lands in the brand `.env`, and everything else re-derives.** The handler
return key `state` survives as the WITHIN-RUN carry (how the zone operation
hands its zone id to the operations after it) and is written to no file.

`.omega/runs/{ts}.json` is unchanged, and so is `.omega/state.json` — what
retired is its CONTENT, not the file. It lives on as the ONE per-machine
RECORD file, sectioned per fact kind
([#479](https://github.com/Omega-JS-Stack/omega/issues/479)): its `deploy`
section is the record `@omega.js/devkit/deploy-record` writes on every
successful deploy verb, and future record kinds join it as sibling top-level
sections. The state-retirement migration owns only the service-keyed sections
it retires and leaves every record section alone; deploy-record owns only
`deploy` and passes every other section through verbatim, so an unmigrated
brand's records are read in place beside its config-shaped leftovers. The one
record move that still happens is the interim `.omega/deploys.json` the
records spent 0.45.0 in
([#449](https://github.com/Omega-JS-Stack/omega/issues/449)): it needs no
migration step — deploy-record folds it into state.json on its first read or
write, says so in one line, and removes the old file.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The state file | `.omega/state.json`, per-service keyed, written after every service | The service-keyed sections are gone. The migration moves each fact to its home and deletes the file — or trims it to its machine records (`deploy`, and any future record section) when the brand has any | **This one has DATA.** `npx omega manage --migration=state-retirement` audits (prints every planned move and writes nothing); `--migration=state-retirement --execute` performs it. Idempotent: the executed run leaves nothing to move, so a re-run is a clean no-op. It is the ONE `local: true` migration — no backend target, no service account, no Firestore |
| GA4 Measurement Protocol secrets | `analytics.streams.{target}.apiSecret` in state; the disperse service read it from there | `GOOGLE_ANALYTICS_SECRET_{TARGET}` in the brand `.env`, written by the analytics service; the schema's `deliverAs` composes each target's own `GOOGLE_ANALYTICS_SECRET` from it on every verb | The migration moves them. A brand with no state file re-resolves them from GA on the next `npx omega manage` |
| VAPID key pair | `cloud.cloudMessaging.{vapidPublicKey,vapidPrivateKey}` in state | Public half → `cloud.messaging.vapidKey` in omega.json5 (it ships to every browser); private half → `VAPID_PRIVATE_KEY` in the brand `.env` | The migration splits them. Lose them and there is no API to re-read them: an interactive run re-prompts for the pair from the Firebase console |
| Cloudflare zone id | `edge.zoneId` in state (read by nothing across runs) | `edge.providers.cloudflare.zone` in omega.json5 — the id `omega purge` targets from a build, where no Cloudflare token is in play | The migration moves it, and the edge service now keeps it current: the resolved id always wins over a stale hand-set one |
| Reconcile confirmations | `search.gaLinked`, `payment.{radarConfirmed,disputesConfirmed}`, `cloud.authentication.oauthRedirectsConfigured`, `captcha.domainsConfirmed` in state | `search.providers.searchConsole.gaLinked`, `payment.providers.stripe.{radarConfirmed,disputesConfirmed}`, `cloud.oauthRedirectsConfigured`, `captcha.providers.recaptcha.domainsConfirmed` in omega.json5 | The migration moves them. These are the only reconcile flags config keeps — each is a human console action with no read API on either side, so nothing can re-check it. Every OTHER flag was dropped: the ensure re-reads the platform |
| Everything else | Repo identity, Search Console property URL, GA stream ids and URIs, Stripe account id, provider product ids, Apple certificates/profiles/bundle id, Sentry project map, the Firebase SDK config, billing/firestore/database/storage/hosting/functions status, SendGrid + Beehiiv names | Not persisted anywhere | Nothing to do — every one of them is re-read from its platform (or re-derived from config) by the idempotent ensure that owned it. The provider product ids and the SDK config already had their config home; state was a duplicate |
| `@omega.js/manager/state` subpath export | `require('@omega.js/manager/state')` → `readState` / `writeState` / `statePath` / `STATE_DIR` | Removed. `writeRunOutput` moved to `src/lib/run-output.js` and is still exported from the package root | Delete the import. Nothing in the monorepo or any brand used it |

## One vocabulary — a brand's surfaces live in `targets/` ([#443](https://github.com/Omega-JS-Stack/omega/issues/443))

Config has always called them `targets`; the folder they lived in said `apps/`,
and this monorepo's own `apps/` meant something else again — the in-repo test
BRANDS. Three meanings for two words. Ian's ruling (2026-08-21): one
vocabulary. A brand monorepo's surfaces live under `targets/`, and this
monorepo's brands live under `brands/`. Same behavior, new names — discovery,
scaffolding, the FILE_MAP semantics, disperse, the CI workflow templates and
every doc changed together, and nothing dual-reads `apps/`.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Brand folder | `<brandRoot>/apps/<target>` — `apps/website`, `apps/backend`, `apps/desktop`, `apps/extension`, `apps/website-admin` | `<brandRoot>/targets/<target>` — the dir names inside are unchanged | **Run the migration ONCE, per brand**: `npx omega manage --migration=targets-rename --execute` (bare, without `--execute`, prints the plan and moves nothing), then `npm install` at the brand root. Nothing heals this inside a normal run — every other verb FAILS LOUD on the old shape and points here. Idempotent — a migrated brand re-runs as a no-op. A brand carrying BOTH folders is a half-done migration and fails loudly instead of guessing: merge them into `targets/` by hand, delete `apps/`, run again |
| Root workspaces glob | `"workspaces": ["apps/*"]` | `"workspaces": ["targets/*"]` | The same migration flips the entry (every other entry is preserved), and heals it on its own for a folder you renamed by hand. Run `npm install` at the brand root afterwards so npm re-links `node_modules/<app>` at the new path |
| Paths in YOUR files | `apps/website/...` in the brand's own scripts, CI workflows, editor config, READMEs, `.env` comments | `targets/web/...` | By hand: the migration moves the folder, never your text. `npx omega manage` rewrites the workflow templates it owns; anything you authored is yours to grep |
| This monorepo's brand folder | `apps/sandbox-brand`, `apps/omega-playground`, `apps/newsflash-brand` | `brands/<same>` | Monorepo-internal — nothing for a consumer brand to do |
| CI base-path helper ([#455](https://github.com/Omega-JS-Stack/omega/issues/455)) | `require('@omega.js/web/deploy').appPathPrefix()` — called by name from the scaffolded `.github/workflows/build.yml` | `targetPathPrefix()` — same signature, same behavior | A brand whose workflow still calls the old name re-scaffolds it (`npx omega manage` rewrites the workflows it owns) at its migration session; no alias exists |
| Config merge-layer word ([#455](https://github.com/Omega-JS-Stack/omega/issues/455)) | The per-target-dir layer was the **app layer**: docs said `… ← app shared ← app targets.<name>`, `loadConfig()`/`composeTargetConfig()` returned `files.app`, and `resolveEnvChain()` returned `{ app, brand, company }` | The **local layer**: `… ← local shared ← local targets.<name>`, `files.local`, `{ local, brand, company }` | Nothing in an authored `omega.json5` changes (the layer is positional, no `app:` key ever existed). Code reading `files.app` or `chain.app` renames the key; no alias exists |

## One DNS flip — `emailurl.<domain>` rides the Cloudflare proxy ([#646](https://github.com/Omega-JS-Stack/omega/issues/646))

Links inside a transactional email opened with the browser's insecure-site
warning on every brand not yet on OMEGA. The cause, confirmed live on
2026-08-27: SendGrid rewrites every link through the branded link host
`emailurl.<domain>`, that host serves NO certificate of its own
(`https://emailurl.<legacy domain>` fails certificate validation, while plain
HTTP answers), and the account's link branding carries no SSL setting at all —
every one of its 36 entries is `valid: true`, `legacy: false`, with no `ssl`
field. So a click could only ever land on an `http://` hop first, and Chrome
said so. The edge service's DNS default now creates that one record
**proxied**, so Cloudflare terminates TLS at the edge with the zone's own
certificate and forwards to sendgrid.net.

**The flip is ORDERED, and the DNS ensure enforces the order itself.** SendGrid
validates a branded link by resolving `emailurl.<domain>` as a CNAME to
sendgrid.net, and a proxied record answers with Cloudflare's addresses instead
— so proxying first locks a NEW domain's branding out of ever validating. Every
run the edge service reads `GET /v3/whitelabel/links` and only writes
`proxied: true` when SendGrid reports that host `valid: true`; until then the
record stays grey-clouded and the run warns, naming the record. Nothing to
sequence by hand: since
[#693](https://github.com/Omega-JS-Stack/omega/issues/693) the campaigns
service CREATES the branding when the account has none, writes both of its
CNAMEs, waits for the validation later in the same walk, and flips that record
to proxied itself —
the edge service's next read agrees, because a valid branding desires a proxied
record.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| `emailurl.<domain>` CNAME → `sendgrid.net` | Grey-clouded (`proxied: false`), so the click resolved straight to SendGrid over HTTP | Orange-clouded (`proxied: true`) once SendGrid reports the link branding valid — the only SendGrid record that is; `emailauth`, the `<sendgrid id>` owner CNAME and both DKIM keys stay grey, because SendGrid validates those by CNAME lookup | **Per legacy brand, once**: run `npx omega manage` for a brand the edge service owns — an already-validated branding (every live ITW brand) flips on that run; a branding still pending stays grey with a warning, and the rerun after SendGrid validates flips it. By hand elsewhere: validate the branded link in SendGrid FIRST, then turn the proxy ON for `emailurl.<domain>` in Cloudflare |

## Unsubscribe-group ids leave the code — config carries them ([#649](https://github.com/Omega-JS-Stack/omega/issues/649))

Every transactional send attaches a SendGrid unsubscribe (ASM) group, and BEM
hardcoded the seven ids in `constants.js`. Those ids belong to the SendGrid
ACCOUNT they were created in — ITW's — so a brand on any other account either
sent under a group that does not exist there or under a stranger's. Ids are
account data, never code: the campaigns service now provisions the seven groups
by NAME and writes each id into the brand's own `config/omega.json5`, and the
backend keeps only the KEYS (`GROUP_KEYS` in `constants.js`).

Matching by name is what makes sibling brands sharing one SendGrid account
converge: the second brand's run finds the groups the first one created and
lands the SAME ids.

**A missing id fails the send LOUDLY** (coded 400, naming the config path). It
is a programmer error — the manage walk never ran for this brand — and a
fallback would be the exact bug this removes.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| ASM group ids | `GROUPS` in `packages/backend/src/manager/libraries/email/constants.js` — seven literal ids compiled into the framework | `marketing.campaigns.providers.sendgrid.groups.<key>` in the brand's `config/omega.json5`, one integer per key (`orders`, `hello`, `account`, `marketing`, `security`, `newsletter`, `internal`) | **Per brand, once**: run `npx omega manage` (or `--service=campaigns`) — the campaigns service creates any group the account is missing and writes all seven ids into `config/omega.json5`. By hand: read the ids from SendGrid → Suppressions → Unsubscribe Groups and write the block yourself. The ensure matches by NAME, so on an account whose groups carry legacy-prefixed names ("BEM - Order Updates"), RENAME them to the canonical "OMEGA - " names FIRST (ids never change, so legacy sends keep working) — otherwise the ensure creates a duplicate set and unsubscribe state splits (this happened once on the shared account, repaired 2026-08-29). A brand on its own fresh account just gets its own groups. Until the block exists, every send throws instead of mailing under a foreign group |
| `prepare.resolveSender()` signature | `resolveSender({ sender, from, group }, brand, brandDomain)` | `resolveSender({ sender, from, group }, brand, brandDomain, omega)`: the fourth argument carries the config the ids live in | Only affects code calling `prepare.js` directly: pass `omega` as the fourth argument. `group:` still accepts a raw numeric id AND now accepts a group KEY, which resolves through config |

## `brand.subdomains` becomes web targets ([#588](https://github.com/Omega-JS-Stack/omega/issues/588))

A legacy brand running sibling sites off one domain declared them as a
`brand.subdomains` list (soundgrail: `[app, music, exhale]`). Nothing in OMEGA
DECLARED that key (no schema rule, no default, never materialized) and one
thing read it: the cloud hosting op, which ensured an `api.{sub}.{domain}`
Firebase Hosting domain per entry. Ian's 2026-09-01 call: each subdomain shares
the ONE backend, and the fact the list was reaching for is a web TARGET.

So a target is the home. The target's NAME IS the subdomain, so a bare
`admin: { type: 'web' }` resolves to `https://admin.<brand host>`; an entry's own
`url` overrides it for a custom host, and every target shares one
`api.<domain>`. `subdomains` is a retired KEY now (a name test, so it fires at
every depth): a config still carrying the list fails validation with the recipe
instead of silently steering the hosting op.

The brand-level facts stay brand-level. `cloud.config.authDomain` is compared
against `brand.url` for every target (one Firebase project, one backend, one
authDomain), and so is the persona domain the test lanes seed. What IS per
target is the public surface: `site.url`, the gh-pages CNAME, and the deploy
path prefix, so `targets/admin` publishes to admin.acme.test instead of
over the main site.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| Sibling sites of one brand | `brand: { subdomains: ["admin", "cdn"] }`, unvalidated, read only by the cloud hosting op | `targets: { web: { type: 'web' }, admin: { type: 'web' }, cdn: { type: 'web' } }` ([config.md](config.md#targets-every-key-is-a-name-886)); each target lives in `targets/<name>` | **Per brand, once, by hand**: delete the `brand.subdomains` list and write the sibling keys (the names are the subdomains verbatim; add `url:` only where the host is NOT `<name>.<brand host>`). Create each `targets/<name>` dir; `npx omega manage` names the missing ones. No converter: the validator refuses the old key and names the replacement |
| Firebase Hosting API domains | `api.{domain}` **plus** `api.{sub}.{domain}` per subdomain entry | `api.{domain}` alone: one backend, one api host, however many targets | **Nothing to write**: the next `npx omega manage` reconciles the default site with the single domain. Any `api.{sub}.{domain}` a previous run created stays in Firebase and Cloudflare until removed BY HAND, because nothing deletes a live domain, so drop the custom domain in the Firebase console and its Cloudflare CNAME once no client calls it |

## Plan limits become the features catalog ([#647](https://github.com/Omega-JS-Stack/omega/issues/647))

A metered feature used to be spelled TWICE on every product — a number in
`limits` and a display row in the `features` array — and its display copy was
unified across products by a BACKFILL rule (a definition on any one product's
copy explained every other). Its PACING was a third thing again: a product-wide
`rateLimit` that no single feature could opt out of.

So a feature is defined ONCE now, in a top-level `features` catalog (name, icon,
definition, and the `usage` block that meters it), and each product names only
its VALUE. A limit and the row that renders it can no longer disagree, because
there is only one place each fact is written. The backfill retires with the
duplication it existed to paper over: nothing repeats, so nothing needs
unifying.

The counting side changes with it. `Usage.init()` / `validate()` / `increment()`
/ `set()` / `update()` / `setUser()` / `addMirror()` / `setMirrors()` are gone,
replaced by ONE call — `await ctx.usage.consume('<feature>')` — which checks
both counters, refuses with a 429 naming which one hit, else counts and writes
([docs/backend/usage-rate-limiting.md](../backend/usage-rate-limiting.md)).
The hCaptcha over-limit fallback `validate()` carried goes with it: it had no
caller (`marketing/contact`, its only user, passed
`useCaptchaResponse: false`), and a captcha is a bot check, not a quota.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| A metered feature's limit | `payment.products[].limits: { requests: 100 }` | `payment.products[].features: { requests: 100 }`, against a `features.requests` catalog entry carrying a `usage` block | **Per brand, once, by hand**: move each `limits` key into the product's `features` map (same number, same meaning — a MONTHLY limit, `-1` unlimited), and give every id a `features.<id>` catalog entry with at least a `name`. The validator refuses the old key and names the replacement |
| A feature's display copy | `payment.products[].features: [{ id, name, icon, definition, value }]`, repeated per product, definitions unified by a cross-product backfill | `features.<id>: { name, icon, definition }` once, and `payment.products[].features: { <id>: value }` | **Per brand, once, by hand**: lift the name/icon/definition of each entry into the catalog (authored once, in the order you want the rows rendered), and leave only `<id>: value` on each product. `value: true` stays `true`; a feature a tier does NOT include becomes `false` or is simply omitted. The array shape is a validation error naming the map |
| Pacing | `payment.products[].rateLimit: 'daily' \| 'monthly'`, one shape for every metric on the product | `features.<id>.usage.pace: 'daily' \| false`, per feature | **Per brand, once, by hand**: delete `rateLimit`. Day pacing is now the DEFAULT on every counted feature, so a product that carried `rateLimit: 'daily'` needs nothing; one that carried `'monthly'` sets `usage: { pace: false }` on each of its features' catalog entries |
| Mirrored counters | `usage.addMirror('agents/x')` / `setMirrors([...])` at the call site, per request, writing the WHOLE usage object | `features.<id>.usage.mirror: ['agents']` in config, resolved from `user.owns.agents`, writing only the touched feature's counters | **Per brand, once, by hand**: delete the call-site mirror calls, name the document KINDS on the catalog entry, and make sure the code that creates an owned document records its id on the owner's `owns.<kind>` array (a framework field — server-written only) |
| Proxy billing | `await usage.setUser(ownerUid)` swapped the counter's target user mid-request | Removed. A route that must bill another account resolves that account itself and counts against the mirror the catalog declares | **Per brand, by hand**: rework any proxy-billing route around `consume` + a catalog mirror. There is no replacement for silently re-pointing a counter at another user |
| The counting call | `await usage.validate(m); usage.increment(m); await usage.update();` | `await ctx.usage.consume(m)` | **Per brand, by hand**: replace the three-call dance (and the hand-rolled `getUsage() >= LIMIT` gates that grew around it) with one `consume`. It THROWS the 429 — catch it only to reshape the message |
| Anonymous counting | `Usage().init(ctx, { key: ip })` — an explicit key silently switched a signed-in user's storage too | `ctx.usage.forKey(ip)` — a SEPARATE counter | **Per brand, by hand**: replace each keyed `init` with `forKey`. A signed-in caller's own counters can no longer be redirected by passing a key |
| Per-user extra credits | Not expressible — a limit was the plan's number, full stop | `user.usage.overrides.<feature>`, a number that wins over the plan's | **Nothing to migrate**: new capability. Admin-written only (`usage` is a rules-protected framework field), and the reset cron never touches it |
| A page's own `features:` block | A page or layout could name a top-level `features:` frontmatter block of its own content (a marketing "Features" band) and read it as `resolved.features` | `features` is a CONFIG SECTION now, so a page key may not shadow it — rename the block (the framework's own `/download`, `/extension` and the neobrutalism index call theirs `highlights`) | **Per brand, by hand**: rename any top-level `features:` frontmatter block and its `resolved.features.*` reads. A section restated bare in `config:` is a build error naming the key, and a `site.features` read is one too, so an unmigrated page fails loudly rather than rendering an empty band |

## The user-connection feature is `connections` ([#788](https://github.com/Omega-JS-Stack/omega/issues/788))

The lane a brand's users link third-party accounts through was named `oauth2`
in the API, the user record, the config section, the env prefix, the brand
provider folder and the callback URL, while the UI called it "Connections".
Ian's 2026-09-03 ruling: the product concept is a CONNECTION, and a connection
will not always be an OAuth grant — an API key or a bot token is one too — so
the whole feature carries the product word, and each stored record names its
own kind with a `type` field (`'oauth2'` today, the only kind that exists).
OAuth's own version is not the reason; OAuth 2.1 still calls itself OAuth 2.

Nothing dual-reads the old names. The user DOCUMENTS move in one step of the
brand migration — `npx omega manage --migration=users --execute`, whose `users`
migration writes `connections.<provider>` with its `type` and deletes `oauth2`
in the same write ([manager/migrations.md](../manager/migrations.md)) — and the
config key is a retired-key error naming its replacement. Everything else in
the table is by hand, once per brand. One transient at the deploy itself: a
connect attempt whose provider login was already open fails its callback once
(the state cipher and the session key changed with the name) and succeeds on
retry; its stale `usage/{uid}.oauth2` session clears with the daily clean.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| User record | `users/{uid}.oauth2.{provider}` | `users/{uid}.connections.{provider}`, each record carrying `type: 'oauth2'` | **The migration moves them**: `npx omega manage --migration=users` audits, `--execute` writes. Idempotent — a document already moved is a no-op, and a document carrying both keeps `connections` and drops the leftover |
| Route | `GET \| POST \| DELETE /omega/user/oauth2` | `/omega/user/connections`; the actions (`authorize`, `status`, `tokenize`, `refresh`) and the delete keep their names, but `authorize` and `tokenize` no longer accept an admin `uid` — a passed one answers 400 naming the argument, since both need the connecting user's own browser. `status`, `refresh` and the delete still take one as an admin (each acts at the provider on that user's behalf), and a trusted read of a stored token is `GET /omega/admin/firestore?path=users/<uid>` with the admin key ([#782](https://github.com/Omega-JS-Stack/omega/issues/782)) | Repoint any caller of your own that names the path. The framework's own callers (the account page, the callback page) move with the framework. A server-side caller that passed a `uid` to `authorize` or `tokenize` moves that call to the user's OWN browser session — no admin key can stand in for it — and reads the resulting token through the admin firestore route |
| Config section | `oauth2: { <provider>: {…} }` | `connections: { <provider>: {…} }` — the per-provider block is byte-identical, with ONE change of meaning ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)): a PACKAGED provider (google, discord, spotify, twitch, kick) is `enabled: false` in the framework defaults, so an entry that relied on "absent means enabled" is now off | Rename the key in `config/omega.json5`, and add `enabled: true` to each packaged provider's block that does not already carry it — a brand's OWN provider is unchanged (present unless `enabled: false`). A config still carrying `oauth2` is a retired-key error naming the move ([config.md](config.md#retired-keys-fail-loudly)) |
| Credentials | `OAUTH2_<PROVIDER>_CLIENT_ID` / `OAUTH2_<PROVIDER>_CLIENT_SECRET` | `CONNECTIONS_<PROVIDER>_CLIENT_ID` / `CONNECTIONS_<PROVIDER>_CLIENT_SECRET` | **Rename the pair by hand** in the brand `.env` (and every `.env.<environment>` overlay), and in the CI secrets any workflow injects them from. A layer still carrying the Google pair FAILS the load naming the new name ([#845](https://github.com/Omega-JS-Stack/omega/issues/845)): they are registered retired env names ([config.md](config.md#retired-env-keys-srcenv-retiredjs)), spelled out one provider at a time. For any other provider there is no check, and the env schema does not know the old name, so the provider reads an empty client id and its authorize leg 500s |
| Provider console redirect URI | `<websiteUrl>/oauth2` | `<websiteUrl>/connections/callback` | **Register the new URI at every provider** whose block the brand declares (Google Cloud console, Discord developer portal, Spotify dashboard, …). Add it BESIDE the old one, deploy, then remove the old one — a redirect URI is matched exactly, so a deploy ahead of the console edit breaks every link attempt |
| Brand provider module | `targets/backend/src/oauth2/<name>.js` | `targets/backend/src/connections/<name>.js` | Move the directory. The lane resolves `${omega.cwd}/connections/` first and the package's own second, exactly as before |
| Website callback page | the `/oauth2` default page (`blueprint/auth/oauth2`) | `/connections/callback` (`blueprint/connections/callback`) | **Nothing for a brand that never overrode it.** A brand carrying its own copy moves it to the new path and layout name; `/connections` itself stays free for a future listing page |
| Provider module shape ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)) | `verifyIdentity(tokenizeResult, Manager, ctx, uid)`, `buildAuthorizeUrl(context)`, `revokeToken(token, {…})`, `verifyConnection(refreshToken, {…})`, `authParams`, `urls.tokenize` + `urls.refresh` + `urls.status`, and a copy of the "already connected" query inside `verifyIdentity` | ONE context object for every step, called as a method on the module: `identity(context)` (required, → `{ id, … }`), `authorize`, `exchange`, `refresh`, `revoke`, `status`; `params` for extra authorize params; ONE `urls.token`; `urls.revoke` optional; `urls.status` deleted | **Per provider module, by hand** (switchboard's YouTube provider is the known one outside this repo): rename the six members, fold `urls.tokenize`/`urls.refresh` into `urls.token`, rename `authParams` → `params`, drop `urls.status`, read `tokenizeResult`/`Manager`/`ctx`/`uid`/`clientId` off the one `context` argument, and DELETE the uniqueness query — the route owns it now and matches on `identity.id`, so the step just answers the identity, with a string `id`. A module missing `identity()` or `urls.token` throws at load naming the file |

## One target picker — `--target=` on every brand-root verb ([#780](https://github.com/Omega-JS-Stack/omega/issues/780))

The brand-root fan-outs picked targets with `--only=<a,b>` / `--except=<a,b>`
while `omega test` picked with `--target=<a,b>`. One picker now, one spelling on
all six verbs (`deploy`, `build`, `clean`, `dev`, `update`, `test`): the tokens
are unchanged (a target key like `web`, or a target dir name like `website`), and
a token matching nothing stops the run: never a run-everything fallback, and
never the matched subset either.

Beyond parity, `--only` was also firebase's own flag on the backend target:
`firebase deploy --only hosting` picks a SERVICE, so one flag name meant two
things on one verb. That pass-through is untouched and stays a target-level
flag, run from `targets/backend`.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The brand-root target picker | `omega deploy --only=web,backend`, and the same flag on `build`, `clean`, `dev`, `update` | `omega deploy --target=web,backend` on every one of them | **Per brand, by hand**: respell `--only=` as `--target=` in npm scripts, CI workflows and shell aliases. Passing `--only` now fails loudly naming `--target=`, so nothing runs the wrong set silently |
| Subtracting from the set | `--except=<a,b>` (the default set minus these) | No subtractive form: name the exact set with `--target=` | **Per brand, by hand**: replace `omega dev --except=backend` with `omega dev --target=web`. A GUI/watcher target (desktop, extension) still has to be named to boot |

## The brand SOURCE repo derives as `<brand.id>-omega` ([#809](https://github.com/Omega-JS-Stack/omega/issues/809))

Brand repo names grew inconsistent (`clockii-omega`, `omega-playground`,
`studymonkey-website`), so Ian ruled one rule on 2026-09-07: every repo a brand owns is
`<brand.id>-<role>`. The releases repo already derived that way (`<brand.id>-releases`);
the SOURCE repo's default was the bare `brand.id` and is now `<brand.id>-omega`. Nothing
else moved: the typed `repo.providers.github.repo` slug still wins, and the owner half is
unchanged.

The blast radius is every reader of `brandRepo()`: web's `omega deploy --direct` (its
Pages project address included), the manager's github service (org, repo and Pages
reconciliation), the backend's `resolved.github` CMS commits, and the release dispatch.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The brand source repo's default name | `brand.id` verbatim (`acme` → `Acme-Org/acme`) | `<brand.id>-omega` (`acme` → `Acme-Org/acme-omega`) | **Per brand, by hand, and only if the brand relied on the default**: either declare the existing name once with `repo.providers.github.repo: "<name>"` (a bare name, or an `owner/name` slug when the repo sits under another org), or rename the GitHub repo to `<brand.id>-omega` and let the default derive it. A brand that already types the slug is untouched |

## Public identifiers leave `.env` for config ([#893](https://github.com/Omega-JS-Stack/omega/issues/893))

Six values were declared in both homes at once. Ian, 2026-09-12: "it seems our custom is
to put IDs in config. should we do that? seems like env is standard to be secrets only."
The rule that settles it is in [config.md](config.md) ("Config or env?"): config holds what
is PUBLIC by design (visible in a store URL, shipped to browsers, printed in a binary),
`.env` holds secrets, the login coordinates that only travel with a secret, and machine
paths. Nothing about the SECRET halves changed: `RECAPTCHA_SECRET_KEY`,
`PAYPAL_CLIENT_SECRET`, `CHARGEBEE_API_KEY` and every store API credential stay in `.env`.

There is no dual-read, so a `.env` layer that still declares one of the six FAILS the load
naming the move (`@omega.js/config`'s `env-retired.js`, checked in the ONE place a `.env`
layer is parsed; since the strict-schema change the line is unread instead, and `omega migrate`
names the move). The three listing ids also left the extension's CI secrets block: a
public id rides the config snapshot a deploy pushes, like every other config value.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The Chrome Web Store item id | `CHROME_EXTENSION_ID` in `.env` (+ a repo secret) | `targets.<name>.listings.chrome.id` | Move the value into config beside that listing's `url`, delete the `.env` line, and delete the repo secret |
| The AMO add-on id | `FIREFOX_EXTENSION_ID` in `.env` (+ a repo secret) | `targets.<name>.listings.firefox.id`, which IS the manifest's `browser_specific_settings.gecko.id` | Move the value into config, delete the `.env` line and the repo secret. A manifest declaring a different gecko id now fails the package: delete that key, or make the two match. A brand that never published gets the derived id pinned into its config by the extension's local scaffold, on the first verb run in the target |
| The Edge Partner Center product id | `EDGE_PRODUCT_ID` in `.env` (+ a repo secret) | `targets.<name>.listings.edge.id` | Move the value into config, delete the `.env` line and the repo secret |
| The reCAPTCHA site key | `RECAPTCHA_SITE_KEY` in `.env` (+ a web repo secret) | `captcha.providers.recaptcha.siteKey` (already declared) | Delete the `.env` line; most brands already carry the value in config. The manage walk's captcha service asks for it there now |
| The PayPal client id | `PAYPAL_CLIENT_ID` in `.env`, bridged into `process.env` at backend boot | `payment.providers.paypal.clientId` (already declared), read directly by the provider library | Delete the `.env` line; the config key is where it was already |
| The Chargebee site name | `CHARGEBEE_SITE` in `.env`, bridged into `process.env` at backend boot | `payment.providers.chargebee.site` (already declared), read directly by the provider library | Delete the `.env` line; the config key is where it was already |

## The four schema-less web sections retire ([#850](https://github.com/Omega-JS-Stack/omega/issues/850))

`favicon`, `manifest`, `icons` and `currency` were legacy UJM presentation blocks the
config converter wrote under `targets.web`, with no schema rule anywhere: @omega.js/web
kept a private list so its own `config:` guard would pass them. Ian, 2026-09-09:
everything the build processes needs a schema definition, favicons stay auto-generated
with no consumer config, and any new web-only shape lives under `targets.web`, never at
the root. So the list is gone, `CONFIG_SECTIONS` is exactly the schema's list, and each of
the four is a registered retired path ([config.md](config.md#retired-keys-fail-loudly)):
a brand still carrying one fails validation naming what answers it now. `omega migrate`
drops the three and moves the currency, with a note each.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The favicon folder | `targets.web.favicon.path` pointed the head's icon links at a folder of your own | The shipped set only: the target's own `src/assets/images/favicon/`, else the set the build derives from the brand's `assets/logo/brandmark.svg`, at `/assets/images/favicon` (plus a root `favicon.ico`) | Delete the key. Change the brand's brandmark, or put your own set in the target's favicon folder; there is no path to override |
| The browser chrome color | `targets.web.favicon.theme-color` fed the `theme-color` meta | **`brand.color`**, the one place a brand states its hex (the accent ramps derive from it too, [theming.md](theming.md)) | Delete the key. Set `brand.color` if it is not set already; a brand with no color emits no `theme-color` meta at all |
| The web app manifest block | `targets.web.manifest` | Nothing: no reader exists, and the manifest that ships is the favicon set's own `site.webmanifest` | Delete the key. Every value under it was already being ignored |
| The footer link icons | `targets.web.icons`, a name-to-markup map the footer looked each `link.icon` up in | The `icon` on the link itself, as Font Awesome classes: `icon: 'fa-brands fa-github'` ([#619](https://github.com/Omega-JS-Stack/omega/issues/619), [icons.md](icons.md)) | Delete the key and spell each link's icon as its own `fa-*` classes in your `src/_includes/frontend/sections/footer.json`. The legacy block only ever held a `style`, which the lookup could never resolve, so those icons were rendering empty already |
| The price currency | `targets.web.currency` (or a root `currency`), read by the pricing JSON-LD | **`payment.currency`**, beside the providers that charge in it | Move the value. `omega migrate` does it for you; by hand it is one key |

## One platform vocabulary, and one shipping declaration ([#867](https://github.com/Omega-JS-Stack/omega/issues/867))

OMEGA said `mac` in a login record, `macos` in an icon dir, `win` in a config key and
`chromium` in a build dir, all for the same three or four things. Ian, 2026-09-10: ONE
vocabulary, the client's (`getPlatform()` / `getBrowser()`), everywhere OMEGA speaks for
itself: platforms `mac`, `windows`, `linux`, `chrome`, `firefox`, `edge`; formats `dmg`,
`nsis`, `deb`, `appimage`, `snap`, `zip`, `store`. Node's `darwin`/`win32`,
electron-builder's `mac`/`win`/`AppImage` and GitHub's runner labels are foreign
vocabularies, each translated at one point; `APPLE_*` and `SNAPCRAFT_*` env names stay,
because they name vendors.

With it, what a target SHIPS became one declaration in one shape on both targets:
`targets.<name>.platforms.<platform>.formats.<format>`, presence = enabled, every platform
and format on by default, `false` to drop one, per-format settings inside the format.

**The config half is a migration, not hand-editing**:
`npx omega manage --migration=platform-names --execute` at the brand root rewrites every
omega.json5 the brand owns and renames its icon dirs. Run it BEFORE `omega migrate --execute`, which
deletes a retired key rather than moving it.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The Windows platform block | `targets.desktop.platforms.win` | `targets.desktop.platforms.windows` (installer knobs and `signing` unchanged inside it) | Run the migration; it moves the block with every setting |
| What the desktop ships | implicit (deb + AppImage always, snap behind `platforms.linux.snap.enabled`) | `platforms.<platform>.formats.<format>` | Run the migration: `linux.snap.*` moves into `linux.formats.snap.*` and its `enabled` flag becomes presence (`enabled: false` becomes `formats.snap: false`) |
| What the extension ships | implicit (every browser built, a store published when its API credentials happened to be set) | `platforms.<chrome|firefox|edge>.formats.<zip|store>` | Nothing to move: declare the block only to DROP something (`edge: false`) |
| The mac icon dir | `config/icons/macos/` | `config/icons/mac/` | Run the migration; it renames the dir at the brand root and in every target |
| The chromium build dir | `packaged/chromium/raw/` + `packaged/chromium/extension.zip` | `packaged/chrome/raw/` + `packaged/chrome/extension.zip` | Nothing to move (the dir is generated): re-point a "Load unpacked" bookmark and any local script |
| The opera extension build | `packaged/opera/` (a third build, published nowhere: the Opera Add-ons have no API) | gone | Nothing. Opera installs the chrome build like every other Chromium browser |
| The site's download links | `/download/mac/universal`, `/download/windows/universal`, `/download/linux/debian` | `/download/mac/dmg`, `/download/windows/nsis`, `/download/linux/deb` | Nothing: the three old segments keep their pages as redirects to the same file. `/download/linux/snap` now goes to the brand's Snap Store listing |
| The desktop asset names | `<Product>-mac-universal.dmg`, `<Product>-windows-universal.exe`, `<Product>-linux-debian.deb` | `<Product>-mac-dmg.dmg`, `<Product>-windows-nsis.exe`, `<Product>-linux-deb.deb` | Nothing in the brand. The next release publishes the new names, and the site links them from the same table; a link typed by hand somewhere outside OMEGA needs retyping |
| The `platforms` workflow input | accepted `darwin`, `win`, `ubuntu` as spellings | `mac`, `windows`, `linux` (or `all`) | Retype any saved dispatch that used an alias. `mac,darwin` used to turn the Windows leg on, because `darwin` contains `win` |
| Each env key's mint page | the manager's REQUIRES registry, per service | the env schema's `label` / `url` / `hint` | Nothing in a brand: the walk asks from the schema now, which is why the signing and store credentials can be asked for at all |

## One dispatch trigger on every workflow ([#923](https://github.com/Omega-JS-Stack/omega/issues/923))

All four templates accepted a second trigger, `repository_dispatch: [omega-deploy]`,
and the HTTP surface advertised it as a way in. It never worked the way it read:
an event TYPE is not a ref, so such a run checks out the DEFAULT branch, which
since [#915](https://github.com/Omega-JS-Stack/omega/issues/915) never carries
the deploy tree. Nothing in OMEGA ever sent one, so the trigger is gone rather
than pinned.

| Contract | Old form | New form | Manual migration step |
|---|---|---|---|
| The workflow dispatch channel | `POST /repos/<o>/<r>/dispatches` with `{"event_type":"omega-deploy"}` | `POST /repos/<o>/<r>/actions/workflows/<file>/dispatches` with `{"ref":"omega-deploy"}` | Retype any caller outside OMEGA that sent the event type. A brand's own verbs already dispatched this way, so nothing in the brand changes; its next omega verb rewrites the composed workflow |

## Deliberate compatibility that REMAINS

Old forms the new system still speaks ON PURPOSE, because a party outside this
ecosystem still sends them. They are NOT accommodations to clean up: each one
retires when its named condition is met, and never unilaterally.

| Compatibility | Who still speaks it | Retirement condition |
|---|---|---|
| `backendManagerKey` sent in outbound request bodies (`process.env.OMEGA_ADMIN_KEY` under the OLD field name) | Legacy-BEM parent deployments, the Ghostii API, and ITW's `wrapper` Cloud Function — all still reading that field | Each upstream migrates to the new stack and accepts the `omega-admin-key` header; fix per upstream, never unilaterally |
| The Ghostii flat-article response fallback | api.ghostii.ai, whose production backend runs legacy BEM and can return the flat field shape | Ghostii returns only the structured shape |
| The `gatherings/online` sign-out leg | Old somiibo / electron-manager desktop clients that still write that RTDB path | Those app versions are out of circulation |
| `legacyProductIds` / `legacyPlanIds` matching in the PayPal and Chargebee providers | Currently-billing subscribers on plan/product IDs created before the current catalog | The last subscription on a legacy ID ends or is migrated |
| The legacy desktop deep-link param translation in web core auth (`?destination=&source=app&signout=&cb=` → `returnUrl` / `authSignout`, chained through `/token`) | Shipped legacy desktop apps whose auth links are baked into installed binaries | Those app versions are out of circulation |
| Fixed legacy download filenames in the desktop mirror-downloads task (`Somiibo.dmg`, `Somiibo-Setup.exe`, `somiibo_amd64.deb`) | Every published download link and site pointing at the stable, version-less filename | No published link depends on the stable filename |
