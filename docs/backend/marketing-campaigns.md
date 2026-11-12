# Marketing Campaign System

## Campaign CRUD Routes (admin-only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/marketing/campaign` | Create campaign (immediate or scheduled) |
| GET | `/marketing/campaign` | List/filter campaigns by date range, status, type |
| PUT | `/marketing/campaign` | Update pending campaigns (reschedule, edit) |
| DELETE | `/marketing/campaign` | Delete pending campaigns |

## Firestore Collection: `marketing-campaigns/{id}`

```javascript
{
  settings: { name, subject, preheader, content, template, sender, segments, excludeSegments, ... },
  sendAt: 1743465600,        // Unix timestamp (any format accepted, normalized on create)
  status: 'pending',         // pending | processing | sent | failed
  type: 'email',             // email | push
  recurrence: { pattern, day, hour, minute?, nth? },  // Optional — makes it recurring
  generator: 'newsletter',   // Optional — runs content generator before sending
  recurringId: '_recurring-sale',      // Present on history docs (links to parent template)
  generatedFrom: '_recurring-newsletter', // Present on generated docs
  results: { campaigns: {...}, newsletter: {...} },
  processingStartedAt: 1743465610,  // Set while claimed by a cron run (lease)
  generatorAttempts: 2,      // Consecutive empty generator runs (retry-cap bookkeeping)
  error: 'Unknown generator "..."',  // Set when marked failed without sending
  metadata: { created: {...}, updated: {...} },
}
```

## Campaign Types

- **Email**: dispatches through each role via `mailer.sendCampaign()`: the `campaigns` role's provider (SendGrid, a Single Send) and the `newsletter` role's (Beehiiv, a post). `settings.providers` names the roles to send through (`['campaigns']`, `['newsletter']`, as the admin calendar's checkboxes send them); omitted, every role that is on sends. The provider behind each role is its row in `@omega.js/config`'s `EMAIL_PROVIDERS` ([email-system.md](email-system.md#email-providers-and-roles)). A word in `settings.providers` that is no role fails the campaign with a coded 400 naming the word (keyed by that word in the results), and nothing is sent on any role
- **One publish point**: `sendCampaign()` is the one place a campaign is published, generator campaigns included (the newsletter generator builds the content and creates no post). Its newsletter leg makes one post whose title is the campaign's `subject` (else its `name`), whose tags are the settings' `contentTags`, and which is a draft whenever the run is a testing one (`ctx.isTesting()`), whatever `sendAt` says
- **Push**: dispatches to FCM via `notification.send()` (shared library). The icon falls back to `brand.images.brandmark` and is omitted when unset; the click target falls back to `brand.url` and throws when unset — a push never wears a framework identity.
- Content is **markdown** — converted to HTML at send time. Template variables resolved before conversion.

## Claim/Lease Lifecycle

Every due campaign is **claimed** before any work happens: the cron transactionally flips `status: 'pending'` → `'processing'` (stamping `processingStartedAt`). A campaign another (overlapping) run already claimed is skipped — double-sends are impossible by construction.

- Every terminal path writes a final status: `sent`/`failed` for one-offs, back to `pending` (with an advanced `sendAt`) for recurring
- If a run dies mid-flight (crash, function timeout), the doc stays `processing` until the **stale-lease reclaim** flips it back to `pending` after `PROCESSING_LEASE_SECONDS` (30 min) — a natural retry backoff
- Unknown campaign `type`s and unknown `generator`s are marked `failed` with an `error` field (a config typo must not retry every 10 minutes forever)
- A **coded 400** — the framework's permanent-fault convention (`errorWithCode(..., 400)` in the email library, the missing-`brand.url` throw in `notification.js`, the AI library's invalid-request rejects) — is finalized as `failed` with the message in `error`, in ONE pass. Such a fault never heals, so the lease reclaim would retry it forever; recurring campaigns fail outright too, since the next occurrence meets the same hole. It is caught in all three places it can arrive: thrown by the send, thrown by a generator's `generate()` (which the empty-generation attempts ladder never counts), and **carried** in a provider result — `sendCampaign()` converts each provider's throw to `{ success: false, error, code }`, so the email path's config-hole 400s reach the cron as data, not as throws
- Every other failure keeps its existing path: a code-less throw stays `processing` for the reclaim, a code-less provider failure rides the `success: false` bookkeeping
- `PUT /marketing/campaign` only edits `pending` campaigns, so a mid-flight campaign can't be edited out from under the cron

## Recurring Campaigns

Campaigns with a `recurrence` field repeat automatically:
- Cron fires → creates a **history doc** (same collection, `recurringId` set) → advances `sendAt` to next occurrence
- Status returns to `pending` on the recurring template after each run, history docs are `sent`/`failed`
- `_` prefix on IDs groups them at top of Firestore console

Recurrence patterns: `daily`, `weekly`, `monthly`, `monthly-weekday`, `quarterly`, `yearly`

The `monthly-weekday` pattern targets the Nth weekday of each month (e.g., 2nd Wednesday). Requires `nth` (1-4) and `day` (0=Sun–6=Sat) in the recurrence object. All other patterns use simple interval addition from the current `sendAt`.

All scheduling helpers live in `constants.js` (SSOT): `nextWeekday()`, `nextNthWeekday()`, `nextMonthDay()`, `getNextOccurrence()`, `getNextFutureOccurrence()`. The cron job imports from there — no duplicated logic.

**Catch-up safety:** the cron advances recurring campaigns with `getNextFutureOccurrence()`, which skips ALL missed occurrences and always lands in the future. A weekly campaign stalled for 3 weeks (cron outage, dried-up sources) sends ONE issue and resumes its schedule — never a catch-up burst of back-to-back sends.

## Generator Campaigns

Campaigns with a `generator` field (e.g. `generator: 'newsletter'`) are handled by the frequent cron inline — generate content and send in one shot when `sendAt` is due:
1. Frequent cron claims the generator campaign past its `sendAt`
2. Runs the generator module (e.g., `generators/newsletter.js`)
3. Sends the generated content immediately
4. Stores a history record with generated content + send results (bulky byproducts — `article`, `structure`, `mjml`, image buffers — are stripped from the stored settings)
5. Recurring: advances the template's `sendAt` to the next FUTURE occurrence and returns it to `pending`. One-off: finalized to `sent`/`failed` so it is never picked up again

**Empty-run retry cap:** when the generator yields nothing (no sources, filter dropped everything), the campaign returns to `pending` with `generatorAttempts` incremented and retries next run. After `GENERATOR_MAX_ATTEMPTS` (36 ≈ 6h at the 10-minute cadence) a recurring campaign skips to its next occurrence (counter reset); a one-off is marked `failed`.

**Test gating:** `generate()` short-circuits to `null` under `ctx.isTesting()` without `TEST_EXTENDED_MODE` — same convention as the marketing providers and the blog cron. A normal consumer test run never spends AI tokens or touches GitHub/Beehiiv; extended runs are production-equivalent.

The generator creates no post: the send in step 3 publishes it, through `sendCampaign()`'s newsletter leg (see [Campaign Types](#campaign-types)), published in production and a draft on a testing run. The generator returns the post's tags as `contentTags` and the report email's facts as `report`; once the send has answered, the cron mails the report (`generators/newsletter.js` `sendReport()`) to `alerts@{brandDomain}` with all asset links, its subject adapting to whether the post was published.

## Email Rendering

All campaign emails are rendered server-side via the unified MJML template system — no SendGrid dynamic templates (`d-xxx` IDs). The marketing pipeline calls `prepare.render()` to compile campaign content through the same MJML pipeline used by transactional emails.

Campaign content is **markdown** — converted to HTML via `renderContent()`, then passed to the resolved email template (default: `card`). The rendered HTML goes into SendGrid's `html_content` field on the Single Send.

See [docs/backend/email-system.md](email-system.md) for the full template system reference (composable base blocks, template registry, all 4 email templates).

## Template Variables

Resolved at send time via `powertools.template()`. Single braces `{var}` for campaign-level.

| Variable | Example Output |
|----------|---------------|
| `{brand.name}` | Somiibo |
| `{brand.id}` | somiibo |
| `{brand.url}` | https://somiibo.com |
| `{season.name}` | Winter, Spring, Summer, Fall |
| `{holiday.name}` | Black Friday, Christmas, Valentine's Day, etc. |
| `{date.month}` | November |
| `{date.year}` | 2026 |
| `{date.full}` | March 17, 2026 |

## UTM Auto-Tagging

`libraries/email/utm.js` scans HTML for `<a href>` matching the brand's domain and appends UTM params. Applied to both marketing campaigns and transactional emails.

Defaults: `utm_source=brand.id`, `utm_medium=email`, `utm_campaign=name`, `utm_content=type`. Override via `settings.utm` object.

## Segments SSOT

`SEGMENTS` dictionary in `constants.js` — 22 segment definitions. OMEGA creates them in SendGrid, @omega.js/backend resolves keys to provider IDs at runtime via `resolveSegmentIds()` (cached).

| Category | Segments |
|----------|----------|
| Subscription (9) | `subscription_free`, `subscription_paid`, `subscription_trialing`, `subscription_cancelling`, `subscription_suspended`, `subscription_cancelled`, `subscription_churned`, `subscription_ever_paid`, `subscription_never_paid` |
| Lifecycle (5) | `lifecycle_7d`, `lifecycle_30d`, `lifecycle_90d`, `lifecycle_6m`, `lifecycle_1y` |
| Engagement (5) | `engagement_active_30d`, `engagement_active_90d`, `engagement_inactive_90d`, `engagement_inactive_5m`, `engagement_inactive_6m` |

Campaigns reference segments by SSOT key: `segments: ['subscription_free']`. Auto-translated to each role's provider IDs.

**A campaign whose audience resolves to nothing fails before anything is sent**, with a coded 400 (`{ success: false, error, code: 400 }` on the role's result) that names the key, so the cron finalizes it as `failed` instead of retrying:

- a segment key (include or exclude) the role's provider does not know;
- a requested segment whose query has no `WHERE` condition (it would drop out of the AND and widen the audience to the whole brand);
- a `campaigns` send with no segments, no lists and no brand list.

Any one of these on any role sends nothing on every role: each role's audience is resolved before the first send. A campaign that names no segment keys never lists a provider's segments. A provider that cannot be reached while resolving segment ids is a code-less failure instead (`{ success: false, error }`, no `code`) that fails its own role only: the other roles still send. It is not finalized as a config fault: it rides the `success: false` bookkeeping, which marks a one-off `failed` when no role succeeded and moves a recurring campaign on to its next occurrence. It is not retried.

## Brand-Scoped Dynamic Segments (SendGrid)

### The problem

All brands share one SendGrid account. SendGrid segments are account-wide — `subscription_cancelled` contains cancelled users from ALL brands. `send_to.segment_ids` is a UNION (OR), so you can't intersect a segment with a brand's list. Custom fields like `brand_id` are global per contact (last brand to sync wins), so multi-brand contacts have unreliable `brand_id` values.

### The workaround (current)

At **send time**, the marketing pipeline creates a temporary SendGrid segment that ANDs the original segment's query with `"brand_id" = '<brand>'`. This scopes the audience to the current brand.

**Flow:**
1. Resolve segment names → SendGrid IDs (cached `resolveSegmentIds()`)
2. Fetch each segment's `query_dsl` via `GET /marketing/segments/2.0/{id}`
3. Extract WHERE clauses (a query may span lines), combine with `AND "brand_id" = '<brand>'`; a segment with no WHERE clause makes the whole temp segment resolve to nothing
4. `POST /marketing/segments/2.0` → creates temp segment (~3s)
5. Use temp segment ID in `send_to.segment_ids`
6. Schedule the Single Send — SendGrid evaluates the query at dispatch time
7. Delete the temp segment after scheduling (query already captured)

Same strategy for exclude segments — a separate temp segment is created and passed in `send_to.exclude_segment_ids`.

**Test mode** skips the brand filter entirely. `test: true` overrides targeting to just `test_admin` with no brand_id condition, no lists, no excludes — so the admin email receives tests regardless of which brand last synced their `brand_id`.

### Timing

- Temp segment creation: ~3s (API call)
- Segment materialization: ~10-15s (contacts_count populates)
- SendGrid evaluates the query at send dispatch, NOT at segment creation — so materialization delay doesn't matter
- Total overhead per campaign send: ~3-7s (create + cleanup)

### Known limitation: `brand_id` is last-write-wins

`brand_id` is a global custom field on the contact. When multiple brands sync the same email address, the last sync overwrites `brand_id`. For 99.9% of contacts (single-brand users), this is correct. Multi-brand contacts (e.g. admin emails) may have the wrong `brand_id`.

### Ideal solution: SendGrid subusers

Per-brand subusers provide full contact/segment/field isolation under one billing account. Requires SendGrid Pro plan ($90/month+). Each subuser gets its own API key, contacts, segments, and custom fields. OMEGA would create a subuser per brand during onboarding. This eliminates all the workarounds above.

### Key files

| Purpose | File |
|---------|------|
| Dynamic segment creation | `sendgrid.js` → `createBrandScopedSegment()` |
| Segment query fetch | `sendgrid.js` → `getSegmentQuery()` |
| Send pipeline integration | `marketing/index.js` → `campaignsAudience()`, `sendCampaignsEmail()` (the `campaigns` row of `ROLE_LEGS`) |
| Segment SSOT (conditions) | `constants.js` → `SEGMENTS` |
| OMEGA segment setup | `@omega.js/manager` `src/services/campaigns/ensure/segments.js` |

## Contact Pruning

**Pruning is ON by default** ([#478](https://github.com/Omega-JS-Stack/omega/issues/478), superseding #422's opt-in): the config schema's default supplies `marketing.prune.enabled: true` through the resolved chain, so a brand with no `marketing` block, no `prune` key, or `prune: {}` prunes. The ONLY shape that stops it is an explicit `enabled: false`, which logs the skip and deletes nothing. The per-provider safety floors below bound the blast radius of the on-default.

`cron/daily/marketing-prune.js` — runs 1st of each month. Pruning is strictly PER-PROVIDER: each provider's own engagement decides that provider's removals, so a reader who opens every newsletter but ignores offer mail is never deleted from the newsletter on a SendGrid-only signal ([#365](https://github.com/Omega-JS-Stack/omega/issues/365)). Three stages:
1. **Re-engagement**: send email to `engagement_inactive_5m` (excluding `engagement_inactive_6m`), its text in `data.content.message`, through the `campaigns` role alone (`providers: ['campaigns']`): that provider holds the engagement segments, which Beehiiv cannot create by API.
2. **Prune (SendGrid)**: export `engagement_inactive_6m` contacts, bulk delete from SendGrid only. Never prunes paying customers: the `subscription_paid` segment is excluded from the delete list, and when that exclusion cannot be built (the paid segment has no usable query, or its export fails) the stage logs one error line and deletes nothing that run. An export that comes back empty is no failure: nobody is paying, and the prune goes on.
3. **Prune (Beehiiv)**: list the publication's active subscriptions with Beehiiv's own per-subscriber stats (`expand[]=stats`) and delete the ones that have received at least `NEWSLETTER_RECEIVED_FLOOR` newsletters, joined more than `NEWSLETTER_MIN_AGE_DAYS` ago, and have never opened or clicked. A quiet channel keeps everyone under the floor and prunes nobody, which is the guard working. Never prunes paying customers either: Beehiiv cannot see app subscriptions, so each candidate's email is resolved to its user doc and skipped when its `User` reads `active` (an active paid plan), which is the same `subscription_paid` rule stage 2 uses. The skipped count rides the run log as `skippedPaid`, as it does for SendGrid.

Both lanes DELETE the contact/subscription and never unsubscribe it (an unsubscribe revokes marketing consent in Firestore permanently), and both log the deleted emails to `marketing-prune-logs/{brandId}/runs/{YYYY-MM}` (the Beehiiv lane under `{YYYY-MM}-newsletter`) for recoverability.

## Newsletter Generator

`generators/newsletter.js` orchestrates a multi-step pipeline that produces a fully rendered, email-safe newsletter. Output is HTML (not markdown) — the marketing library detects `settings.contentHtml` and uses it directly, skipping the markdown pipeline.

Pipeline:
1. Resolve sources: `resolveSources({ sources, count: sourceCount || 6, categories })` — the unified blog/newsletter resolver (source-resolver.js). Each pick is a RANDOM source from the entry's `sources` array; failures follow the type hierarchy ($feed → other feeds → $parent; $parent → other parent items; nothing falls to $brand). Firestore-checked so used items never repeat, session-checked so one issue never gets duplicates. See [docs/backend/ghostii.md](ghostii.md#source-picking--fallback-hierarchy) for the full hierarchy.
2. **structure.js** — Generic dispatcher. Resolves the active template, merges `BASE_SCHEMA` (universal fields: subject, preheader, signoff, citations) with the template's own `schema` fragment, calls the template's `buildPrompt({brand, newsletterConfig, sources})` to get the AI brief, runs the AI call, and normalizes the result via the template's optional `normalize()`. Default provider: `openai` (override per-run only via `NEWSLETTER_PROVIDER_STRUCTURE` env).
3. **image-illustrator.js** (default): one flat-vector PNG per section in parallel (`Promise.all`), generated directly via `ctx.ai.image()` → `gpt-image-2`. Iterates `structure.sections`; templates whose content shape isn't section-based (e.g. field-report uses `dispatches`) populate `sections` in their `normalize()` step so this loop keeps working unchanged. The prompt enforces a clean flat 2D vector style (Stripe / Linear / undraw.co aesthetic) built from the brand palette (`content.theme.{primary,secondary,accent}Color`), on a white background, no text. **Legacy method:** set `marketing.newsletter.content.method.image = 'svg'` to use the older `svg-illustrator.js` (AI authors an `<svg>`, rasterized via `@resvg/resvg-js`). Both methods return the same `{ png: Buffer, fallback, meta }` contract.
4. **mjml-template.js** — Resolves the template by name from `templates/index.js`, calls `template.build({structure, imagePaths, theme, ...})` for the MJML, compiles to email-safe HTML via the `mjml` package. Brand-domain links get UTM-tagged via the existing `tagLinks()` utility.
5. Mark used: `trackContentSource()` per source into the local `content-sources` collection — ONLY after generation succeeds. No PUT to the parent; the child tracks its own usage.

> **Step 3 runs concurrently with the linked-article build** (see below) when `article.enabled` is on — both are slow AI calls, so they share one `Promise.all`. The article URL is stamped onto the lead section before steps 4/5 render.

## Newsletter-driven blog article (`article.enabled`)

When `marketing.newsletter.content.article.enabled: true`, the newsletter generator expands its **lead section** (`structure.sections[0]`) into a full blog article and links to it from the newsletter.

Flow (runs in parallel with SVG generation, between structure and render):
1. `buildLinkedArticle()` builds a brief from the lead section's title + body, folded with the shared `tone` + `instructions`.
2. **Ghostii** (`libraries/content/ghostii.js` → `writeArticle()`) expands it into a full article + hero image.
3. `publishArticle()` POSTs to the `admin/post` route (commits markdown + images to the website repo). Public URL = `{brand.url}/blog/{slug}`.
4. The URL is injected as `structure.sections[0].cta = { label: 'Read the full article', url }`. The MJML `sectionCard` and the markdown renderer both render `section.cta` automatically.

**Failure is isolated** — if the article build throws, it resolves to `null`, no CTA is injected, and the newsletter ships normally. The newsletter never depends on the article succeeding.

The published URL is surfaced on the return as `assets.articleUrl` and `meta.article`. Config block: `marketing.newsletter.content.article = { enabled, author }` (`enabled` default `false`; `author` is the post author slug). Standalone article publishing (independent of the newsletter) lives in the daily `blog-auto-publisher.js` cron, which uses the same `libraries/content/ghostii.js` engine — see [docs/backend/admin-post-route.md](admin-post-route.md). Standalone blog publishing is **disabled by default** (`blog.enabled: false`).

## Template-owned schemas

Each template under `lib/templates/` owns its own content shape. Templates export:

```js
module.exports = {
  build({ structure, imagePaths, theme, brandName, brandUrl, brandAddress, sponsorships, now }),  // → MJML
  meta:     { name, description, requires, optional, supports },
  schema:   { required, properties },  // JSON schema FRAGMENT — merged into BASE_SCHEMA
  normalize(structure, { brand, newsletterConfig }),  // optional post-AI normalization
  buildPrompt({ brand, newsletterConfig, sources }),  // optional — defaults to classic prompt
};
```

`BASE_SCHEMA` (in `structure.js`) declares the universals every newsletter must have: `subject`, `preheader`, `signoff`, `citations`. Templates merge their own fields on top via `schema.properties` + `schema.required`.

**Adding a new template:**
1. Create `lib/templates/<name>.js` with `build`, `meta`, `schema`, and `normalize`. Add `buildPrompt` if the content shape requires a custom AI brief.
2. Register it in `lib/templates/index.js`.
3. **Add a matching fixture** at `test/email/fixtures/<name>.json` with the same content shape. This is REQUIRED — the iteration test loads it by default when the active brand's template is your new one. Without it, the default test run fails with "fixture not found".
4. Add the template name to the `TEMPLATES` array in `test/email/newsletter-templates.test.js` so the fixture suite renders it. Add per-template assertions if the new template renders unique identity markers (e.g. field-report's `LEAD DISPATCH` kicker).
5. Audit graceful omission — every template's `build()` must handle missing optional fields (return `''` for omitted blocks rather than throwing). Existing templates (clean, editorial, field-report) all do this.

Existing classic-shape templates (`clean`, `editorial`) share their schema via `lib/templates/classic-schema.js`. New templates with the same `{intro, sections: [{title, body, cta, image_prompt}]}` shape should reuse `CLASSIC_SCHEMA` + `normalizeClassic` rather than duplicating.

## Iteration test default behavior

`test/email/newsletter-generate.test.js` runs in **fixture mode by default** — it loads `test/email/fixtures/<active-template>.json` and renders straight through MJML. ~25-50ms, no AI, $0. This is what runs in CI and what you use for layout iteration.

Set `TEST_EXTENDED_MODE=1` to switch to the full AI pipeline against real sources from the parent server. That mode requires `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OMEGA_ADMIN_KEY`, and a parent URL.

Per-brand customization lives under `marketing.newsletter.content` — nested under `newsletter` because the newsletter role owns the content pipeline. The whole pipeline is gated by `marketing.newsletter.enabled`. Each role names its vendor as a KEY under `providers` ([#425](https://github.com/Omega-JS-Stack/omega/issues/425)); provider-hung facts (the publication id) live inside it, while `enabled` and `content` stay role-level — `content` is generator config, not Beehiiv config:

```js
marketing.newsletter = {
  enabled: true,
  providers: {
    beehiiv: {
      publicationId: 'pub_xxxxx',
    },
  },
  content: {
    categories: ['social-media', 'marketing'],
    instructions: '...',           // free-form text for the AI
    tone: 'professional',          // 'casual' | 'actionable' | 'witty' | etc.
    template: 'field-report',      // clean | editorial | field-report
    theme: { primaryColor, secondaryColor, accentColor, font },
    sponsorships: [ ... ],
  },
}
```

AI provider defaults live in code (openai for structure, anthropic for SVG — each chosen for what each model does best). Override per-run only via env: `NEWSLETTER_PROVIDER_STRUCTURE` / `NEWSLETTER_PROVIDER_SVG`. No per-brand override — every brand uses the same defaults.

## Asset hosting (production cron flow)

The frequent cron uploads per-section PNGs + the rendered `newsletter.html` + `newsletter.md` + `summary.md` to the public `itw-creative-works/newsletter-assets` repo. Each brand pushes to its own branch (branch name = brandId) — zero contention when multiple brands upload concurrently. New brand branches are created automatically as empty orphans on first upload. Folder layout:

```
Branch: {brandId}
  content/{campaignId}/
    section-N.png       — per-section illustration (embedded in HTML)
    newsletter.html     — final rendered email-safe HTML
    newsletter.md       — programmatic markdown view (per-section ## blocks, ready for Beehiiv paste)
    summary.md          — short editorial recap (2-3 sentences)
```

The `main` branch is a viewer hub (GitHub Pages) — no newsletter content.

`newsletter.md` is built programmatically from the same `structure` JSON the HTML is rendered from (no AI cost) by `lib/markdown-renderer.js`. Each section/dispatch becomes a standalone `## heading` block — drop it into the Beehiiv editor one block at a time and insert ad blocks between dispatches.

The `campaignId` is the same Firestore doc ID the cron uses for the generated `marketing-campaigns/{newId}` doc, reserved up front so the GitHub URLs and the Firestore doc always match.

Asset URLs are stamped onto the generated campaign doc:

```js
marketing-campaigns/{newId}: {
  settings:    { subject, preheader, contentHtml, ... },
  assets: {
    campaignId,           // same as the doc id
    folderUrl,            // https://github.com/itw-creative-works/newsletter-assets/tree/{brandId}/content/{campaignId}
    htmlUrl,              // https://raw.githubusercontent.com/.../newsletter.html  — paste this into Beehiiv as one block
    markdownUrl,          // https://raw.githubusercontent.com/.../newsletter.md    — per-section blocks (ads between)
    summaryUrl,           // https://raw.githubusercontent.com/.../summary.md       — share-snippet recap
    imageUrls: [...],     // raw.githubusercontent.com URLs already embedded in contentHtml
    tags: [...]           // AI-generated content tags (also the settings' `contentTags`, the post's tags)
  },
  meta:        { tokens, cost, durations, source scores },
  results:     { newsletter: { success, id } },   // the post sendCampaign() published
  ...
}
```

**`structure` schema (universals)** — every newsletter the generator produces satisfies this regardless of template:

| Field | Purpose |
|---|---|
| `subject` | Email subject (≤80 chars) |
| `preheader` | Inbox preview text (≤120 chars) |
| `summary` | 2-3 sentence editorial recap (≤600 chars) — written to `summary.md` and used as share snippet. Distinct from preheader (which is an inbox hook). |
| `tags` | 0-5 topical tags (lowercase kebab-case), returned as the settings' `contentTags`, which the newsletter post carries as Beehiiv `content_tags` |
| `signoff` | Two-line closing |
| `citations` | 0-10 `{note, source}` pairs rendered as footnotes |

Templates add their own fields on top (e.g. classic adds `intro` + `sections`; field-report adds `tldr` + `dateline` + `dispatches`).

**No AI-authored CTAs in generated content.** The schema intentionally does NOT include section-level CTAs / outbound links. The AI cannot author URLs reliably — it has no browse access to your site and no real source URLs to reference, so any URL it produces is invented. Newsletters are self-contained reads; outbound links come from sponsorship blocks rendered by the template shell (driven by `marketing.newsletter.content.sponsorships[]`), not from generated section bodies. The **one exception** is the linked-article CTA: when `article.enabled` is on, `section.cta = { label, url }` is injected onto the lead section by code *after* the article is published (a real, verified URL) — never authored by the AI. Both `sectionCard` (MJML) and the markdown renderer render `section.cta` when present.

**Newsletter report email: sent after every generated send.** Once `sendCampaign()` has answered, the cron calls the generator's `sendReport()` with the send's newsletter result, which mails an internal report via `sender: 'internal'` (resolves to `alerts@{brandDomain}`) with:
- The post's status (published with its id, or the failure reason; the subject line adapts)
- A prominent "Preview Newsletter" button (GitHub Pages viewer)
- Subject, preheader, tags
- Direct links to the rendered HTML, per-section markdown, and summary
- Linked articles (published ones only — unpublished articles are never referenced)
- All sources used (linked when they have real URLs, feed hostname in parentheses)
- The full GitHub folder

This means the newsletter is never "stuck" — even with Beehiiv disabled or failing, you get an actionable email pointing to ready-to-paste assets. The report is best-effort; failure to send is logged but does not block the Firestore campaign-doc write.

Requires `GH_TOKEN` env var (org-scoped, write access to `newsletter-assets`). Without it, the cron's HTML/image upload calls throw and the run aborts.

## Iteration test asset story

`NEWSLETTER_GITHUB_UPLOAD=1` in the iteration test enables the same upload flow against the same repo. Local-only by default for fast layout iteration (writes to `.temp/newsletter/run-<stamp>/newsletter.html`).

| Module | Purpose |
|---|---|
| `lib/structure.js` | Generic AI dispatcher — merges template schema with BASE_SCHEMA, calls template.buildPrompt, normalizes |
| `lib/svg-illustrator.js` | Per-section SVG → PNG (rasterized via `@resvg/resvg-js`) |
| `lib/mjml-template.js` | Template dispatcher → MJML → email-safe HTML, UTM-tagged |
| `lib/templates/index.js` | Template registry (`clean`, `editorial`, `field-report`) |
| `lib/templates/classic-schema.js` | Shared content schema for `clean` + `editorial` |
| `lib/templates/newsletter-shared.js` | Newsletter-specific `shell()` + primitives (sponsorship, citations, footer, address) |
| `lib/templates/shared-campaign.js` | Shared utilities for all templates (`escape()`, `resolveTheme()`, `formatAddress()`) |
| `lib/templates/editorial/helpers.js` | Editorial-only helpers (pullquote, issue number, eyebrow) |
| `lib/templates/field-report/helpers.js` | Field-report-only helpers (kicker, dispatch dateline, terminal block, terminator) |
| `newsletter.js` | Orchestrator — resolves sources via the unified source-resolver, calls lib modules, tracks usage locally |
| `test/email/fixtures/{name}.json` | Hand-crafted structure per template (loaded by iteration test in fixture mode) |

## Seed Campaigns

Checked by `npx omega test` every run (missing or drifted seeds are reported as a warning, never written). Creating them and enforcing their fields is opt-in: `npx omega test --seed-campaigns` (idempotent). Emulator runs seed on boot, so demo-* projects need neither.

| ID | Type | Description |
|----|------|-------------|
| `_recurring-sale-free` | email (campaigns) | Sale targeting free users — 2nd Wednesday of month, 10:30 AM PT (17:30 UTC) |
| `_recurring-sale-churned-trial` | email (campaigns) | Sale targeting churned trial users — 2nd Wednesday, 10:30 AM PT |
| `_recurring-sale-churned-paid` | email (campaigns) | Sale targeting churned paid users — 2nd Wednesday, 10:30 AM PT |
| `_recurring-sale-cancelled` | email (campaigns) | Sale targeting cancelled users — 2nd Wednesday, 10:30 AM PT |
| `_recurring-newsletter` | email (newsletter) | AI-generated newsletter — every Wednesday, 10:30 AM PT (17:30 UTC) |

## Marketing Config

```javascript
marketing: {
  campaigns: { enabled: true, providers: { sendgrid: { listId: '' } } },
  newsletter: {
    enabled: false,
    providers: { beehiiv: { publicationId: 'pub_xxxxx' } },
    content: {
      categories: ['social-media', 'marketing'],
      instructions: '',                     // free-form AI instructions
      tone: 'professional',
      template: 'clean',                    // clean | editorial | field-report
      article: {                            // expand the lead section into a linked blog post (Ghostii → admin/post)
        enabled: false,
        author: 'alex-raeburn',             // author slug for the linked article
      },
      theme: { primaryColor, secondaryColor, accentColor, font },
      sponsorships: [ ... ],
    },
  },
  prune: { enabled: false },              // ON by default (#478) — false is the ONLY shape that stops it (see Contact Pruning)
}
```

## Key Marketing Files

| Purpose | File |
|---------|------|
| Marketing library | `src/omega/libraries/email/marketing/index.js` |
| Shared preparation (brand, sender, render) | `src/omega/libraries/email/prepare.js` |
| Email template registry | `src/omega/libraries/email/generators/lib/templates/index.js` |
| Composable base blocks (skeleton, logo, card, etc.) | `src/omega/libraries/email/generators/lib/templates/base.js` |
| Field + segment SSOT | `src/omega/libraries/email/constants.js` |
| UTM tagging | `src/omega/libraries/email/utm.js` |
| Newsletter generator | `src/omega/libraries/email/generators/newsletter.js` |
| Newsletter copy (AI) | `src/omega/libraries/email/generators/lib/structure.js` |
| Newsletter SVG (AI) | `src/omega/libraries/email/generators/lib/svg-illustrator.js` |
| Newsletter MJML → HTML | `src/omega/libraries/email/generators/lib/mjml-template.js` |
| Newsletter asset host (GitHub upload: PNGs + newsletter.html + newsletter.md + summary.md) | `src/omega/libraries/email/generators/lib/image-host.js` |
| Newsletter markdown renderer (programmatic, no AI) | `src/omega/libraries/email/generators/lib/markdown-renderer.js` |
| Ghostii article engine (writeArticle + publishArticle) | `src/omega/libraries/content/ghostii.js` |
| Standalone blog article cron (off by default) | `src/omega/events/cron/daily/blog-auto-publisher.js` |
| Unified AI library | `src/omega/libraries/ai/index.js` (OpenAI + Anthropic via `ctx.ai.request({ provider, ... })`) |
| Notification library | `src/omega/libraries/notification.js` |
| SendGrid provider | `src/omega/libraries/email/providers/sendgrid.js` |
| Beehiiv provider | `src/omega/libraries/email/providers/beehiiv.js` |
| Campaign routes | `src/omega/routes/marketing/campaign/{get,post,put,delete}.js` |
| Campaign + newsletter cron | `src/omega/events/cron/frequent/marketing-campaigns.js` |
| Pruning cron | `src/omega/events/cron/daily/marketing-prune.js` |
| Seed campaigns | `src/cli/commands/setup-tests/helpers/seed-campaigns.js` |
