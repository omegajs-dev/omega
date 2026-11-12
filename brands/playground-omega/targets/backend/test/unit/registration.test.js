/**
 * Registration guard, yours to extend: what this target deploys, and whether every
 * route it dispatches to still loads. `src/index.js` is read as TEXT (requiring it
 * boots the framework); each route handler IS required, so a broken import fails here.
 */
const fs = require('node:fs');
const path = require('node:path');
const { defineCases, expect } = require('@omega.js/backend/test');

const APP_DIR = path.join(__dirname, '..', '..');
const SRC = path.join(APP_DIR, 'src');
const INDEX = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');

const FRAMEWORK_DIR = path.dirname(require.resolve('@omega.js/backend/package.json', { paths: [APP_DIR] }));

// The prefixes the framework's own registrations occupy. A consumer export
// wearing one would silently overwrite a framework function, or be overwritten
// by it. Either way something stops deploying.
const RESERVED_PREFIXES = ['omega_', 'bm_'];

// The HTTP verbs the request pipeline looks for as `<route>/<method>.js`.
const METHOD_FILES = ['get.js', 'post.js', 'put.js', 'patch.js', 'delete.js'];

/**
 * The consumer Cloud Functions index.js registers, read out of the source:
 * `omega.functions.<name> = …omega.routes.run('<route>', { req, res })`.
 * @returns {Array<{name: string, route: string}>}
 */
function consumerFunctions() {
  return [...INDEX.matchAll(/omega\.functions\.(\w+)\s*=([\s\S]*?);\n/g)].map((match) => ({
    name: match[1],
    route: (match[2].match(/routes\.run\(\s*'([^']+)'/) || [])[1],
  }));
}

// A custom-server backend carries no firebase.json, so the cases that read it skip
function firebaseJson(skip) {
  const file = path.join(APP_DIR, 'firebase.json');
  if (!fs.existsSync(file)) skip('no firebase.json in this target');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = defineCases({
  description: 'Registration: what this target deploys, and every route it dispatches loads',
  type: 'group',

  tests: [
    {
      name: 'index-js-boots-the-installed-framework',

      run() {
        expect(INDEX, 'index.js does not boot @omega.js/backend').toMatch(/require\('@omega\.js\/backend'\)/);
        expect(INDEX, 'omega.initialize(…) is the bootstrap call').toMatch(/\.initialize\(/);
        expect(INDEX, 'index.js exports omega.functions, the Cloud Functions map').toMatch(/module\.exports = omega\.functions;/);

        // The specifier index.js requires, resolved the way NODE resolves it FROM
        // src/, the same lookup the deployed function performs at cold start. A
        // renamed dependency, a missing workspace link or a `file:` path off by a
        // directory all fail here instead of at boot.
        const resolved = require.resolve('@omega.js/backend', { paths: [SRC] });

        expect(resolved.startsWith(FRAMEWORK_DIR + path.sep), `index.js's '@omega.js/backend' resolves to ${resolved}, outside the framework package`).toBeTruthy();
      },
    },

    {
      name: 'no-consumer-function-takes-the-framework-namespace',

      run() {
        for (const fn of consumerFunctions()) {
          for (const prefix of RESERVED_PREFIXES) {
            expect(!fn.name.startsWith(prefix), `omega.functions.${fn.name} takes the framework's reserved "${prefix}" prefix: one of the two functions will not deploy`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'every-dispatched-route-resolves-and-loads',

      run() {
        // The pipeline resolves `path.resolve(<routesDir>, <route>)` and then
        // takes `<method>.js` if it exists, `index.js` otherwise. A function that
        // does not dispatch through `omega.routes.run()` carries its handler inline: nothing to
        // resolve, so it is this test's business only if it names a route.
        for (const fn of consumerFunctions().filter((f) => f.route)) {
          const routeDir = path.resolve(SRC, 'routes', fn.route);
          expect(fs.existsSync(routeDir), `src/routes/${fn.route}/ does not exist: the route answers 500`).toBeTruthy();

          const handlers = [...METHOD_FILES, 'index.js']
            .map((file) => path.join(routeDir, file))
            .filter((file) => fs.existsSync(file));

          expect(handlers.length > 0, `src/routes/${fn.route}/ has no <method>.js and no index.js: every request answers 405`).toBeTruthy();

          // Requiring is the point: a route's own imports are exercised here instead
          // of at cold start.
          for (const file of handlers) {
            // A route is an ES module: require() answers its namespace, the handler its default export
            const handler = require(file).default;

            expect(typeof handler, `${path.relative(APP_DIR, file)} has no default export handler function (export default async (...) => {})`).toBe('function');
            expect(handler.constructor.name, `${path.relative(APP_DIR, file)}'s handler is not async`).toBe('AsyncFunction');
          }
        }
      },
    },

    {
      name: 'firebase-deploys-the-staged-dist',

      run({ skip }) {
        const FIREBASE = firebaseJson(skip);

        // `omega build` copies src/** → dist/** and firebase.json deploys dist/.
        expect(FIREBASE.functions[0].source, 'functions deploy from the staged dist/, never src/').toBe('dist');
        expect(FIREBASE.hosting.public, 'hosting serves the staged public dir').toBe('dist/public');
      },
    },

    {
      name: 'the-omega-api-rewrite-serves-the-framework-prefixes-first',

      run({ skip }) {
        const rewrites = firebaseJson(skip).hosting.rewrites;
        const api = rewrites.find((r) => r.function === 'omega_api');

        expect(api, 'no omega_api rewrite: every built-in route would 404').toBeTruthy();

        // Firebase hosting glob groups match a WHOLE path, so `/omega/**` alone would
        // not cover the bare `/omega`. Each prefix is listed on its own as well.
        const alternatives = api.source.replace(/^\{|\}$/g, '').split(',');

        for (const prefix of ['/omega', '/omega/**']) {
          expect(alternatives.includes(prefix), `the ${prefix} path is not routed to omega_api`).toBeTruthy();
        }

        // The omega rewrite has to stay FIRST: hosting takes the first match, and a
        // broader pattern above it would swallow the framework prefixes.
        expect(rewrites[0].function, 'the omega_api rewrite is no longer first').toBe('omega_api');
      },
    },
  ],
});
