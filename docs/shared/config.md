# omega.json5 — the single OMEGA config

One config file, identical shape, for every OMEGA project type. Owned by `@omega.js/config`
(`packages/config`); frameworks vendor it at prepare time and read **only** this format —
there is no dual-read of legacy files. Legacy brands migrate by converting their old config
once (mapping tables below) and deleting the old file.

Consistency between this file and what pages actually say — brand facts read from config instead of typed,
one brand hex, the merge chain, secrets out of config — is the plugin's `omega:brandcheck` skill,
[agent-plugins/claude/skills/brandcheck/SKILL.md](../../agent-plugins/claude/skills/brandcheck/SKILL.md);
its quality hook fires on every `omega.json5` edit.

## Location

| Project | File |
|---|---|
| Every project type (default) | `config/omega.json5` |
| Standalone backend repo | `functions/config/omega.json5` |
| Brand monorepo — brand level | `{brand}/config/omega.json5` |
| Brand monorepo — local level | `{brand}/targets/{target}/config/omega.json5` |

JSON5: comments, trailing commas, unquoted keys, single quotes all allowed.

## Shape

```json5
{
  // SHARED sections — identical spelling in every project type.
  // (`SHARED_SECTIONS` in @omega.js/config is the authoritative list.)
  brand:          { id, name, url, description, tagline, type, font, color, contact: { email, phone, carbonCopy: […] }, address: {…}, images: {…} },   // #524: type = the schema.org type the JSON-LD stamps ('Organization' unset), font = the display face the assets service renders the wordmark from. contact.carbonCopy = audit BCCs
  cloud:          { enabled, provider: 'firebase', config: { apiKey, authDomain, databaseURL, projectId, storageBucket, messagingSenderId, appId, measurementId }, messaging: { vapidKey }, shared, supportEmail, consentAudience, apiSubdomain, organizationId, billingAccount, oauthRedirectsConfigured },   // ONE cloud home (#23): the app config PLUS the provisioning fields; projectId lives only at cloud.config.projectId. vapidKey: web-push public key (console → Cloud Messaging), public by design. shared: true limits the manage cycle to the per-brand operations AND skips the backend deploy whole (#882, deploys.md)
  repo:           { provider: 'github', owner },   // ONE block (#883): where the brand hosts its SOURCE. Presence enables the repo service, `provider` defaults to `github`, and `owner` is the only typed value: every repo name derives from `<brand.id>-<role>` and visibility is the brand root package.json's `private` field, so neither is configurable here
  edge:           { providers: { cloudflare: { enabled, zone, dns, settings, rules, cacheRules, speedTest, webAnalytics, workers } } },   // workers[]: { name, route, script, env, secrets } (script from the brand's `workers/`, then the company tree's, then the framework's, secrets named from `.env`). webAnalytics.enabled: Cloudflare Web Analytics for the zone (default true, resolution-only), the edge service's `web-analytics` operation turns the account's RUM site on or off to match. rules.redirect: the ORDERED dynamic-redirect ruleset — [{ name, expression, statusCode, preserveQueryString, targetUrl, enabled }], `expression`/`targetUrl` in Cloudflare's own filter language. The ONE home for a TEMPLATED redirect, whose destination is computed from the request path (#466); the manager's edge service reconciles them by `name` (docs/manager/edge.md)
  captcha:        { providers: { recaptcha: { enabled, project, siteKey, domainsConfirmed: [] } } },   // domainsConfirmed: machine-written. The classic key's domain list has no API, so the captcha service records the owner's confirmation here and stops asking
  search:         { providers: { searchConsole: { enabled, submitSitemap, sitemapPaths, gaLinked } } },   // #546: each `enabled` is the service's own switch, default ON — false skips that whole service. gaLinked: machine-written — the Search Console ↔ GA association has no API, so the confirmation is the record
  forms:          { providers: { slapform: { enabled, formId, templateFormId, updateFormInfo, plan } } },
  inbound:        { chat:  { providers: { chatsy:   { enabled, agentId, accountId, templateAgentId, updateAgentInfo, plan, sponsorshipsUrl, settings } } },
                    email: { providers: { replyify: { enabled, agentId, templateAgentId, updateAgentInfo, plan, discount } } } },
  analytics:      { enabled, providers: { google: { id, propertyId, accountId }, meta: { id, accountId }, tiktok: { id, accountId, appId } } },   // #524: the pixel/measurement id is the RUNTIME value; propertyId/accountId are the platform ids the manager reconciles against (never secrets: tokens stay in .env). tiktok.appId: the DEVELOPER APP the token mint authorizes through (#448/#635): public config; the app secret is pasted once and never saved
  advertising:    { providers: { adsense: { client, displaySlot, inArticleSlot, inFeedSlot, multiplexSlot }, inhouse: { source } }, fallback, tags: [] },   // C4 cp105; inhouse source: 'self' | 'company' | full URL (ads spec). #527: `client` is the ONE adsense switch — its presence drives the managed account, the ad units and the ads.txt record together (no `units`, no `enabled`). Role-level: `fallback: 'inhouse'` is the lane a provider miss falls through to (false/absent ends at the built-in promo), `tags` are the brand's contextual targeting tags
  payment:        { currency, providers: { stripe: { publishableKey }, paypal: { clientId }, chargebee: { site }, coinbase: { enabled } }, products: […], winback: { enabled, percent, amount, duration } },   // currency: the ISO 4217 code every price in `products` is quoted in, default `USD` (#850). One currency per brand, named by the pricing page's JSON-LD, the checkout and the backend's order history alike; the successor to the retired `targets.web.currency`. #642: coinbase (Coinbase Commerce, crypto, one-time purchases only) is the one provider switched by an explicit `enabled`, default OFF: its whole credential is the secret COINBASE_COMMERCE_API_KEY, so there is no public datum to gate on. winback = the cancel-flow save offer (#268), on by default at 50% off the next cycle; see below
  monitoring:     { enabled, providers: { sentry: { org, dsn, environment, sampleRate, tracesSampleRate, replaysSessionSampleRate, replaysOnErrorSampleRate, scrubEmail, attachScreenshot, bundlePatterns: [] } } },   // #425: the monitor is a KEY under `providers`. dsn presence IS the runtime enable signal; environment unset = the host's gate names it; scrubEmail defaults true (email OFF), attachScreenshot is desktop-only, bundlePatterns + the two replay rates browser-only (replay defaults to 0 — opt-in, #485). docs/shared/monitoring.md
  connections:    { <provider>: { enabled, max, scope: [], name, logo, description } },   // #771/#788: per-provider USER-CONNECTION settings, keyed by provider name; public values only (the credentials are the CONNECTIONS_<PROVIDER>_CLIENT_ID/_SECRET env pair). The provider set is OPEN — a brand ships its own as `targets/backend/src/connections/<name>.js` — so the section stays free-form. See below
  theme:          { id, appearance },            // project-owned; seeded at onboarding
  translation:    { enabled, default, languages: [], providers: { claude: {} } | { chatgpt: {} }, model, include: [] }, // presence picks the engine; absent = claude. `include` is the web route list (#858): globs with `!` negation, read in .gitignore order, default ['**', '!blog/**'], a brand list REPLACES it, and a page overrides it for itself with `translation.include: true`/`false` in frontmatter. docs/shared/translation.md
  socials:        { twitter: 'somiibo', spotify: { handle, redirect } },   // platform → handle. The handle derives the profile URL every surface reads (JSON-LD sameAs, the footer row, omega_social) and @omega.js/web emits a shortlink redirect page at /<platform> per entry (#429); the object form adds a redirect target that WINS for the shortlink when it is not the profile URL. Blank handle = no entry, no page. Not a disperse-owned SHARED_SECTION — brand-level content, read by the web target

  // MANAGER-read brand-level sections (#277). Schema-known at the TOP level: the
  // manager loads the brand config unfolded, and a website-only brand has no
  // `targets.backend` to hold them (presence there would enable the target). A
  // `targets.backend.<same key>` block still overrides any of them.
  company:        { id: '<parent brand.id>' | 'self', webhooks: true },   // #677: the ONE key joining a brand to its company, OUTSIDE `brand`. `id` and `webhooks` are the only typed keys; the loader FILLS the same key with { id, name, url, images: { wordmark }, webhooks } from the parent's own config, and a brand with no company resolves to its own name/url under a null id, so no reader carries a fallback. `webhooks: false` says the provider ACCOUNT (SendGrid Event Webhook, Beehiiv webhook) is somebody else's and the walk never repoints its one webhook. See "The company" below
  domain:         { enabled, providers: { namecheap: {} }, email: { providers: { cloudflare: {} }, forwarding: [] } },   // TWO roles (#425): the REGISTRAR is the one key under `providers` (namecheap is the one the service drives by API; every other registrar gets manual instructions), the mailbox provider the one key under `email.providers`. Presence picks; no entry = nothing chosen, and the service skips; `false` at either email key means none
  certificates:   { enabled, providers: { apple: { bundleIdPrefix, capabilities: [], profiles: [], certificates: [] } } },   // Apple signing for desktop/mobile targets. bundleIdPrefix is the brand's own answer ('com.mycompany' + brand.id composes the bundle id); the credentials live in .env (APPLE_API_ISSUER, APPLE_API_KEY_ID, APPLE_TEAM_ID)
  reviews:        { enabled, sites: [] },
  marketing:      { campaigns: { enabled, providers: { sendgrid: { listId, groups: { orders, hello, account, marketing, security, newsletter, internal } } } }, newsletter: { enabled, providers: { beehiiv: { publicationId } }, content: […] }, prune: { enabled } },   // #425: each role names its vendor as a KEY under `providers`; `enabled` and the newsletter `content` PIPELINE blob stay role-level. `prune` is ON by default (Ian 2026-08-22, #478) and per-brand disableable: docs/backend/marketing-campaigns.md § Contact Pruning. `groups` holds the SendGrid unsubscribe (ASM) group ids — per ACCOUNT, so the campaigns service provisions them by name and writes the ids here (#649)
  blog:           { /* AI blog-content settings (Ghostii pipeline) */ },
  devlog:         { enabled, providers: { ghostii: { orgs, lookbackDays, … } } },   // commit-digest devlog (#553): `enabled: true` PUBLISHES AI-written posts to the live site, so it is case 3 — the literal true is the only ON, absence is off, and no default is materialized
  seo:            { github: { content: [] } },   // the manager's parasite-SEO content repos; big blocks may live in the `config/seo.json5` sidecar, which the loader reads as this section (same merge, same checks). The site-wide SEARCH POSTURE is NOT here: it is `targets.web.meta.index`, the same name a page writes (#564)
  dataRequest:    { /* GDPR/CCPA data-request query definitions */ },
  directory:      { enabled },                   // opt in to the manager's directory PUSH: this brand's entry into the COMPANY's brands collection (#246/#677); default off, public facts only. docs/manager/directory.md
  sponsorships:   { acceptable: [], unacceptable: [], prices: { 'guest-post': 70, 'link-insertion': 50 } },   // sponsorship terms — the first directory BLOCK; `prices` is an open placement→USD map, not an enum

  // TARGET-scoped config. EVERY KEY IS A TARGET NAME and key presence =
  // "this brand enables a target by that name" (#886); the name is the folder
  // `targets/<name>`. Every entry MUST declare its `type`: the framework that
  // runs there, or `custom` (see Custom targets below). The keys below are
  // named for their type, which is the common case, not a rule: a second web
  // target is a sibling key with `type: 'web'` (see Targets below).
  targets: {
    web:       { type: 'web', hosting: { provider: 'github' }, meta: { index }, imagemin, collections, client: { consent, … }, dev: { limitCollections } },   // `hosting` says who SERVES this target's built site (#883): web targets only, `github` by default, which publishes it to the target's own `<brand.id>-<name>` repo and serves it from Pages at the target's url. `meta` holds SITE-WIDE defaults for page-meta values, spelled exactly as a page spells them (#564; `index` is the only key today). No `redirects` key: #466 retired it; a TEMPLATED redirect is a Cloudflare redirect rule (edge.providers.cloudflare.rules.redirect), an enumerable one is a redirect PAGE (docs/web/index.md). client: the @omega.js/client runtime blob (auth, sentry, exitPopup, …): a settings bag the client normalizes, declared as an OPEN object; only the keys a BRAND authors are typed: `consent` (see "Consent" below), plus `auth.config.policy` ('authenticated' | 'unauthenticated' | 'disabled'; absent = no policy, and the auth/admin layouts set theirs in page frontmatter), `exitPopup.enabled` and `serviceWorker.enabled` (both default true, materialized) ([#650](https://github.com/Omega-JS-Stack/omega/issues/650)). collections: the brand's OWN content collections: name → { field, size, title, description, permalink }; documents live in `_<name>/` and the engine generates the listing + one page per category of `field` (#207). dev.limitCollections: dev-only collection sampling: collection name → max documents ({ posts: 50 }) plus `randomize: true`; development builds only, production always ships the whole site (#190)
    backend:   { type: 'backend', projectType, auth: { signup: { maxPerIpPerDay } } },   // projectType: 'firebase' (default: Cloud Functions) | 'custom' (the same backend as its own server on PORT, for a container host: no Functions deploy, no emulator lane; see "Backend project type" below). auth.signup.maxPerIpPerDay: signups allowed per client IP per day, positive integer, default 2 (the schema's own `default:`, resolution-only: `materialize: false`, so no brand file gains the key, and the backend's signup guard reads the resolved value). Raise it for audiences behind shared egress (NAT/CGNAT, VPNs, offices)
    desktop:   { type: 'desktop', omega: { authPersistence }, app: { appId, productName, copyright, category, languages, darkModeSupport },
                 platforms: { mac, windows, linux },
                 autoUpdate: { enabled, autoDownload, startupDelayMs, feedCheckIntervalMs, idleEvalIntervalMs, maxAgeMs },
                 startup: { mode, openAtLogin: { enabled, mode } },
                 protocol: { singleInstance },   // singleInstance: unset reads as true; false skips the single-instance lock for a CLI-shaped app
                 releases, remoteConfig: { enabled, url }, remoteScripts, restartManager },   // platforms: what this app SHIPS plus each platform's install knobs (#867): `platforms.<mac|windows|linux>.formats.<dmg|nsis|deb|appimage|snap>`, presence = enabled, `false` drops a default, per-format settings inside the format (see "The shipping declaration" below)
    extension: { type: 'extension', platforms: { chrome, firefox, edge }, categories, listings },   // platforms: the SAME shipping declaration the desktop target carries (#867): `platforms.<chrome|firefox|edge>.formats.<zip|store>`, where the zip rides the release and the store is published to. categories: the AMO slugs a FIRST Firefox publish lists the add-on under (#884), default ['alerts-updates'] and validated against AMO's own set; the Firefox lane sends them with the summary (brand.description, cut to 250) and the target package.json `license` (UNLICENSED lists as all-rights-reserved). listings: per store, the `id` the store knows this extension by (#893: chrome/firefox/edge; the firefox one IS the manifest's gecko id) plus the `url` and `state` the site's /extension page reads (see "The site global" below)
    mobile:    { type: 'mobile' /* RESERVED: MAM parked */ },
    community: { type: 'web', url: 'https://community.acme.com' },   // a SECOND web target → targets/community
    api:       { type: 'custom' },   // a target no framework owns (#603): the manager drives it entirely through its own package.json scripts; see "Custom targets" below
  },
}
```

## Resolution

`loadConfig(projectDir, target, { defaults })` produces ONE resolved object per target:

```
schema defaults ← framework defaults ← company ← company.<environment> ← brand shared ← brand targets[name] ← brand root config/seo.json5 ← brand.<environment> ← local shared ← local targets[name] ← root config/seo.json5 (no brand layer) ← local.<environment>
```

The brand root's `config/seo.json5` is the brand's `seo` section: the loader reads it with the same merge and the same two checks as the brand root's `omega.json5`, right after it. From a target it is the brand layer's; at the brand root, or in a standalone project, it is the local layer's. A target's own `config/seo.json5` is not a layer and is never read.

- **The bottom layer is the SCHEMA's own defaults** ([#478](https://github.com/Omega-JS-Stack/omega/issues/478)) —
  see [Defaults & self-healing](#defaults--self-healing) below. `options.defaults` sits directly
  above it and carries only what a framework does differently.
- "shared" = the file minus its `targets` key. In a standalone repo only the local layers exist.
- **Every layer is TWO files**: its `config/omega.json5` and an optional
  `config/omega.<environment>.json5` overlay beside it
  ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)), the config mirror of the
  `.env` + `.env.<environment>` pair below. The overlay wins over its OWN base and still
  loses to the layer above, each file keeping the shared-then-`targets[name]` split. The
  three names are exactly what `envEnvironment()` returns, so the config overlay, the env
  overlay and the runtime's own answer are ONE vocabulary: exactly ONE environment's
  overlay composes, a missing overlay is nothing, and a file named anything else
  (`omega.staging.json5`) is not a layer at all, so nothing reads it and nothing warns
  about it. An overlay is a PARTIAL, holding only the overrides: the validator judges the
  merged result, never an overlay on its own. Nothing scaffolds one; a brand writes the
  file the day it has a public value that differs by environment (the case that named it:
  a `pk_test_` Stripe publishable key for the local checkout, the live key in the base).
- **WHICH environment's overlay composes is the LANE's word, never the machine's**
  ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)): `loadConfig` and
  `composeTargetConfig` take `options.environment`, and every lane that produces a
  production artifact names `production`, the way `stageFunctions({ environment })` already
  names one for the `.env` overlay beside it. So a production build never carries a
  development override, even though the machine that runs it answers `development` in a
  terminal: the web build and both web deploy lanes name it, the desktop and extension
  bakes name it under their own `OMEGA_BUILD_MODE` word, and the backend deploy stage names
  it for both halves of the upload at once. The ambient answer (`envEnvironment()`) is what
  a DEV boot and a deployed runtime take, which is the whole point of it; an environment
  outside the three names throws. A compose asks outright: told nothing,
  `composeTargetConfig` freezes the authored base layers and no overlay at all.
- **The company layer** is the company's own `company/config/omega.json5`, found through the
  brand's `company: { id }` key and the machine registry (the same ONE resolver the `.env`
  cascade, owner hooks and the signing tree read, [#677](https://github.com/Omega-JS-Stack/omega/issues/677)
  see "The company" below). It layers exactly like the brand file (company shared <-
  company `targets[name]`). A brand naming no company has no company layer; the resolved
  result reports the file it used as `files.company`.
- **`projectDir` may be one of a target's SUBDIRS** — `functions/` (@omega.js/backend's runtime cwd)
  or `dist/` (its staged build output, the view `omega test` loads): every walk (brand root,
  company marker, local-layer fallback, target name, compose, `resolveBrandRoot`) treats the target root
  as one level up, so `loadConfig(functionsDir, 'backend')`, `loadConfig(distDir, 'backend')` and
  `loadConfig(targetRoot, 'backend')` resolve identically. A staged `config/omega.json5` inside either
  subdir is the deployed runtime's own view, never an authored local layer.
- **WHICH entry is the target layer comes from the DIR**: `targets/community` resolves
  `targets.community` (§ Targets). A standalone project has no such dir, so it is named by its
  own file: the SINGLE declared target of the framework's type (a deployed backend staged from
  `api: { type: 'backend' }` is still the `api` target, so its entry is the layer, `enabled` is
  true and its url derives), and the type word when the file declares none or declares two.
- **Target sections overlay the TOP LEVEL**: `targets.desktop.platforms` resolves to
  `config.platforms`; frameworks never read through `config.targets.<name>.…`.
- **Any shared key inside a target entry overrides it for that surface** — a desktop-only
  Sentry DSN is just `targets.desktop.monitoring.providers.sentry.dsn`; disabling any integration per-surface is
  uniformly `<key>: { enabled: false }`. One agnostic deep merge everywhere (objects merge,
  arrays/scalars replace, `null` replaces, `undefined` is skipped).
- **A global value and its specific override share ONE name**: the standing rule is recorded in
  [docs/shared/rulings.md](rulings.md) (Ian 2026-09-09).
- **@omega.js/web adds one MORE layer, per page** ([#607](https://github.com/Omega-JS-Stack/omega/issues/607)):
  a page's (or layout's) `config:` frontmatter block merges over the resolved config for that page
  alone, and templates read the result as `resolved.config.*` — the WHOLE merged config, never a
  subset. It is the same deep merge, one layer higher: `… ← local targets[name] ← page config:`.
  Nothing else in the config chain knows about it. The membership rule runs both ways: a page
  restating a config section BARE is a build error, and a key under `config:` that no omega.json5
  section answers to is a build error too. Page machinery — `meta`, `schema`, `layout`,
  `permalink` — is not config and has no home in this file at all
  ([docs/web/frontmatter.md](../web/frontmatter.md)).
- The merged `targets` map rides along on the resolved config so enabled-target enumeration
  survives (`getEnabledTargets()`); the `enabled` flag on the result says whether the resolved
  NAME is listed, and the result carries that `name`.
- **A dir whose entry runs another framework is a loud error**: `loadConfig(targets/backend,
  'desktop')` throws `targets.backend is type backend; this project runs the desktop framework`
  rather than silently merging somebody else's layer.
- No target argument → whole-file merge (the shape omega-manager's disperse works with).

## Targets: every key is a NAME (#886)

`targets` is an object whose EVERY key is a target NAME. The name is the folder
(`targets/<name>`), the `--target=<name>` word, and the derived-repo suffix. Every entry
declares a `type`: the framework that runs there (`web`, `backend`, `desktop`, `extension`,
`mobile`) or `custom`. A brand runs two web sites by declaring two names:

```json5
targets: {
  web:       { type: 'web', url: 'https://somiibo.com' },
  community: { type: 'web', url: 'https://community.somiibo.com' },
  backend:   { type: 'backend' },
  desktop:   { type: 'desktop' },
  docs:      { type: 'custom' },
}
```

- **No id, no folder key, no name table.** The key IS the answer, so the dir walk and the path
  derivation are each one line: `targetPath(config, 'community')` → `targets/community`, and
  `targetNameFromDir(projectDir)` → the target root's basename inside a brand (null for a
  standalone project, whose dir name is arbitrary). `targetEntries(config)` is the ONE
  enumeration, `{ name, type, ...entry }` in config order; `targetsOfType(config, 'web')`
  filters it. Nothing derives a folder any other way.
- **The merge chain is by NAME**: `defaults ← company ← brand shared ← brand targets.<name> ←
  local shared ← local targets.<name>`. A shared key inside an entry still overrides the shared
  value for that surface, exactly as before.
- **The NAME is the subdomain** ([#588](https://github.com/Omega-JS-Stack/omega/issues/588),
  Ian 2026-09-01). `targetUrl(config, name)` is the one resolver: the entry's own `url`, else a
  target-scoped `brand.url`, else `brand.url` when the name IS its type (`web: { type: 'web' }`
  is the brand itself), else `https://<name>.<host of brand.url>`, so `community: { type:
  'web' }` is a COMPLETE declaration. An explicit `url` overrides it for a custom host. The host
  is taken EXACTLY as `brand.url` states it (a `www.` brand derives `admin.www.acme.com`), and
  no usable `brand.url` derives nothing at all (null, never a half-built `https://admin.`).
- **An unset `brand.url` is the Pages address**
  ([#1145](https://github.com/Omega-JS-Stack/omega/issues/1145)). A brand with no domain of its
  own writes no `brand.url` (or `url: null` in a layer that switches a declared domain off), and
  when `targets.web` is a GitHub-hosted web target, `loadConfig` and `composeTargetConfig` alike
  fill it right after the merge with `pagesAddress(config, 'web')`:
  `https://<repo.owner lowercased>.github.io/<brand.id>-web`. No `web` target, no `repo.owner`,
  no `brand.id`, or another `hosting.provider` leaves it unset, and every reader skips as before.
  The filled value counts as the BRAND layer's, so a sibling target is never misread as an
  override. On a default Pages host `targetUrl` itself gives a sibling WEB target its own Pages
  address (`admin` → `https://<owner>.github.io/<brand.id>-admin`, since
  `admin.<owner>.github.io` is no site), so the loader and every direct caller read one rule; a
  non-web sibling keeps the name-as-subdomain derivation. Readers that manage a DOMAIN (the manager's
  `edge`, `domain`, `search`, `cloud`, `account`, `campaigns` and `captcha` services, the verify
  sweep's live gate, the web purge) each ask
  `defaultAddressReason(url)` once and skip with its answer, `brand.url is the hosting
  provider's default address (<host>): no domain to manage`, before any credential or registrar
  ask; every other reader takes the address like any declared url. Buying a
  domain later is one line: `brand.url` becomes it.
- **Validator rules**: a key must be a dir-safe slug (`/^[a-z][a-z0-9-]*$/`, because it is a
  folder name), an entry must be a plain object, and its `type` must be one of the six. An ARRAY
  is the retired multi-instance form and names its replacement, a sibling key
  ([breaking-changes.md](breaking-changes.md)). **More than one `backend` target is a WARNING**
  (`warnings` on the result): backend stays single in practice, one Cloud Functions surface per
  brand.
- **Dev ports offset by the target's position among its OWN type**
  (`targetPortOffset(config, name)`): the first web target takes the classic base, the second
  takes base + 1, and a backend declared between them shifts nothing
  ([docs/shared/local-dev.md](local-dev.md)). The N7 bump-if-taken allocator still guarantees a
  free port.
- **An override AT the target IS its url**, never a base to stack the name on: the entry's own
  `brand.url`, a `targets/<name>/config/omega.json5` naming `https://shop.acme.test`, or a dev
  layer naming `http://localhost:4000` are each the answer as written (no `shop.shop.acme.test`,
  no `https://admin.localhost:4000`). The derivation only runs while the resolved `brand.url` is
  still the brand layer's. A CUSTOM host belongs on the entry's `url`, never on a target-scoped
  `brand.url`: the authDomain check reads `brand.url`, so overriding it there makes that check
  compare against the custom host and fail.
- **Brand-level facts stay brand-level.** `cloud.config.authDomain` compares against `brand.url`
  for every target (one Firebase project, one backend, one authDomain), and so does the persona
  domain the test lanes seed. Only a target's PUBLIC surface is per target: `site.url`, the
  gh-pages CNAME `omega deploy`/`omega build` write, and the deploy path prefix.
- **One shared `api.<domain>`**: every web target talks to the same backend, so the manager's
  cloud hosting op ensures exactly one API domain no matter how many targets a brand runs
  ([docs/manager/cloud.md](../manager/cloud.md)).
- **The resolved `url` is a declared key** (`packages/config/src/schema.js`), so the strict
  schema never fails a target load over the url it just derived.
- **Legacy `brand.subdomains` conversion rule**: each subdomain becomes its own web target,
  `["admin", "cdn"]` → `admin: { type: 'web' }, cdn: { type: 'web' }` beside the main site; the
  names carry the subdomains, so nothing else is written. The key itself is undeclared, so a
  config still carrying it fails the strict load, and `omega migrate` names that recipe.
- Non-goals: no cross-target shared builds, no per-target Firebase projects.

## The shipping declaration (`platforms`) and the format table (#867)

Desktop and extension declare what they SHIP in the SAME shape, in the ONE vocabulary
(@omega.js/client's `getPlatform()` / `getBrowser()`): platforms `mac`, `windows`,
`linux`, `chrome`, `firefox`, `edge`; formats `dmg`, `nsis`, `deb`, `appimage`, `snap`,
`zip`, `store`. It is `mac`, never `macos`, and `windows`, never `win`.

```json5
targets: {
  desktop: {
    type: 'desktop',
    platforms: {
      mac:     { formats: { dmg: {} }, arch: ['universal'] },
      windows: { formats: { nsis: {} }, oneClick: true, signing: { strategy: 'self-hosted' } },
      linux:   { formats: { deb: {}, appimage: {}, snap: { channels: ['stable'] } } },
    },
  },
  extension: {
    type: 'extension',
    platforms: {
      chrome:  { formats: { zip: {}, store: {} } },
      firefox: { formats: { zip: {}, store: { channel: 'listed' } } },
      edge:    false,   // this brand does not ship to Edge
    },
  },
}
```

- **Presence is the switch, and every platform and format defaults ON.** A brand drops one
  with the literal `false` (the `certificates: false` idiom), never by omitting it: a
  config that says nothing ships everything the framework can build.
- **Per-format settings live INSIDE the format** (`linux.formats.snap.channels`,
  `firefox.formats.store.channel`), which is why the declaration is an object and not a
  list. The keys BESIDE `formats` are that platform's install knobs (arch, the NSIS
  installer flags, mac entitlements, the Windows signing strategy).
- **The format table is [`platforms.js`](../../packages/config/src/platforms.js)**, the
  successor of `desktop-artifacts.js`: per target, platform and format it says what the
  format IS (`kind: 'asset'`, a file on the brand's releases repo with an `ext`; or
  `kind: 'store'`, a publish), the env keys it cannot ship without (`requires`) and the
  per-listing config paths a store needs before it can accept an upload (`listing`, the
  `listings.<browser>.id` of [#893](https://github.com/Omega-JS-Stack/omega/issues/893)),
  and, for a store, the `label` and `console` page a human creates that listing on.
  Everything derives from it: the electron-builder target lists, the site's
  `/download/<platform>/<format>` links and their versionless asset names, the manage
  walk's per-brand list of ship credentials and its Enter-to-open ask, and the manual step
  a publish prints for a listing that does not exist yet.
- **A `listing` says what a store needs BEFORE it can accept an upload**, which is why the
  firefox store declares none: AMO takes the manifest's gecko id, so that publish always
  goes through, and the id is the brand's own derived value, pinned into the brand config as
  `listings.firefox.id` by the extension's local scaffold (never by a publish, which runs on
  a throwaway checkout). Chrome and Edge assign theirs in a dashboard, so those two are
  the ids the walk asks for, with a "not yet" skip.
- **`requires` names ENV keys, and the env schema owns them.** A key with a `requiredWhen`
  applies only when that rule holds, so the Windows nsis format asks for the credentials of
  the strategy the brand actually signs with and no other's. The rules read what the target
  ships, defaults included: a desktop target that never mentions the snap owes
  `SNAPCRAFT_STORE_CREDENTIALS`, and one that names no signing strategy owes the two
  self-hosted Windows keys, until the format is turned off with `false`. The schema is also where each key's
  `label`, `url` (the page that mints it) and `hint` live: one home for what a key is and
  where it comes from (see "The env schema" below).
- **The one translation points.** Node's `darwin`/`win32` becomes OMEGA's word in
  @omega.js/desktop's `utils/platform.js`; electron-builder's `mac`/`win`/`AppImage`/`nsis`
  is spelled only in its `gulp/tasks/build-config.js`; GitHub's runner labels only in the
  generated workflow. `APPLE_*` and `SNAPCRAFT_*` env names stay as they are: they name
  vendors, not platforms.
- **Retired, with a migration**: `platforms.win` and `platforms.linux.snap` are undeclared, so
  a brand still carrying either fails the strict load, and `omega migrate` names the replacement.
  `npx omega manage --migration=platform-names --execute` performs the rewrite at the brand
  root (every omega.json5 it owns, brand file and target files alike) and renames
  `config/icons/macos/` to `config/icons/mac/` with it. Run it BEFORE `omega migrate --execute`,
  which DELETES a retired key rather than moving it. `snap.enabled: false` becomes
  `formats.snap: false`, because presence is the switch now.

## Custom targets (#603)

A brand also runs targets no framework owns — a Render API, a worker, a script. They are
declared like any other target, with `type: 'custom'`:

```json5
targets: {
  web:     { type: 'web' },
  api:     { type: 'custom' },   // → targets/api
  jobs:    { type: 'custom' },   // → targets/jobs
  nightly: { type: 'custom' },   // → targets/nightly
}
```

- **The type is the declaration**, and it is the ONLY thing checked: the key is a name, so a
  name no framework owns is a deliberate brand choice rather than a typo to guess at.
- **Its verbs are its own package.json scripts**: `start`, `build`, `test`, `deploy`, `clean`.
  The manager runs each through `npm run <verb>` when the script is present and skips it
  loudly when it is absent — nothing is inferred or defaulted.
- **No framework service reconciles it.** The only manage op that sees a custom target is the
  workspace service (structure, agent docs, settings). Nothing is composed into a `.env` of its
  own; it INHERITS the brand keys — the manager loads the env chain into `process.env` before it
  spawns anything, so a custom target started by `omega dev`/`omega deploy` has them. A standalone
  run inside the target dir does not (there is no `@omega.js/config` in there to walk the cascade).
  Full contract: [docs/manager/index.md](../manager/index.md) § Custom targets.

## Backend project type (#584)

`targets.backend.projectType` says how the backend RUNS, and it is the only switch:

```json5
targets: {
  backend: { projectType: 'custom' },   // default is 'firebase'
}
```

- **`'firebase'` (default)** — the backend exports Cloud Functions, deploys with `firebase deploy`,
  and runs locally on the emulator suite. Everything OMEGA does today.
- **`'custom'`** — the SAME backend (same routes, same schemas, same auth middleware, same
  helpers, same `.env`) served by its Express app on `process.env.PORT`, for a container host
  (Render & co). `initialize()` reads the mode off this key, so a brand's `src/index.js` is
  unchanged; an explicit `projectType` option still wins.
- **What custom mode removes is the Firebase LANE, not Firebase**: no Functions deploy, no
  emulator, no emulator test run — those four verbs refuse loudly and name their replacement
  ([docs/backend/index.md](../backend/index.md)). `firebase-admin` still loads, so a custom
  server that reads Firestore or verifies an ID token works exactly as before.
- **Not to be confused with a custom TARGET** (above): that is a target no framework owns.
  This one IS the `@omega.js/backend` target, with a different artifact. Same-type duplicates
  are sibling keys (§ Targets).
- The brand-root behavior — deploy through the target's own `deploy` script, `omega dev` booting
  the server instead of the emulator: [docs/manager/index.md](../manager/index.md).

## Hard rules

- **Secrets NEVER live in omega.json5** — they live in `.env`. `loadConfig` throws on any
  key matching `/(secret|privateKey|apiSecret)$/i` in any section of a raw file, before any
  merge. Public credentials (`publishableKey`, `clientId`, `cloud.config.apiKey`) pass by
  design.
- **The legacy `targets` ARRAY form throws**: `targets` is an object keyed by target name,
  and a per-target ARRAY (the retired multi-instance form) is a validation error naming its
  replacement, a sibling key.
- Schema findings (required/type/min/match/enum) come back as `errors`, not throws — build-time
  audit throws on them, boot warns/fails per framework policy.

## The company (`company: { id }`), #677

ONE key joins a brand to its company, OUTSIDE `brand` (Ian 2026-09-12: "brand key is for
things about this brand, and the parent/company/organization key is OUTSIDE of that"):

```json5
company: { id: 'itw-creative-works' },   // a sub-brand: the parent's brand.id
company: { id: 'self' },                 // the company brand itself, kept visible on purpose
```

- **The `id` is the only key a consumer types.** The loader FILLS the same object at load,
  from the parent's own config: `company: { id, name, url, images: { wordmark } }`. One name,
  one shape, at every level.
- **A brand with no `company` key resolves to `{ id: null, name: brand.name, url: brand.url,
  images: {} }`**, so no reader anywhere needs a fallback: the footer credit, the email
  wordmark and the in-house ads api all read one shape. `company.name` / `company.url` /
  `company.images` are RESOLVED, never typed: an authored one fails the load naming the key.
- **The company's shared files live in `company/` inside the company brand's own repo**
  (`company/config/omega.json5`, `company/.env`, `company/.omega/certificates/apple/`), and
  inheritance is ONE rule: a brand-level file the child lacks resolves from there at the same
  relative path (`resolveCompany(brandRoot).file(relPath)`). A new kind of inherited file
  costs zero code. The manage walk's preflight SENDS an operator there
  ([#910](https://github.com/Omega-JS-Stack/omega/issues/910)): once a company resolves,
  every fix line it prints for a missing key names that `company/.env` by path, with the
  brand `.env` as the override, so a credential every sibling brand needs is pasted once.
- **The doctrine line: a brand with a company reuses the company tree first, always.**
- **WHERE that repo is on this machine is a cache, never configuration**: `~/.omega/brands.json`
  (`OMEGA_HOME` moves it), keyed by `brand.id`, which every `loadConfig()` refreshes for its
  own brand, and nobody maintains it. A company that has never been loaded here prints ONE line
  per run (`Company <id> is not on this machine: inheritance off…`) and the run continues with
  no company layer. A write prunes only the lines whose root is missing on disk, checked by the
  same test the reader resolves a parent with, lands as one atomic rename, and never rewrites a
  registry file it cannot parse; `OMEGA_DEBUG` prints each write's caller and its kept and
  pruned ids ([#941](https://github.com/Omega-JS-Stack/omega/issues/941)).
- **Off-laptop, nothing ever reads `company/`**: the machine that dispatches a deploy resolves
  it and writes `config/company-resolved.json5` beside the brand config (`{ config, company }`),
  which the mirror push carries and then removes; the loader reads that generated layer when the
  registry has no line. The env half needs nothing: the deploy precheck's secrets push sends the COMPOSED target
  env (company ← brand ← target) as that repo's own secrets.

Full contract, and the `omega company init` half: [../manager/company.md](../manager/company.md).

## Config or env? (#893)

One value, one home, and the line between the two files is what it IS, not who
reads it:

- **config/omega.json5 holds what is PUBLIC by design**: a value a store URL
  carries, a browser bundle ships, or a binary prints. A store item id, a
  reCAPTCHA site key, a PayPal client id, a Chargebee site name, `cloud.config.apiKey`,
  a Stripe `publishableKey`: anyone can read them off the shipped product, so
  hiding them buys nothing and splitting them across two files costs a drift.
- **`.env` holds secrets, the login coordinates that only travel WITH a secret,
  and machine paths**: an API key or token; the username, OAuth client id,
  Apple issuer / key id / team id that are useless without the secret beside
  them and are asked for in the same breath (Ian 2026-09-12: the Apple triple
  and the Namecheap username stay in env); and a path that is true of one
  laptop (`OMEGA_FONTAWESOME_ROOT`, `machineLocal`).
- The validator enforces the first half mechanically: a secret-shaped key in
  omega.json5 hard-fails the load (Hard rules above). The second half is this
  rule, and `omega migrate` names a `.env` line that moved (below).
- **A public value in config needs no CI delivery.** It rides the snapshot a
  deploy pushes like every other config value, so it is never a repo secret and
  never a `${{ secrets.KEY }}` line.

### Retired env keys (the migrate table, `@omega.js/manager` `src/migrate/retired-env.js`)

Six public identifiers moved out of `.env` with #893. There is no dual-read, so
a stale line is a value nothing consults. The `.env` layer itself stays OPEN
(an `.env` may carry keys outside omega, [#859](https://github.com/Omega-JS-Stack/omega/issues/859)),
so running code never names one: the brand-root `omega migrate` does. Its report
lists every retired key the brand root's `.env` and each `.env.<environment>`
overlay carry, by NAME only (a value never reaches a report), and `--execute`
renames an env-side rename in place with the value's bytes untouched. A value
that moved into config, and a key retired outright, stay by-hand steps.

| Retired `.env` key | Its config home |
|---|---|
| `CHROME_EXTENSION_ID` | `targets.<name>.listings.chrome.id` |
| `FIREFOX_EXTENSION_ID` | `targets.<name>.listings.firefox.id` |
| `EDGE_PRODUCT_ID` | `targets.<name>.listings.edge.id` |
| `RECAPTCHA_SITE_KEY` | `captcha.providers.recaptcha.siteKey` |
| `PAYPAL_CLIENT_ID` | `payment.providers.paypal.clientId` |
| `CHARGEBEE_SITE` | `payment.providers.chargebee.site` |

The by-hand move for a brand that still carries one:
[breaking-changes.md](breaking-changes.md). The SECRET halves are untouched:
`RECAPTCHA_SECRET_KEY`, `PAYPAL_CLIENT_SECRET`, `CHARGEBEE_API_KEY` and every
store API credential stay in `.env`.

The same table carries the keys that stayed secrets and only changed NAME
([#845](https://github.com/Omega-JS-Stack/omega/issues/845)): the env schema does
not know the old name, so the value reaches nothing. The fix is renaming the
line, not deleting it, which is what `omega migrate --execute` does (it refuses
when the new name is already in the file). Rows are exact names, one per provider.

| Renamed `.env` key | Its new `.env` name |
|---|---|
| `OAUTH2_GOOGLE_CLIENT_ID` | `CONNECTIONS_GOOGLE_CLIENT_ID` |
| `OAUTH2_GOOGLE_CLIENT_SECRET` | `CONNECTIONS_GOOGLE_CLIENT_SECRET` |

And it carries the keys retired OUTRIGHT
([#819](https://github.com/Omega-JS-Stack/omega/issues/819), Ian 2026-09-13): no config
path and no new env name, because a MECHANISM took the key's place rather than another
value. Such a row declares `replacement: null` and its report line reads as a deletion
with nowhere to move the value to. The test-lane pair is the whole set today: web, desktop and
extension each test their own sign-in against a persona the backend emulator seeds
([#904](https://github.com/Omega-JS-Stack/omega/issues/904)), so no suite holds a
credential of its own and the `testing` schema group is gone with them.

| Retired `.env` key | What replaced it |
|---|---|
| `OMEGA_TEST_FIREBASE_ADMIN_KEY` | Nothing to move: delete the line. The seeded persona (#904) replaces the minted custom token |
| `OMEGA_TEST_USER_UID` | Nothing to move: delete the line. The emulator's roster names the persona (#904) |

## The .env cascade (secrets) — D15

Secrets mirror the config hierarchy (`src/env.js`), weakest → strongest:

```
company .env ← brand .env ← local .env ← shell env
```

Every layer is TWO files: its `.env`, and the `.env.<environment>` overlay that wins
over it.

```
.env  ←  .env.development | .env.testing | .env.production
```

- **Same walk as the config cascade**: `{brand}/targets/{target}` layers the brand root's `.env`
  under the target's; a brand naming a company (`company: { id }`) layers that company's
  `company/.env` underneath that (#677). `findBrandRoot` in `load.js` is the ONE definition
  of the walk; both cascades use it.
- **`.env.<environment>` overlays the `.env` beside it**
  ([#586](https://github.com/Omega-JS-Stack/omega/issues/586)) — the widespread standard
  (Next.js, Vite, Rails dotenv, dotenv-flow). The three names are exactly what
  `envEnvironment()` returns (`development` | `testing` | `production`), so the file name
  and the runtime's own answer are ONE vocabulary; only the RUNNING environment's overlay
  is read, and every key in it is equal — whatever it holds wins, values are TRUSTED, and
  no key gets special treatment. The composed artifact is flat and single-environment: a
  deploy composes base + production, the emulator base + development, a test lane base +
  testing, and no other environment's file ever rides along. Onboard scaffolds all three
  beside the brand `.env`, empty but for a header comment (`.env.*` is gitignored).
- **A key of your own in the brand root `.env` reaches every target**
  ([#835](https://github.com/Omega-JS-Stack/omega/issues/835)). The schema filters the
  company and brand layers by TARGET, and a key it never declared names no target, so it
  composes everywhere (base `.env` and `.env.production` alike) and rides the same pipeline
  to GitHub Actions as every declared one. Want it on one target only? Put it in that
  target's own `.env`, the per-key override that was always unfiltered.
- **Precedence via dotenv's no-override semantics**: files load strongest-first and never
  overwrite keys already set, so the shell always wins and local beats brand beats company.
- **A RELOAD honors edits, because ownership is remembered**
  ([#724](https://github.com/Omega-JS-Stack/omega/issues/724)). After a boot load every key
  is "already set", so presence can no longer tell a shell value from a file value — which
  is why `loadEnv` alone can never deliver an edit. The first chain load in a process
  snapshots what `process.env` carried before any file was read (shell-owned, forever) and
  records what each file layer delivers (file-owned). `reloadEnv(startDir, options?)` drops
  the file-owned keys, then loads again: a NEW key and an EDITED value both land, a key
  dropped from the file is dropped from the process, and a shell-set value is never touched.
  The dev lanes' `.env` watchers ([#681](https://github.com/Omega-JS-Stack/omega/issues/681))
  are its one caller.
- **Empty file values never claim a key (cp95a, friction #20)**: `KEY=` / `KEY=""` in any
  `.env` FILE means "documented here, value supplied by another layer" — a scaffolded local
  file full of placeholders can't shadow the brand root's real values. Only the shell can
  deliberately set a key to empty. The brand root's `.env` stub ships `# KEY=""` commented
  placeholders in its `Default Values` section, rendered from the env schema (the merge
  protocol keeps set values on their line, converges empties to the placeholder, and keeps
  the `Custom Values` section verbatim); no framework scaffolds a target `.env` at all.
- **Every `.env` line the framework writes is double-quoted, and reads back as written.**
  `KEY="value"`, an empty value `KEY=""`, a placeholder `# KEY=""`: no other form, with
  one exception. GitHub's runner-dir `.env`, written by `ensureRunnerDirEnv`
  ([runner.md](../desktop/runner.md)), holds bare `KEY=value` lines, because the runner reads
  each line verbatim and quotes would land in the value.
  `envLine` / `serializeEnv` (`src/env.js`) are the one serializer. A value goes in raw
  (dotenv reads `"`, `\`, `'` and `#` back unchanged); a real newline or carriage return is
  written as the two characters `\n` / `\r`, which dotenv expands back, so every line stays
  one line. dotenv judges every write by reading it back: a value it would read back changed
  (one already holding a literal backslash-n or backslash-r, a quote followed by `#`, or a
  trailing backslash that runs into the next line) throws, naming the key and never the value.
  That judge is `assertEnvReadsBack(content, values)`: `envLine` and `serializeEnv` run it, and
  a writer that rewrites lines inside an existing file runs it on the whole file before writing.
  Such a writer finds a key's lines through devkit's `setEnvLines` ([devkit](../devkit/index.md)),
  never a regex of its own.
- **Defined at the source, resolved at runtime/build**: a brand-wide `GH_TOKEN` lives once
  in the brand `.env`; every framework CLI/build resolves the chain at boot
  (`loadEnv(process.cwd())` in the web/desktop/extension CLIs + gulp pipelines,
  `loadEnv(functionsDir)` in the @omega.js/backend CLI and runtime). Nothing is copied
  between `.env` files just to be visible.
- **The brand root's `.env` is the ONE file humans and the manager edit**
  ([#678](https://github.com/Omega-JS-Stack/omega/issues/678)). A target's own `.env` is
  optional and overrides PER KEY, by hand; no machine ever writes one.
- **Backend's local layer is the target-root `.env`** (`targets/backend/.env`) — the layer a
  human uses to override one key for that surface. What physically ships is the STAGED
  `dist/.env`: it rides the Firebase deploy artifact (the cloud can't walk up), so every verb
  that produces one (`omega build`, `dev`, `test`, `deploy`) composes it from the file layers,
  filtered by the env schema. In the cloud the walk finds no brand/company and behavior
  is identical to plain dotenv. Firebase reads the staged `dist/.env` too, with its own
  reader, which decodes backslash codes that dotenv leaves alone. So a value holding a
  backslash before `n`, `r`, `t`, `v`, a backslash or a quote, or before a line break, is
  refused at staging (`assertFirebaseEnvSafe` in the backend's `stage-functions.js`),
  naming the key and never the value.
- **The brand-generated keys are the manager's to mint** — `OMEGA_ADMIN_KEY`,
  `OMEGA_WEBHOOK_KEY`, `OMEGA_NAMESPACE` and `UNSUBSCRIBE_HMAC_KEY` have no dashboard
  behind them, so the onboard stub writes them for a fresh brand and the workspace
  service's `env-keys` step mints any the cascade doesn't serve on every manage
  ([#569](https://github.com/Omega-JS-Stack/omega/issues/569)). The env schema below is
  the one list feeding both, a company-served value is never shadowed by a brand-level
  one, and nothing prints a minted value.
- Missing files and unreadable/stale markers skip silently — `loadEnv` never throws for
  an absent layer.

## The env schema (`src/env-schema.js`) — #581

The omega.json5 schema's sibling: ONE inventory of the env keys OMEGA needs — who owns
each, which targets read it, whether OMEGA mints it or a human pastes it from a third
party, whether it is required, and what it does. Everything that used to hand-keep its
own list derives from it, so a new key is **one entry**, never four edits.

```js
{
  name:        'OMEGA_ADMIN_KEY',      // the env var (SCREAMING_SNAKE)
  match:       /^CONNECTIONS_.+$/,     // …or a pattern, for dynamic families
  owner:       'workspace',            // the manager service that owns it
                                       // ('backend' = the framework itself)
  targets:     ['backend'],            // the targets whose runtime READS it
  group:       'omega',                // its ENV_GROUPS bucket (.env file order)
  generated:   () => randomBytes(32)…, // the function that MINTS a value
  default:     'value',                // …or a static default, where one applies
  secret:      true,                   // never printed, never in omega.json5
  required:    true,                   // absent = the backend refuses to boot
  delivery:    { backend: 'env' },     // per target, HOW the value gets there
  requiredWhen: holds('captcha.providers.recaptcha.siteKey'), // the config now depends on it
  askedWhen:   asks({ captcha: onUnlessOff('captcha.providers.recaptcha.enabled') }), // per asking service
  publicAtRest: true,                  // sanctions a 'bake' (readable in the artifact)
  machineLocal: true,                  // this machine's fact — never published to CI
  label:       'Snap Store credentials',       // the human name an ask opens with
  url:         'https://snapcraft.io/account', // the page that MINTS it
  hint:        'Run `snapcraft export-login -`', // how to get it there
  description: 'What the key drives.',
}
```

- **`label`, `url` and `hint` are the human half, and this schema is their one home**
  ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)). The manager's REQUIRES
  registry used to carry a second copy per service, which is how every desktop signing key
  and every extension store key ended up with a mint page in NEITHER place: no service
  declared them, so nobody could be asked for them. `serviceInputSpec` fills each ask from
  here now, and the registry keeps only its own fields (the reason shown, the gate's label,
  where Disable writes `false`, whether the ask is pasted mid-run, whether it gates, the
  Google scopes): no key name and no "when". `url: null` is a deliberate statement that
  no page mints the value, and such an entry owes a `hint` saying where it does come from.
  The sweep test (`packages/manager/test/service-input.test.js`) holds the line: no
  label/url/hint in the registry, a label on every pasted key, and a url (or an explicit
  null plus a hint) on every one that is not machine-local.

- **`generated:` is the mint switch.** Those keys have no dashboard behind them, so the
  manager writes them into a brand `.env` — at onboard, and on every manage that finds
  one missing. Everything else is a credential a human provides.
- **Only a key OMEGA can produce may be `required`.** Refusing every boot over a secret
  nobody can mint would be a hostage note, not a guard — the config test pins it.
- **`targets:` is the composition domain.** Every verb composes its target's RUNTIME env
  (the backend's staged `dist/.env` — the only artifact that ships and so cannot walk up to
  the brand layer) from the file layers, taking the entries whose `targets` name that
  target. The schema is the only filter on DECLARED keys: no hand list, and PATTERN entries
  (`match:`, e.g. the `CONNECTIONS_*` family) compose exactly like named ones. A key the schema
  names for other targets never reaches this one, so a desktop signing key stays out of the
  functions upload. A key the schema does not know AT ALL is the consumer's own
  ([#835](https://github.com/Omega-JS-Stack/omega/issues/835)): it names no target to be
  filtered by, so a custom line in the brand root `.env` (or its `.env.production` overlay)
  composes for EVERY target, and a consumer who wants one on a single target puts it in
  that target's own `.env`, which passes unfiltered anyway. An edge worker's `secrets[]` key
  ([manager/edge.md](../manager/edge.md)) is such a custom key: it reaches every deploying
  target's secrets, not only the worker. Other targets read brand values through the cascade above at runtime,
  so nothing is written for them.
- **`deliverAs:` renames on delivery**: the entry's brand-level name is what the cascade
  carries (`GOOGLE_ANALYTICS_SECRET_BACKEND`), and the target receives it under the name
  its own code reads (`GOOGLE_ANALYTICS_SECRET`). One entry, both names.
- **`delivery:` says HOW a value reaches each target**
  ([#627](https://github.com/Omega-JS-Stack/omega/issues/627)): `'env'` (read from the
  composed `.env` at runtime — the backend), `'ci'` (the generated workflow injects it
  into the runner env for the build step), or `'bake'` (the build writes it into the
  shipped artifact, because the installed app runs with no `.env`). A bake implies the
  CI injection — the workflow delivers the value the build then bakes. One renderer in
  `@omega.js/config/env-delivery` derives everything from these declarations: each
  target's workflow secrets block, its bake list, and its publish-step secret set. No
  hand-kept `${{ secrets.KEY }}` list survives anywhere.
- **The delivered set is the schema PLUS what only the composed env can name**
  ([#835](https://github.com/Omega-JS-Stack/omega/issues/835),
  [#876](https://github.com/Omega-JS-Stack/omega/issues/876)). `deliveredKeys(target, modes,
  { values })` is the ONE primitive every list derives from, and the composed production
  values it takes add two kinds of key the schema cannot name: a `match` FAMILY member (the
  schema knows `CONNECTIONS_<PROVIDER>_CLIENT_ID` as a shape, so only a brand's own `.env`
  says which providers exist), and a CUSTOM key the schema never declared. A custom key
  travels in its target's FILE mode: on the backend it is written into the `.env` the runner
  builds, like an `env` delivery; on web, desktop and the extension it reaches the runner env
  only, like a `ci` one. `machineLocal` keys and declared keys this target does not deliver
  stay home exactly as before, and neither a `WORKFLOW_OWNED_KEYS` name (the template
  declares those itself) nor a `GITHUB_`-prefixed one (GitHub refuses that prefix as a
  secret name) is ever taken from a composed set. Both halves of the backend workflow (the
  injected block and the `.env` writer's key list) render from that one set, so they cannot
  disagree inside a run.
- **`env` on a NON-backend target declares the laptop's composed `.env` as the channel**
  ([#819](https://github.com/Omega-JS-Stack/omega/issues/819)). The workflow renderer walks
  `ci` and `bake` only, so such a key renders no workflow line, reaches no runner and is
  published as no repo secret: it is read where the developer runs the build.
  `OPENAI_API_KEY` is the case that made it explicit (`{ web: 'env', backend: 'env',
  extension: 'env' }`), because translation runs locally and CI reads the committed cache
  ([#905](https://github.com/Omega-JS-Stack/omega/issues/905)).
- **A workflow block carries `ci` + `bake`, except the backend's, which carries `env` too**
  ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)). Everywhere else the artifact holds its values inside itself and reads
  no env file, so the CI half is the whole block. The backend's deployed artifact ships a
  COMPOSED `.env`, and its deploy runs on a runner with no brand checkout to compose one
  from, so its workflow writes that file out of the runner env: every `env` delivery has to
  be up there to be written. `WORKFLOW_MODES` in `env-delivery.js` is the one home of that
  exception; `DEFAULT_WORKFLOW_MODES` is every other target. Riding with it is
  **`OMEGA_SERVICE_ACCOUNT_JSON`** (`delivery: { backend: 'ci' }`), the deploy credential as
  the key file's own CONTENTS: it is a FILE on every other lane (minted into the brand's
  `.omega/secrets/`, staged into `dist/`), so it renders no brand `.env` line, and the
  backend's precheck values it from that authored chain instead of from a composed env.
  Riding beside it: **`OMEGA_LICENSE_KEY`** (`ci` on all four targets now), because the
  license check runs inside the deploy and the backend's deploy runs on a runner too.
- **`ci` is what keeps a key out of an artifact's `.env`.** The two lanes that write a
  backend `.env` read that one declaration: `envFileKeys('backend')` (the generated key
  list the workflow's writer reads out of the runner env) takes the `env` deliveries only,
  and `artifactEnvValues('backend', values)` strips every `ci` key out of the COMPOSED
  values before the stage serializes `dist/.env`. The composer itself resolves a value for
  everything the target claims, `ci` included, because the secrets publisher has to value
  what it publishes from the same cascade as everything else: the artifact is the narrower
  half, and those two functions are where that is said.
- **A baked key is public at rest.** Anyone who unpacks the app can read it, so a
  `secret: true` entry may only bake when it also declares `publicAtRest: true` — the
  renderer THROWS otherwise, on every lane, so a real credential can never reach an
  artifact by accident. The GA Measurement Protocol secrets are the sanctioned baked keys.
- **`machineLocal: true` marks this machine's own facts** (`OMEGA_FONTAWESOME_ROOT`):
  composed locally like any key, but filtered out of every rendered block and every
  published secret set — a laptop path has no business in CI.
- **Two "when" facts, two questions.** `requiredWhen` says the brand's config now
  depends on the key, so a deploy, a bake or a production start refuses without it.
  `askedWhen` says the feature is on, so `omega manage` asks for the key, and the person
  may skip. They differ on purpose: the Sentry token is ASKED once Sentry is the chosen
  monitor, because the manager creates the Sentry project with it, and REQUIRED only once
  the config holds that project's DSN. Presence only, never a value-shape check, and
  one-directional.
- **Both are written with the named rules of `src/env-when.js`**, so the key list reads as
  plain statements and no caller writes a test of its own:

  | Rule | Holds when |
  |---|---|
  | `holds(path)` | the config path holds a value |
  | `onUnlessOff(path)` | the switch is not `false`, at the path or any section above it: absent means on |
  | `chosen(path, name)` | the provider is the chosen one: a `providers` map picks by presence, a plain value by equality (`chosen('monitoring.providers', 'sentry')`) |
  | `hasTarget(...types)` | the brand declares a target of one of those types |
  | `ships(platform, format)` | a desktop target ships the format: on by default, so it holds until `platforms.<platform>` or `platforms.<platform>.formats.<format>` is `false`, judged per target view |
  | `signsWith(strategy, provider)` | a desktop target ships `windows.nsis` and signs it with that strategy, the default (`self-hosted`) included when none is written. With a provider, that same target also names it at `platforms.windows.signing.cloud.provider`, and the rule prints as `platforms.windows.signing.cloud.provider=<provider>` (`signsWith('cloud', 'azure')`) |
  | `realProject()` | `cloud.config.projectId` is not a `demo-` id: a demo project is local only, so the cloud service asks for nothing there. No id yet is "not chosen", not demo: the cloud service asks for the Google client so it can pick one |
  | `all(...rules)`, `any(...rules)` | every rule, or one of them |
  | `asks({ service: rule })` | the shape of an `askedWhen`: any service asks; `.services` keeps each service's own rule |

- **`askedWhen` maps each asking service to its rule** (`asks({ edge: …, domain: … })` for the
  Cloudflare token), because one key can serve several services. Only the cloud service's
  ask of the Google client needs `realProject()`; analytics, search and advertising ask on
  their own switches. A key only the backend
  reads is asked only of a brand with a backend target. A key whose ask honours a switch
  narrower than its service's (one payment provider, one pixel platform) is optional, and
  Disable turns off that narrower switch.
- **The ship keys are neither.** What a store or signing format needs is the format table in
  `src/platforms.js` (see the shipping declaration above), never a second copy on each key.
- **`missingEnvKeys(config, env, { target, verb })` (`src/env-needs.js`) is the ONE answer to
  "which keys is this brand missing".** It returns `[{ key, need, service, path, text }]`,
  where `need` is `required`, `asked` or `ship`, `path` is what requires the key (the
  config statement, or the declared format for a ship key; null for a key every brand
  owes), `text` is the one line a refusal names it by (`KEY (required by <path>)`, then the
  rule's `note` when it has one: a default format's says it is on until set to `false`), and a
  ship row also carries its format's `label`. Every caller decides only what a miss costs.
  Three helpers beside it: `baseMissingKeys(env, { target, verb })` (what EVERY brand owes:
  the rows an empty config returns, the backend boot guard's and fixture env's answer),
  `missingConfigKeys` (what THIS config adds beyond that) and
  `serviceAskedKeys(config, service)` (the keys `manage` asks of one service, as a set):

  | Verb (`ENV_VERBS`) | Answers | Who calls it |
  |---|---|---|
  | `onboard`, `dev`, `start` | `required` | the backend boot (production refuses, development warns) |
  | `build` | `required`, only the keys a target BAKES | the desktop and extension bakes (build mode throws, development warns) |
  | `deploy` | `required`, only the keys DELIVERED to the target | the deploy's secrets precheck (refuses), the manage walk's `env-rules` op (warns), desktop `validate-certs` |
  | `manage`, `status` | `asked`, one row per asking service, plus the ship keys the declared formats need (asked by `publishing`) | the manage preflight, every service's setup gate |
  | `publish` | `ship`, from the format table | the desktop and extension publishes, the manager's `publishing` service |

  A key read only by targets the brand lacks is never required, and a key present under its
  delivery name (`GOOGLE_ANALYTICS_SECRET` for `GOOGLE_ANALYTICS_SECRET_BACKEND`) counts as
  present. The manage walk's `env-rules` op judges each enabled target's resolved config,
  and judges a TARGET-LESS key (`SENTRY_AUTH_TOKEN`) against the brand root and every
  target view, since the monitoring service lands one DSN per surface. Misses name the
  BRAND-level key, the one a human sets in the brand `.env`.
- **The four Disable switches without a provider block are declared**: `cloud.enabled`,
  `domain.enabled`, `analytics.enabled` and `captcha.providers.recaptcha.enabled`. Each is
  what its service's gate writes `false` to; absence means on, and no default is
  materialized.
- **Nothing is CLEARED, because nothing is written into a hand file**
  ([#636](https://github.com/Omega-JS-Stack/omega/issues/636),
  [#678](https://github.com/Omega-JS-Stack/omega/issues/678)): the composed artifact is
  rebuilt from the cascade every verb, so a credential the brand root retires stops being
  served the moment it is dropped.
- **`group:` picks the .env section**, and `ENV_GROUPS` owns the file order plus each
  section's comment. A group marked `file: false` (the `runtime` group) never reaches a
  brand `.env` at all — those keys resolve some other way (from config at boot, from the
  developer's own shell), so they are neither rendered as placeholders nor composed.
- **Runtime/platform vars are NOT in the schema**: `FIREBASE_CONFIG`,
  `FUNCTIONS_EMULATOR`, `GCLOUD_PROJECT`, the `OMEGA_*_PORT` map, the test-mode
  switches. They are the runtime's facts about itself, not a brand's credentials, and
  the frameworks read them directly.

### One key, one entry — the environment supplies the value — #586

A key whose value must differ between a local run and a deployed one is **not a second
schema entry**. Public payment keys already split per machine through the config merge
chain's local layer; secrets now split the same way through the `.env` cascade's
environment overlay above — the brand puts the test credential in `.env.development`
under the SAME name. The backend uses whatever key the env chain resolves, nothing more:
the rule, and the `.env.development` advice that follows from it, live in
[docs/backend/index.md](../backend/index.md) (the payment-keys paragraph).

The schema declares WHAT a brand supplies, never which environment supplies it: `env.js`
owns that. So `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_SECRET`, `CHARGEBEE_API_KEY` and
`COINBASE_COMMERCE_API_KEY` (asked for through the setup contract, #608, only when
`payment.providers.coinbase.enabled` is on) are one entry each, every provider library
reads the one name, and there is no `<KEY>_DEV` twin, no live-shape guard, and no
payment-specific rule anywhere (ruled 2026-08-26; the twin system was replaced before it shipped, so
nothing migrates).

### One key per AI provider — #639

`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. There is no second name for either.

| Key | Owner | Read by | Asked at |
|---|---|---|---|
| `OPENAI_API_KEY` | `backend` | Contact inference, content + newsletter generation, the `chatgpt` translation provider | `manage` — the `ai` service's setup gate |
| `ANTHROPIC_API_KEY` | `backend` | The backend's Anthropic provider (SVG generation, tool loops) | `manage` — the `ai` service's setup gate |

- **The company-wide fallback is the COMPANY LAYER, never a second key** (Ian
  2026-08-27). The legacy pair (`BACKEND_MANAGER_OPENAI_API_KEY`, then
  `OMEGA_OPENAI_API_KEY`) existed so one company key could serve every brand; the
  `.env` cascade already does that — put the value in the company `.env` and every
  brand under it resolves it, with a brand `.env` overriding. The prefixed names are
  gone from the schema and every reader; migration row in
  [breaking-changes.md](breaking-changes.md).
- **Both are optional and neither gates a run.** The `ai` service declares them
  `gates: false`, so preflight never blocks on them and a brand that calls one
  provider is never nagged about the other. `ai.enabled: false` (what the gate's
  Disable lands) stops the ask for good.

Who derives from it:

| Lane | What it takes |
|---|---|
| `@omega.js/manager` workspace `env-keys` + the onboard `.env` stub | `generatedEnvKeys()` — name → the function that mints a value |
| `@omega.js/manager` `lib/env-order.js` (the brand and company `.env` marker template) | `envFileGroups()` + `envKeysByGroup()`: the groups of the `Default Values` section, their comments, their keys |
| `@omega.js/config` `composeTargetEnv()` (the delivery composition every verb runs) | `ENV_SCHEMA` + `envFileGroups()`: a DECLARED brand key rides down when its entry claims it (by `name` or by `match`), its `targets` include the target, and its group renders into a file; a key no entry knows at all is the consumer's own and rides down to every target ([#835](https://github.com/Omega-JS-Stack/omega/issues/835)); `deliverAs` is applied on arrival, and each layer's `.env.<environment>` overlay composes above its own base (#586) |
| `@omega.js/config` `envKeysForTarget(target)` (the rendering lane's list) | `ENV_SCHEMA` + `envFileGroups()` — the NAMED keys a target reads, which placeholders a brand `.env` carries |
| `@omega.js/backend` `libraries/env.js` (the one reader) | `envSchemaEntry()` for every read, `baseMissingKeys(…, { verb: 'start' })` for the boot guard, and `getEnvironment()` re-exported under its own name ([docs/backend/index.md](../backend/index.md)) |
| `@omega.js/manager` `lib/scaffold.js` (the onboard stub) + `lib/gitignore.js` (the brand `.gitignore` template and its heal) | `ENV_ENVIRONMENTS`: one empty `.env.<environment>` per name, and the `.env.*` ignore |
| `@omega.js/config` `env-delivery.js` (the one delivery renderer) | `delivery` + `deliverAs` + `machineLocal` + `publicAtRest`, plus the target's COMPOSED production values for the keys the schema cannot name (`match` families and custom keys, #835/#876): each target's workflow secrets block, bake list, and publish-step secret set; web and extension render their workflow token from it, desktop's ensure-target template pass does the same, backend's composed `deploy.yml` renders both its secrets block and the KEY LIST its node `.env` writer reads out of the runner env ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)), and all secret publishers send exactly its set |
| `@omega.js/config` `env-needs.js` (`missingEnvKeys`, the one answer) | `targets` + `delivery` + `deliverAs` + `required` + `requiredWhen` + `askedWhen`, and the format table for the ship keys: what every verb's caller acts on, each at its own severity |

## The environment (`src/environment.js`), #817

`src/environment.js` is the ONE environment module every OMEGA target answers
from ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)). Four calls,
one implementation, one call form everywhere: `getEnvironment()` plus
`isDevelopment()` / `isProduction()` / `isTesting()`, called directly by every
framework's `omega` instance and build module. It requires NOTHING, so it is bundled into browser
artifacts (the desktop renderer, every extension bundle) and vendored into
`@omega.js/client`, which reaches the same four through its own methods.

**ONE INPUT.** On Node it is `process.env.OMEGA_ENVIRONMENT`. In a browser
context, which can read neither env nor files, it is `config.environment`, the
build fact every surface already bakes into `OMEGA_BUILD_JSON.config`
([#896](https://github.com/Omega-JS-Stack/omega/issues/896)), reached as
`this.config.environment` off the instance the call is made on. Nothing else is
consulted: no `app.isPackaged`, no `manifest.update_url`, no `NODE_ENV`, no
terminal sniffing.

**NO DEFAULT.** A context with no input throws and names the variable. A guessed
environment is how a dev build ships as production and how a production build talks
to an emulator, and both failures stay silent until a user finds them.

**`setEnvironment(value)` is the only writer in a running process**, so a fourth
word can never reach the variable. A lane that spawns a child names it instead in
the child env object it builds, as a literal one of the three. Who names it, and
with what:

| Lane | Names |
|---|---|
| `@omega.js/backend`'s boot (`initialize()`, right after the `.env` cascade loads) | `envEnvironment()`, the AMBIENT answer (below) |
| `@omega.js/desktop` / `@omega.js/extension` `src/build.js`, at load | `buildLaneEnvironment(isBuildMode())`: `production` under `OMEGA_BUILD_MODE` (which WINS over an inherited value, so a production build spawned from a test run still bakes production), else an already-named value, else `development`. That rule is ONE exported helper beside `setEnvironment`, not a copy of the expression per framework, and those two build lanes are its only callers |
| `@omega.js/desktop`'s main process, at `initialize()` | the `environment` its baked config carries, for a packaged app that has no parent lane |
| `@omega.js/web`'s verbs | `production` for `omega build`, `development` for `omega dev`, `testing` for `omega test` |
| the desktop test runners, the extension `test` verb | `testing` |
| `@omega.js/backend`'s `omega test` (the runner child) and emulator (the Functions child), in the child env object | `testing` |

`envEnvironment()` (in `src/env.js`) is the PRODUCER of that input, never a
second reader of it: it is the sniff a lane runs ONCE to decide what to set, and
the default for the two overlay selections (`.env.<environment>` and
`config/omega.<environment>.json5`). An already-set `OMEGA_ENVIRONMENT` wins
inside it too, so the producer and the reader can never disagree in one process.

## Owner hooks (`config/hooks/`) — cp91

`src/hooks.js` — owner-supplied code the frameworks call at named hook points, so
company-specific logic lives in the OWNER'S tree, never in framework source. Layout is
**nested, mirroring the call site** (Ian's directive): the account service's password
step loads `config/hooks/account/password.js`; a future onboarding hook would live under
`config/hooks/onboard/…` — one file per hook point, path = the invoking structure.

- **Home = `config/`, versioned by default** (Ian 2026-07-11): hooks are AUTHORED code
  and sit with the other owner-authored omega inputs (omega.json5, seo.json5, chatsy.md,
  …) — never under machine-owned, gitignored `.omega/`, where a hook lost on a fresh
  clone would silently change behavior (passwords falling back to the seed channel and
  rotating). Secrets still belong in `.env` — a hook that needs one reads `process.env`;
  to keep a hook out of git anyway, add your own `config/hooks/` ignore line.
- **Resolution order**: the brand root's own `config/hooks/<point>.js`, else the company
  tree's `company/config/hooks/<point>.js` (via `company: { id }`, #677): a company-wide
  hook covers every brand, a single brand can still override it. It is the ONE inheritance
  rule applied to one more relative path, and costs the hook loader no code of its own.
- **Contract**: plain CJS, `module.exports = ({ … }) => …` (async fine). Each call site
  documents its hook's signature/return. Absent hook → `loadHook` returns null and the
  caller uses its default behavior; a hook that EXISTS but is broken (unloadable,
  non-function export, bad return) throws — an owner who wrote a hook never gets silent
  fallback.
- **First (and so far only) hook point**: `account/password` —
  `({ email, domain, apex, brand }) => password` (string ≥ 6 chars), letting a company
  formula generate per-brand passwords without ever living in a repo the framework ships.

## Port auto-allocation (N7)

`src/ports.js` — classic defaults, probe at boot, per-port +1 bump only when taken, so
multiple brands run dev stacks concurrently. Single-brand dev with free defaults is
byte-identical to the pre-N7 behavior (no bumping, no artifacts).

- **`CLASSIC_PORTS`** — the historical defaults (functions 5001, hosting 5002, firestore
  8080, auth 9099, database 9000, storage 9199, pubsub 8085, ui 4050, website 4000,
  livereload 35729, cdp 9222), plus `hub: 4400`, firebase-tools' own emulator-hub
  default, shared by every stack on the machine rather than allocated per run (the
  backend's orphan sweep and its hub locator read it here). **This map is the ONLY source of those numbers**
  ([#834](https://github.com/Omega-JS-Stack/omega/issues/834)): @omega.js/client
  carried four of them plus a classic dev origin, @omega.js/desktop's url-helpers
  and the desktop auth lib three more, and @omega.js/extension's url-helpers and
  background worker two, each as a last-resort fallback "for a build made with no
  stack up". Every one of those is gone. The numbers reach a browser exactly one
  way: each surface bakes the map into its build json with the classics as the
  FLOOR and the live stack's resolved (possibly bumped) numbers over them, so a
  dev artifact always carries a COMPLETE map and the classic dev ORIGIN rides it
  the same way. A read that finds no map throws `devFactMissing()`
  (`src/dev-facts.js`, the one home of that error), naming the fact it wanted and
  the build step that writes it: a missing map is a broken build, and nothing
  anywhere assumes a port again. Nothing identity-checks what answers on a
  classic port, which is why an assumed one failed as an auth mystery or a silent
  connection refusal rather than as a port problem.
- **`resolvePorts({ wanted, pins, claimed })`** — each wanted port keeps its value when
  free, bumps +1 until free when taken (shared `claimed` set prevents two names landing
  on one port). `pins` (the config `ports` section) never bump — a busy pin throws.
  The free-check is a QUADRUPLE bind-probe (127.0.0.1, ::1 when the host has IPv6,
  the IPv4 wildcard 0.0.0.0, and the `::` wildcard) — on macOS/BSD, wildcard and
  specific-address listeners COEXIST on one port, and the two wildcard FAMILIES
  coexist with each other, so any single-surface probe false-positives against a
  sibling brand's stack and the real bind crashes later (found live at cp186: the
  playground's https proxy holds IPv6 `*:5002`; a 127.0.0.1-only probe handed 5002
  to the second brand's functions emulator — and again at #345: a foreign `0.0.0.0`
  squatter read free to the `::` probe and the auth emulator died with no bump).
- **Ports file** — `writePortsFile(projectDir, ports, facts)` /
  `readPortsFile/clearPortsFile(projectDir)`: `<projectDir>/.temp/ports.json`
  (pid-stamped; readers ignore dead-pid leftovers). The allocator (the backend emulator
  boot) writes it; siblings of the same brand (`omega test` against a running emulator,
  the e2e harness) read it; cleared on clean shutdown. `facts` publishes the resolved
  NON-port facts beside the map — today `origin`, the website's dev origin
  ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)).
  A consumer process targets `https`, the PUBLIC origin under the local certificate,
  and never `hosting`, the internal plain-http port the mkcert proxy forwards to; every
  `omega dev` leg trusts that certificate through `NODE_EXTRA_CA_CERTS` ([#795](https://github.com/Omega-JS-Stack/omega/issues/795)).
- **Sibling map** — `readSiblingPorts(targetDir)` merges every OTHER target's live ports file
  in the same brand (a running backend's emulator map) for the target that asks;
  `readSiblingOrigin(targetDir)` reads the published dev website origin the same way. Read
  at USE time, never cached: the file appears when the backend boots and changes when it
  restarts.
- **Env channel** — `portsToEnv(ports)` → `OMEGA_<NAME>_PORT` vars injected into spawned
  children; `envPort(name)` reads one, `envPorts(env)` reads the whole map back out.
  The name (`envName()`) and the positive-integer check (`parsePort()`) live in the
  browser-safe `src/dev-facts.js`, re-exported here, so the browser chain below reads
  env the same way.
- **Browser channel (cp89, [#300](https://github.com/Omega-JS-Stack/omega/issues/300))** —
  browser code can read neither env nor files, so a surface BAKES the map into its
  client config, under the same key on all three (`OMEGA_BUILD_JSON.config.dev`, #894):
  `omega dev` writes that line into the page chrome
  PER RENDER (its resolved website port with the sibling backend's map merged over it),
  and its auth-emulator proxy resolves the target port per REQUEST. The render-time
  bake is ADVISORY ([#346](https://github.com/Omega-JS-Stack/omega/issues/346)): the
  dev server REWRITES that chrome in every HTML response as it serves it, resolving the
  sibling maps per request, because the normal boot order builds the whole page fleet in
  under a second while the emulator suite seeds for minutes — nothing under `src/`
  changes when it lands, so no page would ever re-render onto it. Mid-session emulator
  restarts onto bumped numbers ride the same lane. Built `dist/` output is untouched on
  disk. Desktop (its renderer bundle) and extension (every bundle) bake the same map at
  the same key at build time, from the sibling file plus the env channel; production
  builds bake none. Drivers serving a
  STATIC build set `window.__OMEGA_DEV_PORTS__` (the devkit e2e harness — the site
  builds before the emulator boots), which is a FALLBACK: it fills only what a page's
  chrome omits, so a side channel no real browser has can never hide a broken real one.
  The dev WEBSITE ORIGIN rides the same map as one more resolved fact
  ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)): `omega dev` publishes
  `dev.origin` (protocol AND port — the mkcert proxy fronts the public port by default,
  so a port number alone cannot say the scheme) into the chrome and into its ports file,
  and desktop/extension bake it from that file on their existing lanes, with
  `CLASSIC_DEV_ORIGIN` as the floor under it (#834) so the key is always present.
  The extension manifest's `externally_connectable` dev entry resolves from it at
  package time; nothing hardcodes a dev origin any more.
  `@omega.js/client`'s `getDevWebsiteOrigin()` is the one getter that answers it,
  and it THROWS when the artifact carries none rather than assuming
  `https://localhost:4000`, because a wrong dev origin fails as a silent
  connection refusal.
  `@omega.js/client` resolves chrome `dev.ports` → runtime global, and THROWS when
  neither answers ([#834](https://github.com/Omega-JS-Stack/omega/issues/834)):
  there is no classic-defaults step under them any more, and no
  "assuming the classic …" warning, because nothing is assumed. Its dev
  `getApiUrl` speaks plain http to a mapped `hosting` (the emulator serves http)
  and https to a mapped `https` (`mgr serve`'s mkcert proxy); neither mapped is
  the same loud error. Dev mode
  resolves the LOCAL stack for every source, including `source: 'company'` —
  `company.url` is a production concept, and dev deliberately makes no live server
  hits (ratified, Ian 2026-08-03, [#34](https://github.com/Omega-JS-Stack/omega/issues/34)).
- **The local port chain**: `@omega.js/client/modules/dev-ports.js` is its ONE home,
  browser-safe and instance-free. It reads `OMEGA_<NAME>_PORT` (Node-side contexts
  only), then the `dev.ports` map it is given, then throws `devFactMissing()` naming the
  caller's writer, and it builds the local URLs on that port with one host rule: the
  mkcert proxy (`https`) answers `https://localhost:<port>`, the name its certificate
  carries, and every plain-http emulator (the `hosting` API, functions, auth) answers
  `http://127.0.0.1:<port>`, because `localhost` can resolve to `::1` in Node and miss an
  emulator bound to `127.0.0.1`. The client base class calls it with the map
  `_providedDevPorts()` builds (chrome over `window.__OMEGA_DEV_PORTS__`);
  @omega.js/desktop's and @omega.js/extension's `utils/url-helpers.js` call it with
  their baked map and their own writer, and keep no copy of their own.
- **Website port (cp89)** — `omega dev` allocates through the same model: classic
  **4000** (pre-N7 it defaulted to 8080, colliding with the SAME brand's firestore
  emulator), bump when taken, `--port` flag or config `ports.website` pins; publishes
  its own ports file in the website target dir.
- **Serve + per-target ports (cp90)** — `mgr serve` allocates through the same model
  (`--port` pins, taken bumps — the old kill-the-incumbent check is gone) and PUBLISHES
  its map: `https` (the mkcert proxy) + `hosting` (the internal plain-http
  firebase-serve port), so `omega dev` bakes even a bumped serve into the chrome and
  Stripe webhook forwarding targets the port that actually speaks http (it used to aim
  plain http at the TLS proxy). Desktop + extension `serve` allocate `livereload` — two
  targets of one brand land on distinct ports — and desktop allocates `cdp` when
  requested (`OMEGA_CDP_PORT` set); desktop URL getters mirror the backend's
  env-channel reads (`https` → mkcert, `hosting` → plain http, classic otherwise).
  The manager's Google-OAuth loopback binds an EPHEMERAL port (`listen(0)`, RFC 8252)
  instead of pinning 9876. The backend's `getWebsiteUrl` returns
  `http://localhost:4000` unless its own mkcert proxy is up (plain http on the public
  port 307s to https, so the link lands either way); desktop's reads the whole dev
  ORIGIN instead (baked `dev.origin`, then `OMEGA_WEBSITE_PORT` composed over https,
  then the classic `https://localhost:4000`), matching the browser-side answer scheme
  and all ([#747](https://github.com/Omega-JS-Stack/omega/issues/747)). The BROWSER-side answer
  is `getDevWebsiteOrigin()`, which needs the exact origin and takes it from the
  resolved map (#262). Packaged
  extension/desktop artifacts keep BUILD-TIME-BAKED ports by design (a shipped
  extension can't probe); the extension manifest's dev-website origin documents that
  inline.
- **Config `ports` section** (schema, optional object) — explicit pins for any port name;
  unset = auto-allocate.
- When a boot bumps emulator ports, the backend CLI materializes
  `firebase.resolved.json` next to firebase.json (same dir, so relative paths keep
  resolving) and boots firebase-tools with `--config`; the committed firebase.json never
  changes. Gitignored; removed on shutdown.

## Validation

`validateConfig(config, { target })` = shared schema + that target's refinements
(`TARGET_SCHEMAS[target]`), run against the RESOLVED config. `brand.id` (URL-scheme-safe
slug) and `brand.name` are the only universally required fields.

**The schema is STRICT: an undeclared key is an ERROR** ([#859](https://github.com/Omega-JS-Stack/omega/issues/859)).
Every leaf path of the resolved config that no rule declares fails the load, ONE error line
per path, so a brand sees each key it has to move or delete:

```
config.<path> is not a key the schema declares. Remove it, or if it is a legacy key run `npx omega migrate` at the brand root (report) and `--execute` to convert (docs/shared/config.md → Validation)
```

The line has one home, the validator's exported `undeclaredLine(path)`, and the loader prints
it for every file it reads, the `config/seo.json5` sidecar included: the loader reads that file
as its layer's `seo` section, so the sidecar meets the strict check exactly like the base file.

**A list with keys declared below it is walked item by item.** Rules spell an item's keys with
the list position left out (`seo.github.content.owner`), and the check walks each plain-object
item of such a list, so the reported path carries the position:
`config.seo.github.content[0].org`, the one spelling of a list position on every line (the
secret line, the strict line, the migrate report) and in the editor's path argument, where a
bare `.0` step is a key named `0`, never a position. A list with nothing declared below it (`payment.products`,
`account.admins`) stays one value, as do its items, and an item that is not a plain object
(a `purgecss.safelist` string) is never walked.

The validator knows only the present shape: a retired name fails exactly like a typo, with
no special message, and the brand-root `omega migrate` is the one code that knows what an
old name became (its tables are `@omega.js/manager`'s `src/migrate/`, see Migration below).
A key the code reads owes a rule; a key nothing reads is dead and goes. What stays OPEN:

- **A rule of type `object`/`array` opens its subtree ONLY when no rule is declared beneath
  it: a brand's postal `brand.address`, `brand.images`, the `connections` provider map,
  `payment.products`, `blog.providers`, `devlog.providers.ghostii`. A section
  with typed keys (`cloud.config`, `devlog`, `marketing`, `repo`, `seo.github`, `targets.web.meta`,
  `targets.desktop.platforms`, `releases`) is CLOSED, so a retired path or a typo inside it
  fails. `cloud.config` types every key the Firebase web SDK takes. Two bags are open
  beside typed keys on purpose, marked `open: true` on their rule: the @omega.js/client
  `client` settings bag and the manager's `edge.providers.cloudflare` engine data.
- **The documented override blocks** a brand hands a framework verbatim, each an open rule:
  `targets.desktop.electronBuilder` (merged over the generated electron-builder config),
  `targets.desktop.windows` (per-window BrowserWindow options), `targets.desktop.cdp`,
  `targets.desktop.fileAssociations`, `targets.desktop.protocols`, and the backend's
  `targets.backend.mcp.authUrl`.
- **The keys framework code writes**, never a brand: the `company.name` / `.url` / `.images`
  the loader fills (a staged compose output carries them on purpose, and the loader refuses a
  TYPED one in a brand or company file), and, only under `validateConfig(config, { decorated:
  true })`, the build facts a surface bakes (`runtime`, `environment`, `version`, `buildTime`,
  `target`, `dev`). The desktop boot and its build audit validate a baked config that way; an
  authored load declares none of them, so a brand typing one, or a typo under `dev`, fails.
- **The `targets` namespace, on a whole-file load**: a target entry's keys are judged by that
  target's OWN load, which hoists `targets.<name>.*` to the top level where the schema reads
  them. A custom target's keys are its own.

The `.env` layer is NOT strict: an `.env` may carry keys outside omega, and a key nothing
reads is simply unread.

**authDomain is the brand's own host** (cp268): when `cloud.config.authDomain` is set it
must equal the BRAND host, `brand.url`, for every target a brand runs
([#588](https://github.com/Omega-JS-Stack/omega/issues/588)): one Firebase project, one
backend, one authDomain. A target's own `url` is not read here (a
`targets/admin` load would otherwise fail its own brand's authDomain), and the
top-level `url` is only the fallback for a config carrying no `brand.url` at all. A
`*.firebaseapp.com` value hard-fails (self-hosted `/__/auth/*` on the brand
host is what keeps redirect sign-in working under browser storage partitioning; the web
build emits those helper files), and any other mismatch fails naming both values. Absent
passes, and `demo-*` (emulator-only) projects are exempt.

**A product price is a bare NUMBER** ([#674](https://github.com/Omega-JS-Stack/omega/issues/674)):
every entry of `payment.products[].prices` must be a number — `once: 49.99`, never
`once: { amount: 49.99 }` — and the object shape is a config ERROR naming the product and
the key. The two sides did not read it the same: the checkout page's resolver unwrapped
`{ amount: N }` while the backend's confirmation URL and all three provider libraries took
the bare number, so an object-shaped price rendered a correct order summary and reached
the confirmation URL as `[object Object]`. There is no shared resolver to settle it in —
the browser bundle cannot reach a build-time package, and the deployed backend runtime
carries none either — so the SHAPE is settled here, in the one place both sides' catalog
comes from.

**A one-time price is `once`, and only `once`** ([#849](https://github.com/Omega-JS-Stack/omega/issues/849)):
a one-time product writes `prices: { once: 49.99 }` and a subscription names its cadence
(`monthly`, `annually`, …). The checkout page and every backend reader take `once` alone,
so the validator refuses the legacy one-time spellings, naming `once`: `prices.amount` on
any product (it is no cadence) and any cadence key (`daily`, `weekly`, `monthly`,
`annually`: `SUBSCRIPTION_CADENCES`, the one list) on a one-time product. It refuses
`once` on a subscription too, naming the cadence keys. `npx omega migrate --execute`
moves an `amount` to `once` inside its own product; a cadence key on a one-time product
is renamed by hand ([breaking-changes.md](breaking-changes.md)).

## The features catalog (`features`) and a product's values — #647

A feature is **defined once**, at the top level, and a product names only its **value**.
The two halves cannot disagree, because there is only one place a name, an icon or a
definition can be written:

```json5
{
  features: {
    saves: {
      name: 'Saves',
      icon: 'fa-solid fa-feather',
      definition: 'Notes, clips, and pages you can save per month.',
      usage: { pace: 'daily', mirror: ['teams'] },
    },
    templates: { name: 'Page templates', icon: 'fa-solid fa-palette', usage: { pace: false } },
    support:   { name: 'Priority support', icon: 'fa-solid fa-headset', definition: 'Your tickets jump the queue.' },
  },

  payment: {
    products: [
      { id: 'basic',   name: 'Basic',   features: { saves: 100 } },
      { id: 'premium', name: 'Premium', features: { saves: 10000, templates: 40, support: true } },
      { id: 'pro',     name: 'Pro',     features: { saves: -1, templates: 120, support: true } },
    ],
  },
}
```

### The catalog

| Key | Type | What it does |
|-----|------|--------------|
| `features.<id>.name` | string, **required** | The label every surface prints: pricing rows, the comparison matrix, the account's usage cards |
| `features.<id>.icon` | string | Font Awesome icon name ([icons.md](icons.md)) |
| `features.<id>.definition` | string | The dotted-underline tooltip. Authored ONCE — every card, row and bar renders this one |
| `features.<id>.usage` | object | Its presence makes the feature **counted** (metered per user). Absent = a **perk**, never counted |
| `features.<id>.usage.pace` | `'daily'` \| `false` | Day pacing is the DEFAULT. `false` opts out to a plain monthly counter |
| `features.<id>.usage.mirror` | string[] | Document KINDS this feature's counters also land on, resolved from `user.owns.<kind>` — declared here, never at a call site |

**Key order is row order.** The pricing page's rows, the comparison matrix and the
account's usage cards all render the catalog in the order it is written.

### A product's values

`payment.products[].features` is a MAP of `<catalog id>: value`:

| The feature is | Its value is | Renders as |
|---|---|---|
| Counted | a number — the **monthly limit** | `100 Saves` |
| Counted | `-1` — unlimited | `Unlimited Saves` |
| Perk | `true` | a check, name only |
| Perk | a string | `24/7 Support` |
| Either | `false` (or absent) | nothing — the tier does not include it |

The validator fails **a number on a perk** (it would draw a usage card against a limit no
gate enforces) and **a perk value on a counted feature** (the gate would read it as zero,
so the plan advertises the feature and every call refuses it). It also fails a value on an
id the catalog does not define, because nothing reads it — the same silence a retired key
used to buy.

### What this replaces

`payment.products[].limits`, the per-product `features` ARRAY, and the product-wide
`rateLimit` are **retired**. The ARRAY is a validation error naming its replacement;
`limits` and `rateLimit` sit inside the open `payment.products` subtree, so the loader does
not judge them and the brand-root `omega migrate` is what names both.
The cross-product definition BACKFILL retires with them: nothing repeats, so nothing needs
unifying. The mapping is in [breaking-changes.md](breaking-changes.md).

### Top-level `usage` is reserved

`usage` at the top level is reserved for **counting settings** (an anonymous-store mode, a
reset hour) and carries **no key today**. It is not a second home for the catalog. The
backend's gate reads `features`; how a user's counters behave is
[docs/backend/usage-rate-limiting.md](../backend/usage-rate-limiting.md).

## User connections (`connections`) — #771, #788, #792, #793

Every key under `connections` is a PROVIDER a brand's users may link from the account page
— `google`, `discord`, `spotify`, `twitch`, `kick` ship with `@omega.js/backend`, and
any other one is a file the brand writes at `targets/backend/src/connections/<name>.js`
(the lane loads that directory before its own). So the section is free-form by design;
nothing here is required, and these are the keys an entry may carry:

| Key | What it does |
|---|---|
| `enabled` | Whether the connection is offered on the account page; the backend also refuses `authorize`, `tokenize` and `refresh` for a provider whose resolved value is `false`. The five PACKAGED providers are `false` in the framework defaults — turning one on is the brand's act, since a card with no `CONNECTIONS_<PROVIDER>_CLIENT_ID` behind it could connect nothing. A brand's OWN provider is on unless this is `false` |
| `max` | The most accounts of this provider one user may link, a positive whole number (default `1`, which a brand's own provider reads too). A NEW account past it is refused at `tokenize` with a 400 naming the key; the same account reconnecting replaces its own record. The validator refuses `0` and a fraction, naming the key |
| `scope` | An array that WINS over the provider module's default scope |
| `name` | The card's title on the account page |
| `logo` | What the card draws: the NAME of a mark `@omega.js/web` ships (`core/logos/brandmarks/original/<name>.svg`, drawn inline), or a full URL (drawn as an `<img>`). A value carrying a `/` or a `:` is a URL; anything else is a mark name |
| `description` | The line under the title |

Every key is a PROVIDER NAME, so it is strictly `[a-z0-9-]` — the same rule the
backend's confined loader enforces. A key outside it can never resolve to a
provider, and the account page says so on the card instead of offering a
connection that could only fail.

**This section is the ONLY card list** ([#792](https://github.com/Omega-JS-Stack/omega/issues/792)):
every entry carrying a `name` and a `logo` renders a card, and the account layout's old
`connections:` frontmatter rows — which shadowed a brand's own entry and pointed at CDN
files that 404 — are gone. The framework's defaults carry `name`, `logo` and `description`
for the five packaged providers, so `google: { enabled: true }` is a complete card and any
key a brand writes wins through the ordinary merge chain. Those defaults RESOLVE only
(`materialize: false`, above): they are never copied into a brand's file. An enabled
provider with no `name` + `logo` after the merge gets the "unsupported connection" card,
which says exactly that.

Secrets never live here: the credentials are the `CONNECTIONS_<PROVIDER>_CLIENT_ID` /
`CONNECTIONS_<PROVIDER>_CLIENT_SECRET` pair in the `.env` (the provider name uppercased,
dashes as underscores). The full provider contract — the module shape, the ONE context
every step takes, `pkce: 'S256'`, the route-owned identity uniqueness, and the `type` every
stored record carries — is `docs/backend/connections.md`.

## The cancel-flow save offer (`payment.winback`) — #268

When a customer starts cancelling a PAID subscription, the billing card pitches a
discount on the next cycle before it asks them why they are leaving. Accepting applies
the discount through the provider's own coupon plumbing, calls the cancel off, and
leaves the saving on the card (what comes off, and which bills it comes off — #325);
declining opens the cancellation questionnaire unchanged.

The pitch is made per cancel ATTEMPT, never once per session (#324): a customer who
declines, closes the questionnaire and comes back to cancel meets the offer again,
because nothing about their subscription changed. Only a CLAIM (the discount is applied,
and the backend refuses a second one) or a refusal no retry fixes ends it.

An accepted offer is recorded in TWO places, on purpose (#325). `payments-orders/{orderId}`
`.requests.winback` is the offer's MEMORY — what a second accept is refused against — and
the account carries the discount ITSELF at `subscription.discount`, shaped like every other
discount in the payment stack (`{ valid, code, percent | amount, duration }`) plus a
`source`. That is what the billing card renders on a later visit; without it the saving
disappeared on the next page load. `source` is the whole reason it is safe to read as a
claim: today only the winback claim writes this node, and `source` is what keeps the
read safe when checkout discounts start writing it too, because only
`source: 'winback'` says this customer already took the save offer.

**The claim ends with the subscription it was made on (#333).** The account's node also
carries `resourceId`, the subscription the discount was applied to, stamped at claim
time. The unified webhook write carries no discount key, so a merge would otherwise keep
the node forever: a customer who churned and resubscribed carried a spent claim into the
NEW subscription, where `source: 'winback'` reads as "already claimed" and the save offer
is silently never pitched again. Every subscription-resource webhook compares the stamp against
the subscription the event is about and CLEARS the node on a mismatch (a new subscription
is a clean slate), while same-subscription traffic (renewals, cancellations, plan
changes) leaves the saving exactly as claimed. A node with no stamp predates it and
nothing can prove it belongs to an older subscription, so it is read as riding the one it
is found on and stamped there: no live discount is taken away on a guess, and it clears
on the next resubscribe like any other. CONSUMPTION is not cleared: a spent `once` coupon
still reads as applied until the subscription changes, because no provider's unified
shape reports whether the coupon is still attached (#333).

The offer is the brand's, and **a brand that writes nothing gets one anyway**: 50% off
the next cycle, that cycle only.

| Key | Type | Default | What it does |
|-----|------|---------|--------------|
| `payment.winback.enabled` | boolean | `true` | The whole off switch. `false` skips the pitch, and the cancel meets the data-retention warning instead (#341) |
| `payment.winback.percent` | integer 1-100 | `50` | Whole percentage off. Mutually exclusive with `amount` |
| `payment.winback.amount` | number > 0 | — | Flat amount off in `payment.currency`'s major unit (`10` = $10). Mutually exclusive with `percent` |
| `payment.winback.duration` | `'once'` \| `'forever'` | `'once'` | `once` discounts the next cycle only; `forever` is a permanent price cut |

Setting **both** `percent` and `amount` is a validation error: a coupon is one shape or
the other everywhere in the payment stack, and two shapes on one offer has no honest
reading.

`resolveWinbackOffer(payment)` is the ONE home of these defaults. The backend's
`POST /payments/winback` route resolves the brand's section through it, and the web
build bakes the same call into the client blob (`site.client.payment.winback`), so the
dialog the customer reads and the coupon the provider creates can never name different
numbers — the browser never applies a default of its own.

Not every provider can discount a subscription that is already running. Stripe can
(the coupon plumbing the checkout already uses); PayPal has no discount object at all
and Chargebee has no way to reach a live subscription with one through existing
plumbing. Those two refuse with `not-supported-by-provider`, and the billing card
retires the offer for the session and opens the questionnaire — a subscriber can always
still cancel.

## Consent (`client.consent`) — #383

The consent banner is a real GATE, so its config is schema-known even though the rest of
the `client` blob is not: a typo that silently disabled it would ship a site with no
consent surface and no error.

```json5
targets: {
  web: {
    client: {
      consent: {
        enabled: true,                    // default true; false ships NO banner
        config: {
          position: 'bottom-left',        // bottom-left | bottom-right | bottom
          content: {
            message: 'We use cookies … See our { terms }.',       // the banner face
            panelIntro: 'We and our partners … See our { cookies } and { terms }.',
            accept: 'Accept',                                     // the big grant
            customize: 'Customize',                               // opens the panel
            acceptAll: 'Accept all',                              // the panel's pair
            acceptNone: 'Accept none',
          },
          // `{terms}` and `{cookies}` link the terms and cookie-policy pages.
          // `save` retired with the Save button (#391) — a config still setting
          // it is ignored, not an error.
        },
      },
    },
  },
}
```

Two things are deliberately NOT config:

- **The regime.** The visitor's browser timezone picks it — the strict opt-in roster (plus an
  unplaceable timezone) gets opt-in, where no provider script loads until they accept; everywhere
  else gets opt-out, where the scripts load and a first visit sees only the Cookies Settings
  tab ([#391](https://github.com/Omega-JS-Stack/omega/issues/391)). There is no key that
  forces one, because the answer is legal, not stylistic.
- **The colors.** The panel paints itself from the `--omega-*` token sheet, which is the
  only way it is correct in both color modes. The old `palette`/`theme` keys are gone.

`enabled: false` is legal only for a site that loads no analytics or marketing provider
at all — the gate and the banner are the same switch.

## Feature gating polarity (#527)

Ratified 2026-08-24 (Ian). A feature has ONE switch with ONE polarity, and which
polarity it is follows from what the feature needs — never from taste at the read
site. Three cases:

| Case | The switch | The read | Examples |
|------|-----------|----------|----------|
| **1. Data-bearing** — the feature cannot run without a value only the brand can supply | that DATA's presence | `if (value)` | `advertising.providers.adsense.client`, `monitoring.providers.sentry.dsn`, `analytics.providers.*.id`, `edge.providers.cloudflare.zone`, `advertising.providers.inhouse.source` |
| **2. Zero-data**: the framework can run it for every brand with no input | `enabled`, default ON | `value !== false` | `forms.providers.slapform.enabled`, `inbound.chat.providers.chatsy.enabled`, `search.providers.searchConsole.enabled`, `edge.providers.cloudflare.enabled`, `targets.web.meta.index`, the manager's own `enabled`, `server.enabled`, `assets.enabled`, `payment.enabled`, `seo.enabled`, `certificates.enabled`, `account.enabled` |
| **3. Consequential** — it costs money, publishes to the world, or is irreversible | `enabled`, default OFF | `value === true` | `directory.enabled`, `devlog.enabled`, `targets.desktop.platforms.mac.mas.enabled` |

- **A block by itself NEVER enables.** Authoring `providers: { adsense: {} }` is an opt-IN
  to being asked, not an ON — the case-1 data or the case-2/3 `enabled` still decides.
- **Never a second switch on one feature.** Two switches let a config say ON to one half
  of the stack and OFF to the other: adsense carried exactly that (the manager gated on
  `enabled`, the site on `client` + `units`), so `{ client, enabled: false }` stopped the
  account being managed while the site kept serving ads off it. #527 collapsed adsense to
  case 1 and deleted both extra gates. A state that needs a second switch to express
  (managed account, ad-free site) is deliberately inexpressible.
- **Every code-read switch has a schema rule** ([#546](https://github.com/Omega-JS-Stack/omega/issues/546)):
  with no rule, the key fails the strict load, and a rule is also where the validator
  documents what the key does. The rule carries the `default:` that
  states the polarity — except where the SECTION is presence-gated (`advertising`), because
  a materialized default would write the section into every brand and switch the feature on
  for brands that configured none; there the ON answer lives at the read site.

## Tri-state provisioning values (#33)

Provisioning-flow keys (org, billing account, service/agent ids — anything a manage
flow can set up interactively) follow ONE contract, enforced by the manager's
config-flow engine (`packages/manager/src/lib/config-flow.js`):

| Value | Meaning |
|-------|---------|
| missing / `null` | ASK in an interactive run: the answer lands in omega.json5; without a TTY: warn + skip, aggregated in the run summary |
| a default the caller's `present` rejects | Not an answer, so ASK like missing. A caller passes `present` where a default would otherwise read as answered: an empty pick `{}` or an empty list `[]` is not an answer, and `cloud.shared` (schema default `false`) is asked once while the brand's own file does not author it |
| `false` | The user opted OUT: silent skip, never prompt or warn again. `false` on an ancestor section (`inbound.chat.providers.chatsy: false`) opts out every key under it. At the two email keys (`domain.email.providers`, `domain.email.forwarding`) `false` means none |
| anything else | Use it |

Every ask offers the opt-out (the gate's "Disable" and, in selection flows, an inline
"No …" choice), so `false` is always reachable; delete the line to be asked again.
First consumers: `cloud.organizationId` (asked at project creation — pick an org or
create standalone) and `cloud.billingAccount` (pick/create a billing account or stay
on Spark). ONE cloud home (#23, reversing the old `gcp`-vs-`firebase` split): the
platform-level org and billing account, the provisioning switches (`cloud.shared`,
`cloud.supportEmail`, `cloud.apiSubdomain`) and the app config (`cloud.provider`,
`cloud.config`) are all `cloud.*`, and the project id has exactly one address —
`cloud.config.projectId`. `cloud.supportEmail`'s null auto-derives the authorizing
user's email instead of asking.

## The site global: the curated targets view (#85, #610)

`toSiteGlobal()` (the web build's `site.*`) strips the raw `targets` machinery and
replaces it with a CURATED `site.targets` — an allow-list of display-safe facts per
declared target, never a spread of the raw config: every entry carries `enabled: true`,
desktop adds a derived `releasesUrl` plus the per-artifact `downloads` map once releases
are opted in, extension adds its store `listings`.

It is the ONE home of those facts
([#610](https://github.com/Omega-JS-Stack/omega/issues/610)). The legacy UJM-shaped
`targets.web.download` / `targets.web.extension` page maps — and the `site.download` /
`site.extension` data they filled — are GONE: a brand still carrying either key fails
the strict load, and `omega migrate` names the block it derives from and drops it.

- **The desktop derivation is OPT-IN (#124)**: `releasesUrl` appears only when
  `targets.desktop.releases` is present (its
  `enabled` defaults true when the block exists); `releases.enabled: false` always
  suppresses, and a bare desktop target with no `releases` block derives nothing —
  declaring the target does not mean a release exists yet. `releases.enabled` is ONE
  switch for the whole release surface: the desktop build also reads it
  (electron-builder publish config), so `false` turns off desktop publishing too — and
  there it defaults true even with no `releases` block.
- **Desktop releases URL**: `https://github.com/<owner>/<name>/releases/latest`, where
  owner and name come from `releasesRepo(config)` in
  [repo.js](../../packages/config/src/repo.js): the brand's ONE public releases repo
  ([#799](https://github.com/Omega-JS-Stack/omega/issues/799),
  [#883](https://github.com/Omega-JS-Stack/omega/issues/883)). It is always
  `<brand.id>-releases` under `repo.owner`, with no override key left anywhere;
  `targets.desktop.releases` presence is only the opt-in. Nothing addressable, no URL
  (no owner, no brand id). That helper is the ONE
  home of the address: @omega.js/desktop's electron-builder publish block, its releases-repo
  provisioning and its `finalize-release` uploads read the same call, so the feed a shipped
  app polls and the link a download button carries cannot disagree.
- **Desktop direct downloads ([#620](https://github.com/Omega-JS-Stack/omega/issues/620),
  [#867](https://github.com/Omega-JS-Stack/omega/issues/867))**:
  `downloads.<platform>.<format>` = `<releasesUrl>/download/<asset>`, one per format the
  brand SHIPS (`mac.dmg`, `windows.nsis`, `linux.deb`, `linux.appimage`, in offer order),
  plus `linux.snap`, which is the Snap Store listing because the store holds that file.
  The format keys and the asset names are `platforms.js`'s: the SAME table
  @omega.js/desktop's `build-config` writes into `electron-builder.yml`, so a button
  hands over the file and never lands on a GitHub page. They carry no version, which is
  what keeps `/releases/latest/download/<asset>` pointing at the newest build forever:
  releasing a desktop version never touches the website. Derived from
  `targets.desktop.app.productName` → `brand.name`; no product name, no `downloads` (a
  guessed filename is a dead button). A platform or format the brand dropped is absent
  here too, so the site never renders a button for something nobody builds.
- **Extension listings**: `targets.extension.listings.<store>.{url,state}` for the six
  stores the theme renders (chrome, firefox, edge, opera, safari, brave) —
  schema-declared; url must be http(s). Entries with neither url nor state stay absent.
  The `id` beside them (#893) is the publish lane's, not the page's: it never
  reaches the curated view, because a listing with no url has nothing to link.
- **Idempotent by contract**: the web build applies `toSiteGlobal` twice (loadSiteData,
  then configureOmega) — a curated `releasesUrl` and its `downloads` survive the second
  pass unchanged.
- **The curated view is keyed by target NAME, and every fact derives from the entry's TYPE**
  ([#886](https://github.com/Omega-JS-Stack/omega/issues/886)): a brand that names its desktop
  target `app` gets `site.targets.app.releasesUrl` and `site.targets.app.downloads`. The name is
  never the test. A target whose type derives nothing is a presence-only entry.

Three consumers read the curated view and nothing else: the `/download` page (every
desktop button → `site.targets.desktop.downloads[platform][artifact]`), the `/extension` page
(`site.targets.extension.listings[browser].url`), and the shortlink generator
(`src/target-shortlinks.js`, #561), which publishes `/download/<platform>[/<artifact>]`
and `/extension/<store>` off the same facts. Mobile derives nothing while MAM is
parked, so the mobile band stays on its notify form.

## The browser subset: one `client` flag, one `OMEGA_BUILD_JSON`, one `build.js` (#894, #743)

Three surfaces hand a config to a browser: web's pages and its service worker, desktop's
renderer windows, and every extension page plus its service worker. What may go in is ONE
decision, declared once and made once, and it is DELIVERED one way:

- **The declaration** is `CLIENT_SECTIONS` in [src/schema.js](../../packages/config/src/schema.js):
  a per-SECTION `client` flag. `true` ships the whole section (its keys are public by
  design, and a secret-shaped key can never be in the file at all); an ARRAY of dot-paths
  ships only that section's public half, for a section whose other keys are
  provisioning-only. No row means the browser never sees it. Today: `advertising`,
  `analytics`, `app`, `brand`, `captcha`, `client`, `company`, `connections`, `features`,
  `listings`, `monitoring`, `payment`, `theme` ride whole; `cloud` rides
  `['config', 'messaging.vapidKey']` (the Firebase WEB config is public, the GCP account
  facts beside it are not); `forms` rides `['providers.slapform.formId']` and `inbound`
  the three chatsy leaves the widget reads. A NEW section defaults to invisible, which
  fails as a missing feature rather than as a leak.
- **The function** is `clientConfig(resolved)`
  ([src/client-config.js](../../packages/config/src/client-config.js)): the flagged
  sections, plus the build FACTS a surface composes onto the config before baking it
  (`runtime`, `environment`, `version`, `buildTime`, `target`, `url`, `dev`). `runtime` is
  baked on every surface, including desktop (#896): a packaged Electron renderer is a
  browser with no Electron globals of its own, so nothing can sniff it from inside.
  `payment` comes out with its winback offer RESOLVED, so the dialog a customer reads and
  the coupon the backend creates name the same numbers. A secret-shaped key inside a
  section about to ship THROWS: that config should never have loaded, and this is the last
  place before it is published. A value a build is sanctioned to bake (`publicAtRest`,
  "Config or env?" above) is added by that build AFTER this gate, never carried through it.
- **The wrapper** is the same name and the same five keys on every surface:
  `OMEGA_BUILD_JSON = { config, package, mode, license, builtAt }`, reachable as
  `self.OMEGA_BUILD_JSON` in a window and in a worker alike. `config` is the subset; the
  rest are facts about the BUILD and never part of the client contract. `mode` is the same
  THREE keys everywhere, `{ environment, build, publish }`: the build's verdict, whether it
  was a build rather than a dev/watch run, and whether it publishes. A surface's own extra
  verdicts (desktop's `server`) stay inside that surface's build module.
- **The delivery** is ONE FILE, `build.js` at the artifact's web root
  ([#743](https://github.com/Omega-JS-Stack/omega/issues/743), Ian 2026-09-12: "make it
  same shape and consumption everywhere as much as possible"). Two plain statements, written
  by `composeBuildJson()` + `writeBuildJs()` in
  [@omega.js/devkit/build-json](../../packages/devkit/src/build-json.js):

  ```js
  self.OMEGA_BUILD_JSON = { config, package, mode, license, builtAt };
  self.OMEGA_BUILD_JSON.config.dev = { … } | null;
  ```

  Every HTML shell loads it with one script tag, FIRST (web's `core/_includes/core/head.html`
  at `/build.js`, desktop's page template at `../../build.js`, the extension's at
  `/build.js`), and every worker with one `importScripts` line (web's `sw/omega.js`, the
  extension's `background.js`). Every web loader carries the build stamp, because the edge
  caches `/build.js` for a year ([docs/manager/edge.md](../manager/edge.md)): the head's tag
  is `/build.js?cb=<stamp>`, and the service worker imports the same URL with the same stamp,
  baked into its bundle at build as `__OMEGA_BUILD_STAMP__`. The extension's worker loads
  plain `/build.js`, since it is a packaged file that no HTTP cache holds. No bundle carries
  a copy of the config: the esbuild banners and defines the browser bundles grew are retired
  (the worker's stamp is a fact about the build, not config), and so is web's inline foot
  script. The `dev` map is its own statement because `omega dev` REWRITES that one line per
  request (#346), so a site built before the emulator came up still serves the map of the
  stack running right now.

  Desktop's MAIN and PRELOAD bundles are the one exception, and not to the file: they are
  Node, they boot from the WHOLE resolved config inside the asar, and they keep carrying it
  as a define plus a banner.

  A web page whose own `config:` block (#607) changes what a runtime reader sees emits ONE
  more line after the loader tag, `Object.assign(self.OMEGA_BUILD_JSON.config, <delta>)`,
  naming only the sections that actually differ.
- **`@omega.js/client` is handed `OMEGA_BUILD_JSON.config`** by the same call on all three
  surfaces, and it owns the mapping onto its own contract: the `client` blob IS its top
  level, `cloud.config` is the Firebase home it boots from, and
  `monitoring.providers.sentry` is the one error-reporting switch. No surface composes a
  second home for any of those.

The backend is deliberately outside this: it stages the WHOLE resolved config to
`dist/config/omega.json5` and reads it with the loader, which is right for a server.

## Consumer access

Each framework exposes the vendored loader — desktop: `require('@omega.js/desktop/config')`,
extension: `require('@omega.js/extension/config')` → `{ loadConfig, validateConfig, … }`.
Consumer workflows use this instead of raw JSON5 reads so brand-monorepo resolution
always applies.

**Derived values reach brands as VALUES, never as a recipe to re-run**
([#290](https://github.com/Omega-JS-Stack/omega/issues/290)). A brand target cannot require
this private package at runtime, so a framework that owns a derivation publishes its
ANSWER on the runtime config object the target already holds, under `resolved.*`: the
backend's `omega.config.resolved.github` carries `{ owner, name, slug }`, the brand's
SOURCE repo as one finished value. The derivations themselves stay here (`src/repo.js`):
one implementation, called by the framework, so no brand re-implements the rules and
drifts from them. New derived values join a framework's `resolved` group as real brand
needs surface.

## The repo block and the repos it derives (#883)

ONE block says where a brand hosts its code, and it is two keys:

```json5
repo: { provider: 'github', owner: 'Acme-Org' }
```

- **Presence is the switch.** A brand with no `repo` block hosts its source somewhere the
  manager does not touch, and the repo service skips, exactly as a missing target key
  means that target is not enabled. There is no `enabled` key.
- **`provider`** defaults to `github` and must be one of `REPO_PROVIDERS` (`['github']`).
  A second provider is one table row plus its own helper, never a reshape of the block.
- **`owner`** is the only typed value, and it is required whenever the block is present:
  the GitHub user or org that owns every repo the brand's names derive under. Onboarding
  writes it from the wizard's pick, `--owner`, or the clone's origin.

**Every repo NAME derives from the `<brand.id>-<role>` rule** (Ian 2026-09-07,
[#809](https://github.com/Omega-JS-Stack/omega/issues/809)), one function per role in
[repo.js](../../packages/config/src/repo.js), which every package reads. No override key
of any kind exists: a repo name that must differ is a brand id that must differ.

| Role | Derivation | Visibility | Holds |
|---|---|---|---|
| Source monorepo | `sourceRepo(config)` → `<repo.owner>/<brand.id>-omega` | the brand root package.json `private` field | the brand's code, its scaffolded workflows and their Actions secrets, and the CMS's content commits. Every dispatch addresses this one |
| Releases | `releasesRepo(config)` → `<repo.owner>/<brand.id>-releases` | always public (the desktop updater polls it with no token) | every target's built artifacts: desktop installers, the extension's zips, tagged per target |
| Website, one per GitHub-hosted web target | `websiteRepo(config, name)` → `<repo.owner>/<brand.id>-<target name>` | private only when the brand is private AND the owner's plan allows Pages from a private repo, else public, and the manage walk says which | the BUILT site only, one force-orphan commit on `gh-pages`, served by Pages at the target's url |

**`repoDrift(originSlug, config)`** is the one comparison of a checkout's `origin` with
the source repo ([#934](https://github.com/Omega-JS-Stack/omega/issues/934)): the whole
slug, case-insensitive, null when they agree or the config derives no source repo, else
the line `origin is <slug> but config derives <derived>: fix repo.owner in
config/omega.json5 or move the repo`. The boot prelude prints it; `omega manage` and
`omega deploy` refuse with it ([deploys.md](deploys.md#the-origin-gate-934)).

**`repoMissing(role)`** is the one line a refusal quotes when a role's repo is
unaddressable (no owner, or no brand id), with `role` one of `source`, `releases` or
`website`: `Set repo.owner and brand.id in config/omega.json5: the <role> repo is <name>
under that owner.`, where `<name>` is that role's derivation from the table above. Each
refusal (the backend CMS, the deploy dispatch, the secret publication skip, the desktop
and extension release lanes, the web direct deploy) states its own lead, then this line;
an unknown role throws.

**Visibility lives in the brand root's `package.json`**, never in omega.json5
(`brandVisibility(brandRoot)`): `private: true` or the field ABSENT is a private brand
(every brand monorepo is private by default, Ian 2026-09-11), and only a literal `false`
is a public one. The manage walk reconciles the repo to it in both directions.

**`targets.<name>.hosting.provider`** says who SERVES a web target's built site, on web
targets only (a non-web target carrying `hosting` is a validation error). It defaults to
`github`, must be one of `HOSTING_PROVIDERS` (`['github']`), and is what `websiteRepo`
reads: another provider means there is no GitHub repo to address at all.

**The Pages custom domain is ONE derivation**, `pagesHost(config, name)`: the bare host of
that target's `targetUrl`, and an empty string when the url names a default Pages address
(`*.github.io` is an ADDRESS, never a domain, [#366](https://github.com/Omega-JS-Stack/omega/issues/366)).
The manage walk sets the domain on the repo from it and the web deploy writes its `CNAME`
file from it, so the two can never claim different domains for one site.

**The Pages address is ONE derivation too**, `pagesAddress(config, name)`:
`https://<owner lowercased>.github.io/<websiteRepo name>` for a GitHub-hosted web target, null
whenever `websiteRepo` is. The loader fills an unset `brand.url` from it and the web direct
deploy's project-site plan falls back to it, so the two never spell the address apart.
`isDefaultPagesHost(host)` is the one test for a default Pages host, read by `pagesHost` and by
`defaultAddressReason(url)`, which answers the skip reason for a url on a default Pages host and
null for anything else, so every domain-managing reader skips with one call.

The by-hand steps for a brand still on the old shape are the register's
[2026-09-11 section](breaking-changes.md#2026-09-11-one-repo-block-and-the-website-repo-883).

## Defaults & self-healing

Ian's ruling (2026-08-22, [#478](https://github.com/Omega-JS-Stack/omega/issues/478)): the config
stays complete and current. A subsystem that exists has its config structure IN the file —
visible and editable — instead of an invisible framework fallback, and every default has ONE
home.

**The schema is that home.** A `schema.js` entry carries its own `default:` beside its type and
description; `schemaDefaults(target)` builds them into the merge chain's lowest layer, so nothing
else re-states a default. A key with no sane framework answer carries none: owner decisions,
tri-states that mean "ask" (`cloud.billingAccount`), ids the services provision
(`forms.providers.slapform.formId`), anything secret-shaped. The other standing exclusion is the
**presence gate** ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)), which in practice
means monitoring: that service reads `monitoring.providers.sentry` presence as the pick of
Sentry, so its SDK knobs (`sampleRate`, `scrubEmail`, …) carry no default and keep their home in
the package that reads them — and `advertising`, whose adsense `client` id is the whole switch
([#527](https://github.com/Omega-JS-Stack/omega/issues/527)), so a materialized block would turn
the web build's automatic ad placements on for a brand that configured none. `repo` is the third
([#883](https://github.com/Omega-JS-Stack/omega/issues/883)): the BLOCK's presence enables the
repo service, so `repo.provider` carries no default either and the value a missing provider reads
lives beside the derivation, in `src/repo.js`. Blocks whose services
gate on `enabled` or provisioned ids rather than presence (cloudflare, searchConsole,
slapform, chatsy, replyify) DO carry defaults — see the polarity doctrine above.
Role-level switches beside any providers block
(`monitoring.enabled`, `marketing.campaigns.enabled`) are nobody's pick and always may.

**The manager backfills only what the schema cannot default**
([#972](https://github.com/Omega-JS-Stack/omega/issues/972)). `@omega.js/manager`'s `DEFAULTS` is
`schemaDefaults()` with `MANAGER_DEFAULTS` (`packages/manager/src/config.js`) on top, and a manager
test fails on any key both of them default. What stays in that table is what no schema `default:`
can carry:

- **Placeholders**, `null` or empty: the ids a service writes back
  (`payment.providers.stripe.publishableKey`, `forms.providers.slapform.formId`, the agent and list
  ids), the tri-states that mean "ask" (`cloud.organizationId`, `cloud.billingAccount`) and the
  lists an owner fills (`payment.products`, `domain.email.forwarding`). None has a framework
  answer, which is the rule above.
- **Settings under a vendor key whose presence picks that vendor**: Stripe's `updateAccountInfo`
  and Radar rules, GA4's `timeZone`, `currency` and `enhancedMeasurement`, the Ghostii devlog
  writer's settings, and the Apple capability, profile and certificate sets. A schema default
  resolves in every target and materializes into every brand, so it would name that vendor for
  every brand; under `certificates.providers.apple` it would also make the `APPLE_API_*` keys
  required everywhere, through their `requiredWhen`.
- **`devlog.enabled: false`**: the case-3 switch whose rule keeps devlog out of the schema's
  defaults layer ([#553](https://github.com/Omega-JS-Stack/omega/issues/553)).

**`omega manage` materializes what a brand lacks.** The workspace service's `defaults` operation
(right after the `config` health check) diffs the brand's own `config/omega.json5` against the
schema defaults and writes the missing blocks through the comment-preserving editor, each key
documented with the schema's own description. That description is what a brand reads in its
own file, so it states what the key does and its default in the present tense: no em dash, no
issue tag, no history (a config test walks every rule and fails on the first two). The rules:

- **Never an overwrite.** Only keys the brand has NOT authored are written — a `false` a brand
  set (or a section it deliberately switched off) is a decision, and the heal never dives into it.
- **Highest missing path, once.** A brand with no `marketing` at all gets one `marketing` block,
  not one edit per key inside it.
- **Target refinements land in their target** ([#943](https://github.com/Omega-JS-Stack/omega/issues/943)).
  A default only one framework declares (web's `meta.index`, extension's `categories`) is judged
  per declared target on the view `loadConfig` resolves for it, and written under
  `targets.<name>`, never at the root, which the strict schema reads as shared.
- **Idempotent.** A converged config leaves the file byte-identical; a dry run reports the blocks
  and writes nothing.
- **New subsystems arrive on the next run.** Adding a `default:` to the schema is all it takes for
  every consumer's config to grow the block the next time manage runs.

`marketing.prune.enabled` is the first ruling this carries: pruning is ON by default and lands in
every brand config as an editable switch (Ian 2026-08-22, closing the
[#422](https://github.com/Omega-JS-Stack/omega/issues/422) follow-up).

**`materialize: false` — a default that resolves but is never written**
([#793](https://github.com/Omega-JS-Stack/omega/issues/793)). A rule may carry the flag beside its
`default:`, and then `schemaDefaults()` still puts the value at the merge chain's lowest layer —
every reader resolves it — while `missingDefaults()` and `defaultComments()` skip it, so the manage
walk never writes it into `config/omega.json5`. The line for when to use it: **is this value an
OWNER's decision, or the framework's own fact?** A decision belongs in the brand's file, where it is
visible and editable (that is every ordinary default). A framework fact a brand may override and
rarely does — presentation the framework owns — belongs at the layer that owns it, because a copy in
every brand config is a copy that drifts from the thing it came from. The `connections` section is
the first: the framework ships the five packaged providers' `name`, `logo` and `description`, a
brand overrides any key through the ordinary merge chain, and nothing is copied into a brand file to
go stale ([docs/backend/connections.md](../backend/connections.md)). The Cloudflare engine data
(`edge.providers.cloudflare.dns`, `settings`, `speedTest`, `cacheRules`, `rules.*`, `webAnalytics.enabled`) and
`account.admins` are the others: platform answers and a list a company config typically sets once,
where a copy in every brand file would shadow the company layer (arrays replace whole).

## Writeback (comment-preserving edits)

omega.json5 is hand-edited — comments, key order, and quote style carry meaning — so
programmatic writes are surgical text edits, not a re-stringify (omega-manager's
serializer rewrote the whole file in canonical order and lost comments; this replaces
it). The manager's services use it to land resolved IDs in config: the SendGrid list,
the Beehiiv publication, Stripe/PayPal product IDs, the Firebase SDK config.

`applyConfigEdits(source, edits, { comments }?)` applies `{ 'dot.path': value }` edits to JSON5 text:
existing leaves get their value span replaced; missing branches insert as one property
before the containing object's closing brace (matching indent; house style: unquoted
keys, JSON.stringify strings, trailing commas). Every byte outside the edited spans
survives. Paths take dots, `[0]` positions, and `[key=value]` matchers that select
an array element by its own key — `payment.products[id=plus].stripe.productId` — so
writes self-locate in the file being edited instead of trusting an index computed from a
merged config. Array elements are never created.

`comments` (dot-path → text) documents INSERTED keys only — the comment lands above the key its
path names, wherever inside the inserted block that is, wrapped at that key's indent. A path that
already exists keeps whatever the brand wrote above it. That is how the manage-run heal
([Defaults & self-healing](#defaults--self-healing)) lands each materialized block with the
schema's own guidance beside it.

Guarantees: edits whose value already matches are skipped entirely (reruns are
byte-identical); after every edit the result must JSON5-parse and hold the requested
value at the requested path, or the call throws and nothing is returned — a corrupted
config can't land on disk.

`writeConfigValues(projectDir, edits, { dryRun }?)` is the file-level form: resolves the
standard locations, skips the write when nothing changes, and returns
`{ path, changed, applied }` (`applied` = the paths that actually differed). The manager
wraps it in `lib/config-write.js` (`writeBrandConfig(context, edits)`) for the uniform
dry-run gate + logging.

**Deleting** is the same surgery in reverse ([#612](https://github.com/Omega-JS-Stack/omega/issues/612)):
`applyConfigRemovals(source, paths)` cuts the property a dot-path names — its key, its whole
subtree, the comma that separated it, and the `//` comment block documenting it, because that
comment describes the key being deleted and would otherwise dangle over the next one. A property
sharing its line (`{ a: 1, b: 2 }`) takes only itself and its separator. Absent paths are skipped,
so reruns are byte-identical, and each removal is verified (parses, path gone) or the call throws.
Array ELEMENTS are never removed, the mirror of never creating them. `removeConfigValues(projectDir,
paths, { dryRun }?)` is the file-level form → `{ path, changed, removed }`. Unlike a write it does
NOT normalize top-level key order: a deletion is surgical, and re-sorting the file around it would
bury the one line the caller means to report. The consumer is `omega migrate` at a brand root
([manager/index.md](../manager/index.md)).

## Migration — legacy configs → omega.json5

No framework reads the legacy files anymore. Convert once, delete the old file. General
recipe: shared-looking sections move to the TOP LEVEL (brand, analytics, payment, theme;
`oauth2` lands as `connections` (#788); `firebaseConfig` becomes `cloud: { provider: 'firebase', config: {…} }` and
`sentry` becomes `monitoring: { providers: { sentry: {…} } }`); everything framework-specific
moves under `targets.<name>`.

### The targets shape rename (#886)

An OMEGA-era brand converts once: every entry declares its `type`, and the KEY is the folder.
The by-hand steps (and the rest of the register) are in
[breaking-changes.md](breaking-changes.md#2026-09-11-targets-keyed-by-name-886).

| Legacy | New |
|---|---|
| `targets/website` (the canonical web folder) | **`targets/web`**: the folder is the key, and the key is `web` |
| `targets/website-admin` (an instance's suffixed folder) | **`targets/admin`**: the sibling key names its own folder |
| `web: [{ id: 'main' }, { id: 'admin' }]` (the instance ARRAY) | **sibling keys**: `web: { type: 'web' }, admin: { type: 'web' }` |
| `--target=website` | **`--target=web`**: the flag takes the NAME |

### The one repo block (#883)

The brand's repo hosting used to be spelled in four places: `repo.providers.github`, a
separate top-level `github` identity, a `targets.<name>.github.repo` override, and the
desktop releases owner/repo. One block says it now (`repo: { provider, owner }`), every repo
name derives from `<brand.id>-<role>`, and visibility is the brand root package.json's
`private` field. Each retired key is undeclared, so a brand still carrying one fails the
strict load instead of silently addressing a repo nothing publishes to, and each is a
registered PATH in the migrate table, so `omega migrate` names its home. The by-hand
steps are the register's
[2026-09-11 section](breaking-changes.md#2026-09-11-one-repo-block-and-the-website-repo-883).

| Retired path | New home |
|---|---|
| `repo.providers.github.org` | **`repo.owner`** |
| `repo.providers.github.repo` | nothing: the source repo IS `<brand.id>-omega`. A name that must differ is a brand id that must differ |
| `repo.providers.github.private` | the brand root `package.json` `private` field (absent = private) |
| `repo.providers.github.shared` | nothing: an org may host many brands, and no brand rewrites an org profile |
| `repo.providers.github.enabled` | the PRESENCE of the `repo` block |
| `github.user` | nothing: the owner is `repo.owner` |
| `github.website` | nothing: a web target's site repo is `<brand.id>-<target name>` |
| `targets.<name>.github.repo` (every type) | nothing: the CMS commits to the SOURCE repo `<brand.id>-omega` |
| `targets.desktop.releases.owner` | nothing: `<brand.id>-releases` under `repo.owner` |
| `targets.desktop.releases.repo` | nothing: `<brand.id>-releases` under `repo.owner` (`releases: {}` stays the presence switch) |

**Retired keys fail loudly** ([#142](https://github.com/Omega-JS-Stack/omega/issues/142),
[#859](https://github.com/Omega-JS-Stack/omega/issues/859)): a retired key is undeclared,
so the strict schema fails the load on it like on any unknown key (see Validation), and the
loader knows nothing more. What the key BECAME is the migrate verb's knowledge: the tables
below are `@omega.js/manager`'s `src/migrate/retired-keys.js` (config) and
`src/migrate/retired-env.js` (`.env`), the one code that knows an old name. A name that was
renamed OUTRIGHT is a NAME row, found wherever it sits (shared level, inside a
`targets.<name>` entry). Today that is `web_manager` → `client`, `firebaseConfig` → `cloud`,
`cookieConsent` → `client.consent`, `subdomains` → `targets.web`, `oauth2` → `connections`
and `parent` → `company.webhooks`. Names that live on as legitimate
keys elsewhere stay out of the list — the rows below are their only guide. `sentry` is the one
that reads like a contradiction and is not: its NEW home is itself a `sentry` key
(`monitoring.providers.sentry`), so a name test would fire on the very shape it is steering
people toward. Same for `google`/`meta` under `analytics.providers`.

**`omega migrate --execute` at the brand root deletes them** ([#612](https://github.com/Omega-JS-Stack/omega/issues/612)): both halves of the
list, from every authored omega file (the brand's `config/omega.json5` and its environment
overlays, the `config/seo.json5` sidecar the loader reads as the `seo` section, each target's own file
and its overlays, one report block each), through the
comment-preserving editor (`removeConfigFileValues`):
the key, its subtree, and the comment documenting it, with every other byte untouched. One line
per key naming its replacement, a bare `omega migrate` for the plan, idempotent (a converged brand's rerun
is byte-identical). It removes the dead key; moving the setting into the home named in the tables
below is still by hand, EXCEPT where a row carries a converter
([#858](https://github.com/Omega-JS-Stack/omega/issues/858)): then the new value is written
first, through the same comment-preserving editor, and the old key is deleted in the same
run, so a brand never sits between the two shapes. A bare run prints both halves. The
same pass then lists every key the strict schema still refuses and no row covers
(config's `undeclaredAuthoredPaths()`: the whole file, then each framework target entry as
its own load sees it), as a by-hand line:
judged after converting under `--execute`, so it is what the brand still owes, and it
exits 1 in both modes while any remains.

`subdomains` is the newest name ([#588](https://github.com/Omega-JS-Stack/omega/issues/588),
Ian 2026-09-01). The key was READ by exactly one thing, the cloud hosting op, which ensured an
`api.{sub}.{domain}` per entry, and DECLARED by nothing: no schema rule, no default, never
materialized. The fact it was reaching for is a web target, so a target is its home now:
the NAME is the subdomain, and every subdomain shares one `api.<domain>`. It is a NAME test by the
rule above (`subdomains` exists nowhere else in the schema), so it fires wherever a brand wrote
it, including down inside a target entry's own `brand` block.

| Retired key | New home |
|---|---|
| `subdomains` | **`targets`** as sibling web targets: `["admin", "cdn"]` becomes `admin: { type: 'web' }, cdn: { type: 'web' }` beside the main site (§ Targets). The NAME is the subdomain (`https://admin.<brand host>`), an entry's own `url` overrides it for a custom host, and the targets share ONE `api.<domain>` |

`oauth2` is the newest name ([#788](https://github.com/Omega-JS-Stack/omega/issues/788),
Ian 2026-09-03). The product concept is a CONNECTION, and a connection will not always be an
OAuth grant — an API key or a bot token is one too — so the whole feature carries the product
word (the section, the route, the user-record field, the env prefix, the brand provider folder,
the callback URL) and each stored record names its own kind with `type: 'oauth2'`. A NAME test
by the rule above: `oauth2` exists nowhere else in the schema. The by-hand steps a carrying
brand still owes — the env rename, the provider-console redirect URI, the provider folder move —
are in [breaking-changes.md](breaking-changes.md#the-user-connection-feature-is-connections-788).

| Retired key | New home |
|---|---|
| `oauth2` | **`connections`** — the per-provider block is unchanged. The credentials are the `CONNECTIONS_<PROVIDER>_CLIENT_ID`/`_SECRET` pair now, a brand's own provider module lives at `targets/backend/src/connections/<name>.js`, the route is `/omega/user/connections`, and the redirect URI to register is `<websiteUrl>/connections/callback` |

The de-branding rekey ([#23](https://github.com/Omega-JS-Stack/omega/issues/23)) adds a
second, PATH-based half in the same file (`RETIRED_PATHS`): keys whose provider keeps its
own name one level down inside the new home, so a name test would false-positive. Each
entry matches ONE exact path from the root, array positions ignored, and the report names the
real path, index and all
([#732](https://github.com/Omega-JS-Stack/omega/issues/732)). A `targets.<name>` row names the
TYPE, and the key is a NAME, so the row fires on EVERY target of that type: with `community:
{ type: 'web' }` declared, `targets.community.meta.title` matches the
`targets.web.meta.title` row and the report names the real path
([#886](https://github.com/Omega-JS-Stack/omega/issues/886)):

| Retired path | New home |
|---|---|
| `slapform` | **`forms.providers.slapform`** |
| `chatsy` | **`inbound.chat.providers.chatsy`** (the widget `settings` moved here too — one home) |
| `replyify` | **`inbound.email.providers.replyify`** |
| `cloudflare` | **`edge.providers.cloudflare`** |
| `recaptcha` | **`captcha.providers.recaptcha`** (`site-key` → `siteKey`) |
| `searchConsole` | **`search.providers.searchConsole`** (`seo` already means the parasite-SEO content feature) |
| `gcp` | **`cloud`** (`cloud.organizationId`, `cloud.billingAccount`) |
| `firebase` | **`cloud`** (`cloud.shared`, `cloud.supportEmail`, `cloud.apiSubdomain`; projectId only at `cloud.config.projectId`) |
| `advertising.providers.google-adsense` | **`advertising.providers.adsense`** + camelCase slots |
| `github` | **`repo`** ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)): the separate identity block is gone, and `github.user` / `github.website` are registered retired PATHS now, so a carrying brand hears it from `omega migrate` instead of this table |

The one-provider-shape normalization ([#425](https://github.com/Omega-JS-Stack/omega/issues/425))
adds its own rows to the same `RETIRED_PATHS` half — every role names its vendors
`role.providers.<provider>` now, so the flat picks, the bare vendor key and payment's
fourth word are all retired. Key PRESENCE is the pick; `false` is the deliberate off
switch; no entry at all is "none chosen" (what a null provider meant). `cloud` stays the
ratified exception. Full rationale + the by-hand step per row:
[breaking-changes.md](breaking-changes.md#one-provider-shape--roleprovidersprovider-425).

| Retired path | New home |
|---|---|
| `payment.providers` | **`payment.providers`** — contents identical. The SINGULAR `provider` (Firestore document fields, the intent schema, the payments route params, the email merge field, `libraries/payment/providers/`) is a live data contract and is unchanged |
| `certificates.apple` | **`certificates.providers.apple`** — no bare vendor keys; Windows signing sits beside it later |
| `domain.provider` | **`domain.providers.<registrar>`** — `{ namecheap: {} }` / `{ squarespace: {} }` |
| `domain.email.provider` | **`domain.email.providers.<provider>`** — `domain.email.forwarding` stays role-level (provider-agnostic) |
| `translation.provider` | **`translation.providers.<name>`** — `{ claude: {} }` / `{ chatgpt: {} }`; an absent block still means claude. `translation.model` stays role-level |
| `devlog.provider` + `devlog.{lookbackDays,orgs,excludeRepos,excludeCommits,excludeTopics,includePrivate,postPath,destinations,overrides}` | **`devlog.providers.ghostii.<same key>`** — the writer is the KEY, its settings live inside it. `devlog.enabled` stays role-level |
| `monitoring.provider` + `monitoring.{org,dsn,environment,sampleRate,tracesSampleRate,scrubEmail,attachScreenshot,bundlePatterns}` | **`monitoring.providers.sentry.<same key>`**: the monitor is the KEY, every SDK-facing knob lives inside it. `monitoring.enabled` stays role-level, and per-surface DSNs are `targets.<name>.monitoring.providers.sentry.dsn` |
| `marketing.campaigns.provider` + `marketing.campaigns.listId` | **`marketing.campaigns.providers.sendgrid.listId`** — `marketing.campaigns.enabled` stays role-level |
| `marketing.newsletter.provider` + `marketing.newsletter.publicationId` | **`marketing.newsletter.providers.beehiiv.publicationId`** — `marketing.newsletter.enabled` AND `marketing.newsletter.content` stay role-level: content configures @omega.js/backend's newsletter generator, not Beehiiv |

The retired-key sweep only ever runs over an omega.json5: the `omega migrate` converter
READS legacy files as input and emits the new names, and only its output is validated.

AdSense's one-switch collapse ([#527](https://github.com/Omega-JS-Stack/omega/issues/527))
adds the last two rows ([#628](https://github.com/Omega-JS-Stack/omega/issues/628)). Both
were unregistered until then, so a brand still carrying the deleted gate validated CLEAN
while the account it meant to leave alone started being managed — the key reading exactly
like it still worked. `omega migrate` drops both with the note.

| Retired path | New home |
|---|---|
| `advertising.providers.adsense.enabled` | **`advertising.providers.adsense`** — `client` presence is the ONE switch (managed account + rendered units + the ads.txt record). `advertising.providers.adsense: false` opts the provider out; there is no second gate |
| `advertising.providers.adsense.units` | **`advertising.providers.adsense`** — the render-only gate #527 refused. A managed-but-ad-free brand omits the block and manages the account by hand |

The `meta` section is the other registered path ([#607](https://github.com/Omega-JS-Stack/omega/issues/607),
Ian 2026-08-26 — meta never exists in two places). It shipped for one wave beside the
bare `meta:` a page and a layout already wrote, which is two homes for one fact; deleting
the config half leaves page frontmatter as the only meta, with `brand.name` /
`brand.description` as the site-wide default the head falls back to. Registered at its
authored path AND at the `targets.web` overlay — never by key NAME, because
`analytics.providers.meta` is a legitimate key one level down.

| Retired path | New home |
|---|---|
| `meta.title`, `meta.description` (and the same two under `targets.web.meta`) | **`brand.name` / `brand.description`** for the site-wide default, and that page's own `meta:` frontmatter for anything per-page ([docs/web/frontmatter.md](../web/frontmatter.md)) |
| `seo.index` | **`targets.web.meta.index`** ([#564](https://github.com/Omega-JS-Stack/omega/issues/564), Ian's same-name ruling 2026-09-09): the site-wide default and the page override are ONE name at both levels, so `meta.index` is what a page writes and `targets.web.meta.index` is what the site writes. `targets.web.meta` itself is LIVE for that key; only `title` and `description` are retired under it |

`translation.exclude` is the same ruling's second fold ([#858](https://github.com/Omega-JS-Stack/omega/issues/858),
Ian 2026-09-13). The key named what NOT to translate and defaulted to nothing, so a brand
that never thought about it paid a provider for every post it had, and a page had no way to
say anything at all. The list says what to TRANSLATE now: globs on page routes with `!`
negation, read in `.gitignore` order, defaulting to `['**', '!blog/**']` in the DEFAULTS
layer, and a page overrides it for itself with the SAME key name one level down
(`translation.include: true`/`false` in its own frontmatter). Registered at its authored
path AND at the `targets.web` overlay, the two places a brand can write it, never by key
NAME: `exclude` is a legitimate key elsewhere. This row carries a CONVERTER, so
`omega migrate` MOVES the setting instead of only deleting it.

| Retired path | New home |
|---|---|
| `translation.exclude` (and the same key under `targets.web.translation`) | **`translation.include`**: the route list says what to translate, so `exclude: ['docs']` becomes `include: ['**', '!docs']` and `omega migrate` writes exactly that before deleting the old key ([translation.md](translation.md), [docs/web/frontmatter.md](../web/frontmatter.md)) |

`targets.web.redirects` is the newest registered path ([#466](https://github.com/Omega-JS-Stack/omega/issues/466)).
It shipped in 0.45.0 and was withdrawn: static hosting has no server, so the map could only
ever be answered CLIENT-side off the built 404 page, and a search engine saw a 404 that
redirects rather than a move. Redirects are not web config at all now — a TEMPLATED
redirect needs edge computing, an enumerable one is a page. Registered at its authored
path, the one place a carrying brand has it.

| Retired path | New home |
|---|---|
| `targets.web.redirects` | **`edge.providers.cloudflare.rules.redirect`** for a templated redirect (`/c/:id` → `/code?id=:id`, the DashQR pattern) — the manager's edge service reconciles the ruleset ([docs/manager/edge.md](../manager/edge.md)). A redirect whose URLs can be ENUMERATED is a redirect PAGE instead: `redirect.url` in frontmatter on the `modules/utilities/redirect` layout ([docs/web/index.md](../web/index.md)) |

The four schema-less web sections are registered paths too
([#850](https://github.com/Omega-JS-Stack/omega/issues/850), Ian 2026-09-09:
everything the build processes has a schema home). They were legacy UJM
presentation blocks the converter wrote under `targets.web` with no schema rule
anywhere, and @omega.js/web carried a PRIVATE list (`WEB_ONLY_SECTIONS`) purely
so its own `config:` guard would pass them. That list is gone: each key is
undeclared, so a brand still carrying one fails the strict load instead of
authoring a value nothing reads, and `omega migrate` names the home. Registered at their authored path,
the one place a carrying brand has them, and `omega migrate` drops the three
with a note and moves the currency.

| Retired path | New home |
|---|---|
| `targets.web.favicon` | nothing for the path: the favicon set is MINTED from the brand images (manager assets service) and bridged to `/assets/images/favicon`, so an override pointed the whole site at an unminted folder. Change the source image, **`brand.images.favicon`**. The `theme-color` half is **`brand.color`**, the one place a brand states its hex |
| `targets.web.manifest` | nothing: no reader anywhere in @omega.js/web. The web app manifest that ships is the minted set's own `site.webmanifest` |
| `targets.web.icons` | **the `icon` on the link itself**, as Font Awesome classes (`icon: 'fa-brands fa-github'`): one icon mechanism ([#619](https://github.com/Omega-JS-Stack/omega/issues/619), [icons.md](icons.md)), so there is no name-to-markup map |
| `targets.web.currency` | **`payment.currency`**: the price currency belongs to the payment section every other surface reads it from, and the pricing JSON-LD reads it there |

`targets.desktop.downloads.*` are the newest registered paths ([#799](https://github.com/Omega-JS-Stack/omega/issues/799)).
The `download-server` mirror gave marketing a fixed filename, which the versionless artifact
names ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)) made free: the site links
the ONE public releases repo directly and reads nothing from the mirror, so #799 deleted the
lane. Without these rows a brand carrying the block validates clean (it sits inside the
exempt `targets` namespace), gets a second repo provisioned and nothing published to it.
Registered per KEY at its authored path, never by name: the curated
`site.targets.desktop.downloads` map is a legitimate `downloads` one level down.

| Retired path | New home |
|---|---|
| `targets.desktop.downloads.enabled` | **`targets.desktop.releases`**: one public releases repo per brand, and its versionless assets ARE the permanent download links |
| `targets.desktop.downloads.owner` | nothing: there is no second repo to own, and the releases repo derives as `<brand.id>-releases` under `repo.owner` (#883) |
| `targets.desktop.downloads.repo` | nothing: the releases repo derives as `<brand.id>-releases` (#883) |
| `targets.desktop.downloads.tag` | nothing: `/releases/latest/download/<asset>` is what the stable mirror tag was for |

The company is ONE key now ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)),
outside `brand`, and everything else about the company is RESOLVED at load. The typed
display name and the typed parent wordmark are registered retired PATHS; the typed
`company.url` (and any `company.name` / `company.images`) fails the LOAD instead, naming
the file, because the resolver fills those same keys and a retired-key sweep over a
resolved config would fire on its own answer. Past the brand file, a resolved or baked
config carries those three keys legitimately, so the validator treats the loader-filled
`company.name` / `.url` / `.images` as declared. The by-hand step, and the `parent` /
`.omega/company.json` half, are in
[breaking-changes.md](breaking-changes.md#2026-09-12-one-company-key-and-a-company-tree-inside-the-parent-677).

| Retired path | New home |
|---|---|
| `brand.company` | **`company.name`**, resolved from `company: { id: '<parent brand.id>' }`: the parent's name is the parent's to state |
| `brand.images.companyWordmark` | **`company.images.wordmark`**, resolved from the parent's own `brand.images.wordmark` |
| `company.url` (typed) | **`company.url`** (resolved): type `company: { id }` and the loader fills it; an authored one fails the load |
| `parent` (every value) | The key is RETIRED outright ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)): the topology is **`company: { id: 'self' }`** / **`company: { id: '<parent brand.id>' }`**, and the opt-out `parent: false` is **`company: { webhooks: false }`**. A config still carrying `parent` fails the strict load, and `omega migrate` names `company.webhooks` |

Two top-level sections nothing reads any more are rows too
([#859](https://github.com/Omega-JS-Stack/omega/issues/859)), found on a live brand that
still carried them. Each is registered at its authored path, one row for the whole section,
so `omega migrate` names it and `--execute` deletes it.

| Retired path | New home |
|---|---|
| `adsense` (the whole section, `accountId` included) | **`advertising.providers.adsense.client`**: the provider's own `ca-pub-…` id, from which the manager derives the account ([#527](https://github.com/Omega-JS-Stack/omega/issues/527)). Write the id there first if it is not already |
| `download` (the top-level page map: `mac.universal`, `linux.debian`, …) | **`targets.desktop.releases`**, curated onto `site.targets.desktop.downloads` ([#610](https://github.com/Omega-JS-Stack/omega/issues/610)) |

### electron-manager (`config/electron-manager.json` → `config/omega.json5`) — DONE (checkpoint 18)

| Legacy | New |
|---|---|
| `brand`, `analytics`, `payment`, `theme` | top level, unchanged |
| `firebaseConfig` | **`cloud: { provider: 'firebase', config: {…} }`** (D12) |
| `sentry` | **`monitoring: { providers: { sentry: { dsn } } }`** ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)) |
| `app` | `targets.desktop.app` |
| `targets.mac` / `targets.win` / `targets.linux` (per-OS) | `targets.desktop.platforms.mac` / `.windows` / `.linux` ([#867](https://github.com/Omega-JS-Stack/omega/issues/867): the vocabulary is `mac`, `windows`, `linux`, and what each ships is `platforms.<platform>.formats.<format>`; `platforms.linux.snap` moved inside as `platforms.linux.formats.snap`, its `enabled` flag replaced by presence) |
| `autoUpdate`, `startup`, `releases`, `remoteConfig`, `restartManager` | `targets.desktop.<same key>` |
| `electronBuilder` overrides | `targets.desktop.electronBuilder` |
| `cdp` | `targets.desktop.cdp` |
| `windows` (optional) | `targets.desktop.windows` |
| `fileAssociations`, `protocols` | `targets.desktop.<same key>` |

### backend-manager (`functions/backend-manager-config.json` → `functions/config/omega.json5`) — DONE (checkpoint 19)

| Legacy | New |
|---|---|
| `brand`, `analytics`, `payment` | top level, unchanged |
| `oauth2` | **`connections`** — the per-provider block is unchanged ([#788](https://github.com/Omega-JS-Stack/omega/issues/788)); the credentials become the `CONNECTIONS_<PROVIDER>_CLIENT_ID`/`_SECRET` pair |
| `firebaseConfig` | **`cloud: { provider: 'firebase', config: {…} }`** (D12) |
| `sentry` | **`monitoring: { providers: { sentry: { dsn } } }`** ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)) |
| custom keys (`omega`, …) | REFUSED: the schema is strict ([#859](https://github.com/Omega-JS-Stack/omega/issues/859)), so a key no rule declares fails the load. `mcp.authUrl` is the one declared backend override (`targets.backend.mcp.authUrl`); anything else moves to its real home or goes |
| `github`, `reviews`, `marketing`, `blog`, `dataRequest` | top level, unchanged ([#277](https://github.com/Omega-JS-Stack/omega/issues/277)): shared keys the manager reads brand-level, so a website-only brand has a home for them; `targets.backend.<same key>` still overrides |
| `parent` | RETIRED outright ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)): a URL or `'self'` becomes **`company: { id }`**, and `parent: false` becomes **`company: { webhooks: false }`**. The key itself fails the load now, naming its new home |

Notes: @omega.js/backend's framework-defaults layer is `templates/config/omega.json5` resolved through
the same loader and passed as `options.defaults`; `initialize()` takes no
`backendManagerConfigPath` option (the loader discovers the file); boot warns on
schema findings, `npx omega test`'s target checks are the hard audit. The sandbox brand dogfoods the full
hierarchy: shared sections live in `brands/sandbox-brand/config/omega.json5` (brand level),
the backend target's local file carries only `targets.backend`.

### browser-extension-manager (`config/browser-extension-manager.json` → `config/omega.json5`) — DONE (checkpoint 20)

| Legacy | New |
|---|---|
| `brand`, `analytics`, `theme` | top level, unchanged |
| `firebaseConfig` | **`cloud: { provider: 'firebase', config: {…} }`** (D12) |
| `sentry` | **`monitoring: { providers: { sentry: { dsn } } }`** ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)) |
| custom keys (`liveReloadPort`, …) | REFUSED: the schema is strict ([#859](https://github.com/Omega-JS-Stack/omega/issues/859)), so a key no rule declares fails the load |
| `analytics.providers.google.secret` | **`.env` → `GOOGLE_ANALYTICS_SECRET`** (secrets never in omega.json5; loader hard-fails) |
| *(no extension-specific keys yet)* | `targets.extension: {}` — presence = enabled; extension-specific settings land here |

Notes: `build.getConfig()` (`require('@omega.js/extension/build')`) returns the RESOLVED config (missing file → `{}`; schema
findings warn once per process — BXM has no separate audit surface). The build snapshot
(`OMEGA_BUILD_JSON`, the artifact's one `build.js`) bakes `GOOGLE_ANALYTICS_SECRET` from the environment at
build time, same value flow as before. `bxm setup` scaffolds + merges `config/omega.json5`
(the defaults merge now preserves consumer-only keys at every level — it previously
dropped them).

### ultimate-jekyll-manager (`src/_config.yml` + `config/ultimate-jekyll-manager.json`) — `omega migrate` (B4, checkpoint 32)

The web leg of the brand-root `omega migrate` converts the consumer (a bare run
reports, `--execute` writes). It emits declared keys only, and never judges the
brand config itself: the brand-root config pass is the one place that does
([manager/index.md](../manager/index.md)).

| Legacy | New |
|---|---|
| `url` | `brand.url` (site.url derives; empty `baseurl` dropped) |
| `brand`, `theme` | top level, verbatim |
| `oauth2` | **`connections`** — same block, new name ([#788](https://github.com/Omega-JS-Stack/omega/issues/788)) |
| `analytics.{google,meta,tiktok}` (flat scalars) | `analytics.providers.<p>.id` — the unified spelling; the web chrome emits the client's flat shape from it |
| `web_manager.firebase.app.config` | **`cloud: { provider: 'firebase', config: {…} }`** (top level); the engine composes `cloud.config` back into `client.firebase.app.config` at build |
| `web_manager.payment` | **`payment`** (top level); composed back into `client.payment` (pricing layouts + the client read it there); credential keys set to `false` (legacy "disabled") are dropped |
| `web_manager` (rest: auth, exitPopup, …) | **`targets.web.client`** — the client-runtime settings blob, whole, under its new name (#1: `web_manager` → `client`, since it configures `@omega.js/client`; WebManager is not an OMEGA concept). No dual-read: the old key name is not honored anywhere |
| `web_manager.sentry` (`{ enabled, config: {…} }`) | **`monitoring: { enabled, providers: { sentry: {…} } }`** (top level) — the SDK knobs inside `config` ARE the provider block ([#485](https://github.com/Omega-JS-Stack/omega/issues/485)). Leaving them in the client blob meant the converted brand had no `monitoring` key at all, so the manager's monitoring service skipped every run and no Sentry project was ever reconciled |
| `web_manager.cookieConsent` (incl. `palette`, `theme`, `type`, `content.dismiss`) | **`targets.web.client.consent`** — the block that became a real gate (#383). `palette`/`theme` are gone (the panel paints from the `--omega-*` tokens); `type` is gone (the visitor's region picks opt-in vs opt-out); `content.dismiss` is now `content.accept`, beside `content.customize`, `content.panelIntro`, `content.acceptAll` and `content.acceptNone` (#391 retired `content.save` with the Save button) |
| `web_manager.chatsy` (agentId + widget settings) | **`inbound.chat.providers.chatsy`** — the chat widget left the client blob for the one chat home the manager also provisions (#23) |
| `socials` | **`socials`** (top level) — a SHARED_SCHEMA key, so the root is its home and the scaffold emits it there ([#483](https://github.com/Omega-JS-Stack/omega/issues/483)). A web load resolves `targets.web.socials` identically, which is why the converter used to leave it in the target; the handles are brand identity, read past the website too |
| `translation` | **`translation`** (top level): a SHARED_SECTIONS key, so the root is its home and the scaffold emits it there ([#526](https://github.com/Omega-JS-Stack/omega/issues/526)). A web load resolves `targets.web.translation` identically, which is why the converter used to leave it in the target; but disperse copies the SHARED sections, so a target-scoped engine config is invisible to every other target that translates (the extension's `_locales`). `translation.include` stays a web-only key at that shared home, and the legacy `exclude` list CONVERTS to it on the way through ([#858](https://github.com/Omega-JS-Stack/omega/issues/858)): `exclude: ['docs']` becomes `include: ['**', '!docs']`, one note, so the brand keeps translating exactly what it was |
| `meta` | **`targets.web.meta.index`, and nothing else**: the title/description half is DROPPED ([#607](https://github.com/Omega-JS-Stack/omega/issues/607), Ian 2026-08-26: meta never exists in two places): the site-wide defaults are `brand.name` / `brand.description` (what @omega.js/web's head falls back to) and everything per-page is that page's own `meta:` frontmatter ([docs/web/frontmatter.md](../web/frontmatter.md)). The `index` half lives on under the SAME name a page writes ([#564](https://github.com/Omega-JS-Stack/omega/issues/564), Ian 2026-09-09). `omega migrate` drops the legacy title/description with a note, and a config still carrying `meta.title` / `meta.description` fails the strict load |
| `download`, `extension`, `favicon`, `manifest`, `icons`, `currency` | **DROPPED with a note, every one** (nothing lands under `targets.web`): `download` / `extension` derive from the desktop and extension targets ([#610](https://github.com/Omega-JS-Stack/omega/issues/610)); `favicon`, `manifest` and `icons` retire with [#850](https://github.com/Omega-JS-Stack/omega/issues/850) (the favicon set is minted and `theme-color` comes from `brand.color`, nothing reads a manifest block, and a link carries its own `fa-*` classes). `currency` MOVES to **`payment.currency`**. Each one is a registered retired path, so carrying it forward would write a config the validator refuses |
| `recaptcha` (incl. `site-key`) | **`captcha.providers.recaptcha`** (`siteKey` — every key is camelCase, #23) |
| `cloudflare` (the purge `zone`) | **`edge.providers.cloudflare`** — one cloudflare home, shared with the manager's zone reconciliation (#23) |
| `advertising.google-adsense` (flat or under `providers`) | **`advertising.providers.adsense`** with camelCase slots (`displaySlot`, `inArticleSlot`, `inFeedSlot`, `multiplexSlot`) — provider ids drop the vendor prefix (#23). An `enabled` or `units` gate beside them is DROPPED with a note ([#628](https://github.com/Omega-JS-Stack/omega/issues/628)): `client` presence is the one switch, so carrying the gate forward would validate as retired while the id turned the account and the units back on |
| `permalink`, `pagination`, `defaults`, `generators`, and any other unrecognized section | **DROPPED with a note per path**: no omega.json5 key reads them, and the schema is strict ([#859](https://github.com/Omega-JS-Stack/omega/issues/859)), so the converter emits only declared keys. Carry a setting that still matters by hand. (`collections` is its own row: dropped with its manual step, [#589](https://github.com/Omega-JS-Stack/omega/issues/589)) |
| UJM-json `distribute`, `sass.purgecss`, `imagemin`, `github.workflows` | `targets.web.{purgecss,imagemin}`; `distribute` and `workflows` are DROPPED with a note (undeclared, nothing reads them). `imagemin` is LIVE (schema-known; `enabled: false` ships images verbatim, otherwise the build-time 320/640/1024 + webp matrix runs), and `purgecss.safelist` is LIVE too ([#250](https://github.com/Omega-JS-Stack/omega/issues/250)): schema-known (`{ standard, deep, greedy, keyframes }` arrays, or a bare array for `standard`), it merges over the framework's built-in safelist in the purge pass |
| UJM-json `webpack`, `gems`; `_config.yml` Jekyll machinery (`plugins`, `exclude`, …) | dropped, noted in the report |
| secret-shaped keys anywhere | dropped + warned — move to `.env` |

Beyond config: the codemod rule table runs over `src/**` templates, the seed
`src/assets/js/main.js` is deleted (core main + boot runtime replace it;
customized ones are flagged with the port recipe), `main.scss`'s
`@use 'ultimate-jekyll-manager' with (…)` becomes `@use 'omega:main' with (…)`,
page-css self-`@use` lines are dropped, and Gemfile/Gemfile.lock/the legacy
configs are removed.

### omega-manager brand configs (`.brands/{id}/config.json`)

The brand-config `targets` ARRAY's role is absorbed by key presence in the omega.json5
`targets` object. omega-manager's disperse writes omega.json5 from brand config + state at
its Phase-3 cutover (enumerating `SHARED_SECTIONS`, per-surface values into
`targets.<name>` overrides).

## Package API (quick reference)

```js
const {
  loadConfig,          // (projectDir, target?, { defaults }?) → { config, errors, warnings, enabled, name, files }
  composeTargetConfig, // (projectDir, target) → { config, files } — company+brand+local frozen into ONE self-contained file (deploy upload boundary, #31)
  hasOmegaConfig,      // (projectDir) → boolean — "is this project migrated?"
  resolveConfigPath,   // (projectDir) → abs path | null
  overlayPath,         // (basePath, environment) → the abs omega.<environment>.json5 beside that base, existing or not: the ONE spelling of an overlay file (the loader and the migrate config pass both name it through here)
  seoSidecarPath,      // (basePath) → the abs seo.json5 beside that base, existing or not: the ONE spelling of the sidecar (the loader and the migrate config pass both name it through here)
  getEnabledTargets,   // (config) → ['web', 'backend', …]
  findBrandRoot,       // (projectDir) → brand root | null — CLASSIFIES one target dir (THE hierarchy rule)
  findBrandConfigPath, // (projectDir) → the BRAND layer's omega.json5 | null — the file a target with no local-layer file rides
  resolveBrandRoot,    // (startDir) → brand root | null — SEARCHES upward from anywhere (standalone → itself), bounded at the nearest .git
  loadEnv,             // (startDir) → { chain, loaded } — resolve + load the .env cascade
  reloadEnv,           // (startDir, options?) → same — drops the FILE-owned keys, then loads again, so an EDITED value lands and the shell still wins (#724)
  resolveEnvChain,     // (startDir) → { local, brand, company } .env paths (no loading)
  loadEnvChain,        // (paths) → loaded[] — dotenv strongest-first, nulls/missing skip
  resolveCompany,      // (brandRoot) → { id, name, url, images, root, dir, file(relPath), config }: the ONE company resolver (#677)
  recordBrand,         // ({ id, root, name, url }) → wrote?: the machine registry line every loadConfig refreshes, unless it is passed `record: false` (`omega status`)
  readRegistry,        // () → { <brand.id>: { root, name, url, updatedAt } }: ~/.omega/brands.json (OMEGA_HOME moves it)
  COMPANY_RESOLVED_FILE, // 'config/company-resolved.json5': the generated layer a deploy hands a runner
  // The mint bridge (mint-bridge.js): the minted identity files a site ships, read by the web build and the deploy snapshot
  MINT_ROOT,           // '.omega/assets': where the manager's assets service mints, brand-root relative
  LOGO_SOURCES_DIR,    // 'assets/logo': the committed logo sources
  BRANDMARK_SOURCE,    // 'assets/logo/brandmark.svg': the one source the whole mint derives from
  MINT_BRIDGE,         // [{ src, dest }]: brand-root relative source to site path, the four files a site ships
  FAVICON_DEST, BRANDMARK_SVG_DEST, BRANDMARK_PNG_DEST, // the bridge's site paths read by name
  mintBridgeSources,   // (brandRoot) → the bridge sources that exist, brand-root relative, in bridge order
  hasLogoSources,      // (brandRoot) → whether BRANDMARK_SOURCE exists: the question the mint asks before it runs
  resolveHook,         // (startRoot, 'account/password') → hook file | null (brand → company)
  loadHook,            // (startRoot, hookPath) → { fn, file } | null — broken hooks THROW
  validateConfig,      // (config, { target, decorated }?) → { errors, warnings }; an undeclared path is an error (strict, #859); `decorated` declares a baked config's build facts
  undeclaredPaths,     // (config, { target }?) → the leaf paths no rule declares
  undeclaredAuthoredPaths, // (fileConfig, { target }?) → the same, over one authored file: whole file, then each framework target entry (the migrate pass and the web converter)
  runSchema,           // low-level rule walker (EM's proven engine)
  formatErrors,        // errors → numbered block
  resolvedBrandHost,   // (config) → the BRAND's own host (`brand.url`, top-level `url` only as fallback), lowercased | '' — authDomain validation AND every persona address (#708). Home: `src/brand-host.js`, browser-safe and stdlib-only, also the `@omega.js/config/brand-host` subpath; a browser surface reaches it through `@omega.js/client/modules/brand-host.js` (client's build vendors it), which web's dev palette imports
  findSecretKeys,      // (object) → paths of secret-shaped keys, a list position `[0]`
  keyPath, itemPath,   // (parent, key) / (parent, index) → the one spelling of a config path (`seo.github.content[0].org`)
  pathSteps, spellSteps, // path ↔ steps, a list position a number step: the one parser and its inverse
  chosenProvider,      // (role.providers) → the picked provider name | null — presence is the pick, `false` the off switch (#425)
  backendProjectType,  // (targets.backend | resolved backend config) → 'firebase' | 'custom' — how the backend runs (#584)
  BACKEND_PROJECT_TYPES,
  applyConfigEdits,    // (source, edits, { comments }?) → edited source — comment-preserving (see Writeback)
  writeConfigValues,   // (projectDir, edits, { dryRun, comments }?) → { path, changed, applied }
  writeConfigFileValues, // (configPath, edits, options?) → the same, on one named omega file (an overlay, a target's own)
  applyConfigRemovals, // (source, paths) → edited source — deletes a key, its subtree and its own comment (#612)
  removeConfigValues,  // (projectDir, paths, { dryRun }?) → { path, changed, removed } — absent paths skip, so reruns are byte-identical
  removeConfigFileValues, // (configPath, paths, options?) → the same, on one named omega file
  schemaDefaults,      // (target?) → the schema's own defaults, the merge chain's lowest layer (#478)
  missingDefaults,     // (rawConfig, target?) → [{ path, value }] — the blocks a brand file lacks (the manage heal's list)
  planMerge,           // (incoming, present) → { added: [{ path, value }], kept: [{ path, value, incoming }] }: filling `present` from `incoming`, never overwriting (missingDefaults' planner; the web migrate leg's root merge)
  setAtPath,           // (object, dotted, value) → sets the value at a dot-path, creating the objects on the way
  defaultComments,     // (target?) → { 'dot.path': description } — the guiding comments a materialized block carries
  deepMerge,           // agnostic layer merge
  // The targets map (targets.js: every key is a NAME, #886)
  targetEntries,       // (config) → [{ name, type, …entry }] in config order; throws on a missing/unknown type
  targetsOfType,       // (config, 'web') → the same entries, that type only
  targetPath,          // (config, 'community') → 'targets/community'; an undeclared name throws with the declared list
  targetNameFromDir,   // (projectDir) → the target root's basename inside a brand (functions//dist/ normalize up); null standalone
  targetUrl,           // (config, name) → entry url → entry brand.url → brand.url when name IS the type → pagesAddress(config, name) for a web target on a *.github.io brand → https://<name>.<brand host> | null
  targetPortOffset,    // (config, name) → position among the SAME-type targets (dev-port offsets)
  brandHost,           // (url) → the host exactly as brand.url states it (www kept, path dropped, port kept)
  // The GitHub Pages address (repo.js, #1145)
  pagesAddress,        // (config, name) → https://<owner lowercased>.github.io/<brand.id>-<name> for a GitHub-hosted web target | null; an unset brand.url resolves to pagesAddress(config, 'web')
  isDefaultPagesHost,  // (host) → whether it is a GitHub default Pages host (`*.github.io`): an address, never a domain
  defaultAddressReason, // (url) → the ONE skip reason of every domain-managing reader (edge, domain, search, cloud, account, campaigns, captcha, verify live gate, web purge) for a default Pages host | null
  TARGET_NAME_PATTERN, TARGET_TYPES, // the name slug rule and [web, backend, desktop, extension, mobile, custom]
  // The browser subset (#894): what a browser surface may see, and the one wrapper it is baked in
  clientConfig,        // (resolved + this build's facts) → the blob every browser surface bakes as OMEGA_BUILD_JSON.config
  CLIENT_FACT_KEYS,    // the build facts that ride beside the client sections (runtime, environment, version, buildTime, target, url, dev)
  TARGETS, SHARED_SECTIONS, CLIENT_SECTIONS, SHARED_SCHEMA, TARGET_SCHEMAS,
} = require('@omega.js/config');
```
