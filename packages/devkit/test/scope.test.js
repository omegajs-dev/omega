/**
 * parseTestScope — the C5 test-scoping grammar (one meaning everywhere).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { parseTestScope, isPathTargeted, noMatchMessage, noMatchExitCode, NO_MATCH_EXIT_CODE, FANOUT_ENV } = require('../src/test/scope.js');

module.exports = defineCases({
  type: 'group',
  description: 'scope',
  tests: [
    {
      name: 'no targets in consumer context → project only',
      run: (ctx) => {
        const scope = parseTestScope([]);
        ctx.expect(scope.sources).toEqual(['project']);
        ctx.expect(scope.filters).toEqual({ framework: [], project: [] });
        ctx.expect(scope.invalid).toEqual([]);
      },
    },

    {
      name: 'no targets in framework self context → framework only',
      run: (ctx) => {
        const scope = parseTestScope([], { selfTest: true });
        ctx.expect(scope.sources).toEqual(['framework']);
      },
    },

    {
      name: 'bare path binds to project source',
      run: (ctx) => {
        const scope = parseTestScope(['pages/pricing']);
        ctx.expect(scope.sources).toEqual(['project']);
        ctx.expect(scope.filters.project).toEqual(['pages/pricing']);
        ctx.expect(scope.filters.framework).toEqual([]);
      },
    },

    {
      name: 'framework:/omega:/mgr: select the framework suite',
      run: (ctx) => {
        for (const prefix of ['framework', 'omega', 'mgr']) {
          const scope = parseTestScope([`${prefix}:`]);
          ctx.expect(scope.sources, prefix).toEqual(['framework']);
        }
      },
    },

    {
      name: 'per-framework alias (backend:, em:) via frameworkAliases',
      run: (ctx) => {
        const scope = parseTestScope(['backend:routes/'], { frameworkAliases: ['backend'] });
        ctx.expect(scope.sources).toEqual(['framework']);
        ctx.expect(scope.filters.framework).toEqual(['routes/']);
      },
    },

    {
      name: 'project:/brand: are explicit project aliases',
      run: (ctx) => {
        for (const prefix of ['project', 'brand']) {
          const scope = parseTestScope([`${prefix}:auth/`]);
          ctx.expect(scope.sources, prefix).toEqual(['project']);
          ctx.expect(scope.filters.project, prefix).toEqual(['auth/']);
        }
      },
    },

    {
      name: 'full: selects both sources, path applies to both',
      run: (ctx) => {
        const bare = parseTestScope(['full:']);
        ctx.expect(bare.sources).toEqual(['framework', 'project']);

        const scoped = parseTestScope(['full:auth']);
        ctx.expect(scoped.filters.framework).toEqual(['auth']);
        ctx.expect(scoped.filters.project).toEqual(['auth']);
      },
    },

    {
      name: 'mixed targets union sources with per-source filters',
      run: (ctx) => {
        const scope = parseTestScope(['framework:admin/', 'checkout'], { frameworkAliases: ['backend'] });
        ctx.expect(scope.sources).toEqual(['framework', 'project']);
        ctx.expect(scope.filters.framework).toEqual(['admin/']);
        ctx.expect(scope.filters.project).toEqual(['checkout']);
      },
    },

    {
      name: 'unknown prefix is reported invalid, not silently dropped',
      run: (ctx) => {
        const scope = parseTestScope(['framwork:oops']);
        ctx.expect(scope.invalid).toEqual(['framwork:oops']);
        // Falls back to the consumer default rather than matching nothing.
        ctx.expect(scope.sources).toEqual(['project']);
      },
    },

    {
      name: 'windows-style path with drive colon is not treated as a prefix',
      run: (ctx) => {
        // `C:` would match `<word>:` — the prefix grammar is lowercase-only, so
        // an uppercase drive letter stays a bare path.
        const scope = parseTestScope(['C:/tests/x']);
        ctx.expect(scope.sources).toEqual(['project']);
        ctx.expect(scope.filters.project).toEqual(['C:/tests/x']);
      },
    },

    {
      name: 'frameworkIds: each target framework answers its row\'s id, a package no row names answers none',
      run: (ctx) => {
        const { frameworkIds } = require('../src/test/scope.js');
        const { TARGET_TYPE_ROWS } = require('@omega.js/config/target-types');

        for (const row of TARGET_TYPE_ROWS.filter((entry) => entry.framework)) {
          ctx.expect(frameworkIds(row.framework), row.framework).toEqual([row.id]);
        }
        ctx.expect(frameworkIds('@omega.js/manager')).toEqual([]);
        ctx.expect(frameworkIds('@omega.js/nope')).toEqual([]);
      },
    },

    {
      name: 'a path filter means the run asked for files BY NAME (#814)',
      run: (ctx) => {
        // The no-match rule keys off this: a named path that selects nothing is a
        // typo, while a bare run (or a bare prefix) asked for a source, not a file.
        ctx.expect(isPathTargeted(parseTestScope(['build/config']))).toBe(true);
        ctx.expect(isPathTargeted(parseTestScope(['project:build/config']))).toBe(true);
        ctx.expect(isPathTargeted(parseTestScope(['desktop:build/config'], { frameworkAliases: ['desktop'] }))).toBe(true);
        ctx.expect(isPathTargeted(parseTestScope(['full:build/config']))).toBe(true);

        ctx.expect(isPathTargeted(parseTestScope([]))).toBe(false);
        ctx.expect(isPathTargeted(parseTestScope(['project:']))).toBe(false);
        ctx.expect(isPathTargeted(parseTestScope(['mgr:']))).toBe(false);
        ctx.expect(isPathTargeted(parseTestScope(['full:']))).toBe(false);
      },
    },

    {
      name: 'the no-match line is one sentence naming the target (#814)',
      run: (ctx) => {
        ctx.expect(noMatchMessage('renderer/does-not-exist')).toBe('No test file matches "renderer/does-not-exist".');
        ctx.expect(noMatchMessage('desktop:build/typo')).toBe('No test file matches "desktop:build/typo".');
      },
    },

    {
      name: 'a no-match exits 1 alone and with a distinct code inside a brand-root fan-out (#814)',
      run: (ctx) => {
        // The brand root forwards ONE target to every target, where a target that
        // does not carry it is a no-op rather than a typo. The code is how the
        // fan-out tells a miss from a failure.
        ctx.expect(NO_MATCH_EXIT_CODE).toBe(3);
        ctx.expect(FANOUT_ENV).toBe('OMEGA_TEST_FANOUT');

        ctx.expect(noMatchExitCode({})).toBe(1);
        ctx.expect(noMatchExitCode({ OMEGA_TEST_FANOUT: '' })).toBe(1);
        ctx.expect(noMatchExitCode({ OMEGA_TEST_FANOUT: '1' })).toBe(3);
      },
    },
  ],
});
