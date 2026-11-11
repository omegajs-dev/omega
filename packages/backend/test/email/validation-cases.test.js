/**
 * Email validation case corpus — verifies all free checks (format, disposable,
 * corporate, localPart, typo, dns) plus NeverBounce result parsing (no API calls).
 *
 * The behavior-by-behavior suite lives next door in validation.test.js; this file is
 * the broad address corpus — one test per address, one per parse code.
 */
const { validate } = require('../../dist/omega/libraries/email/validation.js');
const { parseResult } = require('../../dist/omega/libraries/email/validation-provider-neverbounce.js');
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const FREE_CHECKS = ['format', 'disposable', 'corporate', 'localPart', 'typo', 'dns'];

const CASES = [
  // ---- Should PASS ----
  { email: 'user@gmail.com', expect: 'pass' },
  { email: 'someone@yahoo.com', expect: 'pass' },
  { email: 'hello@outlook.com', expect: 'pass' },
  { email: 'sarah@protonmail.com', expect: 'pass' },
  { email: 'first.last@microsoft.com', expect: 'pass' },
  { email: 'user+tag@gmail.com', expect: 'pass' },
  { email: 'john@icloud.com', expect: 'pass' },
  { email: 'user@aol.com', expect: 'pass' },
  { email: 'user@hotmail.com', expect: 'pass' },

  // ---- Should FAIL: format ----
  { email: '', expect: 'fail', check: 'format' },
  { email: 'notanemail', expect: 'fail', check: 'format' },
  { email: '@nodomain.com', expect: 'fail', check: 'format' },
  { email: 'noat.com', expect: 'fail', check: 'format' },
  { email: 'spaces in@email.com', expect: 'fail', check: 'format' },

  // ---- Should FAIL: disposable (vendor list) ----
  { email: 'test@mailinator.com', expect: 'fail', check: 'disposable' },
  { email: 'test@guerrillamail.com', expect: 'fail', check: 'disposable' },
  { email: 'user@yopmail.com', expect: 'fail', check: 'disposable' },

  // ---- Should FAIL: disposable (custom list) ----
  { email: 'test@dollicons.com', expect: 'fail', check: 'disposable' },
  { email: 'test@availors.com', expect: 'fail', check: 'disposable' },
  { email: 'test@sharebot.net', expect: 'fail', check: 'disposable' },
  { email: 'test@deltajohnsons.com', expect: 'fail', check: 'disposable' },
  { email: 'test@gmail10p.com', expect: 'fail', check: 'disposable' },
  { email: 'test@dyzov.com', expect: 'fail', check: 'disposable' },
  { email: 'test@mailpwr.com', expect: 'fail', check: 'disposable' },
  { email: 'test@closetab.email', expect: 'fail', check: 'disposable' },
  { email: 'test@biosu.dev', expect: 'fail', check: 'disposable' },
  { email: 'test@wikfee.com', expect: 'fail', check: 'disposable' },
  { email: 'test@oakon.com', expect: 'fail', check: 'disposable' },

  // ---- Should FAIL: corporate ----
  { email: 'user@instagram.com', expect: 'fail', check: 'corporate' },
  { email: 'user@facebook.com', expect: 'fail', check: 'corporate' },

  // ---- Should FAIL: localPart (exact) ----
  { email: 'noreply@gmail.com', expect: 'fail', check: 'localPart' },
  { email: 'no-reply@gmail.com', expect: 'fail', check: 'localPart' },

  // ---- Should FAIL: localPart (patterns) ----
  { email: 'aaaa@gmail.com', expect: 'fail', check: 'localPart' },
  { email: 'testuser@gmail.com', expect: 'fail', check: 'localPart' },
  { email: '_test.basic@somiibo.com', expect: 'fail', check: 'localPart' },
  { email: '_test.allow_consent-granted@somiibo.com', expect: 'pass' },

  // ---- Should FAIL: typo domains ----
  { email: 'user@gamil.com', expect: 'fail', check: 'typo' },
  { email: 'user@gamil.con', expect: 'fail', check: 'typo' },
  { email: 'user@gmai.com', expect: 'fail', check: 'typo' },
  { email: 'user@gmai.co', expect: 'fail', check: 'typo' },
  { email: 'user@gmial.com', expect: 'fail', check: 'disposable' },
  { email: 'user@gnail.com', expect: 'fail', check: 'typo' },
  { email: 'user@gmail.con', expect: 'fail', check: 'typo' },
  { email: 'user@gmail.cok', expect: 'fail', check: 'typo' },
  { email: 'user@gmail.cm', expect: 'fail', check: 'typo' },
  { email: 'user@aol.con', expect: 'fail', check: 'typo' },
  { email: 'user@icloud.con', expect: 'fail', check: 'typo' },
  { email: 'user@hotmail.con', expect: 'fail', check: 'typo' },
  { email: 'user@hotmial.com', expect: 'fail', check: 'disposable' },
  { email: 'user@hotnail.com', expect: 'fail', check: 'typo' },
  { email: 'user@outlook.con', expect: 'fail', check: 'typo' },
  { email: 'user@outlok.com', expect: 'fail', check: 'typo' },
  { email: 'user@yahoo.con', expect: 'fail', check: 'typo' },
  { email: 'user@protonmial.com', expect: 'fail', check: 'typo' },
  { email: 'user@oegmail.com', expect: 'fail', check: 'typo' },

  // ---- Should FAIL: dns (no MX / null MX / domain not found) ----
  { email: 'someone@thisdoesnotexist99887766.com', expect: 'fail', check: 'dns' },
  { email: 'someone@zzzznotreal123456.net', expect: 'fail', check: 'dns' },
  { email: 'someone@example.com', expect: 'fail', check: 'dns' },
];

// NeverBounce single-check `result` parsing — the API returns STRING textcodes.
// Regression: @omega.js/backend 5.5.1–5.6.1 compared against numbers, failing every mailbox
// check and silently skipping marketing sync for all signups.
const NB_PARSE_CASES = [
  { result: 'valid', expectValid: true, expectStatus: 'valid' },
  { result: 'catchall', expectValid: true, expectStatus: 'catchall' },
  { result: 'catch-all', expectValid: true, expectStatus: 'catchall' },
  { result: 'unknown', expectValid: true, expectStatus: 'unknown' },
  { result: 'invalid', expectValid: false, expectStatus: 'invalid' },
  { result: 'disposable', expectValid: false, expectStatus: 'disposable' },
  { result: 0, expectValid: true, expectStatus: 'valid' },
  { result: 1, expectValid: false, expectStatus: 'invalid' },
  { result: 2, expectValid: false, expectStatus: 'disposable' },
  { result: 3, expectValid: true, expectStatus: 'catchall' },
  { result: 4, expectValid: true, expectStatus: 'unknown' },
];

module.exports = defineCases({
  description: 'Email validation case corpus (free checks + NeverBounce parsing)',
  type: 'group',
  tests: [
    ...NB_PARSE_CASES.map(({ result, expectValid, expectStatus }) => ({
      name: `parseResult(${JSON.stringify(result)})`,

      run() {
        const parsed = parseResult(result);

        expect(parsed.valid, `Expected valid=${expectValid}, got ${parsed.valid}`).toBe(expectValid);
        expect(parsed.status, `Expected status=${expectStatus}, got ${parsed.status}`).toBe(expectStatus);
      },
    })),

    ...CASES.map(({ email, expect: expected, check: expectedCheck }) => ({
      name: `${expected}: ${email || '(empty)'}`,
      timeout: 10000,
      // Negative DNS cases need a live NXDOMAIN answer — extended-only, matching
      // validation.test.js. Pass cases keep the dns check: it is offline-safe
      // (network errors skip; only definitive no-MX/NXDOMAIN answers block).
      skip: expectedCheck === 'dns' && !process.env.TEST_EXTENDED_MODE
        ? 'TEST_EXTENDED_MODE not set (requires live DNS resolution)'
        : false,

      async run() {
        const result = await validate(email, { checks: FREE_CHECKS });
        const failedCheck = Object.entries(result.checks).find(([, v]) => v && !v.valid);

        expect(result.valid, `Expected: ${expected}, Got: ${result.valid ? 'pass' : 'fail'}${failedCheck ? ` (${[failedCheck[0], failedCheck[1].reason].filter(Boolean).join(': ')})` : ''}`).toBe(expected === 'pass');

        // A failing case must fail on the check it was written for.
        if (expectedCheck && !result.valid && failedCheck) {
          expect(failedCheck[0], `Expected to fail on: ${expectedCheck}, actually failed on: ${failedCheck[0]}`).toBe(expectedCheck);
        }
      },
    })),
  ],
});
