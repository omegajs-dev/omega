/**
 * Test: server conversion delivery — the match data every platform receives
 * ([#385](https://github.com/Omega-JS-Stack/omega/issues/385), stage D of
 * [#302](https://github.com/Omega-JS-Stack/omega/issues/302)).
 *
 * The point of the stage is that a server conversion can be MATCHED to the human
 * who clicked the ad. So these tests read the actual bodies that would go on the
 * wire — built by the real adapters from `@omega.js/analytics`' catalog, fed by
 * the real match-data builders — from a realistic order: attribution with both
 * touches, the platform cookies the checkout collected, the request pair the
 * intent captured, and the tracking-consent snapshot.
 *
 * Four contracts under test:
 *   1. Match data — hashed email/phone (raw PII never leaves), external_id, the
 *      click ids and cookies in each platform's own slot, IP + user agent.
 *   2. The consent gate — an explicit `false` blocks its category's providers;
 *      an ABSENT snapshot (legacy orders, the raw-API recovery lane) allows all.
 *   3. Absence never throws — an order with no attribution and no request still
 *      delivers, on external_id alone.
 *   4. The environment gate — only PRODUCTION reaches a platform; a dev or
 *      emulator run resolves the whole walk and delivers nothing
 *      ([#464](https://github.com/Omega-JS-Stack/omega/issues/464)).
 *
 * Zero I/O: nothing here reaches a platform. Most assertions are on the bodies
 * the builders return; the two that read the WIRE drive a copy of the delivery
 * module whose transport is a recorder (`fireOnRecordedWire`), so a send is
 * observed without a byte leaving the process.
 *
 * Run: npx omega test framework:analytics/conversion-delivery
 */
const crypto = require('crypto');
const path = require('path');
const conversions = require('../../dist/omega/libraries/analytics/conversions.js');
const matchData = require('../../dist/omega/libraries/analytics/match-data.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// A uid the way one actually looks — Firebase's alphabet is case-SENSITIVE —
// carrying the padding a stored id can pick up. A lowercased or untrimmed
// digest is a different digest, so a fixture that was already trim and
// lowercase would have let either drift through unnoticed.
const UID = '  AYVZezRcE9CsyI ';
const UID_TRIMMED = 'AYVZezRcE9CsyI';
// TikTok's Events API documents external_id as "SHA-256 hashing is required",
// while Meta documents it as "Hashing recommended" and its own Pixel example
// sends a raw id ([#410](https://github.com/Omega-JS-Stack/omega/issues/410)).
// So the two platforms take the SAME uid in two shapes, and the digest is
// hard-coded (shasum of the TRIMMED, case-preserved uid) rather than computed
// here: a hash that stops matching the browser half's `ttq.identify()` fails
// here instead of on a live pixel.
const UID_DIGEST = '12266491d7fe2f07c833999f4d011444564df71cfd7aaafb346f0edf473572b4';
const EMAIL = 'Buyer@Example.COM';
const IP = '203.0.113.7';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

// An account doc with everything the schema can hold — what the ONE shared
// reader (`readUserMatchFields`) turns into the full match block (#577).
const FULL_USER_DOC = {
  auth: { uid: UID_TRIMMED, email: 'Ada.Lovelace@Example.COM' },
  personal: {
    name: { first: 'Ada', last: 'Lovelace' },
    birthday: { timestamp: '1985-02-16T00:00:00.000Z', timestampUNIX: 477273600 },
    gender: 'female',
    location: { country: 'US', region: 'California', city: 'San Diego', postalCode: '94035' },
    telephone: { countryCode: 1, national: 5550102030 },
  },
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The attribution shape the landing capture writes and the intent fold carries:
// an organic first touch, a paid last touch, plus the cookies read at checkout.
function fullAttribution() {
  return {
    first: {
      tags: { utm_source: 'newsletter', utm_medium: 'email' },
      referrer: 'https://news.ycombinator.com/',
      url: 'https://brand.test/',
      page: '/',
      timestamp: '2026-06-01T00:00:00.000Z',
    },
    last: {
      tags: { utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'launch', utm_term: 'omega', utm_content: 'hero' },
      clickIds: { fbclid: 'FB-CLICK', gclid: 'G-CLICK', ttclid: 'TT-CLICK' },
      referrer: 'https://facebook.com/',
      url: 'https://brand.test/pricing?utm_source=meta',
      page: '/pricing',
      timestamp: '2026-08-01T00:00:00.000Z',
    },
    affiliate: { code: 'IAN7', timestamp: '2026-08-01T00:00:00.000Z', url: 'https://brand.test/', page: '/' },
    cookies: { fbc: 'fb.1.1754006400000.REAL-COOKIE', fbp: 'fb.1.1754006400000.987654321', ttp: 'TTP-COOKIE' },
  };
}

const PURCHASE_PARAMS = {
  transaction_id: '_test-sub-conversion',
  value: 9.99,
  currency: 'USD',
  items: [{ item_id: 'premium', item_name: 'Premium', price: 9.99, quantity: 1 }],
  payment_provider: 'stripe',
  payment_frequency: 'monthly',
  is_trial: false,
  is_recurring: false,
};

/** Deliver one event exactly as the payment webhook would, and hand back the per-provider results. */
function deliver({ ctx, omega, event = 'purchase', params = PURCHASE_PARAMS, attribution = fullAttribution(), trackingConsent = null, providers, identity }) {
  return conversions.deliverConversion({
    event: event,
    params: params,
    providers: providers,
    attribution: matchData.buildAttributionContext(attribution),
    identity: identity || matchData.buildIdentity({
      uid: UID,
      email: EMAIL,
      telephone: { countryCode: 1, national: 5550102030 },
      request: { ip: IP, userAgent: USER_AGENT },
    }),
    trackingConsent: trackingConsent,
    eventId: `${event}._test-webhook-event`,
    ctx: ctx,
    omega: omega,
  });
}

function descriptorFor(results, provider) {
  return results.find((result) => result.provider === provider)?.descriptor;
}

function outcomeFor(results, provider) {
  return results.find((result) => result.provider === provider)?.outcome;
}

// The pixel ids a brand configures, in the shape the config resolves them from
// (`analytics.providers.<provider>.id`).
const META_PIXEL = '_TEST_META_PIXEL';
const TIKTOK_PIXEL = '_TEST_TIKTOK_PIXEL';

/**
 * Fire one purchase at the two ad transports with the wire RECORDED.
 *
 * The delivery module is re-required with its `wonderful-fetch` replaced by a
 * recorder, so the real `sendMeta`/`sendTikTok` run — config read, body built,
 * POST issued — and the test reads exactly what a platform would have received.
 * The module and the cache entry are both restored, so every other test in this
 * file keeps the real transport.
 *
 * GA4 is out of the fire: its transport is the Omega instance's own Measurement
 * Protocol helper rather than this module's `post`, and the server half of a
 * purchase-shaped fire names the two providers that dedupe anyway.
 *
 * @param {object} options
 * @param {boolean} options.production - What the ctx answers for `isProduction()`.
 * @returns {{results: object[], calls: object[], lines: string[]}}
 */
function fireOnRecordedWire({ production }) {
  const modulePath = require.resolve('../../dist/omega/libraries/analytics/conversions.js');
  const fetchPath = require.resolve('wonderful-fetch', { paths: [path.dirname(modulePath)] });
  const realFetch = require.cache[fetchPath];
  const savedEnv = { META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN, TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN };
  const calls = [];
  const lines = [];
  const record = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));

  require.cache[fetchPath] = {
    id: fetchPath,
    filename: fetchPath,
    loaded: true,
    exports: (url, options) => {
      calls.push({ url: url, options: options });
      return Promise.resolve({});
    },
  };
  delete require.cache[modulePath];

  // A configured brand is the only one that can send at all — without a token
  // both transports answer `skipped (not configured)` and prove nothing.
  process.env.META_ACCESS_TOKEN = '_test-meta-token';
  process.env.TIKTOK_ACCESS_TOKEN = '_test-tiktok-token';

  try {
    const results = require(modulePath).deliverConversion({
      event: 'purchase',
      params: PURCHASE_PARAMS,
      attribution: matchData.buildAttributionContext(fullAttribution()),
      identity: matchData.buildIdentity({ uid: UID, email: EMAIL, request: { ip: IP, userAgent: USER_AGENT } }),
      providers: ['meta', 'tiktok'],
      eventId: 'purchase._test-wire-event',
      ctx: {
        log: record,
        error: record,
        warn: record,
        isProduction: () => production,
        isDevelopment: () => !production,
      },
      omega: { config: { analytics: { providers: { meta: { id: META_PIXEL }, tiktok: { id: TIKTOK_PIXEL } } } } },
    });

    return { results: results, calls: calls, lines: lines };
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (realFetch) {
      require.cache[fetchPath] = realFetch;
    } else {
      delete require.cache[fetchPath];
    }
    delete require.cache[modulePath];
    require(modulePath);
  }
}

module.exports = defineCases({
  description: 'Server conversion delivery: match data, consent gating, absent-data tolerance',
  type: 'group',

  tests: [
    {
      name: 'meta-user-data-carries-the-full-match-block',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({ ctx, omega });
        const body = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: matchData.buildIdentity({
            uid: UID,
            email: EMAIL,
            telephone: { countryCode: 1, national: 5550102030 },
            request: { ip: IP, userAgent: USER_AGENT },
          }),
          eventId: 'purchase._test-webhook-event',
        });

        const event = body.data[0];

        expect(event.event_name, 'the catalog names the Meta event').toBe('Purchase');
        expect(event.event_id, 'the dedupe id rides the event').toBe('purchase._test-webhook-event');
        expect(event.action_source).toBe('website');

        // Identity — hashed, never raw
        expect(event.user_data.em, 'email is SHA256 of the trimmed lowercase address').toBe(sha256('buyer@example.com'));
        expect(event.user_data.ph, 'phone is SHA256 of the digits, country code included').toBe(sha256('15550102030'));
        expect(event.user_data.external_id, 'Meta only RECOMMENDS hashing external_id, and its Pixel half sends the raw uid (#410)').toBe(UID);
        expect(JSON.stringify(event).includes(EMAIL), 'the raw email must never appear anywhere in the body').toBe(false);
        expect(JSON.stringify(event).includes('5550102030'), 'the raw phone number must never appear anywhere in the body').toBe(false);

        // Same-device match
        expect(event.user_data.client_ip_address).toBe(IP);
        expect(event.user_data.client_user_agent).toBe(USER_AGENT);
        expect(event.user_data.fbc, 'the real cookie wins over any construction').toBe('fb.1.1754006400000.REAL-COOKIE');
        expect(event.user_data.fbp).toBe('fb.1.1754006400000.987654321');

        // Commerce, in Meta's own vocabulary (the catalog's map)
        expect(event.custom_data.value).toBe(9.99);
        expect(event.custom_data.currency).toBe('USD');
        expect(event.custom_data.content_ids).toEqual(['premium']);
        expect(event.custom_data.fbc, 'match data never rides the custom data').toBe(undefined);
      },
    },

    {
      // Meta REQUIRES `action_source` and makes its accuracy a term of use, and
      // its enum names this exact case: `system_generated`, "for example, a
      // subscription renewal that's set to auto-pay each month". Every server
      // fire claimed `website`, which said a person had been on the site for a
      // charge their card took on its own
      // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)). The
      // catalog decides it per event; the body is where it has to show up.
      name: 'a-billed-charge-tells-meta-system-generated-and-a-checkout-website',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const identity = matchData.buildIdentity({ uid: UID, email: EMAIL, request: { ip: IP, userAgent: USER_AGENT } });
        const actionSourceFor = (event) => conversions.buildMetaBody({
          descriptor: descriptorFor(deliver({ ctx, omega, event: event }), 'meta'),
          identity: identity,
          eventId: `${event}._test-webhook-event`,
        }).data[0].action_source;

        for (const event of ['subscription_renew', 'payment_recovered', 'trial_convert']) {
          expect(actionSourceFor(event), `${event} bills a card with nobody present`).toBe('system_generated');
        }

        for (const event of ['purchase', 'trial_start', 'subscription_cancel']) {
          expect(actionSourceFor(event), `${event} is something a person did on the site`).toBe('website');
        }
      },
    },

    {
      // The match block a real account can fill
      // ([#577](https://github.com/Omega-JS-Stack/omega/issues/577)): the doc
      // already held the name, birthday, gender and location, and Meta accepts
      // all four — so the body carries every parameter, not just `em` +
      // `external_id`. The normalization each one needs is pinned value by
      // value in analytics/match-normalization.test.js; what this asserts is
      // that the BODY carries them, from the one shared reader.
      name: 'a-full-account-fills-every-meta-parameter',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const identity = matchData.buildIdentity({
          uid: UID,
          user: FULL_USER_DOC,
          request: { ip: IP, userAgent: USER_AGENT },
        });

        const results = deliver({ ctx, omega, identity });
        const userData = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
        }).data[0].user_data;

        expect(Object.keys(userData).sort(), 'every parameter Meta accepts from this account rides the body').toEqual(['client_ip_address', 'client_user_agent', 'country', 'ct', 'db', 'em', 'external_id', 'fbc', 'fbp', 'fn', 'ge', 'ln', 'ph', 'st', 'zp']);

        // The email and phone still come off the SAME reader — a call site that
        // passes a doc must not lose the two keys it always had.
        expect(userData.em, 'the doc\'s email is read and normalized like any other').toBe(sha256('ada.lovelace@example.com'));
        expect(userData.ph, 'and its telephone pair').toBe(sha256('15550102030'));
        expect(JSON.stringify(userData).includes('Lovelace'), 'no raw personal value anywhere in the block').toBe(false);
      },
    },

    {
      // The fire log is how a brand SEES its match quality without opening an
      // ads manager: per provider, the keys that went and the accepted keys
      // that were empty. KEY NAMES ONLY — a match value, raw or hashed, must
      // never reach a log line (#577).
      name: 'the-fire-log-names-the-match-keys-sent-and-the-ones-that-were-empty',
      auth: 'none',

      async run({ expect, omega }) {
        const lines = [];
        const record = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
        const identity = matchData.buildIdentity({ uid: UID, email: EMAIL, request: { ip: IP, userAgent: USER_AGENT } });

        conversions.deliverConversion({
          event: 'purchase',
          params: PURCHASE_PARAMS,
          attribution: matchData.buildAttributionContext({}),
          identity: identity,
          providers: ['meta'],
          eventId: 'purchase._test-fire-log',
          ctx: { log: record, error: record, warn: record, isProduction: () => false, isDevelopment: () => true },
          omega: omega,
        });

        const summary = lines.find((line) => line.startsWith('deliverConversion: purchase →'));

        expect(!!summary, `the walk logs one summary line: ${lines.join(' | ')}`).toBe(true);
        expect(summary.includes('meta blocked (dev) sent em,external_id,client_ip_address,client_user_agent;'), `the line names what went: ${summary}`).toBe(true);
        expect(summary.includes('empty ph,fn,ln,ct,st,zp,country,db,ge,fbc,fbp'), `and what the platform accepts but this fire had nothing for: ${summary}`).toBe(true);
        expect(summary.includes(EMAIL), 'never the raw value').toBe(false);
        expect(summary.includes(identity.emailHash), 'and never the hashed one either').toBe(false);
      },
    },

    {
      name: 'meta-constructs-fbc-from-the-captured-fbclid',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The cookie never made it to checkout (cleared jar, ITP, another device)
        const attribution = fullAttribution();
        delete attribution.cookies.fbc;

        const results = deliver({ ctx, omega, attribution });
        const descriptor = descriptorFor(results, 'meta');
        const capturedMs = Date.parse('2026-08-01T00:00:00.000Z');

        expect(descriptor.userData.fbc, 'fbc is built per Meta spec from the click id, stamped when it was captured').toBe(`fb.1.${capturedMs}.FB-CLICK`);
        expect(descriptor.userData.fbp, 'the browser cookie is untouched by the construction').toBe('fb.1.1754006400000.987654321');

        // Nothing to build from is not an error — the fire still goes with what it has
        const noClick = fullAttribution();
        delete noClick.cookies.fbc;
        delete noClick.last.clickIds.fbclid;

        const bare = descriptorFor(deliver({ ctx, omega, attribution: noClick }), 'meta');
        expect(bare.userData.fbc, 'no cookie and no fbclid means no fbc, never a malformed one').toBe(undefined);
      },
    },

    {
      // Events API 2.0 FLATTENED the match block: what used to sit under
      // `data[].context` (`context.user`, `context.ad.callback`, `context.ip`,
      // `context.user_agent`) is one `data[].user` object, with the click id as
      // a plain `user.ttclid` and the phone under `phone`, not `phone_number`
      // ([#482](https://github.com/Omega-JS-Stack/omega/issues/482)). An
      // off-spec key does not error — it matches nobody, silently.
      name: 'tiktok-user-block-carries-the-full-match-block',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({ ctx, omega });
        const body = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: matchData.buildIdentity({
            uid: UID,
            email: EMAIL,
            telephone: { countryCode: 1, national: 5550102030 },
            request: { ip: IP, userAgent: USER_AGENT },
          }),
          eventId: 'purchase._test-webhook-event',
          pixelCode: '_TEST_PIXEL',
        });

        const event = body.data[0];

        expect(event.event, 'the catalog names the TikTok event — Purchase, since CompletePayment was retired ([#652])').toBe('Purchase');
        expect(event.event_id).toBe('purchase._test-webhook-event');
        expect(event.user.email, 'TikTok takes the email hashed too').toBe(sha256('buyer@example.com'));
        expect(event.user.phone, 'TikTok\'s spec is the E.164 number, plus included').toBe(sha256('+15550102030'));
        expect(event.user.external_id, 'TikTok REQUIRES external_id hashed, and a raw one matches nobody (#410)').toBe(UID_DIGEST);
        expect(JSON.stringify(event).includes(UID_TRIMMED), 'the raw uid must not ride a TikTok body under any key').toBe(false);
        expect(event.user.ttp).toBe('TTP-COOKIE');
        expect(event.user.ttclid, 'the click id is a match key like any other in 2.0').toBe('TT-CLICK');
        expect(event.user.ip).toBe(IP);
        expect(event.user.user_agent).toBe(USER_AGENT);
        expect(event.properties.contents[0].content_id, 'TikTok commerce rides its documented `contents` array ([#652])').toBe('premium');
        expect(event.properties.value).toBe(9.99);

        // The v1.2 nesting is GONE, not duplicated alongside — a body carrying
        // both shapes is how the two drift apart on the next edit.
        expect(Object.hasOwn(event, 'context'), 'the v1.2 context block never rides along').toBe(false);
        expect(JSON.stringify(event).includes('phone_number'), 'nor its key names').toBe(false);
      },
    },

    {
      // `timestamp` was an ISO string; 2.0's REQUIRED field is `event_time`, in
      // Unix SECONDS — the same stamp Meta's body has always carried. An ISO
      // string here is either a rejection or an event attributed to the wrong
      // day, and neither shows up anywhere but the platform's own dashboard
      // ([#482](https://github.com/Omega-JS-Stack/omega/issues/482)).
      name: 'the-tiktok-item-stamps-event-time-in-unix-seconds',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const before = Math.floor(Date.now() / 1000);
        const results = deliver({ ctx, omega });
        const event = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: matchData.buildIdentity({ uid: UID }),
          eventId: 'purchase._test-webhook-event',
          pixelCode: TIKTOK_PIXEL,
        }).data[0];

        expect(Number.isInteger(event.event_time), `event_time is an integer of seconds, not ${JSON.stringify(event.event_time)}`).toBe(true);
        expect(event.event_time >= before, 'stamped at build time').toBe(true);
        expect(event.event_time <= Math.floor(Date.now() / 1000), 'and never in the future').toBe(true);
        // Milliseconds pass Number.isInteger too, and are the failure the unit
        // gets wrong silently: a 13-digit stamp reads as the year 46,000.
        expect(String(event.event_time).length, 'seconds, not milliseconds').toBe(10);
        expect(Object.hasOwn(event, 'timestamp'), 'the v1.2 ISO field is replaced, not kept beside it').toBe(false);
        expect(JSON.stringify(event).includes('T00:00:00'), 'no ISO stamp rides the item under any key').toBe(false);
      },
    },

    {
      // TikTok's Events API validates the DESTINATION at the top level of the
      // request: `event_source` and `event_source_id`. The pixel id used to ride
      // as `data[].pixel_code` instead, so every live fire came back
      // `{"code":40002,"message":"Invalid value for event_source_id: not a valid
      // string."}` — the field TikTok validates was never sent, while the id sat
      // correctly in config the whole time
      // ([#465](https://github.com/Omega-JS-Stack/omega/issues/465)).
      name: 'the-tiktok-body-names-the-pixel-in-event-source-id',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({ ctx, omega });
        const body = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: matchData.buildIdentity({ uid: UID }),
          eventId: 'purchase._test-webhook-event',
          pixelCode: TIKTOK_PIXEL,
        });

        expect(body.event_source_id, 'the configured pixel id is the event source id TikTok validates').toBe(TIKTOK_PIXEL);
        expect(body.event_source, 'a conversion for a website is the web source').toBe('web');
        expect(body.data[0].pixel_code, 'one home for the id — a second copy in the data item is what drifted').toBe(undefined);
      },
    },

    {
      name: 'the-tiktok-send-puts-the-configured-pixel-on-the-wire',
      auth: 'none',

      async run({ expect }) {
        // The body test above proves the SHAPE; this one proves the id actually
        // reaches it — the resolution step (#465) is where the send went wrong.
        const { calls, lines } = fireOnRecordedWire({ production: true });
        const tiktok = calls.find((call) => call.url.includes('business-api.tiktok.com'));

        expect(!!tiktok, `a configured brand in production must reach TikTok: ${lines.join(' | ')}`).toBe(true);
        expect(tiktok.options.body.event_source_id, 'the id on the wire is the one config resolved').toBe(TIKTOK_PIXEL);
        expect(tiktok.options.body.event_source).toBe('web');
        expect(JSON.stringify(tiktok.options.body).includes('pixel_code'), 'the v1.2 field never rides along').toBe(false);

        // The other transport is the control: it was delivering all along.
        const meta = calls.find((call) => call.url.includes('graph.facebook.com'));

        expect(!!meta, `Meta must still be reached: ${lines.join(' | ')}`).toBe(true);
        expect(meta.url.includes(`/${META_PIXEL}/events`), 'Meta names its pixel in the path').toBe(true);
      },
    },

    {
      // A server conversion has no page of its own — a webhook fires from
      // Stripe's servers — so the only URL it can honestly claim is the one the
      // attribution touch captured. It used to be dropped on the floor by
      // `buildAttributionContext()`, so TikTok's data item carried no `page` and
      // Meta's event no `event_source_url`, and both platforms scored the match
      // lower for it ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)).
      name: 'the-page-the-conversion-happened-on-rides-both-ad-bodies',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const context = matchData.buildAttributionContext(fullAttribution());

        expect(context.url, 'the CREDITED touch\'s url reaches the adapters').toBe('https://brand.test/pricing?utm_source=meta');
        expect(context.referrer, 'and the referrer it landed from').toBe('https://facebook.com/');

        const results = deliver({ ctx, omega });
        const identity = matchData.buildIdentity({ uid: UID });

        const meta = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
        }).data[0];

        const tiktok = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
          pixelCode: TIKTOK_PIXEL,
        }).data[0];

        expect(meta.event_source_url, 'Meta reads the conversion\'s page as event_source_url').toBe('https://brand.test/pricing?utm_source=meta');
        expect(tiktok.page, 'TikTok 2.0 reads it as the item\'s page object').toEqual({ url: 'https://brand.test/pricing?utm_source=meta', referrer: 'https://facebook.com/' });

        // It is context, not commerce and not a match key — a url in either
        // block is an off-spec field the platform reads as neither.
        expect(meta.custom_data.url, 'the page never rides Meta\'s custom data').toBe(undefined);
        expect(tiktok.properties.url, 'nor TikTok\'s properties').toBe(undefined);
        expect(tiktok.user.url, 'nor either match block').toBe(undefined);
        expect(meta.user_data.url).toBe(undefined);

        // GA4's Measurement Protocol gets no invented slot: the campaign params
        // are what its half of this attribution has always been.
        expect(descriptorFor(results, 'google').payload.url, 'GA4 gains no url param').toBe(undefined);
      },
    },

    {
      name: 'a-direct-landing-sends-a-page-of-the-url-alone',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The landing capture writes `referrer: null` for a visit that came from
        // no page at all (a typed url, an app link). An empty referrer key is a
        // field we tried and failed to send.
        const attribution = fullAttribution();
        attribution.last.referrer = null;

        const results = deliver({ ctx, omega, attribution });
        const identity = matchData.buildIdentity({ uid: UID });

        const meta = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
        }).data[0];

        const tiktok = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
          pixelCode: TIKTOK_PIXEL,
        }).data[0];

        expect(meta.event_source_url, 'the url still goes — a referrer was never part of Meta\'s field').toBe('https://brand.test/pricing?utm_source=meta');
        expect(tiktok.page, 'the page is the url alone').toEqual({ url: 'https://brand.test/pricing?utm_source=meta' });
        expect(Object.hasOwn(tiktok.page, 'referrer'), 'never an empty referrer beside it').toBe(false);
      },
    },

    {
      name: 'no-touch-url-means-no-page-and-no-event-source-url',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The raw-API recovery lane: no browser was ever involved, so there is
        // no touch and no url. An invented one is worse than an absent one —
        // the brand's home page would credit every recovered order to a page
        // nobody converted on.
        const results = deliver({ ctx, omega, attribution: {}, identity: matchData.buildIdentity({ uid: UID }) });
        const identity = matchData.buildIdentity({ uid: UID });

        const meta = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
        }).data[0];

        const tiktok = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: identity,
          eventId: 'purchase._test-webhook-event',
          pixelCode: TIKTOK_PIXEL,
        }).data[0];

        expect(Object.hasOwn(meta, 'event_source_url'), 'Meta gets no key at all, never an empty string').toBe(false);
        expect(Object.hasOwn(tiktok, 'page'), 'and TikTok no empty page object').toBe(false);
      },
    },

    {
      name: 'google-gains-the-campaign-params-and-gclid',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const descriptor = descriptorFor(deliver({ ctx, omega }), 'google');

        expect(descriptor.name).toBe('purchase');
        expect(descriptor.payload.source, 'last touch is the credited one').toBe('meta');
        expect(descriptor.payload.medium).toBe('cpc');
        expect(descriptor.payload.campaign).toBe('launch');
        expect(descriptor.payload.term).toBe('omega');
        expect(descriptor.payload.content).toBe('hero');
        expect(descriptor.payload.gclid, 'the Google click id rides as an event param').toBe('G-CLICK');
        expect(descriptor.payload.value, 'the commerce params are untouched').toBe(9.99);
        expect(descriptor.payload.fbc, 'another platform\'s match data never rides GA4').toBe(undefined);
      },
    },

    {
      name: 'campaign-falls-back-to-the-first-touch',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // A user who arrived on a tagged link and never came back through one:
        // last touch is only ever written by a tagged visit (#384).
        const attribution = fullAttribution();
        delete attribution.last;

        const descriptor = descriptorFor(deliver({ ctx, omega, attribution }), 'google');

        expect(descriptor.payload.source, 'first touch credits the conversion when there is no last').toBe('newsletter');
        expect(descriptor.payload.medium).toBe('email');
        expect(descriptor.payload.campaign, 'a param the touch never carried is absent, not empty').toBe(undefined);
      },
    },

    {
      name: 'marketing-declined-blocks-meta-and-tiktok-but-not-google',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({
          ctx,
          omega,
          trackingConsent: { analytics: true, marketing: false, region: 'opt-in', version: 1 },
        });

        expect(outcomeFor(results, 'meta'), 'an opted-out user reaches no ad platform').toBe('skipped (consent: marketing)');
        expect(outcomeFor(results, 'tiktok')).toBe('skipped (consent: marketing)');
        expect(descriptorFor(results, 'meta'), 'a blocked provider never even resolves its payload').toBe(undefined);
        expect(outcomeFor(results, 'google').startsWith('skipped (consent'), 'analytics was granted, so GA4 still counts it').toBe(false);
      },
    },

    {
      name: 'analytics-declined-blocks-google-but-not-the-ad-platforms',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({
          ctx,
          omega,
          trackingConsent: { analytics: false, marketing: true, region: 'opt-in', version: 1 },
        });

        expect(outcomeFor(results, 'google')).toBe('skipped (consent: analytics)');
        expect(outcomeFor(results, 'meta').startsWith('skipped (consent'), 'the two categories gate independently').toBe(false);
      },
    },

    {
      name: 'an-absent-snapshot-is-not-a-denial',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // A legacy order, or one minted by the raw-API recovery lane, carries no
        // snapshot at all. Blocking it would be a silent revenue hole.
        for (const snapshot of [null, undefined, {}]) {
          const granted = conversions.resolveTrackingConsent(snapshot);

          expect(granted.analytics, `${JSON.stringify(snapshot)} allows analytics`).toBe(true);
          expect(granted.marketing, `${JSON.stringify(snapshot)} allows marketing`).toBe(true);
        }

        const results = deliver({ ctx, omega, trackingConsent: null });

        for (const provider of ['google', 'meta', 'tiktok']) {
          expect(outcomeFor(results, provider).startsWith('skipped (consent'), `${provider} fires without a snapshot`).toBe(false);
        }
      },
    },

    {
      name: 'an-order-with-no-attribution-still-fires-on-external-id',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The raw-API recovery lane: no browser was ever involved, so there is no
        // attribution, no cookies and no request pair.
        const results = deliver({
          ctx,
          omega,
          attribution: {},
          identity: matchData.buildIdentity({ uid: UID }),
        });

        const body = conversions.buildMetaBody({
          descriptor: descriptorFor(results, 'meta'),
          identity: matchData.buildIdentity({ uid: UID }),
          eventId: 'purchase._test-webhook-event',
        });

        expect(body.data[0].user_data, 'external_id alone — no empty match keys invented').toEqual({ external_id: UID });

        // The lane where external_id is the ONLY match key is exactly where its
        // shape decides whether the fire matches anybody at all (#410).
        const tiktok = conversions.buildTikTokBody({
          descriptor: descriptorFor(results, 'tiktok'),
          identity: matchData.buildIdentity({ uid: UID }),
          eventId: 'purchase._test-webhook-event',
          pixelCode: '_TEST_PIXEL',
        });

        expect(tiktok.data[0].user, 'TikTok\'s lone match key is the digest its Events API requires').toEqual({ external_id: UID_DIGEST });

        expect(descriptorFor(results, 'google').payload.source, 'no campaign params either').toBe(undefined);
        expect(outcomeFor(results, 'meta').startsWith('skipped (consent'), 'missing match data never blocks the fire').toBe(false);
      },
    },

    {
      // `sign_up` is a `placement: 'both'` event, and its two halves do NOT all
      // deduplicate: Meta and TikTok merge on event_id, GA4 has no cross-source
      // dedupe at all — a Measurement Protocol sign_up beside the browser's gtag
      // one is simply two registrations. So the server half names the providers
      // it owns, and GA4 stays mapped in the catalog for the client.
      name: 'a-provider-the-other-half-owns-is-never-fired',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const results = deliver({
          ctx,
          omega,
          event: 'sign_up',
          params: { method: 'email', user_id: UID },
          providers: ['meta', 'tiktok'],
        });

        expect(outcomeFor(results, 'google'), 'GA4 must not be fired by a half that cannot dedupe against the other').toBe('skipped (not selected)');
        expect(descriptorFor(results, 'google'), 'an unselected provider never even resolves its payload').toBe(undefined);

        // The two that DO dedupe are resolved and handed to their transport.
        for (const provider of ['meta', 'tiktok']) {
          expect(descriptorFor(results, provider).name, `${provider} resolves its native event`).toBe('CompleteRegistration');
          expect(outcomeFor(results, provider).startsWith('skipped (not selected)'), `${provider} is this half's to fire`).toBe(false);
        }

        // Unrestricted stays unrestricted — the seam is opt-in per fire.
        const everyProvider = deliver({ ctx, omega, event: 'sign_up', params: { method: 'email', user_id: UID } });

        expect(outcomeFor(everyProvider, 'google').startsWith('skipped (not selected)'), 'a fire that names no providers reaches every mapped one').toBe(false);
      },
    },

    {
      name: 'an-account-with-no-phone-sends-no-phone-hash',
      auth: 'none',

      async run({ expect }) {
        // The account schema stores the pair as NUMBERS defaulting to 0. Hashing
        // that would give every phoneless account the same match key — junk the
        // platforms would happily match strangers to each other on.
        for (const hash of [matchData.hashPhone, matchData.hashPhoneE164]) {
          expect(hash({ countryCode: 0, national: 0 }), 'the schema default is no phone').toBe(null);
          expect(hash(undefined)).toBe(null);
        }

        expect(matchData.hashPhone({ countryCode: 1, national: 5550102030 }), 'a real number still hashes').toBe(sha256('15550102030'));

        // Firebase Auth hands the trigger an E.164 string instead of the pair.
        expect(matchData.hashPhone('+1 555-010-2030'), 'the Auth record shape hashes to the same digest').toBe(sha256('15550102030'));

        const identity = matchData.buildIdentity({ uid: UID, telephone: { countryCode: 0, national: 0 } });

        expect(Object.hasOwn(identity, 'metaPhoneHash'), 'an unresolvable match key is absent, never empty').toBe(false);
        expect(Object.hasOwn(identity, 'tiktokPhoneHash'), 'and neither normalization invents one').toBe(false);
      },
    },

    {
      // ONE hash used to go to every provider, and the platforms do not agree on
      // what to hash ([#392](https://github.com/Omega-JS-Stack/omega/issues/392)):
      // Meta's advanced matching wants bare digits, TikTok's Events API the E.164
      // form WITH the plus. Same person, two digests — an off-spec key does not
      // error, it just silently matches nobody.
      name: 'the-phone-hash-is-normalized-per-provider-spec',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        const telephone = { countryCode: 1, national: 5550102030 };
        const identity = matchData.buildIdentity({ uid: UID, telephone: telephone });

        expect(identity.metaPhoneHash, 'Meta hashes the bare digits').toBe(sha256('15550102030'));
        expect(identity.tiktokPhoneHash, 'TikTok hashes the E.164 number').toBe(sha256('+15550102030'));
        expect(identity.metaPhoneHash === identity.tiktokPhoneHash, 'two specs, two digests — never one hash for both').toBe(false);

        // The same normalizers the browser half uses (`@omega.js/analytics/identity`),
        // so a server conversion and a pixel event carry the SAME match key.
        const results = deliver({ ctx, omega, identity });

        const meta = conversions.buildMetaBody({ descriptor: descriptorFor(results, 'meta'), identity: identity, eventId: 'purchase._test-webhook-event' });
        const tiktok = conversions.buildTikTokBody({ descriptor: descriptorFor(results, 'tiktok'), identity: identity, eventId: 'purchase._test-webhook-event', pixelCode: '_TEST_PIXEL' });

        expect(meta.data[0].user_data.ph, 'the Meta body carries the digits-only digest').toBe(sha256('15550102030'));
        expect(tiktok.data[0].user.phone, 'the TikTok body carries the E.164 digest').toBe(sha256('+15550102030'));
      },
    },

    {
      name: 'an-event-name-the-catalog-does-not-know-is-loud-and-harmless',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // A typo in a canonical name used to be SILENT: every adapter returned
        // null, and the fire read exactly like `subscription_plan_change` on Meta — a
        // deliberate non-mapping. So a webhook could stop reporting revenue and the logs
        // would say nothing was wrong. The outcome is now its own word, and the
        // walk still cannot take the webhook down with it.
        const warnings = [];
        const record = (line) => warnings.push(String(line));
        const guarded = { ...ctx, log: record, error: record, warn: record };

        const results = conversions.deliverConversion({
          event: 'purchsae',
          params: PURCHASE_PARAMS,
          eventId: 'purchsae._test-typo',
          ctx: guarded,
          omega: omega,
        });

        for (const provider of ['google', 'meta', 'tiktok']) {
          expect(outcomeFor(results, provider), `${provider} must say the NAME was wrong, not that the provider declined to map a real event`).toBe('skipped (unknown event)');
        }

        const loud = warnings.filter((line) => line.includes('[unknown canonical event]'));

        expect(loud.length, `exactly one loud line, not one per provider: ${warnings.join(' | ')}`).toBe(1);
        expect(loud[0].includes('purchsae'), `the line must name the offender: ${loud[0]}`).toBe(true);
      },
    },

    {
      name: 'the-outcomes-an-ad-platform-has-no-use-for-reach-google-only',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The catalog maps none of these on Meta or TikTok — an unmapped provider
        // is a decision, and the adapter skips rather than inventing an event.
        // `trial_lapse` is the deliberate omission of the exclusion lane below
        // ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)): a lapsed
        // trialist is a win-back audience to retarget, not one to hide ads from.
        // The other two are [#407](https://github.com/Omega-JS-Stack/omega/issues/407)'s
        // lifecycle additions, dark to an ad platform because no money moved.
        for (const event of ['subscription_uncancel', 'subscription_plan_change', 'trial_lapse']) {
          const results = deliver({ ctx, omega, event });

          expect(descriptorFor(results, 'google').name, `${event} resolves on GA4 under its own name`).toBe(event);
          expect(outcomeFor(results, 'meta'), `${event} has no Meta mapping`).toBe('skipped (no mapping)');
          expect(outcomeFor(results, 'tiktok'), `${event} has no TikTok mapping`).toBe('skipped (no mapping)');
        }
      },
    },

    {
      name: 'a-cancellation-and-a-refund-build-exclusion-audiences-worth-zero',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The churn moments an ad platform CAN use
        // ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)): neither
        // Meta nor TikTok can subtract revenue and neither optimizes against an
        // event, but both can build an exclusion audience from a custom one. So
        // each webhook fire that already reaches GA4 now resolves on the two
        // platforms as well — at value ZERO, because a refund carrying its
        // amount would ADD to the return their ads manager reports.
        for (const [event, native] of [['subscription_cancel', 'SubscriptionCancel'], ['refund', 'Refund']]) {
          const results = deliver({ ctx, omega, event });

          const google = descriptorFor(results, 'google');
          const meta = descriptorFor(results, 'meta');
          const tiktok = descriptorFor(results, 'tiktok');

          expect(google.name, `${event} still resolves on GA4 under its own name`).toBe(event);
          expect(google.payload.value, 'GA4 keeps the real number — its revenue report is where a refund nets out').toBe(9.99);

          expect(meta.name, `${event} reaches Meta as ${native}`).toBe(native);
          expect(meta.kind, 'Meta defines no churn event, so the pixel command is trackCustom').toBe('custom');
          expect(meta.payload.value, 'a churn signal must never book revenue in an ad account').toBe(0);
          expect(meta.payload.content_ids, 'the plan is what makes the audience worth building').toEqual(['premium']);

          expect(tiktok.name, `${event} reaches TikTok as ${native}`).toBe(native);
          expect(tiktok.kind).toBe('custom');
          expect(tiktok.payload.value, 'TikTok cannot subtract revenue either').toBe(0);
          expect(tiktok.payload.contents[0].content_id).toBe('premium');
          expect(tiktok.payload.contents[0].price, 'the per-item price would put the amount back on the wire').toBe(undefined);
          expect(tiktok.payload.contents[0].quantity, 'so it comes off with the value, like Meta\'s signal').toBe(undefined);

          // The bodies that would go on the wire carry the same zero.
          const body = conversions.buildMetaBody({ descriptor: meta, identity: {}, eventId: `${event}._test-webhook-event` });
          const tiktokBody = conversions.buildTikTokBody({ descriptor: tiktok, identity: {}, eventId: `${event}._test-webhook-event`, pixelCode: '_TEST_PIXEL' });

          expect(body.data[0].event_name).toBe(native);
          expect(body.data[0].custom_data.value).toBe(0);
          expect(tiktokBody.data[0].event).toBe(native);
          expect(tiktokBody.data[0].properties.value).toBe(0);
          expect(JSON.stringify(tiktokBody).includes('9.99'), 'no amount rides a churn body under ANY key').toBe(false);
        }
      },
    },

    {
      name: 'a-trial-conversion-reaches-all-three-as-real-revenue',
      auth: 'none',

      async run({ expect, ctx, omega }) {
        // The one [#407] addition where money actually moved, so unlike the four
        // above it carries a full mapping: GA4's standard purchase (revenue
        // belongs in the revenue report) and each ad platform's Purchase, which
        // is what every real charge is to them (Ian's money-event table, [#652]).
        const results = deliver({
          ctx,
          omega,
          event: 'trial_convert',
          params: { ...PURCHASE_PARAMS, is_trial: true, is_recurring: false },
        });

        const google = descriptorFor(results, 'google');

        expect(google.name, 'the first real charge lands in GA4 revenue').toBe('purchase');
        expect(google.payload.value).toBe(9.99);
        expect(google.payload.is_trial, 'the flag pair is what marks it inside GA4 purchase').toBe(true);
        expect(google.payload.is_recurring).toBe(false);

        expect(descriptorFor(results, 'meta').name).toBe('Purchase');
        expect(descriptorFor(results, 'tiktok').name).toBe('Purchase');
      },
    },

    {
      // An emulator boot seeds personas, every seeded account fired the server
      // half of `sign_up`, and Meta DELIVERED dozens of fake registrations to the
      // brand's live pixel — real ad data polluted by a dev run
      // ([#464](https://github.com/Omega-JS-Stack/omega/issues/464)). The gate is
      // the one `@omega.js/monitoring` and the GA4 Measurement Protocol helper
      // already use: outside production, nothing goes out.
      name: 'a-dev-run-resolves-the-whole-walk-and-delivers-nothing',
      auth: 'none',

      async run({ expect }) {
        const { results, calls, lines } = fireOnRecordedWire({ production: false });

        expect(calls.length, `an emulator run must reach no platform: ${calls.map((call) => call.url).join(', ')}`).toBe(0);

        for (const [provider, native] of [['meta', 'Purchase'], ['tiktok', 'Purchase']]) {
          expect(outcomeFor(results, provider), `${provider} says it was blocked, not that it sent`).toBe('blocked (dev)');
          expect(descriptorFor(results, provider).name, `${provider} still resolves — the dev trace names what WOULD have fired`).toBe(native);

          const blocked = lines.filter((line) => line.includes(`[${provider}]`) && line.includes('blocked (dev)'));

          expect(blocked.length, `exactly one blocked line for ${provider}: ${lines.join(' | ')}`).toBe(1);
          expect(blocked[0].includes('purchase'), `the line names the event: ${blocked[0]}`).toBe(true);
        }

        // And the same fire in production is the proof the gate reads the
        // environment rather than simply never sending.
        expect(fireOnRecordedWire({ production: true }).calls.length, 'production still delivers to both platforms').toBe(2);
      },
    },
  ],
});
