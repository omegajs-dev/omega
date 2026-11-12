# Usage & Rate Limiting

## The one call

```js
module.exports = async ({ ctx }) => {
  const left = await ctx.usage.consume('saves');   // throws a 429 over limit

  // ... do the work the user paid for
  return ctx.respond({ saved: true, left: left.left });
};
```

`consume` checks both counters, refuses with a 429 that names WHICH one hit, else counts, writes, and returns what is left. There is no "validate then increment then update" dance to get half right — every hand-rolled gate that used to live in a route existed because there was one.

## What a feature IS lives in config, once

A feature is defined ONCE, in the top-level `features` catalog, and each product names only its VALUE ([docs/shared/config.md](../shared/config.md)):

```json5
{
  features: {
    saves:   { name: 'Saves', icon: 'feather', definition: 'Notes you can save.',
               usage: { pace: 'daily', mirror: ['teams'] } },
    support: { name: 'Priority support', icon: 'headset' },
  },
  payment: {
    products: [
      { id: 'basic',   name: 'Basic',   features: { saves: 100 } },
      { id: 'premium', name: 'Premium', features: { saves: -1, support: true } },
    ],
  },
}
```

- A `usage` block makes the entry **counted** (metered per user). An entry without one is a **perk** and is never counted — `consume('support')` is a 500, not a silent gate.
- A counted feature's product value is its **monthly limit**, as a number. `-1` is unlimited. `false` (or absent) means the tier does not include it, which reads as a limit of `0`: every call refuses.
- A perk's value is `true` / `false` / a string.
- The validator fails a number on a perk and a perk value on a counted feature, so a plan can never advertise a meter nothing enforces.

## Two counters, and the day's share

Every counted feature carries two counters per user: **month** and **day**.

| Field | What it is |
|---|---|
| `monthly` | This month's count, reset on the 1st by cron |
| `daily` | Today's count, reset every day by cron |
| `total` | All-time count, never resets |
| `last` | `{ timestamp, timestampUNIX }` of the last time it moved |

The day's share is `ceil(monthly limit / days in this month)`, so a quota of 100 in a 31-day month allows 4 a day and can never be burned on day one. **Unused day share expires at midnight** — it never rolls forward.

Pacing by day is the **default**. `usage: { pace: false }` on the catalog entry opts a feature out to a plain monthly counter (`day.limit` reads `-1`, and the day never refuses).

**Either counter full refuses, and the month cap always holds.** `consume` checks the MONTH first — a spent month is not "try again tomorrow":

| State | The 429 says |
|---|---|
| Month spent | `You have used all 100 of your Saves this month (100/100). Upgrade your plan for more.` |
| Day's share spent, month has room | `You have used today's Saves (4/4 of the 100 on your plan this month). Try again tomorrow.` |

## Per-user overrides

`user.usage.overrides.<feature>` is a number that **wins over the plan's**: extra credits granted to one account, not a second pricing tier. The day's share derives from the effective number, so an override of 300 on a 31-day month allows 10 a day rather than the plan's 4.

`usage` is a framework field the Firestore rules deny every client ([templates/firestore.framework.rules](../../packages/backend/templates/firestore.framework.rules)), so an override can only ever be server-written — which is what makes it trustworthy as a limit. The reset cron never touches it.

## The API

`ctx.usage` is attached to every route by the request pipeline. Attaching is **synchronous and I/O-free**: the counter resolves the account on the first `consume`/`read`, so a route that never counts pays nothing.

| Method | What it does |
|---|---|
| `consume(feature, amount = 1, options?)` | async — check, count, write. Throws a 429 over limit; returns `{ used, left, day: { used, left } }` |
| `read(feature)` | async — the same numbers plus `limit`, `planLimit`, `override`, `day.limit`, without counting |
| `forKey(key)` | A SEPARATE counter for an anonymous key (see below) |
| `forUser(uid)` | A SEPARATE counter for another account, `users/{uid}` (see below) |
| `limits()` / `counters()` | What the counter already KNOWS — the `omega-properties` header's `usage.limits` / `usage.current`; empty until it has resolved |
| `getProduct(id?)` | The account's resolved product |
| `addWhitelistKeys(keys)` | API keys that never get refused (they still count) |

`options.limit` is for the counters that are **not plan features** — a per-IP signup gate is a security control with its own declared config key (`targets.backend.auth.signup.maxPerIpPerDay`), not a tier anybody buys. An explicit limit supplies the definition the catalog would have, so the catalog lookup and the product read are skipped and the counter is a plain period counter with no day share. The framework's own anti-abuse gates use it: signup-by-IP, `marketing/contact`, `marketing/email-preferences`.

Every derivation — the effective limit, the day share, what is left — lives in `@omega.js/account`'s features module, the SAME one the browser's account page reads through `@omega.js/client/modules/features.js`. The number that refuses a request and the number a usage card draws can never be two different numbers.

## Anonymous counting is explicit

```js
await ctx.usage.forKey(ctx.request.geolocation.ip).consume('marketing-subscribe', 1, { limit: 5 });
```

`forKey` returns a **separate** counter bound to that key, writing to `usage/{key}` (or a local temp store when `unauthenticatedMode: 'local'`). Passing a key can never silently move a signed-in user's own counters into the anonymous store, which is exactly what the old `options.key` did.

Keyed counters are **day-only in practice**: the cron wipes the whole anonymous store daily, so an anonymous monthly limit cannot exist.

**`ctx.usage` refuses a signed-out caller.** `consume`/`read` on a request with no uid throws `usage: no signed-in account to count against; use usage.forKey(<key>) for anonymous callers`. It does not fall back to the anonymous store: routing there silently would be the very bug `forKey` exists to remove, and counting on the user doc would write `users/null` — one document every anonymous caller on earth would share.

## Counting against another account

```js
await ctx.usage.forUser(sellerUid).consume('reviews');   // the seller's plan, the seller's month
```

- `forUser(uid)` is for a paid feature that runs for one account inside a request made by another: a buyer submits a post and the seller's AI reviewer reads it, so the seller's plan decides whether it runs and the use counts against the seller.
- It returns a **separate** counter bound to `users/{uid}`, and everything above works on it the same way: that account's plan, its per-user override, the month and day checks, its mirrors.
- The whitelist is checked against that account's own API key, so a whitelisted caller gets no free uses on someone else's counter.
- Like `forKey`, the call is synchronous and does no I/O; the account is read once, on the first `consume`/`read`. A missing or non-string uid throws at once.
- A uid with no document throws a **404**, `usage: no account at users/<uid>`, and writes nothing: the counter never heals or creates an account. A route that wants to skip a missing account catches it.
- **The caller's roles are not checked.** The call works for any caller, a signed-out one included, so the route decides who may charge whom.
- **Take the uid from a record the route trusts** (the post's seller, the team's owner), never from the request body: `forUser` lets its caller spend that account's quota.
- The `omega-properties` header and analytics keep reporting the caller's own counter (`ctx.usage`), never a `forUser` one.

## Mirrors are declared in the catalog

`usage: { mirror: ['teams'] }` on a catalog entry says a feature's counters also land on every document the account owns of that kind — resolved from `user.owns.teams` (a framework field, server-written like `usage`). `consume` writes the touched feature's counters to the user doc and every mirror in ONE parallel write:

```
users/{uid}          ← { usage: { saves: { monthly, daily, total, last } } }
teams/{teamId}       ← the same patch
```

It writes **that feature's counters only**, never the whole usage object, so two features counted in the same second cannot overwrite each other. There is no call-site mirror API — nothing to re-derive per route.

## Reset schedule

| Target | Frequency | What happens |
|---|---|---|
| Local storage | Daily | Cleared entirely |
| `usage` collection (anonymous keys) | Daily | Deleted entirely |
| User doc `usage.<feature>.daily` | Daily | Reset to 0 |
| User doc `usage.<feature>.monthly` | Monthly (1st) | Reset to 0 |
| User doc `usage.overrides` | Never | Untouched — a reset is not a revoke |

The daily cron (`events/cron/daily/reset-usage.js`) runs at midnight UTC, and performs a single write per user.

The account page's usage cards show when each counter next resets ("Day resets 5:00 PM", "Month resets Nov 1"): these same UTC boundaries, read from `nextReset(period)` in `@omega.js/account`'s features module and shown in the viewer's local time.

**Which counters reset is a question of SHAPE, not of catalog membership.** The cron QUERIES on the counted features the catalog defines plus the framework's own gates (a Firestore query has to name a field path), but once it has the document it clears every counter-shaped key under `usage` — so a counter run against an explicit limit, which by definition has no catalog entry, resets like any other. Sweeping only the catalog left those growing forever, which permanently refused the user after their first few uses.
