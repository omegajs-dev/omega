# The campaigns service — the brand's email marketing (SendGrid)

The `campaigns` service reconciles the brand's email-marketing infrastructure on SendGrid:
domain authentication, link branding, a verified sender for Single Sends, the brand's marketing
list, the unsubscribe groups the backend sends through, `@omega.js/backend`'s custom fields and
segments, and the account-global Event Webhook. It runs after `edge`, because the DKIM records
are written into the Cloudflare zone.

The whole service reconciles ONE SendGrid account per brand-or-company: the
groups/fields/segments/webhook operations converge on the same result when sibling brands
share the account.

## What it reconciles

| Operation | What it does |
|---|---|
| `domain-auth` | SendGrid domain authentication for `brand.url`'s domain. Missing → authenticate (`automatic_security` returns three CNAMEs under `emailauth.`), diff-sync those records into the Cloudflare apex zone, then validate — an interactive run polls until DNS propagates and SendGrid confirms. |
| `link-branding` | SendGrid link branding for `brand.url`'s domain — the `emailurl.` host every transactional link is rewritten through. Missing → brand the links (`POST /v3/whitelabel/links` with subdomain `emailurl`), diff-sync both returned CNAMEs into the Cloudflare apex zone UNPROXIED, then validate — an interactive run polls until SendGrid confirms. On valid, the `emailurl` CNAME is PATCHed to proxied ([#693](https://github.com/Omega-JS-Stack/omega/issues/693)). Skipped on a subdomain project: the apex records belong to the parent brand's walk. |
| `sender-identity` | The verified sender Single Sends require: `offers@{contact domain}` with the brand's name. It auto-verifies because `domain-auth` ran first. |
| `list` | The brand's marketing list, resolved config id → exact-name lookup → create, with the id written back to `marketing.campaigns.providers.sendgrid.listId`. |
| `unsubscribe-groups` | The account's ASM groups (below). |
| `custom-fields` | `@omega.js/backend`'s custom fields, from its marketing SSOT, honoring each field's provider skip list (SendGrid has first/last name built in) — ONE derivation (`fieldsForProvider()`), the same one the backend's contact sync writes through, so a skipped field is neither provisioned here nor sent there ([#695](https://github.com/Omega-JS-Stack/omega/issues/695)). A type mismatch cannot be patched in SendGrid, so the field is deleted and recreated. |
| `segments` | `@omega.js/backend`'s segments, each one's `query_dsl` rebuilt from its conditions and compared against the live segment; stale ones are PATCHed, falling back to delete + recreate. Orphaned `__temp_` segments (leaked by a brand-scoped campaign send that crashed) are swept. |
| `event-webhook` | The account-global Event Webhook pointed at the PARENT backend's forwarder, with the consent toggles (`bounce`, `dropped`, `spam_report`, `unsubscribe`, `group_unsubscribe`) enabled and drift patched by minimum diff. |

Fields and segments `@omega.js/backend` does not own are never touched.

## Unsubscribe groups ([#649](https://github.com/Omega-JS-Stack/omega/issues/649))

The `unsubscribe-groups` operation ensures the SendGrid ASM groups the backend's send path
names actually exist, and lands their ids in config. The KEYS come from `@omega.js/backend`'s
email SSOT (`GROUP_KEYS`); the recipient-facing NAME and description of each live here, on the
provider side:

| Key | Group name |
|---|---|
| `orders` | OMEGA - Order Updates |
| `hello` | OMEGA - Onboarding |
| `account` | OMEGA - Account |
| `marketing` | OMEGA - Marketing & Promotions |
| `security` | OMEGA - Security |
| `newsletter` | OMEGA - Newsletter |
| `internal` | OMEGA - Internal Alerts |

Groups are matched by NAME, never by id: ASM ids are per SendGrid ACCOUNT, so sibling brands
sharing one account converge on the same groups and land the same ids. Each resolved id is
written to `marketing.campaigns.providers.sendgrid.groups.<key>` — its ONE authoritative home,
through the comment-preserving editor, so a converged brand leaves omega.json5 byte-identical.
`@omega.js/backend` reads the id there and fails loudly at send time when one is missing. A
backend group key with no name+description row here throws at the top of the operation, not at
send time. A dry run names the groups it would create and writes nothing.

## Config

- `marketing.campaigns.enabled: false` — skip.
- `brand.url`: none skips the service, and so does one on a default Pages host (`*.github.io`,
  the address an unset `brand.url` resolves to, [config.md](../shared/config.md)), with
  `brand.url is the hosting provider's default address (<host>): no domain to manage`, before the SendGrid key ask: there is no
  sender domain to authenticate.
- `marketing.campaigns.providers.sendgrid` — the vendor is a KEY under `providers`
  ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)): no entry means none chosen.
- `marketing.campaigns.providers.sendgrid.listId` — written back by `list`.
- `marketing.campaigns.providers.sendgrid.groups.<key>` — written back by `unsubscribe-groups`.
- `brand.address` — the physical mailing address CAN-SPAM requires on a sender. omega-manager
  stamped the company's address on every brand; this ASKS for the brand's own
  ([#635](https://github.com/Omega-JS-Stack/omega/issues/635)), five fields behind ONE gate,
  and warns only when nobody can be asked.
- `company` names whose backend the Event Webhook points at
  ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)): the RESOLVED `company.url`,
  which is this brand's own url when it names no company. `company: { webhooks: false }` is
  the one deliberate opt-out, for a shared provider ACCOUNT whose single account-level webhook
  belongs to somebody else.

**Credentials**: `SENDGRID_API_KEY` in the brand `.env`. `OMEGA_WEBHOOK_KEY` is OMEGA's own
and is MINTED by the setup contract rather than asked for
([#635](https://github.com/Omega-JS-Stack/omega/issues/635)), so the webhook operation can
read it even when this service runs before the workspace one did.

## Gotchas

- **SendGrid supports ONE Event Webhook per account**, so it always targets the parent brand's
  forwarder and the parent fans events out to each brand's own `/marketing/webhook` endpoint.
  Only the consent toggles are managed — tracking toggles (open/click/delivered) are not ours
  to touch.
- **No Cloudflare token is survivable.** `domain-auth` prints the records to add by hand and
  still attempts validation, so a manual fix converges on the next run; `link-branding` prints
  the one-line manual flip (orange-cloud the `emailurl` CNAME) and warns.
- **`link-branding` writes its own CNAMEs, because on run 1 nobody else has.** The `edge`
  service builds the SendGrid record set from a LIVE domain-auth read, and a brand new brand has
  no authenticated domain until `domain-auth` creates one minutes later in the same walk — so
  edge wrote none of those records, and a branding with no CNAME behind it can never validate.
  This operation diff-syncs both link CNAMEs itself (unproxied, the only state SendGrid can
  validate) through the same writer `domain-auth` uses. Edge still stays the RECONCILER: its
  next live read sees `valid: true` and desires the record proxied, so both services agree
  ([#693](https://github.com/Omega-JS-Stack/omega/issues/693)).
- **The sender's identity needs human input** where config has none: the address prompt is a
  genuine ask, not a wait, so a headless run legitimately warns.
- **Changing the query builder re-syncs every segment.** The generated SQL is compared against
  the live segments for staleness, so any edit to the DSL translation is a fleet-wide re-sync
  on the next run.
