# Analytics — the catalog, the one call, and where an event fires

> Every event any OMEGA surface counts — a web page, the desktop main process, the
> extension, a Cloud Function — is declared ONCE in a catalog and fired through ONE
> call, and each provider hears it in its own dialect
> ([#328](https://github.com/Omega-JS-Stack/omega/issues/328)).

This file is the CONTRACT, not a migration report: the package and its catalog are built
([#382](https://github.com/Omega-JS-Stack/omega/issues/382)), the web consent gate is built
([#383](https://github.com/Omega-JS-Stack/omega/issues/383)), the server-side delivery is
built ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)), and every front-end call
site now fires through the facade ([#386](https://github.com/Omega-JS-Stack/omega/issues/386)).
New code writes to what is below.

## The shape

`@omega.js/analytics` is a private workspace package — it never publishes, and prepare
vendors it into the published frameworks (the `@omega.js/account` pattern, HARD RULE 3 in
the repo map; [publishing.md](publishing.md)). It is CJS, because a Cloud Function and the
Electron main process `require()` it while the browser bundles import it with standard
interop.

| File (`packages/analytics/src/`) | What it owns |
|---|---|
| `index.js` | The facade — `event()`, `configure()`, and the fire walk |
| `catalog.js` | The SSOT: one entry per canonical event, with every provider mapping |
| `adapters/resolve.js` | The shared adapter mechanism (catalog lookup → mapping → payload) |
| `adapters/google.js` · `meta.js` · `tiktok.js` | One file per provider: where attribution attaches |
| `transports/browser.js` | Executes a descriptor against the page globals, guarded ([#306](https://github.com/Omega-JS-Stack/omega/issues/306)) |
| `consent.js` | The consent seam — `createConsentGate(providerFn)`, categories, `GRANT_ALL` |
| `core.js` | GA4 Measurement Protocol semantics (device_id/client_id/user_id derivation, payload shape) |
| `logger.js` | This package's `[@omega.js/analytics:<module>]` tag ([logging.md](logging.md)) |

Every provider's facts live in ONE row, in `@omega.js/config`'s
`analytics-providers` (below), and every reader derives from it.

**The one call**, from client code and backend code alike:

```js
analytics.event('purchase', { transaction_id: id, value: 19, currency: 'USD', items: [...] });
```

One fire walks three steps per provider, in this order:

1. **consent** — a blocked category's providers never even resolve
2. **adapter** — this provider's catalog mapping, or `null` when it has none
3. **transport** — the host's seam; a missing or blocked page global is a silent no-op

Nothing in that walk throws at a visitor. A transport that could not deliver returns
`false`, and the dev log is the only trace. That guard is the WHOLE contract for an
unconfigured or blocked provider ([#606](https://github.com/Omega-JS-Stack/omega/issues/606)):
no surface defines a placeholder `gtag`/`fbq`/`ttq`, because a stub only makes a pixel
that never loaded read as present. @omega.js/web's page chrome carries none, and
`test/analytics-blocked.test.js` fails any template or module that names one.

**The host injects its seams** — nothing is sniffed:

```js
analytics.configure({ transport, consent, context, environment });
```

`transport` is `{ send(descriptor) => boolean }`; `consent` is a gate from
`createConsentGate`; `context` is `{ attribution, consent, runtime }`; `environment` mirrors
the client's `config.environment` seam and defaults to `'production'`. An unconfigured
runtime is INERT — it resolves and logs, and delivers nothing — never a guess at page
globals.

**Who injects what**, per runtime:

| Host | transport | consent | context | environment |
|---|---|---|---|---|
| web page (`@omega.js/web` `core/js/libs/analytics.js`) | the guarded browser transport | the banner's record, read live | attribution + `runtime: 'web'` | — |
| `@omega.js/client` | the browser transport on web; the Measurement Protocol in the extension; NONE in a desktop renderer, which forwards over the IPC bridge instead ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)) | — | `runtime` in the extension | the brand's `config.environment` |
| `@omega.js/desktop` main process | its own Measurement Protocol fetch, and the ONE sender for the whole install — its own windows' events included | — | `runtime: 'electron'` | the app's dev flag |
| `@omega.js/backend` | the three HTTP APIs (`libraries/analytics/conversions.js`) | the order's/user's snapshot | the order's attribution | — |

Web core reaches the package THROUGH `@omega.js/client` (`@omega.js/client/modules/analytics.js`),
never as a bare `@omega.js/analytics`: the package is private, so in a consumer install it
exists only as the copy vendored into the client's dist — and the client is a real runtime
dependency of every framework.

**A fire may also carry options**: `event(name, params, { eventId, providers })`. `eventId`
is the platform dedupe key both halves of a two-sided event name (Meta's fourth pixel
argument `eventID`, TikTok's `event_id`). GA4 has no event-id slot — it deduplicates
ecommerce on the `transaction_id` PARAM instead
([Google](https://support.google.com/analytics/answer/12313109),
[#656](https://github.com/Omega-JS-Stack/omega/issues/656)), which is why both halves of a
`purchase` send the same one. `providers` restricts a fire to the providers THIS side owns —
which is how a `both` event splits without double-counting.

**An unknown event name is a programmer error.** It throws in development (a typo must not
silently cost a conversion) and is logged-and-skipped in production, where the throw would
take the customer's action with it.

## The provider rows

- **The one home**: `packages/config/src/analytics-providers.js`, one frozen row per
  provider in `ANALYTICS_PROVIDERS`; `analyticsProvider(id)` answers a row, or `null` for
  an unknown id. The values live there and nowhere else.
- **The id** is the row's `id` everywhere: the catalog's `providers` keys, a
  descriptor's `provider`, the `providers` fire option, the adapter file, the fire log,
  and the config key under `analytics.providers`. GA4 is the product's name, never an id.
  A `providers` option naming an id no row has throws in development and logs in
  production, like an unknown event name.
- **The backend's `providers`**: `deliverConversion` never throws at its caller, so an
  id no row has logs one warning line naming the id and the event, in every
  environment, and the fire goes on.
- **The fields** and who reads them:
  - `consentCategory`: the tracking-consent category that gates the provider. Read by
    the facade's gate, the backend's consent walk, the web loader and
    `CONSENT_CATEGORIES`.
  - `dedupesOnEventId`: the platform collapses a browser half and a server half that
    share an event id. Read by the server half of `sign_up`
    (`libraries/analytics/signup.js`) and the confirmation page's trial half.
  - `matchKeys`: the server match parameters it accepts, in the order the backend's
    fire log (`conversions.js`) reads them out; an empty list means no match block.
  - `browserSender` / `serverSender`: the browser transport's and the backend's
    `SENDERS` can deliver it; tests pin each map to the rows, both ways.
  - `measurementProtocol`: it has a Measurement Protocol transport. Read by the
    client's and desktop main's Measurement Protocol transports.
- **Order and functions**: the facade and the backend fire in the rows' order. The
  adapters, the senders and the match blocks stay where they run; tests pin each row
  to its adapter file and its senders, and each match block to its row's keys.
- **In the browser**: `clientConfig()` ALWAYS bakes the rows as `analytics.capabilities`
  (the shape `payment.capabilities` uses), since they are provider facts, not brand
  settings; `analytics.providers` rides only when the brand configures it. Web core reads
  them through `getAnalyticsCapabilities()` in `core/js/libs/analytics.js`, which throws
  when a build did not bake them.
- **A rule a row cannot express stays with its event**: the confirmation page's trial
  exception is stated once, in `core/js/pages/payment/confirmation/modules/tracking.js`.
- **Not in the rows**: the manager's pixel specs hold API clients, so they stay in the
  manager.

## The catalog contract

One entry per canonical event; callers only ever speak canonical names and canonical
params. There is no unified cross-provider signature — each adapter speaks its provider's
dialect (Ian's constraint). The canonical vocabulary is GA4-flavoured (flat params plus an
`items` array), so GA4 is pass-through and the `map()`s live where the ad platforms
genuinely disagree.

```js
add_to_cart: {
  params: ['currency', 'value', 'items'],
  placement: 'client',
  providers: {
    google: { name: 'add_to_cart', kind: 'standard' },
    meta: { name: 'AddToCart', kind: 'standard', map: metaCommerce },
    tiktok: { name: 'AddToCart', kind: 'standard', map: tiktokCommerce },
  },
},
```

- **`params`** — the canonical param contract; documentation for callers.
- **`placement`** — `'client' | 'server' | 'both'` (the rule below).
- **`providers`** — the per-provider mapping. Each carries `name` (the provider's NATIVE
  event name), `kind`, and an optional `map(params, context) => payload` (default:
  pass-through).
- **`method`** — the rare fourth key, browser only: the provider's own PIXEL METHOD to call
  instead of its tracked-event command, for a signal the platform manages itself rather than
  exposing as a trackable name. Exactly one mapping names one today, TikTok's `page_view` →
  `ttq.page()` ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)); it takes no name
  and no payload, the pixel reads the page, and `name`/`kind` stay declared for the catalog
  and the fire log.
- **`actionSource`** — the fifth key, Meta only and SERVER only: the `action_source` this
  event's conversion carries instead of the default `website`. Meta requires the field and
  asks that it be accurate, and its enum names the case itself, `system_generated`, "for
  example, a subscription renewal that's set to auto-pay each month". So
  `subscription_renew`, `payment_recovered` and `trial_convert` declare it: a card was billed
  with nobody on the site ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)). A
  cancellation the subscriber clicked is a website conversion like any other and declares
  nothing.

**The two commerce dialects**, as the 2026-09-02 standards review against the live references
left them ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)). The browser and the
server halves send the SAME payload for one event, because that is what they deduplicate on:

- **Meta** `custom_data` carries `content_ids` AND `contents` (`{ id, quantity, item_price }`,
  Meta's own field names; its pixel reference asks for `contents` or `content_ids` on a catalog campaign),
  `content_type: 'product'`, `currency`, `value`, `num_items` (the UNITS bought, summed over
  the items, not the number of lines), `order_id` from the canonical `transaction_id`, and
  `content_name` only on an event with exactly ONE product, since Meta documents it as the
  singular name of the page/product.
- **TikTok** `properties` carries `content_ids` AND `contents`
  (`{ content_id, content_name, content_category, price, quantity }`, `content_category`
  filled from the item's `item_category` and left out when it has none),
  `content_type: 'product'` at the PROPERTIES level where Events API 2.0 documents it (its
  `contents` object has no per-item `content_type`; the older Pixel SDK model's does),
  `currency`, `value` (the order total, where a `price` is one item's) and `order_id`.
- A churn moment's exclusion signal keeps neither platform's priced fields: Meta's `contents`
  comes off whole (its `item_price` IS the amount, and the object requires `id` + `quantity`),
  TikTok's keeps the array minus `price`/`quantity` (its `content_category` stays), and
  `content_ids` names the plan on both.

**The three mapping kinds** — and the third one is an absence:

| Kind | Meaning | What the transport does |
|---|---|---|
| `standard` | The platform defines this event | Meta `fbq('track', …)`, the platform's own event |
| `custom` | A deliberate custom event (often preserving today's data continuity, e.g. Meta `ExitPopupShow`) | Meta `fbq('trackCustom', …)` |
| *absent* | This provider has no mapping for this event | The adapter returns `null`; the facade dev-logs `skipped (no mapping)` |

**Unmapped stays unmapped.** An absent mapping is a decision, not a gap to fill: inventing a
custom event so a provider "has coverage" ships junk into an ad account nobody will ever
read. Equally, a mapping must be HONEST — several pre-OMEGA call sites claimed standard
names their platform does not define, and those are `custom` here.

**Every name, kind and param is checked LIVE against the platform's own spec before it is
written or changed** (Ian 2026-08-27,
[#652](https://github.com/Omega-JS-Stack/omega/issues/652)) — never from memory, because a
platform renames and retires events (TikTok retired `CompletePayment` for `Purchase`, and
`ClickButton` was never on its standard list at all). The pages sit in the catalog
header so no edit can miss them:

| Spec | What it settles |
|---|---|
| [GA4 recommended events](https://support.google.com/analytics/answer/9267735) | Which canonical names are GA4 standards |
| [Meta standard events](https://www.facebook.com/business/help/402791146561655) | The exact wire name, and what each event MEANS (Purchase requires `value` + `currency`) |
| [Meta Pixel reference](https://developers.facebook.com/docs/meta-pixel/reference) | Which params each standard event takes, and which a catalog campaign needs (`contents` or `content_ids`) |
| [TikTok standard events](https://ads.tiktok.com/help/article/standard-events-parameters) | The current standard roster and its recommended params |
| [TikTok Events API 2.0](https://business-api.tiktok.com/portal/docs?id=1771100865818625) | The server half's envelope, `properties` and `contents` fields (the 2.0 shape, which is not the Pixel SDK's) |
| [GA4 transaction_id dedupe](https://support.google.com/analytics/answer/12313109) | The one PARAM that binds: one id per charge |

A `kind: 'standard'` may only ever claim a name the platform lists; anything else is
`custom`, under the canonical event's own PascalCase name. `packages/analytics/test/catalog.test.js`
pins both rosters, so a mapping that drifts off them fails.

**Adding an event is one catalog entry plus a test.** The entry lands in `catalog.js` under
its section, and `packages/analytics/test/catalog.test.js` gets the resolve case that proves
the mapping (name, kind, and the payload each provider receives). The shape guards —
placement valid, every mapping carrying a name and a known kind — already run over the whole
catalog, so a malformed entry fails without new test code.

**Naming.** Canonical names are snake_case and follow GA4's standard names where one exists
(`file_download`, not `download`). A custom name is `{category}_{action}` with the action in
PRESENT/imperative form — `trial_start`, `subscription_cancel`, `user_delete`, never the past
tense of the fact ([#416](https://github.com/Omega-JS-Stack/omega/issues/416)) — because that
is how GA4, Meta and TikTok all name a conversion; a platform's own standard WIRE name stays
verbatim wherever a mapping uses one (Meta and TikTok both spell it `StartTrial`), but a PascalCase
wire WE coin for a `custom` mapping obeys the same tense rule as the canonical it carries
(`SubscriptionCancel`, `Refund`, never the past-tense form). Action buckets
stay buckets — `user_billing_action`, `user_refund_request`, `user_section_view` carry an
`action`/`section` param rather than sprawling into an event per button.
Two events that look similar are only merged when they
answer the same question: `marketing_newsletter_subscribe` and `status_subscribe` are deliberately
distinct. A family's names move TOGETHER — the marketing opt-ins and their opt-outs all carry
the `marketing_` prefix (`marketing_email_subscribe` / `marketing_email_unsubscribe`), while
`status_subscribe` keeps none because status-page updates are operational, not marketing.

## The placement rule

**Money and account truth fires SERVER-side. UI actions fire CLIENT-side. `sign_up` fires
BOTH.**

| Placement | Why | Examples |
|---|---|---|
| `server` | The browser cannot be trusted for revenue, and the outcome is only known where it happened | `refund`, `trial_convert`, `trial_lapse`, `subscription_cancel`, `subscription_uncancel`, `subscription_plan_change`, `subscription_renew`, `payment_recovered`, `user_delete` |
| `client` | The event IS the interaction — nothing server-side ever sees it | `view_item`, `add_to_cart`, `begin_checkout`, `add_payment_info`, `page_view`, `file_download`, the exit-popup, consent, notification-permission and account-navigation events |
| `both` | Ad platforms need the browser signal for retargeting AND the server signal for truth | `sign_up`, `purchase`, `trial_start` |

When both halves fire, both must carry the SAME event id so the platform collapses them into
one conversion (Meta's deduplication, TikTok's `event_id`). Sending both without the id is
double-counting; sending only the server half loses the retargeting signal — which is exactly
the hole the commented-out purchase pixel left
([#302](https://github.com/Omega-JS-Stack/omega/issues/302)).

**GA4 deduplicates `purchase` on `transaction_id`** — web streams only, and never on an
empty string ([Google](https://support.google.com/analytics/answer/12313109)). It has no
event-id slot, so which providers each half owns is decided per event, and the three `both`
events split it three different ways:

| Event | The dedupe id | Browser half | Server half |
|---|---|---|---|
| `sign_up` | `sign_up.<uid>` — the uid is the only thing both sides hold before either fires | GA4 + Meta + TikTok (`libs/auth/tracking.js`) | Meta + TikTok (`routes/user/signup` → `libraries/analytics/signup.js`, the post-auth request — never the auth trigger, which has no request behind it, [#577](https://github.com/Omega-JS-Stack/omega/issues/577)) |
| `purchase` | `purchase.<order id>` for the ad platforms, and the same `<order id>` as `transaction_id` for GA4 | GA4 + Meta + TikTok (`pages/payment/confirmation/modules/tracking.js`) | GA4 + Meta + TikTok (`events/firestore/payments-webhooks/analytics.js`) |
| `trial_start` | `trial_start.<order id>` | Meta + TikTok (`pages/payment/confirmation/modules/tracking.js`) — GA4's `trial_start` is a CUSTOM event with no dedupe, so the server keeps it | GA4 + Meta + TikTok (`events/firestore/payments-webhooks/analytics.js`) |

GA4 rides the browser purchase because the id makes it safe, and the browser is where the
session, the campaign and the `client_id` are — a webhook has none of them
([#656](https://github.com/Omega-JS-Stack/omega/issues/656)). And the browser half fires
`trial_start`, not `purchase`, on a trial checkout: `?track=true` rides EVERY checkout, and
two different event NAMES never deduplicate, so the old browser Purchase collapsed into
nothing and each platform counted it as a second conversion beside the server's trial. The
value was never the defect — the intent route already sends `amount=0` on a trial's
confirmation URL ([#654](https://github.com/Omega-JS-Stack/omega/issues/654)).

**`transaction_id` is ONE CHARGE's id, never the subscription's** (Ian 2026-08-27):

| The charge | The id | Why |
|---|---|---|
| First purchase — a paid checkout, a one-time buy, or a trial start | the ORDER id | The only id the confirmation page holds, so both halves match |
| Renewal, recovery, trial conversion | the provider's own charge id (Stripe/Chargebee invoice, PayPal sale), carried on the webhook event as `chargeId` | A subscription bills against one order forever; the subscription id collapsed every renewal after the first into a GA4 duplicate |
| Refund | the id of the charge it reverses — the provider's `chargeId` on a subscription, the ORDER id on a one-time buy (its single charge, and no provider names one on the refund) | So GA4 nets the two |
| Everything else (cancel, uncancel, plan change, lapse) | the subscription id | A GA4 CUSTOM event with no dedupe, and the subscription really is its subject |
| THE EXCEPTION — the trial-lapse sweep's own `trial_convert` (`events/cron/daily/trial-lapse-sweep.js`) | the subscription id | The provider never announced the charge (PayPal fires no trial-end event at all), so this path has no invoice to name. `trial.outcome` is stamped once, which keeps it to one fire |

Revenue is the server's, because a browser cannot be trusted with it; a registration's GA4
count is the browser's, because that is where the funnel it belongs to lives.

An entry's `placement` is where the rule is written down per event, so a call site in the
wrong tier is a reviewable finding, not a judgment call.

## Consent

Nothing counts before the visitor's answer is known. Two tiers, chosen by the browser's own
timezone — no network call, nothing to consent to before consent exists
(`packages/web/core/js/libs/consent-region.js`):

- **Opt-in regions — a STRICT ROSTER**: `Europe/*` (the EEA, the UK, and Turkey, which rides
  the prefix), the four Atlantic zones the EEA reaches outside it (Reykjavik, Canary, Madeira,
  Azores), Brazil's sixteen zones (LGPD), China (PIPL: Asia/Shanghai, Asia/Urumqi) and South
  Korea (PIPA: Asia/Seoul). No provider script loads until Accept, and the banner is the GATE
  that asks. Google Consent Mode's `consent default` is queued into `dataLayer` before gtag.js
  can load (denied), and every change pushes a `consent update`, so the tag itself honors the
  flags on top of us not loading it. A timezone we cannot place reads as opt-in — the only safe
  direction.
  - **The join rule**: a country joins only when its law genuinely requires opt-in consent for
    tracking cookies and that is verified; when in doubt it stays out
    ([#423](https://github.com/Omega-JS-Stack/omega/issues/423)). Quebec's Law 25 qualifies but
    cannot be expressed — America/Montreal aliases to America/Toronto — so Canada stays out.
- **Everywhere else**: auto opt-in, scripts load immediately, and a first visit sees **no
  banner at all** ([#391](https://github.com/Omega-JS-Stack/omega/issues/391)) — only the
  small Cookies Settings tab, which reopens the full panel for anyone who wants to turn things
  off. There is nothing to gate and nothing worth interrupting, so `cookie_banner_show` fires
  only where the banner actually shows.

The record is `trackingConsent` in the client storage blob
(`packages/web/core/js/libs/tracking-consent.js`): `{ analytics, marketing, region,
timestamp, version }`. Two categories, because that is what a visitor can meaningfully
answer — `analytics` (GA4) and `marketing` (Meta, TikTok); "necessary" is not a category
because nothing about it is optional. Bumping `TRACKING_CONSENT_VERSION` re-prompts everyone,
which is what changing what a category COVERS requires.

- The banner is `packages/web/core/js/core/consent.js`: a cookie-iconed message, one big
  Accept, and a small Customize opening the panel — a dense legal intro, a row of pill
  switches (Necessary locked on, then Analytics and Marketing), then **Accept all / Accept
  none** bottom-right. Every switch APPLIES AND SAVES the moment it is flipped and the panel
  stays open, so there is no Save to forget to press; either button flips every switch to
  match, saves, and collapses to the tab. Refusal is one click at the same size as the grant
  (the EU equal-ease rule). The loader that actually gates the scripts is
  `packages/web/core/js/core/analytics-loader.js`, and it runs FIRST in `main.js` — nothing
  may count an event ahead of that decision. That loader counts NOTHING of its own: the Meta
  and TikTok page views it used to fire raw at pixel init now go through the facade like every
  other event ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)), restricted to the
  pixel that just installed, since GA4 counts its own page view off the `config` command.
- **A save that grants nothing IS the denial** — Accept none and an all-off panel are the
  same answer and fire the same `cookie_consent_deny`. That fire is made AFTER the record is
  written, so the gate the visitor just closed is the one it is asked about: a denial is
  honored, not counted.
- Granting a category injects its loader immediately, no reload. REVOKING cannot unload a
  running script, so it takes effect on the next page load while Consent Mode updates now.
- In the package, the facade reads each provider's `consentCategory` off its row and asks
  the gate once per provider per event. The gate reads its provider function LIVE, so a visitor who
  accepts mid-session is counted from that moment with nothing re-configuring. The default
  when no host injects a gate is `GRANT_ALL` — desktop, extension and backend have no banner
  to gate on.
- The same consent state gates the server-side match-data enrichment
  ([#302](https://github.com/Omega-JS-Stack/omega/issues/302)): an opted-out user sends
  nothing, from either side.
- **Absence is not denial.** Server-side, a null or absent `trackingConsent` snapshot
  GRANTS both categories — only an explicit `false` blocks. Legacy orders predating the
  consent system and the raw-API recovery lane (which mints orders with no client anywhere
  near them) carry no snapshot at all, and refusing to report their revenue would be a
  silent accounting hole rather than a privacy win.
- **Cloudflare Web Analytics sits OUTSIDE this gate.** Its beacon is injected by the edge, not
  loaded by the page, so no consent answer reaches it; it is on or off per zone through
  `edge.providers.cloudflare.webAnalytics.enabled` ([docs/manager/edge.md](../manager/edge.md)).

**The `consent` name is taken.** `consent` in storage and in the signup payload is the
signup form's LEGAL record (`{ legal, marketing }`, captured by
`packages/web/core/js/libs/auth/forms.js` and interpreted by the backend signup route).
Tracking consent is `trackingConsent` — key, exports, and payload field — everywhere. Sharing
one key would read a tracking answer as a revoked terms agreement.

## Attribution

Attribution is captured once and CARRIED; no event assembles its own.

- **The shape**: `attribution: { first, last, affiliate }` in client storage — first-touch
  written on the first visit ever seen and never overwritten, last-touch replaced only by a
  TAGGED visit, both timestamped (any lookback window is computed at read time).
- **Where it attaches**: the user doc at signup, `payments-intents` at creation, and
  `payments-orders` via the intent fold. The tracking-consent snapshot rides the same
  payloads under `trackingConsent`.
- **The reserved slot**: every event carries attribution through the facade's `context`, not
  through its params — `configure({ context })` → `resolve(name, params, context)` → each
  adapter attaches it the way ITS provider wants: GA4 takes campaign fields as flat event
  params, while Meta (`fbc`, `fbp`) and TikTok (`ttclid`, `ttp`) take theirs in the
  descriptor's `userData` match block, never in the event's custom data. The touch's
  `url`/`referrer` ride the same slot server-side ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)):
  Meta sends `event_source_url`, TikTok a `page` object, GA4 nothing — omitted entirely
  when the touch carried no url. A call site never hand-attaches attribution.

Capture and storage are [#384](https://github.com/Omega-JS-Stack/omega/issues/384); the
server-side delivery with full match data (hashed email/phone, IP, user agent, click ids) is
[#385](https://github.com/Omega-JS-Stack/omega/issues/385);
[#302](https://github.com/Omega-JS-Stack/omega/issues/302) owns the deep spec for both.

## Running paid ads

Two systems count a paid campaign, they disagree by design, and each is right about a
different question. This is the reading guide, plus the one thing every campaign has to do
for either of them to work.

**Every paid ad link carries utm tags.** The system can only credit what the LINK declares:
the landing capture reads the utm tags off the URL, stores them as that visit's touch, and
carries the touch onto the user doc, the payment intent and the order. An untagged ad click
is an organic visit forever, in both ledgers below. So the destination URL of every ad, on
every platform, is tagged:

```
https://brand.test/pricing?utm_source=meta&utm_medium=cpc&utm_campaign=launch-2026&utm_content=hero-video&utm_term=project-management
```

| Tag | What it names |
|---|---|
| `utm_source` | The platform the click came from (`meta`, `tiktok`, `google`, `newsletter`) |
| `utm_medium` | How it was paid for (`cpc`, `paid_social`, `email`) |
| `utm_campaign` | The campaign, spelled the SAME way it is spelled in the ads manager |
| `utm_content` | The creative, so two ads in one campaign stay tellable apart |
| `utm_term` | The keyword or audience (optional: search and interest targeting) |

The platform's own click id (`fbclid`, `ttclid`, `gclid`) rides along on its own and is what
the server's match data links a conversion to. The utm tags are how a HUMAN reads the result.

**The two ledgers.** Both are honest; they measure different windows with different rules.

| Ledger | What it counts | Read it for |
|---|---|---|
| The ads manager (Meta Events Manager, TikTok Ads) | GROSS, short window: the conversions its own pixel and Conversions/Events API saw inside its attribution window, at the value that fired, credited its own way | Steering spend day to day, and feeding the optimizer the signal it bids on |
| GA4, `first user campaign` | NET, long run: everything a campaign's visitors ever did, renewals included and refunds netted out, credited to the campaign that FIRST brought them | Whether the campaign was worth running at all |

The ads manager runs ahead and reads high: it counts a conversion the moment its window says
so, it cannot subtract a refund, and each platform credits itself for clicks the other also
saw. GA4 runs behind and reads low: a renewal thirteen months out still lands on the campaign
that acquired the customer, and a refund nets against the purchase it reverses. Never subtract
one from the other and never average them. **The ads manager decides what to do today; GA4
decides whether to keep doing it.**

**Exclusion audiences are what a churn event is for.** Neither ad platform can subtract
revenue and neither optimizes against an event, but both can build an AUDIENCE from a custom
one ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)). So the two churn moments
reach them as custom events worth zero: `subscription_cancel` as `SubscriptionCancel`,
`refund` as `Refund`, both `value: 0` because sending the real amount would ADD to the
return the ads manager reports. Build the platform's exclusion audience off those two, and
spend stops chasing people who already left. `trial_lapse` is deliberately NOT in that lane:
a lapsed trialist is a win-back audience worth RETARGETING, not somebody to hide ads from.

**The Measurement Protocol secret ships inside extension and desktop bundles, and that is an
accepted tradeoff** ([#413](https://github.com/Omega-JS-Stack/omega/issues/413), Ian's ruling
2026-08-20). Those runtimes have no page pixels, so they report through GA4's Measurement
Protocol, which requires an `api_secret` in the request: a distributed bundle therefore
carries one, and anyone who unpacks it can extract it. The exposure is bounded and known: an
MP secret is WRITE-ONLY, it reads nothing back, and the worst an abuser can do is post junk
events into the property. That is data POLLUTION, not data theft, and it is a documented GA4
limitation rather than a bug here. The reopen trigger is real abuse: if junk events or secret
misuse ever show up in a live property, reopen #413 and spec the backend proxy (every
extension event routed through a Cloud Function, which is the cost the ruling declined to pay
up front).

## Dev logging — one line per fire

In development the whole walk prints as ONE tagged line, the complete per-provider outcome
of that event:

```
[@omega.js/analytics:events] add_to_cart → google sent, meta sent, tiktok skipped (consent: marketing)
```

The outcome vocabulary is the walk itself: `sent`, `skipped (consent: <category>)`,
`skipped (no mapping)`, `skipped (no transport)`, `blocked (no global)` — which is how a
blocker looks, since a blocked global is a silent no-op by contract. Production prints
nothing per fire.

This one line is the whole dev trace. It replaced web core's `setupTrackingInterceptors()`
(`packages/web/core/js/libs/dev.js`), which retired with the call-site rewire
([#386](https://github.com/Omega-JS-Stack/omega/issues/386)): monkey-patching the globals
only ever saw the calls that survived the page's own guards, while the walk above reports the
skips too, and why.

## Only production reaches a platform

**A server conversion is delivered in PRODUCTION and nowhere else.** An emulator boot seeds
personas, every seeded account fired the server half of `sign_up`, and Meta delivered dozens
of fake registrations to the brand's live pixel — a dev run polluting the ad data the
optimizer bids on ([#464](https://github.com/Omega-JS-Stack/omega/issues/464)). So
`deliverConversion` carries the gate `@omega.js/monitoring` and the Measurement Protocol
helper already carry: any non-production environment (development OR testing, the intentional
`!isProduction()` check) delivers nothing.

The gate sits AFTER the catalog resolve, so the walk still reports what WOULD have fired and
with what — a blocked send is information, not silence. Each blocked provider says so on its
own line, and the fire's summary line carries the outcome word `blocked (dev)` plus the match
keys that fire would have carried (providers separated by ` | `, since each summary has commas
of its own):

```
[@omega.js/backend:omega_api] deliverConversion [meta]: sign_up blocked (dev) — nothing sent (event_id=sign_up.<uid>)
[@omega.js/backend:omega_api] deliverConversion: sign_up → google skipped (not selected) | meta blocked (dev) sent em,fn,ln,external_id,client_ip_address,client_user_agent,fbp; empty ph,ct,st,zp,country,db,ge,fbc | tiktok blocked (dev) sent … (event_id=sign_up.<uid>)
```

A real send is therefore proved the way **Verifying** says below — a live drive read in the
platform's own debugger — never by pointing a dev run at the live pixel.

## Identity is not an event

An identity has no catalog entry, because it is not something that happened — it is a SETTING
the events after it inherit. Each provider takes its own: GA4's `set` (`user_id`, user
properties), the Meta Pixel's advanced-matching `init`, TikTok's `identify`. So it lives
beside the transport rather than inside the catalog, in exactly one module per runtime:

- **web** — `identify(user)` / `reset()` in `core/js/libs/analytics.js`, called by
  `core/js/core/auth.js` off the auth state, guarded per provider like every other page call.
  It sets GA4's user PROPERTIES, the Meta `init` and the TikTok `identify`. `external_id` is
  each platform's own key and rides in the shape that platform's spec asks for: RAW for Meta,
  which only RECOMMENDS hashing and whose own Pixel example passes a bare id, and SHA-256 for
  TikTok, whose Events API REQUIRES the digest
  ([#410](https://github.com/Omega-JS-Stack/omega/issues/410)). Every OTHER match
  key is SHA-256 hashed before it reaches a pixel, normalized per that platform's own spec
  (Meta hashes a phone as bare digits, TikTok as E.164), and the rules live in
  `@omega.js/analytics/identity`. The server's match data agrees key for key: `match-data.js`
  reads the SAME normalizers out of that module and carries both digests
  (`metaPhoneHash` / `tiktokPhoneHash`, the browser's own key names, plus
  `tiktokExternalIdHash`), so a pixel event and a server conversion for one person present
  identical match keys
  ([#392](https://github.com/Omega-JS-Stack/omega/issues/392)).
- **every runtime** — `@omega.js/client`'s `setUserId` / `setUserProperties`, which SEND on
  web through the page's gtag and ride the Measurement Protocol payload elsewhere. The one
  carve-out is a bridged desktop renderer: main owns identity, so its renderer forwards
  `setUserProperties` over the bridge and `setUserId` throws loudly
  ([#480](https://github.com/Omega-JS-Stack/omega/issues/480)). The
  cross-surface value is `uuidv5(uid, namespace)`: the same human is the same `user_id` on a
  page, in the desktop app, in the extension and from a Cloud Function.

**GA4's `user_id` has exactly ONE owner: the client.** Both modules run on a web page off the
same auth transition, so a second writer is simply the last writer — and web writing the raw
uid there would leave GA4 holding an id no other surface ever sends. `identify()` therefore
sets no `user_id`, and `reset()` clears none.

The client also fires `login` / `logout` off auth state — on every runtime EXCEPT web, where
the auth pages own them, because only the call site knows the method the visitor actually
used.

### The device id every `client_id` starts from

`client_id` is `uuidv5(deviceId, namespace)`, and the deviceId under it comes from ONE
derivation — `core.deriveDeviceId({ get, set, seed })` — with each target injecting its own
world, on the `createRequest(deps)` mold
([#396](https://github.com/Omega-JS-Stack/omega/issues/396)):

| Target | Persistence | Seed |
|---|---|---|
| web · extension (`@omega.js/client`) | `localStorage._omega_device_id` | none — a page can read nothing about the machine, so the generated UUID IS the id |
| desktop main (`lib/context.js`), for the whole install | electron-store `context.deviceId` | the first non-internal MAC, so a reinstalled app resolves the id it had before its storage was wiped |

A desktop RENDERER derives none and persists none ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)):
its client is bridged, its events are delivered by main's sender, and main's id is the
install's identity. A renderer minting its own would be the identity fork the bridge exists to
prevent — one install counted as two GA clients.

The walk is **stored → seed → uuidv4**: a persisted id always wins (a desktop install survives
a NIC swap or a VPN), and the floor is the `uuid` package's `v4`, which is a real UUID in every
runtime — it uses the platform's `crypto.randomUUID` where that exists and `getRandomValues`
where it does not (an insecure origin), so no surface falls back to a random-looking string.

**One machine is NOT one GA client across surfaces**, and never was: each surface derives its
device id from its own storage, so the desktop app and the browser on one machine are two
`client_id`s. What unifies a human is `user_id`, and it rides ALONGSIDE the client id in every
payload rather than replacing it — providers need the stable client id for session stitching.

## Match quality — every parameter, and where its value comes from

**The plumbing exists for EVERY match parameter each platform accepts, even where a brand does
not yet hold the value** (Ian's ruling, 2026-08-24,
[#577](https://github.com/Omega-JS-Stack/omega/issues/577)). An empty value compacts away as
it always has; what is never acceptable is a parameter the platform reads and we never wired.
Meta scored the playground's StartTrial 6.2/10 and its CompleteRegistration around 4/10 while
every server event carried `em` + `external_id` alone — and the account doc already held the
name, birthday, gender, location and phone.

**One normalization table per provider, and no shared "close enough" normalizer.** The rules
genuinely differ key by key, and a value normalized by the wrong platform's rule is ACCEPTED
by the API and matched to nobody — the same silent nothing an unhashed value is. The server's
tables live in `packages/backend/src/omega/libraries/analytics/match-data.js`; the browser
half's shared rules (email, phone, external id) live in `@omega.js/analytics/identity` so both
halves of one person present identical keys.

**Meta** — Conversions API `user_data`
([customer-information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)).
Every key below is hashing-required except the last four.

| Key | Source | Normalization |
|---|---|---|
| `em` | `auth.email` (Auth's record on a signup) | trim, lowercase, SHA-256 |
| `ph` | `personal.telephone` `{ countryCode, national }` | digits only, country code included, SHA-256 |
| `fn` / `ln` | `personal.name.first` / `.last` | lowercase, no punctuation, SHA-256 |
| `ct` | `personal.location.city` | lowercase, no punctuation and NO SPACES (`newyork`), SHA-256 |
| `st` | `personal.location.region` | the 2-character ANSI code in lowercase (a US state NAME is looked up); other countries lowercase with no spaces, SHA-256 |
| `zp` | `personal.location.postalCode` — the account page's optional postal-code field ([#663](https://github.com/Omega-JS-Stack/omega/issues/663)); the bag key keeps Meta's own name | lowercase, no spaces or dashes, first five digits of a US zip, SHA-256 |
| `country` | `personal.location.country` | ISO 3166-1 alpha-2, lowercase, SHA-256 — a country NAME sends nothing |
| `db` | `personal.birthday` (the `$timestamp` pair) | `YYYYMMDD` in UTC, SHA-256 |
| `ge` | `personal.gender` | the lowercase initial, and Meta accepts `f`/`m` alone — anything else sends nothing |
| `external_id` | the uid | RAW (Meta only RECOMMENDS hashing, #410) |
| `client_ip_address` / `client_user_agent` | the request that created the checkout intent, or the post-auth signup request | never hashed |
| `fbc` / `fbp` | the browser's `_fbc`/`_fbp` cookies; `fbc` is CONSTRUCTED from a captured `fbclid` when the cookie never arrived | never hashed |

**TikTok** — Events API 2.0 `data[].user`
([event/track/](https://business-api.tiktok.com/portal/docs?id=1771101303285761)): `email`,
`phone`, `external_id` (all three SHA-256 REQUIRED), `ttclid`, `ttp`, `ip`, `user_agent`.
**There is no name or address parameter** — its user object documents none, so the backend
sends none. A `first_name` or `zip_code` key there is read by nobody.

**GA4** — Measurement Protocol `user_data`
([user-provided data](https://developers.google.com/analytics/devguides/collection/ga4/uid-data)),
built by `helpers/analytics.js` from the authenticated request's own user. Its rules are NOT
Meta's: `sha256_email_address` and `sha256_phone_number` (E.164 WITH the `+`), and an
`address` block whose `sha256_first_name` / `sha256_last_name` drop digits and symbols,
`sha256_street` keeps its digits, while `city`, `region` (the region NAME, not a code) and
`postal_code` ride in the CLEAR and `country` is UPPERCASE alpha-2. The address comes off the
account: `personal.location.street` and `personal.location.postalCode` are the account page's
optional fields ([#663](https://github.com/Omega-JS-Stack/omega/issues/663)). The account's own
`personal.location` wins over the request's geolocation, which stays the fallback.

**Where the signup's match data comes from.** The server half of `sign_up` fires from the
post-auth request (`routes/user/signup`, via `libraries/analytics/signup.js`), NOT from the
auth trigger: a trigger has no HTTP request behind it, so it could see no IP, no user agent,
no platform cookies and no attribution the browser had not posted yet. The browser posts the
cookies under `attribution.cookies` — the shape the checkout intent already sends — and the
route's own `flags.signupProcessed` gate keeps it to one fire per account. The dedupe id is
`sign_up.<uid>` on both halves, as before.

**Reading it back.** Two dev surfaces answer the two halves of "did this match?":

- the backend's fire log names, per provider, the keys that went and the accepted keys that
  were empty — KEY NAMES ONLY, because a hashed email is still that person's email:
  `deliverConversion: sign_up → meta blocked (dev) sent em,external_id,client_ip_address,client_user_agent; empty ph,fn,ln,… | tiktok …`
- the dev palette's **Ad match keys** section (the one dev surface,
  [#342](https://github.com/Omega-JS-Stack/omega/issues/342)) shows the browser's side: the
  consent state, which pixel scripts loaded, which platform cookies exist right now, and the
  stored attribution's keys. The checkout intent's response echoes the cookie key names the
  SERVER received, which is where a blocked pixel shows up.

## Verifying

- **The package**: `npm test` in `packages/analytics` (and the root `test:packages` lane) —
  catalog shape, per-provider resolve, the guarded transport, the consent gate, the dev log.
- **A call site**: drive the flow with a dev server running and read the fire-log line —
  that is the proof the event fired, with what, to whom. Reading the template proves nothing;
  the catalog is what decides.
- **A live drive**: the platforms' own debuggers — GA4 DebugView, Meta Events Manager's Test
  Events, the TikTok Pixel Helper — and both consent regions (an opt-in timezone must show
  nothing loading before Accept).

## Enforcement

The checklist is the plugin's `omega:analytics` skill
([agent-plugins/claude/skills/analytics/SKILL.md](../../agent-plugins/claude/skills/analytics/SKILL.md)),
and the quality hook fires it on every surface that owns an event: the web flow pages and the
auth modules, the backend payment routes and the auth/webhook events, and the package itself.
