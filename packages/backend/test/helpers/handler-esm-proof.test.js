/**
 * Test: an ES module handler loads through require() and runs
 *
 * Run: npx omega test backend:helpers/handler-esm-proof
 *
 * A `.js` handler with `export default` and no `"type": "module"` loads
 * through a plain require(). The Node half writes a route and an auth hook
 * into scratch in a handler's body forms (an `import` of a CommonJS helper,
 * `import.meta.dirname`, a lazy `await import()`) and runs each default
 * export; the emulator half sees the framework's own ES module handlers run
 * inside the functions emulator.
 */
const path = require('node:path');
const { scratch } = require('./_handler-cases.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// The helper and the lazy module a handler reaches: CommonJS, as a helper beside a handler stays
const SIBLINGS = {
  'helper.js': "module.exports = { tag: 'from-helper' };\n",
  'lazy.js': "module.exports = { tag: 'from-lazy' };\n",
};

const ROUTE = `import helper from './helper.js';

export default async ({ ctx, omega, user, data, usage, analytics }) => {
  const lazy = await import('./lazy.js');

  return {
    uid: user.uid,
    data,
    helper: helper.tag,
    lazy: lazy.default.tag,
    dirname: import.meta.dirname,
  };
};
`;

const AUTH_HOOK = `import helper from './helper.js';

export default async ({ ctx, omega, user, context }) => {
  const lazy = await import('./lazy.js');

  return {
    uid: user.uid,
    eventType: context.eventType,
    helper: helper.tag,
    lazy: lazy.default.tag,
    dirname: import.meta.dirname,
  };
};
`;

module.exports = defineCases({
  description: 'An ES module handler loads through require() and its default export runs',
  type: 'group',

  tests: [
    {
      name: 'an-es-module-route-loads-through-require-and-runs-with-its-payload',
      async run({ expect, after }) {
        const dir = scratch(after, { ...SIBLINGS, 'get.js': ROUTE });
        const handler = require(path.join(dir, 'get.js')).default;

        const result = await handler({ ctx: {}, omega: {}, user: { uid: 'uid-route' }, data: { n: 7 }, usage: {}, analytics: {} });

        expect(result).toEqual({
          uid: 'uid-route',
          data: { n: 7 },
          helper: 'from-helper',
          lazy: 'from-lazy',
          dirname: dir,
        });
      },
    },

    {
      name: 'an-es-module-auth-hook-loads-through-require-and-runs-with-its-payload',
      async run({ expect, after }) {
        const dir = scratch(after, { ...SIBLINGS, 'on-create.js': AUTH_HOOK });
        const hook = require(path.join(dir, 'on-create.js')).default;

        const result = await hook({ ctx: {}, omega: {}, user: { uid: 'uid-hook' }, context: { eventType: 'user.create' } });

        expect(result).toEqual({
          uid: 'uid-hook',
          eventType: 'user.create',
          helper: 'from-helper',
          lazy: 'from-lazy',
          dirname: dir,
        });
      },
    },

    {
      // The emulator runs the framework's own handlers from this package's dist:
      // loadHandler answering them proves they are ES modules, and the emulator
      // serving them proves its workers load one through require()
      name: 'inside-the-functions-emulator-an-es-module-route-and-auth-handler-run',
      async run({ expect, http, firestore, accounts }) {
        const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
        const dist = path.join(__dirname, '..', '..', 'dist', 'omega');

        expect(typeof loadHandler(path.join(dist, 'routes', 'health', 'get.js')), 'the health route is an ES module').toBe('function');
        expect(typeof loadHandler(path.join(dist, 'events', 'auth', 'on-create.js')), 'the auth on-create handler is an ES module').toBe('function');

        const response = await http.as('none').get('omega/health');
        expect(response, 'the emulator served the ES module route').toBeSuccess();

        // A seeded persona's doc is written by auth on-create inside the emulator
        const doc = await firestore.get(`users/${accounts.basic.uid}`);
        expect(doc && doc.auth && doc.auth.uid, 'the emulator ran the ES module auth handler').toBe(accounts.basic.uid);
      },
    },
  ],
});
