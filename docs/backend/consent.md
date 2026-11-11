# Marketing Consent System

Captures, stores, and synchronizes user consent for legal terms (ToS + Privacy) and marketing communications across SendGrid + Beehiiv. Designed for GDPR / CASL / CAN-SPAM compliance with full audit metadata.

This doc covers the **server-side** (@omega.js/backend) part of the system. The matching frontend pieces live in [ultimate-jekyll-manager](https://github.com/itw-creative-works/ultimate-jekyll-manager) and [@omega.js/client](../../packages/client/).

## Why this exists

1. **Capture explicit, affirmative consent** at signup with separate checkboxes for legal terms (required) and marketing communications (optional). Store the exact label text the user agreed to.
2. **Let users withdraw consent at any time** via the account-page toggle or the email-footer unsubscribe link.
3. **Stay in sync with provider-side actions** — when a user clicks unsubscribe in a SendGrid or Beehiiv email, the user doc updates AND the OTHER provider is also notified.
4. **Never re-add an unsubscribed user** — `email.add()` and `email.sync()` short-circuit in the library itself when `consent.marketing.status === 'revoked'`, so every call site (payment-event syncs, admin re-syncs, public newsletter form, legacy API commands) is covered. See "Email library consent gate" below.

## Canonical user-doc shape

Every user doc has a `consent` object with two sub-trees:

```js
consent: {
  legal: {
    status: 'granted' | 'revoked',
    grantedAt: { timestamp, timestampUNIX, source, ip, text },
  },
  marketing: {
    status: 'granted' | 'revoked',
    grantedAt: { timestamp, timestampUNIX, source, ip, text },
    revokedAt: { timestamp, timestampUNIX, source, ip, text },
  },
}
```

**Field semantics:**

- `status` — single-source-of-truth boolean state, expressed as a string enum so future states (`'pending'`, `'expired'`) don't break the schema.
- `grantedAt` / `revokedAt` — full audit metadata for the **most recent** transition of each kind. Both ALWAYS present on the doc; nulls live at the leaves (e.g. `grantedAt: { timestamp: null, ... }`), never at the object boundary. Matches @omega.js/backend's `subscription.expires` / `payment.startDate` conventions.
- `legal` only has `grantedAt` (no `revokedAt`) because revoking legal consent = deleting the account.
- `text` records the **exact wording** the user agreed to. Critical for audit defense if a marketing label is challenged later.

**Object always present, nulls at leaves.** No special-casing required when reading — `account.consent.marketing.grantedAt.timestamp` is either an ISO string or `null`, never `undefined`.

### Source enum

| Source | Where it fires | Side |
|---|---|---|
| `'signup'` | Signup form checkbox toggled at account creation | both |
| `'account'` | `/account` notifications page toggle | both |
| `'admin'` | Manual admin override | both |
| `'imported'` | Legacy user migration backfill | both |
| `'sendgrid'` | SendGrid webhook event (`group_unsubscribe`, etc.) | revoke only |
| `'beehiiv'` | Beehiiv webhook event (`subscription.unsubscribed`, etc.) | revoke only |

## Capture points

There are five places where consent gets recorded or updated. All five converge on the same canonical shape.

### 1. Signup form (Phase B)

[src/omega/routes/user/signup/post.js](../../packages/backend/src/omega/routes/user/signup/post.js): the existing `/user/signup` route now accepts a `consent` settings field:

```js
// Client sends (lightweight transit shape):
{
  consent: {
    legal: { granted: true, text: 'I agree to ...' },
    marketing: { granted: false, text: 'I agree to receive ...' },
  },
}
```

`buildConsentRecord(ctx, data.consent, creationTime, existingConsent)` translates this into the canonical user-doc shape:

- `legal.granted: true` → `legal.status = 'granted'`, `grantedAt` populated with `source: 'signup'` + **timestamp from Auth `creationTime`** + server-detected IP + exact label text.
- `marketing.granted: false` → `marketing.status = 'revoked'`, `grantedAt` all-null, `revokedAt` populated with `source: 'signup'`. (Records the explicit decline.)

**Timestamps come from Firebase Auth `creationTime`,** not request time, so `consent.grantedAt` matches `metadata.created` (the OMEGA user migration treats `metadata.created` as the SSOT and reconciles `grantedAt` against it — stamping from request time made every new signup drift by a few seconds and get re-fixed on the next migration run).

**Server-derived time is authoritative.** Client-supplied timestamps are ignored — defends against clock manipulation by malicious clients.

**Strict boolean check.** Only `granted === true` counts as granted. `'true'`, `1`, or other truthy values are rejected.

**Never downgrades an existing grant (data-loss guard).** A legacy account — one signed up before the `flags.signupProcessed` completion flow existed, so its flag was never set — re-fires `/user/signup` on every page load until the flag flips. Its consent was captured months ago and is long gone from `localStorage`, so the payload arrives empty. Without protection, `buildConsentRecord` would compute `'revoked'` and the `{ merge: true }` write would wipe the consent the user actually granted. The guard reads the existing doc's consent (`existingConsent`) and **preserves any already-`granted` status when the incoming payload does not explicitly re-grant it.** A genuine new grant still applies; an at-signup decline with no prior grant still records the decline. (The primary mitigation is OMEGA migration Fix 4f, which backfills `flags.signupProcessed: true` for established accounts so they never re-fire; this guard is the backstop for the deploy-before-migration gap.)

**Marketing sync gating.** After writing the user doc, the route checks `userRecord.consent.marketing.status === 'granted'` before calling `mailer.sync(uid)`. Declining the marketing checkbox means the user is created normally, gets transactional emails, but is NEVER added to SendGrid / Beehiiv marketing lists.

### 2. Account-page toggle (Phase D)

[src/omega/routes/marketing/email-preferences/post.js](../../packages/backend/src/omega/routes/marketing/email-preferences/post.js): authenticated mode.

```
POST /omega/marketing/email-preferences
Body: { action: 'subscribe' | 'unsubscribe' }
```

- Requires authentication (uses the calling user's auth UID and email).
- Rate-limited per-user via `ctx.usage.consume('email-preferences', 1, { limit: RATE_LIMIT })` (5 per counting period) — an anti-abuse gate with an explicit limit, not a plan feature ([usage-rate-limiting.md](usage-rate-limiting.md)).
- Writes `consent.marketing.{status, grantedAt|revokedAt}` to the user doc with `source: 'account'` + server time + server IP.
- Calls `mailer.sync(uid)` on subscribe, `mailer.remove(email)` on unsubscribe — hits both SendGrid + Beehiiv via the email library.

Note: `grantedAt.text` is `null` for account-page subscribes because the marketing label text is not currently passed from the frontend toggle (TODO if needed).

### 3. HMAC unsubscribe link (legacy, Phase D)

Same route, anonymous mode. The existing email-footer unsubscribe link flow:

```
POST /omega/marketing/email-preferences
Body: { email, asmId, sig, action: 'subscribe' | 'unsubscribe' }
```

- `sig = HMAC-SHA256(email, UNSUBSCRIBE_HMAC_KEY)` — proves we generated the link.
- IP-rate-limited (5/day per IP).
- **Also writes the user doc** if the email maps to a user — `consent.marketing.{status, revokedAt}` with `source: 'sendgrid'` (since HMAC links only appear in SendGrid email footers).
- **Unsubscribe is cross-provider** — besides the SendGrid ASM suppression, the route calls `mailer.remove(email)` (best-effort) so the contact is removed from Beehiiv too. ASM suppression alone only stops SendGrid sends.
- **Subscribe actually re-adds the contact** — the user-doc mirror writes `granted` BEFORE the provider calls, then the route calls `mailer.sync(uid)` when the email maps to a user (the fresh grant passes the library consent gate — no bypass flags) or `mailer.add({ email, source: 'resubscribe' })` when it doesn't. Best-effort, same testing guard as the ASM call.
- Backward-compatible — old in-flight email links continue to work.

### 4. Provider webhooks (Phase E)

[src/omega/routes/marketing/webhook/post.js](../../packages/backend/src/omega/routes/marketing/webhook/post.js): receives unsub / spam / bounce events from SendGrid and Beehiiv.

```
POST /omega/marketing/webhook?provider=sendgrid&key=<OMEGA_WEBHOOK_KEY>
POST /omega/marketing/webhook?provider=beehiiv&key=<OMEGA_WEBHOOK_KEY>
```

The dispatcher loads `providers/{provider}.js`, parses the event(s), and for each event:

1. Checks `isSupported(eventType)` — filters out non-revoke events like `delivered` / `open`.
2. Calls `handleEvent({ omega, ctx, parsed })` on the provider.

There is **no idempotency ledger**. Both handler side effects — writing `consent.marketing.status = 'revoked'` and calling `mailer.remove()` — are idempotent, so a provider retry (or a duplicate fan-out from the parent) re-runs to the same end state with no extra side effects. This is the key difference from `payments-webhooks`, where dedup is load-bearing because payment side effects are not idempotent.

Each provider's `handleEvent` does the same shape of work:

1. Look up the user by `auth.email` in THIS brand's Firestore. Silent skip if not found (the email may belong to a sibling brand — see "Parent forwarder" below).
2. Write `consent.marketing.status = 'revoked'` with the appropriate `source` ('sendgrid' or 'beehiiv'), preserving `grantedAt` as informational audit history.
3. Call `mailer.remove(email)` to sync the unsubscribe to the OTHER provider (best-effort, idempotent on 404).

**Supported event types:**

| Provider | Event types treated as revoke |
|---|---|
| SendGrid | `unsubscribe`, `group_unsubscribe`, `spamreport`, `bounce`\*, `dropped`\* |

\* `bounce` and `dropped` only revoke consent when `bounce_classification` is `'Invalid Address'` (hard bounce). Technical bounces (DMARC, TLS, DNS, reputation) are sender-side issues — the recipient's email is still valid, so consent is preserved.
| Beehiiv | `subscription.unsubscribed`, `subscription.deleted`, `subscription.paused` |

**Beehiiv publication filter.** Each Beehiiv event includes a `publication_id`. The provider compares this against `beehiivProvider.getPublicationId()`, which reads `omega.config.marketing.newsletter.providers.beehiiv.publicationId` (populated at brand-onboarding time by OMEGA's `newsletter/ensure/publication.js`). Mismatch → silent skip. This is how shared-publication events (e.g. devbeans shared by 6 brands) get routed correctly: each brand processes only events matching its own publication. Brands without `publicationId` in config silently skip all Beehiiv webhook events. The same convention applies to SendGrid: `marketing.campaigns.providers.sendgrid.listId` is populated by OMEGA's `campaigns/ensure/list.js`.

### 5. Admin contact removal

[src/omega/routes/marketing/contact/delete.js](../../packages/backend/src/omega/routes/marketing/contact/delete.js): admin-only endpoint.

```
DELETE /omega/marketing/contact
Body: { email }
```

After removing the contact from all providers, the route mirrors `consent.marketing.status = 'revoked'` to the user doc when the email maps to a user — `revokedAt` from server time with `source: 'admin'`, same write shape as the webhook providers (`grantedAt` preserved as audit history). Without this mirror, the next `sync()` (payment event, admin re-sync) would re-add the contact the admin just removed. Best-effort and silent when no user matches.

## Parent forwarder (Phase E)

[src/omega/routes/marketing/webhook/forward/post.js](../../packages/backend/src/omega/routes/marketing/webhook/forward/post.js)

SendGrid and Beehiiv only let you configure a small number of webhook URLs (often one per account). With many brands sharing the same SendGrid account, we can't point the webhook at every brand's @omega.js/backend directly. Instead:

```
SendGrid → POST https://api.itwcreativeworks.com/omega/marketing/webhook/forward?provider=sendgrid&key=X
Beehiiv  → POST https://api.itwcreativeworks.com/omega/marketing/webhook/forward?provider=beehiiv&key=X
```

The **parent @omega.js/backend** (the one whose `config/omega.json5` has `parent: 'self'` under `targets.backend`) exposes the forwarder route. Every other @omega.js/backend has the route but it returns 404 (gated on `omega.isParent()`).

The parent forwarder:

1. Validates `?provider=X&key=Y` (same `OMEGA_WEBHOOK_KEY` env var — shared across all brands).
2. Reads the `brands` collection from the parent's own Firestore.
3. For each brand: derives the child API URL as the `apiAddress` of the brand's URL (`https://somiibo.com` → `https://api.somiibo.com/omega/marketing/webhook?provider=X&key=Y`). A child on a default Pages host has no address there (a registry doc carries no project id), so it counts as a failed forward.
4. POSTs the raw provider body to every child in parallel via `Promise.allSettled`.
5. Returns 200 even if some children fail — idempotent child handlers make provider retries (and re-fans) safe.

### Why fan-out instead of central processing

Each brand has its own Firebase project, so its `users` collection is separate. The parent can't write to a child's Firestore. By having each child process the event against its own users, we get:

- **Correct per-brand updates** — only brands where the user actually has an account update their user docs.
- **Failure isolation** — one child being down doesn't block updates on the others.
- **Idempotent handlers** — re-processing the same event (provider retry or re-fan) produces the same end state, so no dedup ledger is needed.
- **No new schema** — no need for the parent to maintain a brand → publication map; each child filters on its own.

### Why self IS in the fan-out

The parent @omega.js/backend has its own brand (e.g. `itw-creative-works`) with its own users. By fanning out via HTTP to itself like any other child, the parent's brand processes its users the same way as siblings — no special-case inline path.

### Shared-publication scenario (Beehiiv devbeans)

1. User on shared "devbeans" publication clicks unsubscribe.
2. Beehiiv posts event with `publication_id: pub_69c961a7...` to parent's `/marketing/webhook/forward`.
3. Parent fans out the raw event to all N brands.
4. The 6 brands sharing the devbeans publication: `getPublicationId()` matches, they each look up the user, only the brand(s) with the user write the doc and call `mailer.remove`.
5. The brands with dedicated publications: `getPublicationId()` mismatch, silent skip.

## Email library consent gate

[src/omega/libraries/email/marketing/index.js](../../packages/backend/src/omega/libraries/email/marketing/index.js)

`email.add()` and `email.sync()` check the user's `consent.marketing.status` IN THE LIBRARY, before validation and provider calls. Because the gate lives in the library rather than at call sites, every caller is covered: the signup route, the email-preferences toggle, payment-event syncs ([events/firestore/payments-webhooks/on-write.js](../../packages/backend/src/omega/events/firestore/payments-webhooks/on-write.js)), the admin PUT re-sync (`routes/marketing/contact/put.js`), the public newsletter form (`routes/marketing/contact/post.js`).

**Semantics:**

- **Revoked-only skip.** ONLY the literal string `'revoked'` blocks. Missing consent, `null`, or any other value proceeds — legacy users have no `consent` field and must keep syncing.
- **`sync()`** — after the user doc is resolved (whether passed as a doc or fetched by uid), a revoked doc logs a warn and returns `{ blocked: 'consent', email }` (mirrors the `{ blocked: 'validation', ... }` shape) BEFORE validation and provider calls.
- **`add()`** — looks up the user doc by email first (same `auth.email` equality query the webhook providers use). Doc found + revoked → `{ blocked: 'consent', email }`. No doc found → proceed (pure newsletter contact). Lookup failure → proceed (fail open, logged) — a rare duplicate add is recoverable; silently dropping contacts is not.
- **`remove()` is never gated** — removal is always safe.

The signup route ADDITIONALLY gates at its call site (`userRecord.consent.marketing.status === 'granted'` before calling `mailer.sync(uid)`) — that check runs before the route's paid NeverBounce/ZeroBounce mailbox validation, so declined users never trigger a paid check. The library gate is the safety net for everyone else.

The gate logic is unit-tested without Firestore in [test/email/marketing/consent-gate.test.js](../../packages/backend/test/email/marketing/consent-gate.test.js) — run with `npx omega test framework:email/marketing/consent-gate` (the test needs no emulator, but the runner boots its standard harness around it).

## Configuration

### Env vars (per brand)

```bash
# All brands
OMEGA_WEBHOOK_KEY="<shared-across-all-brands>"

# Minted by the manager (brand-generated — nothing to paste)
UNSUBSCRIBE_HMAC_KEY="<32 random bytes, hex>"

# Existing (unchanged)
SENDGRID_API_KEY="<account-wide>"
```

The webhook key is shared because it has to be the same value the parent forwards to each child. Rotate by updating every brand's env in lockstep.

`UNSUBSCRIBE_HMAC_KEY` has no dashboard behind it: `omega manage` mints it into the brand `.env` when the cascade serves none and disperse composes it into the backend's own ([#569](https://github.com/Omega-JS-Stack/omega/issues/569)). A brand's backend **refuses to boot without it, in every environment** ([#581](https://github.com/Omega-JS-Stack/omega/issues/581) — the boot guard validates every required key of the env schema at once and names them all) — signing an email with nothing, and only finding out at a real customer's first receipt, is the failure that bought this guard. There is ONE reader of the key, `libraries/env.js`, on both the signing and the verifying side.

### Provider dashboard setup

**SendGrid Event Webhook** (Settings → Mail Settings → Event Webhook):
```
URL: https://api.itwcreativeworks.com/omega/marketing/webhook/forward?provider=sendgrid&key=<OMEGA_WEBHOOK_KEY>
Events: Group Unsubscribe, Unsubscribe, Spam Report, Bounce, Dropped
```

**Beehiiv Webhooks** (per-publication setup):
- Dedicated publications: point at the single brand's parent URL.
- Shared "devbeans" publication: point at the parent URL — fan-out handles the routing.

```
URL: https://api.itwcreativeworks.com/omega/marketing/webhook/forward?provider=beehiiv&key=<OMEGA_WEBHOOK_KEY>
Events: subscription.unsubscribed, subscription.deleted, subscription.paused
```

### Parent vs child config

Parent's `config/omega.json5` (`targets.backend` section):
```js
{
  parent: 'self',
  brand: { id: 'itw-creative-works', url: 'https://itwcreativeworks.com', ... },
  ...
}
```

Every other brand:
```js
{
  parent: 'https://itwcreativeworks.com',  // NO `api.` subdomain — inserted at call time
  brand: { id: 'somiibo', url: 'https://somiibo.com', ... },
  ...
}
```

**Convention:** `parent` stores the parent's brand URL (matching the format of `brand.url`), NOT the API URL. The API address is derived at call time by `omega.getParentApiUrl()` (`apiAddress`). This keeps stored config in one consistent format and lets the deployment convention live in one place.

**Three helpers** on the instance for working with this:

- `omega.getParentUrl()`: returns the parent's website URL, `config.company.url`, else this brand's own `config.brand.url`.
- `omega.getParentApiUrl()`: returns the parent's API URL, its `apiAddress`: `https://api.{host}` on an owned host, the project's `omega_api` functions url on a default Pages host. Only a brand that IS its parent knows that project id, so a sub-brand's Pages-hosted parent answers `''`. **Always live**: it does NOT redirect to localhost in dev mode, because you can't run two Firebase emulators simultaneously. The parent's API is always the production URL regardless of which environment THIS brand is in.
- `omega.isParent()`: boolean, true when the config names no company or `company: { id: 'self' }`.

Only the @omega.js/backend where `omega.isParent()` returns true exposes `/marketing/webhook/forward`. Everywhere else, the route is invisible (404).

## Legacy user migration

Existing users created BEFORE the consent system has no `consent` field. They need a one-time backfill. The shape per the agreed strategy:

```js
// For every legacy user doc
{
  consent: {
    legal: {
      status: 'granted', // implicit from active account
      grantedAt: {
        timestamp: userDoc.metadata?.created?.timestamp || null,
        timestampUNIX: userDoc.metadata?.created?.timestampUNIX || null,
        source: 'imported',
        ip: userDoc.activity?.geolocation?.ip || null,
        text: null, // don't fabricate label text
      },
    },
    marketing: {
      status: 'revoked', // no opt-in on record
      grantedAt: { timestamp: null, timestampUNIX: null, source: null, ip: null, text: null },
      revokedAt: {
        timestamp: userDoc.metadata?.created?.timestamp || null,
        timestampUNIX: userDoc.metadata?.created?.timestampUNIX || null,
        source: 'imported',
        ip: userDoc.activity?.geolocation?.ip || null,
        text: null,
      },
    },
  },
}
```

**Idempotency guard:** skip docs where `consent.legal.grantedAt.source` already has a non-null value (those went through the new signup flow or a prior migration run).

There is no frontend gate to sequence this against: OMEGA's web auth listener carries no page-load consent guard — UJM's `ENFORCE_CONSENT_GUARD` was deleted rather than ported, so a doc without `consent.legal.status === 'granted'` never signs anybody out ([#700](https://github.com/Omega-JS-Stack/omega/issues/700)).

After the migration: optionally run a re-opt-in drip campaign to legally recover marketing consent for the users you bulk-revoked.

## Test coverage

**@omega.js/backend tests:**

- [test/helpers/user.test.js](../../packages/backend/test/helpers/user.test.js) — 31 tests covering the canonical schema, defaults, granted/revoked states, round-tripping
- [test/routes/user/signup.test.js](../../packages/backend/test/routes/user/signup.test.js) — 3 tests for signup-time consent capture (granted both, marketing declined, missing payload)
- [test/routes/marketing/email-preferences.test.js](../../packages/backend/test/routes/marketing/email-preferences.test.js) — 14 tests for the email-preferences route (anonymous HMAC + authenticated)
- [test/routes/marketing/webhook.test.js](../../packages/backend/test/routes/marketing/webhook.test.js) — 15+ tests covering SendGrid + Beehiiv providers against the emulator
- [test/routes/marketing/webhook-forward.test.js](../../packages/backend/test/routes/marketing/webhook-forward.test.js): verifies the forwarder route returns 404 on non-parent backends
- [test/helpers/webhook-forward.test.js](../../packages/backend/test/helpers/webhook-forward.test.js) — 12 unit-style tests with mocked admin + fetch, covering fan-out, URL derivation, failure isolation, self-inclusion, edge cases
- [test/email/marketing/consent-gate.test.js](../../packages/backend/test/email/marketing/consent-gate.test.js) — 21 plain-node tests for the library consent gate (revoked-only skip semantics, `{ blocked: 'consent' }` returns from `sync()`/`add()`, by-email lookup query + normalization, fail-open on lookup errors); the tests themselves touch no emulator and no network (the runner still boots its standard harness)

**Total: 75+ tests across the consent system.**

Run with `npx omega test` (full suite) or `npx omega test routes/marketing/webhook` (just the webhook tests).

### Live-provider tests (extended mode only)

Most @omega.js/backend tests are self-contained against the local emulator. The marketing-consent system has one test that's an exception — [test/email/consent-lifecycle.test.js](../../packages/backend/test/email/consent-lifecycle.test.js) — which makes real API calls to SendGrid + Beehiiv to verify the full round-trip works end-to-end.

The validation pipeline (`src/omega/libraries/email/validation.js`) blocks all `_test.*` emails from reaching providers via the `/^_test\.(?!allow_)/` pattern in `blocked-local-patterns.js`. The two `_test.allow_*` sentinels (`_test.allow_consent-granted` and `_test.allow_consent-declined`) used by the lifecycle test bypass that gate intentionally, and the test cleans up after itself (phase-3 removes the granted contact via `omega.email.remove()`).

The "all cleanup runs at start, never at the end" rule documented in [docs/backend/test-framework.md](test-framework.md) applies to all test data, including third-party providers.

## Frontend pieces (cross-references)

- **UJM signup form** — [signup.html](https://github.com/itw-creative-works/ultimate-jekyll-manager/blob/main/src/defaults/dist/_layouts/themes/classy/frontend/pages/auth/signup.html) (two consent checkboxes, inline error UX)
- **UJM auth library** — [libs/auth.js](https://github.com/itw-creative-works/ultimate-jekyll-manager/blob/main/src/assets/js/libs/auth.js) (`captureSignupConsent`, `validateConsent`, `reverseAccidentalSignup` for the Google-on-signin quirk)
- **UJM core auth listener** — [core/auth.js](https://github.com/itw-creative-works/ultimate-jekyll-manager/blob/main/src/assets/js/core/auth.js) (`ENFORCE_CONSENT_GUARD` flag, page-load silent-signout for orphan accounts)
- **UJM account page** — [account/index.html](https://github.com/itw-creative-works/ultimate-jekyll-manager/blob/main/src/defaults/dist/_layouts/themes/classy/frontend/pages/account/index.html) + [sections/notifications.js](https://github.com/itw-creative-works/ultimate-jekyll-manager/blob/main/src/assets/js/pages/account/sections/notifications.js)
- **@omega.js/client DEFAULT_ACCOUNT** — [modules/auth.js](../../packages/client/src/modules/auth.js) (consent fields with `'revoked'` defaults so legacy reads don't crash)

## Future work

- **Country-aware default checkbox state** — pre-check both checkboxes in jurisdictions where it's legally permitted (e.g. US under CAN-SPAM). Out of scope for the initial rollout; TODO comment in signup.html.
- **Re-consent flow for material label changes** — if the marketing label text changes meaningfully, prompt existing users to re-consent (versioning via the stored `text` field).
- **Audit-log sub-collection** — currently only the most-recent transition is kept. If legal needs full history, add `users/{uid}/consent-history/{transition-id}`.
- **ECDSA / HMAC signature verification** on webhooks — SendGrid supports it, Beehiiv requires HMAC. Currently bearer-token only (`?key=`). Future hardening.
