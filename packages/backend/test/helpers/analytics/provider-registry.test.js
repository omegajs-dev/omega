/**
 * Test: the backend's analytics readers derive from the one row per provider.
 *
 * `ANALYTICS_PROVIDERS` (`@omega.js/config`) states each provider's facts once.
 * The server senders, the match blocks and the signup fire's provider selection
 * keep their functions here, so each must be exactly the rows that say so: a
 * row without its reader, or a reader without a row, fails here.
 *
 * Plain node: the delivery runs on a recording ctx outside production, so the
 * walk resolves every body and nothing reaches a platform.
 */
const conversions = require('../../../dist/omega/libraries/analytics/conversions.js');
const matchData = require('../../../dist/omega/libraries/analytics/match-data.js');
const signup = require('../../../dist/omega/libraries/analytics/signup.js');
const { ANALYTICS_PROVIDERS, analyticsProvider } = require('../../../dist/vendor/config/index.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const UID = '_test-provider-registry-uid';
const EVENT_ID = 'purchase._test-provider-registry';

// An account and a visit holding every value a match block can carry, so an
// absent key in a body is the block's, never the fixture's.
const FULL_USER_DOC = {
  auth: { uid: UID, email: 'Ada.Lovelace@Example.COM' },
  personal: {
    name: { first: 'Ada', last: 'Lovelace' },
    birthday: { timestamp: '1985-02-16T00:00:00.000Z', timestampUNIX: 477273600 },
    gender: 'female',
    location: { country: 'US', region: 'California', city: 'San Diego', postalCode: '94035' },
    telephone: { countryCode: 1, national: 5550102030 },
  },
};

const FULL_ATTRIBUTION = {
  last: {
    tags: { utm_source: 'meta', utm_medium: 'cpc' },
    clickIds: { fbclid: 'FB-CLICK', gclid: 'G-CLICK', ttclid: 'TT-CLICK' },
    url: 'https://brand.test/pricing',
    timestamp: '2026-08-01T00:00:00.000Z',
  },
  cookies: { fbc: 'fb.1.1754006400000.REAL-COOKIE', fbp: 'fb.1.1754006400000.987654321', ttp: 'TTP-COOKIE' },
};

const IDENTITY = matchData.buildIdentity({
  uid: UID,
  user: FULL_USER_DOC,
  request: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
});

// Where each provider's match block lands in the body its sender posts
const USER_BLOCK = {
  meta: (descriptor) => conversions.buildMetaBody({ descriptor, identity: IDENTITY, eventId: EVENT_ID }).data[0].user_data,
  tiktok: (descriptor) => conversions.buildTikTokBody({ descriptor, identity: IDENTITY, eventId: EVENT_ID, pixelCode: '_TEST_TIKTOK_PIXEL' }).data[0].user,
};

/** The row ids a predicate picks, sorted */
function ids(predicate) {
  return Object.values(ANALYTICS_PROVIDERS).filter(predicate).map((row) => row.id).sort();
}

/**
 * One purchase walked for the given providers, its results per provider.
 * `lines` collects `{ method, text }` per logged line; `production` picks the environment.
 */
function deliverFull(providers, { lines = [], production = false } = {}) {
  const saved = { META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN, TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN };
  const recorder = (method) => (...args) => lines.push({ method: method, text: args.map((arg) => String(arg)).join(' ') });

  // A configured brand: without a token a sender answers before the walk reaches its body
  process.env.META_ACCESS_TOKEN = '_test-meta-token';
  process.env.TIKTOK_ACCESS_TOKEN = '_test-tiktok-token';

  try {
    return conversions.deliverConversion({
      event: 'purchase',
      params: { transaction_id: '_test-registry-order', value: 9.99, currency: 'USD', items: [{ item_id: 'premium', price: 9.99, quantity: 1 }] },
      providers: providers,
      attribution: matchData.buildAttributionContext(FULL_ATTRIBUTION),
      identity: IDENTITY,
      eventId: EVENT_ID,
      ctx: { log: recorder('log'), error: recorder('error'), warn: recorder('warn'), isProduction: () => production, isDevelopment: () => !production },
      omega: { config: { analytics: { providers: { meta: { id: '_TEST_META_PIXEL' }, tiktok: { id: '_TEST_TIKTOK_PIXEL' } } } } },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

module.exports = defineCases({
  description: 'Analytics provider rows: the server senders, the match blocks and the signup fire',
  type: 'group',

  tests: [
    {
      name: 'the-server-senders-are-exactly-the-rows-that-say-serverSender',
      auth: 'none',

      async run({ expect }) {
        expect(Object.keys(conversions.SENDERS).sort(), 'a sender for every row that says it has one, and none for a row that does not').toEqual(ids((row) => row.serverSender));
        expect(ids((row) => row.serverSender), 'every provider takes a server conversion').toEqual(['google', 'meta', 'tiktok']);
      },
    },

    {
      name: 'each-match-block-is-exactly-its-rows-match-keys-and-google-has-none',
      auth: 'none',

      async run({ expect }) {
        const withKeys = ids((row) => row.matchKeys.length > 0);

        expect(analyticsProvider('google').matchKeys, 'GA4 takes its campaign fields as event params, never a match block').toEqual([]);
        expect(Object.keys(conversions.MATCH_BLOCKS).sort(), 'a match block for every row with match keys, and none for a row without').toEqual(withKeys);

        const results = deliverFull(withKeys);

        for (const id of withKeys) {
          const descriptor = results.find((result) => result.provider === id)?.descriptor;

          expect(Boolean(USER_BLOCK[id]), `${id} has match keys, so its body carries a match block`).toBe(true);
          expect(Object.keys(USER_BLOCK[id](descriptor)).sort(), `${id}'s body carries exactly its row's match keys`).toEqual([...analyticsProvider(id).matchKeys].sort());
        }
      },
    },

    {
      name: 'the-signup-fire-goes-to-the-rows-that-dedupe-on-event-id',
      auth: 'none',

      async run({ expect }) {
        const fire = signup.buildSignupFire({ authUser: { uid: UID }, userRecord: {}, request: {} });

        expect([...fire.providers].sort(), 'the server half reaches exactly the providers that collapse it with the browser half').toEqual(ids((row) => row.dedupesOnEventId));
        expect(ids((row) => row.dedupesOnEventId), 'GA4 has no event-id slot, so the browser half owns its registration count').toEqual(['meta', 'tiktok']);
      },
    },

    {
      // A webhook's conversion is revenue already earned: a stale id in its list
      // must cost a warning, never the conversion the known providers still owe.
      name: 'an-unknown-provider-id-warns-and-the-known-ones-still-deliver',
      auth: 'none',

      async run({ expect }) {
        const unknownWarnings = (lines) => lines.filter((line) => line.text.includes('ga4'));

        // Production too: the list names the unknown id alone, so nothing reaches a platform
        const live = [];
        deliverFull(['ga4'], { lines: live, production: true });
        expect(unknownWarnings(live).map((line) => line.method), `production warns once: ${JSON.stringify(live)}`).toEqual(['warn']);
        expect(unknownWarnings(live)[0].text.includes('purchase'), 'and the warning names the event').toBe(true);

        const lines = [];
        const results = deliverFull(['ga4', 'meta', 'tiktok'], { lines: lines });
        expect(unknownWarnings(lines).map((line) => line.method), `development warns once: ${JSON.stringify(lines)}`).toEqual(['warn']);
        expect(unknownWarnings(lines)[0].text.includes('purchase'), 'and the warning names the event').toBe(true);

        for (const id of ['meta', 'tiktok']) {
          const result = results.find((entry) => entry.provider === id);

          expect(Boolean(result && result.descriptor), `${id} still resolves its conversion`).toBe(true);
          expect(result.outcome.startsWith('skipped'), `${id} is walked to its sender, got "${result.outcome}"`).toBe(false);
        }
      },
    },
  ],
});
