/**
 * analytics-providers.test.js: the ONE row per analytics provider.
 *
 * Every reader (the adapters, the browser and server senders, the match blocks,
 * the consent maps, the Measurement Protocol transports) derives from these
 * rows, so a caller that could edit one at runtime would move them all at once.
 */

const defineCases = require('@omega.js/devkit/test/define-cases');
const { ANALYTICS_PROVIDERS, analyticsProvider } = require('../src/index.js');

const ROW_FIELDS = ['browserSender', 'consentCategory', 'dedupesOnEventId', 'id', 'matchKeys', 'measurementProtocol', 'serverSender'];

module.exports = defineCases({
  type: 'group',
  description: 'analytics-providers',
  tests: [
    {
      name: 'the rows are frozen, each answers by its id, and an unknown id answers null',
      run: (ctx) => {
        const rows = Object.values(ANALYTICS_PROVIDERS);

        ctx.expect(rows.map((row) => row.id).sort(), 'one row per provider, under the one name google').toEqual(['google', 'meta', 'tiktok']);
        ctx.expect(Object.isFrozen(ANALYTICS_PROVIDERS), 'the table is frozen').toBeTruthy();

        for (const row of rows) {
          ctx.expect(Object.keys(row).sort(), `${row.id} carries the one row shape`).toEqual(ROW_FIELDS);
          ctx.expect(Object.isFrozen(row), `${row.id} is frozen`).toBeTruthy();
          ctx.expect(Object.isFrozen(row.matchKeys), `${row.id}'s match keys are frozen with it`).toBeTruthy();
          ctx.expect(analyticsProvider(row.id), `${row.id} answers its own row`).toBe(row);
        }

        ctx.expect(analyticsProvider('nope')).toBe(null);
        // A descriptor names its provider, so an inherited property is never a row
        ctx.expect(analyticsProvider('constructor')).toBe(null);
        ctx.expect(analyticsProvider(undefined)).toBe(null);
      },
    },
  ],
});
