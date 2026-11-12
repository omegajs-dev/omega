/**
 * Test: the three remaining auth triggers open with the uid and nothing else
 * ([#657](https://github.com/Omega-JS-Stack/omega/issues/657)).
 *
 * `beforeCreate`, `beforeSignIn` and `onDelete` each used to open with
 * `ctx.log(..., user, context)` — the whole Firebase user record (email, display
 * name, provider data, password hash) plus the trigger context (IP, user agent,
 * credential) into Cloud Logging, on every signup and every sign-in. The headline
 * is now the uid alone, the #641 shape `onCreate` already carries, and the fat
 * payload sits one level down at `debug` — silent on a normal run, one
 * `OMEGA_DEBUG=1` away.
 *
 * Pure: the log seam #632 added is `ctx` itself, so a recorder in its place reads
 * every line the handler writes with no emulator, no admin SDK and no ports. The
 * only stand-ins are that recorder and the Firestore/Usage doubles the handlers
 * reach for AFTER the line under test.
 *
 * Note on the IP: `beforeCreate`'s rate-limit lines still name the client IP,
 * deliberately — it is the rate limiter's KEY, not the user's identity. The line
 * this test is about is the headline, and the headline is asserted whole.
 *
 * Run: npx omega test framework:events/auth-trigger-log-privacy
 */
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const beforeCreate = loadHandler(require.resolve('../../dist/omega/events/auth/before-create.js'));
const beforeSignIn = loadHandler(require.resolve('../../dist/omega/events/auth/before-signin.js'));
const onDelete = loadHandler(require.resolve('../../dist/omega/events/auth/on-delete.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const UID = '_test-657-uid';
const EMAIL = 'leaky.person@omegajs-test.dev';
const DISPLAY_NAME = 'Leaky Person';
const IP = '203.0.113.9';

// A UserRecord the way both trigger flavors receive it — the material that used
// to ride the headline.
const USER = {
  uid: UID,
  email: EMAIL,
  emailVerified: true,
  displayName: DISPLAY_NAME,
  photoURL: 'https://cdn.omegajs-test.dev/leaky-person.png',
  passwordHash: 'hash-657',
  providerData: [{ providerId: 'password', uid: EMAIL, email: EMAIL, displayName: DISPLAY_NAME }],
  metadata: { creationTime: '2026-08-30T00:00:00Z', lastSignInTime: '2026-08-30T00:00:00Z' },
};

// AuthEventContext (blocking functions): carries the IP, the user agent, the locale.
const AUTH_CONTEXT = {
  ipAddress: IP,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  locale: 'en-US',
  eventId: 'event-657',
  additionalUserInfo: { providerId: 'password', email: EMAIL, isNewUser: true },
};

// EventContext (1st-gen triggers): no IP, no user agent.
const EVENT_CONTEXT = {
  eventId: 'event-657',
  eventType: 'providers/firebase.auth/eventTypes/user.delete',
  resource: { service: 'firebaseauth.googleapis.com' },
};

// The log seam: every level the handlers write to, recorded verbatim.
function createRecorder() {
  const calls = { log: [], debug: [], error: [] };
  const record = (level) => (...args) => calls[level].push(args);

  return {
    calls: calls,
    ctx: { log: record('log'), debug: record('debug'), error: record('error') },
  };
}

// A call as one string, the way it lands in Cloud Logging.
function render(args) {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

// No hooks/auth/*.js under this dir, so the consumer hook lookup is a no-op.
const OMEGA = { cwd: __dirname, config: { auth: { signup: { maxPerIpPerDay: 2 } } } };

async function runBeforeCreate() {
  const { calls, ctx } = createRecorder();

  // The rate limiter is the handler's real path: only the usage counter is a
  // double (configure/forKey/consume, the #647 shape the gate calls).
  const counter = {
    configure: () => counter,
    forKey: () => counter,
    consume: async () => ({ used: 1, left: 1, day: { used: 1, left: 1 } }),
  };
  const omega = { ...OMEGA, firebase: { functions: {} } };

  ctx.usage = counter;

  await beforeCreate({ ctx: ctx, omega: omega, user: USER, context: AUTH_CONTEXT });

  return calls;
}

async function runBeforeSignIn() {
  const { calls, ctx } = createRecorder();
  const admin = { firestore: () => ({ doc: () => ({ set: async () => undefined }) }) };

  await beforeSignIn({ ctx: ctx, omega: { ...OMEGA, firebase: { admin } }, user: USER, context: AUTH_CONTEXT });

  return calls;
}

async function runOnDelete() {
  const { calls, ctx } = createRecorder();

  // No user doc, so the handler writes its headline and returns before the
  // delete, the marketing removal and the conversion.
  const admin = { firestore: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };

  await onDelete({ ctx: ctx, omega: { ...OMEGA, firebase: { admin } }, user: USER, context: EVENT_CONTEXT });

  return calls;
}

// What the marketing library answers `remove()` with: one entry per enabled
// provider, each carrying that provider's own payload — the address included.
const MARKETING_RESULT = {
  campaigns: { success: true, jobId: 'job-710', contact: { email: EMAIL, name: DISPLAY_NAME } },
  newsletter: { success: true, subscriber: { id: 'sub-710', email: EMAIL } },
};

// The full run: an existing doc, so the handler goes past its headline into the
// delete, the marketing removal and the conversion. The marketing removal is
// fire-and-forget, so the caller drains the microtask queue before reading.
async function runOnDeleteWithDoc() {
  const { calls, ctx } = createRecorder();

  const admin = {
    firestore: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ auth: { uid: UID, email: EMAIL } }) }),
        delete: async () => undefined,
      }),
    }),
  };

  const omega = { ...OMEGA, firebase: { admin } };

  ctx.email = { remove: async () => MARKETING_RESULT };

  await onDelete({ ctx: ctx, omega: omega, user: USER, context: EVENT_CONTEXT });
  await new Promise((resolve) => setImmediate(resolve));

  return calls;
}

// The two claims every trigger makes, asserted the same way for each.
function assertHeadlineIsUidAlone({ expect, calls, tag }) {
  const headline = calls.log[0];

  expect(headline, `${tag}: no headline line was logged`).toBeTruthy();
  expect(headline[0], `${tag}: headline is not the uid alone: ${render(headline)}`).toBe(`${tag}: ${UID}`);
  expect(headline.length, `${tag}: the headline carries a payload: ${render(headline.slice(1))}`).toBe(1);
}

function assertNothingPrivateRidesTheLog({ expect, calls, tag, context }) {
  const written = [...calls.log, ...calls.error];

  for (const args of written) {
    const line = render(args);

    expect(line.includes(EMAIL), `${tag}: email written to a log line: ${line}`).toBe(false);
    expect(line.includes(DISPLAY_NAME), `${tag}: display name written to a log line: ${line}`).toBe(false);
    expect(args.includes(USER), `${tag}: the user record rides a log line: ${line}`).toBe(false);
    expect(args.includes(context), `${tag}: the trigger context rides a log line: ${line}`).toBe(false);
  }

  // Not deleted — moved behind the debug gate, which is dropped whole unless
  // OMEGA_DEBUG is set.
  const records = calls.debug.filter((args) => args.includes(USER) && args.includes(context));

  expect(records.length, `${tag}: the full record should stay reachable at debug level`).toBe(1);
}

module.exports = defineCases({
  description: 'auth triggers log the uid only',
  type: 'group',

  tests: [
    {
      name: 'before-create-headline-is-the-uid-alone',
      async run({ expect }) {
        assertHeadlineIsUidAlone({ expect: expect, calls: await runBeforeCreate(), tag: 'beforeCreate' });
      },
    },

    {
      name: 'before-create-never-logs-the-record-or-the-context',
      async run({ expect }) {
        assertNothingPrivateRidesTheLog({ expect: expect, calls: await runBeforeCreate(), tag: 'beforeCreate', context: AUTH_CONTEXT });
      },
    },

    {
      name: 'before-signin-headline-is-the-uid-alone',
      async run({ expect }) {
        assertHeadlineIsUidAlone({ expect: expect, calls: await runBeforeSignIn(), tag: 'beforeSignIn' });
      },
    },

    {
      name: 'before-signin-never-logs-the-record-or-the-context',
      async run({ expect }) {
        assertNothingPrivateRidesTheLog({ expect: expect, calls: await runBeforeSignIn(), tag: 'beforeSignIn', context: AUTH_CONTEXT });
      },
    },

    {
      name: 'on-delete-headline-is-the-uid-alone',
      async run({ expect }) {
        assertHeadlineIsUidAlone({ expect: expect, calls: await runOnDelete(), tag: 'onDelete' });
      },
    },

    {
      name: 'on-delete-never-logs-the-record-or-the-context',
      async run({ expect }) {
        assertNothingPrivateRidesTheLog({ expect: expect, calls: await runOnDelete(), tag: 'onDelete', context: EVENT_CONTEXT });
      },
    },

    // ─── The marketing removal's own line ([#710]) ───

    {
      name: 'on-delete-marketing-remove-logs-the-uid-and-a-count',
      async run({ expect }) {
        const calls = await runOnDeleteWithDoc();
        const line = calls.log.find((args) => String(args[0]).includes('Marketing remove'));

        expect(line, `no marketing-remove line was logged: ${calls.log.map(render).join(' | ')}`).toBeTruthy();
        expect(line.length, `the line carries the provider result: ${render(line.slice(1))}`).toBe(1);
        expect(render(line), 'the line should name the account the removal was for').toMatch(new RegExp(UID));
        expect(render(line), 'the line should count the providers that answered').toMatch(/2/);
      },
    },

    {
      name: 'on-delete-marketing-remove-keeps-the-result-behind-the-debug-gate',
      async run({ expect }) {
        const calls = await runOnDeleteWithDoc();

        for (const args of [...calls.log, ...calls.error]) {
          expect(args.includes(MARKETING_RESULT), `the provider result rides a log line: ${render(args)}`).toBe(false);
          expect(render(args).includes(EMAIL), `email written to a log line: ${render(args)}`).toBe(false);
        }

        const records = calls.debug.filter((args) => args.includes(MARKETING_RESULT));

        expect(records.length, 'the provider result should stay reachable at debug level').toBe(1);
      },
    },
  ],
});
