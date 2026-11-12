/**
 * Test: router.js: request URL to pipeline route path
 *
 * Run: npx omega test backend:helpers/router
 *
 * Every incoming HTTP request enters the pipeline through this one
 * resolution, and the prefix table is a contract:
 *   /omega/…            the canonical prefix
 *   /omega_api/…        the direct Cloud Function URL
 * Everything else keeps its path, minus the leading slash, including a first
 * segment that merely STARTS with a prefix word (/omegatron/…), since a prefix
 * only counts as a whole segment. The retired /backend-manager/ alias is no
 * prefix at all: a legacy client's path names no route.
 *
 * dispatch() serves the MCP endpoint, else the FRAMEWORK's route of that name:
 * `omega_api` is omega's own, and a consumer route rides its own function
 * (omega.routes.run()), so a consumer route of the same name is never reached.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRoutePath, dispatch } = require('../../dist/omega/router.js');
const { bootOmega } = require('./_boot-omega.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// The router only ever reads req.path.
const resolve = (path) => resolveRoutePath({ path });

// A consumer cwd whose routes/ carries a route the framework does not ship
function consumerCwd(route) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-router-'));
  const dir = path.join(cwd, 'routes', route);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'get.js'), "export default async ({ ctx }) => ctx.respond({ from: 'consumer' });");

  return cwd;
}

// One real request through dispatch() on a real express app (the request and
// response objects the pipeline reads), answered and closed
async function dispatchOnce(omega, urlPath) {
  const app = require('express')();

  app.use((req, res) => dispatch(omega, req, res));

  const server = await new Promise((resolveServer) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.close();
  }
}

module.exports = defineCases({
  description: 'router resolveRoutePath() route path extraction',
  type: 'group',

  tests: [
    // ─── The canonical prefix ───

    {
      name: 'strips-the-omega-prefix',
      async run({ expect }) {
        expect(resolve('/omega/user/sign-up')).toBe('user/sign-up');
        expect(resolve('/omega/admin/post')).toBe('admin/post');
      },
    },

    {
      // The direct Cloud Function URL. The prefix alternation is ordered
      // longest-first AND followed by a boundary assertion, so `omega` can
      // never win a `/omega_api/…` path the way first-match alternation
      // used to (which left `_api/…`, a route that cannot exist).
      name: 'strips-the-direct-function-url-prefix',
      async run({ expect }) {
        expect(resolve('/omega_api/user/sign-up')).toBe('user/sign-up');
      },
    },

    {
      // A brand on a default Pages host calls `<functions address>/omega_api/omega/health`;
      // Cloud Functions hands the function the path after its name, so the router
      // sees `/omega/health` and must still find the route.
      name: 'the-functions-address-path-of-a-pages-brand-resolves-its-route',
      async run({ expect }) {
        expect(resolve('/omega/health')).toBe('health');
      },
    },

    {
      name: 'the-retired-backend-manager-alias-is-no-prefix',
      async run({ expect }) {
        expect(resolve('/backend-manager/user/sign-up')).toBe('backend-manager/user/sign-up');
      },
    },

    // ─── Bare prefixes and depth ───

    {
      name: 'a-bare-prefix-resolves-to-the-empty-route',
      async run({ expect }) {
        expect(resolve('/omega/')).toBe('');
        expect(resolve('/omega')).toBe('');
        expect(resolve('/omega_api')).toBe('');
      },
    },

    {
      name: 'deep-paths-keep-every-remaining-segment',
      async run({ expect }) {
        expect(resolve('/omega/payment/subscription/cancel')).toBe('payment/subscription/cancel');
        expect(resolve('/omega/a/b/c/d/e')).toBe('a/b/c/d/e');
      },
    },

    {
      name: 'trailing-slashes-are-preserved',
      async run({ expect }) {
        expect(resolve('/omega/user/sign-up/')).toBe('user/sign-up/');
      },
    },

    // ─── Unprefixed and absent paths ───

    {
      name: 'an-unprefixed-path-just-loses-its-leading-slash',
      async run({ expect }) {
        expect(resolve('/user/sign-up')).toBe('user/sign-up');
        expect(resolve('user/sign-up')).toBe('user/sign-up');
      },
    },

    {
      name: 'an-absent-path-resolves-to-the-empty-route',
      async run({ expect }) {
        expect(resolve('')).toBe('');
        expect(resolve(undefined)).toBe('');
        expect(resolve('/')).toBe('');
      },
    },

    // ─── The prefix must LEAD ───

    {
      name: 'a-prefix-word-mid-path-is-not-stripped',
      async run({ expect }) {
        expect(resolve('/api/omega/user')).toBe('api/omega/user');
        expect(resolve('/omega/omega/user'), 'only the leading prefix goes').toBe('omega/user');
      },
    },

    {
      // The prefix must be a WHOLE first segment: a path whose first segment
      // merely starts with a prefix word is not a prefixed path at all, and
      // keeps every character (minus its leading slash).
      name: 'a-route-merely-starting-with-a-prefix-word-is-untouched',
      async run({ expect }) {
        expect(resolve('/omegatron/user')).toBe('omegatron/user');
        expect(resolve('/backend-manager-legacy/user')).toBe('backend-manager-legacy/user');
      },
    },

    // ─── Query strings never reach here (req.path excludes them) ───

    {
      name: 'the-resolution-returns-the-route-path-string',
      async run({ expect }) {
        expect(typeof resolveRoutePath({ path: '/omega/user/sign-up' })).toBe('string');
      },
    },

    // ─── dispatch(): omega_api serves the framework's routes only ───

    {
      name: 'a-route-only-the-consumer-ships-answers-the-framework-missing-route',
      async run({ expect }) {
        const omega = bootOmega();
        omega.cwd = consumerCwd('only-in-consumer');

        const answer = await dispatchOnce(omega, '/omega/only-in-consumer');

        expect(answer.status, 'the pipeline\'s missing-route answer').toBe(404);
        expect(answer.text, 'looked up under the framework\'s routes/').toMatch(/only-in-consumer\): route does not exist/);
        expect(answer.text.includes('"from":"consumer"'), 'the consumer module never answered').toBe(false);
      },
    },
  ],
});
