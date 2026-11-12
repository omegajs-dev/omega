/**
 * Test: a missing user doc heals at sign-in
 * ([#405](https://github.com/Omega-JS-Stack/omega/issues/405)).
 *
 * A user doc is born at signup. Nothing recreated it when it went missing, so an
 * auth user whose `users/{uid}` disappeared stayed unauthenticated on every
 * request forever. The heal sits in authenticate()'s token lane — the one seam
 * every signed-in surface passes through — and recreates the doc auth:on-create
 * would have written, behind the auth record and nothing else.
 *
 * Real everything: real Firebase Auth users in the emulator, real ID tokens
 * (custom token → the emulator's own identitytoolkit endpoint, exactly how a
 * browser gets one), the real Context, the real on-create and before-signin
 * handlers, and the real HTTP surface for the wiring. Broken states are BUILT
 * here — an established account whose doc is deleted — because that is the state
 * the wild produces, and the accounts are IMPORTED so their creationTime is a
 * real one the signup window can be tested on both sides of.
 *
 * Run: npx omega test framework:helpers/user-doc-heal
 */

const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const onCreate = loadHandler(require.resolve('../../dist/omega/events/auth/on-create.js'));
const beforeSignIn = loadHandler(require.resolve('../../dist/omega/events/auth/before-signin.js'));
const { buildUserDoc, healUserDoc, HEAL_TAG } = require('../../dist/omega/libraries/user-doc.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../dist/omega/context.js');

// The 1st-gen EventContext shape for a user creation — what the trigger hands the
// handler, forwarded straight to its debug line and the consumer hook.
const EVENT_CONTEXT = {
  eventType: 'providers/firebase.auth/eventTypes/user.create',
  resource: { service: 'firebaseauth.googleapis.com' },
};

// The AuthEventContext a blocking sign-in handler receives — it writes the caller's
// ip/agent/locale onto the doc as activity.
const SIGNIN_CONTEXT = {
  ipAddress: '203.0.113.10',
  userAgent: 'omega-heal-suite',
  locale: 'en-US',
  eventType: 'providers/cloud.auth/eventTypes/user.beforeSignIn',
};

/**
 * A REAL ID token for a uid, the way a browser sign-in gets one: a custom token
 * from the admin SDK, exchanged for an ID token at the auth emulator's own
 * identitytoolkit endpoint. The token authenticate() verifies is the one Firebase
 * Auth issued, not a hand-built JWT.
 */
async function mintIdToken(omega, uid) {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

  if (!authHost) {
    throw new Error('FIREBASE_AUTH_EMULATOR_HOST is unset — this suite needs the auth emulator');
  }

  const customToken = await omega.firebase.admin.auth().createCustomToken(uid);
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });

  const body = await response.json();

  if (!body.idToken) {
    throw new Error(`the auth emulator refused the custom token: ${JSON.stringify(body)}`);
  }

  return body.idToken;
}

// A context carrying the token the way a request does — the Authorization header
// authenticate() reads.
function contextFor(omega, idToken) {
  return new Context(omega, {
    req: { headers: { authorization: `Bearer ${idToken}` } },
  }, { functionName: 'omega_api' });
}

// Every leaf path in a doc, sorted: the SHAPE, free of the values that differ
// between two builds of the same record (api keys, uuids, timestamps).
function shapeOf(value, prefix) {
  prefix = prefix || '';

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }

  return Object.keys(value)
    .flatMap((key) => shapeOf(value[key], prefix ? `${prefix}.${key}` : key))
    .sort();
}

/**
 * The broken state this whole issue is about: a real account, established long
 * ago, with no user doc.
 *
 * Imported rather than created, for the two things the heal reads off the record:
 * a creationTime OUTSIDE the signup window (a brand-new account is on-create's,
 * not the heal's) and real federated providerData (an anonymous account gets no
 * doc anywhere). Auth's import path fires no user-creation trigger either, so
 * nothing races the heal into writing a doc of its own.
 */
async function agedAuthUser(omega, uid, options) {
  options = options || {};

  const admin = omega.firebase.admin;
  const email = `${uid}@example.com`;
  const ageMs = typeof options.ageMs === 'number' ? options.ageMs : 30 * 24 * 60 * 60 * 1000;
  const created = new Date(Date.now() - ageMs);

  await admin.auth().deleteUser(uid).catch(() => {});

  const result = await admin.auth().importUsers([{
    uid: uid,
    email: email,
    displayName: 'Aged Persona',
    metadata: { creationTime: created.toUTCString(), lastSignInTime: created.toUTCString() },
    providerData: options.anonymous ? [] : [{
      uid: email,
      email: email,
      displayName: 'Aged Persona',
      providerId: 'google.com',
    }],
  }]);

  if (result.failureCount) {
    throw new Error(`importUsers refused ${uid}: ${JSON.stringify(result.errors)}`);
  }

  await admin.firestore().doc(`users/${uid}`).delete();

  return admin.auth().getUser(uid);
}

// An account created RIGHT NOW, with its doc still to come: the signup window the
// heal stands down inside. Imported so the trigger stays out of the test's way —
// this suite drives the on-create handler itself.
async function freshAuthUser(omega, uid) {
  return agedAuthUser(omega, uid, { ageMs: 0 });
}

// The real auth:on-create handler, run on a real Auth record — how this suite
// gets the doc a signup writes without waiting on trigger timing.
async function runOnCreate(omega, authUser) {
  return onCreate({
    omega: omega,
    ctx: new Context(omega, {}, { functionName: 'omega_authOnCreate' }),
    user: authUser,
    context: EVENT_CONTEXT,
  });
}

// Leave nothing behind: the auth user goes (its on-delete takes the doc), then
// the doc itself in case the account never had a trigger to fire.
async function cleanup(omega, uid) {
  const admin = omega.firebase.admin;

  await admin.auth().deleteUser(uid).catch(() => {});
  await admin.firestore().doc(`users/${uid}`).delete().catch(() => {});
}

module.exports = defineCases({
  description: 'a missing user doc heals at sign-in (idempotent, order-proof)',
  type: 'group',
  timeout: 60000,

  tests: [
    {
      name: 'a-signed-in-user-with-a-doc-is-never-rewritten',
      run: async ({ expect, omega, accounts, firestore }) => {
        const uid = accounts.basic.uid;
        const idToken = await mintIdToken(omega, uid);

        // Snapshot AFTER the sign-in that minted the token — the pin is on the
        // authentication, not on what a sign-in itself is entitled to update.
        const before = await firestore.get(`users/${uid}`);

        expect(before?.auth?.uid, `precondition: users/${uid} should already exist`).toBeTruthy();

        const ctx = contextFor(omega, idToken);
        const user = await ctx.authenticate();

        expect(user.authenticated, 'a persona with a doc authenticates').toBe(true);
        expect(user.auth.uid, 'the authenticated uid is the token subject').toBe(uid);

        const after = await firestore.get(`users/${uid}`);

        expect(after, 'authenticating a user who HAS a doc must write nothing').toEqual(before);
      },
    },

    {
      name: 'a-missing-doc-is-recreated-at-signin',
      run: async ({ expect, omega, firestore }) => {
        const uid = '_test-heal-missing-doc';

        try {
          const authUser = await agedAuthUser(omega, uid);
          const idToken = await mintIdToken(omega, uid);

          expect(await firestore.get(`users/${uid}`), 'precondition: the doc is missing').toBe(null);

          const ctx = contextFor(omega, idToken);
          const user = await ctx.authenticate();

          expect(user.authenticated, 'the healed caller authenticates on the same request').toBe(true);

          const healed = await firestore.get(`users/${uid}`);

          expect(healed, 'the doc exists again').toBeTruthy();
          expect(healed.auth.uid, 'the doc carries its uid').toBe(uid);
          expect(healed.auth.email, 'the doc carries the Auth email').toBe(authUser.email);
          expect(healed.api?.privateKey, 'the doc carries a generated api key, like a signup doc').toBeTruthy();
          expect(healed.metadata.tag, 'the doc says out loud that it was healed').toBe(HEAL_TAG);

          // An account this old signed up long ago: re-running the signup flow at
          // it (welcome emails, affiliate credit, marketing sync) is not a heal
          expect(healed.flags.signupProcessed, 'a healed account is not sent back through signup').toBe(true);

          // The shape is auth:on-create's, not a second hand-rolled one
          const born = buildUserDoc({ ctx, user: authUser, tag: 'auth:on-create' });

          expect(shapeOf(healed), 'the healed doc has the shape a signup writes').toEqual(shapeOf(born));
          expect(healed.metadata.created, 'metadata.created comes from the Auth record').toEqual(born.metadata.created);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'the-doc-a-signin-leaves-behind-is-healed-not-trusted',
      run: async ({ expect, omega, firestore }) => {
        const uid = '_test-heal-signin-residue';

        try {
          const authUser = await agedAuthUser(omega, uid);
          const idToken = await mintIdToken(omega, uid);

          // The REAL blocking handler every sign-in runs through: it merge-writes
          // activity onto users/{uid}, so a doc-less account reaches authenticate()
          // carrying a doc that is not an account.
          await beforeSignIn({
            omega: omega,
            ctx: new Context(omega, {}, { functionName: 'omega_authBeforeSignIn' }),
            user: authUser,
            context: SIGNIN_CONTEXT,
          });

          const residue = await firestore.get(`users/${uid}`);

          expect(residue, 'precondition: the sign-in left a doc').toBeTruthy();
          expect(residue.auth, 'precondition: that doc is not an account').toBe(undefined);

          const user = await contextFor(omega, idToken).authenticate();

          expect(user.authenticated, 'a caller whose doc is nothing but sign-in residue is healed and authenticated').toBe(true);

          const healed = await firestore.get(`users/${uid}`);

          expect(healed.auth.uid, 'the residue is healed into a real account doc').toBe(uid);
          expect(healed.activity.geolocation.ip, 'the heal keeps what the sign-in already wrote').toBe(SIGNIN_CONTEXT.ipAddress);
          expect(healed.api?.privateKey, 'the account gets the api keys it never had').toBeTruthy();
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'on-create-then-heal-converges-without-clobbering',
      run: async ({ expect, omega, firestore }) => {
        const uid = '_test-heal-race-create-first';

        try {
          await runOnCreate(omega, await agedAuthUser(omega, uid));

          // Age the doc the way the live database ages one: a leaf the schema
          // gained after this account signed up. Reshaping those is the manual
          // users migration's job alone — a heal that finds a real doc must leave
          // it exactly as it is, drift included.
          const admin = omega.firebase.admin;

          await admin.firestore().doc(`users/${uid}`)
            .update({ 'subscription.trial.claimed': admin.firestore.FieldValue.delete() });

          const born = await firestore.get(`users/${uid}`);

          expect(born.metadata.tag, 'precondition: on-create wrote the doc').toBe('auth:on-create');
          expect(born.subscription.trial.claimed, 'precondition: the doc is missing a schema leaf').toBe(undefined);

          const ctx = new Context(omega, {}, { functionName: 'omega_api' });
          const returned = await healUserDoc({
            ctx: ctx,
            admin: omega.firebase.admin,
            uid: uid,
          });

          const after = await firestore.get(`users/${uid}`);

          expect(after, 'a heal arriving second must leave on-create\'s doc exactly as it is').toEqual(born);
          expect(returned.api.privateKey, 'the heal reports the doc that survived').toBe(born.api.privateKey);
          expect(after.metadata.tag, 'the tag still names the seam that created it').toBe('auth:on-create');
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'heal-then-on-create-converges-without-duplicating',
      run: async ({ expect, omega, firestore }) => {
        const uid = '_test-heal-race-heal-first';

        try {
          // An established account whose doc went missing, healed first
          const authUser = await agedAuthUser(omega, uid);
          const ctx = new Context(omega, {}, { functionName: 'omega_api' });

          await healUserDoc({
            ctx: ctx,
            admin: omega.firebase.admin,
            uid: uid,
          });

          const healed = await firestore.get(`users/${uid}`);

          expect(healed.metadata.tag, 'precondition: the heal wrote the doc').toBe(HEAL_TAG);

          // The trigger arrives afterward with the REAL Auth record it fires on
          await runOnCreate(omega, authUser);

          const after = await firestore.get(`users/${uid}`);

          expect(after, 'on-create arriving second must skip the doc the heal wrote').toEqual(healed);
          expect(after.api.privateKey, 'no second set of api keys was minted').toBe(healed.api.privateKey);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'a-healed-account-can-make-an-authenticated-request-immediately',
      run: async ({ expect, omega, http, firestore }) => {
        const uid = '_test-heal-authenticated-request';

        try {
          await agedAuthUser(omega, uid);
          const idToken = await mintIdToken(omega, uid);

          expect(await firestore.get(`users/${uid}`), 'precondition: the doc is missing').toBe(null);

          http.setAuth('bearer', { token: idToken });

          // The route is a normal authenticated read — the heal happens inside the
          // request that would previously have answered 401
          const first = await http.get('omega/user/subscription', {});

          expect(first, 'the request that healed the account also succeeds').toBeSuccess();
          expect(first, 'the account answers with its subscription').toHaveProperty('data.subscription');
          expect(await firestore.get(`users/${uid}`), 'the doc exists after the request').toBeTruthy();

          const second = await http.get('omega/user/subscription', {});

          expect(second, 'the next request succeeds too, healing nothing').toBeSuccess();
          expect((await firestore.get(`users/${uid}`)).metadata.tag, 'the second request wrote no new doc').toBe(HEAL_TAG);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'a-token-whose-account-is-gone-is-never-healed',
      run: async ({ expect, omega, firestore }) => {
        const uid = '_test-heal-deleted-account';

        try {
          await agedAuthUser(omega, uid);
          const idToken = await mintIdToken(omega, uid);

          // The account goes away while its token is still inside its hour
          await omega.firebase.admin.auth().deleteUser(uid);

          const ctx = contextFor(omega, idToken);
          const user = await ctx.authenticate();

          expect(user.authenticated, 'a deleted account does not authenticate').toBe(false);
          expect(await firestore.get(`users/${uid}`), 'the heal must never mint a doc with no auth user behind it').toBe(null);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'the-heal-refuses-a-uid-with-no-auth-user',
      run: async ({ expect, omega, firestore }) => {
        // The seam above cannot reach the heal for a deleted account — the
        // emulator's verifyIdToken refuses the token first. The guard itself is
        // what keeps the auth-less doc #399 refuses from being minted here, so it
        // is pinned directly: no auth user, no doc, ever.
        const uid = '_test-heal-no-auth-user';

        try {
          await omega.firebase.admin.firestore().doc(`users/${uid}`).delete();

          const ctx = new Context(omega, {}, { functionName: 'omega_api' });
          const healed = await healUserDoc({
            ctx: ctx,
            admin: omega.firebase.admin,
            uid: uid,
          });

          expect(healed, 'the heal reports nothing to heal').toBe(null);
          expect(await firestore.get(`users/${uid}`), 'no doc is written for a uid this project never authenticated').toBe(null);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'a-signup-still-in-flight-is-left-to-on-create',
      run: async ({ expect, omega, firestore }) => {
        // The interleaving that made this window necessary: a brand-new account
        // makes an authenticated request BEFORE auth:on-create has run. A heal
        // there would write the doc, and on-create's own "already exists" check
        // would then skip the account for good — no consumer hook, ever, and an
        // ordinary signup logged as out of sync.
        const uid = '_test-heal-signup-in-flight';

        try {
          const authUser = await freshAuthUser(omega, uid);
          const age = Date.now() - new Date(authUser.metadata?.creationTime || 0).getTime();

          expect(age < 120000, `precondition: the record should be brand new, Auth says ${authUser.metadata?.creationTime} (${Math.round(age / 1000)}s old)`).toBeTruthy();

          const ctx = new Context(omega, {}, { functionName: 'omega_api' });

          const healed = await healUserDoc({
            ctx: ctx,
            admin: omega.firebase.admin,
            uid: uid,
          });

          expect(healed, 'the heal stands down inside the signup window').toBe(null);
          expect(await firestore.get(`users/${uid}`), 'the doc is still on-create\'s to write').toBe(null);

          // on-create arrives and does its FULL job, early return untaken
          await runOnCreate(omega, authUser);

          const born = await firestore.get(`users/${uid}`);

          expect(born.metadata.tag, 'the signup doc is on-create\'s, tag and all').toBe('auth:on-create');
          expect(born.flags.signupProcessed, 'a real new signup still has its signup flow ahead of it').toBe(false);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'a-signup-window-caller-with-residue-still-authenticates',
      run: async ({ expect, omega, firestore }) => {
        // The stand-down must not cost a caller the answer they used to get. A
        // signup still in flight has a doc holding nothing but before-signin's
        // activity, and that doc authenticated its caller before the heal existed
        // — /user/signup itself arrives this way, and its 30s poll for the doc is
        // behind that authentication.
        const uid = '_test-heal-window-residue';

        try {
          const authUser = await freshAuthUser(omega, uid);
          const idToken = await mintIdToken(omega, uid);

          await beforeSignIn({
            omega: omega,
            ctx: new Context(omega, {}, { functionName: 'omega_authBeforeSignIn' }),
            user: authUser,
            context: SIGNIN_CONTEXT,
          });

          const residue = await firestore.get(`users/${uid}`);

          expect(residue, 'precondition: the sign-in left a doc').toBeTruthy();
          expect(residue.auth, 'precondition: that doc is not an account yet').toBe(undefined);

          const user = await contextFor(omega, idToken).authenticate();

          expect(user.authenticated, 'a signup in flight authenticates on its residue, exactly as it did before the heal existed').toBe(true);

          const after = await firestore.get(`users/${uid}`);

          expect(after.auth, 'the heal still wrote nothing inside the window').toBe(undefined);
          expect(after.metadata.tag, 'nothing tagged this doc a heal').toBe(undefined);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },

    {
      name: 'an-anonymous-account-is-never-given-a-doc',
      run: async ({ expect, omega, firestore }) => {
        // Anonymous accounts get no user doc anywhere in the framework — the heal
        // reads the record the same way auth:on-create does.
        const uid = '_test-heal-anonymous';

        try {
          const authUser = await agedAuthUser(omega, uid, { anonymous: true });

          expect(authUser.providerData, 'precondition: the record has no provider behind it').toEqual([]);

          const ctx = new Context(omega, {}, { functionName: 'omega_api' });
          const healed = await healUserDoc({
            ctx: ctx,
            admin: omega.firebase.admin,
            uid: uid,
          });

          expect(healed, 'the heal refuses an anonymous account').toBe(null);
          expect(await firestore.get(`users/${uid}`), 'no doc is written for one').toBe(null);
        } finally {
          await cleanup(omega, uid);
        }
      },
    },
  ],
});
