/**
 * The edge service's `workers` operation, driven directly over a temp brand
 * root and the recording fake: a script resolves from the brand's
 * `workers/`, then the company tree's, then the framework's, a script in none
 * rejects before any request, and `secrets` ride the upload as `secret_text`
 * bindings read from the brand environment beside the `plain_text` ones.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { join } = require('node:path');
const jetpack = require('fs-jetpack');
const { recordBrand } = require('@omega.js/config');

// The machine registry is per-machine state: fixtures write into a temp home
require('@omega.js/devkit/test/temp-home');

const { ZONE, brandConfig, fakeApi, handlerContext } = require('./lib/edge-fixture.js');
const ensureWorkers = require('../src/services/edge/ensure/workers.js');

// Tests must never see a real token from the shell environment
delete process.env.CLOUDFLARE_TOKEN;

const SECRET_KEY = 'WORKKIT_APP_PRIVATE_KEY';
const BRAND_PROXY = "export default { fetch() { return new Response('brand'); } }";
const TOKEN_SERVICE = "export default { fetch() { return new Response('token'); } }";
const COMPANY_SHARED = "export default { fetch() { return new Response('company'); } }";

/** Every read the step makes on an empty account, and the two writes it makes. */
function workerApi(name) {
  return fakeApi({
    zones: [ZONE],
    responses: {
      'GET /accounts': [{ id: 'acct-1' }],
      'GET /zones/zone-1': { ...ZONE, account: { id: 'acct-1', name: 'Fixture Account' } },
      'GET /accounts/acct-1/workers/scripts': [],
      'GET /zones/zone-1/workers/routes': [],
      [`PUT /accounts/acct-1/workers/scripts/${name}`]: { id: name },
      'POST /zones/zone-1/workers/routes': { id: 'r1' },
    },
  });
}

/** A config whose one worker is `worker`, routed under the brand domain. */
function configWith(worker) {
  const config = brandConfig();
  config.edge.providers.cloudflare.workers = [{ route: 'api.{ domain }/x*', ...worker }];
  return config;
}

/** A handler context whose brand root holds `workers/<file>` for each entry. */
function contextWith(config, api, brandWorkers = {}) {
  const context = handlerContext(config, api);
  for (const [file, content] of Object.entries(brandWorkers)) {
    jetpack.write(join(context.brandRoot, 'workers', file), content);
  }
  return context;
}

/**
 * The company brand, its `company/workers/<file>` for each entry, and the
 * brand's ONE key naming it.
 */
function stageCompany(brandRoot, companyWorkers) {
  const companyBrandRoot = jetpack.tmpDir({ prefix: 'omega-workers-company-' }).path();
  for (const [file, content] of Object.entries(companyWorkers)) {
    jetpack.write(join(companyBrandRoot, 'company', 'workers', file), content);
  }

  jetpack.write(join(brandRoot, 'config', 'omega.json5'), {
    brand: { id: 'fixture-brand', url: 'https://fixture-brand.test' },
    company: { id: 'fixture-co' },
  });
  // The line the company brand's own run writes, nobody maintains it
  recordBrand({ id: 'fixture-co', root: companyBrandRoot, name: 'Fixture Co', url: 'https://fixture-co.test' });
}

const upload = (api, name) => api.call('PUT', `/accounts/acct-1/workers/scripts/${name}`);

module.exports = defineCases({
  type: 'group',
  description: 'edge-workers',
  tests: [
    {
      name: 'workers: brand-workers-folder-wins-over-the-framework-file',
      run: async (ctx) => {
        const api = workerApi('api-proxy');
        const config = configWith({ name: 'api-proxy', script: 'omega-api-proxy.js', env: {} });

        await ensureWorkers(contextWith(config, api, { 'omega-api-proxy.js': BRAND_PROXY }));

        const call = upload(api, 'api-proxy');
        ctx.expect(call, 'the step uploaded the script').toBeTruthy();
        ctx.expect(await call.form.get('index.js').text()).toBe(BRAND_PROXY);
      },
    },

    {
      name: 'workers: the-company-tree-supplies-a-script-the-brand-lacks',
      run: async (ctx) => {
        const api = workerApi('shared');
        const config = configWith({ name: 'shared', script: 'shared.js', env: {} });
        const context = contextWith(config, api);
        stageCompany(context.brandRoot, { 'shared.js': COMPANY_SHARED });

        await ensureWorkers(context);

        const call = upload(api, 'shared');
        ctx.expect(call, 'the step uploaded the script').toBeTruthy();
        ctx.expect(await call.form.get('index.js').text()).toBe(COMPANY_SHARED);
      },
    },

    {
      name: 'workers: the-framework-file-serves-when-the-brand-and-company-lack-it',
      run: async (ctx) => {
        const api = workerApi('api-proxy');
        const config = configWith({ name: 'api-proxy', script: 'omega-api-proxy.js', env: {} });
        const context = contextWith(config, api);
        stageCompany(context.brandRoot, {});
        // The framework file is the fixture, so its bytes are the expectation
        const frameworkProxy = jetpack.read(join(__dirname, '..', 'src', 'services', 'edge', 'workers', 'omega-api-proxy.js'));

        await ensureWorkers(context);

        const call = upload(api, 'api-proxy');
        ctx.expect(call, 'the step uploaded the script').toBeTruthy();
        ctx.expect(await call.form.get('index.js').text()).toBe(frameworkProxy);
      },
    },

    {
      name: 'workers: a-script-in-no-tier-rejects-before-any-request',
      run: async (ctx) => {
        const api = workerApi('ghost');
        const config = configWith({ name: 'ghost', script: 'missing.js' });
        const context = contextWith(config, api);
        const brandRoot = context.brandRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        await ctx.expect(ensureWorkers(context)).rejects.toThrow(new RegExp(
          `Worker script not found: missing\\.js \\(looked in ${brandRoot}/workers/missing\\.js, the company tree, and .*src/services/edge/workers/missing\\.js\\)`,
        ));
        ctx.expect(api.calls, 'no request was sent').toEqual([]);
      },
    },

    {
      name: 'workers: secrets-ride-as-secret_text-bindings-beside-env-plain_text',
      run: async (ctx) => {
        process.env[SECRET_KEY] = 'pem-base64';
        try {
          const api = workerApi('token-service');
          const config = configWith({
            name: 'token-service', script: 'token-service.js', env: { MODE: 'live' }, secrets: [SECRET_KEY],
          });

          await ensureWorkers(contextWith(config, api, { 'token-service.js': TOKEN_SERVICE }));

          const call = upload(api, 'token-service');
          ctx.expect(call, 'the step uploaded the script').toBeTruthy();
          const metadata = JSON.parse(call.form.get('metadata'));
          ctx.expect(metadata.main_module).toBe('index.js');
          ctx.expect(metadata.bindings).toEqual([
            { type: 'plain_text', name: 'FUNCTIONS_REGION', text: 'us-central1' },
            { type: 'plain_text', name: 'MODE', text: 'live' },
            { type: 'secret_text', name: SECRET_KEY, text: 'pem-base64' },
          ]);
          ctx.expect(await call.form.get('index.js').text()).toBe(TOKEN_SERVICE);
        } finally {
          delete process.env[SECRET_KEY];
        }
      },
    },

    {
      name: 'workers: a-listed-secret-with-no-value-rejects-naming-the-key',
      run: async (ctx) => {
        delete process.env[SECRET_KEY];
        const api = workerApi('token-service');
        const config = configWith({ name: 'token-service', script: 'token-service.js', secrets: [SECRET_KEY] });

        await ctx.expect(ensureWorkers(contextWith(config, api, { 'token-service.js': TOKEN_SERVICE }))).rejects.toThrow(
          /Worker token-service: secret WORKKIT_APP_PRIVATE_KEY is not set in the brand \.env/,
        );
        ctx.expect(api.calls, 'no request was sent').toEqual([]);
      },
    },
  ],
});
