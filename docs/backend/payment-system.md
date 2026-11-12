# Payment System

This document covers the full payment system: pipeline architecture, subscription model + statuses, transition handlers, provider interface, product configuration, and the test provider.

## Pipeline

The payment system follows a linear pipeline: **Intent → Webhook → On-Write → Transition**.

1. **Intent** (`POST /payments/intent`): Client requests a payment session. @omega.js/backend verifies the purchaser is one of this project's users (an auth user AND a user doc — [below](#a-payment-never-creates-a-user-doc)), validates the product, generates an order ID (`XXXX-XXXX-XXXX`), and delegates to the provider module (e.g., Stripe creates a Checkout Session). Saves to `payments-intents/{orderId}`.

2. **Webhook** (`POST /payments/webhook?provider=X&key=Y`): Provider sends event data. @omega.js/backend parses and categorizes the event (`subscription` or `one-time`), extracts the UID, and saves to `payments-webhooks/{eventId}` with `status: 'pending'`.

3. **On-Write** (Firestore trigger on `payments-webhooks/{eventId}`): Fetches the resource from the provider API — [the only trusted source](#a-lookup-the-provider-cannot-answer-never-processes-the-payload), never the object the webhook body carried — transforms it into a unified object, detects state transitions, dispatches handlers, tracks analytics, and writes to `users/{uid}.subscription` (subscriptions) and `payments-orders/{orderId}`.

4. **Transitions** (fire-and-forget): Handler files run asynchronously after detection. Failures never block webhook processing. Skipped during tests unless `TEST_EXTENDED_MODE` is set.

### A lookup the provider cannot answer never processes the payload

**The provider's lookup response is the only trusted source.** A webhook body is whatever the caller posted — the endpoint authenticates on the query key by design, and nothing in the body is verified — so `fetchResource()` used to swallow a failed lookup and hand that body back as the resource, flagged `_stale`. Unverified data then drove real subscription state and real conversion events ([#506](https://github.com/Omega-JS-Stack/omega/issues/506)). There is no fallback any more, for any provider: a lookup that fails produces no resource at all, and the pipeline branches on WHICH failure it was.

| Outcome | What it means | What the pipeline does |
|---|---|---|
| **Not found** | The provider affirmatively does not have the resource (Stripe `resource_missing`/404, a Chargebee 404, a Coinbase Commerce 404, `PayPal API 404`) | **Refuse and acknowledge.** Nothing is written — no subscription, no order, no intent, no conversion. The event doc completes with `refusal` = `{ reason: 'resource-not-found', resourceType, resourceId }` and a loud `RESOURCE NOT FOUND` error naming the provider and the resource. Completed, not failed: no retry could ever turn a resource the provider does not have into one it does, so the ladder is not burned and the provider stops redelivering |
| **Unreachable** | A timeout, a 5xx, an expired key — the answer exists and this attempt could not read it | **Defer.** The throw marks the doc `failed`, which is what the [retry sweep](#payments-webhooks-retry-state) re-pends: the redelivery IS the reconciliation mechanism. Still nothing is written off the payload |
| **Permanent** | The lookup can never even be ATTEMPTED — a malformed envelope, a parser error. Today's one instance: a Stripe refund envelope carrying no charge id at `data.object.id` | **Fail terminally.** The doc is marked `failed` AND `deadLetter: true` on its FIRST attempt, with a loud `PERMANENT FAILURE` line and the envelope's actual shape (`type=`, `data.object.object=`, `data.object keys=[…]`) in the message. Handing `undefined` to the SDK threw something that is not a 404, so this used to classify as unreachable and burn the whole ladder ten minutes at a time before dead-lettering something the first attempt already knew was unprocessable ([#536](https://github.com/Omega-JS-Stack/omega/issues/536)) |

The split is one rule for every provider, in `libraries/payment/provider-errors.js` — the same classifier the cancel route and the trial-lapse sweep force-write against — and `libraries/payment/fetch-failure.js` is what every library's lookup throws through — `fetchResource()` and `getRefundDetails()` alike, each naming itself in the message so the failure points at the call that actually missed — so no provider names its own not-found shape twice. Anything unrecognized is unreachable by construction: an unknown error must never be the one that drops an event.

The webhook body is still read for **identifiers** — which event, which resource id, which order a failed event belonged to. What it may never do is say what STATE a resource is in. The one library that reads its own body as an answer is the [test provider](#test-provider): there is no test provider out there to ask, so the emulator's records plus the event body are its API — and the webhook route refuses `provider=test` in production.

### A lookup that DOES answer says whose event it is

The same rule, one step further in: on a successful lookup the uid comes from `library.getUid(resource)` — the record the provider answered with — and the payload's uid is only what that is **cross-checked** against. Reading the payload's uid first meant an event naming a REAL subscription id with a different `metadata.uid` moved that subscription onto whatever uid the caller typed ([#509](https://github.com/Omega-JS-Stack/omega/issues/509)). Every provider's resource carries the uid this framework put on it: Stripe `metadata.uid`, PayPal `custom_id`, Chargebee `meta_data`/`cf_uid`, Coinbase Commerce `metadata.uid`.

| The provider's record | The payload | What the pipeline does |
|---|---|---|
| Carries a uid | Claims the same one, or claims none | **Write, steered by the provider's.** A payload that claimed none has the resolved uid persisted on the event doc, exactly as the PayPal `PAYMENT.SALE` path always did |
| Carries a uid | Claims a DIFFERENT one | **Refuse and acknowledge.** Nothing is written — not under the claimed uid, and not under the provider's either: an event that lies about its owner has nothing left in it worth acting on, and writing it quietly under the real owner would hide the forgery. The doc completes with `refusal` = `{ reason: 'uid-mismatch', payloadUid, providerUid, source }` and a loud `UID MISMATCH` error naming both |
| Carries none, but the **hosted page** does | Claims anything | The hosted page is a record of the PROVIDER's, so it steers and the payload is cross-checked against it — a match writes, a mismatch earns the same `uid-mismatch` refusal, stamped `source: 'hosted-page'`. A hit also brings its `orderId` and backfills `meta_data` onto the subscription, so the next event resolves directly |
| Carries none, and no hosted page answers | Claims one | **Write, steered by the payload's** — nothing is left to check it against. A loud `UID FALLBACK` warning names the fallback, because that write is the one that was never cross-checked |
| Carries none, and no hosted page answers | Claims none | Unchanged: an event with no uid fails |

**The hosted-page lookup runs BEFORE the payload's claim is believed.** A Chargebee hosted-page checkout does not forward `subscription[meta_data]`, so the subscription answers no uid until the backfill runs — but `pass_thru_content` on the hosted page holds ours, and that lookup used to be gated on `!uid`: it was consulted only when the payload claimed nothing, i.e. never in the one case where a claim needed checking ([#533](https://github.com/Omega-JS-Stack/omega/issues/533)).

A miss **falls back, never refuses**: the scan covers only the last 25 hosted pages (`GET /hosted_pages?limit=25&sort_by[desc]=created_at`), so a null honestly means "not in the window", not "not this uid" — refusing on it would break every hosted-page checkout older than 25 pages.

`provider=test` is exempt in practice, not by a branch: its `fetchResource()` may legitimately answer with the payload object, so the two uids are the same value and no mismatch can arise. Its protection is the production refusal above.

### The writes are one batch

The three writes an event produces — `users/{uid}.subscription` (subscriptions only), `payments-orders/{orderId}`, and `payments-intents/{orderId}` — land in **ONE Firestore batch**. As separate awaits, anything that threw between them left the state split: a user who paid with no order behind it, or an order whose intent still said `pending`. The batch makes it all-or-nothing. Transition dispatch and analytics stay **outside** the batch — they are fire-and-forget and must never gate the writes.

### A refund merges into the purchase

A refund **updates** a purchase record; it does not redefine it. A one-time refund's resource is the bare charge that moved the money back — it names no product and no price — so re-deriving the order from it degraded a completed purchase to `product: 'unknown'` at price 0 and replaced the checkout `resourceId` with the charge id. The pipeline merges instead:

- `unified.status` → `refunded`
- `unified.payment.refund` → `{ amount, currency, reason, date }` (from the provider library's `getRefundDetails()`)
- product, price, and the purchase's own `resourceId` stay exactly what the completed purchase wrote

**What came back is the provider's number.** `getRefundDetails()` used to read the amount, the currency and the reason out of the webhook envelope, so an event claiming an inflated refund booked that number onto the order record, into the customer's refund email and into the refund conversion ([#510](https://github.com/Omega-JS-Stack/omega/issues/510)). It takes the resource the pipeline already looked up (`getRefundDetails(resource, { raw, refundId, eventType, resourceType, ctx })` — `resourceType` says which of the provider's back-pointers to read, [below](#a-refund-record-has-to-belong-to-the-event-that-named-it)) and answers from provider data only — the envelope is read for the lookup KEY and nothing else, the same trust level as the `resourceId` every lookup starts from. The providers are not symmetric about where a refund lives:

| Provider | Where the refund's numbers come from |
|---|---|
| **Stripe** | The **charge**. The one-time path already fetched it (`resourceType: 'charge'`); the subscription path — whose resource is the subscription the refunded charge belongs to — reads it back by the charge id the payload names |
| **PayPal** | The **refund's own record**: `GET /v2/payments/refunds/{id}` for `PAYMENT.CAPTURE.REFUNDED`, `GET /v1/payments/refund/{id}` for the v1 sale refunds. The sale or capture already in hand is the ORIGINAL payment — its amount is the purchase price, which a partial refund makes plainly wrong. The refund's own id rides on the parsed event as `refundId`, kept there because `resourceId` is reassigned to the sale/capture the refund reversed |
| **Chargebee** | The **credit note**: `GET /credit_notes/{id}`, keyed by the id in the envelope. The subscription or invoice the event resolves to carries no credit-note fields at all, and the envelope's own `content.transaction` amount is no longer a fallback |
| **Chargebee, no credit note** | The **transaction**: `GET /transactions/{id}`, keyed by `content.transaction.id` — a lookup KEY only, exactly the trust level the credit-note id has. A gateway refund issued without a credit note is a real refund, and dropping the untrusted envelope fallback without putting a trusted one in its place wrote `amount: null` onto the order and into the customer's refund email ([#534](https://github.com/Omega-JS-Stack/omega/issues/534)). Amount comes off `transaction.amount` (cents, like the credit note's `total`); `reason` stays null, because a transaction carries no `reason_code` |
| **Coinbase Commerce** | **Nothing** — there is no refund record to read, so no coinbase event is ever a refund. `getRefundDetails()` is unreachable by construction and answers with no amount rather than throwing, since throwing inside the pipeline would redeliver an event forever |
| **Test** | Stripe's reader over the charge it already has — the fetched resource when the event resolved to the charge, otherwise the event body. Never a real Stripe lookup: there is no Stripe account behind a test-provider event to answer one |

A refund lookup that fails is classified by the same seam as any other ([above](#a-lookup-the-provider-cannot-answer-never-processes-the-payload)): not-found refuses the event (the stamp names the lookup that actually missed — `charge`, `refund`, `credit_note`, `transaction`), unreachable defers it, and a Stripe envelope naming no charge id at all fails permanently before the call is made. An event that names no refund record at all — no refund id, or for Chargebee neither a credit note nor a transaction — records **no amount** rather than the payload's, and says so in the log.

### A refund record has to belong to the event that named it

The lookup key is the payload's, and that is where the [#510](https://github.com/Omega-JS-Stack/omega/issues/510) trust argument stopped one step short: the event's own `resourceId` is SELF-CONSISTENT (whatever it names is what gets fetched and what gets written), while a refund id imports numbers ACROSS records. An attacker holding the webhook key could pair a real sale of their own — which passes the uid check above — with an UNRELATED refund id from the same merchant account, and another customer's amount, currency and reason landed on this order, its email and its refund conversion ([#532](https://github.com/Omega-JS-Stack/omega/issues/532)).

So every refund lookup is linked back. Each provider reads its own back-pointer and hands the pair to `libraries/payment/refund-linkage.js`, where the decision is written once:

| Provider | The event's resource | The record's back-pointer |
|---|---|---|
| **PayPal** | `sale` (v1 one-time refund) | `sale_id` |
| **PayPal** | `capture` (v2 `PAYMENT.CAPTURE.REFUNDED`) | `links[rel=up]` — the URL's last segment is the capture id |
| **PayPal** | `subscription` (a v1 sale refund behind a billing agreement) | none — the refund names the SALE, never the agreement, so there is nothing to compare |
| **Chargebee** | `subscription` | `subscription_id` (credit note or transaction) |
| **Chargebee** | `invoice` | `reference_invoice_id` (credit note), else `linked_invoices[].invoice_id` (transaction — the event's own invoice counts as the link when it is among them) |
| **Stripe** | `subscription` | the charge's `subscription`, else its `metadata.uid` against the subscription's own uid |
| **Stripe** | `charge` | none needed — the charge IS the resource, fetched by the event's `resourceId`, so it is self-consistent |
| **Coinbase Commerce** | any | none — the provider has no refund record to link back from |
| **Test** | any | none — the test provider is its own API and looks nothing up |

| The record's back-pointer | What the pipeline does |
|---|---|
| **Disagrees** | **Refuse and acknowledge.** Nothing is written; the doc completes with `refusal` = `{ reason: 'refund-not-linked', refundType, refundId, resourceType, resourceId, linkedTo }` and a loud `REFUND NOT LINKED` error naming what the record really belongs to. Completed, not failed: no retry can relate two unrelated records |
| **Agrees** | Proceed — the numbers are recorded exactly as before |
| **Absent** | **Proceed, loudly.** A record carrying no back-pointer for this kind of resource (the PayPal subscription row above; a Stripe charge with neither `subscription` nor `metadata.uid`) is UNPROVEN, not wrong — the rule is refuse on mismatch, and absence is not a mismatch. A `REFUND LINK UNPROVEN` warning names the refund that was recorded without being linked back, the same posture the `UID FALLBACK` warning takes (ratified 2026-08-23 on [#532](https://github.com/Omega-JS-Stack/omega/issues/532)) |

### A refund with no purchase behind it is refused, not minted

A refund can only UPDATE a purchase — it can never DEFINE one. When the refund event named an order that did not exist, the merge above could not run and the event was read as a fresh purchase definition instead: `payments-orders/{orderId}` was created with `unified.status: 'completed'` and the REFUND's id as the resource, so a reversal was booked as revenue while the transition trail said `one-time/purchase-refunded`. Reachable whenever the purchase write is missing — a lost or failed purchase webhook, a webhook registered after the sale, or PayPal delivering `PAYMENT.CAPTURE.REFUNDED` before the capture.

So the pipeline **refuses**, and writes nothing to `payments-orders` or `payments-intents`: no transition is detected, no analytics fire, and the webhook doc completes with `transition: null` — the trail agrees with the record. The refusal is stamped on the event's OWN doc, alongside that transition: `payments-webhooks/{eventId}.refusal` = `{ reason: 'refund-without-order', captureId }`, with a loud `REFUND WITHOUT ORDER` error line carrying the money from `getRefundDetails()`. The doc already holds the refund payload as delivered (`raw`), the owner and the order the refund named; what it adds is the id of the capture the refund reversed — read off the payload's HATEOAS `up` link, which PayPal points at the capture and other providers omit (`null`, never a guess). That capture id is the pointer a human reconciles the missing purchase from ([#335](https://github.com/Omega-JS-Stack/omega/issues/335)).

The webhook is **completed**, not failed: the event reached a terminal decision, so it must not burn the retry ladder or dead-letter. The event doc is keyed by the provider's event id, so a redelivery re-decides the same document rather than piling up duplicates — and `refusal` is written on every completion (`null` when nothing was refused), so a reprocess that now finds its order clears the flag instead of leaving a stale one behind.

### A payment never creates a user doc

A user doc is born at **signup**, behind a real Firebase auth user. A payment event can update one and can never mint one, at either seam ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)):

- **The webhook pipeline** looks the uid up in Auth when `users/{uid}` does not exist. With no auth user it refuses: nothing is written — no user doc, no order, no intent — and the event completes with `refusal` = `{ reason: 'user-without-auth' }` plus a loud `USER WITHOUT AUTH` warning naming the uid and the event. Completed, not failed, so the provider stops redelivering an event nothing here will ever act on. A uid whose doc already exists takes no lookup at all: updates and deletes behave exactly as before.
  - The refusal also **reports**, at `warning` level, through the backend's one capture handle (`omega.sentry`, null and therefore a no-op when no DSN is configured; [monitoring.md](../shared/monitoring.md)). It carries the uid, the event id and type, the provider and the reason; no email is assembled, so there is nothing for the PII scrub to take out. The doc stamp is the record a human reconciles from; this is the alarm that tells them to look, since the whole problem is that nobody knows to (Ian, 2026-08-20).
- **The checkout route** verifies BOTH halves before it starts — missing either answers `403` with a warn line, so there is no provider session, no intent doc, and no half-written account.

The seam is real, not theoretical: a QA checkout run locally against the emulator with real test-mode keys has its webhooks delivered to the **deployed** backend (the emulator has no webhook path), and `customer.subscription.created` for an emulator-only uid used to mint a LIVE `users/{uid}` holding nothing but a subscription block. Residue that predates the guards is cleaned up by the users migration, which flags exactly this shape as an orphan.

The opposite direction is healed rather than refused: a real account whose user doc went missing gets it recreated when it next authenticates ([common-operations.md](common-operations.md#a-missing-user-doc-heals-here)), so a genuine customer never arrives at the checkout guard above without a doc.

## 3-Layer Architecture

The payment system is cleanly separated into three independent layers:

| Layer | Purpose | Tests |
|-------|---------|-------|
| **Provider input** (Stripe, PayPal, Chargebee, Coinbase Commerce, Test) | Parse raw webhooks + transform to unified shape | Helper tests per provider (`payment/stripe/to-unified-subscription.js`, `payment/paypal/to-unified-one-time.js`, `payment/coinbase/parse-webhook.js`, etc.) |
| **Unified pipeline** (provider-agnostic) | Transition detection, Firestore writes, analytics | Journey tests (`journey-payments-*.js`) |
| **Transition handlers** (fire-and-forget) | Emails, notifications, side effects | Skipped during tests unless `TEST_EXTENDED_MODE` |

Each provider transforms its raw data into the **same unified shape**. Once data enters the pipeline, the code doesn't know or care which provider it came from. This means:
- Adding a new provider = implement the provider interface (below). The pipeline handles the rest.
- Journey tests use the `test` provider but exercise the full unified pipeline end-to-end.
- Provider-specific tests only need to verify correct transformation to the unified shape.

## Subscription Statuses

| Status | Meaning | User can delete account? |
|--------|---------|--------------------------|
| `active` | Subscription is current and valid (includes trialing) | No (unless `product.id === 'basic'`) |
| `suspended` | Payment failed (Stripe: `past_due`, `unpaid`) | No |
| `cancelled` | Subscription terminated (Stripe: `canceled`, `incomplete`, `incomplete_expired`) | Yes |

`suspended` is the dunning entry state for **both** failure shapes: a renewal that fails on a live subscription, and a FIRST checkout that declines. The two are told apart by the transition, not the status — `payment-failed` for the renewal, `checkout-declined` for the first checkout ([Subscription Transitions](#subscription-transitions)).

### Stripe Status Mapping

| Stripe Status | `subscription.status` | Notes |
|---|---|---|
| `active` | `active` | Normal active subscription |
| `trialing` | `active` | `trial.claimed = true` |
| `past_due` | `suspended` | Payment failed, retrying |
| `unpaid` | `suspended` | Payment failed |
| `canceled` | `cancelled` | Subscription terminated |
| `incomplete` | `cancelled` | Never completed initial payment |
| `incomplete_expired` | `cancelled` | Expired before completion |
| `active` + `cancel_at_period_end` | `active` | `cancellation.pending = true` |

## Unified Subscription Object (`users/{uid}.subscription`)

```javascript
subscription: {
  product: {
    id: 'basic',                   // product ID from config ('basic', 'premium', etc.)
    name: 'Basic',                 // display name from config
  },
  status: 'active',                // 'active' | 'suspended' | 'cancelled'
  expires: { timestamp, timestampUNIX },
  trial: {
    claimed: false,                // has user EVER used a trial
    expires: { timestamp, timestampUNIX },
    outcome: null,                 // 'converted' | 'lapsed' | null — stamped by whichever path sees the trial end, NOT by the unified transform
  },
  cancellation: {
    pending: false,                // true = cancel at period end
    date: { timestamp, timestampUNIX },
  },
  payment: {
    provider: null,               // 'stripe' | 'paypal' | etc.
    orderId: null,                 // @omega.js/backend order ID (e.g., '1234-5678-9012')
    resourceId: null,              // provider subscription ID (e.g., 'sub_xxx')
    frequency: null,               // 'monthly' | 'annually' | 'weekly' | 'daily'
    price: 0,                      // resolved from config (number, e.g., 4.99)
    startDate: { timestamp, timestampUNIX },
    updatedBy: {
      event: { name: null, id: null },
      date: { timestamp, timestampUNIX },
    },
  },
}
```

`trial.claimed` says only that a trial **happened** — a converted trial and a lapsed one carry identical dates — so `trial.outcome` is the one stored conversion signal. It is additive: the provider libraries never produce it (the unified transform's `trial` carries `claimed` + `expires` only, and the user-doc write is a merge), and it is mirrored in the `@omega.js/account` user schema. Whichever path sees the trial end stamps it: the webhook pipeline writes `converted` on the charge it books as the conversion ([Subscription Transitions](#subscription-transitions)), and the trial-lapse sweep stamps whatever the provider confirms when no webhook ever comes ([Payment Cron Jobs](#payment-cron-jobs)).

## Access Check Patterns

```javascript
// Is premium (paid)?
user.subscription.status === 'active' && user.subscription.product.id !== 'basic'

// Is on trial?
user.subscription.trial.claimed && user.subscription.status === 'active'

// Has pending cancellation?
user.subscription.cancellation.pending === true

// Payment failed?
user.subscription.status === 'suspended'
```

## The subscription getters on `User`

A `User` (`@omega.js/account`, the same class on the backend and in the browser) derives the calculated subscription facts as getters, computed on every read. The raw data (`subscription.product.id`, `status`, `trial`, `cancellation`) stays on the document's own fields.

```javascript
export default async ({ ctx, user }) => {
  user.plan;       // 'basic' when cancelled or suspended
  user.active;     // true for an active, trialing or cancelling paid plan
};
```

A route reads the caller as `user`, already a `User`. Framework code that holds a raw account document builds one through `src/omega/helpers/account.js` (`new User(document)`).

| Getter | Type | Description |
|-------|------|-------------|
| `plan` | `string` | Effective plan ID the user has access to RIGHT NOW (`'basic'` if cancelled/suspended) |
| `active` | `boolean` | User has active access (active, trialing, or cancelling) |
| `trialing` | `boolean` | In an active trial (status `'active'` + `trial.claimed` + unexpired `trial.expires`) |
| `cancelling` | `boolean` | Cancellation pending (status `'active'` + `cancellation.pending` + NOT trialing) |
| `everPaid` | `boolean` | The user has ever paid (a payment start date exists) |

The getters never reach `toJSON()`, so a Firestore write or an API response carries the stored document alone. The browser's `omega.auth.user` is the same class, so both sides read the same answer.

**Use the getters instead of manual access checks.** They centralize all the derivation logic in one place:

```javascript
// ✅ PREFERRED: the getter
if (user.active) { /* has access */ }

// ❌ AVOID: manual checks that duplicate logic
if (user.subscription.status === 'active' && user.subscription.product.id !== 'basic') { /* ... */ }
```

## Transition Handlers

When a webhook changes a subscription or processes a one-time payment, @omega.js/backend detects the state transition and dispatches to a handler file. Handlers are fire-and-forget (non-blocking) — they run after the transition is detected but before or during the Firestore writes. Handler failures never block webhook processing.

Handlers are skipped during tests unless `TEST_EXTENDED_MODE` is set.

### Transition Detection

The `transitions/index.js` module compares the **before** state (current `users/{uid}.subscription`) with the **after** state (new unified subscription) to detect what changed.

**A detected transition is CLAIMED before anything acts on it** ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)): a transaction writes `payments-orders/{orderId}.transitions.<name>` = `{ eventId, status, timestamp, timestampUNIX }`, and an event that finds the field already there acts on nothing. Detection is a diff, so two webhooks for one checkout in flight together (Stripe's `customer.subscription.created` and `invoice.payment_succeeded`, one second apart) both read `basic` and both detect `new-subscription` — the claim is what makes only one of them act on it. One claim per order per transition NAME, so the order's later transitions still fire.

**A claim carries its outcome, and a `failed` one is retakeable.** `status` is `claimed` while the run holds it, `done` once that run got through all three effects below, and `failed` beside the webhook doc's own failure stamp. A winner can throw AFTER claiming — the batch that writes the subscription, the order and the intent comes after the dispatch — and the frequent cron then re-runs that same event id ([below](#payments-webhooks-retry-state)). Against a claim with no outcome on it, the retry was refused by its own claim forever: no order email, no analytics, no marketing sync, and no subscription, for a customer who paid. `failed` is the one reclaimable state here for the same reason it is the one reclaimable state on the webhook doc and on a dispute alert; a `claimed` or `done` record refuses whoever asks, including the event holding it.

**And a claim only speaks for ten minutes** (`CLAIM_WINDOW_MS`, exported by `transitions/index.js`). The race it settles is SECONDS wide and the retry that re-runs a failed event is minutes wide, while the order id is stable for the subscription's whole life — so every transition that can happen twice re-detects a name the order already carries: a second dunning cycle's `payment-failed`, a `cancellation-requested` after an uncancel, a second `plan-changed`. Unbounded, the first claim swallowed all of them for as long as the subscription lasted. A claim older than the window is retaken whatever its status; a fresher one from another event still refuses, which is what makes the concurrent pair above resolve to one.

The claim gates all THREE effects a transition drives, because the live sighting duplicated all three:

| Effect | Suppressed with |
|---|---|
| The handler dispatch (the customer's order email) | `Transition suppressed (claimed by <eventId>)` |
| The analytics fire (`trial_start`, `purchase`) | `Payment analytics suppressed (claimed by <eventId>)` |
| The marketing sync (`email.sync`) | `Marketing sync suppressed (claimed by <eventId>)` |

The analytics fire is dropped WHOLE rather than re-resolved without its transition: `resolvePaymentEvent()` has `!transitionName` branches, so a nulled transition would make the duplicate resolve as a RENEWAL and fire `subscription_payment` — worse than firing nothing. A run with no transition detected at all is untouched by any of this; a renewal still tracks and still syncs.

### Subscription Transitions

| Transition | Before → After | File | Email event |
|---|---|---|---|
| `payment-refunded` | detected from the event type, not the state diff | `transitions/subscription/payment-refunded.js` | `refunded` |
| `new-subscription` | basic/null → active paid | `transitions/subscription/new-subscription.js` | `confirmation` |
| `subscription-winback` | cancelled paid → active paid | `transitions/subscription/subscription-winback.js` | `confirmation` (delegates to `new-subscription.js`) |
| `checkout-declined` | basic/null → suspended | `transitions/subscription/checkout-declined.js` | none — log only |
| `checkout-declined` | cancelled paid → suspended (a win-back that declines) | `transitions/subscription/checkout-declined.js` | none — log only |
| `payment-failed` | active → suspended | `transitions/subscription/payment-failed.js` | `payment-failed` |
| `payment-recovered` | suspended → active | `transitions/subscription/payment-recovered.js` | `payment-recovered` |
| `cancellation-requested` | pending=false → pending=true | `transitions/subscription/cancellation-requested.js` | `cancellation-requested` |
| `cancellation-removed` | pending=true → pending=false, same product, still active | `transitions/subscription/cancellation-removed.js` | none — log only |
| `subscription-cancelled` | non-cancelled → cancelled | `transitions/subscription/subscription-cancelled.js` | `cancelled` |
| `plan-changed` | active product A → active product B | `transitions/subscription/plan-changed.js` | `plan-changed` |

**Order is behavior.** `payment-refunded` is checked first, from the event type alone (a refund may not move the subscription's state at all). The rest are an ordered ladder — most specific first — and the table lists them in that order (`checkout-declined` is reached by two rules, hence two rows). Two placements carry the weight:

- `subscription-winback` and both `checkout-declined` rules sit **ahead of** `payment-failed`. Users are born active on `basic`, and a full cancellation leaves the paid product id in place, so without them a returning subscriber matched nothing (no confirmation email, and analytics read the checkout as a renewal) and a declined FIRST checkout read as active → suspended and sent renewal-dunning copy to someone who never had access to lose. The cancelled-paid → suspended rule closes the last branch of that pair: a win-back whose payment declines used to match no rule at all, so the webhook completed with no transition, no log and no analytics ([#223](https://github.com/Omega-JS-Stack/omega/issues/223)).
- `cancellation-removed` sits **behind** `payment-recovered` and requires the same product, so a recovery or a plan change that also clears the schedule keeps its own, more meaningful, name.

Two transitions are deliberately log-only:

- `checkout-declined` — the user is standing at the checkout watching the decline. No email, and no analytics either: no money moved.
- `cancellation-removed` — the `order` template has no copy for a withdrawn cancellation, and an unknown event falls back to the `confirmation` variant, which would show a subscriber a "total paid today" they were never charged. Sending the wrong email is worse than sending none, so the HANDLER stays a record until the template carries the copy. Analytics is a separate concern and does fire: a withdrawn cancellation is a retention win ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).

**`subscription-cancelled` inside the trial term is a lapse, not churn** ([#414](https://github.com/Omega-JS-Stack/omega/issues/414)). The transition and its email are unchanged (the subscription did cancel), but analytics books `trial_lapse`, because a customer who never paid cannot be lost revenue. It reaches that branch on every provider: Chargebee ends a trial with no card on file by cancelling it, and a Stripe or PayPal subscriber may simply quit mid-trial. The check reads the unified term the way the `payment-failed` lapse does, never a provider name. What stops the sweep telling the same story again is that a cancelled subscription drops out of its `status == active` candidate query; the subscription-keyed event id both paths derive only collapses a race on Meta and TikTok — GA4 deduplicates ecommerce on `transaction_id`, and `trial_lapse` is a custom event it never dedupes at all ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).

**A trial that already lapsed is not booked twice.** The provider suspends the subscription at the failed charge, which is where the lapse is reported, then exhausts dunning and cancels what it was holding. That second webhook books **nothing**: its prior state is a suspension whose term never moved past the trial's end, so the outcome it carries was told already, and booking it added paid-churn revenue plus a Meta/TikTok audience signal behind a customer who never paid. A subscriber who converted and lapsed on dunning months later is untouched by the rule, because their term did move.

**The cancelled payload's own evidence overrules the record on file.** The prior state is a stored delivery like any other, so a degraded one carries no term and reads as a long-past trial; a cancellation whose payload names a term reaching past the trial's end is a subscriber who paid, whatever the record lost. Neither the lapse nor the silence above applies then. Both rules read `before` from the user doc, so a cancellation with no prior subscription at all books plain churn.

Which leaves `subscription_cancel` for the cancellations a trial does not explain: a subscriber who left their trial behind, and one who never had a trial at all. It is no longer where a never-paid trialist lands.

**A conversion does not depend on which webhook arrives first** ([#697](https://github.com/Omega-JS-Stack/omega/issues/697)). The first real charge after a trial has no transition at all — it is a payment event, exactly like a renewal — and what tells the two apart used to be the stored doc's in-trial-ness at charge time. That is not a signal: Stripe delivered `customer.subscription.updated` (trial over, term pushed out) a full hour before `invoice.payment_succeeded`, so the doc had already left the trial by charge time and the conversion booked as month two. The two webhooks race in real time, so an arbitrary share of conversions mislabeled — revenue stayed right (both ride the same charge-keyed purchase), the funnel's most valuable step did not. So the label reads two DURABLE facts instead, and both read the same whichever webhook lands first: the subscription ever claimed a trial (`trial.claimed`, true for its whole life), and its trial has no `trial.outcome` on record yet. The charge that converts stamps `converted` in the same batch that writes the subscription, which is what makes the next charge an ordinary renewal — state, not reporting, so it is written whether or not the analytics fire ran, and `isTrialConversion()` is the one predicate the label and the write both read. Its limit: a subscription that converted before the stamp existed carries none, so its next renewal books one conversion.

`subscription-winback` sends the customer the same order confirmation a first subscription does — same template, same computed totals — by calling `new-subscription.js` rather than keeping a second copy of it. Analytics fires a **purchase** (`reason: 'winback-purchase'`, non-recurring, at what the customer actually paid) instead of the renewal the payment event would otherwise have been read as.

All email-sending transition handlers send via `template: 'order'` + `data.order.event: '<event>'`. The single `order.js` template handles all 9 event types — no per-event template files. See [docs/backend/email-system.md](email-system.md) for the full template system reference.

Note: Trials are NOT a separate transition. The `new-subscription` handler checks `after.trial.claimed` to determine if the subscription started with a trial.

### One-Time Transitions

| Transition | Event Type | File | Email event |
|---|---|---|---|
| `purchase-refunded` | `charge.refunded` (Stripe), `PAYMENT.SALE.REFUNDED` (PayPal), `payment_refunded` (Chargebee) | `transitions/one-time/purchase-refunded.js` | `refunded` |
| `purchase-completed` | `checkout.session.completed`, `CHECKOUT.ORDER.APPROVED`, `payment_succeeded` (Chargebee), `charge:confirmed` (Coinbase) | `transitions/one-time/purchase-completed.js` | `confirmation` |
| `purchase-failed` | `invoice.payment_failed`, `payment_failed` (Chargebee) | `transitions/one-time/purchase-failed.js` | `payment-failed` |

**Every one-time transition mails, through its subscription twin's generator** ([#673](https://github.com/Omega-JS-Stack/omega/issues/673)). `purchase-refunded` and `purchase-failed` were log-only stubs, so a customer refunded on a one-time purchase heard about it from their bank statement; both now send the same `order` template + event the subscription side sends (`subscription/payment-refunded.js`, `subscription/payment-failed.js`), and `purchase-refunded` keeps its structured amount/currency/reason log line as the operator's record.

**Two Coinbase events map to NO transition on purpose** ([#642](https://github.com/Omega-JS-Stack/omega/issues/642)). `charge:pending` and `charge:failed` are both parsed and both write their order — so the account page's Orders list tells the truth about a crypto purchase at every stage — but neither mails. `charge:pending` is crypto detected on-chain and not yet confirmed, so there is nothing settled to book; `charge:failed` is a hosted charge that expired unpaid, which is the ABANDONED-CHECKOUT population (the buyer walked away from the page in front of them), exactly the population `checkout-declined` refuses to mail. An abandoned Stripe session sends nothing either, because Stripe emits no event for it at all.

`purchase-failed` mails where the subscription side's first-checkout twin (`checkout-declined`) deliberately does not, because the populations are opposites. It is reached by an `invoice.payment_failed` whose `billing_reason` no subscription owns — a **manual invoice** (`routes/payments/webhook/providers/stripe.js` routes it to `one-time`; Chargebee's `payment_failed` with no subscription lands in the same category, though `detectOneTimeTransition()` only maps Stripe's event name today). Nobody is standing at a checkout watching a manual invoice fail, so the failure reaches the customer only if this handler tells them.

**Idempotency:** EVERY transition on this side is detected from the event type alone, so the `previouslyCompleted` guard covers the whole one-time side — a webhook doc that already completed once (a redelivery, or a doc put back to `pending`) detects nothing, and the customer is not emailed twice about the same purchase or refund. The subscription side applies the same guard to its one event-type-only path, `payment-refunded`.

### Handler Interface

All handlers are in `src/omega/events/firestore/payments-webhooks/transitions/` and are ES modules whose default export is a single async function (the dispatcher loads them through the one handler loader, which refuses a CommonJS file by name):

```javascript
export default async function ({ ctx, before, after, order, uid, userDoc, refundDetails }) {
  // ctx: the webhook event's Context (ctx.omega is the instance)
  // before: previous subscription state (null for new/one-time)
  // after: new unified state (subscription or one-time)
  // order: the order document
  // userDoc: full user document data
  // refundDetails: the refund's details, on a refund
};
```

### Creating a New Transition Handler

1. Add detection logic in `transitions/index.js` (in priority order)
2. Create handler file in `transitions/{category}/{name}.js`
3. Handler receives full context: use `ctx.log()` for logging, `omega.getApiUrl()` for API calls

## Subscription Management Routes

Owned, cross-provider endpoints for managing a live subscription. They write **no subscription state** — they delegate to the provider and let the resulting webhook drive the pipeline.

### POST /payments/cancel

Ends the caller's subscription: at the close of the current billing period normally, **immediately when the subscription is still in its free trial** (Ian's ruling, 2026-08-15 — we do not keep serving a trial we know will not convert). Input: `reason`, `feedback`, `confirmed`, and the privileged `skipGuards`.

Guards: authenticated, `confirmed: true`, an active or suspended paid subscription, no cancellation already pending, a known provider and resource id, and the **24-hour young-subscription guard**. `skipGuards` is honored only for an admin or outside a real deployment (the suites and the dev palette cancel seeded subscriptions minutes old); every other caller is ignored, loudly.

**A trial is exempt from the 24-hour guard.** That guard exists to stop a cancellation racing a PAID checkout that is still settling, and a trial has no payment to settle — blocking it told the most common trial behavior there is, cancelling the same day you started, that the subscription "is still being set up" ([#267](https://github.com/Omega-JS-Stack/omega/issues/267)).

**"Still inside the trial" has ONE definition**, `routes/payments/cancel/_is-trialing.js` — the trial is claimed, the subscription is `active`, and `expires` still equals `trial.expires` (conversion moves `expires` out to the end of the first paid period while `trial.expires` stays put, so the two stop matching the moment real money is involved; an expiry missing on both sides reads false, because a guard must never be waived by absent data). The route and all four cancel providers consult that one function, which is what keeps the guard waiver and the cancel mode from disagreeing — they were three per-provider copies of the same comparison before.

**Analytics consults it too, with one documented widening** (`events/firestore/payments-webhooks/analytics.js` `isInsideTrial()`, which the trial-lapse sweep also reads). Chargebee's in-trial payload names no `current_term_end` at all, so `expires` folds to the epoch and the timestamp match cannot see a Chargebee trial — every Chargebee conversion read as a renewal and every Chargebee lapse reported nothing ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)). An epoch expiry is the ABSENCE of a term, not a term that ended in 1970, so for REPORTING a claimed trial with a real trial expiry and no term at all still counts. That widening stays out of `_is-trialing.js` deliberately: the shared predicate also waives the 24-hour guard, and a guard must never be waived by missing data. Reporting carries no such stake.

**The widening is bounded by the state the payload arrived FROM** ([#414](https://github.com/Omega-JS-Stack/omega/issues/414)). A degraded delivery carried no term either: the pipeline used to hand over the webhook's own body when the provider API was unreachable, and an active PAID subscription in that body is shaped exactly like a Chargebee trial — same claimed trial, same epoch expiry. Nothing inside such a payload separates them, so the prior state does. That degraded path no longer exists at all — a lookup the provider cannot answer now refuses or defers rather than processing the body ([above](#a-lookup-the-provider-cannot-answer-never-processes-the-payload)) — and the bound stays as the guard for any other object that reaches the transformers without a term. A subscription already paid through a real term did not lose that term by trialing, so a term missing there is a hole in the delivery and the widening does not apply. Unbounded, a renewal on that path matched no branch at all and booked nothing: real revenue, silently unreported. The bound needs one healthy delivery behind it, which is its limit: two degraded deliveries in a row leave no term on either side, so that renewal still books nothing. It fails toward silence, never toward a fabricated number.

The sweep passes no prior state and keeps the unbounded widening. Two other things bound it there: its candidate query only reaches trials whose `trial.expires` sits between 30 days and 24 hours ago, and `trial.outcome` is stamped once and never revisited, so a degraded record can be misread at most once and only inside that window.

How each provider performs the immediate half:

| Provider | Trial cancel | Paid cancel |
|---|---|---|
| **Stripe** | `subscriptions.cancel()` — the subscription ends now | `subscriptions.update({ cancel_at_period_end: true })` |
| **Chargebee** | `cancel_for_items` with `cancel_option: 'immediately'` | the same call with `end_of_term` |
| **PayPal** | the one cancel endpoint, with a trial `reason` — immediacy is enforced on OUR side (below) | the same endpoint; the remaining paid term rides as `cancellation.pending` |
| **test** | fabricates `customer.subscription.deleted` | fabricates `customer.subscription.updated` with `cancel_at_period_end` |

**PayPal has no second cancel mode**, so the immediacy lives in the unified transform: `calculatePeriodEnd()` returns null for a subscription still inside its trial WINDOW (the trial end computed from `start_time` + the plan's `TRIAL` cycle is still ahead), so the cancellation webhook resolves it to `cancelled` with nothing pending and no future expiry. Reading the payment record instead handed a cancelled trialer a full paid period whenever the plan charged a setup fee on day zero — `billing_info.last_payment` exists during a trial, and it is not a billing period.

### POST /payments/uncancel

Withdraws a scheduled cancellation, so the subscription renews as normal instead of ending at the close of the current billing period. Input: `confirmed`.

Guards: authenticated, `confirmed: true`, an ACTIVE paid subscription whose `cancellation.pending === true`, and a known provider.

Delegates to the provider — Stripe clears `cancel_at_period_end`, Chargebee calls `remove_scheduled_cancellation` — and the webhook that follows fires the `cancellation-removed` transition. The only thing the route writes is the withdrawal of the request itself: `payments-orders/{orderId}.requests.cancellation` is cleared, because leaving the reason/feedback behind would misreport the order's state.

**PayPal is not supported.** PayPal cannot resume a cancelled subscription — its only reactivation verb (`/v1/billing/subscriptions/{id}/activate`) works on a SUSPENDED subscription, and a cancelled one is terminal. PayPal also has no cancel-at-period-end: our cancel route cancels the PayPal subscription outright and the pipeline represents the remaining paid term as `cancellation.pending`, so a PayPal subscriber reading "pending cancellation" is already cancelled at PayPal.

### POST /payments/plan

Moves a live subscription to another product and/or billing frequency without cancel-and-resubscribe. Input: `productId`, `frequency`, `confirmed`.

Guards: authenticated, `confirmed: true`, an active paid subscription with no cancellation scheduled, and a target that is a subscription product the brand sells at that frequency and is not the plan the caller is already on.

Two of those refusals carry a **machine-readable code** on the `omega-properties` header's `additional.code`, the same shape the [capability gate](#capability-gating) ships under — the client branches on the code, never on the sentence:

| Code | When | Why it is a refusal |
|---|---|---|
| `already-on-plan` | Same product AND same frequency — **or** the same product when `payment.frequency` is unrecorded | A no-op costs a real provider call and a real webhook. Same product at a DIFFERENT *recorded* frequency is a real switch and stays allowed; with nothing recorded to compare, `'monthly' === undefined` is false and the no-op would sail through, so every cadence of the current product is refused until the backend records one. |
| `cancellation-pending` | `cancellation.pending === true` | The providers swap the PRICE, never the schedule — a switch here would land the caller on a new plan still set to end at period end, silently. Undo the cancellation first. |

**The guards never lean on the client's filtering.** The billing page hides Change while a cancellation is pending and renders the current plan disabled, but that is courtesy: the modal's own filter silently missed whenever `payment.frequency` was unrecorded, which is how a same-plan switch reached the provider in the first place ([#237](https://github.com/Omega-JS-Stack/omega/issues/237)).

**A switch never grants, resets, or extends a trial** (Ian 2026-08-14). A mid-trial switch CARRIES the trial over — same original end date, new plan — and `trial.claimed` stays claimed. The route writes no state, so each provider's `switchPlan()` preserves it through the swap — and each one restates the date from the **live provider object**, never from our own user doc, which can lag the provider and would make the preserving route the thing that MOVED the trial: Stripe restates `trial_end` off the subscription it already retrieved to find the item, and Chargebee GETs `/subscriptions/{id}` and restates that object's `trial_end` when its status is `in_trial`. A trial already over is left alone in both (Stripe rejects a past `trial_end`, and its dates stay on the object anyway). The test provider carries `trial_start`/`trial_end` onto the event it fabricates — and, while the trial is live, sets the current period TO the trial period, the way Stripe reports a trialing subscription: the cancel flow's shared classifier ([`_is-trialing.js`](#post-paymentscancel), read by the route and every provider) decides a cancellation is immediate on that `trial.expires === expires` equality, so a fabricated 30-day period would have broken trial-cancel immediacy after a switch. Fabricating the trial dates as null is exactly what ended a live trial on switch: the unified transform reads `trial.claimed` straight off the event. PayPal's `revise` takes no trial parameter — its trial is derived from the plan's `TRIAL` billing cycle anchored to the original `start_time`, so a revise cannot extend a trial past what it would have been from day one, but an unequal trial LENGTH on the target plan can still shift the end date.

| Provider | How it switches |
|---|---|
| **Stripe** | Updates the existing subscription ITEM with the new price, `proration_behavior: 'create_prorations'` (the item's id must be sent or Stripe adds a second item instead of replacing the first) |
| **Chargebee** | `update_for_items` with the deterministic `{itemId}-{frequency}` item price the checkout builds |
| **PayPal** | `revise` — PayPal's first-class plan change, prorated by its own rules |

The webhook that follows fires the existing `plan-changed` transition.

### POST /payments/winback

Applies the cancel-flow **save offer** to a live subscription, so the cancel the customer started never happens ([#268](https://github.com/Omega-JS-Stack/omega/issues/268)). The billing card pitches it before the cancellation questionnaire; accepting calls this route, declining opens the questionnaire unchanged. Input: `confirmed`.

The offer is the **brand's**, not this route's: `payment.winback` in omega.json5, resolved by `@omega.js/config`'s `resolveWinbackOffer()` — 50% off the next cycle when a brand configures nothing, `enabled: false` to turn it off entirely ([docs/shared/config.md](../shared/config.md#the-cancel-flow-save-offer-paymentwinback--268)). The web build resolves the same section through the same function into its client blob, so the dialog and the coupon can never name different numbers.

Guards: authenticated, `confirmed: true`, the offer enabled for this brand, an ACTIVE paid subscription that is **not** inside its free trial (`_is-trialing.js` — a trial cancel is immediate and nothing has been paid, so there is no next cycle to discount) and has no cancellation scheduled, a known provider, and **an order doc carrying no claim yet**.

The offer reaches the provider as a discount-codes `validate()` result (`libraries/payment/winback.js`), so the coupon plumbing is the checkout's: Stripe's `StripeLib.resolveCoupon()` builds the same deterministic, reused coupon a discount code does, and `subscriptions.update({ discounts: [...] })` attaches it. Stripe's `discounts` parameter **replaces** every discount already on the subscription rather than adding to them, so an existing coupon is dropped when the offer's lands. The subscription itself is untouched — same plan, same cadence, same renewal date — and the route writes no subscription state.

**Claimed once.** `payments-orders/{orderId}.requests.winback` records the discount and when it was taken, and a second call is refused against that same document — an offer takeable every time the cancel dialog opens is a permanent discount nobody agreed to. That refusal carries `offer-already-claimed` on `omega-properties` (`additional.code`), because the client reads the ACCOUNT and the claim lives on the order doc, so a past claimant is pitched the offer again and the billing card needs a code to retire it on ([#310](https://github.com/Omega-JS-Stack/omega/issues/310)). A subscription carrying no `payment.orderId` has nowhere to record the claim, so it is refused before dispatch with `offer-not-claimable` on `omega-properties` (`additional.code`) instead of being handed an offer this route cannot remember. The accept is also recorded server-side (`ctx.analytics.event('payments/winback', …)`), which is what the experiment is measured with against the existing `subscription-winback` transition baseline; the client counts offer-shown and offer-declined, which never reach a server.

**Every refusal is named.** Each 400 this route returns carries a machine-readable code on `omega-properties` (`additional.code`), in refusal order: `confirmation-required`, `offer-disabled`, `no-active-subscription`, `trial-not-eligible`, `cancellation-pending`, `missing-payment-details`, `unknown-provider`, `not-supported-by-provider`, `offer-not-claimable`, `offer-already-claimed` ([#311](https://github.com/Omega-JS-Stack/omega/issues/311)). The client pitches the offer off the ACCOUNT alone, so a state it cannot see reaches accept — and a refusal it cannot name leaves the customer in a dialog arming a retry that can never succeed. All but `confirmation-required` are dead ends for that account (the billing card's `deadEndCodes`): it retires the offer and opens the questionnaire on them, while an unconfirmed request — which the same button sending it again fixes — leaves the offer armed. The card also gates the PITCH on `subscription.payment.provider` and `payment.resourceId`, so an admin-granted or imported subscription with no provider details is never offered a discount the route could only refuse.

**Only Stripe and the test provider apply it.** PayPal has no coupon or discount object at all, and Chargebee has coupons but no existing plumbing that reaches a LIVE subscription with one (`update_for_items` REPLACES the subscription's items, so carrying a coupon through it would mean restating the live item set on every offer — a re-pricing risk taken for a discount). Both declare that by exporting nothing, and the billing card retires the offer for the session and opens the questionnaire on the refusal, so a subscriber on either can always still cancel.

### Capability gating

All three routes are capability-gated the same way: **a provider module that supports the operation exports it; one that cannot lacks the export.** PayPal's `uncancel/providers/paypal.js` and both `winback/providers/{paypal,chargebee}.js` are deliberately empty for exactly this reason (the file still has to exist, or the route would answer "Unknown provider" — a different and wrong statement).

The route checks the export and refuses **before dispatch**, so the caller never discovers the limit as a provider error:

- HTTP **400**, with a sentence pointing at the billing portal
- `not-supported-by-provider` on the response's `omega-properties` header under `additional.code` — @omega.js/client surfaces it as `error.properties.additional.code`, so a client branches on the code, not the sentence

The billing portal (`POST /payments/portal`) stays the fallback for anything a provider will not do here.

## Refunds

`POST /payments/refund` has **two subjects, one endpoint** — which one is decided by whether `orderId` is present. Both store the reason/feedback on `payments-orders/{orderId}.requests.refund` in one shape, and both let the resulting webhook drive the pipeline.

| Input | Subject | Guards |
|---|---|---|
| No `orderId` | The caller's **subscription** — refunds the latest payment and cancels immediately | Authenticated, `confirmed`, a paid subscription, already cancelled or pending cancellation, inside the 6-month window |
| With `orderId` | A **one-time purchase**, named by its `payments-orders` doc | Authenticated, `confirmed`, the order is the caller's own, `type: 'one-time'`, not already refunded, inside the 6-month window |

Notes on the one-time branch:

- A one-time purchase writes nothing to `users/{uid}.subscription`, so the order IS the subject — there is no subscription state to check and nothing to cancel.
- A missing order and somebody else's order answer **identically** ("Order not found"): an order id must never be a probe for whether another user's purchase exists.
- "Already refunded" covers both paths — `requests.refund` (the in-app path) and `unified.status === 'refunded'` (a refund issued from the provider dashboard, which arrives by webhook and writes no request).
- One-time refunds are always **FULL**. Stripe, PayPal, Chargebee and the test provider implement `processOneTimeRefund` ([Provider Interface](#provider-interface)).
- **A purchase on a provider with no refund API is refused before any provider is loaded** ([#642](https://github.com/Omega-JS-Stack/omega/issues/642), [#849](https://github.com/Omega-JS-Stack/omega/issues/849)). Coinbase Commerce is the one today: returning coins is a manual transfer the merchant makes from its dashboard, at whatever the coin is worth that day, and nothing about it is ever attached to the charge. Its registry row says `refundable: false`, so `refund-policy.js` answers `provider-cannot-refund` ("Coinbase Commerce purchases cannot be refunded automatically…") in the SAME predicate the account page reads, and the Orders list never offers a button the route would 400. `refund/providers/coinbase.js` still exists and still throws from both halves: a missing file makes the route say "Unknown provider", a different and wrong statement ([Capability gating](#capability-gating)).

The refund window is 6 months on both subjects, measured from the subscription's `payment.startDate` or the order's created timestamp; an absent date cannot disqualify a refund.

**The one-time lane is reachable from the account page** ([#672](https://github.com/Omega-JS-Stack/omega/issues/672)). `GET /user/orders` is the read path — `payments-orders` is admin-only to clients and a one-time purchase writes nothing to `users/{uid}`, so the route reads the caller's own orders through the admin SDK and the Firestore rules stay untouched. It hands back a SUMMARY per order (what was bought, when, for how much, its status), never the provider's raw resource, the request context or the attribution. Each summary carries `refundable`, and that answer is `libraries/payment/refund-policy.js`'s `oneTimeRefundRefusal()` — the same predicate the guards above run — so a refund button the account page offers is a refund this route accepts. The account page's Orders section lists them and its Refund section posts the picked `orderId`.

What the pipeline then does with the refund webhook is in [A refund merges into the purchase](#a-refund-merges-into-the-purchase).

## Provider capabilities

What each provider CAN do has one home: one capability descriptor per provider, exported by `libraries/payment/providers/index.js` (`PAYMENT_PROVIDERS`, and `paymentProvider(id)`, which answers `null` for an id no row has, the same two names @omega.js/config exports) ([#849](https://github.com/Omega-JS-Stack/omega/issues/849)). Every backend decision about a provider reads its row, never its name, and the checkout page reads the SAME rows, so a button the page offers is a checkout the backend accepts. The rows are authored in `@omega.js/config`, because that is the one package both surfaces reach: the backend registry re-exports them under the same names, and `clientConfig()` bakes them into the browser config as `payment.capabilities` ([docs/web/index.md](../web/index.md)).

| Provider | `acceptsZeroCharge` | `refundable` | `couponsHostedByProvider` | `subscriptions` | `oneTime` | `trials` |
|---|---|---|---|---|---|---|
| **Stripe** (`stripe`) | yes, a 100% coupon on its own page | yes | yes | yes | yes | yes |
| **Chargebee** (`chargebee`) | yes, a 100% coupon on its own page | yes | yes | yes | yes | yes |
| **PayPal** (`paypal`) | no | yes | no, the price is computed here | yes | yes | yes |
| **Coinbase Commerce** (`coinbase`) | no | no | no, the price is computed here | no | yes | no |
| **Test** (`test`) | yes | yes | yes | yes | yes | yes |

Each descriptor is `{ id, name, acceptsZeroCharge, refundable, couponsHostedByProvider, subscriptions, oneTime, trials }`; `name` is the word a refusal speaks. What reads each capability:

| Capability | The decision |
|---|---|
| `acceptsZeroCharge` | `chargeableAmount()` in `libraries/payment/discount-codes.js`, which a provider computing its own price calls with its id: a row that refuses $0 refuses a code covering the whole price, coded 400 ([Discounts and the first charge](#discounts-and-the-first-charge)). The checkout hides that provider's button on a fully discounted total |
| `refundable` | `oneTimeRefundRefusal()` in `libraries/payment/refund-policy.js` answers `provider-cannot-refund`, naming the provider, so the refund route and the account page's Orders list agree ([Refunds](#refunds)) |
| `subscriptions`, `oneTime` | The intent route's provider gate refuses a product type the provider does not sell, 400, before an order id is minted or a provider module runs; the checkout offers the button only for the types the row sells |
| `trials` | The intent route sells a plan without its trial on a provider with none, the same silent downgrade an ineligible buyer gets |
| `couponsHostedByProvider` | Documents which providers take a coupon object on their own page and which are sent a price this framework computes (`applyToAmount()`); every provider's intent module is written to its row |

An id with no row is an unknown provider: the intent route answers "Unknown provider" (its module load after that gate is bare, since every row has a module and a load that throws is a framework bug), `chargeableAmount()` throws (a caller passing a display name is a bug), and the refund policy leaves it to the route's own "Unknown provider". `test/helpers/payment/provider-registry.test.js` pins the parity: every file in `libraries/payment/providers/` and in the intent, webhook and refund provider folders has a row and every row a file, the subscription-only route folders (cancel, plan, portal, uncancel, winback) hold exactly the rows that sell subscriptions, and each refusal set equals the rows that say "cannot".

## Provider Interface

**Which key a provider initializes with is the env chain's answer, and only the brand's overlay keeps a live key out of a local run.** Every provider reads its secret through the ONE env reader under the SAME name in every environment, and nothing inspects the value ([#586](https://github.com/Omega-JS-Stack/omega/issues/586)). The whole contract, and why the `.env.development` overlay is the brand's own opt-in, is one paragraph: [docs/backend/index.md](index.md#the-env-reader-librariesenvjs--581).

A deploy without an OMEGA license runs no live payments: `libraries/payment/license.js` refuses Stripe/PayPal/Chargebee `init()` when the deploy stamped `OMEGA_LICENSE_STATUS=keyless` into the artifact's `.env`. The `test` provider is never gated, and an absent status — every local lane, the emulator, every test — behaves exactly as it always has. The check itself is a deploy-time question the CLI asks; nothing here phones home. Contract: [docs/shared/publishing.md](../shared/publishing.md#the-license-check-320).

Each provider implements three modules:

A provider implements as much of this as its API HAS. Coinbase Commerce sells one-time charges and nothing else, so it ships an intent, a webhook, a refund refusal and a library, and no cancel/portal/plan/uncancel/winback module at all — every one of those routes acts on a subscription it can never have ([Coinbase Commerce (crypto) is one-time only](#coinbase-commerce-crypto-is-one-time-only)).

**Intent provider** (`routes/payments/intent/providers/{provider}.js`):

```javascript
module.exports = {
  async createIntent({ uid, orderId, product, productId, frequency, trial, discount, confirmationUrl, cancelUrl, ctx }) {
    return { id, url, raw };
  },
};
```

**Webhook provider** (`routes/payments/webhook/providers/{provider}.js`):

```javascript
module.exports = {
  isSupported(eventType) { return boolean; },
  parseWebhook(req) { return { eventId, eventType, category, resourceType, resourceId, refundId, raw, uid }; },
};
```

**Cancel provider** (`routes/payments/cancel/providers/{provider}.js`):

```javascript
module.exports = {
  async cancelAtPeriodEnd({ resourceId, uid, subscription, ctx }) { /* cancel at end of period */ },
};
```

**Refund provider** (`routes/payments/refund/providers/{provider}.js`):

```javascript
module.exports = {
  async processRefund({ resourceId, uid, subscription, ctx }) {
    return { amount, currency, full };
  },
  // The ONE-TIME half. All four providers implement it, and a one-time refund is
  // always FULL: Stripe refunds the session's payment_intent, PayPal refunds the
  // completed capture, Chargebee refunds the invoice, test fabricates the webhook.
  async processOneTimeRefund({ resourceId, uid, order, ctx }) {
    return { amount, currency, full };
  },
};
```

**Uncancel provider** (`routes/payments/uncancel/providers/{provider}.js`) — optional; a missing export IS the capability declaration ([Capability gating](#capability-gating)):

```javascript
module.exports = {
  async uncancel({ resourceId, uid, subscription, ctx }) { /* clear the scheduled cancellation */ },
};
```

**Plan provider** (`routes/payments/plan/providers/{provider}.js`) — optional, same gate:

```javascript
module.exports = {
  async switchPlan({ resourceId, uid, subscription, product, productType, frequency, ctx }) { /* move the subscription */ },
};
```

**Winback provider** (`routes/payments/winback/providers/{provider}.js`) — optional, same gate; `discount` is a discount-codes `validate()` result built from the brand's `payment.winback`:

```javascript
module.exports = {
  async applyOffer({ resourceId, uid, subscription, discount, ctx }) { /* discount the next cycle */ },
};
```

**Portal provider** (`routes/payments/portal/providers/{provider}.js`):

```javascript
module.exports = {
  async createPortalSession({ resourceId, uid, returnUrl, ctx }) {
    return { url };
  },
};
```

**Shared library** (`libraries/payment/providers/{provider}.js`):

```javascript
module.exports = {
  init() { /* return SDK instance */ },
  async fetchResource(resourceType, resourceId, context) { /* return the provider's answer, or throw */ },
  extractResource(raw) { /* return the resource this provider's webhook envelope carries */ },
  getOrderId(resource) { /* return orderId string or null */ },
  getUid(resource) { /* return the uid the provider's record carries, or null */ },
  async getRefundDetails(resource, options) { /* { raw, refundId, eventType, resourceType, ctx } → { amount, currency, reason } from provider data, linked back to `resource` */ },
  toUnifiedSubscription(rawSubscription, options) { /* return unified object */ },
  toUnifiedOneTime(rawResource, options) { /* return unified object */ },
};
```

**`fetchResource()` never falls back.** It returns what the provider answered or throws the classified failure the pipeline branches on ([above](#a-lookup-the-provider-cannot-answer-never-processes-the-payload)) — a provider library that swallows its own lookup failure is the bug [#506](https://github.com/Omega-JS-Stack/omega/issues/506) closed.

**`getRefundDetails()` answers about the resource it was handed.** The `options` bag carries the lookup KEYS the envelope supplies (`raw`, `refundId`) and the `resourceType` that says which back-pointer to read; the record it fetches is asserted against `resource` through `libraries/payment/refund-linkage.js` before its numbers are returned ([above](#a-refund-record-has-to-belong-to-the-event-that-named-it)).

**Every library names its own envelope.** `extractResource(raw)` reads the resource out of the event body, for its IDENTIFIERS — which order a failed event belonged to, and the body the test provider answers its own lookups from. Each provider nests it somewhere else, so reading Stripe's shape for everyone resolved every other provider's to nothing ([#222](https://github.com/Omega-JS-Stack/omega/issues/222)):

| Provider | Envelope |
|---|---|
| **Stripe** | `data.object` |
| **Chargebee** | `content.<type>` — `content.subscription` first, then `content.invoice` (the same precedence its webhook parser categorizes on) |
| **PayPal** | `resource` |
| **Coinbase Commerce** | `event.data` — the delivery envelope wraps an EVENT, and the charge is that event's data |
| **Test** | delegates to Stripe's (it generates Stripe-shaped payloads) |

Stripe's `fetchResource()` also handles `'charge'`, the resource a one-time refund arrives as. It expands the `payment_intent`, because a charge inherits its metadata from the PaymentIntent that created it — when the charge itself carries none, the intent is the only place `uid`/`orderId`/`productId` live. (The checkout sets them there for exactly this reason: `payment_intent_data.metadata`, not the session's.)

## Product Resolution

Products are resolved differently per provider, but always end up matching a product in `config.payment.products`:

| Provider | Resolution chain | Stable ID |
|-----------|-----------------|-----------|
| **Stripe** | `sub.items.data[0].price.product` or `raw.plan.product` → match `product.stripe.productId` or `legacyProductIds` | `prod_xxx` |
| **PayPal** | `sub → plan_id → plan → product_id` → match `product.paypal.productId` | PayPal catalog product ID |
| **Coinbase Commerce** | `charge.metadata.productId` → match `product.id` directly (the charge is created with our own metadata; there is no Coinbase catalog to reconcile against) | our own product id |
| **Test** | Uses `product.stripe.productId` in Stripe-shaped data | Same as Stripe |

Falls back to `{ id: 'basic' }` if no match found.

## Provider-Specific Details

**Stripe:** Uses `metadata.uid` and `metadata.orderId` on subscriptions for UID/order resolution.

**PayPal:** Uses `custom_id` field on subscriptions with format `uid:{uid},orderId:{orderId}`. Product resolution fetches the plan from the subscription, then gets `product_id` from the plan. Plans are scoped by `product_id` query param to avoid cross-brand matches on shared PayPal accounts.

### Coinbase Commerce (crypto) is one-time only

The crypto provider ([#642](https://github.com/Omega-JS-Stack/omega/issues/642)) is the first one that implements a SUBSET of the interface, because the API it wraps has a subset of the concepts. Coinbase Commerce sells a hosted **charge**: one payment, one price, one page. There is no subscription, plan, billing agreement, coupon, portal or refund object anywhere in it.

| Question | Coinbase Commerce's answer |
|---|---|
| **Switch** | `payment.providers.coinbase.enabled` — the ONLY provider whose switch is an explicit `enabled` (default OFF) rather than a public datum, because its whole credential is the secret `COINBASE_COMMERCE_API_KEY` and a secret never lives in config |
| **Auth** | `X-CC-Api-Key` + `X-CC-Version: 2018-03-22` on every call. There is no sandbox HOST — a test-mode key against the same endpoint is the test lane |
| **Intent** | `POST /charges` with `pricing_type: 'fixed_price'`, and the buyer is redirected to the charge's `hosted_url`. A validated discount code comes off HERE (`applyToAmount`), because the price is one we compute and Coinbase has no coupon object to apply it on its own page |
| **Identifiers** | `charge.metadata` — a flat string map carrying `uid`, `orderId`, `productId`. There is no `custom_id` string to pack, the way PayPal needs |
| **Resource** | `charge`, read back at `GET /charges/{id}` (the endpoint takes the id or the short code) |
| **Status** | the LAST entry of `charge.timeline` — a charge has no status field. `COMPLETED`/`RESOLVED` → `completed`, `NEW`/`PENDING` → `pending`, `EXPIRED`/`CANCELED` → `failed`, anything else passes through lowercased |
| **Webhook** | `charge:confirmed`, `charge:pending`, `charge:failed`, all category `one-time`. `charge:created` stays out (it is our own intent call answering, not a payment); `charge:delayed` and `charge:resolved` stay out until the merchant decision they encode is specified |
| **Signature** | **not verified**, like every other provider — the `?key=` check is the one boundary ([Webhook Verification](#webhook-verification)) |
| **Subscriptions** | `toUnifiedSubscription()` THROWS, the intent route's provider gate refuses a subscription product off the registry row (`subscriptions: false`), and the intent provider refuses one too before it calls Coinbase. Fabricating one would grant recurring access off a single crypto payment |
| **Refunds** | unsupported by the provider (`refundable: false`), refused by `refund-policy.js` before dispatch ([Refunds](#refunds)) |
| **Cancel / portal / plan / uncancel / winback** | no module at all: every one of those routes acts on a SUBSCRIPTION, and no coinbase subscription can exist to reach them |

The checkout hides the crypto button on a subscription product off the same row the intent route refuses by ([Provider capabilities](#provider-capabilities)), so the two halves cannot disagree.

**The key is asked for through the shared setup contract**: `COINBASE_COMMERCE_API_KEY`'s `askedWhen` in the env schema (`@omega.js/config`) says the payment service asks for it, and `services/payment/lib/provider-setup.js` offers it. It is the only provider flow with no public field to collect, so its gate leads straight to the secret paste, and its "Disable permanently" lands on `payment.providers.coinbase.enabled` (the ask's own switch) rather than on the provider block. The ask fires only when that switch is explicitly `true`; a brand that never turned crypto on is never asked. Beyond the key, the payment service reconciles nothing for Coinbase: there is no catalog, and its webhook endpoint is registered by hand in the Coinbase dashboard.

**Open product question — the buyer reaches the confirmation page before the coins confirm.** Coinbase redirects to `redirect_url` the moment the payment is submitted, while the charge is still `PENDING`, and a one-time confirmation page opens CONFIRMED without polling ([#668](https://github.com/Omega-JS-Stack/omega/issues/668)). So a crypto buyer sees "confirmed" first and their receipt email arrives when `charge:confirmed` lands, which can be minutes later. Nothing here decides that yet; it is the one-time confirmation contract, and changing it is Ian's call.

### Subscriptionless refunds are one-time

A refund with no subscription behind it is the refund of a **one-time purchase**, and all three webhook parsers now categorize it as `one-time` instead of dropping it (`category = null`, which meant such a refund never entered the pipeline at all):

| Provider | Event | Resource it resolves to |
|---|---|---|
| **Stripe** | `charge.refunded` with no subscription and no invoice | `charge` — the charge itself (`data.object.id`) |
| **PayPal** | `PAYMENT.SALE.REFUNDED` with no billing agreement | `sale` — the sale it reversed (`resource.sale_id` or `resource.id`) |
| **Chargebee** | `payment_refunded` with no subscription in `content` | `invoice` — the invoice it refunded |

PayPal's `fetchResource()` handles `'sale'` the same way, and it is a two-step read: it GETs the v1 sale (`/v1/payments/sale/{id}`) the refund reversed, and a v1 sale carries **no `custom_id`** — so when the sale names a `parent_payment`, that payment is fetched too and its transaction's `custom` (or `custom_id`) is folded onto the sale, which is the only place `uid`/`orderId`/`productId` live. The fold is best-effort, the way the subscription case's plan fetch is: an unreadable parent payment still returns the LIVE sale rather than losing it, since only its identifiers were missed. Before this branch existed, every PayPal one-time refund threw "Unknown resource type" and logged a provider-unreachable error for a fetch that was never attempted ([#224](https://github.com/Omega-JS-Stack/omega/issues/224)).

## Product Configuration

Products are defined in `config/omega.json5` under `payment.products`, and the features they meter in the sibling top-level `features` catalog (both shared top-level sections):

```javascript
// A feature is DEFINED once in the top-level catalog, beside `payment` rather
// than inside it, and a product names only its VALUE
// ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
features: {
  requests: {
    name: 'API requests',
    icon: 'bolt',
    definition: 'Calls to the API you can make per month.',
    usage: { pace: 'daily' },
  },
},

payment: {
  providers: {
    stripe: { publishableKey: 'pk_live_...' },
    paypal: { clientId: 'ARvf...' },
  },
  products: [
    {
      id: 'basic',           // Free tier (no prices, no provider keys)
      name: 'Basic',
      type: 'subscription',
      features: { requests: 100 },
    },
    {
      id: 'premium',         // Paid subscription
      name: 'Premium',
      type: 'subscription',
      features: { requests: 1000 },
      trial: { days: 14 },
      prices: { monthly: 4.99, annually: 49.99 },       // Flat numbers; also supports 'weekly' and 'daily'
      stripe: { productId: 'prod_xxx', legacyProductIds: ['prod_OLD'] },
      paypal: { productId: 'PROD-abc123' },
    },
    {
      id: 'credits-100',     // One-time purchase
      name: '100 Credits',
      type: 'one-time',
      prices: { once: 9.99 },
      stripe: { productId: 'prod_yyy' },
      paypal: { productId: null },
    },
  ],
}
```

Key rules:
- `features` on a product is a MAP of `<catalog id>: value` — the number is the monthly limit (`-1` unlimited), and the name, icon, definition and pacing live once in the top-level `features` catalog. The retired `limits`, the per-product `features` ARRAY and the product-wide `rateLimit` are validation errors naming their replacement ([docs/shared/config.md](../shared/config.md#the-features-catalog-features-and-a-products-values--647))
- `prices` contains **flat numbers only** — no provider-specific IDs
- Provider IDs live at the product level: `stripe: { productId }`, `paypal: { productId }`
- `stripe.productId` is stable — never changes even when prices change
- `stripe.legacyProductIds` maps old pre-migration Stripe products to this product
- Price IDs (Stripe `price_xxx`, PayPal plan IDs) are **resolved at runtime** by matching amount + interval against active prices on the provider's product
- `basic` product has no `prices` and no provider keys — it's the free tier
- `archived: true` stops offering a product to new subscribers while keeping it resolvable for existing ones

## Firestore Collections

| Collection | Key | Purpose |
|---|---|---|
| `payments-intents/{orderId}` | Order ID | Intent metadata (provider, product, status) |
| `payments-webhooks/{eventId}` | Provider event ID | Webhook processing state + transition result + `refusal`, the stamp on an event the pipeline REFUSED to act on ([above](#a-refund-with-no-purchase-behind-it-is-refused-not-minted)). One of five reasons: `resource-not-found`, `uid-mismatch`, `refund-not-linked`, `refund-without-order`, `user-without-auth` |
| `payments-orders/{orderId}` | Order ID | Unified order data (single source of truth for orders) |
| `users/{uid}.subscription` | User UID | Current subscription state (subscriptions only) |

### payments-webhooks retry state

Two fields on the event doc carry the retry ladder:

| Field | Meaning |
|---|---|
| `retryCount` | How many times processing this event has failed. The on-write trigger increments it every time it marks the doc `failed`. |
| `deadLetter` | Terminal latch. `true` means the doc will never be re-flipped — because it burned its retries, or because the trigger stamped it on the FIRST attempt for a [permanent failure](#a-lookup-the-provider-cannot-answer-never-processes-the-payload). |

**A REFUSED event that could not record its own refusal writes nothing else.** If the refusal stamp's own Firestore write throws, the doc is marked `failed` (so the sweep below re-pends it and the next pass re-decides and re-stamps) and the failure path stops there: it does NOT fall back to resolving an orderId out of the payload and marking `payments-intents/{orderId}` failed. That was the one doc a refused forgery could still reach, named entirely by the caller ([#535](https://github.com/Omega-JS-Stack/omega/issues/535)). Failures that are not refusals still close their intent out, exactly as before.

The webhook route answers the provider `200` the moment the event is stored, so a doc the trigger marked `failed` is never delivered again — a transient fault (a provider API blip, a lost Firestore write) would drop the payment silently. The frequent cron `events/cron/frequent/retry-failed-webhooks.js` closes that: it re-flips `failed` docs back to `pending` (which is exactly what the trigger picks up) under a ceiling of **5** attempts, then stamps `deadLetter: true` **once, loudly**, and leaves the doc alone — something permanent is wrong with it and it needs a human, not another pass.

Reprocessing is safe by construction: the trigger's staleness guard and its `previouslyCompleted` guard make a second pass a no-op rather than a second charge or a second email.

**The escape hatch is a redelivery.** The webhook route's claim transaction treats `failed` as the one reclaimable state, and its write replaces the doc — so a provider redelivering the event resets the ladder (`retryCount` and `deadLetter` both go), and the dead-lettered doc gets a fresh set of attempts. That is the documented way back for an event that was dead-lettered for a fixable reason ([#220](https://github.com/Omega-JS-Stack/omega/issues/220)).

## Payment Cron Jobs

| Job | Cadence | What it does |
|---|---|---|
| `cron/frequent/retry-failed-webhooks.js` | Frequent (10 min) | Re-flips failed webhook events to `pending` under the retry ceiling, then dead-letters ([above](#payments-webhooks-retry-state)) |
| `cron/frequent/abandoned-carts.js` | Frequent (10 min) | Mails the escalating cart reminders, and defers the ones whose checkout is still live ([below](#abandoned-cart-reminders)) |
| `cron/daily/trial-lapse-sweep.js` | Daily | Confirms expired trials with the provider and lapses the abandoned ones |
| `cron/daily/expire-paypal-cancellations.js` | Daily | Closes out PayPal pending cancellations whose term has ended |

### Abandoned cart reminders

The checkout page writes `payments-carts/{uid}` on load (`status: 'pending'`, `reminderIndex: 0`, `nextReminderAt: now + 900`) and the frequent cron mails whatever is due, escalating through `REMINDER_DELAYS` — **15m, 3h, 24h, 48h, 72h** (`libraries/abandoned-cart-config.js`, the SSOT both sides read). A completed purchase marks the cart `completed` from the webhook pipeline, and so does a user who turns out to have an active subscription.

**A cart with checkout activity inside its window is not abandoned** ([#655](https://github.com/Omega-JS-Stack/omega/issues/655)). The reminder clock used to be set ONCE, when the page loaded, and nothing ever moved it — so a shopper who spent 20 minutes on the checkout was mailed "Complete your checkout" two minutes before their purchase went through. `POST /payments/intent` now stamps `lastActivityAt` on the cart (fire-and-forget, an `update` so a checkout reached without a cart tracker never creates one), and the sweep restarts the CURRENT reminder's own delay from that touch: the reminder is deferred, never spent, so the shopper still gets reminder #1 if this checkout goes nowhere. A cart nobody ever took to a checkout carries no activity and reads exactly as it did.

### Trial lapse sweep

A trial that ends without converting should leave the user on `basic`. The providers say so with a webhook — and when that webhook is missed or never fires, the user keeps a paid product they never paid for, with nothing to notice it: `trial.claimed` means "this subscription HAD a trial", never "it converted".

So the sweep **asks the provider**. It never infers a lapse from dates:

1. **Windowed candidate query** — trial claimed, subscription still `active`, and `trial.expires.timestampUNIX` between 30 days ago and 24 hours ago. The 24-hour grace exists because webhook lag at trial end is normal and PayPal's stored trial expiry is a computed estimate (PayPal fires no trial-end event); the 30-day floor keeps this a backstop for missed webhooks rather than a re-examination of every trial ever claimed.
2. **Skip** the ones already stamped, already on `basic`, or with no provider to ask.
3. **Fetch the live subscription** — the provider's answer is the only thing this sweep acts on, so a fetch that cannot answer waits for the next run instead of fabricating a cancellation. Only "no such subscription" counts as gone (the same `notFound` classification the webhook pipeline refuses on).
4. **Decide.** Provider says active → the trial `converted`: stamp `trial.outcome` and touch nothing else. Gone or cancelled → the trial `lapsed`: the same end state the cancel route writes (status `cancelled`, back on `basic`, nothing pending) plus the stamp. Anything else (a suspended subscription still in dunning) → neither outcome is true yet, nothing is stamped, and the next run asks again.
5. **Re-read and write in ONE transaction**, so a webhook that landed since the query is never clobbered. Both halves of that guard matter and both were wrong once ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)): a bare read followed by a separate `set` left a window where a webhook committing between the two was overwritten anyway (the guard proved freshness at a moment that had already passed), and the comparison against the run's read stamp was a strict `>` — but both numbers are whole SECONDS, so a webhook writing inside the sweep's own second read as OLDER, which is exactly the write the guard exists to protect. Equal now counts as newer; the cost of being wrong is one candidate re-examined next run.
6. **Report the outcome** — `trial_convert` or `trial_lapse`, through the same `deliverConversion` path the payment webhook uses.

No email is sent from here — the sweep is state correction.

**Why the sweep reports at all.** For PayPal this is the ONLY place a trial's outcome is ever known: PayPal fires no trial-end event, so the webhook pipeline is never told and the trial funnel had no signal whatsoever ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).

**And why it cannot double-count.** The guard is the term: a conversion the payment webhook already saw moved `expires` out past the trial's end — and stamps `trial.outcome` besides, which the sweep skips outright one step before the term guard ([#697](https://github.com/Omega-JS-Stack/omega/issues/697)) — while a lapse it saw left the subscription suspended or cancelled, which this sweep's `status == active` query never selects. So a candidate still inside its trial is exactly one no webhook resolved, and it is the only one the sweep reports — the outcome is still STAMPED either way, because that is state correction. Both paths key the event id on the subscription (`trial_convert.<resourceId>`), which collapses a genuine race on the two platforms that key on an event id; the term guard is what keeps GA4 honest, since GA4 deduplicates a `purchase` on `transaction_id` and the two paths cannot name the same one — the webhook has the invoice, this sweep has only the subscription ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).

The candidate query needs a composite index on `users`, registered in `src/cli/commands/setup-tests/helpers/required-indexes.js` (the SSOT for required indexes).

### PayPal cancellation expiry

PayPal has no cancel-at-period-end, so a cancelled PayPal subscription serves out its paid term as `cancellation.pending` and this cron closes it once `expires` passes. It writes the user's subscription **and** the order doc's `unified` mirror — the mirror is what handlers and the UI read, and leaving it behind meant an expiry produced a stale order. Both land in one batch, as the delta this cron owns (never a whole map read from a snapshot, which would restore every other field to its read-time value).

It takes the pipeline's staleness discipline too: each candidate is re-read at its turn, and anything a webhook has since written — a newer `payment.updatedBy` stamp on the subscription, a newer `metadata.updated` on the order, a status that is no longer a pending cancellation — makes the cron stand down rather than overwrite the newer truth.

Its candidate query (`subscription.payment.provider` + `subscription.cancellation.pending`) needs a composite index on `users`, registered in the same SSOT — it shipped without one, so the cron worked only in brands where the index had been hand-created ([#225](https://github.com/Omega-JS-Stack/omega/issues/225)).

## Webhook Verification

ONE layer gates `POST /payments/webhook`, and the dispute-alert route beside it: **the shared key** — `?key=<OMEGA_WEBHOOK_KEY>`, compared in constant time. Every provider rides it, a mismatch is a 401 before anything else runs, and nothing is parsed or stored until it passes.

Provider signing secrets are deliberately not part of this: no provider verifies a native signature, and the backend holds no signing secret for one ([#634](https://github.com/Omega-JS-Stack/omega/issues/634)). That is a standing rule for every provider added since, Coinbase Commerce included — its `X-CC-Webhook-Signature` header is **not** verified, and its shared secret is never configured or stored here (Ian 2026-08-27). The key is the boundary, which is why it is a minted, brand-owned value and why a manage run leaves exactly one endpoint carrying it.

## Test Provider

The `test` provider generates Stripe-shaped data and auto-fires webhooks to the local server. Only available in non-production environments. Use `provider: 'test'` in intent requests during testing. The test webhook provider delegates to Stripe's parser since it generates Stripe-shaped payloads.

Both doors enforce that: the intent side throws inside `intent/providers/test.js`, and `POST /payments/webhook?provider=test` answers 403 in production (the webhook providers receive only the raw request, so the route's dispatch layer carries the guard). Real providers are unaffected — a provider dashboard points at `POST /omega/payments/webhook?provider=<provider>&key=<OMEGA_WEBHOOK_KEY>`, where the shared key is the boundary ([Webhook Verification](#webhook-verification)).

### Discounts and the first charge

`discountCodes.applyToAmount(amount, discount)` is the one home of the **discounted-charge** computation — `percent` maps to Stripe's `percent_off`, `amount` to its `amount_off` (dollars here, cents there) — and every place that needs "what is the customer charged today" calls it: the intent route's confirmation URL, the test provider's fabricated payloads, the analytics value resolver, and the `new-subscription` / `purchase-completed` email totals. (Promo *savings* — the amount taken off, not the amount charged — is a different quantity and stays inline at its two email sites.)

Only the FIRST charge moves. Every code is `duration: 'once'`, so `users/{uid}.subscription.payment.price` keeps the full renewal price from config; the discount itself is recorded on the order (`order.discount`), which is what analytics reads.

**The confirmation URL's `amount` is the ROUTE's job, not a provider's** ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)). `buildConfirmationUrl()` in `routes/payments/intent/confirmation-url.js` applies the validated discount, so the number is right on every provider. That placement is load-bearing: a real provider applies its coupon on its own hosted page and never revisits this URL, so doing the math provider-side left a discounted Stripe checkout landing on the confirmation page quoting the LIST price — and the client's tracking modules read that param straight into GA4/pixel revenue. A trial quotes `$0` and a coupon takes its cut off nothing.

**The confirmation URL names the product TYPE** ([#668](https://github.com/Omega-JS-Stack/omega/issues/668)). `buildConfirmationUrl()` sets `type=subscription|one-time` beside `frequency`, because the confirmation page holds nothing else about what was bought: it decides whether to WAIT for the webhook by asking whether the purchase writes account state at all, and a checkout that sent the wrong `frequency` (a one-time buy asking for `annually`) left it polling for a plan a one-time purchase never writes until it timed out, on a payment that had completed cleanly. The route also NORMALIZES what a one-time checkout bills on — `frequency` is written `once` beside `trial = false`, next to the guards, rather than taken from the caller — so the intent doc, the provider call and the confirmation URL cannot record a cadence the buyer will never be billed on. The one-time receipt names the PRODUCT in its summary row (`templates/order.js`), where it used to repeat the order id the header already prints.

**Every provider charges the discounted one-time amount** ([#758](https://github.com/Omega-JS-Stack/omega/issues/758)). The split is by what the provider's API HAS: Stripe and Chargebee hand their hosted page a real coupon object (`discounts: [{ coupon }]`, `coupon_ids: [...]`) and it comes off on their side, while a PayPal v2 Order, a Coinbase charge and the test provider's session are prices this framework computes, so those three call `applyToAmount()` on `prices.once` themselves. PayPal's one-time order did neither: it charged the list price while the confirmation URL built beside it quoted the discounted one, so a buyer with a valid code paid full price and landed on a cheaper receipt.

**A PayPal SUBSCRIPTION discounts its first period with a setup fee** ([#759](https://github.com/Omega-JS-Stack/omega/issues/759)). PayPal's Subscriptions API has no coupon object either, and the plan the manager's payment walk created carries ONE infinite `REGULAR` billing cycle (plus a `TRIAL` cycle ahead of it when the product configures trial days), so neither shape the create call offers can move the first payment alone. `plan.billing_cycles` overrides a cycle by `sequence` and carries no `tenure_type` or `frequency`, so it cannot ADD a cheaper first cycle, and re-pricing the single cycle it can reach would ride every renewal with it; pricing a `TRIAL` cycle at the discount is worse, because `resolveTrial()` reads any TRIAL cycle as a claimed trial, which would make a PAYING subscriber read as trialing everywhere the backend asks (access revoked the instant they cancel, the winback offer refusing them). So `intent/providers/paypal.js` charges the discounted period at approval as the plan override's setup fee (`plan.payment_preferences.setup_fee`, at `applyToAmount(prices[frequency], discount)`) and tells the plan's own cycles to start one full period later (`start_time`), which leaves every renewal at the plan's list price. An undiscounted subscription is untouched (no override, no `start_time`, billing starts now), and a free trial still charges nothing today, so a code takes its cut off nothing there. One carve-out remains against Stripe and Chargebee, which attach the coupon beside the trial so it lands on the first PAID invoice: a PayPal trial checkout loses the code entirely, and it cannot follow the trial onto the first paid period without minting a per-buyer plan, which this framework does not do. The override also repeats the plan's `auto_bill_outstanding` and `payment_failure_threshold`, so a partial override can never change a discounted subscriber's retry behavior. Like the coupon builders above, this is proven on the params PayPal is asked to create; that the setup fee is collected at approval when `start_time` sits a period out is a live-sandbox item ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).

**A code that covers the WHOLE price is refused, never sent as $0.00, on a provider whose row says it cannot take one** ([#786](https://github.com/Omega-JS-Stack/omega/issues/786), [#849](https://github.com/Omega-JS-Stack/omega/issues/849)). `chargeableAmount(listPrice, discount, { provider })` in `libraries/payment/discount-codes.js` is `applyToAmount()` with that refusal in front of it, and the refusal is the provider's `acceptsZeroCharge` capability ([Provider capabilities](#provider-capabilities)), never a list of names. The providers whose amount this framework computes call it with their id: the PayPal one-time order, the PayPal subscription's setup fee (before the plan lookup, so PayPal is not called at all) and the Coinbase charge, and neither API takes a zero amount, so `WELCOME10OFF` on anything priced at or under $10 would come back a provider 400 the buyer reads as the checkout's generic failure. The Error is coded 400, which is the one case `POST /payments/intent` answers with the provider path's own words: a 400 naming the code, the list price and the provider. Stripe and Chargebee take the $0 checkout on their own hosted page, where the coupon lives; a product priced 0 keeps each provider's existing "No price configured" fault, and a checkout TAKING A FREE TRIAL is skipped outright (`takingTrial`): nothing is charged today whatever code rides along, and the code comes off the first paid period. The checkout page hides a button on a zero total off the same row (`core/js/pages/payment/checkout/modules/state.js` in @omega.js/web), so the refusal is a backstop rather than the buyer's first news. Pinned by `test/routes/payments/intent-zero-total.test.js`, whose every-provider case walks the registry.

**A trial product carries TWIN PayPal plans, and skipping the trial is a plan choice** ([#761](https://github.com/Omega-JS-Stack/omega/issues/761)). PayPal puts a trial on the PLAN, never on the subscribe call, so the manager's payment walk mints TWO active plans per paid interval on a product that configures `trial.days`: the trial twin (`TRIAL` cycle + `REGULAR`) and the skip-trial twin (`REGULAR` only), named `<Display> (Monthly)` and `<Display> (Monthly, no trial)`. `resolvePlanId(product, frequency, trial)` in `libraries/payment/providers/paypal.js` matches on interval + amount + `TRIAL`-cycle PRESENCE — the manager's own rule, since plan names are display only — and both callers (the checkout and the plan switch) pass the trial value they resolved, so a buyer the route refused a trial subscribes to a plan that has no free cycle on it at all. That is what makes skip-trial real: the old code "skipped" by setting `start_time` five minutes out, which left the plan's `TRIAL` cycle running anyway, so `resolveTrial()` read a PAYING customer as trialing (a cancel inside that window revoked access at once) and the discount had to carve trial products out. Both are gone: the +5 minute nudge is deleted and a returning buyer with a code gets the setup-fee discount like everyone else. A trial checkout still resolves the trial twin and still charges nothing today. **A trial product needs one manage run (`npx omega manage --service=payment`) to mint its no-trial twin** — until then a skip-trial checkout throws the plan lookup's "No active PayPal plan … without a trial cycle" rather than falling back to the trial twin and handing out a free period nobody granted. A product without trial days is unchanged: one plan per interval, one twin.

The test provider's remaining share is the **payload it fabricates**, carrying the coupon the way Stripe reports it: a Stripe-shaped `discount` on the subscription, `amount_total` + `total_details.amount_discount` on a one-time session, and the discounted `amount_due` on a declined checkout's failed first invoice.

**Both coupon shapes reach the real providers.** A code in `discount-codes.js` carries either `percent` or `amount` (flat dollars), and each provider builds its provider's own form: Stripe gets `percent_off`, or `amount_off` in CENTS with the `currency` beside it (Stripe rejects an amount coupon without one); Chargebee gets `discount_type: 'percentage'` + `discount_percentage`, or `'fixed_amount'` + `discount_amount` in the currency's minor unit + `currency_code`. Currency is `payment.currency` (default `USD`). The deterministic coupon id differs per shape (`BEM_{CODE}_{n}OFF_ONCE` vs `BEM_{CODE}_{n}AMTOFF_ONCE`) so one code can never collide with the other form, and the percent id is unchanged, so coupons already live in a brand's provider account keep resolving. Both builders are proven on the params they ask the provider to create; live-provider verification is a Stage 3 item ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).

**A `validate()` result OMITS the shape a code does not have** — it never carries `amount: undefined` — because the result is not just read, it is WRITTEN: `POST /payments/intent` persists it as `payments-intents/{orderId}.discount`, and firebase-admin refuses a document containing an undefined value, throwing synchronously *after* the provider has already created the real checkout session. Readers branch with `discountCodes.promoShape(discount)` → `'percent' | 'amount' | null`. The `null` arm is not defensive padding: a discount read back off an order written before the amount field existed is `valid` with neither shape, and the confirmation-email transitions are dispatched fire-and-forget, so reading a missing shape there costs the customer their receipt silently.

The order email quotes the shape it was given: `promoPercent` renders "15% off", `promoAmount` renders "$10.00 off", `promoSavings` is what the code actually took off (floored at the charge — a $10 code against a $4.99 charge saves $4.99, not $10), and a shapeless discount renders no promo line at all while the totals stand at full price.

### Simulating a declined checkout

`POST /payments/intent` takes a `simulate` field — allow-listed to `'decline'` by the schema, honored **only** by the test provider (itself non-production), inert on real providers, and **never persisted** onto the intent or the order. It is how the dunning journey (decline → suspended → recovery) is proven end-to-end.

A decline mirrors what a real provider does, per product type:

| Product type | What the test provider fabricates |
|---|---|
| **subscription** | The subscription is born `past_due` (→ `suspended`) with no trial claimed, then a sequenced `invoice.payment_failed` with `billing_reason: 'subscription_create'`. The two events go out **in order** — the failed invoice names the subscription, and the pipeline resolves it from the order the first event wrote. |
| **one-time** | The session is still created; the payment is what fails, so a failed `manual` invoice (`invoice.payment_failed`) goes out in place of the completed session. |

A decline's `payments-intents` doc still ends `completed`. The intent status means "the pipeline processed this", not "the customer paid" — the payment outcome lives on the order and the subscription.

### Simulating an abandoned checkout

`simulate: 'abandon'` is the same allow-listed field's other value: the session is created and returned exactly as always, and **no webhook is fired**. That is not a shortcut — it is what abandonment IS. The customer closes the tab, nothing happened, and the provider has nothing to report.

It exists because every other payment test drives an event through the pipeline, so the one state nothing covered was the state where the pipeline never runs ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)). What an abandoned checkout must leave behind is exactly one thing — the `payments-intents/{orderId}` doc, still `pending`, which is what the abandoned-cart lane and any later reconciliation read. What it must NOT leave behind is anything shaped like a purchase: no `payments-orders` doc, no subscription change, no claimed trial, no name auto-filled off a payment resource. A customer who considered buying and did not is indistinguishable from one who never opened the page.

### The dispute test provider

The dispute pipeline gets the same treatment the payment routes do. `events/firestore/payments-disputes/providers/test.js` implements the same two functions the Stripe provider does — `searchAndMatch` and `processDispute` — against the emulator's own records, and it is selected the way every dispute provider is: off the alert's `provider` field (Chargeblast's `processor`).

It exists because a dispute is the one payment path with no simulatable half: `searchAndMatch` needs a real charge and `processDispute` needs a real refund and a real cancel, so the assertion that matters most — *a chargeback takes the subscription away* — had no test at any tier.

The simulation is deliberately shaped like the real thing:

- the **match** is found by AMOUNT and CARD (last4 `4242`), the way Stripe's charge search is, so a mismatched alert reaches the `no-match` branch instead of being waved through on the email alone;
- the **cancel** is not written onto the user. It writes the same synthetic `customer.subscription.deleted` pipeline document Stripe's `subscriptions.cancel()` produces, so the webhook pipeline is what revokes access — here as in production.

It **refuses in production**, and that guard is load-bearing rather than decorative: the provider name comes off the alert payload, so without it a forged alert could force-cancel a real subscriber by asking for the simulation.

## Scenario coverage matrix

Every scenario in [#212](https://github.com/Omega-JS-Stack/omega/issues/212)'s spec, and the file that pins it. `test/` paths are relative to `packages/backend/`; the unit tier is plain-node (no emulator), the journey tier runs the real pipeline against the emulator.

| # | Scenario | Pinned by |
|---|---|---|
| 1 | basic → premium upgrade | `test/events/payments/journey-payments-upgrade.test.js`; rule 1 in `transitions-detect.test.js` |
| 2 | premium cancel, access to term end | `journey-payments-cancel.test.js`, `journey-payments-cancel-endpoint.test.js`, `journey-payments-cancel-no-order.test.js`, `routes/payments/cancel.test.js`, `cancel-trialing.test.js`, `cancel-provider-errors.test.js`, `cancel-skip-guards.test.js`; rules 6 + 8 |
| 3 | uncancel before term end | `journey-payments-uncancel.test.js`, `routes/payments/uncancel.test.js`; rule 7 (`cancellation-removed`) |
| 4 | plan switch + frequency switch, proration | `journey-payments-plan-switch.test.js`, `journey-payments-plan-switch-trial.test.js`, `journey-payments-plan-change.test.js`, `routes/payments/plan.test.js`, `refund-paypal-proration.test.js`; rule 9, and the **frequency-only switch has no rule** — pinned as a known gap |
| 5 | refunds: full, prorated, partial, one-time | `journey-payments-refund-webhook.test.js`, `journey-payments-refund-no-order.test.js`, `journey-payments-one-time-refund.test.js`, `routes/payments/refund.test.js`, `refund-one-time.test.js`, `webhook-refund-*.test.js`, `purchase-refunded-handler.test.js`; refund priority + idempotency in `transitions-detect.test.js` |
| 6 | trial: claim, convert, cancel mid-trial, lapse | `journey-payments-trial.test.js`, `journey-payments-trial-cancel.test.js`, `trial-lapse-sweep.test.js`, `trial-lapse-sweep-staleness.test.js`, `routes/payments/trial-eligibility.test.js` |
| 7 | dunning: decline → retry → recovery → cancel | `journey-payments-decline.test.js`, `journey-payments-suspend.test.js`, `journey-payments-failure.test.js`, `journey-payments-winback-decline.test.js`; rules 3, 3b, 4, 5 |
| 8 | payment-method update mid-subscription | `webhook-ordering.test.js` (`a-payment-method-update-refreshes-state-and-emails-nobody`), `routes/payments/portal.test.js`, `portal-return-url.test.js` |
| 9 | chargebacks / disputes → forced cancel | `journey-payments-dispute.test.js` (end to end), `routes/payments/dispute-alert.test.js`, `dispute-email-status.test.js`, `dedup-race.test.js` |
| 10 | webhook robustness: duplicates, ordering, unknown types | `webhook-ordering.test.js`, `dedup-race.test.js`, `webhook-retry-sweep.test.js`, `webhook-atomic-writes.test.js`, `routes/payments/webhook.test.js`, `test-processor-doc-shape.test.js`; real deliveries in `test/stripe-live/subscription-lifecycle.test.js` (opt-in lane) |
| 11 | abandoned checkout — no residue | `journey-payments-abandoned.test.js`; the reminder sweep's activity rule in `events/payments/abandoned-cart-activity.test.js` |
| 12 | account deletion with an active subscription | `test/routes/user/delete.test.js` (deletion is REFUSED while a paid subscription stands) |
| 13 | one-time: purchase, refund, re-purchase | `journey-payments-one-time.test.js`, `journey-payments-one-time-decline.test.js`, `journey-payments-one-time-failure.test.js`, `journey-payments-one-time-refund.test.js`, `routes/payments/intent-one-time-metadata.test.js`, `webhook-stripe-refund-one-time.test.js`; the transition mails in `purchase-refunded-handler.test.js` + `purchase-failed-handler.test.js`, the account surface in `routes/user/orders.test.js` + web's `account-orders.test.js` |
| 14 | order ids are unique | `helpers/payment/order-id.test.js` (mint, collide, retry, fail loudly) |

**Known gaps, pinned rather than hidden:** a frequency-only switch (same product, monthly → annually) matches no transition rule, so no email fires for it — asserted explicitly in `transitions-detect.test.js` so a future rule flips a test rather than passing unnoticed.
