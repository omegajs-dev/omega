/**
 * run(): the CLI body, shared by bin/omega (via dist/omega-bin.js, the
 * dispatcher) and cross-framework dispatch ('@omega.js/extension/cli').
 */
// The value-LESS flags, the only list a CLI owes the parse: every other flag
// takes the next token as its value (`--filter auth` keeps `auth`). Mirrors the
// same fix in @omega.js/backend's CLI.
const BOOLEAN_FLAGS = ['extended', 'direct', 'dry-run', 'secrets', 'major', 'force-fresh', 'cached-only'];

async function run() {
  // Local-dist freshness guard: a stale locally-linked dist rebuilds and the
  // invocation re-execs once, so no command ever runs stale framework code
  require('@omega.js/devkit/local').freshnessBoot({ packageName: '@omega.js/extension' });

  // Boot preludes: the cheap, non-interactive checks every verb passes through,
  // filtered by the verb about to run (#890)
  require('@omega.js/devkit/preludes').runPreludes({ verb: process.argv[2], targetDir: process.cwd() });

  // The router owns --help/--version, so both route through the alias table
  // and the router's built-in help.
  const argv = require('@omega.js/devkit/argv').parseArgv(process.argv.slice(2), { booleans: BOOLEAN_FLAGS });
  const cli = new (require('./cli.js'))(argv);

  await cli.process(argv);
}

module.exports = { run, BOOLEAN_FLAGS };

// Runnable as a file: the package's own `npm test` calls it directly, never through the dispatcher
if (require.main === module) run();
