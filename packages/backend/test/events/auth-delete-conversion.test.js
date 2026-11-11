/**
 * Test: auth:on-delete fires `user_delete` as a CANONICAL conversion
 * ([#328](https://github.com/Omega-JS-Stack/omega/issues/328)).
 *
 * The handler used to reach `Analytics(...).event('user_delete')`
 * directly — the right NAME, but past the consent gate and past the catalog's
 * per-provider walk. It now goes through `deliverConversion`, which is what
 * makes it the same kind of event as every other server conversion.
 *
 * THE DEDUPE ID IS `user_delete.<uid>`. An account is deleted once; a
 * redelivered trigger must report the same event, not a second one.
 *
 * The load-bearing ordering detail: the consent snapshot is read from the user
 * doc BEFORE the delete, because the delete is the moment it stops existing. An
 * ABSENT snapshot GRANTS (the standing rule) — a legacy account predating the
 * consent system is still counted.
 *
 * Real handler, real omega, real ctx, real Firestore delete. The doc is
 * seeded directly and the UserRecord is a plain object, so no Auth user exists
 * and the emulator's own trigger never races this one.
 *
 * Run: npx omega test framework:events/auth-delete-conversion
 */
const onDelete = require('../../dist/omega/events/auth/on-delete.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../dist/omega/context.js');

const EVENT_CONTEXT = {
  eventType: 'providers/firebase.auth/eventTypes/user.delete',
  resource: { service: 'firebaseauth.googleapis.com' },
};

function testUid() {
  return `_test-delete-conversion-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

/** Seed a user doc, run the real handler against it, hand back the delivery lines. */
async function runHandler({ omega, uid, doc }) {
  const ctx = new Context(omega, {}, { functionName: 'omega_authOnDelete' });
  const admin = omega.firebase.admin;

  await admin.firestore().doc(`users/${uid}`).set(doc);

  const calls = await withConsoleRecorder(async () => {
    await onDelete({
      omega: omega,
      ctx: ctx,
      user: { uid: uid, email: `${uid}@test.invalid` },
      context: EVENT_CONTEXT,
    });
  });

  const delivery = calls.log
    .map((args) => String(args[1]))
    .filter((line) => line.startsWith('deliverConversion: '));

  return { calls: calls, delivery: delivery };
}

module.exports = defineCases({
  description: 'auth:on-delete fires the canonical user_delete conversion',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'a-deleted-account-fires-user-delete-with-the-uid-derived-dedupe-id',
      async run({ expect, omega, firestore }) {
        const uid = testUid();

        try {
          const { delivery } = await runHandler({
            omega: omega,
            uid: uid,
            doc: { auth: { uid: uid, email: `${uid}@test.invalid` } },
          });

          expect(delivery.length, `expected one conversion delivery, got ${delivery.length}: ${delivery.join(' | ')}`).toBe(1);
          expect(delivery[0].startsWith('deliverConversion: user_delete →'), delivery[0]).toBe(true);
          expect(delivery[0].includes(`(event_id=user_delete.${uid})`), `the uid is what the deletion is about: ${delivery[0]}`).toBe(true);

          // GA4 only — an account ending is nothing an ad platform maps.
          for (const provider of ['meta', 'tiktok']) {
            expect(delivery[0].includes(`${provider} skipped (no mapping)`), `${provider} has no mapping: ${delivery[0]}`).toBe(true);
          }

          // An account with no snapshot at all is still counted.
          expect(delivery[0].includes('google skipped (consent'), `an absent snapshot grants: ${delivery[0]}`).toBe(false);
          expect(await firestore.exists(`users/${uid}`), 'the handler still deletes the doc').toBe(false);
        } finally {
          await firestore.delete(`users/${uid}`);
        }
      },
    },

    {
      name: 'a-declined-snapshot-read-before-the-delete-blocks-the-fire',
      async run({ expect, omega, firestore }) {
        const uid = testUid();

        try {
          const { delivery } = await runHandler({
            omega: omega,
            uid: uid,
            doc: {
              auth: { uid: uid, email: `${uid}@test.invalid` },
              trackingConsent: { analytics: false, marketing: false, region: 'opt-in', version: 1 },
            },
          });

          expect(delivery.length, delivery.join(' | ')).toBe(1);
          expect(delivery[0].includes('google skipped (consent: analytics)'), `the snapshot the doc carried still gates the fire after the doc is gone: ${delivery[0]}`).toBe(true);
        } finally {
          await firestore.delete(`users/${uid}`);
        }
      },
    },
  ],
});
