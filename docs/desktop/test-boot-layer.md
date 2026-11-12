# Test Framework — Boot Layer

The `boot` test layer runs against the consumer's **actual built `main.bundle.js`** — the real production main entry, loaded exactly as `electron .` loads one. Replaces shell-level `npm start && sleep 12 && kill` smoke tests with deterministic, signal-driven pass/fail.

The build and the boot happen in a **staged app root of their own**, `<project>/.omega/test-app/` (gitignored) — never the project's `dist/`, which belongs to the `npm start` watcher. See [Isolated build output](#isolated-build-output).

## When to use it

| Layer | What it tests | Speed |
|---|---|---|
| `build` | Plain Node — config parsing, util fns, schema validation. | Fast (ms) |
| `main` | @omega.js/desktop lib code in isolation (storage, ipc, tray, etc.) inside Electron. | Fast (~50ms each) |
| `renderer` | Inside a hidden BrowserWindow. | Fast |
| `boot` | The **whole boot integration**: consumer's main.js → omega.initialize → live state | ~1s startup, then fast |

Use `boot` for tests that need to verify **integration** rather than unit behavior:
- "Does the consumer's `src/main.js` actually wire up correctly?"
- "Did all 13 boot steps complete without throwing?"
- "Did config flow from JSON5 → omega.config → tray titles?"
- "Did `src/integrations/{tray,menu,context-menu}/index.js` load?"
- "Is the menu rendered with the expected default ids?"

## Test shape

```js
// test/boot.test.js (consumer-side)
const { defineCases } = require('@omega.js/desktop/test');

module.exports = defineCases({
  type:        'group',
  layer:       'boot',
  description: 'consumer boot smoke',
  timeout:     20000,
  tests: [
    {
      name: 'omega initialized end-to-end',
      run: async (ctx) => {
        ctx.expect(ctx.omega._initialized).toBe(true);
        ctx.expect(ctx.omega.config).toBeTruthy();
      },
    },
    {
      name: 'tray + menu rendered',
      run: async (ctx) => {
        ctx.expect(ctx.omega.tray.has('open')).toBe(true);
        ctx.expect(ctx.omega.menu.isRendered()).toBe(true);
      },
    },
  ],
});
```

A boot case is `{ name, run(ctx), timeout?, skip? }`, the case every other layer takes. Its `run` is rebuilt from its text inside the booted app's main process, so it sees `ctx` plus Node's `require`, `process` and `Buffer`, never a closure over the test file; its parameter list is `()` or `(ctx)`. Beside the ctx every layer gets (`expect`, `waitFor`, `state`, `layer`, `skip`), a boot case's ctx carries:

| Key | Description |
|---|---|
| `omega` | The fully-initialized live main-process instance, the same one your consumer code uses. |
| `expect` | devkit's assertion library ([expect.js](../../packages/devkit/src/test/expect.js)), the same `expect` the door `@omega.js/desktop/test` exports. Matchers: [test-framework.md](test-framework.md#expect-matchers). |
| `projectRoot` | Absolute path to the consumer project root (its `src/`, `config/` — and the `dist/` a boot run must never write). |
| `appRoot` | Absolute path to the staged app root Electron booted — `<projectRoot>/.omega/test-app`. Assert on built artifacts here (`<appRoot>/dist/main.bundle.js`), not under `projectRoot`. |
| `frameworkDistRoot` | Absolute path to `<@omega.js/desktop>/dist` — where framework test utilities live. |
| `distSnapshotBefore` | Fingerprint of `<projectRoot>/dist` taken before the test build, for the isolation assertion below. |

## How it works

1. The runner discovers `test/**/*.test.js` files and hands the ones with `layer: 'boot'` to the boot driver ([src/test/runners/boot.js](../../packages/desktop/src/test/runners/boot.js)). A suite skipped whole reports its cases skipped there and needs no build.
2. Stages `<projectRoot>/.omega/test-app`, builds into its `dist/` (a failed build fails every boot case with the build's error), and writes a JSON spec file: the suites without `view` and the suites with one, each serialized with its bodies as text (devkit's `./test/serialize`, over `fnSource`).
3. Spawns a real Electron process: `electron <projectRoot>/.omega/test-app` — an app dir with a `package.json` whose `main` is the built bundle, same shape as `npm start`'s `electron .`.
4. Sets three env vars before spawn:
   - `OMEGA_TEST_BOOT=1` — gate
   - `OMEGA_TEST_BOOT_HARNESS=<absolute path to dist/test/harness/boot-entry.js>`
   - `OMEGA_TEST_BOOT_SPEC=<temp file with test definitions>`
5. @omega.js/desktop's `main.js` boots normally; after `omega.initialize()` resolves, it detects `OMEGA_TEST_BOOT=1` and hands the instance to [harness/boot-entry.js](../../packages/desktop/src/test/harness/boot-entry.js), which waits up to 3s for the main window, rebuilds each suite without `view` and runs it through devkit's `runSuite` in this main process, and writes one `__OMEGA_TEST__` line per case on stdout (the one envelope, `eventLine` in devkit's `./test/events`).
6. The driver reports each line's case to the runner by id; the harness calls `app.exit()` once every suite has run. **No sleep, no kill.** A harness that cannot start writes its error on stderr and exits 1, and the runner fails every case it never reported.

## View suites in this lane

A boot suite that names a project view (`layer: 'boot'` + `view: '<name>'`) runs in that view: it needs exactly what this lane already produces, the staged, freshly built app. After the main-process suites finish, `boot-entry.js` opens each such suite's view in a real window of the booted app (through the app's own window manager, hidden), evaluates the page engine `harness/renderer-entry.js` inside the page with the text of devkit's `run-case.js` and `expect.js` (one suite loop, one `expect`, the harness page's own engine), runs the suite there with `ctx.page` set to the page's `window`, and destroys the window. So the page carries the project's real preload, the booted main process's real IPC handlers, and the real config. A standalone spec names its `view` at the top level like any other. The knob and its rules are documented in [test-framework.md](test-framework.md#testing-your-own-views).

## Two-launch suites

A boot suite that declares `secondLaunch: { afterLine, env }` tests what happens when the app is launched while a copy already runs. Its cases never run inside the app: after the harness run ends, the driver launches the built app twice with no harness. The first launch (the primary) starts, and once a line on its stdout holds `afterLine`, the driver launches the app again (the duplicate). `env` is optional and joins both launches' environment. The duplicate keeps the testing userData (`OMEGA_TEST_KEEP_USERDATA=1`), so its boot never wipes the lock the primary holds.

The suite's cases then run in the driver, and their ctx carries `exits`: one `{ role, code, signal }` per process that exited on its own, in the order they exited, `role` being `'primary'` or `'duplicate'`. A process still running when the boot budget ends is ended by the driver and left out of `exits`, so a launch that stalls shows up as a missing entry. A primary that never prints `afterLine` inside the budget fails every case of the suite, naming the line and the last `runtime.log` line.

```js
module.exports = defineCases({
  type:         'group',
  layer:        'boot',
  description:  'a forwarded launch exits as a duplicate',
  secondLaunch: { afterLine: 'main initialized' },
  tests: [
    {
      name: 'the duplicate exits first, then the primary',
      run: (ctx) => ctx.expect(ctx.exits.map((exit) => exit.role)).toEqual(['duplicate', 'primary']),
    },
  ],
});
```

The framework's own two-launch suite is [src/test/suites/boot/second-instance-quit.test.js](../../packages/desktop/src/test/suites/boot/second-instance-quit.test.js). Its primary is the bundled fixture with no window open (`OMEGA_TEST_FIXTURE_WINDOWLESS=1` through `env`), whose `second-instance` listener (`OMEGA_TEST_FIXTURE_QUIT_ON_FORWARD=1`, through the same `env`) calls `omega.quit()`, so its quit lands as fast as a tray-only brand's does.

## Running

```bash
# All layers including boot
npx omega test

# Boot only
npx omega test --layer=boot

# One JSON document on stdout, the boot cases among its tests
npx omega test --layer=boot --reporter=json
```

The booted app's own stdout lines pass through to the run's output as they come. Its silence is budgeted: a boot that writes no harness line for 60s (`OMEGA_TEST_BOOT_TIMEOUT_MS` overrides) fails every case it has not reported, naming the last line of its `logs/runtime.log`, and the child is ended.

## Isolated build output

`npm start`'s watcher owns `<project>/dist/`. When the boot runner built there too, a dev app and a boot-test run interleaved writes on one tree and either side could load a half-written bundle — a race that presents as a code bug. So the boot build gets its own output (#110).

**The seam** is [src/utils/dist-root.js](../../packages/desktop/src/utils/dist-root.js): every gulp task resolves its output through it instead of joining `dist/` by hand, and `OMEGA_BUILD_OUTPUT` (absolute, or relative to the project root) redirects the whole build. Nothing else in the build config is duplicated.

**The staged app root** is `<project>/.omega/test-app/`, built by `stageTestApp()` in [src/test/runners/boot.js](../../packages/desktop/src/test/runners/boot.js):

| Entry | What it is |
|---|---|
| `package.json` | The project's own, verbatim except `main`, pinned at the test build's bundle — so Electron derives the same app name, version and userData path a real boot does. |
| `dist/` | The isolated build output. `<appRoot>/dist/views/*`, `<appRoot>/dist/preload.bundle.js` and the tray icon lookup resolve against it with **no runtime change** — the app root moved, the layout under it did not. |
| `src`, `config` | Symlinks back to the project's. Runtime lookups against `app.getAppPath()` — `src/integrations/{tray,menu,context-menu}/index.js`, the unbundled config fallback — still find the consumer's real files. |

`package.json` and the symlinks are restaged on every run, and the runner clears the staged `dist/` before each build (kept only under `OMEGA_TEST_SKIP_BUILD`). `node_modules` resolution still walks up into the project's. The isolation promise is about `dist/`: a boot run still appends to the project's gitignored `logs/` (the gulp build log and the booted app's runtime log), same as any run.

The regression is covered end-to-end in the real run: the runner fingerprints `<project>/dist` before the build, and [src/test/suites/boot/build-isolation.test.js](../../packages/desktop/src/test/suites/boot/build-isolation.test.js) re-fingerprints it from inside the booted app and asserts nothing was touched.

## Prerequisites

**The runner always rebuilds the bundle first** (via the same gulp pipeline `npm run build` uses) so tests never see stale code. Adds ~10s to the boot-test run; correctness over speed.

Opt out for CI scenarios where build already ran in a separate step:

```bash
OMEGA_TEST_SKIP_BUILD=1 npx omega test --layer=boot
```

Boot then runs against whatever is already in `<project>/.omega/test-app/dist/`. If there is no bundle there, the run **fails loudly** rather than skipping or falling back to the project's `dist/` — an absent test build means the build step that was promised never ran, and booting some other bundle would silently test the wrong code.

## Self-test from the framework repo (the bundled fixture)

Everything above describes a **consumer** running boot tests against their own built bundle. @omega.js/desktop also boot-tests *itself* — the same way BXM verifies "does the extension load?" and UJM verifies "does the site boot?".

When `npx omega test` runs from the @omega.js/desktop repo (the cwd's `package.json` name is `@omega.js/desktop`), two complementary mechanisms engage:

- **The self-test** (devkit's discovery rule, [devkit/index.md](../devkit/index.md#the-case-runner)): test discovery includes the framework's own `boot/**` suites. For a real consumer the run is no self-test and framework `boot/**` suites are **excluded** (they target @omega.js/desktop's fixture, not the consumer's app), so they never run in a consumer's `npx omega test`.
- **`OMEGA_TEST_BOOT_PROJECT`** — [src/commands/test.js](../../packages/desktop/src/commands/test.js) points the boot runner at the bundled fixture under `src/test/fixtures/consumer-app/` instead of the cwd.

The gate decides *whether* the framework boot suite runs; the env var decides *which project* gets booted. (@omega.js/backend's `OMEGA_TEST_BOOT_PROJECT`, BXM's `OMEGA_TEST_BOOT_PROJECT`, and UJM's `UJ_TEST_BOOT_PROJECT` are the exact analogs.)

### The bundled fixture

`src/test/fixtures/consumer-app/` — a minimal, committed @omega.js/desktop consumer (source only):

- `config/omega.json5` — fake brand (`desktop-fixture`), `releases.enabled: false` (no repo discovery during the build), empty `cloud.config` (no Firebase hang).
- `src/main.js` / `src/preload.js` — the one-line bootstraps a real consumer ships; `main.js` creates the `main` window (`show: false`) unless `OMEGA_TEST_FIXTURE_WINDOWLESS=1`, and under `OMEGA_TEST_FIXTURE_QUIT_ON_FORWARD=1` its own `second-instance` listener, registered before it requires the framework, calls `omega.quit()`.
- `src/views/main/index.html` + `src/assets/js/components/main/index.js` + `src/assets/scss/main.scss` — a real view/renderer/theme so the bundle + sass tasks run exactly as for a consumer.

**Runtime-only, gitignored** (never committed): before the boot build, the runner symlinks `@omega.js/desktop` (→ the @omega.js/desktop repo root) and `electron` (→ @omega.js/desktop's own copy) into the fixture's `node_modules` — the only two deps resolved by *explicit path* (the gulpfile location, the bundle's `require('@omega.js/desktop/main')`, and the runner's electron-binary lookup). Everything else (gulp, esbuild, …) resolves via the upward `node_modules` walk because the fixture lives inside the @omega.js/desktop repo. The links are **removed again when the run finishes** — the `@omega.js/desktop` link points back at the repo root, which *contains* the fixture, so a leftover link forms an infinite directory cycle inside `dist/` that crashes the next prepare-package tree walk (`npm run prepare` / `npm publish` → `ENAMETOOLONG`). The fixture `.gitignore` is belt-and-suspenders for crashed runs. See `ensureFixtureDeps()` / `removeFixtureDeps()` in [src/test/runners/boot.js](../../packages/desktop/src/test/runners/boot.js).

The fixture is then **built into a real `main.bundle.js`** (under its own `.omega/test-app/dist/`, like any other boot run) and booted — the same production path a consumer's boot test exercises (bundled, not the unbundled lib code the `main` layer covers). The boot smoke lives at [src/test/suites/boot/consumer-app-boots.test.js](../../packages/desktop/src/test/suites/boot/consumer-app-boots.test.js).

### `OMEGA_TEST_BOOT_PROJECT`

| Env | Purpose |
|---|---|
| `OMEGA_TEST_BOOT_PROJECT` | Root of a project to boot instead of the cwd. Auto-set to `src/test/fixtures/consumer-app` when @omega.js/desktop tests itself; set it explicitly to boot a **real consumer** (e.g. `brands/playground-omega/targets/desktop`) without `cd`-ing into it. |

### Why this exists

The `build`/`main`/`renderer` layers cover @omega.js/desktop's lib code fast and in isolation. None of them prove the framework still assembles a consumer's `src/main.js` into a bundle that boots end-to-end. The fixture self-test fills that gap — @omega.js/desktop's analog of "does the extension load?" (BXM) / "does the site boot?" (UJM).

## Limitations

- Tests run sequentially in a single Electron process to amortize startup cost (~1s). They all share one `omega` instance; `ctx.state` carries across the cases of one suite.
- `run` bodies travel as text (devkit's `fnSource`) and are rebuilt inside the app. Closures over the test file's outer scope **don't survive**: only `ctx` (plus `require`, `process` and `Buffer` in the main process, the page globals in a view) is available inside.
- We can't simulate user input (clicking the tray, right-clicking, typing). For that, you'd need `nut-js` or similar — out of scope.
