# Brands — topology, history, and the local era

> The SSOT for who the brands are, why each exists, and the local-era dependency contract. Settled with Ian 2026-07-11; real brand born 2026-07-18. AGENTS.md carries only the summary table and points here.

## The five brands

### `brands/naked-brand` — "Naked Brand", the bare fixture

Added with Ian 2026-08-29 ([#687](https://github.com/Omega-JS-Stack/omega/issues/687), agreed on [#608](https://github.com/Omega-JS-Stack/omega/issues/608)'s QA question): the standing brands are too COMPLETE to QA from-zero behavior, because a brand that already answered every question shows no prompt. This one is the minimum a brand monorepo can declare and still be walked — id `naked-brand`, one enabled web target, and nothing else. No theme, no analytics/payment/monitoring/connections/marketing sections, no agent-docs chain, no `.env`, no second target, no page content: every one of those is something `npx omega manage` is supposed to OFFER, and the walk's ask/skip/disable ladder is the thing under test.

Test-only forever, offline forever: project id `demo-naked-brand` (Firebase's emulator-only convention) is a guardrail rather than a configuration — every cloud-touching service short-circuits on `demo-*` instead of aiming real Google APIs at a project that does not exist, so nothing here provisions real cloud resources. A QA walkthrough may leave it in any state and reset it (`git clean` + `git checkout` on the folder); nothing outside it reads what a run wrote. The automated lanes do not run against it — it is a hand-walk fixture, and the corpus/e2e fixture is still the sandbox.

### `brands/sandbox-brand` — the synthetic fixture

Fixture for the AUTOMATED corpus/e2e suites: offline, `demo-*` Firebase, deterministic. Both targets are REAL framework consumers, `targets/backend` on `@omega.js/backend` and (since [#775](https://github.com/Omega-JS-Stack/omega/issues/775)) `targets/web` on `@omega.js/web`, whose `/e2e` page carries the hooks the brand's own lane drives: the fixture is the brand's content, never a stand-in for the frameworks. Test runs may mangle and reset it. Never touches real cloud. It deliberately carries no agent-docs chain: its files are test output, not a workspace an agent should be guided into.

### `brands/playground-omega` — "OMEGA Playground", the standing live test brand

Renamed from omega-brand (Ian 2026-07-11, zero ambiguity). Born through the real wizard: id `playground` (shortened on 2026-09-10, [#808](https://github.com/Omega-JS-Stack/omega/issues/808), so the `<brand.id>-<role>` rule derives clean repo names off it), url playground.omegajs.dev, a SUBDOMAIN so derived surfaces never claim the real omegajs.dev. Its THREE repos all derive from that id, none of them typed ([#883](https://github.com/Omega-JS-Stack/omega/issues/883), all under the one `repo: { provider: 'github', owner: 'Omega-JS-Stack' }` block): `playground-omega` (the PUBLIC source repo since 2026-09-24, so its Actions runs never count against the org storage allowance; the folder name here, whose `main` every `omega deploy` snapshots this folder onto, [docs/shared/deploys.md](deploys.md)), `playground-releases` (public: the desktop installers, the extension zips and the autoupdater feed), and `playground-web` (public: the BUILT site alone, one force-orphan commit on `gh-pages`, served by Pages at playground.omegajs.dev, which is what let the source repo stay private on a free org before it went public). The third, the private `playground-rehearsal` snapshot, retired with the rehearsal itself ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)). Points at the real-but-throwaway Firebase project `omegajs-playground` (ITW-org-owned since 2026-07-11; sanctioned for live proofs: Blaze it, break it, delete it; it is TEST INFRASTRUCTURE, never production).

REBRANDED **OMEGA Playground** (Ian 2026-08-21, [#433](https://github.com/Omega-JS-Stack/omega/issues/433) — REVERSES the 2026-07-19 fiction ruling, whose invented brand read as a real product in the ad and analytics consoles). The doctrine now: the playground is openly the OMEGA test surface — "we can mess around here, nothing live actually matters" — so drift from the real omegajs.dev site reads as a demo doing its job, never as a broken copy. Infra identity unchanged (id, url, green accent, classy theme); name and voice are the only things that moved, and the catalog's display names stay placeholder demo copy. Cloud-side display names (the Meta pixel, the GA property + streams, the GCP project name) are the manager's follow-up.

**The playground converts FIRST, in the same change** (Ian 2026-09-11, [#883](https://github.com/Omega-JS-Stack/omega/issues/883)): "we should ALWAYS be updating playground to our new shapes." Every config, folder, repo, or workflow shape the frameworks adopt lands in `brands/playground-omega` in the commit that adopts it, and the playground deploy is the proof run. A playground on an old shape is a defect, never a pending chore.

**The playground is LOCAL unless stated otherwise** (Ian 2026-09-27, [#941](https://github.com/Omega-JS-Stack/omega/issues/941)): its `@omega.js/*` specs are `file:` paths into `packages/`, like every sibling brand, so any install keeps it on the working tree. Node resolves the playground's own `node_modules` first and the monorepo root's workspace links second, so whichever copy is installed is the one that runs. `omega i live` is only for a named live-run test, and `omega i local` restores the `file:` specs right after. A registry pin left in a playground manifest is a defect.

**Its COMPANY is ITW Creative Works** (`company: { id: "itw-creative-works" }`, [#677](https://github.com/Omega-JS-Stack/omega/issues/677)): one top-level key names the parent, and the parent's name, url and wordmark, its config layer, its `.env`, its hooks and its signing tree all RESOLVE from it. ITW is not an OMEGA brand on this machine yet, so every playground run prints one line saying inheritance is off until it converts (the company layer is simply absent until then). The brand types `company: { webhooks: false }` ([#677](https://github.com/Omega-JS-Stack/omega/issues/677), the successor to the retired `parent: false`), which means only "the SendGrid ACCOUNT is shared with the real ITW brands and its one account-level webhook is theirs": the campaigns and newsletter services are its only readers.

Secrets live only in `.env`/`.omega/secrets` (gitignored; the config loader hard-fails secret-shaped keys) — the committed omega.json5 carries public-by-design values only.

### `brands/newsflash-brand` — "The Daily Build", the second skin

Added with Ian 2026-07-17. Id `daily-build`, url dailybuild.omegajs.dev (same subdomain rule). The standing SECOND-SKIN brand: a fictional dev-news publication wearing the newsflash theme permanently, so both first-party skins stay alive in real consumers (classy = playground, newsflash = here). Born by COPY of the playground — the wizard rehearsal is a separate queued exercise. OFFLINE-only (demo-* Firebase, no real cloud/services, never production); website + backend targets only; website dev port pinned 4100 for side-by-side, backend rides N7 bumps.

It plays the SUB-BRAND in the company-mode ads proof, so its company is the playground (`company: { id: "playground" }`, [#677](https://github.com/Omega-JS-Stack/omega/issues/677)): `advertising.providers.inhouse.source: 'company'` derives the company's API address (`api.<company host>`; a company on a default Pages host has none from a sub-brand) from the RESOLVED `company.url`, which is the playground's own url once any playground run has written its registry line on this machine (`test/e2e/verts-company.test.js` is the proof).

### `../omega-omega` — the REAL brand (sibling repo)

BORN 2026-07-18 (cp229), LIVE 2026-07-19 (cp232). Lives outside the monorepo with its own git history; folder + repo are `omega-omega` per the `<brand.id>-<role>` rule ([#808](https://github.com/Omega-JS-Stack/omega/issues/808), 2026-09-10; `omega-brand` before that, `omegajs.dev` before 2026-07-19). GitHub: `Omega-JS-Stack/omega-omega`, from `repo: { provider: 'github', owner: 'Omega-JS-Stack' }` (the key is `org` in that repo until it runs `omega migrate --execute` on the release carrying [#1041](https://github.com/Omega-JS-Stack/omega/issues/1041)) plus the `<brand.id>-<role>` rule; its site publishes to `Omega-JS-Stack/omega-web` ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)).

Id `omega`, name "OMEGA", url omegajs.dev (LIVE: GitHub Pages + Cloudflare), classy theme, website port 4200, web + backend + extension targets. The EXTENSION target is the **OMEGA Companion** ([#927](https://github.com/Omega-JS-Stack/omega/issues/927), 2026-09-14): the browser extension that files brand bookmarks and carries the trusted-automation bridge, which used to sit inside `@omega.js/manager` as `extension/` with another product's identity and shipped to no store at all. It is a normal extension target now (Chrome first, the Chrome Web Store lane, no listing created yet), and the router's `omega-extension` upstream holds the MCP half. Born by FORKING the playground's polished content 1:1 (never a promotion of the test project; stale es caches dropped and re-translated fresh). It is the first SUB-BRAND of Ian's eventual company umbrella, which the config `company: { id }` key models ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)).

**Backend config is real** (flipped 2026-07-19): project `omegajs`, sdkconfig baked, `.firebaserc` real, Blaze linked to the Main Billing Account. authDomain = the BRAND host per cp268 — `omega build` self-hosts Firebase's `/__/auth/*` helper files (what the 2026-07-19 live 404 was actually missing), and a first-party authDomain keeps sign-in redirects working under browser storage partitioning.

**The identity seam SELF-HEALS in the cloud service** (Ian 2026-07-19: "wrapped in npm start — self healing idempotent"; since [#227](https://github.com/Omega-JS-Stack/omega/issues/227), 2026-08-13, that wrapper is `npm run manage`): access probe → grant the manage identity via any able local gcloud account (owner first; editor+firebase.admin fallback — no-org projects refuse API owners) → re-probe through propagation. The FIRST healing run must be Ian's own `npm run manage` from the brand root (the session classifier refuses Claude-fired IAM mutation, even wrapped); every run after is plain reconcile.

**REMAINING GATES**: that first `npm run manage`; the npm publish; one CI-dispatch exercise.

## The local era

Ian 2026-07-18: "still use local … until we are fully locked on all decisions that may result in breaking changes."

- Every `@omega.js/*` dep in the real brand is a committed relative `file:` spec into THIS monorepo.
- Every package carries ONE family version, bumped by hand at each release; the seven publishables are on npm at that version, and 1.0.0 never publishes without Ian's explicit word ([publishing.md](publishing.md)).
- The seven publishables carry no `private` latch and publish with `publishConfig.access: public`; the six private internals keep `private: true` forever ([docs/shared/publishing.md](publishing.md)).

## The line that never moves

The in-repo brands and the playground Firebase project stay test-only forever; nothing in this monorepo is ever the production brand.
