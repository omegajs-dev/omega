# OMEGA

> The map of the omega framework, for every agent working on omega or on a brand built with it. It is a MAP, not a manual: the knowledge lives in the docs beside this file, one folder per framework.

## What this is

The `@omega.js` framework ecosystem in one repo: npm workspaces, one family version bumped by hand. Remote: [github.com/Omega-JS-Stack/omega](https://github.com/Omega-JS-Stack/omega) (npm org `omega.js`, GH org `Omega-JS-Stack`, both Ian's, names final).

**Lineage** (the migration story, kept short): OMEGA consolidates the legacy manager ecosystem. The legacy repos keep serving production and are read-only reference: never modify them.

- backend-manager (BEM) became `@omega.js/backend`; electron-manager (EM) became `@omega.js/desktop`; browser-extension-manager (BXM) became `@omega.js/extension`.
- ultimate-jekyll-manager (UJM) was replaced by `@omega.js/web` (rebuilt on Eleventy 3, not ported); jekyll-uj-powertools became `@omega.js/template-kit`.
- web-manager (WM) was absorbed into `@omega.js/client`; WM no longer exists as a concept; omega-manager's brains became `@omega.js/manager`.

## How knowledge loads

- **`docs/` is the SSOT.** Cross-framework contracts live in `shared/`; each framework's guide is `<framework>/index.md` with its deep docs beside it. No package keeps docs of its own, and no line budget applies inside `docs/`.
- **This file is the one map, and every agent entry imports it.** Knowledge lives in `docs/`, never in an AGENTS.md.
  - In the monorepo, the root `AGENTS.md` opens with an import of this file, then adds the rules for working on omega itself.
  - `@omega.js/manager` ships this whole docs tree plus a one-line `AGENTS.md` importing this file. Every project root's `AGENTS.md`, a brand's or one framework used alone, imports `@node_modules/@omega.js/manager/AGENTS.md` in its Default section (its own notes sit under the Custom marker), so its agent reaches this map in two imports across three files.
  - A locally linked brand's manager docs are synced from the monorepo before every omega verb but a read-only one, so it reads the live map; a published install reads the copy that matches its version. Contract: [shared/agent-docs.md](shared/agent-docs.md).
  - Brand-root knowledge (the target table, the verbs, the brand hard rules, upstream-first) lives in [manager/brand.md](manager/brand.md).
  - The supported shape (a brand monorepo, versus one framework used alone): [shared/agent-docs.md § Supported shape](shared/agent-docs.md#supported-shape).
- **Loading is deterministic, not preloaded.** The omega Claude plugin's hooks detect where the chat is working (a `packages/<framework>/` tree in the monorepo, or a target's tree in a brand) and inject the relevant docs then. Nobody reads guides "just in case".

## The Claude plugin

The monorepo ships a Claude Code plugin (`agent-plugins/claude/`). It serves both audiences: developing this monorepo, and every consumer working on a brand built from these frameworks.

- It is the ONLY home of the `omega:*` skills and of the hooks that do the deterministic loading above. Folder and frontmatter names stay plain (`web`, `backend`, …); Claude Code namespaces them `omega:<skill>` from the plugin manifest's `"name": "omega"`.
- It reaches a machine under two marketplace names that never share a record. The published copy is `omega` (`omega@omega`), fetched from GitHub through the repo-root manifest `.claude-plugin/marketplace.json`. The local copy is `omega-local` (`omega@omega-local`), declared by the second manifest `.claude-plugin/marketplace.local.json` and read in place. Every settings file that turns one on turns the other off.
- Consumers get the published copy: onboarding offers the machine-wide install, and the workspace service writes every brand's committed `.claude/settings.json` to name it. Omega developers get the local copy: this repo's committed `.claude/settings.json` names it, a linked brand's private `.claude/settings.local.json` names it, and `omega i local` makes it the machine default. The plugin manifest carries the family version, so installed copies move at each release. The contract: [shared/agent-docs.md](shared/agent-docs.md).
- It declares exactly ONE MCP server, in `agent-plugins/claude/.mcp.json`: the `@omega.js/mcp-router` endpoint that lazily proxies the browser, electron, and extension upstreams ([mcp-router/index.md](mcp-router/index.md)), and no other native MCP declarations, anywhere.
- The local copy is read LIVE from the checkout, so an edit loads at the next session start: `/reload-plugins` picks it up mid-session, and `claude --plugin-dir ./agent-plugins/claude` is only for same-session iteration and edge cases, not for freshness.

## The map: packages

| Package | What it is | The guide |
|---|---|---|
| `@omega.js/web` | Web framework (UJM successor): Eleventy 3 + LiquidJS, sections/themes, asset lanes, translation | [web/index.md](web/index.md) |
| `@omega.js/backend` | Firebase Cloud Functions backend framework: build, test, deploy | [backend/index.md](backend/index.md) |
| `@omega.js/desktop` | Electron desktop framework: build, test, package for macOS/Windows/Linux | [desktop/index.md](desktop/index.md) |
| `@omega.js/extension` | Chrome/Firefox MV3 extension framework | [extension/index.md](extension/index.md) |
| `@omega.js/client` | Shared frontend runtime singleton (Firebase auth, account, analytics, notifications, bindings) embedded by web/desktop/extension | [client/index.md](client/index.md) |
| `@omega.js/manager` | Brand orchestration engine: walks every service in dependency order, reconciles a brand monorepo to its omega.json5 | [manager/index.md](manager/index.md) |
| `@omega.js/mcp-router` | One lazy MCP endpoint per session: a stdio server proxying the browser/extension upstreams, tools cached and children spawned on demand | [mcp-router/index.md](mcp-router/index.md) |
| `@omega.js/devkit` | Internal: shared build-time internals (logger, local linking, CLI router, prompts, deploy/update executors), vendored into every framework | [devkit/index.md](devkit/index.md) |
| `@omega.js/config` | Internal: the omega.json5 loader, schema, merge, validator | [shared/config.md](shared/config.md) |
| `@omega.js/account` | Internal: user/account schema + subscription resolution, shared by backend and client | [packages/account/src](../packages/account/src) |
| `@omega.js/analytics` | Internal: the ONE analytics contract: event catalog, per-provider adapters (GA4/Meta/TikTok), guarded browser transport, consent seam | [shared/analytics.md](shared/analytics.md) |
| `@omega.js/monitoring` | Internal: the ONE error-reporting contract: config resolution, release tags, PII scrub, the client-side @omega.js-bundle filter, per-platform SDK entries | [shared/monitoring.md](shared/monitoring.md) |
| `@omega.js/template-kit` | Internal: the `omega_*` template filters/tags as engine-neutral JS | [web/template-kit.md](web/template-kit.md) |

## The map: brands

| Brand | Who it is | Cloud |
|---|---|---|
| `brands/naked-brand` | "Naked Brand": the bare fixture: the minimum a brand can declare, so a walkthrough sees every prompt fire from zero; a QA walk may reset it | Offline, `demo-*` only |
| `brands/sandbox-brand` | Synthetic fixture for the automated corpus/e2e; test runs may mangle and reset it | Offline, `demo-*` only |
| `brands/playground-omega` | "OMEGA Playground": the standing LIVE test brand, classy theme; converts to every new shape in the same change (Ian 2026-09-11) | Real-but-throwaway project `omegajs-playground` |
| `brands/newsflash-brand` | "The Daily Build": the standing second-skin brand, newsflash theme | Offline, `demo-*` only |
| `../omega-omega` (sibling repo) | The REAL brand: omegajs.dev, LIVE | Real project `omegajs` |

The in-repo brands and the playground project are test-only forever; nothing in this monorepo is ever the production brand.

- Full topology, history, the local-era `file:` dependency contract, and the remaining launch gates: [shared/brands.md](shared/brands.md).
- **Working inside a consumer brand right now?** Read [manager/brand.md](manager/brand.md) first: the brand-root anatomy, the verbs, and the brand hard rules.
- **Migrating a legacy brand onto OMEGA?** The playbook is [manager/migration.md](manager/migration.md): the six phases, their exit criteria, and the trap register.

## CLI bins

Every framework AND `@omega.js/manager` ship `omega` + `omg` + `mgr`, all the SAME context-aware dispatcher (`@omega.js/devkit/omega-bin`).

- The nearest package.json walking up from cwd names the framework, and THAT framework's CLI runs via its `./cli` export, so npm's arbitrary hoist-winner in a brand monorepo is always correct.
- A verb runs in a TARGET of an owner framework (brand target, standalone project). Framework source (`packages/*`) is never one, so a verb there refuses printing the root form, like a brand-wide manager verb in a target. At a root `--target=` picks: `npx omega test --target=web framework:`. One verb table: devkit's `verbs.js` ([#985](https://github.com/Omega-JS-Stack/omega/issues/985)).
- A verb that needs no brand and that only the manager owns (`status`, `onboard`) runs the manager wherever it is typed, inside a target included. `npx omega status` names what a folder is, what it lacks and the next command, and writes nothing ([manager/index.md](manager/index.md)).
- No target context (fresh dir) → `@omega.js/manager` when installed, else the HOST package's CLI, each with a stderr note. The contextless verbs are the manager's own, so `npx omega onboard` in a fresh clone reaches it whichever framework won npm's `.bin/omega` link ([#908](https://github.com/Omega-JS-Stack/omega/issues/908)).
- Those three are the WHOLE bin set: the per-framework `omega-<framework>` bins are gone ([#877](https://github.com/Omega-JS-Stack/omega/issues/877)), so a human types only `omega` (`npx omega` at a root, `--target=<name>` picking) and a generated CI workflow runs the framework's own `bin/omega` FILE by path. Docs say `npx omega`; `omg`/`mgr` are supported aliases.
- Legacy to OMEGA is ONE brand-root verb, `omega migrate` (a report; `--execute` converts the config, then every target); OMEGA to newer OMEGA is by hand, a dated entry in [shared/breaking-changes.md](shared/breaking-changes.md), the file its report ends on ([#885](https://github.com/Omega-JS-Stack/omega/issues/885)).
  - The schema is STRICT: an undeclared key fails the load naming `npx omega migrate`, the one code that knows an old config or `.env` name (its tables: `packages/manager/src/migrate/`). Rule: [shared/rulings.md](shared/rulings.md) ([#859](https://github.com/Omega-JS-Stack/omega/issues/859)).
- Every framework-owned package.json script spells the verb BARE (`omega build`), on all four frameworks ([#748](https://github.com/Omega-JS-Stack/omega/issues/748)): npm already puts `node_modules/.bin` on the path inside a script. `npx omega` stays canonical for docs and the terminal.

## Config: omega.json5

Single config format everywhere: shared sections (brand, cloud, analytics, payment, sentry, connections, theme) + a `targets` object (key presence = target enabled; any shared key inside a target entry overrides it). Owned by `@omega.js/config`.

- Merge chain: `defaults ← company ← brand shared ← brand targets.<name> ← local shared ← local targets.<name>`.
- Secrets stay in `.env`: the validator hard-fails secret-shaped keys in config.
- **No dual-read (Ian's call, 2026-07-06)**: frameworks flip to omega.json5 outright; legacy brands convert once via the mapping tables. Full reference: [shared/config.md](shared/config.md).

## Docs index

`shared/`: the cross-framework contracts:

- [config.md](shared/config.md): the omega.json5 schema, merge chain, legacy mapping tables
- [local-dev.md](shared/local-dev.md): local linking + watch mechanics
- [testing.md](shared/testing.md): the tiered verification pipeline (unit → corpus → e2e → verts → journey)
- [deploys.md](shared/deploys.md): the deliberate `omega deploy` verb on every target (no push triggers, ever). **A brand deploy never needs a publish** (Ian 2026-09-12): the snapshot lane packs every `file:`-linked `@omega.js/*` package into tarballs that ride the pushed mirror, so the runner installs the framework code as it sits in this working tree
- [updates.md](shared/updates.md): the `omega update` dependency-update contract
- [publishing.md](shared/publishing.md): the publish runbook and the lockstep release (run: the seven publishables are on npm at 0.57.0)
- [icons.md](shared/icons.md): the one Font Awesome mechanism on every surface
- [logging.md](shared/logging.md): the one log-tag contract (`[@omega.js/<package>:<module>]`) and its guard
- [theming.md](shared/theming.md): the `--omega-*` design-system contract, shell chrome, motion
- [translation.md](shared/translation.md): the AI translation engine + config-driven cache
- [analytics.md](shared/analytics.md): the event catalog, the placement rule, consent gating, attribution
- [monitoring.md](shared/monitoring.md): the error-reporting contract: the doctrine, the switches, the release tags, the capture seams
- [agent-docs.md](shared/agent-docs.md): the agent-docs chain: thin pointers here, the brand chain in consumers
- [breaking-changes.md](shared/breaking-changes.md): the legacy→OMEGA breaking-changes register: what changed shape, and the by-hand migration step for each
- [brands.md](shared/brands.md): brand topology, history, the local era
- [rulings.md](shared/rulings.md): standing rulings from the retired board era

`<framework>/`: each framework's guide (`index.md`) plus its deep docs. Web carries the extra set:

- [sections.md](web/sections.md) (the sections & components contract), [frontmatter.md](web/frontmatter.md) (every page-frontmatter key, by family), [omega-sections-spec.md](web/omega-sections-spec.md) (the ratified architecture spec), [template-kit.md](web/template-kit.md)
- [libs.md](web/libs.md) (the `core/js/libs/` inventory and the `__main_assets__` import idiom), [classy-v2/DIRECTION.md](web/classy-v2/DIRECTION.md) (the locked visual spec), [ads-system.md](web/ads-system.md) (the ratified vert/ads architecture)
