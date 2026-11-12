# Common Operations

Inside-the-handler patterns for the most frequent operations. See [docs/backend/routes.md](routes.md) for the route file structure itself.

## Authenticate User

The pipeline authenticates before the route runs, so the route reads the caller off its argument (`ctx.user` is the same `User`):

```javascript
export default async ({ ctx, user }) => {
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
};
```

`ctx.authenticate()` resolves the caller into `ctx.user` for code that runs outside the pipeline, and settles once per request.

### A missing user doc heals here

A verified ID token whose `users/{uid}` doc is gone is a database out of sync with Auth, not a caller to turn away ([#405](https://github.com/Omega-JS-Stack/omega/issues/405)). `authenticate()` recreates the doc `auth:on-create` writes at signup, built from the Auth record by the one shared builder in [src/omega/libraries/user-doc.js](../../packages/backend/src/omega/libraries/user-doc.js), warns naming the uid, and then authenticates the caller normally, so every signed-in surface heals at the same seam. A doc that exists but carries no `auth.uid` counts as missing **to the heal**: that is the residue `auth:before-signin` leaves on a doc-less account, and it is what the heal completes into a real account doc. Whether the caller authenticates is a separate question with an unchanged answer: a doc that exists at all authenticates its caller, healed or not. The healed doc is stamped `metadata.tag: 'auth:heal'` and `flags.signupProcessed: true`, since an established account must not be sent back through the signup flow (welcome emails, affiliate credit, marketing sync) on its next page load.

Three accounts are never healed, so the heal only ever completes an account that should already have a doc:

- **A signup still in flight.** Within `SIGNUP_WINDOW_MS` (two minutes) of the Auth record being created, the heal stands down. That first write is `auth:on-create`'s: it runs the consumer hook, and it would be skipped for good if a heal wrote the doc first. `POST /user/signup` arrives inside this window with nothing but sign-in residue on its doc, authenticates on it exactly as it did before the heal existed, and polls for the doc `auth:on-create` is about to write.
- **Anonymous accounts**, which get no user doc anywhere in the framework.
- **A uid with no Auth user**, which keeps the opposite direction refused (see [payment-system.md](payment-system.md#a-payment-never-creates-a-user-doc)).

A declined heal changes nothing about the request: the caller is answered on the doc they arrived with, which is the pre-heal lane byte for byte. Outside the window the write is a transaction and existing values win over schema defaults: there is one doc per uid and never a duplicate account, whichever of the two writers arrives second finds the doc and leaves it alone, and nothing already on the doc is edited. Reshaping existing docs stays the manual users migration's job alone.

## Read/Write Firestore

```javascript
const admin = omega.firebase.admin;

// Read
const doc = await admin.firestore().doc('users/abc123').get();
const data = doc.data();

// Write
await admin.firestore().doc('users/abc123').set({ field: 'value' }, { merge: true });
```

## Handle Errors

```javascript
// Send an error response (a 5xx is captured to Sentry, a 4xx never is)
return ctx.respond(new Error('Something went wrong'), { code: 500 });

// Or throw: report() decorates, logs and captures without sending, and the
// pipeline answers a thrown error with its own code
throw ctx.report('Bad request', { code: 400 });
```

## Send Response

```javascript
// Success
ctx.respond({ success: true, data: result });

// With custom status
ctx.respond({ created: true }, { code: 201 });

// Redirect
ctx.respond('https://example.com', { code: 302 });
```
