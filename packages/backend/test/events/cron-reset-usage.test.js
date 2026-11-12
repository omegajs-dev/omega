/**
 * The daily usage reset cron (`events/cron/daily/reset-usage.js`)
 * ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
 *
 * The promises, all of them things a user is silently punished by when broken:
 *  - EVERY counter block under `usage` is reset, whatever its key. Catalog
 *    membership is not the test: the framework's own anti-abuse gates count on
 *    the user doc with an explicit limit and carry no catalog entry, so a
 *    catalog-only sweep left them growing forever and the user permanently
 *    refused after five email-preference changes;
 *  - `usage.overrides` is NEVER touched — an admin granted those credits and a
 *    reset is not a revoke;
 *  - the day counter resets every day, the month counter only on the 1st;
 *  - one write per user, however many counters moved.
 *
 * Plain-node unit test (no emulator): the cron's collaborators are the
 * collection walk and the document write, and both are recorded here rather
 * than performed — which is what makes the resulting patch assertable.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');

const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const resetUsage = loadHandler(require.resolve('../../dist/omega/events/cron/daily/reset-usage.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const CATALOG = {
  saves: { name: 'Saves', usage: {} },
  support: { name: 'Priority support' },
};

// One user carrying three kinds of key under `usage`: a catalog feature, a
// framework gate the catalog never defines, and the overrides map.
function userDoc() {
  return {
    saves: { monthly: 40, daily: 4, total: 900 },
    'email-preferences': { monthly: 5, daily: 5, total: 12 },
    overrides: { saves: 500 },
  };
}

/** Run the whole cron over one synthetic user and hand back what it wrote. */
async function runCron() {
  const writes = [];
  const usage = userDoc();

  const doc = {
    id: 'user-647',
    ref: { update: async (patch) => writes.push(patch) },
    data: () => ({ usage: usage }),
  };

  const omega = {
    config: { features: CATALOG },
    firebase: { admin: { firestore: () => ({ recursiveDelete: async () => {}, collection: () => ({}) }) } },
    storage: () => ({ setState: () => ({ write: () => {} }) }),
    utilities: {
      // Every query answers with the one user — the cron dedupes by doc id, so
      // a user found by several field paths is still written once
      iterateCollection: async (handler) => handler({ docs: [doc] }),
    },
  };

  const ctx = { log: () => {}, warn: () => {}, error: () => {}, report: () => {} };
  await resetUsage({ ctx, omega, context: {} });

  return { writes, usage };
}

module.exports = defineCases({
  description: 'Daily usage reset cron',
  type: 'group',

  tests: [
    {
      name: 'every counter block resets — a counter the catalog never defined included',

      async run() {
        const { writes } = await runCron();

        expect(writes.length, 'one write per user, however many counters moved').toBe(1);

        const written = writes[0].usage;

        expect(written.saves.daily, 'the catalog feature reset').toBe(0);
        expect(written['email-preferences'].daily, 'and so did the framework gate the catalog never defines — the counter that used to grow forever').toBe(0);
      },
    },

    {
      name: 'the month counter survives a day that is not the 1st',

      async run() {
        const { writes } = await runCron();
        const written = writes[0].usage;
        const isFirst = new Date().getDate() === 1;

        expect(written.saves.monthly, 'the month resets on the 1st and only then').toBe(isFirst ? 0 : 40);
        expect(written.saves.total, 'the all-time counter never resets').toBe(900);
      },
    },

    {
      name: 'overrides are never touched — a reset is not a revoke',

      async run() {
        const { writes } = await runCron();

        expect(writes[0].usage.overrides, 'the granted credits survive the sweep').toEqual({ saves: 500 });
      },
    },
  ],
});
