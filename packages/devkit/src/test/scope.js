/**
 * Test-scope grammar (C5) — ONE parser for `omega test` targets across every
 * framework, so scoping means the same thing in a web app, a backend, a
 * desktop app, and an extension:
 *
 *   npx omega test                     → PROJECT tests only (consumer context)
 *   npx omega test pages/              → project tests under pages/
 *   npx omega test project:pages/      → same, explicit (`brand:` = alias)
 *   npx omega test framework:          → the framework's own suite
 *   npx omega test framework:routes/   → framework suite, scoped
 *   npx omega test full:               → both sources
 *   npx omega test full:auth           → both sources, path-scoped
 *
 * `omega:` and `mgr:` are universal framework aliases; each framework also
 * answers to its own id (`backend:`, `desktop:`, `extension:`, `web:`) via
 * `frameworkAliases`. Bare paths bind to the PROJECT source — reaching the
 * framework suite is always an explicit choice (Ian 2026-07-11: bare runs
 * from a brand must never drag the framework corpus in).
 *
 * Framework SELF context (running inside the framework package itself —
 * `selfTest: true`) flips the no-target default to the framework suite, so
 * each package's own `npm test` keeps meaning "run my suite".
 */

const { TARGET_TYPE_TWIN } = require('../verbs.js');

const UNIVERSAL_FRAMEWORK_ALIASES = ['framework', 'omega', 'mgr'];
const PROJECT_ALIASES = ['project', 'brand'];
const FULL_ALIASES = ['full'];

/**
 * The id prefixes a framework answers to: the type ids its row names, from
 * the verb table's twin of the target-type rows. A framework runner passes
 * its own as `frameworkAliases`.
 *
 * @param {string} framework - The framework package (`@omega.js/web`, …)
 * @returns {string[]} Its ids; [] for a package that runs no target type.
 */
function frameworkIds(framework) {
  return TARGET_TYPE_TWIN.filter((row) => row.framework === framework).map((row) => row.id);
}

/**
 * Parse `omega test` positional targets into sources + per-source path filters.
 *
 * @param {string[]} rawTargets - Positional targets (may be empty)
 * @param {Object} [options]
 * @param {string[]} [options.frameworkAliases] - Extra framework prefixes for
 *   this framework (e.g. ['backend'], ['desktop'], ['extension'], ['web'])
 * @param {boolean} [options.selfTest] - True when running inside the framework
 *   package itself (no consumer project)
 * @returns {{
 *   sources: string[],                             // subset of ['framework', 'project']
 *   filters: { framework: string[], project: string[] }, // prefix-stripped path filters per source
 *   invalid: string[],                             // unrecognized `<word>:` prefixes (likely typos)
 * }}
 */
function parseTestScope(rawTargets, options = {}) {
  const frameworkAliases = new Set([
    ...UNIVERSAL_FRAMEWORK_ALIASES,
    ...(options.frameworkAliases || []),
  ]);

  const sources = new Set();
  const filters = { framework: [], project: [] };
  const invalid = [];

  for (const raw of rawTargets || []) {
    const target = String(raw).trim();
    if (!target) continue;

    const match = target.match(/^([a-z-]+):(.*)$/);

    if (!match) {
      // Bare path — binds to the PROJECT source.
      sources.add('project');
      filters.project.push(target);
      continue;
    }

    const [, prefix, pathPart] = match;

    if (frameworkAliases.has(prefix)) {
      sources.add('framework');
      if (pathPart) filters.framework.push(pathPart);
    } else if (PROJECT_ALIASES.includes(prefix)) {
      sources.add('project');
      if (pathPart) filters.project.push(pathPart);
    } else if (FULL_ALIASES.includes(prefix)) {
      sources.add('framework');
      sources.add('project');
      if (pathPart) {
        filters.framework.push(pathPart);
        filters.project.push(pathPart);
      }
    } else {
      // Unknown prefix — surface it rather than silently matching nothing.
      invalid.push(target);
    }
  }

  // No targets (or only invalid ones): consumer default = project only;
  // framework self context = the framework's own suite.
  if (sources.size === 0) {
    sources.add(options.selfTest ? 'framework' : 'project');
  }

  return {
    sources: ['framework', 'project'].filter((s) => sources.has(s)),
    filters,
    invalid,
  };
}

/**
 * Did the run ask for test files BY NAME? A path filter (`build/x`,
 * `project:x`, `desktop:x`, `full:x`) names files; a bare run, or a bare
 * source prefix, asks for a source. Only the first kind can be a typo, so
 * only the first kind fails when it selects nothing
 * ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)).
 *
 * @param {{filters: {framework: string[], project: string[]}}} scope - A parseTestScope() result
 * @returns {boolean} True when at least one path filter was given
 */
function isPathTargeted(scope) {
  return scope.filters.framework.length > 0 || scope.filters.project.length > 0;
}

/**
 * The ONE line every framework prints when a named target selects zero test
 * files: the same sentence in a web app, a backend, a desktop app and an
 * extension ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)).
 *
 * @param {string} target - The target as the caller spelled it
 * @returns {string} The message (the caller adds its own log tag)
 */
function noMatchMessage(target) {
  return `No test file matches "${target}".`;
}

// A brand-root run fans ONE target out over every target, where a target that
// does not carry that path is a legitimate no-op rather than a typo. The
// manager sets this signal on the runs it forwards and reads the exit code
// below to tell a miss from a failure
// ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)). Its presence is
// the whole signal.
const FANOUT_ENV = 'OMEGA_TEST_FANOUT';

// The exit code a no-match answers with under that signal: distinct, so the
// fan-out counts misses without confusing them with failures. A standalone run
// stays 1, the code every human and every CI already reads as "this failed".
const NO_MATCH_EXIT_CODE = 3;

/**
 * The exit code a no-match run ends on, given its environment.
 *
 * @param {object} [env] - The environment to read (defaults to process.env)
 * @returns {number} NO_MATCH_EXIT_CODE inside a brand-root fan-out, else 1
 */
function noMatchExitCode(env = process.env) {
  return env[FANOUT_ENV] ? NO_MATCH_EXIT_CODE : 1;
}

module.exports = { parseTestScope, isPathTargeted, noMatchMessage, noMatchExitCode, NO_MATCH_EXIT_CODE, FANOUT_ENV, UNIVERSAL_FRAMEWORK_ALIASES, PROJECT_ALIASES, FULL_ALIASES, frameworkIds };
