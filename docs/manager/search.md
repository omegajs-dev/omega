# The search service — the Search Console property

The `search` service owns the brand's Google Search Console presence: the `sc-domain:{domain}`
domain property (which covers every subdomain), verified by a DNS TXT record written through
Cloudflare, plus sitemap submission and the GA-association nudge. It runs after `edge` (the
zone must exist for TXT verification) and after `analytics` (the GA property is what the
association points at).

## What it reconciles

- **`property`** — an existing property is converged proof, nothing else to check. A missing
  one is created in ONE pass: fetch the DNS_TXT verification token (idempotent — Google returns
  the same token until it is used), write the TXT record via Cloudflare (a stale
  `google-site-verification` record at the same name is replaced), then verify. Interactive
  runs poll until DNS propagates; non-interactive and dry runs attempt verification once,
  report warned, and the rerun converges.
- **`ga-link`** — the Search Console ↔ GA4 association. There is NO API on either side, so it
  is instructions plus an interactive confirm, warned until confirmed; the confirmation lands
  at `search.providers.searchConsole.gaLinked`
  ([#434](https://github.com/Omega-JS-Stack/omega/issues/434)) so the next run believes it.
- **`sitemaps`** — submits only what is MISSING. Legacy omega-manager resubmitted every
  sitemap on every run, which made a converged brand mutate forever; Google re-crawls
  submitted sitemaps on its own.

## Config

| Key | Meaning |
|---|---|
| `search.providers.searchConsole.enabled: false` | Skip the service. |
| `search.providers.searchConsole.sitemapPaths` | Paths to submit (default `/sitemap.xml`). |
| `search.providers.searchConsole.submitSitemap: false` | Turn sitemap submission off. |
| `search.providers.searchConsole.gaLinked` | The one-time GA-association confirm. |
| `analytics.providers.google.propertyId` | Read (not written) by `ga-link` — no property, nothing to associate. |

**Credentials**: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, scopes `webmasters` and
`siteverification`, on the ONE shared token store (`.omega/auth/google-tokens.json`) beside
the cloud grant. `CLOUDFLARE_TOKEN` is optional: without it the property operation prints the
TXT record to add by hand.

## Gotchas

- **A brand with no web target has no sitemap to submit** — skipped, not warned.
- **No domain, no property.** No `brand.url` skips the service, and so does a `brand.url` on a
  default Pages host (`*.github.io`, the address an unset `brand.url` resolves to,
  [config.md](../shared/config.md)), with `brand.url is the hosting provider's default address
  (<host>): no domain to manage`. Both skip before the credential ask.
- **Verification happens once.** Google answers "already verified" when an earlier attempt
  succeeded; that is treated as success, not an error.
