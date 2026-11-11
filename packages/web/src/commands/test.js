/**
 * `omega test`: ONE devkit runner run, in this process, each suite file in its
 * own child. Its roots: web's own suite (`framework:` / `omega:` / `web:`, run
 * from the web package), the smoke suite beside this verb over the target's
 * fresh production build, and the target's own `test/`. A bare run means the
 * target's suites; a self-test (the cwd is @omega.js/web) means web's own suite
 * and skips every target step.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const Logger = require('@omega.js/devkit/logger');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { createRunner } = require('@omega.js/devkit/test/runner');
const { discoverSuites } = require('@omega.js/devkit/test/discovery');
const { guardStdout } = require('@omega.js/devkit/test/guard-stdout');
const { exitFlushed, guardEarlyExit } = require('@omega.js/devkit/test/exit');
const { parseTestScope, noMatchMessage, noMatchExitCode, frameworkIds } = require('@omega.js/devkit/test/scope');
const { setEnvironment } = require('@omega.js/config/environment');
const { ensureTarget } = require('./lib/ensure-target.js');
const { consumerPaths } = require('../consumer.js');

const logger = new Logger('test');

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const SMOKE_DIR = path.resolve(__dirname, '..', 'test', 'smoke');

/**
 * The runner config of one `omega test` run.
 * @param {{projectRoot: string, selfTest: boolean}} options - The target root (the web package on a self-test).
 * @returns {object} The `createRunner` config.
 */
function runnerConfig({ projectRoot, selfTest }) {
  const roots = [{ source: 'framework', dir: path.join(WEB_ROOT, 'test'), cwd: WEB_ROOT }];
  if (!selfTest) {
    roots.push(
      { source: 'project', dir: SMOKE_DIR, cwd: projectRoot },
      { source: 'project', dir: path.join(projectRoot, 'test'), cwd: projectRoot },
    );
  }
  return {
    framework: 'web',
    title: '@omega.js/web Tests',
    projectRoot,
    roots,
    packageName: '@omega.js/web',
    frameworkAliases: frameworkIds('@omega.js/web'),
    isolation: 'process',
    serial: ['watch'],
    // Build-heavy cases run near 30s side by side, the runner's default limit.
    defaultTimeout: 120000,
  };
}

module.exports = async function (options) {
  // Every suite, the project `_init.js` and every child read `testing`; the
  // in-process build names production for itself and puts this back.
  setEnvironment('testing');

  const paths = consumerPaths();
  attachLogFile(path.join(paths.root, 'logs', 'test.log'));

  const manifest = jetpack.read(path.join(paths.root, 'package.json'), 'json');
  const selfTest = Boolean(manifest) && manifest.name === '@omega.js/web';
  const config = runnerConfig({ projectRoot: selfTest ? WEB_ROOT : paths.root, selfTest });
  const runOptions = {
    targets: (options._ || []).slice(1),
    filter: options.filter,
    layer: options.layer,
    lane: options.lane,
    extended: options.extended,
    reporter: options.reporter,
  };

  if (!selfTest) {
    // Under json, stdout carries the runner's one document; the target steps print to stderr.
    const restoreStdout = runOptions.reporter === 'json' ? guardStdout({ strict: true }) : () => {};
    try {
      const ready = await prepareTarget(paths, config, runOptions, options);
      if (!ready) return exitFlushed(noMatchExitCode());
    } finally {
      restoreStdout();
    }
  }

  // A case that ends the process (process.exit) before the report is written
  // never passes; armed past the build, whose own throw is no case's.
  guardEarlyExit();

  let results;
  try {
    results = await createRunner(config).run(runOptions);
  } catch (e) {
    console.error(e.stack || String(e));
    exitFlushed(1);
    return;
  }
  if (results.noMatch) exitFlushed(noMatchExitCode());
  else exitFlushed(results.failed > 0 ? 1 : 0);
};

/**
 * A target's steps before the run: the local scaffold, the no-match stop, then
 * the production build when the scope holds the project.
 * @param {object} paths - consumerPaths() of the target.
 * @param {object} config - The runner config.
 * @param {object} runOptions - The run's options (targets and the runner flags).
 * @param {object} options - The verb's own argv, handed to the build.
 * @returns {Promise<boolean>} False when the run ends here (no file matches).
 */
async function prepareTarget(paths, config, runOptions, options) {
  ensureTarget({ projectDir: paths.root, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  // A typo'd path costs a second here, not a whole build.
  const { noMatch } = discoverSuites(config, runOptions);
  if (noMatch) {
    logger.error(noMatchMessage(noMatch));
    return false;
  }

  const scope = parseTestScope(runOptions.targets, { frameworkAliases: config.frameworkAliases });
  if (scope.sources.includes('project')) {
    // logFile: false, since this run already owns logs/test.log.
    await require('./build.js')({ ...options, logFile: false });
  }
  return true;
}

module.exports.runnerConfig = runnerConfig;
