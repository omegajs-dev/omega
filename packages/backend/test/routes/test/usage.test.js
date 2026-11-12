/**
 * Test: POST /test/usage
 * Tests the usage tracking API through `consume`
 * ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)) — one call
 * checks, counts and writes, and the response reports what is LEFT of both
 * counters rather than the raw fields.
 * This is a suite because we need to track state and verify the counting
 */

const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
module.exports = defineCases({
  description: 'Usage tracking API',
  type: 'suite',
  timeout: 30000,

  tests: [
    // Test 1: Store initial usage state
    {
      name: 'store-initial-usage',
      async run({ firestore, expect, state, accounts }) {
        // Get the basic account's current usage to track changes
        const userDoc = await firestore.get(`users/${accounts.basic.uid}`);

        state.initialUsage = userDoc?.usage || {};

        // Store initial values for the requests feature (may not exist yet)
        state.initialMonthly = state.initialUsage?.requests?.monthly || 0;
        state.initialDaily = state.initialUsage?.requests?.daily || 0;

        expect(true, 'Initial usage state captured').toBeTruthy();
      },
    },

    // Test 2: Consume usage with default values
    {
      name: 'consume-default',
      async run({ http, expect, state }) {
        const response = await http.as('basic').post('omega/test/usage', {});

        expect(response, 'Usage consume should succeed').toBeSuccess();
        expect(response, 'Response should contain the feature name').toHaveProperty('data.feature');
        expect(response, 'Response should contain amount').toHaveProperty('data.amount');
        expect(response, 'Response should contain before values').toHaveProperty('data.before');
        expect(response, 'Response should contain after values').toHaveProperty('data.after');

        // Verify defaults
        expect(response.data.feature, 'Feature should be requests').toBe('requests');
        expect(response.data.amount, 'Default amount should be 1').toBe(1);

        // Verify the month counter moved
        expect(response.data.after.used, 'The month counter should move by 1').toBe(response.data.before.used + 1);

        // Verify the day counter moved
        expect(response.data.after.day.used, 'The day counter should move by 1').toBe(response.data.before.day.used + 1);

        // Store for next test
        state.afterFirstConsume = response.data.after;
      },
    },

    // Test 3: Verify usage persisted to Firestore
    {
      name: 'verify-usage-persisted',
      async run({ firestore, expect, state, accounts }) {
        const userDoc = await firestore.get(`users/${accounts.basic.uid}`);

        expect(userDoc?.usage, 'User should have usage object').toBeTruthy();
        expect(userDoc?.usage?.requests, 'User should have requests usage').toBeTruthy();

        expect(userDoc.usage.requests.monthly, 'Persisted monthly should match API response').toBe(state.afterFirstConsume.used);
        expect(userDoc.usage.requests.daily, 'Persisted daily should match API response').toBe(state.afterFirstConsume.day.used);
        expect(userDoc.usage.requests.total > 0, 'Total should be counted too').toBeTruthy();

        // Verify last timestamp exists
        expect(userDoc.usage.requests.last, 'Should have last object').toBeTruthy();
        expect(userDoc.usage.requests.last.timestamp, 'Should have last.timestamp').toBeTruthy();
        expect(userDoc.usage.requests.last.timestampUNIX, 'Should have last.timestampUNIX').toBeTruthy();
      },
    },

    // Test 4: Consume a custom amount
    {
      name: 'consume-custom-amount',
      async run({ http, expect, state }) {
        const response = await http.as('basic').post('omega/test/usage', {
          amount: 5,
        });

        expect(response, 'Custom amount consume should succeed').toBeSuccess();
        expect(response.data.amount, 'Amount should be 5').toBe(5);

        // Verify both counters moved by 5
        expect(response.data.after.used, 'The month counter should move by 5').toBe(response.data.before.used + 5);
        expect(response.data.after.day.used, 'The day counter should move by 5').toBe(response.data.before.day.used + 5);

        state.afterCustomAmount = response.data.after;
      },
    },

    // Test 5: Verify custom amount persisted
    {
      name: 'verify-custom-amount-persisted',
      async run({ firestore, expect, state, accounts }) {
        const userDoc = await firestore.get(`users/${accounts.basic.uid}`);

        expect(userDoc?.usage?.requests, 'User should have requests usage').toBeTruthy();

        expect(userDoc.usage.requests.monthly, 'Requests monthly should be persisted').toBe(state.afterCustomAmount.used);
        expect(userDoc.usage.requests.daily, 'Requests daily should be persisted').toBe(state.afterCustomAmount.day.used);
      },
    },

    // Test 6: Multiple consumes accumulate
    {
      name: 'multiple-consumes-accumulate',
      async run({ http, expect, state }) {
        // First consume
        const response1 = await http.as('basic').post('omega/test/usage', {});

        expect(response1, 'First consume should succeed').toBeSuccess();

        // Second consume
        const response2 = await http.as('basic').post('omega/test/usage', {});

        expect(response2, 'Second consume should succeed').toBeSuccess();

        // Third consume with a custom amount
        const response3 = await http.as('basic').post('omega/test/usage', {
          amount: 3,
        });

        expect(response3, 'Third consume should succeed').toBeSuccess();

        // Verify accumulation: should be initial + 1 (test 2) + 5 (test 4) + 1 + 1 + 3 = initial + 11
        const expectedMonthly = state.initialMonthly + 11;
        const expectedDaily = state.initialDaily + 11;

        expect(response3.data.after.used, `The month counter should accumulate to ${expectedMonthly}`).toBe(expectedMonthly);
        expect(response3.data.after.day.used, `The day counter should accumulate to ${expectedDaily}`).toBe(expectedDaily);
      },
    },

    // Test 7: Unauthenticated usage tracks by IP in usage collection
    {
      name: 'unauthenticated-usage-by-ip',
      async run({ http, expect, state }) {
        // Unauthenticated requests use IP as key (no proxy headers in emulator, so falls back to 'unknown')
        state.unauthKey = 'unknown';

        const response = await http.as('none').post('omega/test/usage', {});

        expect(response, 'Unauthenticated usage consume should succeed').toBeSuccess();
        expect(response.data.authenticated, 'Should report as unauthenticated').toBe(false);
        expect(response.data.key, 'Key should be unknown').toBe(state.unauthKey);

        // Verify both counters moved
        expect(response.data.after.used, 'The month counter should move by 1').toBe(response.data.before.used + 1);
        expect(response.data.after.day.used, 'The day counter should move by 1').toBe(response.data.before.day.used + 1);

        state.unauthMonthly = response.data.after.used;
      },
    },

    // Test 8: Verify unauthenticated usage persisted to usage collection
    {
      name: 'verify-unauthenticated-usage-persisted',
      async run({ firestore, expect, state }) {
        const usageDoc = await firestore.get(`usage/${state.unauthKey}`);

        expect(usageDoc, 'Usage doc should exist in usage collection').toBeTruthy();
        expect(usageDoc?.requests, 'Usage doc should have the requests feature').toBeTruthy();
        expect(usageDoc.requests.monthly, 'Persisted monthly should match').toBe(state.unauthMonthly);
      },
    },

    // Test 9: Cron resets daily counters for authenticated users
    {
      name: 'cron-resets-daily-counters',
      // omega_cronDaily runs all daily jobs serially; reset-usage is at the end of
      // the alphabetical sequence. In EXTENDED mode the real-API jobs ahead of
      // it can take ~50s combined — override the suite's 30s default.
      timeout: 75000,
      async run({ expect, firestore, state, accounts, waitFor, pubsub }) {
        // Verify daily counter is > 0 before cron
        const beforeDoc = await firestore.get(`users/${accounts.basic.uid}`);
        expect(beforeDoc?.usage?.requests?.daily > 0, 'Daily counter should be > 0 before cron').toBeTruthy();

        // Store monthly and total before cron (should NOT be reset by daily cron)
        state.monthlyBeforeCron = beforeDoc.usage.requests.monthly;
        state.totalBeforeCron = beforeDoc.usage.requests.total;

        // Trigger cron via PubSub
        await pubsub.trigger('omega_cronDaily');

        // Wait for cron to reset daily counter.
        // omega_cronDaily executes every registered daily job sequentially. In EXTENDED
        // mode the real-API jobs (expire-paypal-cancellations,
        // blog-auto-publisher, etc.) can take 40-50s combined before reset-usage
        // (alphabetical tail) gets its turn. 70s gives that the headroom it needs;
        // the per-test `timeout` below matches.
        try {
          await waitFor(
            async () => {
              const doc = await firestore.get(`users/${accounts.basic.uid}`);
              return doc?.usage?.requests?.daily === 0;
            },
            70000,
            500
          );
          expect(true, 'Daily counter was reset to 0 by cron').toBeTruthy();
        } catch (error) {
          expect.fail('Daily counter should be reset to 0 within 70s');
        }
      },
    },

    // Test 10: Cron preserves monthly and total counters (non-1st of month)
    {
      name: 'cron-preserves-monthly-and-total',
      async run({ expect, firestore, state, accounts }) {
        const afterDoc = await firestore.get(`users/${accounts.basic.uid}`);

        // The daily cron resets monthly counters on the 1st BY DESIGN
        // (reset-usage.js), and the functions process may sit in a different
        // timezone than this test process, so on a month boundary in either
        // calendar a reset-to-zero is the correct outcome too
        const boundary = new Date().getDate() === 1 || new Date().getUTCDate() === 1;
        const monthlyOk = afterDoc.usage.requests.monthly === state.monthlyBeforeCron
          || (boundary && afterDoc.usage.requests.monthly === 0);
        expect(monthlyOk, 'Monthly counter should be preserved after daily cron (or reset when the run crosses the 1st)').toBe(true);
        expect(afterDoc.usage.requests.total, 'Total counter should be preserved after daily cron').toBe(state.totalBeforeCron);
      },
    },

    // Test 11: Cron deletes unauthenticated usage collection
    {
      name: 'cron-deletes-unauthenticated-usage',
      async run({ expect, firestore, state, waitFor }) {
        // The cron was already triggered in test 9, so the usage collection should be deleted
        try {
          await waitFor(
            async () => {
              const doc = await firestore.get(`usage/${state.unauthKey}`);
              return !doc;
            },
            10000,
            500
          );
          expect(true, 'Usage collection doc was deleted by cron').toBeTruthy();
        } catch (error) {
          expect.fail('Usage collection doc should be deleted within 10s');
        }
      },
    },

    // Test 12: Daily counter accumulates after cron reset
    {
      name: 'daily-counter-accumulates-after-reset',
      async run({ http, expect }) {
        // After cron reset the day counter to 0, new consumes start from 0
        const response = await http.as('basic').post('omega/test/usage', {
          amount: 3,
        });

        expect(response, 'Consume after cron reset should succeed').toBeSuccess();
        expect(response.data.before.day.used, 'The day counter should be 0 after cron reset').toBe(0);
        expect(response.data.after.day.used, 'The day counter should be 3 after consuming').toBe(3);

        // Monthly should have continued accumulating (not reset)
        expect(response.data.after.used, 'The month counter should continue accumulating').toBe(response.data.before.used + 3);
      },
    },

    // Test 13: A negative amount clamps to 0 instead of DECREMENTING the
    // counter — the route keys usage off the caller's uid OR their IP, so
    // without the clamp an unauthenticated caller could zero their own bucket
    // (#238). Last in the suite: it must not move the counters the
    // accumulation tests above assert on.
    {
      name: 'negative-amount-clamps-to-zero',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/test/usage', {
          amount: -5,
        });

        expect(response, 'A negative amount should be accepted and clamped, not rejected').toBeSuccess();
        expect(response.data.amount, 'Amount should clamp to 0').toBe(0);

        expect(response.data.after.used, 'The month counter must not go down').toBe(response.data.before.used);
        expect(response.data.after.day.used, 'The day counter must not go down').toBe(response.data.before.day.used);
      },
    },

    // Test 14: The same clamp for an UNAUTHENTICATED caller, whose usage doc is
    // keyed by IP — the exact bucket the unclamped amount let anyone reset.
    {
      name: 'negative-amount-clamps-for-unauthenticated-callers',
      async run({ http, expect }) {
        const response = await http.as('none').post('omega/test/usage', {
          amount: -5,
        });

        expect(response, 'Unauthenticated consume should succeed').toBeSuccess();
        expect(response.data.authenticated, 'Should report as unauthenticated').toBe(false);
        expect(response.data.amount, 'Amount should clamp to 0').toBe(0);
        expect(response.data.after.used, 'The month counter must not go down').toBe(response.data.before.used);
      },
    },

    // Test 15: A `uid` in the body counts against THAT account's document
    // through usage.forUser, while the signed-in caller's counter stays put
    {
      name: 'consume-for-another-account',
      async run({ http, expect, firestore, accounts }) {
        const callerPath = `users/${accounts.basic.uid}`;
        const otherPath = `users/${accounts['premium-active'].uid}`;

        const callerBefore = (await firestore.get(callerPath))?.usage?.requests || {};
        const otherBefore = (await firestore.get(otherPath))?.usage?.requests || {};

        const response = await http.as('basic').post('omega/test/usage', {
          uid: accounts['premium-active'].uid,
        });

        expect(response, 'Consume for another account should succeed').toBeSuccess();

        const callerAfter = (await firestore.get(callerPath))?.usage?.requests || {};
        const otherAfter = (await firestore.get(otherPath))?.usage?.requests || {};

        expect(otherAfter.monthly, 'The named account\'s month counter should move by 1').toBe((otherBefore.monthly || 0) + 1);
        expect(otherAfter.total, 'The named account\'s total should move by 1').toBe((otherBefore.total || 0) + 1);
        expect(callerAfter.monthly, 'The caller\'s month counter must not move').toBe(callerBefore.monthly);
        expect(callerAfter.total, 'The caller\'s total must not move').toBe(callerBefore.total);
      },
    },
  ],
});
