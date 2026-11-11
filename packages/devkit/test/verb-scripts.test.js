/**
 * The target scripts a framework scaffolds, derived from the one verb table:
 * every fan-out verb the framework owns is `"<verb>": "omega <verb>"`, and
 * the framework's declared projectScripts merge over that set.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { VERBS } = require('../src/verbs.js');
const { verbScripts, projectScripts } = require('../src/verb-scripts.js');
const { TARGET_TYPE_ROWS } = require('@omega.js/config/target-types');

const TARGET_FRAMEWORK_NAMES = TARGET_TYPE_ROWS.filter((row) => row.framework).map((row) => row.framework);

module.exports = defineCases({
  type: 'group',
  description: 'verb-scripts',
  tests: [
    {
      name: 'verbScripts: every fan-out (`each`) row a framework owns, as its bare `omega <verb>`',
      run: (ctx) => {
        for (const framework of TARGET_FRAMEWORK_NAMES) {
          const expected = VERBS
            .filter((row) => row.owners.includes(framework) && row.fanout === 'each')
            .map((row) => row.name);
          const { start, ...scripts } = verbScripts(framework);

          ctx.expect(Object.keys(scripts), framework).toEqual(expected);
          for (const [verb, command] of Object.entries(scripts)) ctx.expect(command).toBe(`omega ${verb}`);
        }
      },
    },

    {
      name: 'verbScripts: the `dev` row derives npm\'s own `start` script on every framework',
      run: (ctx) => {
        for (const framework of TARGET_FRAMEWORK_NAMES) {
          const scripts = verbScripts(framework);
          ctx.expect(scripts.start, framework).toBe('omega dev');
          ctx.expect(scripts.dev, `${framework}: dev lands as start, never as its own key`).toBe(undefined);
        }
      },
    },

    {
      name: 'verbScripts: a brand-wide or root-run verb is never a target script',
      run: (ctx) => {
        const web = verbScripts('@omega.js/web');
        for (const verb of ['install', 'manage', 'migrate', 'dev', 'help', 'version']) {
          ctx.expect(web[verb], verb).toBe(undefined);
        }
        ctx.expect(['build', 'clean', 'deploy', 'test', 'translate'].map((verb) => web[verb])).toEqual(['omega build', 'omega clean', 'omega deploy', 'omega test', 'omega translate']);
        ctx.expect(verbScripts('@omega.js/extension').package, 'a verb another framework owns never lands').toBe(undefined);
      },
    },

    {
      name: 'verbScripts: a single-target command (`fanout: none`) is never a target script',
      run: (ctx) => {
        const desktop = verbScripts('@omega.js/desktop');
        const backend = verbScripts('@omega.js/backend');
        for (const verb of ['runner', 'sign-windows', 'logs', 'launch', 'publish']) ctx.expect(desktop[verb], verb).toBe(undefined);
        for (const verb of ['cwd', 'logs', 'emulator', 'serve', 'firestore:get']) ctx.expect(backend[verb], verb).toBe(undefined);
      },
    },

    {
      name: 'projectScripts: the framework\'s declared scripts merge over the derived set',
      run: (ctx) => {
        const scripts = projectScripts({ name: '@omega.js/web', projectScripts: { gulp: 'gulp', test: 'node --test' } });

        ctx.expect(scripts.gulp, 'a declared non-verb script lands').toBe('gulp');
        ctx.expect(scripts.test, 'a declared script wins over the derived one').toBe('node --test');
        ctx.expect(scripts.build, 'the derived set fills the rest').toBe('omega build');
        ctx.expect(projectScripts({ name: '@omega.js/web' }), 'no declarations, the derived set alone').toEqual(verbScripts('@omega.js/web'));
      },
    },
  ],
});
