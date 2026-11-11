# Email System

Unified MJML-based email rendering for transactional, marketing, and newsletter emails. All email types go through the same pipeline: **prepare → render (MJML) → deliver (SendGrid)**. No SendGrid dynamic templates (`d-xxx` IDs) — everything is rendered server-side.

## Architecture

### Pipeline Overview

```
Caller (route/transition/cron)
  → prepare.js (shared: brand, sender, signoff, content, categories, unsubscribe URL)
    → templates/index.js (resolve template by name)
      → template.build({ data, theme }) → MJML string
        → mjml-template.js (compile MJML → email-safe HTML, UTM-tag all links)
          → transactional/index.js (recipients, dedup, SendGrid Mail Send)
             OR marketing/index.js (audience, Single Send)
```

### Entry Points

| Context | API | Delivers via |
|---|---|---|
| Transactional (individual) | `ctx.email.send(options)` (or `omega.email.send(options)` outside a request) | SendGrid Mail Send |
| Marketing (campaign) | `ctx.email.sendCampaign(options)` | Each role's provider: `campaigns` (SendGrid Single Send) + `newsletter` (Beehiiv post) |
| Newsletter (generated) | `generators/newsletter.js` → `renderNewsletter()` | Same as marketing |

### Email providers and roles

Each email-marketing provider's facts live in ONE row: `EMAIL_PROVIDERS` in `@omega.js/config` ([`packages/config/src/email-providers.js`](../../packages/config/src/email-providers.js)). Read the rows there; nothing else names a provider's role, key or fields. A row's fields mean:

- `id`: the provider (`sendgrid`, `beehiiv`), the name of its file in `libraries/email/providers/`.
- `role`: the role it serves (`campaigns` or `newsletter`), exactly one provider per role.
- `envKey`: the key that turns the role on.
- `nativeFields`: catalog fields the provider stores in its own columns, so it never takes them as custom fields (`fieldsForProvider()` leaves them out).
- `operations`: the functions the role's callers use, each exported by the provider's file.

How the rows are reached:

- `emailProvider(id)` and `emailProviderForRole(role)` answer a row, or null for an unknown id or role.
- The provider functions stay in the backend, one file per row at `libraries/email/providers/<id>.js`, gathered by the registry `libraries/email/providers/index.js` (static requires; `providerModule(id)` answers the module and throws for an id with none). `test/email/provider-registry.test.js` pins rows against files and every listed operation against the file's exports.
- Callers reach a provider through its role, never its name: `Marketing.roleProvider(role)` (`marketing/index.js`) answers the module through the registry, and `Marketing.roleOn(config, role)` is the one role gate (`marketing.<role>.enabled` not false, and the row's `envKey` set). The marketing library and the daily prune read the provider this way; the manager's campaigns and newsletter services find theirs with `emailProviderForRole`, and the env schema's two marketing ask rules read the row ids.
- The role words are the public shape: results, `settings.providers`, `data.providers.*` and config keep `campaigns` and `newsletter`.

### Shared Preparation (`prepare.js`)

Both transactional and marketing paths share the same preparation layer:

| Function | Purpose |
|---|---|
| `resolveBrand(omega)` | Clones brand config, sanitizes images (SVG→PNG via CDN naming) |
| `resolveSender({ sender, from, group }, brand, brandDomain, omega)` | Resolves sender from/display-name by category key, and the ASM group id from config (`marketing.campaigns.providers.sendgrid.groups.<key>`); see [Unsubscribe groups](#unsubscribe-groups) |
| `renderContent({ content, html, trusted }, utmOptions)` | Markdown→HTML via markdown-it, applies UTM link tagging. Raw HTML in `content` is DISABLED unless `trusted` is set — see [Content trust](#content-trust) |
| `resolveSignoff(signoff)` | The caller's signoff, passed through untouched; none is the team signoff (`{ type: 'team' }`). Nothing is filled from config |
| `buildCategories(type, brandId, extra)` | Builds categories array: `['transactional', brandId, ...extra]` |
| `buildUnsubscribeUrl({ email, groupId, template, websiteUrl })` | HMAC-signed one-click unsubscribe URL |
| `buildTemplateData({ brand, subject, ... })` | Deep-merges system defaults with caller data into the template data tree |
| `render({ brand, template, data, utm })` | Compiles MJML template to email-safe HTML via `renderEmail()` |

### Identity is config, or it is an error

Nothing in the email path carries a built-in human or company identity. Every name, logo and audit address comes from the merged config, and a missing one **fails loudly instead of falling back**: a silent default would sign a brand's mail as someone else.

| Surface | Config key | Missing behavior |
|---|---|---|
| Email footer parent entity | `company.name` (RESOLVED from `company: { id }`, [#677](https://github.com/Omega-JS-Stack/omega/issues/677)) | Falls back to `brand.name`, and a brand with no company resolves to its own name anyway |
| Email footer parent wordmark | `company.images.wordmark` (RESOLVED from the parent's own `brand.images.wordmark`) | The wordmark block is **omitted**: never another company's logo |
| Audit BCCs on `copy: true` sends | `brand.contact.carbonCopy` (`[{ email, name }]`) | No BCCs. A listed entry missing `email` throws 400 |

`copy: true` still CCs the brand's own `brand.contact.email` — that is the brand copying itself and needs no extra config.

No config names a person. Every send signs off as the brand's team ("The {Brand} Team") unless its caller passes its own `data.signoff`: a `personal` one carries its own `name`, `image`, `url` and `urlText`, and passes through untouched. The signup welcome, discount-nudge and checkup emails speak as the brand's team and sign off as it.

### Content trust

Email bodies arrive from two very different places, so `renderContent()` has two lanes and the SAFE one is the default:

| Lane | Who uses it | markdown-it |
|---|---|---|
| **Untrusted** (default) | AI-authored campaign/newsletter bodies, user-submitted fields, anything arriving over a route or the MCP `send_email`/`create_campaign` tools | `html: false` — smuggled `<script>`/`<img onerror>` renders as inert text |
| **Trusted** (`trustedContent: true` on the send settings) | First-party callers that hand-build markup: the dispute alert (`events/firestore/payments-disputes/on-write.js`) and the newsletter report email (`generators/newsletter.js`) | `html: true` |

Rules for the trusted lane:

- A caller may set `trustedContent: true` ONLY for markup it authored itself — and only an INTERNAL caller may set it at all, see [Internal-only send fields](#internal-only-send-fields).
- Every third-party or AI-authored value interpolated into that markup must go through `escapeHtml()` (`constants.js`) first — otherwise the trusted lane becomes an injection lane. Both current trusted callers do this for their webhook/AI values.
- Every URL interpolated into an `href` must go through `safeUrl()` (`constants.js`), not `escapeHtml()` — see [Link schemes](#link-schemes).
- `data.content.html` is a raw-HTML passthrough by declaration — INTERNAL callers only, see [Internal-only send fields](#internal-only-send-fields).

Newsletter template rendering (`generators/lib/templates/newsletter-shared.js`) is independently `html: false` — those bodies are always AI-authored — and escapes every AI field it interpolates via the shared `escapeHtml()`.

### Internal-only send fields

Four send/campaign fields hand the renderer raw HTML, or the trust to render it. Each is a real first-party lane AND a complete bypass of the escaped one, so first-party callers keep all four and **no caller arriving over the API may set any of them**. Ian's call on [#90](https://github.com/Omega-JS-Stack/omega/issues/90), extended to `html` on [#125](https://github.com/Omega-JS-Stack/omega/issues/125).

| Field | What it does | Its internal user |
|---|---|---|
| `data.content.html` | Skips markdown — the body lands in the inbox as live markup | Pre-rendered first-party bodies |
| `html` (top level) | Replaces the rendered MJML document outright (`transactional/index.js` build) | Callers that hand over a complete document |
| `contentHtml` (top level) | Same, on the campaign lane — read AHEAD of the escaped renderer (`marketing/index.js`), and it persists into the stored campaign doc that cron sends later | `generators/newsletter.js` |
| `trustedContent` | Flips the body renderer to `html: true` (raw HTML *and* `javascript:` hrefs survive) | The dispute alert + the newsletter report email |

| Lane | All four fields |
|---|---|
| Internal callers (generators, transition handlers, cron, auth hooks) | Accepted — unchanged |
| `POST /admin/email` (the surface behind the MCP `send_email` tool) | **Blocked** — the route schema strips them (belt); the guard 400s any that slip past (braces) |
| `POST` / `PUT /marketing/campaign` (the MCP `create_campaign` / `update_campaign` tools) | **Blocked** — same belt-and-braces pair |

The check is one shared helper over one field table: `prepare.internalOnlyFieldFault(settings)` returns a coded-400 permanent fault (naming the offending field and the rule) when the caller's settings carry any of them, else null. In practice the route schemas strip these keys first, so over HTTP the guard is the braces behind that belt — it fires only for a lane whose schema misses a field. Every caller-facing email lane runs its resolved settings through it BEFORE handing them to the library — and, on the campaign routes, before `buildCampaignDoc()`, which blacklists doc-level fields rather than allowlisting and would otherwise persist whatever the caller sent. An external lane added later must do the same. Rejection is on the FIELD's presence, not its contents: an external caller has no legitimate reason to send any of these keys at all, and the rejection is logged by field name (never the payload).

Three of the four (`html`, `contentHtml`, `trustedContent`) are also undeclared on the route schemas, and a zod object strips unknown keys — that strip is the belt, this guard the braces, and it is the guard that holds the moment a schema gains the field or a consumer route forwards raw settings. `data.content.html` has no belt: `data` is a schema passthrough, so the guard is its only stop.

`html` was a declared field on the `POST /admin/email` schema and a documented MCP `send_email` parameter until [#125](https://github.com/Omega-JS-Stack/omega/issues/125); Ian ruled the admin/MCP lane matches the API lane exactly, so both the schema field and the tool parameter are gone and the guard covers it like the rest.

Markdown in `data.content.message` is the external caller's lane, and it renders through the untrusted (escaped) renderer.

### Link schemes

An `href` is not made safe by `escapeHtml()` — `javascript:alert(1)` survives escaping intact, and third-party or AI-authored URLs (a dispute alert's `stripeUrl`, a newsletter source's `url`, an AI-written CTA) land in exactly that position. Every URL interpolated into an href goes through `safeUrl()` (`constants.js`) instead:

- **Allowed**: `http:`, `https:`, `mailto:`, and relative/anchor values (no scheme — they cannot carry script). The kept value is still `escapeHtml()`d, which also closes attribute-breakout via a quote in the URL.
- **Dropped**: everything else (`javascript:`, `data:`, `vbscript:`, `file:`), including the obfuscated forms clients still execute — whitespace, control characters, and zero-width/format characters inside the scheme (`java<TAB>script:`, `java<ZWSP>script:`) are all stripped before the scheme is matched. The href comes back empty — the link goes dead — and the drop is logged. It does not throw: one bad URL inside a webhook or AI payload must not take down the whole alert email.

Markdown LINKS need no extra guard — markdown-it's own `validateLink` blocks these schemes in `[text](url)` syntax on both lanes. It is not a guard on the trusted lane's raw HTML: an `<a href="javascript:...">` written directly into a `trustedContent` body is markup, not markdown link syntax, so `validateLink` never sees it. That anchor is the caller's responsibility — hence the `safeUrl()` rule above, and hence `trustedContent` being internal-only.

### Transactional Pipeline (`transactional/index.js`)

Steps inside `build()`:

1. **Brand + sender** — `prepare.resolveBrand()` + `prepare.resolveSender()`
2. **Recipients** — normalize to `{ email, name }`, UID lookup from Firestore, dedup across to/cc/bcc
3. **Content** — `prepare.renderContent()` (markdown→HTML if needed)
4. **Template data** — `prepare.buildTemplateData()` merges brand/signoff/email/categories with caller data
5. **Render** — `prepare.render()` → MJML template → compiled HTML → UTM-tag all links
6. **Assemble** — SendGrid Mail Send object with `content: [{ type: 'text/html', value: html }]`

After `build()`, `send()` delivers via SendGrid, handles scheduled sends (>71h → queue), and persists an audit trail to `emails/{messageId}`.

### Marketing Pipeline (`marketing/index.js`)

`sendCampaign()` reads each role's two legs from one table (`ROLE_LEGS`): it builds every role's audience first (`campaignsAudience()`, `newsletterAudience()`), then dispatches each role's sender: `sendCampaignsEmail()` follows the same prepare → render → deliver pattern, and `sendNewsletterPost()` creates one post. Content comes from `data.content.message` (markdown), the same location as transactional callers. Key difference: audience targeting uses brand-scoped dynamic segments, and a segment key or an audience that resolves to nothing fails the campaign before anything is sent (see [marketing-campaigns.md](marketing-campaigns.md#segments-ssot)).

### Email Validation Pipeline (`validation.js`)

All marketing contact operations (`add`, `sync`) pass through `validate()` before reaching providers. Checks run in order; the first failure short-circuits. (The library consent gate runs even earlier — a user with `consent.marketing.status === 'revoked'` returns `{ blocked: 'consent', email }` before validation; see [consent.md](consent.md#email-library-consent-gate).)

| # | Check | What it catches | Cost | Default |
|---|---|---|---|---|
| 1 | `format` | Regex: must have `@`, domain, no spaces | Free | Yes |
| 2 | `disposable` | ~7k known disposable domains (vendor list + custom additions) | Free | Yes |
| 3 | `corporate` | Social/corporate domains (instagram.com, facebook.com, etc.) | Free | Yes |
| 4 | `localPart` | Junk local parts (test, noreply, all-numeric, `_test.*`) | Free | Yes |
| 5 | `typo` | Common domain misspellings via prefix match (`gamil.`, `gmai.`, `aol.con`, `gmail.cok`, etc.) | Free | Yes |
| 6 | `dns` | No MX record, null MX (RFC 7505), loopback MX, domain not found | Free | Opt-in |
| 7 | `mailbox` | SMTP mailbox verification via NeverBounce or ZeroBounce | Paid | Opt-in |

- **`DEFAULT_CHECKS`** = checks 1–5 (all free, run on every `mailer.add()`/`mailer.sync()` call)
- **`ALL_CHECKS`** = checks 1–7 (used at signup to include paid mailbox verification)
- The `dns` check is opt-in (not in DEFAULT_CHECKS) because it's async/slower — include it for bulk validation
- The `dns` check blocks only on an answer (`ENOTFOUND`, `ENODATA`, null or loopback MX): a DNS server failure (`ESERVFAIL`) or a network error skips it and never blocks
- The `typo` check uses prefix matching (`"gamil."` catches `gamil.com`, `gamil.con`, `gamil.co`) — see `data/typo-domains.js`
- Custom disposable domains go in `data/custom-disposable-domains.json` (not the vendor list)
- Run `npx omega test framework:email/validation-cases` to verify all checks against the address corpus

### The disposable-domain dataset: seed + refresh cache

The vendor list is a committed **seed** plus a gitignored **refresh cache**, owned by `libraries/email/disposable-domains.js`. A refresh can never dirty the git tree.

| | Path | Written by |
|---|---|---|
| Seed (committed) | `src/omega/libraries/email/data/disposable-domains.json` | `node scripts/promote-disposable-domains.js`, nothing else, ever |
| Cache (gitignored) | `.cache/email/disposable-domains.json` | `node scripts/update-disposable-domains.js` (also the `npm prepare` before-hook) |

`load()` reads the cache when it is present and parseable, else the seed — so an offline clone, a CI box with no network, and a deployed function (which ships the seed and no cache) all resolve the same committed baseline.

**To advance the committed baseline**: `node scripts/update-disposable-domains.js` to refresh the cache, then `node scripts/promote-disposable-domains.js` to copy it over the seed, then review and commit the diff.

## Data Contract

The template receives one `data` object with a clear separation of concerns:

- **`data.content`** — template-specific payload. **Callers provide this.** What goes inside depends on the template.
- **`data.signoff`** — shared across templates. **Callers provide this** (defaults to team if omitted).
- **`data.brand`** / **`data.email`** / **`data.personalization`** — **system-injected by `prepare.js`**. Callers never touch these.

`trustedContent: true` (a top-level send setting, not part of `data`) opts the body out of HTML escaping — first-party markup only, see [Content trust](#content-trust).

Every caller — transactional, marketing, transition handler — passes data the same way:

```js
await email.send({
  template: 'card',
  subject: 'Welcome!',
  to: 'user@example.com',
  sender: 'hello',
  categories: ['account/welcome'],
  data: {
    content: { title: 'Welcome!', message: '# Hello!\n\nMarkdown here.' },
  },
});
```

### Per-template `data.content` shapes

| Template | `data.content` fields |
|---|---|
| **card** | `{ title, message, button: { text, url } }` |
| **plain** | `{ greeting, message, link: { url, text }, signoff }` |
| **order** | `{ event, id, type, unified, _computed, provider }` |
| **feedback** | (none — self-contained) |

Marketing campaigns add `discountCode` to `data.content`:
```js
data: {
  content: {
    title: 'Summer Sale!',
    message: 'Markdown with **{discount.code}**...',
    button: { text: 'Upgrade Now →', url: '{brand.url}/pricing' },
    discountCode: 'SUMMER15',
  },
}
```

Template variables (`{brand.name}`, `{discount.code}`, `{holiday.name}`, etc.) are resolved across the entire settings object before rendering.

## Template System

### Template Registry (`templates/index.js`)

Two registries, two resolve functions:

```js
resolveEmailTemplate('card')         // → card | plain | order | feedback
resolveNewsletterTemplate('clean')   // → clean | editorial | field-report
```

No aliases. Callers use direct template names. Unknown email templates fall back to `card` with a console warning.

### Template Builder Signature

Every email template exports `{ build, meta }`:

```js
function build({ data, theme, templateName }) {
  return '<mjml>...</mjml>';
}
const meta = { name: 'card', description: '...' };
module.exports = { build, meta };
```

### Composable Base Blocks (`base.js`)

All templates compose from shared building blocks. `skeleton()` is required; everything else is opt-in.

| Block | Purpose | Used by |
|---|---|---|
| `skeleton(opts, content)` | Required wrapper. `<mjml>` + `<mj-head>` (title, preview, styles) + `<mj-body>` + hidden ASM tags + hidden category tags | All templates |
| `logo(brand, theme)` | Centered brandmark image (or fallback text) | card, order, feedback |
| `cardWrapper(content)` | White card with border + 16px rounded corners | card, order, feedback |
| `signoff(data, theme)` | Team ("The Brand Team") or personal (headshot + name + link) | card, order |
| `button(btn)` | Dark CTA button | card, order |
| `footer(brand, email)` | ITW wordmark, footer text, links (account/terms/privacy/unsub), copyright, address | card, order, feedback |

### Hidden Tags (inside `skeleton()`)

Every email includes hidden elements that SendGrid and email clients process but users don't see:

- **ASM tags**: `<%asm_group_unsubscribe_raw_url%>` + `<%asm_preferences_raw_url%>` — suppress SendGrid's auto-inserted unsubscribe text
- **Category tags**: `category=transactional`, `category=order/confirmation`, etc. — used for email sorting/filtering

### Email Templates

#### `card` (default)

The workhorse. White card on gray background with logo, title, markdown body, optional CTA button, signoff, and full footer. Used for: welcome emails, account notifications, data requests, general transactional, marketing campaigns.

#### `plain`

Looks like a regular email from a person. No logo, no card, no branding. Full-width (`<mj-body width="100%">`). Just message + signoff + minimal gray footer with unsubscribe link. Used for: personal outreach, plain notifications.

#### `order`

Handles ALL 9 order event types in one template. Event from `data.content.event`. Componentized into sections:

| Section | Purpose |
|---|---|
| `_header()` | Emoji + title + subtitle per event type |
| `_summary()` | Product/price/discount/total table (only for `SUMMARY_EVENTS`) |
| `_details()` | Date, provider, frequency, account email |
| `_explanation()` | Conditional paragraphs: trial notice, promo code, cancellation reason, etc. |
| `_ctaButton()` | CTA pointing to dashboard/billing/pricing depending on event |
| `_helpText()` | "Questions? Contact support" |

**Event types:**

| Event | Fired by | Emoji |
|---|---|---|
| `confirmation` | new-subscription, purchase-completed | :tada: |
| `payment-failed` | payment-failed transition | :warning: |
| `payment-recovered` | payment-recovered transition | :white_check_mark: |
| `cancellation-requested` | cancellation-requested transition | :wave: |
| `cancelled` | subscription-cancelled transition | :x: |
| `plan-changed` | plan-changed transition | :arrows_counterclockwise: |
| `refunded` | payment-refunded transition | :moneybag: |
| `trial-ending` | (future) trial-ending cron | :hourglass: |
| `abandoned-cart` | abandoned-carts cron | :shopping_cart: |

#### `feedback`

Rating faces (dislike/neutral/like/love) with gift card incentive. Four clickable faces linking to a feedback URL with a `rating` query param — unicode glyphs, not hosted images, so the mail fetches nothing from a third-party CDN. Invisible placeholder labels on empty cells for vertical alignment. Used by the signup post-onboarding feedback email.

### Newsletter Templates

Newsletter templates are separate from email templates — different input shape, different registry. See [marketing-campaigns.md](marketing-campaigns.md) for the full newsletter system.

| Template | Style |
|---|---|
| `clean` | Simple, minimal |
| `editorial` | Full-width hero sections, editorial tone |
| `field-report` | Structured dispatch format |

## UTM Auto-Tagging

`utm.js` → `tagLinks()` auto-tags **all HTTP/HTTPS links** in email HTML — not just brand-domain links. Applied at two levels:

1. **Content rendering** — `prepare.renderContent()` tags links in the markdown→HTML body
2. **MJML compilation** — `renderEmail()` tags links in the compiled template HTML (CTA buttons, footer links, signoff links, etc.)

Default UTM params (auto-derived, no manual setup needed):

| Param | Source | Example |
|---|---|---|
| `utm_source` | Brand ID | `somiibo` |
| `utm_medium` | Always `email` | `email` |
| `utm_campaign` | First caller category (transactional) or campaign name (marketing) | `account_welcome`, `summer_sale_free_users` |
| `utm_content` | `transactional` or `marketing` | `transactional` |

Existing UTM params on a URL are never overwritten. Callers can pass `utm: { utm_term: '...' }` for additional params. Values are sanitized to lowercase alphanumeric + underscores.

## Transition Handler Email Convention

All payment transition handlers pass `template: 'order'` + `data.content` to the `send-email` utility:

```js
// In transitions/subscription/new-subscription.js:
sendOrderEmail({
  template: 'order',
  subject: 'Your order #...',
  categories: ['order/confirmation'],
  data: {
    content: { event: 'confirmation', ...order, _computed: { ... } },
  },
});
```

The order template reads `data.content` for all rendering decisions. No per-event template files — the single `order.js` handles everything.

### Personalization

Recipient display name in Gmail comes from the `to` field: `{ email: 'user@example.com', name: 'Taylor Trial' }`. In the email body, templates use `data.personalization.name` for greetings like "Hey Taylor".

Names are resolved during recipient normalization in the transactional pipeline — the user's `personal.name.first` from their Firestore doc is used when available.

## Sender Categories

Defined in `constants.js` → `SENDERS`. Each category auto-resolves a from address, display name, and unsubscribe-group KEY:

| Category | From | Display Name | Group key |
|---|---|---|---|
| `orders` | `orders@{domain}` | Orders at {Brand} | `orders` |
| `hello` | `hello@{domain}` | {Brand} | `hello` |
| `account` | `account@{domain}` | {Brand} Account | `account` |
| `marketing` | `marketing@{domain}` | {Brand} | `marketing` |
| `security` | `security@{domain}` | {Brand} Security | `security` |
| `newsletter` | `newsletter@{domain}` | {Brand} Newsletter | `newsletter` |
| `internal` | `alerts@{domain}` | {Brand} Alerts | `internal` |

## Unsubscribe groups

A SendGrid unsubscribe (ASM) group id belongs to the SendGrid ACCOUNT that created
it, so ids are never code. `constants.js` carries `GROUP_KEYS` — the seven keys
above — and nothing else; the id of each lives in the brand's own config at
`marketing.campaigns.providers.sendgrid.groups.<key>`
([#649](https://github.com/Omega-JS-Stack/omega/issues/649)).

- The manager's campaigns service provisions the groups (matched by NAME, so
  sibling brands on one account converge on the same ids) and writes each id back
  into `config/omega.json5`. Nothing here creates them.
- `prepare.resolveSender()` reads the id at build time. A missing one throws a
  coded-400 naming the config path: it means the manage walk never ran, and
  sending anyway would attach a group from somebody else's account.
- A caller may pass `group:` explicitly — a KEY resolves through config, a raw
  numeric id is used as-is.

## Testing

### The testing-mode capture (the SendGrid stand-in)

Outside extended mode, `Transactional.send()` **records** the email instead of delivering it and returns `{ status: 'captured' }` ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)). The seam sits past `build()` (after the brand, the recipients, the template data and the MJML render, before SendGrid is even required), so a broken template or a config hole fails a test rather than reaching production, and the audit trail and the `admin/email` analytics event (both facts about a DELIVERY) are not written.

**The gate is the mailer's, not the caller's.** `ctx.isTesting() && !TEST_EXTENDED_MODE` is asked in exactly one place (`isCapturing()`), the way the marketing library gates `add`/`sync`/`remove` at the SSOT level. Do not add an `isTesting()` check around a new `send()` call — the seam already covers it. What the seam does NOT cover: a send scheduled past `SEND_AT_LIMIT` is queued to `emails-queue` before the seam is reached (assert it there), and extended mode still sends real mail.

**The store is a file:** `<projectDir>/.temp/test-emails.jsonl`, one JSON record per line, beside `test-mode.json` and resolved the same way (the parent of `omega.cwd`). A file rather than a `_test/emails` Firestore collection because a test drives the mailer from three places and only a file serves all three: the emulator's function worker (another process from the test runner, so an in-memory array is impossible), the test-runner process itself, and a plain-node case with no emulator and therefore no Firestore to read. It also needs no rules, no index and no cleanup lane, and `.temp/` is already gitignored. Cross-process appends stay atomic by keeping every record under `PIPE_BUF` (the summary absorbs the trim).

**The helpers are test-only** (`src/test/utils/email-capture.js`, never a framework export, exactly like `test-mode-file.js`):

```javascript
const capture = require('../../dist/test/utils/email-capture.js');

capture.clearCaptured(omega);                // before the act
await http.as('signup-emails').post('omega/user/signup', {});
capture.readCaptured(omega);                 // [{ to, template, subject, summary, sendAt }]
```

The record's `summary` is the rendered body reduced to visible text — where a test finds the product name a receipt exists to state. Field table and the fire-and-forget caveat: [test-framework.md](test-framework.md#testing-mode-email-capture--how-a-test-reads-what-was-sent).

All email tests live under `test/email/`, mirroring the source at `src/omega/libraries/email/`:

| Test file | What it tests | Extended? |
|---|---|---|
| `templates.js` | MJML rendering for all 4 email templates (11 tests) | No |
| `testing-capture.js` | The [testing-mode capture](#the-testing-mode-capture-the-sendgrid-stand-in): the gate, the store, the summary, the mailer's seam (6 tests) | No |
| `transactional.js` | Transactional email building (assertions on output shape) | No |
| `validation.js` | Email format/disposable/corporate/local-part/typo/dns checks (55 tests) | No |
| `transactional-send.js` | Single transactional email send via SendGrid | Yes |
| `campaign-send.js` | Marketing campaign send with title + CTA + discount code | Yes |
| `feedback-and-plain-send.js` | Feedback + plain template visual test sends | Yes |
| `newsletter-templates.js` | Newsletter MJML rendering (16 tests) | No |
| `newsletter-generate.js` | Full AI newsletter generation pipeline (5min timeout) | Yes |
| `marketing-lifecycle.js` | Contact lifecycle (add/sync/remove) | Yes |
| `consent-lifecycle.js` | Consent webhook round-trip | Yes |
| `render-content.js` | The [content-trust](#content-trust) render lanes (15 tests) | No |
| `identity.js` | Config-driven identity + the loud failures (16 tests) | No |
| `validation-cases.js` | Address corpus for the free checks + NeverBounce parsing (69 tests) | No |
| `sanitize-images.js` | Brand-image absolutization (5 tests) | No |
| `marketing/consent-gate.js` | The marketing consent gate (21 tests) | No |
| `unsubscribe-groups.js` | [Unsubscribe groups](#unsubscribe-groups) resolve from config, and a missing id fails loudly (7 tests) | No |

Extended tests (`TEST_EXTENDED_MODE`) send real emails to `_test-*@{domain}` addresses. See [test-framework.md](test-framework.md) for the full test framework reference.

The last six are pure plain-node units — no emulator, no providers, no network — but they run in the discovered suite like everything else (`npx omega test framework:email`).

### Test recipient convention

All extended email tests send to `_test-<purpose>@{domain}` addresses (e.g. `_test-email-send@somiibo.com`). This keeps test emails separate from real user traffic and makes filtering easy.

## Key Files

| Purpose | File |
|---|---|
| Shared preparation | `src/omega/libraries/email/prepare.js` |
| Transactional pipeline | `src/omega/libraries/email/transactional/index.js` |
| Marketing pipeline | `src/omega/libraries/email/marketing/index.js` |
| MJML compiler (both email + newsletter) | `src/omega/libraries/email/generators/lib/mjml-template.js` |
| Template registry | `src/omega/libraries/email/generators/lib/templates/index.js` |
| Base blocks | `src/omega/libraries/email/generators/lib/templates/base.js` |
| Card template | `src/omega/libraries/email/generators/lib/templates/card.js` |
| Plain template | `src/omega/libraries/email/generators/lib/templates/plain.js` |
| Order template (9 events) | `src/omega/libraries/email/generators/lib/templates/order.js` |
| Feedback template | `src/omega/libraries/email/generators/lib/templates/feedback.js` |
| UTM link tagging | `src/omega/libraries/email/utm.js` |
| Constants (senders, groups, fields, segments) | `src/omega/libraries/email/constants.js` |
| Provider rows (role, env key, native fields, operations) | `@omega.js/config` `src/email-providers.js` |
| Provider row ↔ file test | `test/email/provider-registry.test.js` |
| Email validation | `src/omega/libraries/email/validation.js` |
| Typo domain prefixes | `src/omega/libraries/email/data/typo-domains.js` |
| Custom disposable domains | `src/omega/libraries/email/data/custom-disposable-domains.json` |
| Disposable-domain seed/cache contract | `src/omega/libraries/email/disposable-domains.js` |
| NeverBounce provider | `src/omega/libraries/email/validation-provider-neverbounce.js` |
| Testing-mode capture (the SendGrid stand-in) | `src/test/utils/email-capture.js` |
| ZeroBounce provider | `src/omega/libraries/email/validation-provider-zerobounce.js` |
| Validation tests | `test/email/validation.test.js`, `test/email/validation-cases.test.js` |
| Content-trust test (render lanes + escaping) | `test/email/render-content.test.js` |
| Identity test (config-driven + loud failures) | `test/email/identity.test.js` |
| Seed campaigns | `src/cli/commands/setup-tests/helpers/seed-campaigns.js` |
| Transition email dispatcher | `src/omega/events/firestore/payments-webhooks/transitions/send-email.js` |
