/**
 * Test: auth:on-create fires NO conversion
 * ([#577](https://github.com/Omega-JS-Stack/omega/issues/577), which moved the
 * server half of `sign_up` off this trigger).
 *
 * The trigger used to fire it ([#385](https://github.com/Omega-JS-Stack/omega/issues/385) §4),
 * and it fired blind: an auth trigger has no HTTP request behind it, so the
 * registration reached Meta and TikTok with no IP, no user agent, no platform
 * cookies and an attribution the browser had not posted yet. It now fires from
 * the post-auth request that carries all four (`routes/user/signup`, covered by
 * analytics/signup-conversion.test.js).
 *
 * Which makes THIS file's job the other half of that decision: the trigger must
 * stay silent. Two fires with one dedupe id is one registration counted twice on
 * platforms that merge them and two on the one that does not, so a well-meaning
 * re-add here is exactly the regression worth a test.
 *
 * Real handler, real omega, real ctx, real Firestore write. The record handed
 * in is a UserRecord shape for a uid that has no doc yet — the branch a genuine
 * new account takes. No Auth user is created, so the emulator's own trigger
 * never races this one; the doc it writes is deleted afterwards.
 *
 * Run: npx omega test framework:events/auth-signup-conversion
 */
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const onCreate = loadHandler(require.resolve('../../dist/omega/events/auth/on-create.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../dist/omega/context.js');

const EVENT_CONTEXT = {
  eventType: 'providers/firebase.auth/eventTypes/user.create',
  resource: { service: 'firebaseauth.googleapis.com' },
};

// A brand-new account, in the UserRecord shape the 1st-gen trigger delivers.
function newUserRecord(providerId) {
  const uid = `_test-signup-conversion-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return {
    uid: uid,
    email: `${uid}@test.invalid`,
    displayName: 'Casey Buyer',
    metadata: { creationTime: new Date().toISOString() },
    providerData: [{ providerId: providerId, email: `${uid}@test.invalid`, displayName: 'Casey Buyer' }],
  };
}

// Record every console call the handler makes, restoring console afterward.
async function withConsoleRecorder(fn) {
  const calls = { log: [], debug: [], error: [] };
  const original = { log: console.log, debug: console.debug, error: console.error };

  console.log = (...args) => calls.log.push(args);
  console.debug = (...args) => calls.debug.push(args);
  console.error = (...args) => calls.error.push(args);

  try {
    await fn();
    return calls;
  } finally {
    console.log = original.log;
    console.debug = original.debug;
    console.error = original.error;
  }
}

/** Run the real handler for a brand-new user; hand back any delivery lines. */
async function runHandler({ omega, user }) {
  const ctx = new Context(omega, {}, { functionName: 'omega_authOnCreate' });
  const admin = omega.firebase.admin;

  const calls = await withConsoleRecorder(async () => {
    await onCreate({
      omega: omega,
      ctx: ctx,
      user: user,
      context: EVENT_CONTEXT,
    });
  });

  const delivery = calls.log
    .map((args) => String(args[1]))
    .filter((line) => line.startsWith('deliverConversion: '));

  return { calls: calls, delivery: delivery };
}

module.exports = defineCases({
  description: 'auth:on-create writes the doc and fires no conversion (the post-auth request owns sign_up)',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'a-new-account-writes-its-doc-and-delivers-nothing',
      async run({ expect, omega, firestore }) {
        const user = newUserRecord('password');

        try {
          const { delivery } = await runHandler({ omega: omega, user: user });

          expect(delivery, `the trigger must fire no conversion — the post-auth request owns it: ${delivery.join(' | ')}`).toEqual([]);

          // And the account it is about actually landed.
          expect(await firestore.exists(`users/${user.uid}`), 'the handler still writes the user doc').toBe(true);
        } finally {
          await firestore.delete(`users/${user.uid}`);
        }
      },
    },

    {
      name: 'a-provider-signup-delivers-nothing-either',
      async run({ expect, omega, firestore }) {
        const user = newUserRecord('google.com');

        try {
          const { delivery } = await runHandler({ omega: omega, user: user });

          expect(delivery, `no signup path fires from the trigger: ${delivery.join(' | ')}`).toEqual([]);
        } finally {
          await firestore.delete(`users/${user.uid}`);
        }
      },
    },

    {
      name: 'an-existing-account-fires-nothing',
      async run({ expect, omega, accounts, firestore }) {
        // A provider link or a re-fired trigger is not a registration. The
        // handler returns at its "already exists" branch, before any work.
        const existing = await omega.firebase.admin.auth().getUser(accounts.basic.uid);

        expect(await firestore.exists(`users/${existing.uid}`), 'precondition: the persona already has a doc').toBe(true);

        const { delivery } = await runHandler({ omega: omega, user: existing });

        expect(delivery, `an existing account must fire no conversion: ${delivery.join(' | ')}`).toEqual([]);
      },
    },
  ],
});
