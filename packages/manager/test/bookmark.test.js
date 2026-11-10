/**
 * Bookmark service tests — link derivation from new-world config shapes
 * (single monorepo repo, unslugged Stripe, per-target backend API link) and
 * the WebSocket sync against a REAL ws client standing in for the
 * extension: ack → success, refusal → warned, no-connection timeout →
 * warned, non-interactive → clean skip, dry-run → planned groups with no
 * server opened.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const net = require('node:net');
const WebSocket = require('ws');

const { run } = require('../src/services/bookmark/index.js');
const { generateLinks } = require('../src/services/bookmark/ensure/sync.js');
const { OPERATIONS, SERVICE_ORDER } = require('../src/config.js');
const { openTtyPrompt } = require('./lib/interactive.js');

const FULL_CONFIG = {
  brand: { id: 'fixture', name: 'Fixture Brand', url: 'https://fixture.example' },
  cloud: { config: { projectId: 'fixture-project' } },
  analytics: { providers: { google: { accountId: '111', propertyId: '222' } } },
  repo: { provider: 'github', owner: 'fixture-org' },
  payment: { providers: { stripe: { publishableKey: 'pk_fixture' } } },
};

function runService(context) {
  return run({
    brandId: context.brandConfig.brand.id,
    brandRoot: context.brandRoot || '/nonexistent',
    brandConfig: context.brandConfig,
    targets: context.targets || [],
    operations: OPERATIONS.bookmark,
    options: context.options || {},
    serviceData: {},
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

module.exports = defineCases({
  type: 'group',
  description: 'bookmark',
  tests: [
    // ─── link derivation ─────────────────────────────────────────────────────────

    {
      name: 'bookmark: full config derives every group with new-world shapes',
      run: (ctx) => {
        const targets = [{ name: 'backend', target: 'backend' }, { name: 'web', target: 'web' }];
        const links = generateLinks(FULL_CONFIG, targets, { deployedFunctions: ['omega_api', 'omega_signup'] });

        ctx.expect(Object.keys(links)).toEqual(['Cloud', 'Firebase', 'Analytics', 'Search', 'Stripe', 'GitHub', 'Live']);

        // Cloud: 3 console links + separator + one log link per deployed function
        ctx.expect(links.Cloud.length).toBe(6);
        ctx.expect(links.Cloud[4].title === 'omega_api()' && links.Cloud[4].url.includes('function_name%3D%22omega_api%22')).toBeTruthy();

        // Analytics URLs embed accountId + propertyId
        ctx.expect(links.Analytics[0].url.includes('#/a111p222/')).toBeTruthy();

        // Search Console keyed by the sc-domain of brand.url
        ctx.expect(links.Search[0].url.includes('sc-domain:fixture.example')).toBeTruthy();

        // Stripe links carry NO account slug (per-brand keys)
        ctx.expect(links.Stripe.every((l) => l.url.startsWith('https://dashboard.stripe.com/'))).toBeTruthy();

        // GitHub: the brand's SOURCE monorepo, always `<brand.id>-omega`
        ctx.expect(links.GitHub.map((l) => l.url)).toEqual([
          'https://github.com/fixture-org/fixture-omega',
          'https://github.com/fixture-org/fixture-omega/actions',
        ]);

        // Live: website + API subdomain (backend target present)
        ctx.expect(links.Live.map((l) => l.url)).toEqual(['https://fixture.example', 'https://api.fixture.example']);
      },
    },

    {
      name: 'bookmark: groups with unmet inputs are absent',
      run: (ctx) => {
        const links = generateLinks({ brand: { id: 'bare', name: 'Bare' } }, []);
        ctx.expect(links).toEqual({});

        // The source repo derives from the owner plus the brand id; no backend target
        // means no API link
        const partial = generateLinks(
          { brand: { id: 'p', url: 'https://p.example' }, repo: { owner: 'o' } },
          [{ name: 'web', target: 'web' }],
        );
        ctx.expect(Object.keys(partial)).toEqual(['Search', 'GitHub', 'Live']);
        ctx.expect(partial.GitHub[0].url).toBe('https://github.com/o/p-omega');
        ctx.expect(partial.Live.map((l) => l.title)).toEqual(['Website']);
      },
    },

    {
      name: 'bookmark: the links address the SOURCE repo the one derivation names (#883)',
      run: (ctx) => {
        // No repo name is configurable anywhere: the owner plus `<brand.id>-omega` IS
        // the address, so a link can never point at a repo that does not exist.
        const links = generateLinks(
          { brand: { id: 'acme', url: 'https://acme.example' }, repo: { owner: 'Acme-Org' } },
          [{ name: 'web', target: 'web' }],
        );

        ctx.expect(links.GitHub.map((l) => l.url)).toEqual([
          'https://github.com/Acme-Org/acme-omega',
          'https://github.com/Acme-Org/acme-omega/actions',
        ]);
      },
    },

    {
      name: 'bookmark: a brand on a default Pages host links its API at the project\'s Cloud Functions address',
      run: (ctx) => {
        const links = generateLinks(
          { brand: { id: 'dreamr', url: 'https://dreamr-design.github.io/dreamr-web' }, cloud: { config: { projectId: 'dreamr-app' } } },
          [{ name: 'backend', target: 'backend' }, { name: 'web', target: 'web' }],
        );

        ctx.expect(links.Live.map((l) => l.url)).toEqual([
          'https://dreamr-design.github.io/dreamr-web',
          'https://us-central1-dreamr-app.cloudfunctions.net/omega_api',
        ]);
      },
    },

    // ─── registration ────────────────────────────────────────────────────────────

    {
      name: 'bookmark: registered between migrations and testing',
      run: (ctx) => {
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.indexOf('migrations') + 1]).toBe('bookmark');
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.indexOf('bookmark') + 1]).toBe('testing');
        ctx.expect(OPERATIONS.bookmark.map((op) => op.name)).toEqual(['sync']);
      },
    },

    // ─── sync operation ──────────────────────────────────────────────────────────

    {
      name: 'bookmark: non-interactive run skips cleanly without opening a server',
      run: async (ctx) => {
        const result = await runService({ brandConfig: FULL_CONFIG });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.sync.reason).toBe('non-interactive');
      },
    },

    {
      name: 'bookmark: dry-run reports the planned groups without a server',
      run: async (ctx) => {
        const result = await runService({
          brandConfig: FULL_CONFIG,
          targets: [{ name: 'backend', target: 'backend' }],
          options: { dryRun: true },
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.sync.planned).toEqual(['Cloud', 'Firebase', 'Analytics', 'Search', 'Stripe', 'GitHub', 'Live']);
      },
    },

    {
      name: 'bookmark: extension ack lands the sync as success',
      run: async (ctx) => {
        const port = await freePort();
        process.env.OMEGA_EXTENSION_PORT = String(port);

        // No cloud.config.projectId → no gcloud shell-out during the test
        const config = { brand: { id: 'fixture', name: 'Fixture Brand', url: 'https://fixture.example' }, repo: { owner: 'o' } };

        const tty = openTtyPrompt();
        try {
          const running = runService({ brandConfig: config, targets: [] });

          // The "extension": connect, receive the sync message, ack it
          const received = await new Promise((resolve, reject) => {
            const tryConnect = () => {
              const ws = new WebSocket(`ws://127.0.0.1:${port}`);
              ws.on('error', () => setTimeout(tryConnect, 25)); // server not up yet
              ws.on('message', (data) => {
                ws.send(JSON.stringify({ success: true }));
                resolve(JSON.parse(data.toString()));
              });
            };
            tryConnect();
            setTimeout(() => reject(new Error('sync message never arrived')), 3000);
          });

          ctx.expect(received.type).toBe('OMEGA_BOOKMARK_SYNC');
          ctx.expect(received.brand).toEqual({ id: 'fixture', name: 'Fixture Brand', url: 'https://fixture.example' });
          ctx.expect(Object.keys(received.links)).toEqual(['Search', 'GitHub', 'Live']);

          const result = await running;
          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.sync.synced).toBe(true);
        } finally {
          tty.close();
          delete process.env.OMEGA_EXTENSION_PORT;
        }
      },
    },

    {
      name: 'bookmark: extension refusal warns with its error',
      run: async (ctx) => {
        const port = await freePort();
        process.env.OMEGA_EXTENSION_PORT = String(port);

        const tty = openTtyPrompt();
        try {
          const running = runService({ brandConfig: { brand: { id: 'x', name: 'X' } } });

          await new Promise((resolve) => {
            const tryConnect = () => {
              const ws = new WebSocket(`ws://127.0.0.1:${port}`);
              ws.on('error', () => setTimeout(tryConnect, 25));
              ws.on('message', () => {
                ws.send(JSON.stringify({ success: false, error: 'bookmarks API unavailable' }));
                resolve();
              });
            };
            tryConnect();
          });

          const result = await running;
          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.sync.reason).toBe('bookmarks API unavailable');
        } finally {
          tty.close();
          delete process.env.OMEGA_EXTENSION_PORT;
        }
      },
    },

    {
      name: 'bookmark: no extension → warned after the connect timeout',
      run: async (ctx) => {
        const port = await freePort();
        process.env.OMEGA_EXTENSION_PORT = String(port);
        process.env.OMEGA_EXTENSION_TIMEOUT = '150';

        const tty = openTtyPrompt();
        try {
          const result = await runService({ brandConfig: { brand: { id: 'x', name: 'X' } } });

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.sync.reason).toBe('extension not connected');
        } finally {
          tty.close();
          delete process.env.OMEGA_EXTENSION_PORT;
          delete process.env.OMEGA_EXTENSION_TIMEOUT;
        }
      },
    },
  ],
});
