# Test Framework

Built-in test framework for both @omega.js/extension itself and consumer projects. Jest-like assertion syntax (`expect(actual).toBe(expected)`), four layers, and devkit's one runner underneath ([devkit/index.md](../devkit/index.md#the-case-runner)): the same discovery, scope grammar, reporter and Results block every OMEGA framework prints.

## Running tests

```bash
npx omega test                          # consumer: runs YOUR project suites (bare runs never include the framework corpus)
npx omega test --layer=build            # only build-layer suites (plain Node, fast)
npx omega test --layer=background       # only background-layer suites (real MV3 SW)
npx omega test --layer=view             # only view-layer suites, on the harness pages
npx omega test --layer=boot             # only boot-layer suites (real consumer extension, its built views included)
npx omega test --filter=messaging     # only suites/tests whose name contains "messaging"
npx omega test --extended               # run extended suites against REAL external services (Firebase, etc.) — normal mode skips them in-source, never mocks them
TEST_EXTENDED_MODE=true npx omega test  # same as --extended (the shared, unprefixed env var across all OMEGA frameworks)
npx omega test --reporter=json         # one JSON document on stdout: { passed, failed, skipped, noMatch, durationMs, tests }
```

In @omega.js/extension itself, `npm test` does the same.

A run ends on ONE Results block (`N passing`, `N failing` and `N skipped` when not 0, `Total: N tests in Nms`) and exits 1 when a case failed. With no `--layer` every row runs, in order: build, background, view, boot. Under `--reporter=json` stdout carries the document alone and every other line goes to stderr. A console line the worker or a page prints that is not a case event reaches stdout as it comes, tagged with where it came from (`[sw:log]`, `[page:error]`).

All test output is also teed (ANSI-stripped) to `<projectRoot>/logs/test.log`, truncated fresh on each run — same pattern as EM's `test.log` and @omega.js/backend's `test.log`. Grep it after a run instead of scrolling terminal output.

### Selecting which tests run

`npx omega test` takes two independent selectors that compose:

1. **The positional target** selects which test **files** run, by source + path.
2. **`--filter=<substring>`** matches test **names/descriptions** within the already-selected files.

#### Positional target — select files by source + path

```bash
# Project suites only (the consumer default — the framework corpus needs an explicit prefix)
npx omega test

# ONLY project tests (all of them)
npx omega test project:

# Only project tests matching a path
npx omega test project:custom-test

# ONLY framework tests (mgr: is the universal cross-framework alias)
npx omega test mgr:

# ONLY framework tests (extension-specific aliases — equivalent to mgr:)
npx omega test extension:
npx omega test framework:

# Framework tests matching a path
npx omega test mgr:build/config
npx omega test extension:build/config

# Bare path (no prefix) — PROJECT tests matched by path
npx omega test build/config

# Both sources — always an explicit choice
npx omega test full:
npx omega test full:build/config
```

The source prefix is standardized across all four OMEGA frameworks:

| Target | Selects |
|---|---|
| *(none)* | Project suites only (framework self-test context flips this to the framework suite) |
| `project:` | ONLY project tests (all of them) |
| `project:<path>` | Only project tests matching `<path>` |
| `mgr:` | ONLY framework tests (`mgr:` is the universal alias for "the manager's own tests") |
| `extension:` / `framework:` | ONLY framework tests (extension-specific aliases, equivalent to `mgr:`) |
| `mgr:<path>` / `extension:<path>` | Framework tests matching `<path>` |
| `<path>` (bare) | PROJECT tests matched by `<path>` |
| `full:` / `full:<path>` | BOTH sources — the only way a consumer run includes the framework suite |

A source-prefixed target excludes the other source entirely; the path part (if any) matches by relative path prefix (relative to each source's `test/` root).

A target that names a path and matches NO file is a hard error: the run prints `No test file matches "<target>"` and exits 1, so a typo'd path, or a suite renamed out from under a target, can never run silently green ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)). A run that named no file (bare, or a bare source prefix) still exits 0 when there is nothing to run. Inside a brand-root fan-out the manager sets `OMEGA_TEST_FANOUT=1` on every forwarded run, and the same miss answers with exit 3 instead: a path another target carries is a no-op here, and the brand run fails only when EVERY target missed ([docs/shared/testing.md](../shared/testing.md#brand-root-cp94b)).

#### `--filter` — match test names/descriptions

`--filter` is **orthogonal** to the positional target: it matches a substring against test **names/descriptions** within the files the target already selected. They compose.

```bash
# All suites, but only tests whose name contains "messaging"
npx omega test --filter=messaging

# Project files only, then only tests named "*storage*" within them
npx omega test project: --filter=storage

# Combine the target with extended mode
TEST_EXTENDED_MODE=true npx omega test build/config
```

## Layers

| Layer | Runs in | Use for |
|---|---|---|
| `build` | Plain Node, fast (~ms) | `build.getConfig/getManifest/getPackage`, CLI alias resolution, schema/manifest validation, build helpers, `lib/*.js` regex maps + utilities |
| `background` | Real MV3 service worker via Puppeteer + CDP | Background boot sequence, Firebase auth wiring, messaging listeners, `chrome.runtime.onMessage` handlers |
| `view` | Chromium tab: the harness extension's popup.html / options.html / sidepanel.html | DOM bindings, the `omega` surface, @omega.js/client integration, popup ↔ background messaging |
| `boot` | Real headless Chromium with the **consumer's** `packaged/<browser>/raw/` loaded as unpacked; a suite that declares `view: '<name>'` runs inside that built view | End-to-end smoke: does the consumer's actual extension boot? Manifest validates? SW comes up? Popup renders? Your own views |

With no `--layer`, every row runs in that order.

Each background suite attaches the harness's LIVE service worker afresh, releasing a restarted worker's start pause and probing `chrome.runtime.id` first, so a worker that is gone fails that suite as `service worker for <id> is not active` instead of an undefined `chrome.runtime` read. A worker that dies mid-suite fails that suite's unreported cases with the same message the moment Chrome reports it crashed, instead of waiting out the case timeout.

## NEVER mock — test against the real harness

Every layer hands your test the **real** runtime, never a hand-rolled fake:

- **No mock `omega`, no fake `chrome`/`browser` objects, no stubbed background/popup contexts.** `background`-layer tests run inside a real MV3 service worker with the real `chrome.*` API; `view`-layer tests run inside a real Chromium tab with the real DOM and real `chrome.runtime` messaging; `boot`-layer tests load the consumer's real packaged extension. Use what the harness gives you (`ctx`, the boot layer's `ctx.extension` and `ctx.page`, and the browser globals `chrome` / `document` / `window`): do not reconstruct any of it.
- **Pure functions (zero I/O) are the only thing you call directly.** A regex map in `lib/*.js`, a string formatter, a config-shape validator — `require` it and assert on its output in a `build`-layer test. That is not mocking; it is calling a pure function. Anything that touches real I/O (storage, messaging, the SW lifecycle, the DOM, the network) runs against the real harness, not a substitute.

### Real external APIs are GATED, NOT mocked

Tests that hit a real external service (Firebase, push, any network call) live in **extended suites** and are gated behind extended mode (`npx omega test --extended` or `TEST_EXTENDED_MODE=true`):

- **Normal mode** (`npx omega test`) **SKIPS** these calls **in-source** — guard them with `ctx.skip(reason)` (or an early return) so the test no-ops when extended mode is off. The external API is **skipped in-source, NOT mocked.** Never stand up a fake Firebase / fake fetch to make a normal-mode run go green.
- **Extended mode** (`npx omega test --extended`) runs the same code against the **real** service.
- **Anything an extended test creates externally MUST be cleaned up by the test** — delete the doc/user/record it created (use the suite/group `cleanup: async (ctx) => { ... }` hook, which runs after the last test). Leave no residue in the real backend.

### Extended mode (`TEST_EXTENDED_MODE`)

Extended mode is the opt-in for tests that hit REAL external services (Firebase via @omega.js/client, push, any network call from the background SW / popup / content scripts) instead of skipping them.

- **Skipped by default.** `npx omega test` runs fast and offline-safe — external calls no-op in-source.
- **Opt in** with `npx omega test --extended` (CLI shorthand) or `TEST_EXTENDED_MODE=true npx omega test` (env var). `TEST_EXTENDED_MODE=1` is also accepted.
- **Shared, unprefixed name across all OMEGA frameworks.** All four OMEGA frameworks read the SAME `TEST_EXTENDED_MODE` env var (the canonical name is @omega.js/backend's) — no `BXM_`-prefixed variant.
- **Propagates to every spawned test environment.** The runner sets `process.env.TEST_EXTENDED_MODE = 'true'` for the run, which every in-process suite reads and Puppeteer's Chromium (background / view / boot layers) inherits, since `puppeteer.launch()` inherits `process.env`.
- **The warning prints.** When on, the run opens with the shared extended-mode banner and the extension's two lines naming its blast radius (teed to `logs/test.log`).
- **Tests gate on `process.env.TEST_EXTENDED_MODE`.** Guard external-service tests with `if (process.env.TEST_EXTENDED_MODE !== 'true') ctx.skip('extended mode off');` (or an early return) so they no-op in normal mode.

### The ONLY two exceptions where a narrow stub is allowed

Mock **nothing** by default. There are exactly two cases where the real dependency genuinely cannot run in the test environment — and even then, stub the *smallest possible seam* (one method / one module), restore it immediately, and comment *why*:

1. **A side effect that would destroy the test run itself.** If invoking the real thing would kill or corrupt the harness — a process-exit, a destructive clean/wipe, or a *recursive re-invocation of a CLI command* (running the real `test`/`clean`/`setup` command from inside a test re-enters the runner) — you may stub *that one module/call* to a no-op, assert the dispatch logic, then restore. (Example: `cli.test.js` stubs the real command modules so testing CLI dispatch doesn't actually run them.)
2. **A real dependency the test environment can't provide.** When the real object only exists from infra you can't stand up in a `build`-layer unit test, a unit test may hand a minimal stub to verify a narrow side effect — but a real-harness layer (`background`/`view`/`boot`) MUST still cover the wired path where one exists.

If you can run it for real, you must. These exceptions are not a license to unit-test in isolation when a real-harness layer would work.

## Test coverage — every surface gets a test (HARD RULE)

A feature is not done when it works — it's done when every surface it exposes is covered in the layer that owns that surface:

| Coverage | Layer | Proves |
|---|---|---|
| **Logic** | `build` / `background` | The feature's functions do the right thing when called directly (the real build module, real `chrome.*`, real storage/messaging) |
| **UI** | `view` | The feature's interface is WIRED — a real event on the real DOM triggers the behavior and the visible result appears |
| **End-to-end** | `boot` | The feature survives in the consumer's actual packaged extension (add a `run(ctx)` case to the boot suite) |

**Skipping a layer is the exception, not the default.** A layer may be skipped ONLY when the feature genuinely has no surface there — a pure build-time utility has no UI; a CSS-only tweak has no logic to call. Convenience is never a reason: "the logic test already covers it" does NOT excuse the UI test — logic tests prove the logic, UI tests prove the wiring (a button can come unhooked while every logic test stays green), boot tests prove the packaging. When in doubt, write the test.

## `testing`: the environment a test run names

`npx omega test` names the environment `testing` before any suite loads, through the one environment input ([shared/config.md](../shared/config.md)), so `isTesting()` answers true in the build module, in every build-layer suite and in every bundle a build case makes; a context in Chrome answers what its build baked. See [environment-detection.md](environment-detection.md).

Another runner names it itself:

```json
"test": "OMEGA_ENVIRONMENT=testing vitest"
```

## Test discovery

- **Framework defaults**: `<@omega.js/extension>/dist/test/suites/**/*.test.js`
- **Consumer suites**: `<cwd>/test/**/*.test.js`

**The underscore convention** (devkit's discovery, `@omega.js/devkit/test/discovery`): `_`-prefixed FILES (`test/_init.js`, `test/page/_helper.js`) and everything under a `_`-prefixed DIRECTORY at **any depth** (`test/_fixtures/**`, `test/boot/_private/**`) are excluded from suite discovery. Put shared helpers, fixture data, and non-test support files in `_`-prefixed paths, e.g. `test/_fixtures/`, `test/_helpers/`. The runner still specifically loads `test/_init.js` as the lifecycle hook. Every OMEGA framework shares the convention. Files load alphabetically.

**Framework's boot suites are scoped to @omega.js/extension self-test runs only.** When a consumer runs `npx omega test`, the framework's `dist/test/suites/boot/**` is excluded from discovery (those tests assert on @omega.js/extension's internal fixture extension). Consumers write their own boot tests under `<cwd>/test/boot/`. See [test-boot-layer.md](test-boot-layer.md).

## `test/_init.js` — pre-test lifecycle hook

The runner loads an optional `_init.js` from **both** test roots, the framework's (`<@omega.js/extension>/dist/test/suites/_init.js`) and the consumer project's (`<cwd>/test/_init.js`), and runs it **once, before any suite** (it is NOT itself run as a test; the `_`-prefix keeps it out of discovery). Mirrors the same hook in @omega.js/backend/EM/UJM so all four frameworks share one shape.

The module **must export a function** — `module.exports = (ctx) => ({ ... })` — called with `{ projectRoot }` and returning the hook object. It may declare:

- `async setup({ projectRoot })` — runs once before the suites, e.g. to scaffold a fixture file the boot layer needs.

There is **no `cleanup` hook** and **no `accounts` field** (unlike @omega.js/backend — these frameworks have no auth/user system): tests clean up after themselves, so there is nothing project-level to tear down.

A hook that fails to load, exports a non-function, whose factory throws or returns a non-object, or whose `setup` throws, fails the run before any suite: the loader (`@omega.js/devkit/test/init-hooks`) throws an `InitHookError` naming the file and carrying the cause; the runner records it as a failing entry, runs no case, and `omega test` exits 1.

```javascript
// <cwd>/test/_init.js
const fs = require('fs');
const path = require('path');

module.exports = ({ projectRoot }) => ({
  async setup() {
    // Seed any fixture a suite needs before it runs.
    fs.mkdirSync(path.join(projectRoot, '.temp'), { recursive: true });
  },
});
```

## Test file shapes

Three forms; pick whichever fits. Every one exports through `defineCases`, from the public test API: `const { defineCases } = require('@omega.js/extension/test');`. It hands the spec to the OMEGA runner unchanged. Run on its own with `node --test`, a `build`-layer file runs its own cases, and a file on any other layer registers one failing case naming `npx omega test` ([testing.md](../shared/testing.md#mirrored-suite-shape)). The framework's own suites take the same function from `@omega.js/devkit/test/define-cases`, which prepare vendors into `dist/`.

### Suite (sequential, share state, stop on first failure)

```js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  type: 'suite',
  layer: 'background',
  description: 'storage round-trip',
  cleanup: async (ctx) => { /* runs after the last test */ },
  tests: [
    {
      name: 'set returns without throwing',
      run: async (ctx) => {
        await chrome.storage.local.set({ k: 'v' });
        ctx.expect(true).toBe(true);
      },
    },
    {
      name: 'get returns the just-set value',
      run: async (ctx) => {
        const out = await chrome.storage.local.get('k');
        ctx.expect(out.k).toBe('v');
      },
    },
  ],
});
```

Tests share `ctx.state` across the suite. If one fails, remaining tests are skipped (`stopOnFailure: false` to disable).

- A suite's `setup` and `cleanup` and each `ctx.after` function run under the limit a case has (the suite's `timeout`, else 30s): a `setup` past it fails every case, and an `after` past it fails its case.
- A suite `cleanup` past it fails a `build` run, but only warns on stderr in the in-app `background`, `view` and `boot` suites ([testing.md](../shared/testing.md#mirrored-suite-shape)).

### Group (sequential, share state, run all regardless of failures)

```js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'config defaults',
  tests: [ /* same shape as suite */ ],
});
```

### Standalone (single test per file)

```js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  layer: 'build',
  description: 'manifest_version is 3',
  run: (ctx) => {
    const m = require('@omega.js/extension/build').getManifest();
    ctx.expect(m.manifest_version).toBe(3);
  },
});
```

### Array form (treated as a group)

```js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases([
  { name: 'test 1', run: (ctx) => { /* ... */ } },
  { name: 'test 2', run: (ctx) => { /* ... */ } },
]);
```

## The `ctx` object

Every `run`, `setup` and `cleanup` callback receives `ctx`, on every layer:

- `ctx.expect`: the assertion library (below)
- `ctx.waitFor(condition, timeoutMs?, intervalMs?)`: polls until `condition` returns a truthy value and resolves with it; rejects with `waitFor timed out after <timeoutMs>ms` (5000 by default)
- `ctx.state`: one object shared across the cases of a suite or group
- `ctx.skip(reason)`: skips the current case at runtime (in a suite, the later cases skip with the same reason)
- `ctx.layer`: the row the case runs on (`build`, `background`, `view`, `boot`)

The layer adds its own:

- `view`: `ctx.page` is the harness page's `window`.
- `boot`: `ctx.extension` (the loaded extension) and `ctx.page`, a fresh Puppeteer page per case, closed once the case reports. A suite that declares `view: '<name>'` runs inside that built view instead, where `ctx.page` is its `window`. See [test-boot-layer.md](test-boot-layer.md).

A `background`, `view` or built-view case runs INSIDE the worker or the page, so it also reaches the page through its globals (`document`, `window`, `chrome`).

## `expect()` matchers

One surface on every layer: devkit's assertion library ([packages/devkit/src/test/expect.js](../../packages/devkit/src/test/expect.js)), required on the build and boot layers, inlined as source into the service worker and every page, and handed out by the public door as `require('@omega.js/extension/test').expect`. `ctx.expect(actual, message?)`: a failed check throws an `AssertionError`, its message prefixed `<message>: ` when you pass one.

```js
ctx.expect(actual).toBe(expected);                     // Object.is: NaN is NaN, 0 is not -0
ctx.expect(actual).toEqual(expected);                  // strict deep equality: Date, RegExp, Map, Set, typed arrays, Error,
                                                       //   boxed primitives, prototypes, symbol keys and undefined-valued keys count
ctx.expect(actual).toBeTruthy() / .toBeFalsy()
ctx.expect(actual).toBeDefined() / .toBeUndefined()
ctx.expect(actual).toBeNull()
ctx.expect(actual).toContain(item);                    // array member or substring
ctx.expect(actual).toHaveProperty('a.b', value?)       // or ['a.b'] for a key holding a dot; own or inherited; value by Object.is
ctx.expect(actual).toMatch(/regex/)                    // or a string: a substring
ctx.expect(actual).toBeInstanceOf(Class)
ctx.expect(actual).toBeGreaterThan(n) / .toBeGreaterThanOrEqual(n)
ctx.expect(actual).toBeLessThan(n) / .toBeLessThanOrEqual(n)
ctx.expect(actual).toBeTypeOf('string')                // typeof, plus 'array'
ctx.expect(response).toBeSuccess() / .toBeError(401)   // .success truthy / falsy (and .status equals the status given)
ctx.expect(fn).toThrow(matcher?)                       // below
ctx.expect(actual).not.toBe(expected)                  // negation: every matcher
await ctx.expect(promise).rejects.toThrow(/regex/)     // every matcher, on the rejection reason; a promise that fulfils fails
ctx.expect.fail('why')                                 // throws
```

`toThrow` on a function that throws synchronously checks at once and returns nothing; on a function that returns a promise it returns a promise to `await`. Its matcher is a string (a substring of the message), a RegExp (tested on the message), an Error class (`instanceof`), a validator function (passes only when it returns `true`; its own throw propagates) or an object (each key checked on the thrown error: a RegExp value is tested, any other value compared by strict deep equality). A matcher of any other type throws a usage error naming `toThrow`.

## Consumer pattern: use the build module

Don't `require('json5')` or other transitive @omega.js/extension deps directly from consumer tests: they're not in your `package.json` and the resolution path is fragile. Instead use @omega.js/extension's build module:

```js
const build = require('@omega.js/extension/build');

// Parsed JSON5, the same logic the framework uses internally
const config   = build.getConfig();
const manifest = build.getManifest();
```

This is the same pattern @omega.js/desktop and @omega.js/backend consumers use: assert on framework API output rather than re-implementing parsing/loading in every test.

## Build-layer example

```js
// test/build/config.test.js
const build = require('@omega.js/extension/build');
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'config has required brand fields',
  tests: [
    {
      name: 'brand.id is set',
      run: (ctx) => {
        ctx.expect(build.getConfig().brand.id).toBeTruthy();
      },
    },
    {
      name: 'cloud.config.projectId matches brand.id',
      run: (ctx) => {
        const cfg = build.getConfig();
        ctx.expect(cfg.cloud.config.projectId).toBe(cfg.brand.id);
      },
    },
  ],
});
```

## Background-layer example

```js
// test/background/messaging.test.js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  type: 'suite',
  layer: 'background',
  description: 'chrome.runtime.* surface in real SW',
  tests: [
    {
      name: 'chrome.runtime.id is a non-empty string',
      run: async (ctx) => {
        ctx.expect(typeof chrome.runtime.id).toBe('string');
        ctx.expect(chrome.runtime.id.length).toBeGreaterThan(0);
      },
    },
    {
      name: 'storage.local round-trip',
      run: async (ctx) => {
        await chrome.storage.local.set({ k: 'v' });
        const out = await chrome.storage.local.get('k');
        ctx.expect(out.k).toBe('v');
      },
    },
  ],
});
```

## View-layer example

A `view` suite runs on the harness extension's pages: `context: 'popup' | 'options' | 'sidepanel'` picks which one (`popup` when omitted), and `ctx.page` is that page's `window`. That tests the framework surface in a bare page, not your UI.

### Testing your own views

A suite that declares **`layer: 'boot'`** and **`view: '<name>'`** runs in YOUR built `views/<name>/index.html` ([#959](https://github.com/Omega-JS-Stack/omega/issues/959)), the same pair a desktop built-view suite declares, and lives under `test/boot/` like desktop's. `layer: 'view'` always means a harness page, and `test/view/` holds those harness-page suites only:

```js
// test/boot/popup.test.js
const { defineCases } = require('@omega.js/extension/test');

module.exports = defineCases({
  type: 'group',
  layer: 'boot',
  view: 'popup',                      // <- views/popup/index.html, as built
  description: 'the popup',
  tests: [
    {
      name: 'the sign-in button renders',
      run: async (ctx) => {
        ctx.expect(document.querySelector('.omega-signin')).not.toBeNull();
      },
    },
    {
      name: 'the page is the built popup',
      run: async (ctx) => {
        ctx.expect(ctx.page.location.href).toBe(chrome.runtime.getURL('views/popup/index.html'));
      },
    },
  ],
});
```

It is a **boot** suite, because only that layer loads your packaged extension (`packaged/chrome/raw/`, see [test-boot-layer.md](test-boot-layer.md)): the page is your real built view with its real bundle, talking to your real background, and `ctx.page` is its `window`. Build first (`npm run build`); without a build the layer skips it as it skips every boot case.

- `--layer=boot` and a run with no `--layer` run it; `--layer=view` does not.
- The standalone form (one `run`, no `tests`) works too: it runs as one test named for its `description`, and `--filter` matches that name.
- The page opens at `domcontentloaded` and the suite starts at once, so a test waits for its own UI to settle (a short poll on the DOM) before asserting. Test bodies run inside the page and close over nothing, so each carries its own wait.
- A view the project never built (no `views/<name>/index.html` in the loaded extension) fails every test of the suite, naming the missing file, rather than running on some other page.
- The worked example is the playground extension target's [`test/boot/`](../../brands/playground-omega/targets/extension/test/boot) `popup.test.js` and `sidepanel.test.js`: its popup's signed-out state and "Open notes" button, and a real submit in its side panel.

For the boot layer's own cases (`run(ctx)` with `ctx.extension` and a Puppeteer `ctx.page`), see [test-boot-layer.md](test-boot-layer.md).

## How in-app suites are shipped to the worker and the page

MV3 service workers have a strict CSP that forbids `eval` / `new Function` / `new AsyncFunction`. So a case body can never be rebuilt from a string inside the worker.

Instead each suite travels as ONE payload, built in the runner: the source text of devkit's `run-case.js` and `expect.js` (the same engine and assertions the build layer runs), then the suite as `@omega.js/devkit/test/serialize` writes it (`serializeSuite`: every body as its text), each body spliced in as a literal `async (ctx) => { ... }`. The payload is evaluated once (CDP `Runtime.evaluate` on the worker, `page.evaluate` on a page, both exempt from the page CSP) and runs the suite through devkit's `runSuite`; each case reports as one console line, the envelope of `@omega.js/devkit/test/events` (its `EVENT_PREFIX` plus the event's JSON, the prefix handed in from the runner, never typed in the payload). The driver reads each line back through that module's `createEventTracker(report)`, which returns `{ reported, onEvent(event), settle(cases, error?) }`: `onEvent` hands a parsed event to the runner by case id, and `settle` runs once the suite has. A load or harness failure fails every case of that suite not yet reported; so does a malformed envelope line (a prefixed line whose rest is not JSON), failing those cases with its parse error.

You don't have to think about this (write tests in normal JS), but it's why test bodies must be **self-contained**: they can't close over their file's module scope. A body takes `ctx` (or nothing) and uses `ctx` and the browser globals (`chrome`, `document`, `window`) only; a body that cannot travel (a parameter other than `ctx`, a bound or native function) fails its case naming the file.

## Why a custom harness instead of Jest / Vitest?

Browser-context code (background SW, popup DOM, content script) only runs inside Chromium. This is exactly why @omega.js/extension does not let you mock: a faked `chrome.runtime` (Jest's jsdom can't reproduce it faithfully) or a stubbed API (`webextension-polyfill` provides one, but it doesn't catch real SW lifecycle bugs) passes tests while shipping broken extensions. Puppeteer gives a real Chromium with real `chrome.*` APIs, so the harness is the real thing — not a substitute you assert against. See [NEVER mock](#never-mock--test-against-the-real-harness).

Same trade-off @omega.js/desktop makes with Electron: tests must run inside the real runtime, so the framework owns the runner.

## See also

- [test-boot-layer.md](test-boot-layer.md) — boot layer deep-dive (loads consumer's actual packaged extension)
- [environment-detection.md](environment-detection.md): `omega.isTesting()` / `isDevelopment()` / etc.
