---
name: analytics
description: Use before finishing any flow, checkout, auth, or backend payment/webhook work — or when the ask names analytics, tracking, an event, a conversion, a pixel, gtag/fbq/ttq, GA4, Meta, TikTok, consent gating, or attribution.
user-invocable: true
---

# Analytics (OMEGA event tracking)

Tracking is MECHANISM, not call sites: one catalog declares every event, one call fires it, and the adapters translate it into each provider's dialect. So the review is checking that a flow fires the events it owns, through the catalog, in the right tier — never that someone wrote a good pixel call.

## Where the mechanism lives

- `docs/shared/analytics.md` — the contract: the catalog entry shape, the three mapping kinds, the placement rule, consent, attribution, the dev fire-log. Read it before changing anything below.
- `packages/analytics/src/catalog.js` — the SSOT: one entry per canonical event, with every provider mapping. The code is the answer to "does this event exist?".
- `packages/analytics/src/index.js` — the facade (`analytics.event()`, `configure()`) and the consent → adapter → transport walk.
- `packages/analytics/src/adapters/` and `transports/browser.js` — one file per provider; the guarded transport a blocked global cannot break.
- `packages/web/core/js/libs/tracking-consent.js` — the web consent record the gate reads.

## The checklist

1. **Every user-facing flow fires its catalog events through `analytics.event()`.** A raw `gtag(...)`, `fbq(...)` or `ttq.track(...)` at a call site is the finding — even a guarded one, since the guard is now the transport's job. A flow that ships with no event at all is the same finding in the other direction: name what the surface should count.
2. **A new event exists in the catalog FIRST.** One entry — canonical name, the `params` contract, the `placement`, and a per-provider mapping with an HONEST `kind` (`standard` only where the platform actually defines that event; anything else is `custom`) — plus its resolve case in `packages/analytics/test/catalog.test.js`. Never pass a name the catalog does not carry: it throws in development on purpose.
3. **Placement follows the rule.** Money and account truth fires server-side (purchase, refund, trial, the subscription transitions, deletion); UI actions fire client-side; `sign_up` fires BOTH halves, carrying the same event id so the platforms deduplicate. A revenue event fired from a browser, or a click event fired from a Cloud Function, is misplaced.
4. **No hand-rolled attribution or consent reads.** Attribution rides the facade's `context` slot and each adapter attaches it its own way; consent is the gate the facade asks per provider, per fire. A call site that reads storage for utm values, or checks a consent flag before firing, is duplicating a mechanism that already ran.
5. **Unmapped providers stay unmapped.** A provider absent from an entry's `providers` is a decision — the adapter skips and the dev log says so. Never invent a junk custom event so a platform "has coverage".
6. **Verify by the fire-log, not the template.** Drive the flow and read the one dev line per event (`[@omega.js/analytics:events] <event> → google sent, meta …`); for a live drive, the platform debuggers. Reading the code you just wrote proves nothing about what fired.

## Verifying

Run the package suite for catalog and adapter changes (`npm test` in `packages/analytics`), then drive the actual flow with a dev server running and read the fire-log line — the `omega:browser` skill drives the running server rather than restarting anything. The full verification ladder, including the platform debuggers and the two consent regions, is in `docs/shared/analytics.md`.
