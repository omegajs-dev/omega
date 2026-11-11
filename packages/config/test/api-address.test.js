// src/api-address.js is the one home of a brand's API address: `api.<host>` for a
// host the brand owns, the Cloud Functions address of its project on a default
// Pages host, and nothing when neither can be named.

const defineCases = require('@omega.js/devkit/test/define-cases');

const { apiAddress } = require('@omega.js/config/api-address');

module.exports = defineCases({
  type: 'group',
  description: 'api-address',
  tests: [
    {
      name: 'apiAddress: an owned host is api.<host>, path and port dropped',
      run: (ctx) => {
        ctx.expect(apiAddress('https://acme.com', 'p')).toBe('https://api.acme.com');
        ctx.expect(apiAddress('https://acme.com:8443/shop/', 'p')).toBe('https://api.acme.com');
      },
    },

    {
      name: 'apiAddress: a default Pages host is the project\'s omega_api Cloud Functions address',
      run: (ctx) => {
        ctx.expect(apiAddress('https://ian.github.io/site', 'omegajs-playground'))
          .toBe('https://us-central1-omegajs-playground.cloudfunctions.net/omega_api');
      },
    },

    {
      name: 'apiAddress: a region names the Cloud Functions host it is served from',
      run: (ctx) => {
        ctx.expect(apiAddress('https://ian.github.io/site', 'p', 'europe-west1'))
          .toBe('https://europe-west1-p.cloudfunctions.net/omega_api');
      },
    },

    {
      name: 'apiAddress: no url, a url with no scheme, or a Pages host with no project id, is the empty string',
      run: (ctx) => {
        ctx.expect(apiAddress('https://ian.github.io', undefined)).toBe('');
        ctx.expect(apiAddress('', 'p')).toBe('');
        ctx.expect(apiAddress('not-a-valid-url', 'p'), 'the schema requires an absolute url').toBe('');
      },
    },
  ],
});
