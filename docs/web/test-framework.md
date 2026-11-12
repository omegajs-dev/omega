# Test Framework

`npx omega test` in an @omega.js/web app is **a production build, then ONE run of devkit's case runner**: the five smoke cases over the build, then your own suites, in one Results block. Every web suite is a `defineCases` file asserting with `ctx.expect`, the shape backend, desktop and extension write. The runner is devkit's (`createRunner`, [devkit/index.md](../devkit/index.md#the-case-runner)), as framework `web`, on its one layer, `build`. The verb is [src/commands/test.js](../../packages/web/src/commands/test.js).

## 🚫 NEVER mock: test against a real build

Web's test surface is a real Eleventy build over real fixture content. **Do not hand-roll fake engines, fake config objects, or a stubbed `site` global**: build a fixture site and assert on the emitted HTML/CSS/JS, the way the framework's own suite does (`test/lib/build.js` is the shared build harness; fixtures live in `test/fixtures/`).

**Pure functions are the ONLY exception.** A function with zero I/O (a merge helper, a path resolver, a frontmatter validator) can be `require`d and called directly with plain inputs. That is not mocking; there is nothing to mock. The moment the code under test touches the engine, the asset pipeline, or the filesystem, it runs for real.

The ONLY narrow stub allowed is a side effect that would destroy the test run itself (a process-exit, a destructive clean, a CLI command re-entering the runner): stub that one seam, restore it immediately, comment why.

## Test coverage: every surface gets a test (HARD RULE)

A feature is not done when it works. It is done when every surface it exposes is proven at the LOWEST layer that can prove it ([docs/shared/testing.md](../shared/testing.md), the ratified mantra):

| Coverage | Where | Proves |
|---|---|---|
| **Unit** | a `defineCases` suite calling the module directly | The function does the right thing with known inputs |
| **Integration** | a `defineCases` suite that runs a REAL build over a fixture site | The pieces wire together: the page renders, the asset lands, the manifest names it |
| **End-to-end** | the monorepo's corpus / cross-stack lanes | The contract survives across framework boundaries (brand to backend, real browser) |

**Skipping a layer is the exception, not the default.** A layer may be skipped ONLY when the feature genuinely has no surface there: a pure build-time utility has no rendered output; a CSS-token change has no logic to call. Convenience is never a reason. "The unit test already covers it" does NOT excuse the build test: unit tests prove the logic, build tests prove the wiring (a section can come unhooked while every unit test stays green). When in doubt, write the test.

## Running tests

```bash
npx omega test                 # PROJECT scope: production build, then the smoke cases and your test/ suites
npx omega test project:        # same, spelled explicitly (`brand:` is an alias)
npx omega test framework:      # ONLY @omega.js/web's own suite, no build (`omega:` / `mgr:` / `web:` are equivalent)
npx omega test full:           # both sources
npx omega test build/notes     # build, then only the project suites whose path contains build/notes
```

**A bare run is PROJECT-only.** The framework corpus is always an explicit choice: a bare `npx omega test` from a brand never drags it in (Ian 2026-07-11, the C5 grammar).

### What a run does, in order

1. **It names `testing`** for the whole run: `OMEGA_ENVIRONMENT=testing`, so every suite, the project `_init.js` and every child process read `isTesting()` as true ([docs/shared/config.md](../shared/config.md)).
2. **It tees the run to `logs/test.log`** at the target root, truncated per run and ANSI-stripped: the build's lines and the runner's whole report, Results block included. Grep it rather than re-running ([docs/shared/logging.md](../shared/logging.md)).
3. **`ensureTarget`** heals the target's framework-owned files, as every verb does.
4. **A path target that matches no file stops here**, before the build (see [Scope grammar](#scope-grammar)).
5. **The production build**, when the scope holds the project: the same code path as `npx omega build` (assets, Eleventy, PurgeCSS, `dist/`, plus translation when configured). The build names production for itself and puts back the environment it found when it ends, success or throw, so the suites still read `testing`.
6. **One runner run**: `test/_init.js`'s `setup()` once (below), then every selected suite file, then ONE Results block (passing, failing, skipped, the total). The smoke suite comes first, then the target's `test/` suites. No `test/` directory means the run holds the smoke cases alone.

The verb exits 1 on a failed case or a run error, and 0 otherwise.

### The smoke cases

The smoke suite ships beside the verb ([src/test/smoke/smoke.test.js](../../packages/web/src/test/smoke/smoke.test.js)) and runs as a project suite with the target root as its cwd. It reads only what the build wrote there: `dist/` and `.omega/asset-manifest.json`. It is one `defineCases` group described `smoke`, five cases in this order:

| Case | What must hold |
|---|---|
| `the build wrote pages` | the build produced at least one HTML page in `dist/` |
| `404.html renders through the theme root layout` | `dist/404.html` exists (the guaranteed default page; consumers own their home page) **and** carries `data-theme-id` |
| `the manifest's js.main bundle exists` | the asset manifest names a `js.main` bundle and the file is on disk in `dist/` |
| `every internal link resolves` | the [internal link check](#the-internal-link-check) ([#430](https://github.com/Omega-JS-Stack/omega/issues/430)) |
| `the built output audits clean` | the [four audit checks](#the-built-output-audit-checks): page meta, anchor fragments, image `alt`, sitemap orphans ([#468](https://github.com/Omega-JS-Stack/omega/issues/468)), stale exceptions included |

A failing case's message lists every offender. Being a group, a failed case stops no other case, and your suites still run: one run names every break.

### The internal link check

Every `href`/`src` in `dist/**/*.html` must land on something the same build wrote ([src/link-resolver.js](../../packages/web/src/link-resolver.js)). Nothing else in a build reads a link and asks whether the far end exists, so a nav pointing at pages that stopped being generated used to ship green.

Resolution is omega's flat, extensionless URL contract: `/foo` is served by `dist/foo.html` or `dist/foo/index.html`, an asset path is the file itself, a relative value resolves against its emitting page's directory, and a trailing slash is the same page. A mounted project site (a build stamped with a path prefix) is read at its own base path, and a dead link is reported by its SITE url, the form the exception file is written in ([#755](https://github.com/Omega-JS-Stack/omega/issues/755)). A directory is **not** a page: `/blog` needs `blog.html` or `blog/index.html`, never just `dist/blog/`. Anything with a scheme (`https:`, `mailto:`, `tel:`, `data:`, a brand's own app protocol), a protocol-relative host, or a bare `#fragment` leaves the site and is skipped. Code DISPLAY is skipped too ([#521](https://github.com/Omega-JS-Stack/omega/issues/521)): a `<pre>` block prints escaped source, so an `href=` inside it is characters on the page (a docs snippet, or the section gallery's copyable args block), never a link the page emits.

**Exceptions are a last resort, declared per SOURCE PAGE** in `config/link-exceptions.json5` at the target root. No file at all is the state a brand should be in:

```json5
{
  // #488: the tag cloud links a slug the taxonomy page is not emitted at.
  'blog/tags.html': ['/blog/tags/a-and-r'],
}
```

- The key is the dist-relative page emitting the link; the values are the site-absolute URLs it may leave unresolved. **Any other page linking at the same URL still fails**, so a brand page never rides on a declared gap.
- **A declared exception that has started resolving is itself a failure.** An exception standing over a fixed link is a mask over the next regression at that URL, so the list has to shrink when the break is fixed.
- The file is json5 ([#490](https://github.com/Omega-JS-Stack/omega/issues/490)) because an exception has to carry the reason it exists **beside it**, in a comment. A rationale kept in a worksheet somewhere never travels with the list.
- A malformed file is a hard error, never a silently empty map, and a file left at the retired `config/link-exceptions.json` name fails loudly with the rename instead of quietly excusing nothing.

### The built-output audit checks

Four more static scans of the same `dist/`, siblings of the link check in every way: same walk, same exception file, same "a declaration that has started passing is itself a failure" rule ([src/dist-audit.js](../../packages/web/src/dist-audit.js)). They are cheap and programmatic on purpose: the heavy audits (Lighthouse, HTML validation, spelling, page speed) cost minutes per run and stay out of this tier.

| Check | What must hold | Read off the build |
|---|---|---|
| `meta` | every page ships a non-empty `<title>` **and** `<meta name="description">` | `core/head.html` emits both tags on every page, so a `meta.title` that resolved to nothing ships empty and reads as present to any scan that counts tags. This one reads the value |
| `fragments` | every in-site `href="/page#id"` and `href="#id"` lands on an element the target page has | a fragment on a page the build never wrote is skipped: that is a dead LINK, and one break must not read as two |
| `alt` | every `<img>` carries an `alt` attribute | an EMPTY `alt` is the decorative declaration and passes, including the valueless `alt` the minifier collapses it to |
| `sitemap` | every indexable built page is listed in the emitted `sitemap.xml` | there is exactly ONE opt-out, and the check reads it off dist: a `noindex` page (#564 made noindex and sitemap membership one decision, and the engine stamps the flag on drafts, the `/test` dev surface, `/admin/` and redirect stubs too). A page that must stay out of the sitemap while telling crawlers to index it has no such state any more: make it noindex, or declare `sitemap: true` for it in the exception file. No `sitemap.xml` at all turns the check off |

Pages the build **copies** rather than renders are not audited: Firebase's self-hosted OAuth helpers under `/__/` are vendor markup no brand authored or may edit. A mounted project site is read at its own base path, off the `data-omega-path-prefix` stamp its pages carry.

**Exceptions live in the same `config/link-exceptions.json5`**, one list per check, on the page that OWNS the finding:

```json5
{
  // #430: an array is, and stays, the link check's list for that source page.
  'blog/tags.html': ['/blog/tags/a-and-r'],

  'legal/eula.html': {
    meta: ['description'],   // the tokens: 'title', 'description'
    alt: ['/assets/images/seal.png'],   // by src
    sitemap: true,           // `true` = the whole check on this page
  },

  // A fragment hangs off the page carrying the ANCHOR, not the pages linking
  // it: a hash that page routes in JS is right everywhere it is linked, and
  // 190 nav pages must not each declare the same thing.
  'careers.html': { fragments: ['#openings'] },
}
```

- The checks are `links`, `meta`, `fragments`, `alt`, `sitemap`. A name outside that set is a hard error: a typo that read as "no exception" would turn a declaration off silently.
- A list excuses those findings; `true` excuses the whole check on that page, and is stale the moment the page has nothing left to excuse.
- The hashes @omega.js/web's OWN pages route in JavaScript (the account page's `#billing` to `billing-section`, the contact page's `#chat`) cost a brand nothing: the framework declares them, in every language a translated copy is written to.

`@omega.js/web`'s own default pages resolve with **zero exceptions** ([#427](https://github.com/Omega-JS-Stack/omega/issues/427), guarded by the framework suite's `default-page-links` test through the same resolver), so anything the check reports in a brand is the brand's.

### What framework scope runs

Every `*.test.js` under the resolved `@omega.js/web` package's `test/`, the top level and `test/watch/` alike, each with the package root as its cwd: the monorepo checkout while the brand is locally linked ([docs/shared/local-dev.md](../shared/local-dev.md)). `test/fixtures/` and `test/lib/` are support, not suites. A `framework:` run at a target runs no build and no smoke case.

**Web's own `npm test` is the self-test**: `node dist/cli-run.js test`, the form desktop and extension use. Inside the web package a bare run means the framework suite, with no `ensureTarget`, no build and no smoke root.

### How the files run

- **Each file runs in its own process** (`isolation: 'process'`), so one file's module state, env or `require.cache` never reaches another.
- **Up to `os.availableParallelism() - 1` files run at once** (at least 1): the case runner's own `concurrency` default under process isolation, `poolSize()`; web sets no `concurrency` of its own.
- **The files under `test/watch/` run one at a time, after every other file has ended** (`serial: ['watch']`): the rebuild-polling suites never share the machine with another file ([docs/shared/testing.md](../shared/testing.md)).
- **Each root sets its files' cwd**: the web package for framework suites, the target root for the smoke suite and yours. The runner honors a root's `cwd` on Node 23 and up. Below it, a run that selects a file from a root whose `cwd` is not the runner's own fails before any file runs, so only a `framework:` (or `full:`) run from a target needs Node 23: a bare target run and the web package's own self-test run on Node 22 as before.
- **Output is released per file, in discovery order**: framework suites, then the smoke suite, then yours. The pretty output, the json report's `tests` and the log read as a one-at-a-time run reads; only the durations differ.
- **The default case timeout is 120s.** A case's own `timeout`, else its suite's, wins.
  - A suite's `setup` and `cleanup` and each `ctx.after` function run under the same limit, so a step that never settles reports `setup timed out after <N>ms` (or `cleanup`, or `after hook`) and the run goes on; a suite `cleanup` past its limit fails the run.
- **A file's process lives at most ten minutes** (the runner's `fileTimeout` default; web sets none of its own).
  - Past it the runner ends the file's process and every process under it (an esbuild service, a server it started), and the file fails once as `file deadline`, naming the case in flight or saying every case had reported.
  - The other files' results stand, and the lane ends with its report.

### Flags

The runner flags ride to the run as they do on backend ([backend/test-framework.md](../backend/test-framework.md#the-runner)):

- `--filter=<text>` keeps a case whose name contains the text, or every case of a suite whose description contains it.
- `--layer=build` names web's one layer; an unknown name fails, listing the rows.
- `--lane=<name>` opens an opt-in lane. Web declares none, so any name fails naming that.
- `--extended` sets `TEST_EXTENDED_MODE` for the run.
- `--reporter=pretty|json`. Under `json`, stdout is one JSON document (the run's counts and one entry per case); the verb's own lines and the build's go to stderr.

Every other flag is forwarded to the build step, so `--cached-only` (skip cold-cache translation pages instead of translating them live) changes a test run too.

### Scope grammar

One grammar across every framework (parser: [`@omega.js/devkit/test/scope`](../../packages/devkit/src/test/scope.js)):

| Target | Runs |
|---|---|
| *(bare)* | project scope only: the smoke suite and your `test/` |
| `project:` / `brand:` | project scope only, explicit |
| `framework:` / `omega:` / `mgr:` / `web:` | @omega.js/web's own suite |
| `full:` | both sources |
| `<path>` (bare, no prefix) | project scope, filtered to that path |
| `framework:<path>` / `full:<path>` | the same filter, applied within that source |

- **A path filter is a contains match** on each suite's path relative to its root: `build/notes` selects `test/build/notes.test.js`, and `notes` selects every suite whose path holds it. Type a longer path to narrow. A path filter narrows the smoke suite like any other: `npx omega test build/notes` builds, then runs only that suite, no smoke case, and `npx omega test smoke` runs the smoke cases alone.
- A target that names a path and matches NO file is a hard error, resolved ahead of the production build: the run prints `No test file matches "<target>"` and exits 1 ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)), so a typo'd path, or a suite renamed out from under a target, can never run silently green. A run that named no file (bare, or a bare source prefix) still exits 0 when there is nothing to run. Inside a brand-root fan-out the manager sets `OMEGA_TEST_FANOUT=1` on every forwarded run, and the same miss answers with exit 3 instead: a path another target carries is a no-op here, and the brand run fails only when EVERY target missed ([docs/shared/testing.md](../shared/testing.md#brand-root-cp94b)).
- Unknown prefixes (`framwork:x`) warn (`Unknown test scope prefix ignored`) and are dropped; if every target was invalid, the run falls back to project scope.
- Multiple targets union their sources; each path binds to its own source.
- At a **brand root** (not a target dir) `omega` hands over to `@omega.js/manager`, which fans the same targets out over every target; `web:` routes to the web target only. Table: [docs/shared/testing.md](../shared/testing.md#brand-root-cp94b).

## Writing consumer tests

Every verb scaffolds the target's `test/` ([#818](https://github.com/Omega-JS-Stack/omega/issues/818)), as backend, desktop and extension do: `test/README.md` names the layers, and `test/_init.js` is the lifecycle hook, copied once and yours from then on. The README is marker-merged: every verb rewrites its Default section from the framework's source (`scaffold/test/README.md`), and your notes, a list of your suites say, live under the Custom marker ([shared/agent-docs.md](../shared/agent-docs.md)).

| Directory | Runtime | Use for |
|---|---|---|
| `test/build/` | Plain Node, the `build` layer | Config resolution and the built site in `dist/`: a page renders, carries the right content, links where it should |
| `test/pages/` | Plain Node, the `build` layer | Page modules (`src/assets/js/pages/`): one that imports framework code loads through `loadModule` from `@omega.js/web/test`, with the browser objects it touches passed in |
| `<brandRoot>/test/e2e/` | A real browser against the real local stack | End-to-end: the brand's own browser lane, `defineCases` suite files run by `npx omega test` at the brand root after every target ([docs/manager/brand.md](../manager/brand.md)) |

The directory is a convention, not a layer switch: every suite runs on the one `build` layer. OMEGA Playground's website carries one suite of each (`brands/playground-omega/targets/web/test/`) plus the brand lane at `brands/playground-omega/test/e2e/auth-return.test.js`.

Every suite is a `defineCases` file, one file per concern, taking `{ defineCases, expect }` from web's public test API, `@omega.js/web/test` (the framework's own suites require `@omega.js/devkit/test/define-cases` instead):

```js
// test/build/sitemap.test.js
const { defineCases } = require('@omega.js/web/test');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');

module.exports = defineCases({
  type: 'group',
  description: 'sitemap',
  tests: [
    {
      name: 'the build emits a sitemap',
      run: (ctx) => {
        ctx.expect(fs.existsSync(path.join(DIST, 'sitemap.xml')), 'dist/sitemap.xml is missing').toBeTruthy();
      },
    },
  ],
});
```

- `npx omega test` runs the production build **before** your suites, so `dist/` is fresh: assert against it directly. Run `npx omega build` first when calling `node --test` on one file; a `defineCases` file loaded that way runs its own cases.
- **Assert with `ctx.expect`**, devkit's one assertion library: `toBe`, `toEqual` (strict), `toBeTruthy`, `toMatch`, `toContain`, `toHaveProperty`, `toThrow`, `.not`, `.rejects`, `expect.fail` and the rest ([devkit/index.md](../devkit/index.md#the-case-runner)). A helper outside a case asserts with the file-level `expect`: `const { defineCases, expect } = require('@omega.js/web/test')`. `node:test` and `node:assert` have no place in a web suite.
- **`require(name)`** answers a module from `@omega.js/web`'s own module context, the twin of backend's `omega.require(name)`: `require('@omega.js/web/test').require('esbuild')` is web's copy, whether or not the brand installs one. A name web does not carry throws Node's own `MODULE_NOT_FOUND`.
- **`loadModule(modulePath, { omega, document, window })`** bundles one module (a page module under `src/assets/js/`, a path absolute or relative to the cwd) the way the asset build does, with `__main_assets__/`, `@omega.js/client` and web's own dependencies resolved as in a build, then evaluates it in-process and resolves to its exports (`default` carries the default export). `import omega from '@omega.js/web/runtime'` answers the `omega` you pass, and `document` and `window` are your objects while the module evaluates and are put back after, so every key is optional and every load is fresh.
- A `type: 'group'` runs every case whatever fails; a `type: 'suite'` shares `state` and skips every later case after a failure. `setup(ctx)` and `cleanup` run once per suite, and `ctx.after(fn)` runs once its case settles.
- **Name files `*.test.js`**: the suffix is the discovery signal across every OMEGA package ([docs/shared/testing.md](../shared/testing.md)). A `_`-prefixed file or directory is never a suite, and neither is a file without the suffix, so helpers and fixtures under `test/` are safe (`test/_helper.js`, `test/fixtures/data.js`).
- There are no ctx extras and no boot harness on web: a browser proof goes in the brand's e2e lane.

**A brand's test never names a framework dependency; it asks web for it.** A library web carries reaches a page through the framework-deps hook in every bundle web builds, and reaches a suite through `require(name)` on the test door, so the brand declares no copy of its own and never leans on npm happening to hoist web's. A page module that imports framework code loads through `loadModule`, never through an esbuild call and alias list of the brand's own: the aliases live once, in web.

## `test/_init.js`: pre-test lifecycle hook

The runner loads an optional `test/_init.js` and runs it **once, after the build and before the first case**, the smoke cases included (it is not itself a suite: without the `.test.js` suffix it is never discovered). It goes through devkit's one loader (`@omega.js/devkit/test/init-hooks`), the one backend, desktop and extension read, so the shape is one shape: the module **must export a function**, `module.exports = (ctx) => ({ ... })`, called with `{ projectRoot }`, returning an object whose `async setup({ projectRoot })` seeds any fixture a suite needs. There is no `cleanup` hook and no `accounts` field: tests clean up after themselves. A hook that fails to load, exports a non-function, whose factory throws or returns a non-object, or whose `setup` throws, fails the run: one failing entry names the file and carries the cause, no case runs, and `omega test` exits 1.

```javascript
// test/_init.js
const fs = require('fs');
const path = require('path');

module.exports = ({ projectRoot }) => ({
  async setup() {
    fs.mkdirSync(path.join(projectRoot, '.temp'), { recursive: true });
  },
});
```

## See also

- [docs/shared/testing.md](../shared/testing.md): the layered mantra, the verification tiers, the full C5 grammar, brand-root fan-out
- [docs/devkit/index.md](../devkit/index.md#the-case-runner): the case runner, `defineCases` and `expect`
- [docs/web/index.md](index.md): the web framework guide
- [src/commands/test.js](../../packages/web/src/commands/test.js): the command itself
