/**
 * Test: routes/user/signup/post log privacy
 * The two signup log lines name the account and the SHAPE of what moved, never the
 * payload itself ([#632](https://github.com/Omega-JS-Stack/omega/issues/632)).
 *
 * Run (from the framework repo): npm test routes/user/signup-log-privacy
 *
 * Contract:
 *   - `signup(): Starting` logs the uid and the settings' top-level key names — not the
 *     consent records, the request IP, or the attribution the payload carries.
 *   - `signup(): Writing user record` logs the uid and the record's top-level key names.
 *     buildUserRecord() deliberately preserves the existing doc's `api` keys, so
 *     serializing that record wrote a live private key into Cloud Logging.
 *
 * Pure: keyNames has no I/O, and the `Starting` line is written before the route touches
 * Firestore — the call is allowed to reject at that seam and the assertions read the
 * captured ctx output.
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const post = loadHandler(require.resolve('../../../dist/omega/routes/user/signup/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const { keyNames } = require('../../../dist/omega/routes/user/signup/record-fields.js');

const LEAKED_KEY = 'sk_test_fake_leak';
const LEAKED_IP = '203.0.113.7';

// The merged shape buildUserRecord() writes: the existing doc's api keys survive into it.
const USER_RECORD = {
  auth: { uid: 'user-632', email: 'recipient@test.dev' },
  api: { clientId: 'client-632', privateKey: LEAKED_KEY },
  consent: { marketing: { status: 'granted', ip: LEAKED_IP } },
  attribution: { source: 'newsletter' },
  flags: { signupProcessed: true },
};

// A signup request payload carrying the same kind of material.
const SETTINGS = {
  uid: 'user-632',
  api: { privateKey: LEAKED_KEY },
  consent: { marketing: { granted: true, ip: LEAKED_IP } },
  attribution: { source: 'newsletter' },
  context: { client: { ip: LEAKED_IP } },
};

async function captureStartingLine() {
  const captured = [];
  const record = (...args) => captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

  // No Firestore here — the route rejects at the first poll, long after the line under
  // test was written. The assertions are on the log, not the result.
  const ctx = {
    omega: { firebase: { admin: {} } },
    log: record,
    warn: record,
    error: record,
    respond: () => null,
  };
  const user = { authenticated: true, auth: { uid: SETTINGS.uid, email: 'recipient@test.dev' }, roles: {} };

  await post({ ctx, omega: ctx.omega, user, data: SETTINGS }).catch(() => {});

  return captured.find((line) => line.includes('signup(): Starting'));
}

module.exports = defineCases({
  description: 'routes/user/signup/post log privacy',
  type: 'group',

  tests: [
    {
      name: 'starting-line-names-the-uid-and-the-shape-only',
      async run({ expect }) {
        const line = await captureStartingLine();

        expect(line, 'no signup(): Starting line was logged').toBeTruthy();
        expect(line.includes('user-632'), `line does not name the account: ${line}`).toBeTruthy();
        expect(line.includes('consent'), `line lost the payload shape: ${line}`).toBeTruthy();
      },
    },

    {
      name: 'starting-line-never-serializes-the-settings-payload',
      async run({ expect }) {
        const line = await captureStartingLine();

        expect(!line.includes('privateKey'), `nested payload serialized into the line: ${line}`).toBeTruthy();
        expect(!line.includes(LEAKED_KEY), `private key written to the line: ${line}`).toBeTruthy();
        expect(!line.includes(LEAKED_IP), `request IP written to the line: ${line}`).toBeTruthy();
      },
    },

    {
      name: 'user-record-renders-as-key-names-never-values',
      async run({ expect }) {
        const rendered = keyNames(USER_RECORD);

        expect(rendered.includes('api'), `the record shape is gone: ${rendered}`).toBeTruthy();
        expect(!rendered.includes('privateKey'), `a nested key leaked: ${rendered}`).toBeTruthy();
        expect(!rendered.includes(LEAKED_KEY), `the private key leaked: ${rendered}`).toBeTruthy();
        expect(!rendered.includes(LEAKED_IP), `the request IP leaked: ${rendered}`).toBeTruthy();
      },
    },

    {
      name: 'nothing-to-render-says-none',
      async run({ expect }) {
        expect(keyNames({}), 'an empty payload renders as (none)').toBe('(none)');
        expect(keyNames(null), 'a missing payload renders as (none)').toBe('(none)');
      },
    },
  ],
});
