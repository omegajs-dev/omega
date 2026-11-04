# The edge service — the brand's Cloudflare zone

The `edge` service reconciles the brand's zone to `edge.providers.cloudflare` in
`config/omega.json5`: the zone itself, DNS records, email routing, zone settings, the five
rulesets, scheduled speed tests, Web Analytics, and workers. It runs early — third in the walk — because
every DNS-dependent service after it needs the zone to exist. Every handler follows
read → diff → write (Cloudflare requires fetching current state before patching), and each
read step is cached to `.omega/cache/cloudflare/{op}.json` as a debugging aid.

## What it reconciles

| Operation | What it does |
|---|---|
| `zone` | The zone exists; created when missing. A pending zone reports its nameservers, and an interactive run on a manual registrar opens the registrar's nameserver page and polls until the zone activates. The resolved id lands in `edge.providers.cloudflare.zone` ([#434](https://github.com/Omega-JS-Stack/omega/issues/434)) — the id `omega purge` targets from a build, where no Cloudflare token is in play — and rides the run as state for every later operation. |
| `dns-records` | The required platform record set (GitHub Pages, `www`, the email provider's MX/SPF, DMARC; BIMI and the SendGrid CNAMEs only when configured) plus `dns.records` custom entries, diff-synced: create, update, delete. An apex MX record pointing at another registry mailbox provider is deleted only while a provider is picked; with none picked, existing MX records stay. |
| `email-routing` | Cloudflare Email Routing, only when `domain.email.providers` names cloudflare; rules come from `domain.email.forwarding` (`[{ from: 'support' \| '*', to: 'inbox@…' }]`). |
| `zone-settings` | A flat map matching Cloudflare's own setting IDs, diffed in one bulk read and patched per changed setting (Cloudflare has no bulk PATCH). Addon settings (`speed_brain`, `fonts`) need their own GET each. Read-only and absent settings are skipped, and one setting's failure never blocks the rest. |
| `cache-rules` | The `http_request_cache_settings` entrypoint ruleset, rules matched by description. The framework ships the whole default set (below), so a brand that declares nothing still gets both cache lifetimes. |
| `rules-managed-transforms` | Cloudflare's managed request/response headers, enabled or disabled per config name, PATCHed in one call. |
| `rules-redirect` | The `http_request_dynamic_redirect` ruleset — the ONE home for a brand's templated redirects ([#466](https://github.com/Omega-JS-Stack/omega/issues/466), below). |
| `rules-configuration` | The `http_config_settings` ruleset. |
| `rules-response-headers` | The `http_response_headers_transform` ruleset (always PUT — at the ruleset's id when it exists, at the phase entrypoint when it does not). |
| `rules-security` | Custom firewall rules in `http_request_firewall_custom`. |
| `speed-scheduled-tests` | The homepage's Speed Test schedule (a create-or-replace POST on the custom Speed API endpoint). |
| `web-analytics` | Cloudflare Web Analytics, the beacon Cloudflare injects at the edge. It is ACCOUNT-level: the operation lists the account's RUM sites, finds the one for this zone, and makes its `enabled` match `webAnalytics.enabled` (a missing site is created with automatic install only when the key is `true`). A 403 (a token without "Account Settings Write") returns **warned** naming that permission, and the walk goes on; any other error, on the list or a write, fails the walk. |
| `workers` | Worker scripts + routes from `edge.providers.cloudflare.workers` — `script` names a file in the brand's `workers/` folder, else the company tree's `workers/`, else the service's own `workers/` dir (a name in none fails the walk, naming where it looked); `env` becomes `plain_text` bindings, and `secrets[]` names brand `.env` keys sent as `secret_text` bindings (a key with no value fails the walk before any request; values are never logged). A key named here is a brand-root custom `.env` key, and the env delivery sends every custom key to every target's deploy ([config.md's custom-key rule](../shared/config.md#the-env-schema-srcenv-schemajs--581)): the worker's secret also lands in the web and backend deploy secrets, which never read it. Nothing filters it today. `route` supports `{ domain }` templating. Every run re-uploads each worker and the upload replaces its bindings, so a secret set outside omega is dropped unless `secrets[]` names it. Unconfigured workers and routes are removed. |

## Config

Everything sits under `edge.providers.cloudflare`:

- `enabled: false` — the tri-state opt-out; the whole service skips.
- `zone` — the resolved zone id, written back by the `zone` operation.
- `dns` — `spf` (`'strict'`/`'soft'`), `dmarcPolicy`, `spfIncludes`, `dmarcReports.{rua,ruf}`,
  `bimiLogo`, and `records[]` for custom entries such as verification TXTs. The SendGrid
  domain-auth values are NOT here — they are read live off SendGrid every run
  ([#692](https://github.com/Omega-JS-Stack/omega/issues/692), below).
- `settings` — the zone-settings map, keyed by Cloudflare's setting IDs exactly.
- `cacheRules[]`, `rules.{managedTransforms,redirect,configuration,responseHeaders,security}`,
  `speedTest.{frequency,region}`, `workers[]` (`{ name, route, script, env, secrets }`: `script`
  from the brand's `workers/` folder, else the company tree's, else the service's; `secrets`
  names brand `.env` keys).
- `webAnalytics.enabled`: default `true`, so the zone carries the beacon unless a brand or
  company layer says `false`. The beacon sits outside the consent gate
  ([docs/shared/analytics.md](../shared/analytics.md)). So the first manage run of a brand
  whose zone has no Web Analytics site creates one with automatic install, and the zone starts
  injecting the beacon on that run. Every update sends `auto_install: true`, so a site set up
  for a hand-installed snippet becomes an automatic one.

The schema's defaults hold PLATFORM answers only, resolved but never written into a brand file
(`materialize: false`, docs/shared/config.md); company-specific values (DMARC report
addresses, the BIMI logo, extra CSP hosts) belong in the company or brand layer.

**Credential**: `CLOUDFLARE_TOKEN` in the brand `.env`, asked for through the shared setup
contract, with Zone edit on the brand zone plus "Account Settings Write" (the `web-analytics`
operation's RUM endpoints are account-level). No `brand.url` → the service skips. A `brand.url`
on a default Pages host (`*.github.io`, the address an unset `brand.url` resolves to,
[config.md](../shared/config.md)) skips it too, with `brand.url is the hosting provider's
default address (<host>): no domain to manage`: an address the host owns is no zone to add.
Both skip before the token ask.

**The email asks.** The service's setup asks for the mailbox provider when none is picked
(`domain.email.providers`, a choice from the registry's mailbox providers, landed as the
presence pick), after the token gate and the `brand.url` check and before any operation, so
`dns-records` reads the pick on the same walk. Its MX records land on that walk when no MX
sits at the apex, and on the next walk when another provider's MX had to be deleted first
(an existing record of the same name and type blocks creation while its delete clears it).
While no provider is picked (unset, `{}`, or `false`), `dns-records` leaves every existing MX
record alone; only a
pick marks another registry provider's apex MX records as obsolete. When the picked provider
routes mail (cloudflare) and `domain.email.forwarding` is empty, `email-routing` asks for the
first rule: the address to forward (`support`, or `*` for all) and the inbox it goes to,
landed as one `{ from, to }` entry. Disable at either ask writes `false` at that key and stops
that ask, and every reader takes `false` as none: no MX or SPF include and no rules, with
nothing deleted. A headless or dry run never asks: it prints the one line naming the key and
`config/omega.json5`. A subdomain project is never asked, since its parent brand owns the
apex mail records.

## Cache lifetimes: /assets and /build.js for a year, HTML for a minute

The schema's defaults carry the whole `cacheRules` set, so a brand that declares no rules
still reconciles both of them ([#751](https://github.com/Omega-JS-Stack/omega/issues/751)):

| Rule | Matches | Edge TTL | Browser TTL |
|---|---|---|---|
| `Assets: Cache for 1 Year` | `/assets/*` plus `/__/auth/iframe.js` and `/build.js`, on any host | 1 year | 1 year |
| `HTML: Short Browser Cache` | a SITE host (not `api.`), outside `/assets`, with no file extension or ending `.html` | 2 hours | 1 minute |

The safety in the one-year rule is the CONTENT HASH, and only the CSS and JS bundles carry
one (`main-39ce99d8.css`, `first-paint-A7T6PAIK.js`): new bytes get a new URL, so the old
one can be held forever. **Fonts and images under `/assets` are NOT hashed** — they land at
stable names by design (`assets/fonts/inter-normal-latin.woff2`,
`assets/images/brand/brandmark-640px.webp`), because `@font-face` src URLs are written into
theme CSS. So replacing a font file or a logo in place pins the OLD file in visitors'
browsers for up to a year, and a purge cannot reach a browser copy: ship such a replacement
under a new filename, or accept the year.

`/build.js`, the build snapshot every page and the service worker load, keeps ONE URL on
purpose, so its safety is the BUILD STAMP instead of a hash: every loader of it names the
build in its query string. The head writes `/build.js?cb=<stamp>`, and the service worker's
`importScripts` carries the same stamp, baked into the worker bundle at build
(`__OMEGA_BUILD_STAMP__`). A new build is a new URL at every loader, so the old copy can be
held for a year.

HTML is the opposite of a hashed bundle: its URL never changes, so whatever a browser holds
IS what a returning visitor sees until it expires. One minute is short enough that a deploy
is visible almost immediately; the rule sets its own 2-hour edge TTL (a cache rule overrides
the zone's `edge_cache_ttl` setting) and a deploy purges it.

**A cache rule is ZONE-scoped, so the HTML rule is guarded by host.** The zone serves the
brand's site AND `api.<domain>`, whose Firebase rewrites answer extensionless, user-scoped
GETs (`/authorize`, `/token`, `/omega/**`, `/mcp/**`) — edge-caching one of those would hand
one user's answer to the next. The zone also serves `emailurl.<domain>`, the proxied SendGrid
link-tracking CNAME, whose extensionless click and open URLs must reach SendGrid on every hit or
campaign counts undercount. The guard is `not starts_with(http.host, "api.")` plus the same for
`emailurl.`, rather than an equality on the site host, because every OTHER host on the zone is
a site host: the apex, `www`, and a subdomain project served under the parent zone. Those two
are the non-site hosts the stack creates, at every shape it builds (`api.brand.com`,
`api.app.brand.com` — `packages/manager/src/services/cloud/ensure/hosting.js`;
`emailurl.<domain>` — `packages/manager/src/services/edge/lib/dns-records-helpers.js`). A
hand-added `dns.records` host for some other service is not covered; declare your own
`cacheRules` in that case. The assets rule needs no guard: all three of its paths are static files
wherever they are served from.

The two rules cannot both match one request — the HTML expression excludes `/assets` across
BOTH of its path shapes (extensionless and `.html`), not just the extensionless one.
Extensionless is the normal page shape here, since the default redirect rule strips trailing
slashes (`/about`), and `not … contains "."` is how the free plan says "no file extension"
(`matches` needs Business).

`cacheRules` is an ARRAY, and arrays REPLACE across the config merge chain: a brand
declaring its own `edge.providers.cloudflare.cacheRules` replaces the framework set whole
(the same doctrine as `rules.redirect`), so its block has to carry any platform rule it still
wants. A subdomain project never runs this operation at all (below) — the parent brand's
zone owns the rules its subdomains are served under. A TTL of `0` is a legal value that
reaches Cloudflare as declared rather than falling back to the default
([#754](https://github.com/Omega-JS-Stack/omega/issues/754)): `browserTtl: 0` is `max-age=0`,
revalidate on every request, and a `0` edge TTL means whatever Cloudflare's own rules grammar
makes of it (a full edge bypass is a MODE there, not a TTL).

**Static hosting contributes nothing here.** The web target publishes to GitHub Pages, which
has no header configuration, and nothing in the stack writes a hosting config for the built
site — so the edge is the ONE place a brand's cache lifetimes are set
([docs/shared/deploys.md](../shared/deploys.md)).

## Templated redirects live here, not in the web config

A redirect whose destination is COMPUTED from the request path — DashQR's printed QR codes
point at `/c/<id>` for unbounded ids, and every one of them must land on `/code?id=<id>` —
cannot be enumerated as a page, and static hosting has no server to answer it with. It needs
edge computing, so `edge.providers.cloudflare.rules.redirect` is its one home
([#466](https://github.com/Omega-JS-Stack/omega/issues/466)): the web target's own
`targets.web.redirects` block shipped in 0.45.0 and is retired, and a config still carrying
it fails validation naming this key.

An entry is `{ name, expression, statusCode, preserveQueryString, targetUrl, enabled }`, in
Cloudflare's own filter language — nothing is translated, because the edge is what evaluates
it:

```json5
{
  name: 'Redirect: QR short code',
  expression: '(starts_with(http.request.uri.path, "/c/"))',
  statusCode: 301,
  // The target carries its OWN `?id=`, so an inbound querystring must not be appended
  preserveQueryString: false,
  targetUrl: { expression: 'concat("https://", http.host, "/code?id=", substring(http.request.uri.path, 3))' },
  enabled: true,
}
```

`targetUrl` takes `{ value }` for a fixed destination and `{ expression }` for a computed
one. The ruleset is reconciled whole — a configured rule is created or updated by `name`,
and a rule in Cloudflare that config does not name is REMOVED — so the block is the complete
desired set, the schema's platform defaults (the trailing-slash rule) included.

A redirect whose URLs CAN be enumerated is not this: it is a redirect PAGE in the web target
(`redirect.url` in frontmatter on the `modules/utilities/redirect` layout,
[docs/web/index.md](../web/index.md)).

**`omega dev` does not answer these routes** (the manager call, 2026-08-30). The edge owns
them, so `/c/<id>` is a plain 404 in dev, exactly as it is against the built output — a
local mirror of Cloudflare's filter language would exist only to disagree with production.
Verify a rule against the zone.

## Subdomain projects use the parent zone

When `brand.url` is not an apex (`playground.omegajs.dev`), the service works on the PARENT
zone (`omegajs.dev`) and runs only `zone` and `dns-records` — zone-level settings, rules and
workers belong to the parent brand. `dns-records` then only touches records belonging to the
subdomain. Creating the parent zone is inert until the registrar's nameservers point at it,
which the `domain` service handles right after.

## Gotcha: a subdomain project's API host stays DNS-only, so it gets no Cloudflare geo headers

Cloudflare's Universal SSL — every plan, free included — covers the apex and exactly ONE
label below it (`*.omegajs.dev`). A subdomain project's API host is two labels deep
(`api.playground.omegajs.dev`), so no certificate at the proxy can terminate TLS for it, and
the `cloud` service's hosting ensure leaves that CNAME **DNS-only** (grey cloud) with
Firebase serving the certificate instead (`packages/manager/src/services/cloud/ensure/hosting.js`,
`zoneTlsCoverage`). Traffic therefore never passes through Cloudflare, and Cloudflare's
visitor-location headers — the ones the `addVisitorLocationHeaders` managed transform turns
on — never reach that API. Region and city read null in the backend
([#638](https://github.com/Omega-JS-Stack/omega/issues/638)) and no edge setting fixes it:
nothing is missing, the name is simply outside the certificate.

- **Top-level brands are unaffected**: `api.brand.com` is one label under the zone, Universal
  SSL covers it, the record is proxied, and the geo headers arrive.
- **The fix for a subdomain project is the paid Cloudflare add-on** — Advanced Certificate
  Manager / Total TLS on the zone. The gate already recognizes it: the hosting ensure asks the
  zone for its ACTUAL coverage (`/acm/total_tls`, then active certificate packs) and proxies
  the name the moment a certificate covers it, printing which coverage let it through. A
  lookup failure falls back to not-covered — a DNS-only record works on every plan, a wrongly
  proxied one never does.
- **The log line names it either way**: verified-but-uncovered prints "Universal SSL stops at
  `*.<zone>`; no Total TLS or deeper cert pack on this zone — CNAME stays DNS-only, Firebase
  serves the certificate".

## The SendGrid records come from SendGrid, not from config

`emailauth.<domain>`, the `<id>.<domain>` owner CNAME, `emailurl.<domain>` and both DKIM keys
are all built from one host, `u<id>.<whitelabel>.sendgrid.net`. Those values are SendGrid's own
observed facts about the domain, so `dns-records` READS them per run
(`GET /v3/whitelabel/domains`, the same client the campaigns service uses, `SENDGRID_API_KEY`
from the brand `.env`) instead of carrying a config copy that nothing ever wrote back
([#692](https://github.com/Omega-JS-Stack/omega/issues/692)).

Every no-answer skips the whole SendGrid set and prints the reason: no `SENDGRID_API_KEY`, no
authenticated domain for this brand's domain (the campaigns service creates it), an unreachable
SendGrid, or a `mail_cname` that is not the `u<id>.<whitelabel>.sendgrid.net` shape — that last
one names the host it got. A dry run does the same read and names the host in its plan; a
subdomain project never asks, because the apex record set belongs to the parent brand.

## Gotcha: the branded-link CNAME is grey until SendGrid validates it

`emailurl.<domain>` is the one SendGrid record that rides Cloudflare's proxy. SendGrid
validates a branded link by resolving that host as a CNAME to `sendgrid.net`, and a
Cloudflare-PROXIED record answers with the edge's own addresses instead — so proxying it
before validation locks the branding out of ever validating and every emailed link stays
broken ([#646](https://github.com/Omega-JS-Stack/omega/issues/646)). The handler therefore
asks SendGrid first (`GET /v3/whitelabel/links`) and only proxies once that host reports
`valid: true`.

Since [#662](https://github.com/Omega-JS-Stack/omega/issues/662) the walk WAITS for that
answer instead of leaving the flip to a later run: `pollWithSpinner` re-asks SendGrid every
10s (ENTER checks now, `s` skips) and the same pass proxies the CNAME. A skipped wait, or a
run with no TTY, keeps the record grey and returns **warned** with the reason — "SendGrid has
not validated the branded link — the emailurl CNAME stays unproxied" — so the run summary
names what is still owed. An unreachable SendGrid or a subdomain project answer NO the same
way: the unproxied record is the safe half of the pair (with no key or no authenticated
domain, the SendGrid records are skipped outright).

A host with NO link-branding entry is the one NO that never waits — the `campaigns` service
creates and validates the branding LATER IN THE SAME WALK, when campaigns is enabled for the
brand ([#693](https://github.com/Omega-JS-Stack/omega/issues/693)), so waiting on it here would
never end. The line says so, the record lands grey (exactly the state SendGrid validates
against), and the step is not **warned**: there is nothing pending for this service to finish.
When the campaigns service's validation passes, it flips that same record to proxied itself;
this handler's next live read agrees, because a valid branding desires a proxied record. On a
brand's FIRST walk this handler writes no SendGrid records at all — the live domain-auth read
finds nothing yet — so the campaigns service writes both link CNAMEs itself.

## Other gotchas

- **The Speed API rejects a zone that is not active yet** (`speed.errors.zone_not_active`) —
  the operation skips until activation instead of failing.
- **A never-used ruleset phase** answers "could not find entrypoint ruleset"; that is detected,
  and the first write POSTs a new ruleset rather than PUTting a missing one.
- **Rules are matched by their `name`** (Cloudflare's `description`): rename a rule in config
  and the old one is removed and a new one created.
- **`omega-api-proxy.js`** is for a brand whose api host fronts a dedicated non-Firebase
  backend: the worker carves `/omega` (and the legacy `/backend-manager` alias) out at the
  edge and proxies it to the brand's Cloud Functions, passing everything else through.
