/**
 * Test: routes/user/signup/record-fields.locationFromGeolocation, the
 * `personal.location` fill signup derives from the request's geolocation.
 *
 * Run (from the framework repo): npm test routes/user/signup-location
 *
 * Contract:
 *   - The request's country/region/city fill the matching `personal.location`
 *     fields, so the ad-platform match keys carry ct/st/country.
 *   - A value the user set (incoming settings or the existing doc) ALWAYS wins;
 *     nothing to fill returns an EMPTY object (no `personal.location` key).
 */
const recordFields = require('../../../dist/omega/routes/user/signup/record-fields.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const { locationFromGeolocation } = recordFields;

// The shape the Context resolves from the request headers (cf-ipcountry /
// x-country-code / x-appengine-*) — the extra fields are ignored by the fill.
const GEOLOCATION = {
  ip: '203.0.113.7',
  continent: 'NA',
  country: 'US',
  region: 'CA',
  city: 'San Francisco',
  latitude: 37.7749,
  longitude: -122.4194,
};

module.exports = defineCases({
  description: 'routes/user/signup/record-fields.locationFromGeolocation',
  type: 'group',

  tests: [
    {
      name: 'fills-an-empty-location-from-the-request-geolocation',
      async run({ expect }) {
        // A doc resolved from the account schema carries the location leaves as nulls
        expect(locationFromGeolocation(GEOLOCATION, { country: null, region: null, city: null }), 'country/region/city come from the request geolocation').toEqual({ country: 'US', region: 'CA', city: 'San Francisco' });
      },
    },

    {
      name: 'never-overwrites-a-location-the-user-set',
      async run({ expect }) {
        expect(locationFromGeolocation(GEOLOCATION, { country: 'FR', region: 'IDF', city: 'Paris' }), 'a self-reported location is left entirely alone').toEqual({});
      },
    },

    {
      name: 'fills-only-the-fields-the-user-left-empty',
      async run({ expect }) {
        expect(locationFromGeolocation(GEOLOCATION, { country: null, region: null, city: 'Oakland' }), 'the fill is per-field — the city the user set survives').toEqual({ country: 'US', region: 'CA' });
      },
    },

    {
      name: 'writes-nothing-when-the-request-carries-no-geolocation',
      async run({ expect }) {
        expect(locationFromGeolocation({ ip: '203.0.113.7', country: null, region: null, city: null }, {}), 'no geolocation means no personal.location key in the write').toEqual({});
      },
    },
  ],
});
