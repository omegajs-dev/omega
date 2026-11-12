# Test Framework

## 🚫 NEVER mock — test against the real emulator (HARD RULE)

Tests run against a **real Firebase emulator** (real Firestore/Auth). **Do NOT hand-roll fake/stub/mock objects**: no mock instance, mock admin, hand-built `omega`, fake Firestore or admin, stubbed `ctx`, or fake HTTP. Every test `run()` receives the **real** booted `omega`, `ctx`, `firestore`, `http`, and `accounts` (see [the test context](#context-object)). Use them.

- Call routes over `http.as(...)`; call handlers/helpers with the real `omega`/`ctx` from context; read/write/verify with the real `firestore` helper.
- **Pure functions are the only exception** — a function with zero I/O can be `require()`d and called with plain inputs (nothing to mock). The instant it touches Firestore or any external system, it must run for real against the emulator.
- **Real external APIs (OpenAI, PayPal, GitHub, SendGrid, Beehiiv, Stripe) are gated behind `TEST_EXTENDED_MODE` in the source, NOT mocked** — see [Extended Mode](#extended-mode-test_extended_mode). Normal mode skips them; extended mode runs them for real.
- **Anything an extended test creates in an external system must be cleaned up by the test** (delete the GitHub file, cancel the PayPal invoice, etc.) — the runner's pre-test wipe only covers local Firestore/Auth.

If you're writing `const mockX = {...}` to satisfy a function under test, STOP and pass the real context object instead.

### The ONLY two exceptions where a stub is allowed

Mock **nothing** by default. There are exactly two narrow cases where the real dependency genuinely cannot run in the test environment, and even then, stub the *smallest possible seam*, never a whole `omega`/`ctx`:

1. **A side effect that would destroy the test run itself.** If invoking the real method would kill or corrupt the harness — e.g. a process-exit, an `app.quit()`, a destructive filesystem wipe, a recursive re-invocation of the test/build command — you may stub *that one call* to a no-op, assert the surrounding logic, then restore it. You are not faking behavior; you are preventing the harness from terminating mid-assertion.
2. **Cross-project fan-out that needs infrastructure you can't run locally.** Some routes fan out to *other* @omega.js/backend backends (parent → child brand servers). Only **one** @omega.js/backend emulator runs locally, so the real cross-project call has no second backend to hit. A unit test may hand-roll the minimal inputs (`makeManager`/`makeAdminMock`/mocked `wonderful-fetch`) to exercise the *fan-out logic* in isolation — but a companion integration test MUST still verify the real route's gate/wiring against the emulator. (Example: `test/helpers/webhook-forward.test.js`.)

**Rules for both exceptions:** stub the narrowest seam (one method / one module), restore it immediately, and add a comment stating *why the real thing can't run here*. If you can run it for real, you must.

## Test coverage — every surface gets a test (HARD RULE)

A feature is not done when it works — it's done when every surface it exposes is covered:

| Coverage | Where | Proves |
|---|---|---|
| **Logic** | `test/routes/` / `test/events/` | The handler does the right thing, exercised against the real emulator (real `omega`, `ctx`, Firestore) |
| **Wiring** | Route round-trips over `http.as(...)` | The route is registered, auth-gated, schema-validated, and answers correctly over the real HTTP surface — this IS @omega.js/backend's end-to-end |
| **Rules** | `test/rules/` suites | Firestore AND Realtime Database security rules permit/deny exactly as intended (required whenever rules change) |

@omega.js/backend has no UI layer: a feature's UI coverage lives in the consuming frontend (web, extension, desktop), which has its own mirrored coverage convention. External-API paths are covered for real via [Extended Mode](#extended-mode-test_extended_mode), never mocked.

**Skipping a surface is the exception, not the default.** Skip ONLY when the feature genuinely doesn't expose that surface (a pure helper has no route; a route that touches no Firestore docs needs no rules test). Convenience is never a reason: "the handler test already covers it" does NOT excuse the route round-trip — handler tests prove the logic, round-trips prove the wiring (a route can be unregistered or mis-gated while every handler test stays green). When in doubt, write the test.

## Running Tests

**Where to run:** `npx omega test` runs from a **Firebase project directory** — a consumer project's root or its `functions/` dir (the runner resolves the project from `cwd`, stripping a trailing `/functions`). A single `npx omega test` **auto-launches the emulator** (Option 2 below) — you don't need to start one first.

```bash
# Option 1: Two terminals
npx omega emulator  # Terminal 1 - keeps emulator running
npx omega test      # Terminal 2 - runs tests

# Option 2: Single command (auto-starts emulator) — the usual way
npx omega test
```

### Self-test from the framework repo (bundled fixture)

`npx omega test` run **from the @omega.js/backend repo itself** is a framework self-test: the repo has no `firebase.json`, so the runner boots a **bundled fixture project** ([`src/test/fixtures/firebase-project/`](../../packages/backend/src/test/fixtures/firebase-project)) and runs ONLY the `test/boot/` smoke (emulator boots → the fixture's `initialize()` wires `omega_api` → health returns 200). Mirrors the extension's `OMEGA_TEST_BOOT_PROJECT` and web's site-boot layer. Set `OMEGA_TEST_BOOT_PROJECT=<path>` to self-test against a real consumer instead. The full `routes`/`events`/`rules` suites need a real consumer (use the designated test consumer, [`brands/playground-omega/targets/backend`](../../brands/playground-omega/targets/backend)); the `boot/` smoke is excluded from consumer runs. **Full reference: [test-boot-layer.md](test-boot-layer.md).**

### The runner

The verb stages the target, boots or adopts the emulator, then starts ONE child, [src/test/run-tests.js](../../packages/backend/src/test/run-tests.js), inside the emulator's environment (the run's config rides `OMEGA_TEST_CONFIG`). The child boots firebase-admin and the real instance as a runner host, `initialize({ runnerHost: true })` (no Firebase init, function wiring, server or Sentry), then runs devkit's one case runner (`createRunner`, [devkit/index.md](../devkit/index.md#the-case-runner)) as framework `backend`: every suite of both roots in that one process, on the backend's one layer, `emulator`.

A suite file loads right before its cases run, and its suite `cleanup` runs before the next file loads, so a mock a file installs at load (a module swapped into `require.cache`) and restores in `cleanup` never reaches another file.

- One process means no `fileTimeout`: that limit is for `isolation: 'process'` runs ([testing.md](../shared/testing.md#mirrored-suite-shape)).
- A suite's `setup` and `cleanup` and each `ctx.after` function still run under the limit a case has (the suite's `timeout`, else 30s), and a suite `cleanup` past it fails the run.

The `emulator` layer's driver ([src/test/emulator-driver.js](../../packages/backend/src/test/emulator-driver.js)) runs the pre-flight once per run, up front, before any `test/_init.js` setup and the first case: the install check, the config check, the hosting health check, the project-mismatch check (the health endpoint's `projectId` against this project's, read alone), the persona seed, the rules context, then the connect trap. A pre-flight failure ends the run with one `Pre-flight <step>: …` error line (`Pre-flight health check: …`), the step's own `✗` lines printing above it, and the run exits 1: no case runs, so there is no failure per case. A custom-server backend skips the health check and the seed. Each case then takes its [ctx extras](#context-object) from the driver, its `http` signed in as the case's `auth`, else its suite's, else `none`.

The flags ride to the child: `--filter=<text>` keeps a case whose name contains the text, or every case of a suite whose description contains it (for a suite with no description, its path relative to its test root, `routes/notes.test.js`); `--layer=emulator` names the one row; `--lane=<name>` opens an [opt-in lane](#opt-in-lanes---lane); `--extended` sets `TEST_EXTENDED_MODE`; `--reporter=json` makes the runner's report one JSON document (the run's result: counts and one entry per case) in place of the pretty output, and that document is the verb's whole stdout: every other line (the verb's own, the target checks', the emulator boot's, a boot prelude's note) goes to stderr. One exception: on a linked brand with a stale framework dist, the local freshness guard prints its rebuild lines on stdout first ([#1092](https://github.com/Omega-JS-Stack/omega/issues/1092)). The pretty output is a heading per suite, one line per case, then ONE Results block: passing, failing, skipped, and the total.

A run-level error that is not a pre-flight failure prints its stack and exits 1; a pre-flight failure ends with its one `Pre-flight <step>: …` error line and no stack, the step's own `✗` lines above it, and no case runs. A case that calls `process.exit()` mid-run fails the run: the child exits non-zero and stderr says `The test run ended before its report was written`, the same guard devkit's own cli has ([devkit/index.md](../devkit/index.md#the-case-runner)).

### Filtering tests

Pass a path (relative to `test/`) as a positional argument to run specific tests:

```bash
# Run every suite whose path contains email/transactional
npx omega test email/transactional

# Run all tests in a directory
npx omega test routes/marketing

# Run only @omega.js/backend framework tests (from node_modules/@omega.js/backend/test/)
npx omega test backend:email/templates

# Run only consumer project tests (from the project's own test/)
npx omega test project:routes/custom

# OMEGA_DEBUG=1 emits debug-level lines (full records, raw payloads) when diagnosing
# Combine with extended mode for tests that hit real APIs (--extended sets the shared TEST_EXTENDED_MODE)
npx omega test --extended routes/marketing/push-send
```

A path target selects every suite whose path, relative to its `test/` root, CONTAINS the text (devkit's shared rule, [devkit/index.md](../devkit/index.md#the-case-runner)), so `payments` selects `routes/payments/...` and `helpers/payments-meta...` alike: type a longer path to narrow. `backend:` and `project:` prefixes scope the filter to framework-only or project-only tests respectively. Without a prefix, only the project's tests are searched; `full:` searches both.

A target that names a path and matches NO file is a hard error: the run prints `No test file matches "<target>"` and exits 1 (before the config/health preflight, so a typo costs a second rather than a whole stack), so a typo'd path, or a suite renamed out from under a target, can never run silently green ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)). A run that named no file (bare, or a bare source prefix) still exits 0 when there is nothing to run. Inside a brand-root fan-out the manager sets `OMEGA_TEST_FANOUT=1` on every forwarded run, and the same miss answers with exit 3 instead: a path another target carries is a no-op here, and the brand run fails only when EVERY target missed ([docs/shared/testing.md](../shared/testing.md#brand-root-cp94b)).

## Project mismatch detection

The runner adopts an already-running emulator only when that emulator **proves** it belongs to this project. "Something is listening on the functions port" is not proof — reading it as one adopted another brand's stack on the classic ports and died on a health fetch against the wrong project ([#258](https://github.com/Omega-JS-Stack/omega/issues/258)).

Identity comes from firebase-tools' own **locator file**, not from the hub's HTTP API. A running hub writes `${os.tmpdir()}/hub-<projectId>.json` (`{version, origins, pid}`) for the life of the stack, and the file NAME is the project id. A locator counts only when it claims this hub port (matched against its `origins`) **and** its `pid` is still alive — firebase-tools does not always remove the file, so a crashed run's leftover would otherwise name a hub that is long gone. Two live claims on one port mean one file is stale with a recycled pid, and nothing says which: ambiguous reads as unproven.

The decision (`decideEmulatorAdoption` in [src/cli/commands/test.js](../../packages/backend/src/cli/commands/test.js)):

| Evidence | Outcome |
|---|---|
| This project's own live `.temp/ports.json` publishes that functions port | adopt (`ports-file`) |
| Locator project id **is** this project's | adopt (`project-match`) |
| Locator project id is **another** project's | `project-mismatch` |
| No locator, dead pid, or two live claims | `unidentified` |

Nothing in the CLI's adoption decision aborts. An unadopted port means the run boots **its own** emulator on free ports (the N7 bump path), relocating around the incumbent exactly as a second brand's boot does. (Separately, the test runner's own project-mismatch check reads the health endpoint's `projectId` alone, and aborts a run pointed at the wrong project with "Stop the other emulator first".)
```
  Port 5001 belongs to project "project-a", not "project-b" — booting this project's own emulator on free ports.
  Port 5001 is in use by a listener that does not identify itself — booting this project's own emulator on free ports.
```

## The stack the runner child resolves

The runner loads route handlers **in-process** (journey suites call them directly), so its `omega` builds URLs from `OMEGA_*_PORT` exactly like a function worker does. The test command therefore hands the child the **resolved** port map (bumped ports and all) minus the `https` front: the runner carries no mkcert CA and talks plain http to the stack, hosting's internal port included.

Unset, those getters fell back to the classic defaults, and `omega emulator` puts the mkcert TLS proxy on classic 5002. The test provider's auto-webhook (`omega.getApiUrl()` in `routes/payments/intent/providers/test.js`) followed the proxy's plain-http 307 to https and died on the untrusted cert: every declined-winback and reactivation journey failed against a two-terminal HTTPS emulator while passing when `omega test` booted its own ([#291](https://github.com/Omega-JS-Stack/omega/issues/291)).

## Cross-project API calls (single-emulator limitation)

Some routes fan out to **other @omega.js/backend backends** — e.g. a sponsorship submission on `itw-creative-works` publishes a guest post to `ultimate-jekyll`'s `POST /admin/post`. Only **one** Firebase emulator can run locally at a time, so these cross-project calls **always hit the live deployed target**, even in test/dev mode.

This means:
- The target backend must be **deployed** with up-to-date code for extended tests to pass.
- Normal (non-extended) test mode **gates these calls** via `ctx.isTesting() && !process.env.TEST_EXTENDED_MODE` checks, returning synthetic results. Extended mode makes the real call.
- You **cannot** test cross-project API calls against a local emulator. If the live target is down or has a bug, extended tests that depend on it will fail.

## Test Data Cleanup — at the START of every run

**Hard rule: all LOCAL cleanup happens BEFORE the suite runs, never after.** If a previous run was killed mid-execution (Ctrl-C, OOM, emulator crash), end-of-run cleanup would never fire and the next run would inherit polluted state — broken trial-eligibility checks, leftover dispute alerts, stale webhook docs, polluted marketing-provider lists. Pre-test cleanup makes every run idempotent regardless of how the last one died.

What the runner wipes pre-test (in [src/test/test-accounts.js](../../packages/backend/src/test/test-accounts.js) `deleteTestUsers()` and [src/test/seed.js](../../packages/backend/src/test/seed.js) `seed()`, which the `emulator` driver's pre-flight calls):

1. **`meta/stats`** doc ensured (required for on-create batch writes).
2. **The ENTIRE emulator Firestore** — every top-level collection, flushed recursively (`flushEmulatorFirestore()` → `listCollections()` + `recursiveDelete()`). The emulator DB is 100% test data, so a full flush is the simplest correct clean slate — no per-collection allowlist to maintain. **SAFETY: it only runs when `FIRESTORE_EMULATOR_HOST` is set** (which the test command always sets); if absent it is a no-op, so it can never wipe a real project.
3. **Firebase Auth test users** — the emulator's auth store cleared in bulk (Auth is a separate store from Firestore, so this still runs explicitly). The bulk-clear URL names a **project**, and the emulator answers `200` for a project it has never heard of, so the id is resolved from the admin app this process reads and writes through (`resolveWipeProjectId()`), never defaulted: a `GCLOUD_PROJECT` that disagrees with it aborts the wipe, and so does having no id at all. The runner's child env carries `GCLOUD_PROJECT` from the same config the emulator booted with — without it the wipe cleared an empty `demo-test` store and reported the personas deleted while every import-only account survived ([#292](https://github.com/Omega-JS-Stack/omega/issues/292)).
4. **Realtime Database** — the `_test` namespace removed in full (`admin.database().ref('_test').remove()`, guarded — RTDB is optional).

After the flush, `test/_init.js`'s `setup()` reseeds fixtures into the empty DB.

### Personas (N6)

Every seeded account is a **persona** usable two ways: backend tests authenticate with its `api.privateKey` (`http.as('<id>')`), and a HUMAN or browser flow signs in with its email + the deterministic **`TEST_ACCOUNT_PASSWORD`** (`'omega-test-password'`, exported from [src/test/test-accounts.js](../../packages/backend/src/test/test-accounts.js)) — boot the emulators, open an emulator-connected dev site, sign in as any persona. **`npx omega emulator` seeds personas automatically on boot** (`--no-seed` to skip; non-fatal on failure), via the same shared seed module the test runner uses ([src/test/seed.js](../../packages/backend/src/test/seed.js) — wipe → meta/stats → create accounts → order fixtures → fetch keys → `test/_init.js` hooks). The seed creates personas four at a time (`SEED_CONCURRENCY`, through devkit's `mapLimited`): the functions emulator spawns one runtime worker per in-flight auth trigger and never caps the pool, so a wider burst runs a CI runner out of memory. A persona whose `auth:on-create` never completes within its three attempts aborts the whole seed with `auth:on-create never completed for <email>`, since a backend whose functions never loaded would otherwise seed "successfully"; under the test runner that is the `Pre-flight accounts:` line, under `npx omega emulator` a warning. The test runner re-seeds at the start of every run regardless, so a long-running emulator always starts each test run from the same clean slate. Lifecycle states are first-class personas: `basic` (free), `premium-active` (paid), `premium-trialing` (mid-trial — active on the paid plan, nothing charged, its term ending exactly when the catalog's trial does), `premium-cancelling`, `premium-expired`/`refunded` (cancelled; `refunded` is the post-refund-webhook end state on the `test` provider), `premium-suspended`, `delete`/`delete-by-admin`. `usage-spread` is the one persona that deliberately carries a SPREAD rather than a single state ([#647](https://github.com/Omega-JS-Stack/omega/issues/647), Ian's call): a usage card is only worth previewing beside its neighbours, so it holds one state per COUNTED feature the brand's own catalog defines — untouched, half spent, day cap hit, month cap hit, override credits — and each feature still tells exactly one story. The spread is resolved against the brand catalog like every other seed, never hand-typed (`resolveSeededUsage`), so a brand with fewer counted features simply seeds fewer cards. "Unauthed" needs no persona — that's `http.as('none')` or a signed-out browser. Payment flows get their own dedicated personas so the shared lifecycle ones stay clean (see [Test Account Isolation](#test-account-isolation-critical)): alongside the existing `journey-payments-*` set, `journey-payments-decline` (a first checkout that declines, seeded basic + active), `journey-payments-one-time-refund` (a one-time purchase bought then refunded), `journey-payments-abandoned` (opens a checkout and never finishes it — the persona exists to prove nothing is written), `journey-payments-dispute` (buys, then gets charged back), and `refund-no-order` (a paid subscriber pending cancellation whose subscription carries no `payment.orderId`, so the refund provider has to resolve the product from the subscription itself). For automated browser signin, mint a custom token for the persona's uid (admin SDK or `POST /user/token` as admin) and use the site's `?authCustomToken=` param / the client's `signInWithCustomToken`.

**A persona that holds a paid plan is one that BOUGHT it** ([#263](https://github.com/Omega-JS-Stack/omega/issues/263)). Its seed is resolved against the brand catalog, never hand-typed: `subscription.payment` carries the price and cadence `config.payment.products[].prices` lists for that plan (the same read the unified transforms make), a live term expires at the end of the billing cycle it is on rather than a decade out, and a seed naming `payment.orderId` gets the matching `payments-orders` document stood up at seed time — the fixture the test cancel provider reads the plan off, the test webhook library rebuilds a provider subscription from, and the per-owner trial-eligibility query counts. One definition builds it everywhere (`buildOrderFixture`/`seedOrderFixture` in [src/test/test-accounts.js](../../packages/backend/src/test/test-accounts.js)): the boot seed, the flows lane, and the per-persona dev reset (`POST /test/reset-account`) all write the same record — and a project's own `test/_init.js` personas are seeded on the same terms, so a consumer persona naming an `orderId` gets its order too. A persona that bought nothing (`basic`, `journey-flows-trial`, the signup/consent set) stays deliberately hollow — any subscription order in its name would disqualify it from the trial its journey exists to prove.

### Marketing-provider cleanup

Test signups never reach SendGrid + Beehiiv. The validation pipeline (`src/omega/libraries/email/validation.js`) blocks all `_test.*` emails at the marketing-library layer via the `/^_test\.(?!allow_)/` pattern in `blocked-local-patterns.js`.

The single exception is the `_test.allow_*` prefix. Two long-lived test accounts (`_test.allow_consent-granted@...` and `_test.allow_consent-declined@...`) intentionally round-trip through SendGrid + Beehiiv as the live-provider integration sentinels. They are exercised by `test/marketing/consent-lifecycle.js`, which manages its own setup, assertions, and teardown.

All cleanup follows the start-only rule. No trailing-cleanup exception.

### When adding a new test that writes data

Nothing to register — the **entire emulator Firestore is flushed before every run**, so any collection a test writes starts empty next run automatically. If a test needs a fixture to exist (e.g. a brand doc) before the suite runs, seed it in `test/_init.js`'s `setup()` (it runs after the flush). Realtime Database test data should live under `_test/...` (that namespace is wiped pre-run).

### Within-run state isolation is different

Per-test cleanup is still appropriate when a test sets up DB state that would pollute a **later test in the same run** — e.g. a `try/finally` that removes a fixture so the next sibling test sees a clean slate. Those stay in the test. They are *intra-run* state management, not *next-run* cleanup, and the distinction matters.

The rule: **never put cleanup at the END of a test file or suite for the purpose of preparing the next run** — for LOCAL state. The pre-test full flush already guarantees a clean slate. (The third-party provider exception lives in the runner's post-suite hook, not in individual tests.)

## `test/_init.js` — pre-test lifecycle hook

The runner loads an optional `test/_init.js` from **both** test roots (@omega.js/backend core, `<backend>/test/_init.js`, and the consumer project, `<projectDir>/test/_init.js`) through devkit's one loader (`@omega.js/devkit/test/init-hooks`), and runs it before any case (it is NOT itself run as a test). Same contract for both roots, and the same one desktop, extension and web read, so framework and consumer authors write the identical file. Because the entire emulator Firestore is flushed each run, there are **no collection lists to declare**: `_init.js` only declares accounts and reseeds fixtures.

The module **must export a factory**, `module.exports = ({ projectRoot, config, omega, ctx }) => ({ accounts?, setup?(ctx) })`, called once with the project root, the resolved config, the real instance and a real `Context` on it, and returning the hook object. (The factory form lets a project compute its accounts/fixtures from config. Under `npx omega test` it receives all four; the emulator verb's boot seed passes `config` alone, and the dev palette's roster `config` and `omega`.) It may declare:

- `accounts` — array of extra test accounts to create alongside the built-in ones (admin/basic/premium-*/journey-*), so this project has a user for each lifecycle it exercises. Each entry is `{ id, uid, email, palette, properties }` (email may use the `{domain}` placeholder, which resolves to the brand's HOST — `brand.url`'s hostname, the one derivation the dev palette signs in on; `properties` is merged into the user doc after `auth:on-create`). These accounts are created, fetched (privateKeys), and deleted on the same path as the built-ins, and show up in the `accounts` map that tests and `setup()` receive. A project account may override a built-in one by reusing its `id`. A `palette: '<Label>'` label offers the persona in the dev palette's account switcher, exactly like a built-in one — `GET /test/roster` reads both halves of the seed ([#712](https://github.com/Omega-JS-Stack/omega/issues/712)); an account without a label is machinery and stays off the palette's roster. The functions process reads the file once and remembers what it got — a CHANGED persona has to be re-seeded to exist at all, which is an emulator restart — but a read that FAILED is never remembered ([#733](https://github.com/Omega-JS-Stack/omega/issues/733)): a broken `_init.js` logs its error, serves an empty project half, and is re-read (module cache and all) on the next roster request, so fixing the file is enough.
- `async setup({ projectRoot, admin, config, accounts, omega, ctx })`: seed fixtures (e.g. a brand doc) into the freshly-flushed DB, AFTER the clean slate + account creation. `accounts` is available so fixtures can reference a test uid. Use real ids that mirror production shape (no `_test-` prefix needed: the whole DB is wiped each run). Each root's `setup` runs once, framework root first. The context it receives is built once per run, before the first setup, whether or not any `_init.js` has a `setup`: that build is the [pre-flight](#the-runner) (health check, seed), so it runs once up front, and a failed pre-flight is one error line, not one failure per case. On a custom-server backend nothing is seeded and `setup` runs with `accounts: null`, so a setup that reads accounts guards on `null`.

**A broken hook fails the run.** A file that throws on load, exports anything but a function, whose factory throws or returns a non-object, or whose `setup` throws, stops the run before any case: one failing entry names the file and carries the cause, and the run exits 1. The roster above is the one reader that serves an empty project half instead.

An account without a `palette` label stays out of the palette's roster, but a suite can still reach it: `GET /test/roster?machinery=true` on a backend running as `testing` (every emulator run) offers every seeded account, which is how each sign-in lane finds its own persona ([docs/shared/testing.md](../shared/testing.md), [#904](https://github.com/Omega-JS-Stack/omega/issues/904)).

There is **no `cleanup` hook**: the entire emulator Firestore is flushed before every run and each test cleans up after itself, so there is nothing project-level to tear down.

```javascript
// <projectDir>/test/_init.js
module.exports = ({ config }) => ({
  // One account per lifecycle this project needs. Created alongside the built-ins.
  accounts: [
    { id: 'shop-owner', uid: '_test-shop-owner', email: '_test.shop-owner@{domain}', properties: { roles: {} } },
  ],

  // The entire emulator Firestore is flushed before each run, so just reseed.
  async setup({ admin, accounts }) {
    await admin.firestore().doc('brands/ultimate-jekyll').set({
      id: 'ultimate-jekyll',
      brand: { id: 'ultimate-jekyll', name: 'Ultimate Jekyll', url: 'https://ultimate-jekyll.itwcreativeworks.com' },
      owner: accounts['shop-owner'].uid,
      sponsorships: { prices: { 'guest-post': 50, 'link-insertion': 30 } },
    });
  },
});
```

## Extended Mode (`TEST_EXTENDED_MODE`)

`TEST_EXTENDED_MODE` is the **shared, unprefixed** extended-mode switch standardized across all four frameworks. It opts **in** to REAL external services (default: skipped). The CLI shorthand `--extended` sets it for you, so `npx omega test --extended` is equivalent to `TEST_EXTENDED_MODE=true npx omega test`. Either form works; the flag is just sugar over the env var.

Several routes/handlers skip external API calls (Beehiiv, Stripe webhooks, dispute handlers, marketing libraries) when `process.env.TEST_EXTENDED_MODE` is unset, so unit tests don't fire real webhook side effects. Transactional email is the one that no longer SKIPS: it is built, rendered and [captured](#testing-mode-email-capture--how-a-test-reads-what-was-sent) instead of delivered, which is what makes an email assertable offline ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)). Set the flag (or pass `--extended`) to opt **in** to real delivery and the rest of those side effects for a full end-to-end run.

**@omega.js/backend propagates the mode to BOTH spawned environments — the distinctive @omega.js/backend detail.** The mode reaches (1) the **test-runner subprocess** (spawned with `{ ...process.env }`, so `TEST_EXTENDED_MODE` carries through) AND (2) the **running emulator's function workers** (via the `.temp/test-mode.json` shared state file written pre-flight by `src/test/utils/test-mode-file.js`, allowlisted in `SYNCED_ENV_KEYS`). That's why a single `--extended` on the test command flips both the runner's in-source gates and the live emulator without restarting it.

The marketing library gates at the SSOT level: `Marketing.add()`, `Marketing.sync()`, and `Marketing.remove()` each short-circuit with `if (ctx.isTesting() && !process.env.TEST_EXTENDED_MODE) return {}` before touching any provider. Callers (auth `onDelete`, webhook providers, contact-delete route) inherit the gate for free — do NOT rely on a per-caller guard for provider safety; add the gate to the library method itself when introducing a new provider-touching method.

**Live sync — no env coordination across terminals.** The flag flows automatically from the test command to the running emulator via a small shared state file at `<projectRoot>/.temp/test-mode.json`. The test command writes the file pre-flight; the emulator's function workers watch it via `fs.watch` and mutate their own `process.env.TEST_EXTENDED_MODE` in place. Effect: you only need to set the flag on **the test command**. The emulator follows.

```bash
# Terminal 1 — start once, leave running. NO flag needed.
npx omega emulator

# Terminal 2 — toggle freely between runs:
npx omega test --extended ...                 # runs in extended mode (--extended sets TEST_EXTENDED_MODE)
TEST_EXTENDED_MODE=true npx omega test ...    # identical — the env-var form
npx omega test ...                            # runs in normal mode
npx omega test --extended ...                 # back to extended
```

The emulator log shows each flip, e.g.:

```
[test-mode] resolved TEST_EXTENDED_MODE=false (file present)   ← worker boot
[test-mode] flip TEST_EXTENDED_MODE: (unset) → true            ← test --extended fired
[test-mode] flip TEST_EXTENDED_MODE: true → (unset)            ← test (no flag) fired
```

The test command also confirms the mode in its own output (`Test mode: extended (real external APIs)` pre-flight, `Mode: extended (real external APIs)` after the health check) and, when extended, prints the shared extended-mode headline (`⚠️ WARNING: TEST_EXTENDED_MODE IS TRUE ⚠️`) with backend's own detail lines under it (real emails, real external API calls). The runner's old "TEST_EXTENDED_MODE mismatch" warning is gone — mismatch is impossible by construction.

**Allowlist.** Only env vars listed in `SYNCED_ENV_KEYS` (`src/test/utils/test-mode-file.js`) flow through. Today: `TEST_EXTENDED_MODE`. Add a key there to make a new env var live-syncable across terminals. The allowlist exists to prevent accidentally syncing process-specific vars (`FIRESTORE_EMULATOR_HOST`) or sensitive ones (API keys).

**Preferred flow: set the flag on the test command.** Every `npx omega test` invocation overwrites the shared state file with whatever flags it was called with, and the emulator follows live. This is the recommended pattern — start the emulator once with no flag, leave it running, control the mode from your test invocations.

```bash
# Recommended
npx omega emulator                                # boots in normal mode
npx omega test --extended ...                      # flips emulator to extended (or: TEST_EXTENDED_MODE=true npx omega test ...)
npx omega test ...                                 # flips emulator back to normal
```

**Also supported: set the flag on the emulator command.** This still works as a boot default — the emulator command writes the file with whatever it was started with, so the very first test run (before any `npx omega test` overrides it) sees that mode. Useful if you want to inspect the emulator in a particular mode before firing any tests, or if you script the emulator boot from CI. Just know that the next test command overrides whatever you set here.

```bash
# Also works (boot default — overridden by next test command)
TEST_EXTENDED_MODE=true npx omega emulator        # boots in extended mode
npx omega test ...                                 # ← this still flips it back to normal
```

## Testing-mode email capture — how a test reads what was sent

Extended mode's counterpart: **outside** extended mode, `Transactional.send()` does not call SendGrid at all — it RECORDS the email it built and returns `{ status: 'captured' }` ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)). The seam sits past `build()`, so the brand, the recipients, the template data and the MJML render are the real ones: a template that throws fails a test instead of reaching production. No caller gates itself on `ctx.isTesting()` around a send any more; the seam decides for all of them.

The store is `<projectDir>/.temp/test-emails.jsonl`, one JSON record per line, beside `test-mode.json` and resolved the same way (the parent of `omega.cwd`, which is `<projectDir>/dist` in both processes: the test runner boots there, and so do the emulator's function workers, since `dist` is the source directory `firebase.json` names), so the workers and the runner write and read the ONE store. Full rationale: the module header on [src/test/utils/email-capture.js](../../packages/backend/src/test/utils/email-capture.js), and [email-system.md](email-system.md#testing) § Testing.

```javascript
const capture = require('../../dist/test/utils/email-capture.js');

// Clear BEFORE the act, so what you read back is your own
capture.clearCaptured(omega);

await http.as('signup-emails').post('omega/user/signup', {});

const sent = capture.readCaptured(omega);
// [{ to: ['a@b.dev'], template: 'card', subject: 'Welcome to …!', summary: '…', sendAt: null }]
```

| Field | What it is |
|---|---|
| `to` | Every recipient address the built email carried, in order |
| `template` | The template that rendered it, after the legacy-name shim |
| `subject` | The subject line |
| `summary` | The rendered body reduced to visible text (tags stripped, entities decoded, whitespace collapsed, capped) — where a test finds the product name, the totals, the greeting |
| `sendAt` | The scheduled UNIX second, or `null` for an immediate send |

Two things the capture is NOT. A send scheduled past `SEND_AT_LIMIT` (71 hours) never reaches the seam — it goes to the `emails-queue` collection, and a test asserts it there. And extended mode is untouched: `--extended` still delivers real mail, so nothing about the capture lane changes what the extended suites do.

A handler that dispatches its send fire-and-forget (the payment transitions) needs a poll rather than a look — see [test/events/payments/transition-order-emails.test.js](../../packages/backend/test/events/payments/transition-order-emails.test.js).

## Log Files

The verb tees its whole run to `logs/test.log` at the target root: its setup lines, the port summary, the emulator boot, and the runner child's output, which flows through the verb's own streams. That is the one test log; the child writes none of its own. An emulator the run starts also keeps its own `dist/emulator.log`. Full reference (file table, the `dist/` location exception, `production.log`): [logging.md](logging.md).

## Filtering Tests

```bash
npx omega test rules/             # Run the project's rules tests (bare paths are project-only)
npx omega test full:rules/        # Run rules tests from both sources
npx omega test backend:rules/         # Only @omega.js/backend's rules tests
npx omega test project:rules/     # Only project's rules tests
npx omega test user/ admin/       # Multiple paths
```

## Opt-in lanes (`--lane=`)

A LANE is a suite that needs something the default run must never depend on: credentials, the network, an external CLI. It is off by default and stays off — `npx omega test --lane=<name>` is the only way in, and a lane that cannot satisfy its gate prints **one line** saying which condition failed and exits clean. A skipped lane is a normal outcome, not a failure.

Lanes are unreachable by anything else. `test/<lane>/` is excluded from discovery unless that lane's gate opened it (the lane list's one home is `declaredLanes()` in `src/utils/test-lanes.js`, read from the package's `omega.testLanes` and handed to the runner as its `lanes`), so no default run, no CI lane and no path filter can pull one in.

**How a lane differs from `--extended`:** extended mode is a *mode* — it lets the SAME suites make real calls. A lane is a *set of suites* that exist only for the real thing, plus the gate deciding whether they may run at all.

### `--lane=stripe-live`

Runs the payment pipeline against REAL Stripe test-mode events: real objects in a test account, real deliveries, forwarded into the local emulator by `stripe listen`.

The gate, in order — any failure is one skip line:

1. A Stripe secret resolves through the ONE env reader (`src/omega/libraries/env.js`). A test lane composes its `.env` from the base plus `.env.testing` ([#586](https://github.com/Omega-JS-Stack/omega/issues/586)), so the TEST credential goes in that overlay under the plain `STRIPE_SECRET_KEY` name.
2. That secret is **test-shaped** (`sk_test_`). Nothing upstream vets the value — the env reader hands back whatever the resolved cascade holds — so this gate is the ONLY thing standing between the lane and a live account, and it refuses everything that is not an `sk_test_`: a live key, a restricted key, a publishable key, a paste of the wrong line.
3. The **Stripe CLI** is installed, because the forwarding and the event triggers are its job.

```bash
# In a brand's backend target, with STRIPE_SECRET_KEY="sk_test_…" in .env.testing:
npx omega test --lane=stripe-live
```

What the lane does on the way in: creates the Stripe products and prices the brand's catalogue needs, **idempotently** and tagged `metadata.omega_lane`, so a rerun reuses the first run's objects. The fixtures match on interval + amount because that is all `resolvePriceId()` matches on — a config that has drifted from the account fails here rather than at a customer's checkout. Then it starts `stripe listen --forward-to <hosting>/omega/payments/webhook?provider=stripe&key=<OMEGA_WEBHOOK_KEY>` and waits for the CLI's own ready line before firing anything, so no trigger can land before the tunnel exists.

**Nothing prints a secret.** The gate's refusals name the KEY and the fix; the CLI's ready line carries a signing secret nothing here reads, and it is held back from the forwarder's own output.

The gate and the fixture plan are pure functions with their own offline suite (`test/cli/stripe-live-lane.test.js`), so the safety property is proven on every normal run without an account, a CLI, or the network.

## Test Locations

- **@omega.js/backend core tests:** `test/` (in the framework repo)
- **Project tests:** the consumer project's repo-root `test/` directory (NOT inside `functions/`)

Use `backend:` or `project:` prefix to filter by source. **Mirror the source path so a test reads like what it tests.** Route tests live under `test/routes/<route-path>/<concern>.test.js`, mirroring `src/routes/<route-path>/` — e.g. `src/routes/write/article/` → `test/routes/write/article/generate.test.js`, `src/routes/sponsorship/post.js` → `test/routes/sponsorship/post.test.js`. Split each route into **one file per concern** under its mirrored dir (`test/routes/sponsorship/post.test.js`, `.../manual-validation.test.js`), never one giant `test/test.js`. The runner discovers files by directory, so the split also drives the `project:<path>` filter: `npx omega test project:routes/write` runs a whole route's tests, `project:routes/write/markdown` runs one concern.

**The `.test.js` suffix IS discovery:** the runner only picks up files ending in `.test.js` (the mirrored suite shape shared by every OMEGA package — monorepo `docs/shared/testing.md`). A `.js` file under `test/` without the suffix is support code, never a test, and never runs.

**The underscore convention:** `_`-prefixed files and directories at any depth under `test/` are excluded from suite discovery. Put shared helpers, fixture data, and non-test support files in `_`-prefixed paths, e.g. `test/_fixtures/`, `test/_helpers/`, `test/routes/_shared-utils.js`. The runner still specifically loads `test/_init.js` as the lifecycle hook. Matches the same convention in desktop, extension and web.

## Test Types

> **The runner reads each file's `module.exports` spec; it does NOT inject Mocha/Jest globals.** A test file that calls `describe`/`it`/`before`/`beforeEach`/`after` at top level throws `ReferenceError: beforeEach is not defined` on load, and a discovered `.test.js` file that exports no `defineCases` spec fails the run naming the file. There is no global `assert` or `expect` either: use the `expect` passed into `run({ expect })`. Every test file MUST export one of the shapes below.
>
> **The lifecycle hooks are devkit's:** `cleanup` (per case and per suite), a suite-level `setup(ctx)` that runs once before the first case, and `ctx.after(fn)` inside a case ([devkit/index.md](../devkit/index.md#the-case-runner)). Exporting `before`/`after`/`beforeEach` properties on the module does NOT error: the runner silently ignores them, so setup they were supposed to do never happens. Seed disk/DB fixtures in a suite `setup`, inside the tests via an idempotent helper, or in `test/_init.js`'s `setup()`.

| Type | Use When | Behavior |
|------|----------|----------|
| Standalone | Single logical test | Runs once |
| Suite (`type: 'suite'`) | Sequential dependent tests | Shared state; stops on failure (every later case skips with reason `suite stopped`), and a `ctx.skip(reason)` skips every later case with the same reason |
| Group (`type: 'group'`) | Multiple independent tests | Continues on failure |

Every shape exports through `defineCases`. A consumer's case file takes it from the public test API, `@omega.js/backend/test`, which also exports `expect` for a helper outside a case body (`const { defineCases, expect } = require('@omega.js/backend/test')`); the framework's own suites require the vendored copies by relative path (`dist/vendor/devkit/test/define-cases.js`, `dist/vendor/devkit/test/expect.js`), since they run from a consumer install too ([index.md](index.md#test-framework)).

### Standalone Test

```javascript
const { defineCases } = require('@omega.js/backend/test');

module.exports = defineCases({
  description: 'Test name',
  auth: 'none',  // none, user, admin, premium-active, premium-expired
  timeout: 10000,
  async run({ http, expect, accounts, firestore, state, waitFor }) { },
  async cleanup({ ... }) { },  // Optional
});
```

### Suite (Sequential with Shared State)

```javascript
const { defineCases } = require('@omega.js/backend/test');

module.exports = defineCases({
  description: 'Suite name',
  type: 'suite',
  tests: [
    { name: 'step-1', async run({ state }) { state.value = 'shared'; } },
    { name: 'step-2', async run({ state }) { /* state.value available */ } },
  ],
});
```

### Group (Independent Tests)

```javascript
const { defineCases } = require('@omega.js/backend/test');

module.exports = defineCases({
  description: 'Group name',
  type: 'group',
  tests: [
    { name: 'test-1', auth: 'admin', async run({ http, expect }) { } },
    { name: 'test-2', auth: 'none', async run({ http, expect }) { } },
  ],
});
```

## Context Object

| Property | Description |
|----------|-------------|
| `http` | HTTP client: sends requests to the hosting emulator as-is (see [HTTP Routing](#http-routing)), signed in as the case's `auth` (see [Auth Levels](#auth-levels)) |
| `expect` | devkit's one assertion library: `expect(actual, message?)` with `toBe`, `toEqual`, `toBeTruthy`, `toMatch`, `toContain`, `toHaveProperty`, `toBeTypeOf`, `toBeSuccess`, `toBeError(status?)`, `toThrow`, `.not`, `.rejects` and `expect.fail` (see [Expect Matchers](#expect-matchers); the full set: [devkit/index.md](../devkit/index.md#the-case-runner)) |
| `skip` | `skip(reason)`: ends the case as skipped (in a `type: 'suite'`, every later case too) |
| `after` | `after(fn)`: runs `fn` once the case settles, newest first |
| `accounts` | Test accounts `{ basic, admin, premium-active, ... }` |
| `firestore` | Direct admin DB access (`get`, `set`, `delete`, `exists`) — bypasses security rules |
| `rules` | Firestore **rules** testing client — `rules.asAccount(id)` returns a DB scoped to that user's auth, `rules.expectSuccess(op)` / `rules.expectFailure(op)` assert rule outcomes (see [Rules Tests](#rules-tests)) |
| `state` | Shared state (suites only) |
| `waitFor` | Polling helper `waitFor(condition, timeout, interval)` |
| `config` | Test configuration — `config.apiUrl` is the base URL of the lane THIS run booted (the resolved hosting port, not a literal): a suite that fetches directly instead of through `http` builds its URL from it |
| `omega` | The real booted @omega.js/backend instance (`omega.email`, `omega.utilities`, `omega.firebase.admin`) |
| `ctx` | A real `Context` on that instance, built once by the runner host (`ctx.ai`, `ctx.email`, `ctx.getEnvironment()`) |
| `admin` | The Firebase Admin SDK the runner initialized |
| `pubsub` | `pubsub.trigger(functionName)`: fires a scheduled function on the run's Pub/Sub emulator |
| `payments` | Product metadata resolved once from the brand config (`payments.products[id]`, `payments.stripeProductIds`) |

## HTTP Routing

The `http` client sends requests directly to the hosting emulator (`config.apiUrl` — classically `http://localhost:5002`, but whatever port THIS lane resolved) with no magic prefix. The route string you pass becomes the URL path as-is — the hosting emulator's `firebase.json` rewrites handle routing to the correct Cloud Function.

```javascript
// @omega.js/backend built-in routes — go through omega_api via firebase.json rewrite
http.post('omega/payments/intent', { ... })
http.as('admin').get('omega/admin/stats')
http.as('none').post('omega/marketing/webhook?provider=sendgrid&key=...', [...])

// Consumer project routes — go to their own Cloud Functions via firebase.json rewrites
http.post('projects', { name: 'My Project' })
http.get('sender-accounts', { projectId: 'abc' })
http.as('none').post('webhooks', { event: 'reply', campaignId: '...' })
```

@omega.js/backend routes live under `/omega/*` — always include that prefix. Consumer routes use whatever path is in their `firebase.json` rewrites — no prefix needed.

## Expect Matchers

```javascript
expect(value, message).toBeTruthy()            // Truthy
expect(a, message).toBe(b)                     // Strict equality (Object.is)
expect(a, message).not.toBe(b)                 // Not equal
expect(a, message).toEqual(b)                  // Strict deep equality
expect(value, message).toMatch(/regex/)        // Regex match (or substring)
expect(response, message).toBeSuccess()        // Response success
expect(response, message).toBeError(401)       // Response error, with its status when given
expect(obj, msg).toHaveProperty('path.to.prop') // Property exists (dot path)
expect(obj, msg).toHaveProperty('path', value) // Property value
expect(value, message).toBeTypeOf('string')    // Type check ('array' too)
expect(array, message).toContain(value)        // Array member (or substring)
expect(n, message).toBeGreaterThanOrEqual(min) // Number range: two calls
expect(n, message).toBeLessThanOrEqual(max)
expect.fail(message)                           // Explicit fail
await expect(promise).rejects.toThrow(/x/)     // Rejection
```

A message, when given, prefixes the failure (`<message>: <the matcher's own text>`), and `.not` negates every matcher. The full set (`toBeNull`, `toBeInstanceOf`, `toThrow`'s matcher forms and the rest): [devkit/index.md](../devkit/index.md#the-case-runner).

## Auth Levels

`none`, `user`/`basic`, `admin`, `premium-active`, `premium-expired`, or any seeded account id. A case's own `auth` wins; a suite or group may set `auth` once for every case that names none; with neither, `none`.

## Email Tests (`test/email/`)

All email tests live under `test/email/`, mirroring `src/omega/libraries/email/`. The pipeline was unified under MJML: all templates are rendered server-side (no SendGrid dynamic templates).

| Test file | What it tests | Extended? |
|---|---|---|
| `templates.js` | MJML rendering for card/plain/order/feedback (11 tests) | No |
| `testing-capture.js` | The [testing-mode capture](#testing-mode-email-capture--how-a-test-reads-what-was-sent): the gate, the store, the summary, and the mailer's seam (6 tests) | No |
| `transactional.js` | Transactional email building (output shape assertions) | No |
| `validation.js` | Email format/disposable/corporate/local-part checks (80+ tests) | No |
| `transactional-send.js` | Single transactional send via SendGrid | Yes |
| `campaign-send.js` | Single marketing campaign send | Yes |
| `feedback-and-plain-send.js` | Feedback + plain template visual test sends | Yes |
| `newsletter-templates.js` | Newsletter MJML rendering (16 tests) | No |
| `newsletter-generate.js` | Full AI newsletter generation (5min timeout) | Yes |
| `marketing-lifecycle.js` | Contact lifecycle (add/sync/remove) | Yes |
| `consent-lifecycle.js` | Consent webhook round-trip | Yes |

Extended email tests send to `_test-<purpose>@{domain}` addresses (e.g. `_test-email-send@somiibo.com`). See [docs/backend/email-system.md](email-system.md) for the full email system reference.

## Rules Tests

Security-rules tests run against the **compiled artifact** the emulator booted with (`dist/firestore.rules` — the brand's `firestore.rules` plus the framework half, see [build-system.md](build-system.md)), so they exercise exactly what a consumer deploys.

They use the `rules` client (`src/test/utils/firestore-rules-client.js`). Canonical pattern: **seed as admin (bypasses rules), then test operations as different users**:

```javascript
{
  name: 'setup-docs',
  auth: 'none',
  async run({ rules, accounts }) {
    const adminDb = rules.asAccount('admin');
    await rules.expectSuccess(
      adminDb.doc('items/test-1').set({
        owner: accounts.basic.uid,
        data: { name: 'Test' },
      })
    );
  },
},
{
  name: 'owner-can-read',
  auth: 'none',
  async run({ rules }) {
    const db = rules.asAccount('basic');
    await rules.expectSuccess(db.doc('items/test-1').get());
  },
},
{
  name: 'other-user-cannot-read',
  auth: 'none',
  async run({ rules }) {
    const db = rules.asAccount('basic');
    await rules.expectFailure(db.doc('items/admin-owned').get());
  },
},
```

A suite that needs a DIFFERENT ruleset (proving what a brand's own rules do to
the framework's, for instance) compiles one and loads it into its own emulator
project with `initializeTestEnvironment` — `test/rules/_environment.js` is the
shared plumbing, and `test/rules/brand-merge.test.js` the worked example.

**Realtime Database rules** ride the same emulator through the same library, but
not through the `rules` client, which is Firestore-only. `test/rules/sessions.test.js`
loads `templates/database.rules.json` — the very file `ensureTarget()` ships to a
brand, so there is no copy to drift — into its OWN emulator project, reads the
Database emulator's port off `OMEGA_DATABASE_PORT`, and drives the tree with
`context.database()`. The separate project id matters: the RTDB emulator keys a
namespace by project id, so sharing the fixture's would overwrite the rules the
fixture booted with and `clearDatabase()` would wipe the personas' seeded
sessions.

## Test Account Isolation (CRITICAL)

**NEVER use shared accounts (`basic`, `admin`, `premium-active`, …) with the `test` provider or any operation that creates side-effect data** (orders, webhooks, subscriptions, consent revocations). The test provider auto-fires webhooks that upgrade a user's subscription asynchronously — using `basic` for a payment-intent test upgrades `basic` to a paid subscription and breaks every subsequent test that depends on `basic` being a basic user.

**Rule: any test that creates persistent side-effect data MUST use a dedicated `journey-*` account.**

```javascript
// ❌ WRONG — pollutes the shared 'basic' account
const response = await http.as('basic').post('payments/intent', { provider: 'test', ... });

// ✅ CORRECT — dedicated journey account
const response = await http.as('journey-payments-intent-discount').post('payments/intent', { provider: 'test', ... });
```

**When to create a journey account:** the test uses `provider: 'test'`, creates docs in `payments-orders` / `payments-intents` / `payments-webhooks`, modifies subscription state, sends webhooks that trigger Firestore onWrite handlers, or **writes `consent.marketing` (grant/revoke)** — e.g. marketing webhook revoke events, or `DELETE /marketing/contact` (which mirrors `revoked` to the user doc). Revoked consent persists for the rest of the run and trips the email library's consent gate (`{ blocked: 'consent' }`) on every later `sync()`/`add()` of that account. Existing examples: `journey-webhook-revoke` (webhook revoke events), `journey-marketing-sync` (extended-mode live-provider sync + cleanup; `_test.allow_*` prefix). Add new ones to `src/test/test-accounts.js` (framework tests) or your project's `test/_init.js` `accounts` array (consumer tests).

**Shared accounts are safe for:** validation-only tests (missing fields, invalid input, auth rejection, unknown provider), read-only operations, and tests with no async side effects.

**A FABRICATED payment uid needs an auth user.** A suite that invents a uid instead of using a persona — a shape no persona holds, a doc the pipeline is meant to write itself — must stand the Firebase auth user up itself first, with seeding's own `admin.auth().createUser` shape, password included ([test/routes/payments/intent-purchaser-guard.test.js](../../packages/backend/test/routes/payments/intent-purchaser-guard.test.js)). Both payment seams refuse a uid this project has no Firebase auth user for ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)): the checkout answers 403 and the webhook pipeline completes the event with `refusal.reason: 'user-without-auth'`, writing nothing. A seeded user doc alone is not enough.

## Test Naming Conventions

- **Test names:** kebab-case, descriptive: `'user-can-read-own-doc'`, `'duplicate-submission-rejected'`
- **File names:** match the route method or collection name: `post.js`, `submissions.js`, `signup.js`
- **Descriptions:** present tense, concise: `'Schema validation'`, `'Submission lifecycle'`

## Common Patterns

**Auth rejection** — always test that unauthenticated requests fail:

```javascript
{
  name: 'unauthenticated-rejected',
  async run({ http, expect }) {
    const response = await http.as('none').post('user/signup', {});
    expect(response, 'Should fail without authentication').toBeError(401);
  },
},
```

**Duplicate rejection** — send concurrent identical requests; exactly one should win:

```javascript
{
  name: 'duplicate-rejected',
  timeout: 30000,
  async run({ expect, config }) {
    const body = JSON.stringify({ name: 'Dupe' });
    const [a, b] = await Promise.all([
      fetch(url, { method: 'POST', body }),
      fetch(url, { method: 'POST', body }),
    ]);
    const successes = [a, b].filter(r => r.status === 'success');
    const failures = [a, b].filter(r => r.status === 'fail');
    expect(successes.length === 1 && failures.length === 1, 'One should succeed, one should fail').toBeTruthy();
  },
},
```

**Cleanup** — final suite test deletes what the suite created (see [Test Data Cleanup](#test-data-cleanup--at-the-start-of-every-run) for the start-of-run wipe):

```javascript
{
  name: 'cleanup',
  async run({ firestore, state }) {
    try {
      await firestore.delete(`submissions/${state.id}`);
      await firestore.delete(`forms/${state.formId}`);
    } catch (e) { /* ignore cleanup errors */ }
  },
},
```

## Key Test Files

| File | Purpose |
|------|---------|
| `src/test/run-tests.js` | The runner child: boots the runner host, builds devkit's `createRunner` |
| `src/test/emulator-driver.js` | The `emulator` layer driver: the pre-flight and each case's ctx extras |
| `src/utils/test-lanes.js` | `declaredLanes()`: the opt-in lane list |
| `test/` | @omega.js/backend core tests |
| `src/test/utils/http-client.js` | HTTP client |
| `src/test/utils/firestore-rules-client.js` | Rules testing client (`asAccount` / `expectSuccess` / `expectFailure`) |
| `src/test/utils/email-capture.js` | Testing-mode email capture (`readCaptured` / `clearCaptured`) |
| `src/test/test-accounts.js` | Test account definitions |
| `test/routes/test/schema.test.js` | Schema-validation reference test |
| `test/routes/user/signup.test.js` | Full-lifecycle route suite reference |
| `test/rules/user.test.js` | Rules-test reference |
