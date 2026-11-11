/**
 * run() — the omega bin body for @omega.js/web, shared by bin/omega (via
 * src/omega-bin.js) and cross-framework dispatch ('@omega.js/web/cli').
 */
// The value-LESS flags, the only list a CLI owes the parse: every other flag
// takes the next token as its value, so an undeclared `--extended some/target`
// would become extended='some/target' with NO target. @omega.js/backend's CLI
// declares the same.
const BOOLEAN_FLAGS = [
  'extended', 'dry-run', 'local', 'direct', 'secrets', 'list', 'a',
  'major', 'force-fresh', 'https', 'cached-only',
];

async function run() {
  // Local-dist freshness guard: a stale locally-linked dist rebuilds and the
  // invocation re-execs once, so no command ever runs stale framework code
  require('@omega.js/devkit/local').freshnessBoot({ packageName: '@omega.js/web' });

  // Boot preludes: the cheap, non-interactive checks every verb passes through,
  // filtered by the verb about to run (#890)
  require('@omega.js/devkit/preludes').runPreludes({ verb: process.argv[2], targetDir: process.cwd() });

  // The router owns --help/--version, so `-v`/`--version` reach our version
  // command through the alias table.
  const argv = require('@omega.js/devkit/argv').parseArgv(process.argv.slice(2), { booleans: BOOLEAN_FLAGS });
  const cli = new (require('./cli.js'))(argv);

  await cli.process(argv);
}

module.exports = { run, BOOLEAN_FLAGS };

// Runnable as a file: the monorepo root's `omega test --target=web` calls it directly, never through the dispatcher
if (require.main === module) run();
