# Audit Workflow

Full-project audit for @omega.js/extension — runs against a CONSUMER extension or the FRAMEWORK repo itself (scope auto-detected). Invoked via the `omega:extension` skill (`/omega:extension audit`) or any "audit this extension/project" request.

Every check has a stable ID, a severity, and a scope. Findings are reported as `ID @ file:line`, fixed one at a time, then re-verified. The tables below do NOT restate the rules — each check links to the doc that owns the rule and the fix.

## Protocol

1. **Detect scope** — read `package.json`: `name` is `@omega.js/extension` → **framework audit** (U + @omega.js/extension + F checks); `@omega.js/extension` in (dev)dependencies → **consumer audit** (U + @omega.js/extension checks).
2. **Run the catalog** — every check matching the scope. Search with Grep/Glob/Read over `src/` (+ `test/`, `config/`, `hooks/`); ALWAYS exclude `dist/`, `packaged/`, `node_modules/`, `_legacy/`, `_backup/`, `.temp/`, `.cache/`. Record each finding as `ID @ file:line` + a one-line description.
3. **Persist the report** — write the findings list to `.temp/audit/claude-audit.md` so a long fix loop survives session breaks. Summarize counts by severity in chat.
4. **Fix loop** — TodoWrite per finding, highest severity first, ONE at a time: mark in-progress → root cause → fix → verify → complete. Ask before structural or destructive fixes (file deletions, component restructures, manifest permission changes).
5. **Re-verify** — re-run every check that produced findings until clean; finish with `npx omega test` (must be green).
6. **Doc parity** — if fixes changed behavior, update README / the framework guide / `docs/extension/<topic>.md` / CHANGELOG in the same change set.

Severity: **CRIT** security or broken functionality · **HIGH** hard-rule violation · **MED** convention drift · **LOW** optional improvement.
Scope: **C** consumer · **F** framework repo · **B** both.

## Universal checks (U-xx)

Mirrored across all four OMEGA frameworks — same ID means the same check everywhere.

| ID | Sev | Scope | Check |
|----|-----|-------|-------|
| U-01 | HIGH | B | Every feature has tests at EVERY layer it surfaces (build / background / view / boot) — never mocked, real harness only ([test-framework.md](test-framework.md)) |
| U-02 | HIGH | B | Test hygiene — real-external-API tests gated behind `TEST_EXTENDED_MODE` in-source via `ctx.skip(...)` (not mocked); no tests that assert nothing ([test-framework.md](test-framework.md)) |
| U-03 | CRIT | B | XSS: inline `omega.utilities.escapeHTML(value)` at EVERY DOM sink, `sanitizeURL(url)` at executable URL sinks, zero local escape helpers ([xss-prevention.md](xss-prevention.md)) |
| U-04 | HIGH | B | @omega.js/client owns Firebase: no direct `firebase` imports anywhere; `omega.auth` / `omega.firestore` ([common-mistakes.md](common-mistakes.md)) |
| U-05 | HIGH | C | Bundled code imports a framework dependency bare (the bundler's framework-deps hook resolves it); a `hooks/` file either declares the package in the consumer `package.json` or loads it through `require('@omega.js/extension').require(name)` ([common-mistakes.md](common-mistakes.md), [the framework guide](index.md) §Dependency Resolution) |
| U-06 | HIGH | B | Env behavior gated on the INTENTIONAL check — `isProduction()` or `isDevelopment() \|\| isTesting()`, never `!isDevelopment()`; no ad-hoc `process.env.BXM_*` reads where a helper exists ([environment-detection.md](environment-detection.md)) |
| U-07 | HIGH | B | Config canon — `config/omega.json5` + `src/manifest.json` match the documented shapes; canonical cross-framework blocks (`brand`, `cloud.{provider,config}`, …) not reinvented ([defaults.md](defaults.md), [components.md](components.md)) |
| U-08 | CRIT | B | No private credentials committed — store-publishing credentials, `.env`, tokens, secret keys; `.gitignore` covers them ([publishing.md](publishing.md)). (The Firebase WEB `apiKey` is public by design — do NOT flag it.) |
| U-09 | HIGH | B | Source discipline — nothing edited in `dist/` or `packaged/` (including `dist/manifest.json`); no live code referencing `_legacy/` / `_backup/` ([build-system.md](build-system.md)) |
| U-10 | MED | B | Doc parity — README / the framework guide / `docs/` / CHANGELOG match shipped behavior; the docs index lists every `docs/extension/*.md`; no stale names for renamed commands/patterns |
| U-11 | MED | B | SSOT/DRY — no duplicated constants/config/logic; one authoritative home per value, imported everywhere else |
| U-12 | MED | B | JS conventions — file structure, JSDoc, short-circuit returns, leading logical operators, `fs-jetpack`, one `module.exports` per file (global `js:patterns` skill + [the framework guide](index.md) §File Conventions) |
| U-13 | MED | B | Dead code & stale patterns — no orphaned `src/` files nothing imports; no unused components/views; inventory TODO/FIXME (report only) |
| U-14 | LOW | B | Dependency health — review `npm outdated` / `npm audit`; apply fixes via the `general:update-packages` workflow (includes supply-chain checks) |

## extension-specific checks

| ID | Sev | Scope | Check |
|----|-----|-------|-------|
| EXT-01 | HIGH | B | Cross-browser wrapper — `extension.*` everywhere; never raw `chrome.*` / `browser.*` in component code ([extension.md](extension.md)) |
| EXT-02 | HIGH | B | Component structure — views are HTML FRAGMENTS (not full documents); three parts at conventional paths (view + styles + script) ([components.md](components.md)) |
| EXT-03 | HIGH | B | Service-worker-safe background — no DOM/`window`/`document` APIs in `background`; DOM-needing work goes to an offscreen document ([components.md](components.md), [offscreen.md](offscreen.md), [common-mistakes.md](common-mistakes.md)) |
| EXT-04 | MED | C | Permissions justified — every manifest permission maps to a feature actually used (`offscreen` ↔ offscreen component, `tabs` ↔ auth sync, …); remove unused ones ([components.md](components.md), [auth.md](auth.md), [offscreen.md](offscreen.md)) |
| EXT-05 | MED | C | Store listing — `config/description.md` follows the listing format (Bonus/Privacy sections intact); after a description change, a local `omega build` retranslated it and the updated `translations/<lang>/description.json` is committed ([publishing.md](publishing.md), [translations.md](translations.md)) |
| EXT-06 | MED | B | Accessibility basics in popup/options/sidepanel/pages views — meaningful `alt` text, labeled form fields, real `<button>`/`<a>` elements (no clickable `div`s) |

## Framework-repo checks (F-xx)

Only when auditing the @omega.js/extension repo itself. Mirrored across the four frameworks.

| ID | Sev | Check |
|----|-----|-------|
| F-01 | MED | Sister parity — mirrored sections (config shapes, test contract, guide skeleton, shared env/test conventions) in sync with UJM / @omega.js/backend / EM; deviations are deliberate and documented |
| F-02 | HIGH | Consumer-shipped defaults in sync — what `ensureTarget()` scaffolds (`src/defaults/` via `FILE_MAP`, every verb) matches current conventions and docs ([defaults.md](defaults.md)) |
| F-03 | MED | Docs completeness — every `docs/extension/*.md` indexed in the framework guide; every subsystem has a doc; no "(planned)" links for things that have shipped |
| F-04 | HIGH | `npx omega test mgr:` green before treating the audit as complete |

## See also

- [xss-prevention.md](xss-prevention.md) — the escaping rules behind U-03
- [extension.md](extension.md) — the wrapper rule behind EXT-01
- [components.md](components.md) — the structure rules behind EXT-02 / EXT-03 / EXT-04
- [test-framework.md](test-framework.md) — the layers behind U-01 / U-02
