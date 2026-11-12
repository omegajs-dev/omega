# Test Framework

Built-in test framework for both @omega.js/desktop itself and consumer projects. Jest-like assertion syntax (`expect(actual).toBe(expected)`), layered runners, @omega.js/backend-style output.

## 🚫 NEVER mock — test against the real harness (HARD RULE)

**Do NOT hand-roll fake/stub/mock objects**: no mock `omega`, fake `ipc`/`storage`/`window`/`tray`, stubbed `app`/`BrowserWindow`, or fake IPC channels. Every test gets the **real** framework context:

- `build` runs real @omega.js/desktop helper code in plain Node.
- `main` / `renderer` / `boot` run inside a **real spawned Electron process**, where `ctx.omega` is the **real booted main-process instance**: real `omega.storage`, `omega.ipc`, `omega.tray`, `omega.windows`, etc. Use them; exercise the code the way production does.

**Pure functions are the ONLY exception.** A function with zero I/O (config-defaults merge, icon-path resolver, schema validator, CLI alias resolver, a string/number transform) can be `require()`d and called directly with plain inputs — that's not mocking, there's nothing to mock. The moment a function touches `app.*` / `BrowserWindow` / `ipcMain` / `Tray` / the real bundle / an external service, it MUST run against the real harness in the appropriate layer (`main` / `renderer` / `boot`), not a stub.

**Real external APIs are gated behind extended mode (`TEST_EXTENDED_MODE`), NOT mocked** (see [Extended vs normal mode](#extended-vs-normal-mode) below). Normal mode skips them *in the source*; extended mode runs them for real. The test never fakes them. **Anything an extended test creates in a real external system MUST be cleaned up** by the test (via the suite's `cleanup(ctx)` hook) — external systems are not reset between runs.

If you find yourself writing `const mockX = {...}` to satisfy code under test, STOP: pass the real `ctx.omega` (or its real sub-object), or, if the function is genuinely pure, call it directly with plain data.

### The ONLY two exceptions where a narrow stub is allowed

Mock **nothing** by default. There are exactly two cases where the real dependency genuinely cannot run in the test environment — and even then, stub the *smallest possible seam* (one method / one object), restore it immediately, and comment *why*:

1. **A side effect that would destroy the test run itself.** If the real call would kill or corrupt the harness — `app.quit()`, a process-exit, `autoUpdater.quitAndInstall()`, a destructive wipe — stub *that one call* to a no-op, assert the surrounding decision logic (e.g. that `_allowQuit` was set first), then restore. You are preventing the harness from terminating mid-assertion, not faking behavior. (Examples: `window-manager.test.js` stubs `app.quit`; `auto-updater.test.js` stubs `installNow`/`_promptToInstall`.)
2. **A real dependency the test environment can't provide.** When the real object only exists from infra you can't stand up in a unit test (e.g. a live `webContents` from a not-yet-created window, a second running app instance), a unit test may hand a minimal stub to verify a *narrow side effect* (e.g. that `attach()` registers the right listener). Prefer obtaining the real object from the harness if you can; only stub when you genuinely can't.

If you can run it for real, you must. These exceptions are not a license to unit-test in isolation when a real-harness layer (`main`/`renderer`/`boot`) would work.

## Test coverage — every surface gets a test (HARD RULE)

A feature is not done when it works — it's done when every surface it exposes is covered in the layer that owns that surface:

| Coverage | Layer | Proves |
|---|---|---|
| **Logic** | `build` / `main` | The feature's functions do the right thing when called directly (the real booted `omega`, real storage, real IPC) |
| **UI** | `renderer` | The feature's interface is WIRED — a real event on the real DOM triggers the behavior and the visible result appears |
| **End-to-end** | `boot` | The feature survives in the consumer's actual built bundle (extend the boot suite's `run(ctx)` cases) |

**Skipping a layer is the exception, not the default.** A layer may be skipped ONLY when the feature genuinely has no surface there — a pure build-time utility has no UI; a CSS-only tweak has no logic to call. Convenience is never a reason: "the logic test already covers it" does NOT excuse the UI test — logic tests prove the logic, UI tests prove the wiring (a button can come unhooked while every logic test stays green), boot tests prove the packaging. When in doubt, write the test.

## Running tests

```bash
npx omega test                          # consumer: runs YOUR project suites (bare runs never include the framework corpus)
npx omega test --layer=main             # one row only: build, main, renderer or boot (default: every row, in that order)
npx omega test --filter="storage"       # only suites/tests whose name contains "storage"
npx omega test --extended               # opt into extended mode: real external APIs (also: TEST_EXTENDED_MODE=true)
npx omega test --reporter=json          # stdout is ONE JSON document, the run's result; every other line goes to stderr
OMEGA_TEST_BOOT_TIMEOUT_MS=120000 npx omega test   # the boot lane's budget (default 60s)
```

The verb is ONE run of devkit's runner, in the verb's own process ([devkit/index.md](../devkit/index.md#the-case-runner)): one Results block, one tee to `logs/test.log`, and the exit code `1` on a failed case, the no-match code on a path that matched nothing, else `0`. In @omega.js/desktop itself, `npm test` runs the framework's own suite: the self-test context flips the no-target default.

### Filtering tests

Pass a path (relative to `test/`) as a positional **target** to select which test FILES run:

```bash
# Run project test files under a path (a bare path binds to the PROJECT source)
npx omega test build/config

# Run BOTH sources — reaching the framework suite is always an explicit choice
npx omega test full:
npx omega test full:build/config

# Run ONLY consumer project tests (no framework suites at all)
npx omega test project:

# Run a single project test file
npx omega test project:main/tab-manager

# Run ONLY framework tests (universal cross-framework alias)
npx omega test mgr:

# Run ONLY @omega.js/desktop framework tests (desktop-specific aliases, equivalent to mgr:)
npx omega test desktop:
npx omega test framework:

# Run framework tests matching a path
npx omega test mgr:build/config
npx omega test desktop:build/config

# Combine with extended mode
TEST_EXTENDED_MODE=true npx omega test build/config
```

The target matches against the test file path. The source prefix scopes selection to framework-only or project-only tests — a prefixed target excludes the other source entirely:

- `mgr:`: the **universal cross-framework alias** for "the framework's own tests" (framework-only). Works identically in @omega.js/desktop, @omega.js/extension, @omega.js/web, and @omega.js/backend.
- `desktop:` / `framework:` — desktop-specific aliases for framework-only tests, equivalent to `mgr:`.
- `project:` — consumer project tests only.

A bare prefix (`mgr:` / `desktop:` / `project:` with no path) runs every test in that source. A bare path (no prefix) binds to the PROJECT source; `full:<path>` searches both sources by path.

A target that names a path and matches NO file is a hard error: the run prints `No test file matches "<target>"` and exits 1, so a typo'd path, or a suite renamed out from under a target, can never run silently green ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)). A run that named no file (bare, or a bare source prefix) still exits 0 when there is nothing to run. Inside a brand-root fan-out the manager sets `OMEGA_TEST_FANOUT=1` on every forwarded run, and the same miss answers with exit 3 instead: a path another target carries is a no-op here, and the brand run fails only when EVERY target missed ([docs/shared/testing.md](../shared/testing.md#brand-root-cp94b)).

> **Target vs `--filter`.** The positional target selects test FILES (by path + source). The `--filter=<substring>` flag is orthogonal: it matches test NAMES/descriptions within the selected files. Use them together, e.g. `npx omega test project: --filter="reorder"`.

### Layers

The rows run in this order, every row by default, one row under `--layer=<name>`:

- **build**: runs in the runner's own process, plain Node. Fast.
- **main**: its own Electron, launched on the harness app, runs inside the main process. Required for anything touching `app`/`ipcMain`/`BrowserWindow`.
- **renderer**: a second Electron of its own, launched on the same harness app, runs inside a hidden `BrowserWindow` on the harness page. Bodies travel as text (devkit's `fnSource`) and are rebuilt in the page as `async (ctx) => { body }`, so a body sees only `ctx` and the page's globals (`window`, `document`, `window.desktop.*`): no closures over module scope, and a function whose parameters are anything but `()` or `(ctx)` fails its case naming the file.
- **boot**: rebuilds the project and spawns Electron against the real bundle. The build goes to a staged app root of its own (`<project>/.omega/test-app/`, via `OMEGA_BUILD_OUTPUT`), never the project's `dist/`, so a boot-test run and a live `npm start` watcher never write the same tree. A boot suite with `view: '<name>'` runs in that built view's window. See [test-boot-layer.md](test-boot-layer.md).

### Extended vs normal mode

Suites that hit a live backend (a real GitHub API call, a store publish, etc.) are gated behind **extended mode**: `npx omega test --extended` or `TEST_EXTENDED_MODE=true`. `TEST_EXTENDED_MODE` is the **shared, unprefixed env var across @omega.js/backend, @omega.js/extension, UJM, and @omega.js/desktop** (cross-framework parity): once set on `process.env` it propagates to every spawned test environment (the Electron main/renderer/boot children, the gulp boot build) automatically via `{ ...process.env }`. These external calls are **skipped in-source, NOT mocked**: the suite short-circuits / `ctx.skip()`s when `TEST_EXTENDED_MODE` is unset; with it set, it calls the real service. Default is to skip them so `npx omega test` is fast + green offline, and a warning prints when extended mode is on. The CI workflow runs normal mode by default; add a separate workflow that sets `TEST_EXTENDED_MODE: 'true'` for extended coverage.

Anything an extended suite creates externally must be torn down in its `cleanup(ctx)` — the harness only resets local Electron state between runs, never external systems.

### `OMEGA_ENVIRONMENT=testing`, the one input a test run names

Both @omega.js/desktop test runners (`runners/electron.js`, `runners/boot.js`) spawn their child with `OMEGA_ENVIRONMENT=testing`, the ONE environment input ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)), and nothing writes over an explicit one: the word a build baked into the artifact is the fallback for a packaged app, never an override ([#925](https://github.com/Omega-JS-Stack/omega/issues/925)). That powers `omega.isTesting()` (and the build module's `isTesting()`), the cross-context helper everything in @omega.js/desktop checks when it needs to behave differently in tests:

- `auto-updater` flips its idle threshold from 15min → 3s and its periodic tick from 60s → 500ms, AND short-circuits the native install-prompt dialog (so tests don't pop modal windows).
- **Every BrowserWindow surfaces stealth** — named windows via `window-manager._surface()` AND raw `new BrowserWindow()` ones (e.g. a consumer's automation popup) via a global `browser-window-created` hook registered in `main.js` step 1a-ii. The shared recipe lives in `src/utils/stealth-window.js`: shown INACTIVE (keyboard focus never leaves your editor), opacity 0, click-through (`setIgnoreMouseEvents`), and raw windows get `show()` rerouted to `showInactive()` + `focus()` no-op'd — a test run never interrupts you, and a stray real click physically can't land in the app, while synthetic test input (`executeJavaScript`, `sendInputEvent`, CDP) is unaffected. **`webContents.focus()` is suppressed separately** (a global `web-contents-created` hook in the same main.js block): it bypasses the window-level patches — it's a different object whose `focus()` reaches the native window directly and makes the invisible window KEY, grabbing the keyboard mid-typing even under the accessory policy (which only prevents *launch* activation, not key-window steals). Consumers call it legitimately (e.g. address-bar focus on tab select), so it's no-op'd per-contents under the same predicate. Set **`OMEGA_TEST_SHOW=1`** to surface windows normally and watch a run live (the predicate is evaluated per window, so flipping it mid-run works). Deliberately NOT `hide()`/`minimize()`: occluded windows get throttled by Chromium (`requestAnimationFrame` pauses, `document.visibilityState` flips to `hidden`) — tests would exercise a DIFFERENT runtime, whereas an opacity-0 shown-inactive window renders and behaves identically to a visible one. See [windows.md](windows.md).
- **App-level activation is suppressed too (macOS).** Launching a regular-policy app activates it — the menu bar and keyboard focus switch to the test process at launch even though every window surfaces inactive. Under the same stealth predicate (`src/utils/test-stealth.js` — Testing mode + `OMEGA_TEST_SHOW` unset), `main.js` (step 1a, before app ready) and the spawned test harness flip the app to the **accessory activation policy** (`app.dock.hide()` — the same switch `LSUIElement` bakes for packaged hidden-mode apps): the process never activates, never shows a dock icon, and never steals focus, while windows still render identically. `OMEGA_TEST_SHOW=1` restores normal activation along with visible windows. Verified by frontmost-app sampling across a full run: zero focus changes (previously four steals per run).
- `main.js#initialize` isolates userData per environment: testing runs get `<userData> (Testing)` — **wiped at boot**, so every test run starts from a clean slate (post-run state stays on disk for inspection until the next run; set `OMEGA_TEST_KEEP_USERDATA=1` to skip the wipe). Dev runs get ` (Development)`; production is untouched. See [boot-sequence.md](boot-sequence.md).
- **The main-layer harness exposes a CDP endpoint.** `test/harness/main-entry.js` appends `--remote-debugging-port=0` at require time (loopback-only, OS-assigned port) and publishes the resolved port as **`process.env.OMEGA_CDP_PORT`** before suites run (read from Chromium's `DevToolsActivePort` file; any value inherited from your shell is overwritten — that one points at your dev app, not the harness). Consumer suites can drive real browser automation against the harness Electron itself, e.g. `playwright-core`'s `connectOverCDP('http://127.0.0.1:' + process.env.OMEGA_CDP_PORT)`. Covered by `suites/main/harness-cdp.test.js`.
- Other lib code can branch on `omega.isTesting()` to suppress dock bounce, login-item changes, OS protocol-handler registration, etc.

Consumers writing their own tests name the same input in their own runner, for example in `package.json`:
```json
"test": "OMEGA_ENVIRONMENT=testing vitest"
```
Then in your code, gate test-only behavior on `omega.isTesting()` instead of inventing yet another env var.

## Test discovery

- **Framework defaults**: `<@omega.js/desktop>/dist/test/suites/**/*.test.js`
- **Consumer suites**: `<cwd>/test/**/*.test.js`

**The underscore convention** (devkit's discovery, [devkit/index.md](../devkit/index.md#the-case-runner)): `_`-prefixed FILES (`test/_init.js`, `test/main/_helper.js`) and everything under a `_`-prefixed DIRECTORY at **any depth** (`test/_fixtures/**`, `test/boot/_private/**`) are excluded from suite discovery. Put shared helpers, fixture data, and non-test support files in `_`-prefixed paths: e.g. `test/_fixtures/`, `test/_helpers/`. The runner still specifically loads `test/_init.js` as the lifecycle hook. Matches the same convention in @omega.js/backend/BXM/UJM. Files load alphabetically (sorted globally per source).

**Framework boot suites are scoped to @omega.js/desktop self-test runs only.** When a consumer runs `npx omega test`, the framework's `dist/test/suites/boot/**` is excluded from discovery — those tests are meant to assert on @omega.js/desktop's own internal fixtures and would fail noisily against a real consumer app. Detection: the runner checks `cwd`'s `package.json#name === '@omega.js/desktop'`. Consumers write their own boot tests under `<cwd>/test/boot/`. Matches the same exclusion pattern in BXM and UJM. See [test-boot-layer.md](test-boot-layer.md).

## `test/_init.js` — pre-test lifecycle hook

The runner loads an optional `test/_init.js` from **both** test roots — the framework (`<@omega.js/desktop>/test/_init.js`) and the consumer project (`<cwd>/test/_init.js`) — and runs it **once, before any suite** (it is NOT itself run as a test; the `_`-prefix keeps it out of discovery). Mirrors the same hook in @omega.js/backend/UJM/BXM so all four frameworks share one shape.

The module **must export a function** — `module.exports = (ctx) => ({ ... })` — called with `{ projectRoot }` and returning the hook object. It may declare:

- `async setup({ projectRoot })` — runs once before the suites, e.g. to scaffold a fixture file the boot layer needs.

There is **no `cleanup` hook** and **no `accounts` field** (unlike @omega.js/backend — these frameworks have no auth/user system): tests clean up after themselves, so there is nothing project-level to tear down.

A hook that fails to load, exports a non-function, whose factory throws or returns a non-object, or whose `setup` throws, fails the run before any suite: the loader (`@omega.js/devkit/test/init-hooks`) throws an `InitHookError` naming the file and carrying the cause, the runner reports it as a failed entry with no case run, and `omega test` exits 1.

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

Three forms; pick whichever fits. Every one exports through `defineCases`, from the public test API: `const { defineCases } = require('@omega.js/desktop/test');`. It hands the spec to the OMEGA runner unchanged. Run on its own with `node --test`, a `build`-layer file runs its own cases, and a file on any other layer registers one failing case naming `npx omega test` ([testing.md](../shared/testing.md#mirrored-suite-shape)). The framework's own suites take the same function from `@omega.js/devkit/test/define-cases`, which prepare vendors into `dist/`.

### Suite (sequential, share state, stop on first failure)

```js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  type: 'suite',
  layer: 'main',                    // 'build' | 'main' | 'renderer' | 'boot'
  description: 'storage (main)',
  cleanup: async (ctx) => {         // runs after the last test
    ctx.omega.storage.clear();
  },
  tests: [
    {
      name: 'set + get round-trip',
      run: (ctx) => {
        ctx.omega.storage.set('hello', 'world');
        ctx.expect(ctx.omega.storage.get('hello')).toBe('world');
      },
    },
    {
      name: 'has reflects presence',
      run: (ctx) => { /* ... */ },
      cleanup: (ctx) => { /* ... */ },     // per-test cleanup
      skip: 'reason',                       // skip this test
    },
  ],
});
```

Tests share `ctx.state` across the suite. If one fails, remaining tests are skipped (`stopOnFailure: false` to disable).

- A suite's `setup` and `cleanup` and each `ctx.after` function run under the limit a case has (the suite's `timeout`, else 30s): a `setup` past it fails every case, and an `after` past it fails its case.
- A suite `cleanup` past it fails a `build` run, but only warns on stderr in the in-app `main`, `renderer` and `boot` suites ([testing.md](../shared/testing.md#mirrored-suite-shape)).

### Group (parallel-ish, share state, run all regardless of failures)

```js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  type: 'group',
  layer: 'main',
  description: 'boot sequence (main)',
  tests: [ /* same shape as suite */ ],
});
```

Same shape as suite, but all tests run even if some fail.

### Standalone (single test per file)

```js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  layer: 'build',
  description: 'CLI alias resolves to a command file',
  run: (ctx) => { /* ... */ },
  cleanup: (ctx) => { /* ... */ },
  timeout: 10000,
  skip: false,
});
```

### Array shorthand (group of tests, no metadata)

```js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases([
  { name: 'A', run: (ctx) => { /* ... */ } },
  { name: 'B', run: (ctx) => { /* ... */ } },
]);
```

## Layers

| Layer | Where it runs | Use for |
|---|---|---|
| `build` | The runner's own process, plain Node | CLI, package.json, config schema, gulp tasks |
| `main` | A spawned Electron's main process, booted on the harness app | `omega.initialize()`, lib modules, IPC, windows |
| `renderer` | A hidden BrowserWindow on the framework's harness page, in a second spawned Electron | `window.desktop.*`, preload bridge, UI logic |
| `boot` | The project's own built app: its main process, or one of its built views when the suite declares `view: '<name>'` | the real bundle end to end, your own views |

Every suite file loads once in the runner, which hands each app row's suites to that row's driver (`src/test/runners/`). The driver runs the cases inside the app, through devkit's own `run-case.js` and `expect.js`, and each case reports back by id as one `__OMEGA_TEST__` line on the app's stdout (devkit's `./test/events`, the one envelope).

## ctx (context object)

Every test fn receives a `ctx`:

```js
ctx.expect(actual)          // devkit's expect(), below
ctx.waitFor(condition, timeoutMs?, intervalMs?)  // poll until condition() returns a truthy value
ctx.state                   // shared object across tests in a suite/group
ctx.layer                   // 'build' | 'main' | 'renderer' | 'boot'
ctx.skip(reason)            // skip from inside the test
ctx.omega                   // (main and boot) the booted @omega.js/desktop main-process instance
ctx.page                    // (renderer, and a boot suite with `view`) the page's `window`
ctx.projectRoot, ctx.appRoot, ctx.frameworkDistRoot, ctx.distSnapshotBefore   // (boot, main process)
```

## expect() matchers

On every layer `ctx.expect` is devkit's one assertion library ([packages/devkit/src/test/expect.js](../../packages/devkit/src/test/expect.js)), the same `expect` the door `@omega.js/desktop/test` exports; a page receives its source text and runs it as is. `expect(actual, message?)`: a failed check throws an `AssertionError`, its message prefixed `<message>: ` when you pass one.

```js
.toBe(expected)                         // Object.is: NaN is NaN, 0 is not -0
.toEqual(expected)                      // strict deep equality: Date, RegExp, Map, Set, typed arrays, Error,
                                        //   boxed primitives, prototypes, symbol keys and undefined-valued keys count
.toBeTruthy() / .toBeFalsy()
.toBeDefined() / .toBeUndefined() / .toBeNull()
.toContain(item)                        // array member or substring
.toHaveProperty(path, value?)           // 'a.b', or ['a.b'] for a key holding a dot; own or inherited; value by Object.is
.toMatch(regexOrString)
.toBeInstanceOf(Class)
.toBeGreaterThan(n) / .toBeGreaterThanOrEqual(n)
.toBeLessThan(n) / .toBeLessThanOrEqual(n)
.toBeTypeOf(type)                       // typeof, plus 'array'
.toBeSuccess() / .toBeError(status?)    // a response's .success is truthy / falsy (and .status equals status)
.toThrow(matcher?)                      // below

.not.<matcher>                          // negates every matcher
await expect(promise).rejects.<matcher> // applies to the rejection reason; a promise that fulfils fails
expect.fail(message)                    // throws
```

`toThrow` on a function that throws synchronously checks at once and returns nothing; on a function that returns a promise it returns a promise to `await`. Its matcher is a string (a substring of the message), a RegExp (tested on the message), an Error class (`instanceof`), a validator function (passes only when it returns `true`; its own throw propagates) or an object (each key checked on the thrown error: a RegExp value is tested, any other value compared by strict deep equality). A matcher of any other type throws a usage error naming `toThrow`.

## Output

```
  @omega.js/desktop Tests

    ⤷ storage (main)
      ✓ set + get round-trip (7ms)
      ✓ has reflects presence (8ms)
      ...

  Results
    149 passing
    1 failing
    2 skipped

    Total: 152 tests in 1850ms
```

One Results block for the whole run, every row included; the failing and skipped lines appear when not 0, and a failed case prints its message and stack under its line. Lines the apps print pass through as they come. Under `--reporter=json` stdout carries only the JSON document the run resolves to (`{ passed, failed, skipped, noMatch, durationMs, tests }`); everything else goes to stderr.

All test output is also teed (ANSI-stripped) to `<projectRoot>/logs/test.log`, truncated fresh on each run, the same pattern as `dev.log` (and @omega.js/backend's `test.log`). Grep it after a run instead of scrolling terminal output.

## Test harness internals (main and renderer rows)

- `runners/electron.js` is the `main` and `renderer` driver: each row writes a spec file (`{ layer, suites }`) and spawns its own Electron on the harness directory (`harness/package.json` names `main-entry.js`) with `OMEGA_TEST_SPEC` naming the file.
- `harness/main-entry.js` boots `omega` with `skipWindowCreation: true`. For `main` it `require`s each suite file, normalizes it with the same file path (so the case ids match the runner's), keeps the cases the spec lists (a file that fails to load reports each of them failed, by id and name), and runs `runSuite` with ctx extras `{ omega }`. For `renderer` it opens the hidden harness window and sends the page engine (`harness/renderer-entry.js`) the suites serialized by devkit's `./test/serialize` plus the text of devkit's `run-case.js` and `expect.js`; the page runs `runSuite` with ctx extras `{ page: window }`. A harness page that sends no end event in 60s, fails to load, loses its renderer, or whose page engine ends with an error fails every case it has not reported with that cause (`renderer harness timed out (no end event in 60s)` for the first), and the app exits 1 (`harness/renderer-run.js`).
- Every case event is one `__OMEGA_TEST__{json}` line on stdout (`eventLine` and `parseEventLine` in devkit's `./test/events`, the one envelope every harness writes and every driver reads, extension's included). Every other line the app prints, stdout and stderr alike, passes through to the run's output as it comes.
- Each driver reads its app's events through devkit's `createEventTracker(report)` (`./test/events`), which keeps the ids reported. An app that ends before reporting every case leaves the rest to the runner (`the <layer> layer ended before this case reported`); one that exits non-zero adds its last stderr lines to that message. A malformed envelope line (the prefix with no JSON after it) fails every case the app had not reported by its end, with the parse error.
- `ELECTRON_RUN_AS_NODE` is stripped from the spawn env (would otherwise make Electron behave as Node and break the harness).
- On a Linux CI runner both drivers, these rows and the boot lane, launch Electron with `--no-sandbox` (`electronArgs` in `runners/app-child.js`): Electron's SUID sandbox helper aborts the launch where unprivileged user namespaces are restricted, as on ubuntu 24.04, and the app under test is a fixture.
- **Consumer-scheme containment.** The consumer's `main.js` (where the real `protocol.handle('<brand.id>', …)` lives) never runs in this harness, so `brand://` URLs loaded by main-layer suites would be UNHANDLED. Chromium treats a load on an unhandled scheme as an *external protocol* and hands it to the OS: and if an installed copy of the app owns the scheme (e.g. `/Applications/Brand.app` on macOS, registered via its `Info.plist`), Launch Services launches the installed production app mid-test-run. The harness contains this two ways after `omega` boots: (1) it registers a stub handler for the consumer's brand scheme (read from `<cwd>/config/omega.json5`) on the default session, so `brand://` loads commit in-process as a blank page; (2) it denies the `openExternal` permission on the default session and every session created after it (partitions included), so no navigation can hand ANY scheme to the OS during a test run. Suites that need real page content for `brand://` URLs belong in the boot layer, where the real app (and its real protocol handler) runs. A main-layer suite that genuinely needs its OWN handler for the brand scheme must call `protocol.unhandle(brand.id)` first: the harness stub holds the scheme on the default session.

## A test run never touches the OS keychain, and a blocked boot reports

The harness resolves auth persistence to the **`none`** strategy on every layer, main and boot alike, before any config is read: a brand that declares `omega.authPersistence: 'safeStorage'` still runs its tests with Firebase auth in memory, because the lanes never sign a real user in. That is a hard rule, not a nicety. The boot lane spawns the raw, unsigned `Electron` binary, which carries no keychain ACL, so one `safeStorage` read parks the entire run behind a macOS SecurityAgent prompt ([#907](https://github.com/Omega-JS-Stack/omega/issues/907)). ONE signal answers "is this a test run" on both layers, `omega.isTesting()`: the boot lane boots the consumer's PRODUCTION artifact, and the word baked into it no longer writes over the `OMEGA_ENVIRONMENT=testing` the runner spawned it with ([#925](https://github.com/Omega-JS-Stack/omega/issues/925)), so the booted app reports the lane it is running in. And since a boot can block long before `main.js` requires the harness (where the per-test timeout lives), the boot runner carries its own budget, measured as SILENCE: every harness line rearms it, so a suite that legitimately runs longer keeps going, and a boot that produces no harness output for 60s (`OMEGA_TEST_BOOT_TIMEOUT_MS` overrides) fails every case it has not reported, prints `✗ boot: no harness output after 60s; last runtime.log line: "<line>"` from the booted app's `logs/runtime.log`, and ends the child instead of hanging `npx omega test`.

## Writing consumer tests

In a consumer project, drop files in `test/` (or `test/**`):

```js
// test/login-flow.test.js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  type: 'suite',
  layer: 'main',
  description: 'login flow',
  tests: [
    {
      name: 'storage starts empty',
      run: (ctx) => {
        ctx.expect(ctx.omega.storage.get('user')).toBeUndefined();
      },
    },
  ],
});
```

`npx omega test` runs your project suites; scope `framework:` or `full:` to reach the framework's own.

### Testing your own views

A `boot` suite that declares **`view: '<name>'`** runs against `src/views/<name>/` of YOUR app, as built:

```js
// test/boot/main-view.test.js
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  type: 'group',
  layer: 'boot',
  view: 'main',                       // <- src/views/main/, as built
  description: 'the main view',
  tests: [
    {
      name: 'the heading renders the product name',
      run: (ctx) => {
        ctx.expect(ctx.page.document.querySelector('h1').textContent.trim()).toBe('My App');
      },
    },
    {
      name: 'the preload reached the page',
      run: (ctx) => {
        ctx.expect(typeof window.desktop).toBe('object');
      },
    },
  ],
});
```

Such a suite runs in the **boot lane**, because only that lane stages and builds the real app (`<project>/.omega/test-app/`) before running: the page gets the project's real `dist/preload.bundle.js`, the real IPC handlers of the booted main process, and the real config. The window is created through the app's own window manager (hidden, no bounds persistence) and destroyed when the suite ends. Cost is the boot lane's: one build (~10-30s) shared with your boot tests.

Consequences worth knowing:

- **`layer: 'renderer'` always means the framework's harness page.** A `view` key on any layer but `boot` fails the file at load, naming it. A suite that tests your own view declares `layer: 'boot'`, and runs under `--layer=boot` or the default every-row run.
- The standalone form (one `run`, no `tests`) works too: it runs as one test named for its `description`, and `--filter` matches that name.
- The bodies run inside the page, rebuilt from their text: no closures over module scope, only `ctx` (`expect`, `waitFor`, `state`, `layer`, `skip`, `page`) and the page globals (`window`, `document`, `window.desktop.*`). `ctx.page` is the page's `window`.
- A view that fails to load fails every test of the suite with `view "<name>" did not load`, rather than reporting an empty page.
- A view suite that throws (a crashed page, a destroyed window) or whose page engine ends with an error fails the tests it has not reported with that error, and the next view suite still runs.
- Each case has its own timeout (the case's, then the suite's, then 30s); a page that stops answering altogether is the boot lane's idle budget to end.
