/**
 * Test: the public `/brand` payload carries the repo block as the brand
 * declares it, `{ provider, owner }`, read off a real brand config on disk
 * through the real loader. No request is made: the payload builder is the
 * route's own export, called directly.
 *
 * Run: npx omega test framework:routes/brand/public-config
 */
const path = require('path');
const jetpack = require('fs-jetpack');

const { buildPublicConfig } = require('../../../dist/omega/routes/brand/public-config.js');
const { loadConfig } = require('../../helpers/_shared-config.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

function brandConfig() {
  const root = jetpack.tmpDir({ prefix: 'brand-public-config-' }).path();

  jetpack.write(path.join(root, 'config', 'omega.json5'), `{
    brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
    repo: { provider: 'github', owner: 'Acme' },
    targets: { backend: { type: 'backend' } },
  }`);

  try {
    return loadConfig(root, 'backend').config;
  } finally {
    jetpack.remove(root);
  }
}

module.exports = defineCases({
  description: 'GET /brand: the public payload',
  type: 'group',

  tests: [
    {
      name: 'the-payload-repo-is-provider-and-owner',
      auth: 'none',

      async run({ expect }) {
        expect(buildPublicConfig(brandConfig()).repo).toEqual({ provider: 'github', owner: 'Acme' });
      },
    },
  ],
});
