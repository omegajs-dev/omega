/**
 * Test: auth:on-create logs ONE headline line
 * ([#230](https://github.com/Omega-JS-Stack/omega/issues/230)).
 *
 * The handler used to dump the whole UserRecord (providerData, passwordHash,
 * metadata) plus the event context onto its opening line — per created user, which
 * buries a dev-boot seed. The headline is now `onCreate: <uid>` and nothing else
 * — the address came off it in the #710 pass, so all four auth triggers spell
 * their headline the one way the #657 sweep set; the full record stays reachable
 * one level down, at debug — silent on a normal run, one `OMEGA_DEBUG=1` away.
 *
 * Real everything: a seeded persona's REAL UserRecord from the emulator's Auth,
 * the real omega and ctx, the real handler. The persona already has a user doc,
 * so the handler logs its headline and returns at the "already exists" branch —
 * no writes, nothing to clean up. The only stand-in is `console`, the sink.
 *
 * Run: npx omega test framework:events/auth-on-create-log
 */

const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const onCreate = loadHandler(require.resolve('../../dist/omega/events/auth/on-create.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../dist/omega/context.js');

// Record every console call the thunk makes, restoring console afterward.
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

// A call as one string, the way it lands in Cloud Logging: an address hides just
// as well inside a payload ARGUMENT as in the message, so a scan that only reads
// string args cannot see it. Same rendering email/marketing/remove-log-privacy
// scans with.
function render(args) {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

// The handler forwards the event context straight to the debug line and to the
// consumer hook — this is the 1st-gen EventContext shape for a user creation.
const EVENT_CONTEXT = {
  eventType: 'providers/firebase.auth/eventTypes/user.create',
  resource: { service: 'firebaseauth.googleapis.com' },
};

// The persona's user doc must already exist — that is what sends the handler down
// its read-only "already exists" branch. Checked before every call so a missing doc
// fails the test instead of quietly rewriting a shared account.
async function assertDocExists({ expect, firestore, user }) {
  const doc = await firestore.get(`users/${user.uid}`);

  expect(!!doc?.auth?.uid, `precondition: users/${user.uid} should already exist`).toBe(true);
}

// Run the thunk with the debug switch in a known state — the logger reads it live.
async function withDebug(value, fn) {
  const saved = process.env.OMEGA_DEBUG;

  if (value === undefined) {
    delete process.env.OMEGA_DEBUG;
  } else {
    process.env.OMEGA_DEBUG = value;
  }

  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.OMEGA_DEBUG;
    } else {
      process.env.OMEGA_DEBUG = saved;
    }
  }
}

async function runHandler({ omega, user, debug }) {
  const ctx = new Context(omega, {}, { functionName: 'omega_authOnCreate' });
  const admin = omega.firebase.admin;

  const calls = await withConsoleRecorder(async () => {
    await withDebug(debug, async () => {
      await onCreate({
        omega: omega,
        ctx: ctx,
        user: user,
        context: EVENT_CONTEXT,
      });
    });
  });

  return { calls: calls, headlines: calls.log.filter((args) => args[1] === `onCreate: ${user.uid}`) };
}

module.exports = defineCases({
  description: 'auth:on-create logs one headline line, full record at debug',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'headline-is-the-uid-alone',
      run: async ({ expect, omega, accounts, firestore }) => {
        const user = await omega.firebase.admin.auth().getUser(accounts.basic.uid);

        await assertDocExists({ expect: expect, firestore: firestore, user: user });

        const { calls, headlines } = await runHandler({ omega: omega, user: user, debug: undefined });

        expect(headlines.length, `expected one headline line, got ${headlines.length}`).toBe(1);
        expect(headlines[0][1], headlines[0][1]).toBe(`onCreate: ${user.uid}`);

        // Prefix + message and nothing else — the record is off this line.
        expect(headlines[0].length, `the headline carries a payload: ${JSON.stringify(headlines[0].slice(2)).slice(0, 200)}`).toBe(2);

        // And the address is off every line, not just moved along the headline.
        const leaked = calls.log.filter((args) => render(args).includes(user.email));

        expect(leaked.length, `the email must not ride any log line: ${leaked.map(render).join(' | ').slice(0, 200)}`).toBe(0);
      },
    },

    {
      name: 'the-record-does-not-print-on-a-normal-run',
      run: async ({ expect, omega, accounts, firestore }) => {
        const user = await omega.firebase.admin.auth().getUser(accounts.basic.uid);

        await assertDocExists({ expect: expect, firestore: firestore, user: user });

        const { calls } = await runHandler({ omega: omega, user: user, debug: undefined });

        expect(calls.debug.length, 'the record must stay behind the debug gate by default').toBe(0);
        expect(calls.log.filter((args) => args.includes(user)).length, 'the record must not ride any log line').toBe(0);
      },
    },

    {
      name: 'the-full-record-is-reachable-with-omega-debug',
      run: async ({ expect, omega, accounts, firestore }) => {
        const user = await omega.firebase.admin.auth().getUser(accounts.basic.uid);

        await assertDocExists({ expect: expect, firestore: firestore, user: user });

        const { calls } = await runHandler({ omega: omega, user: user, debug: '1' });

        const records = calls.debug.filter((args) => args.includes(user));

        expect(records.length, 'the full UserRecord should log once at debug level').toBe(1);
        expect(records[0].includes(EVENT_CONTEXT), 'the event context should ride the debug line too').toBe(true);
      },
    },
  ],
});
