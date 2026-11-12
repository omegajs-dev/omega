# Audit Workflow

Full-project audit for @omega.js/desktop — runs against a CONSUMER project or the FRAMEWORK repo itself (scope auto-detected). Invoked via the `omega:desktop` skill (`/omega:desktop audit`) or any "audit this app/project" request.

Every check has a stable ID, a severity, and a scope. Findings are reported as `ID @ file:line`, fixed one at a time, then re-verified. The tables below do NOT restate the rules — each check links to the doc that owns the rule and the fix.

## Protocol

1. **Detect scope** — read `package.json`: `name` is `@omega.js/desktop` → **framework audit** (U + @omega.js/desktop + F checks); `@omega.js/desktop` in (dev)dependencies → **consumer audit** (U + @omega.js/desktop checks).
2. **Run the catalog** — every check matching the scope. Search with Grep/Glob/Read over `src/` (+ `test/`, `config/`, `hooks/`); ALWAYS exclude `dist/`, `release/`, `node_modules/`, `_legacy/`, `_backup/`, `.cache/`. Record each finding as `ID @ file:line` + a one-line description.
3. **Persist the report** — write the findings list to `.temp/audit/claude-audit.md` (create the dir; add `.temp/` to `.gitignore` if missing) so a long fix loop survives session breaks. Summarize counts by severity in chat.
4. **Fix loop** — TodoWrite per finding, highest severity first, ONE at a time: mark in-progress → root cause → fix → verify → complete. Ask before structural or destructive fixes (file deletions, lib restructures, config reshapes).
5. **Re-verify** — re-run every check that produced findings until clean; finish with `npx omega test` (must be green).
6. **Doc parity** — if fixes changed behavior, update README / the framework guide / `docs/desktop/<topic>.md` / CHANGELOG in the same change set.

Severity: **CRIT** security or broken functionality · **HIGH** hard-rule violation · **MED** convention drift · **LOW** optional improvement.
Scope: **C** consumer · **F** framework repo · **B** both.

## Universal checks (U-xx)

Mirrored across all four OMEGA frameworks (UJM / @omega.js/backend / BXM / @omega.js/desktop) — same ID means the same check everywhere.

| ID | Sev | Scope | Check |
|----|-----|-------|-------|
| U-01 | HIGH | B | Every feature has tests at EVERY layer it surfaces (build / main / renderer / boot) — never mocked, real harness only ([test-framework.md](test-framework.md)) |
| U-02 | HIGH | B | Test hygiene — real-external-API tests gated behind `TEST_EXTENDED_MODE` in-source (not mocked); no tests that assert nothing ([test-framework.md](test-framework.md)) |
| U-03 | CRIT | B | XSS: renderer DOM sinks escape untrusted values inline via `omega.utilities.escapeHTML(value)` (+ `sanitizeURL` for URL sinks); zero local escape helpers (rules mirror @omega.js/web and @omega.js/extension `docs/extension/xss-prevention.md`; see also DSK-01 for navigation sinks) |
| U-04 | HIGH | B | @omega.js/client owns Firebase: never `require('firebase')`; renderers use `omega.auth` / `omega.firestore`, main uses `omega.auth` ([common-mistakes.md](common-mistakes.md), [auth.md](auth.md)) |
| U-05 | HIGH | C | Bundled code imports a framework dependency bare (the bundle task's framework-deps hook resolves it); a `hooks/` file either declares the package in the consumer `package.json` or loads it through `desktop.require(name)` after `import desktop from '@omega.js/desktop'` ([common-mistakes.md](common-mistakes.md)) |
| U-06 | HIGH | B | Env behavior gated on the INTENTIONAL check: `isProduction()` or `isDevelopment() \|\| isTesting()`, never `!isDevelopment()`; no ad-hoc `process.env` reads where a helper exists ([environment-detection.md](environment-detection.md)) |
| U-07 | HIGH | B | Config canon — `config/omega.json5` validates against the schema (boot validator green); canonical cross-framework blocks (`brand`, `app`, `cloud.{provider,config}`, `monitoring`, `analytics`, `payment`) not reinvented ([config-schema.md](config-schema.md)) |
| U-08 | CRIT | B | No private credentials committed — signing certs (`config/certs/` gitignored), `.env` secrets, tokens, API secret keys ([signing.md](signing.md)). (The Firebase WEB `apiKey` is public by design — do NOT flag it.) |
| U-09 | HIGH | B | Source discipline — nothing edited in `dist/` or generated files (`dist/electron-builder.yml`, entitlements plist); no live code referencing `_legacy/` / `_backup/` ([build-system.md](build-system.md), [common-mistakes.md](common-mistakes.md)) |
| U-10 | MED | B | Doc parity — README / the framework guide / `docs/` / CHANGELOG match shipped behavior; the docs index lists every `docs/desktop/*.md`; no stale names for renamed commands/patterns |
| U-11 | MED | B | SSOT/DRY — no duplicated constants/config/logic; one authoritative home per value, imported everywhere else |
| U-12 | MED | B | JS conventions — file structure, JSDoc, short-circuit returns, leading logical operators, `fs-jetpack`, one `module.exports` per file (global `js:patterns` skill + [the framework guide](index.md) §File Conventions) |
| U-13 | MED | B | Dead code & stale patterns — no orphaned `src/` files nothing imports; no unused views/components/integrations; inventory TODO/FIXME (report only) |
| U-14 | LOW | B | Dependency health — review `npm outdated` / `npm audit`; apply fixes via the `general:update-packages` workflow (includes supply-chain checks) |

## desktop-specific checks

| ID | Sev | Scope | Check |
|----|-----|-------|-------|
| DSK-01 | CRIT | B | Zero-trust URLs — every DYNAMIC URL is gated through `sanitize-url.js` before `shell.openExternal` / `BrowserWindow.loadURL` / `window.location.href =` (hardcoded internal-scheme URLs bypass) ([the framework guide](index.md) §File Conventions, [common-mistakes.md](common-mistakes.md)) |
| DSK-02 | HIGH | B | Path resolution — `app.getAppPath()` / `utils/app-root.js`, never `process.cwd()`, in runtime code (it's `/` in packaged apps) ([common-mistakes.md](common-mistakes.md)) |
| DSK-03 | HIGH | C | Windows — every `windows.create()` is `await`ed; the `main` window is ALWAYS created (even hidden launches, with `show: false`) so activate/second-instance can surface UI ([windows.md](windows.md), [common-mistakes.md](common-mistakes.md)) |
| DSK-04 | HIGH | B | Zero-trust IPC: all channels go through `omega.ipc` (never raw `ipcMain`); handlers validate payload content before acting, especially in apps embedding remote web content ([ipc.md](ipc.md#zero-trust-payloads)) |
| DSK-05 | MED | C | Icons — one native-size PNG per slot (no `@2x` siblings), macOS tray source named `tray.png` (@omega.js/desktop owns the `Template` rename), no `app.icons` config block ([icons.md](icons.md)) |
| DSK-06 | HIGH | C | File-based integrations — tray/menu/context-menu logic lives in `src/integrations/<name>/index.js`, never expressed in config JSON ([tray.md](tray.md), [menu.md](menu.md), [context-menu.md](context-menu.md)) |
| DSK-07 | HIGH | B | Presence-driven feature flags — credentials enable features (`monitoring.providers.sentry.dsn`, `analytics.providers.google.id`, `cloud.config`); no invented `enabled:` toggles ([config-schema.md](config-schema.md)) |
| DSK-08 | MED | B | Accessibility basics in renderer views — meaningful `alt` text, labeled form fields, real `<button>`/`<a>` elements (no clickable `div`s) |

## Framework-repo checks (F-xx)

Only when auditing the @omega.js/desktop repo itself. Mirrored across the four frameworks.

| ID | Sev | Check |
|----|-----|-------|
| F-01 | MED | Sister parity — mirrored sections (config shapes, test contract, guide skeleton, shared env/test conventions) in sync with UJM / @omega.js/backend / BXM; deviations are deliberate and documented |
| F-02 | HIGH | Consumer-shipped defaults in sync — what `ensureTarget()` scaffolds (`src/defaults/`, every verb) matches current conventions and docs |
| F-03 | MED | Docs completeness — every `docs/desktop/*.md` indexed in the framework guide; every lib module has a doc; no "(planned)" links for things that have shipped |
| F-04 | HIGH | `npx omega test mgr:` green before treating the audit as complete |

## See also

- [common-mistakes.md](common-mistakes.md) — the canonical anti-pattern list behind several checks
- [ipc.md](ipc.md#zero-trust-payloads) — the payload rules behind DSK-04
- [config-schema.md](config-schema.md) — the validator behind U-07 / DSK-07
- [test-framework.md](test-framework.md) — the layers behind U-01 / U-02
