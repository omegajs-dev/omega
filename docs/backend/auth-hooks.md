# Auth Hooks (Consumer Project)

Auth hooks let consumer projects inject custom logic into @omega.js/backend's auth event lifecycle. @omega.js/backend runs its core handler first, then looks for a matching hook at `hooks/auth/{event-name}.js`.

| Hook | File | Behavior |
|------|------|----------|
| `before-create` | `hooks/auth/before-create.js` | Runs after @omega.js/backend's disposable email + rate limit checks (the per-IP daily cap is `targets.backend.auth.signup.maxPerIpPerDay`, default 2). **Can throw `HttpsError` to block signup.** |
| `before-signin` | `hooks/auth/before-signin.js` | Runs after @omega.js/backend's activity update. **Can throw `HttpsError` to block sign-in.** |
| `on-create` | `hooks/auth/on-create.js` | Runs after @omega.js/backend creates the user doc. **Non-blocking** — errors are caught and logged. |
| `on-delete` | `hooks/auth/on-delete.js` | Runs after @omega.js/backend deletes the user doc. **Non-blocking** — errors are caught and logged. |

Hook signature (the same object @omega.js/backend's own handler received):

- A hook is an ES module whose default export is the async function, loaded through the one handler loader.
- A CommonJS hook (`module.exports = ...`) is refused by name: `<file> must be an ES module with one default export (export default async (...) => {})`.
- No top-level `await`: the file is loaded by `require()`, which refuses an async module. An `await` goes inside the default export.

```javascript
export default async ({ ctx, omega, user, context }) => {
  // user: AuthUserRecord (uid, email, providerData, etc.)
  // context: AuthEventContext for blocking functions (ipAddress, userAgent, additionalUserInfo)
  //          EventContext for triggers (eventId, eventType, timestamp; no IP/userAgent)
  // omega: the instance (omega.firebase.admin, omega.firebase.functions, omega.config, ...)
};
```

## Blocking hook example (before-create)

```javascript
// hooks/auth/before-create.js — Only allow Google OAuth signups
const ENFORCE = true;

const ALLOWED_PROVIDERS = ['google.com'];

export default async ({ ctx, omega, user, context }) => {
  if (!ENFORCE) { return; }

  const functions = omega.firebase.functions;
  const provider = context.additionalUserInfo?.providerId;

  if (!ALLOWED_PROVIDERS.includes(provider)) {
    ctx.error(`hook/before-create: Blocked provider '${provider}' for ${user.email}`);
    throw new functions.auth.HttpsError('permission-denied', 'Please sign up with Google.');
  }
};
```

## Non-blocking hook example (on-create)

```javascript
// hooks/auth/on-create.js — Auto-delete spam referrals
import powertools from 'node-powertools';

const ENFORCE = true;
const BLOCKED_AFFILIATE_CODES = ['iLvQjmvm'];

export default async ({ ctx, omega, user, context }) => {
  if (!ENFORCE) { return; }

  const admin = omega.firebase.admin;
  const uid = user.uid;

  // Poll until signup route attaches attribution.affiliate.code
  let referredBy = null;

  await powertools.poll(async () => {
    const userDoc = await admin.firestore().doc(`users/${uid}`).get().catch(() => null);
    if (!userDoc?.exists) { return true; }
    referredBy = userDoc.data()?.attribution?.affiliate?.code;
    return !!referredBy;
  }, { interval: 10000, timeout: 60000 }).catch(() => {});

  if (!referredBy || !BLOCKED_AFFILIATE_CODES.includes(referredBy)) { return; }

  // Delete spam account (triggers on-delete for cleanup)
  await admin.auth().deleteUser(uid).catch(e => ctx.error('Delete failed:', e));
};
```
