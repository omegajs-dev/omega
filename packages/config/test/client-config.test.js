/**
 * client-config.test.js: clientConfig(), the ONE browser-safe subset
 * ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)).
 *
 * Three surfaces bake a config into a public artifact (web's page chrome,
 * desktop's renderer bundle, every extension bundle), and each one used to
 * decide what a browser may see on its own: desktop shipped the WHOLE resolved
 * config, the extension kept a hand-written allow list, web wired a subset
 * together in its engine and its foot include. This function is that decision,
 * once, off the schema's own `client` flag.
 */

const defineCases = require('@omega.js/devkit/test/define-cases');
const { clientConfig, CLIENT_SECTIONS, ANALYTICS_PROVIDERS } = require('../src/index.js');

// A resolved config with one key in every shape the gate has to judge.
const RESOLVED = () => ({
  // client sections
  brand: { id: 'acme', name: 'Acme', url: 'https://acme.com' },
  company: { id: 'itw-creative-works', name: 'ITW', url: 'https://itw.com' },
  theme: { id: 'classy', appearance: 'dark' },
  analytics: { providers: { google: { id: 'G-1' } } },
  advertising: { providers: { adsense: { client: 'ca-pub-1' } } },
  captcha: { providers: { recaptcha: { siteKey: 'site-key' } } },
  monitoring: { enabled: true, providers: { sentry: { dsn: 'https://dsn' } } },
  connections: { twitch: { clientId: 'twitch-client' } },
  features: { requests: { name: 'Requests' } },
  payment: { providers: { stripe: { publishableKey: 'pk_live' } }, products: [] },
  client: { consent: { enabled: true }, auth: { config: { policy: 'authenticated' } } },
  listings: { chrome: { id: 'abcdefghijklmnopqrstuvwxyzabcdef' } },
  cloud: {
    provider: 'firebase',
    config: { apiKey: 'public-web-key', projectId: 'acme' },
    messaging: { vapidKey: 'vapid' },
    // Provisioning facts a browser has no use for
    billingAccount: '01ABCD-234567-89EFGH',
    organizationId: '123456789',
    apiSubdomain: true,
  },
  forms: { providers: { slapform: { formId: 'form-1', plan: 'pro', templateId: 'tpl-1' } } },
  inbound: {
    chat: { providers: { chatsy: { enabled: true, agentId: 'agent-1', settings: { button: {} }, plan: 'pro' } } },
    email: { providers: { postmark: { serverId: 'srv-1' } } },
  },

  // build facts every surface composes
  runtime: 'browser-extension',
  environment: 'production',
  version: '3.1.4',
  buildTime: 1757000000000,
  target: 'extension',
  url: 'https://acme.com',
  dev: { ports: { backend: 5002 }, origin: 'https://localhost:4001' },

  // sections the browser never sees
  account: { enabled: true, admins: [{ email: 'root@acme.com' }] },
  repo: { provider: 'github', owner: 'Acme-Org' },
  edge: { providers: { cloudflare: { zone: 'acme.com' } } },
  certificates: { providers: { apple: { teamId: 'TEAM' } } },
  domain: { namecheap: {} },
  search: { providers: { google: { property: 'acme.com' } } },
  marketing: { campaigns: {}, newsletter: {} },
  translation: { enabled: true, languages: ['es'] },
  platforms: { windows: { signing: 'cloud' } },
  releases: { enabled: true },
  restartManager: true,
  remoteScripts: true,
  hosting: { provider: 'github' },
  purgecss: { safelist: { standard: ['x'] } },
  collections: { docs: { field: 'doc.category' } },
  categories: ['privacy-security'],
  targets: { web: { type: 'web' }, extension: { type: 'extension' } },
  type: 'extension',
});

module.exports = defineCases({
  type: 'group',
  description: 'client-config',
  tests: [
    {
      name: 'the client sections ride whole',
      run: (ctx) => {
        const client = clientConfig(RESOLVED());

        ctx.expect(client.brand).toEqual({ id: 'acme', name: 'Acme', url: 'https://acme.com' });
        ctx.expect(client.theme).toEqual({ id: 'classy', appearance: 'dark' });
        ctx.expect(client.analytics.providers).toEqual({ google: { id: 'G-1' } });
        ctx.expect(client.advertising).toEqual({ providers: { adsense: { client: 'ca-pub-1' } } });
        ctx.expect(client.captcha).toEqual({ providers: { recaptcha: { siteKey: 'site-key' } } });
        ctx.expect(client.monitoring).toEqual({ enabled: true, providers: { sentry: { dsn: 'https://dsn' } } });
        ctx.expect(client.connections).toEqual({ twitch: { clientId: 'twitch-client' } });
        ctx.expect(client.features).toEqual({ requests: { name: 'Requests' } });
        ctx.expect(client.client).toEqual({ consent: { enabled: true }, auth: { config: { policy: 'authenticated' } } });
        ctx.expect(client.listings).toEqual({ chrome: { id: 'abcdefghijklmnopqrstuvwxyzabcdef' } });
      },
    },

    {
      name: 'every bake carries one capability entry per provider row, and providers only when configured',
      run: (ctx) => {
        const rows = Object.values(ANALYTICS_PROVIDERS);
        const configured = clientConfig(RESOLVED()).analytics;
        // A page fires events whether or not the brand configured a provider, so the rows ride every bake
        const bare = clientConfig({ brand: { id: 'acme' } }).analytics;

        for (const analytics of [configured, bare]) {
          const baked = Object.values(analytics.capabilities);

          ctx.expect(baked.map((entry) => entry.id).sort(), 'one entry per row').toEqual(rows.map((row) => row.id).sort());
          for (const row of rows) {
            ctx.expect(baked.find((entry) => entry.id === row.id), `${row.id} carries its row's fields`).toEqual(JSON.parse(JSON.stringify(row)));
          }
        }

        ctx.expect(configured.providers).toEqual({ google: { id: 'G-1' } });
        ctx.expect(bare.providers, 'no analytics section, no providers').toBe(undefined);
      },
    },

    {
      name: 'a non-client section NEVER passes',
      run: (ctx) => {
        const client = clientConfig(RESOLVED());

        for (const section of [
          'account', 'repo', 'edge', 'certificates', 'domain', 'search', 'marketing', 'translation',
          'platforms', 'releases', 'restartManager', 'remoteScripts', 'hosting', 'purgecss',
          'collections', 'categories', 'targets', 'type',
        ]) {
          ctx.expect(client[section], `${section} must never reach a browser`).toBe(undefined);
        }
      },
    },

    {
      name: 'cloud rides its PUBLIC half only: the web config, not the GCP account',
      run: (ctx) => {
        const client = clientConfig(RESOLVED());

        // The Firebase web config is public by design, and the client boots from it
        ctx.expect(client.cloud.config).toEqual({ apiKey: 'public-web-key', projectId: 'acme' });
        ctx.expect(client.cloud.messaging).toEqual({ vapidKey: 'vapid' });
        // The provisioning facts stay in the build
        ctx.expect(client.cloud.billingAccount).toBe(undefined);
        ctx.expect(client.cloud.organizationId).toBe(undefined);
        ctx.expect(client.cloud.apiSubdomain).toBe(undefined);
        ctx.expect(client.cloud.provider).toBe(undefined);
      },
    },

    {
      name: 'forms and inbound ride the LEAVES the runtime reads, never their provisioning siblings',
      run: (ctx) => {
        const client = clientConfig(RESOLVED());

        ctx.expect(client.forms).toEqual({ providers: { slapform: { formId: 'form-1' } } });
        ctx.expect(client.inbound).toEqual({
          chat: { providers: { chatsy: { enabled: true, agentId: 'agent-1', settings: { button: {} } } } },
        });
      },
    },

    {
      name: 'every build fact rides',
      run: (ctx) => {
        const resolved = RESOLVED();
        const client = clientConfig(resolved);

        ctx.expect(client.runtime).toBe('browser-extension');
        ctx.expect(client.environment).toBe('production');
        ctx.expect(client.version).toBe('3.1.4');
        ctx.expect(client.buildTime).toBe(1757000000000);
        ctx.expect(client.target).toBe('extension');
        ctx.expect(client.url).toBe('https://acme.com');
        ctx.expect(client.dev).toEqual(resolved.dev);
        // The resolved company (#677) is a config section, and the browser reads it
        ctx.expect(client.company).toEqual(resolved.company);
      },
    },

    {
      name: 'a secret-shaped key inside a client section FAILS the build',
      run: (ctx) => {
        const resolved = RESOLVED();
        resolved.connections.twitch.clientSecret = 'never-in-a-bundle';

        ctx.expect(() => clientConfig(resolved)).toThrow((error) => {
            ctx.expect(error.message).toMatch(/connections\.twitch\.clientSecret/);
            ctx.expect(error.message).toMatch(/\.env/);
            return true;
          });
      },
    },

    {
      name: 'a secret-shaped key in a NON-client section is nobody\'s business here',
      run: (ctx) => {
        const resolved = RESOLVED();
        resolved.edge.providers.cloudflare.apiToken = 'stays-in-the-build';

        ctx.expect(clientConfig(resolved).edge).toBe(undefined);
      },
    },

    {
      name: 'payment rides with its winback offer RESOLVED, so the dialog and the coupon agree',
      run: (ctx) => {
        const client = clientConfig(RESOLVED());

        ctx.expect(client.payment.providers).toEqual({ stripe: { publishableKey: 'pk_live' } });
        // The framework default (@omega.js/config's one home) is materialized here
        ctx.expect(client.payment.winback.enabled).toBe(true);
        ctx.expect(client.payment.winback.percent).toBe(50);
        ctx.expect(client.payment.winback.duration).toBe('once');
      },
    },

    {
      name: 'an empty resolved config answers the provider capabilities alone, never a throw',
      run: (ctx) => {
        for (const client of [clientConfig({}), clientConfig()]) {
          ctx.expect(Object.keys(client), 'nothing but the bake every page needs').toEqual(['analytics']);
          ctx.expect(Object.keys(client.analytics)).toEqual(['capabilities']);
        }
      },
    },

    {
      name: 'the subset never aliases the resolved config: a caller mutation cannot reach it',
      run: (ctx) => {
        const resolved = RESOLVED();
        const client = clientConfig(resolved);

        client.brand.name = 'Mutated';
        ctx.expect(resolved.brand.name).toBe('Acme');
      },
    },

    {
      name: 'the flag is DECLARED once, in the schema',
      run: (ctx) => {
        ctx.expect(CLIENT_SECTIONS.brand).toBe(true);
        ctx.expect(CLIENT_SECTIONS.account).toBe(undefined);
        ctx.expect(Array.isArray(CLIENT_SECTIONS.cloud)).toBeTruthy();
      },
    },
  ],
});
