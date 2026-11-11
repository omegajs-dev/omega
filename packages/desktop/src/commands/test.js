/**
 * `omega test`: ONE devkit runner run, in this process. Its roots: desktop's own
 * suites (`framework:` / `omega:` / `desktop:`) and the target's `test/`. The
 * `build` row runs here; `main`, `renderer` and `boot` run inside Electron
 * through the drivers in src/test/runners/. A bare run means the target's
 * suites; a self-test (the cwd is @omega.js/desktop) means desktop's own, with
 * its `boot/` suites booting the bundled fixture app, and skips every target step.
 */
const path = require('path');
const jetpack = require('fs-jetpack');
const build = require('../build.js');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { createRunner } = require('@omega.js/devkit/test/runner');
const { guardStdout } = require('@omega.js/devkit/test/guard-stdout');
const { exitFlushed, guardEarlyExit } = require('@omega.js/devkit/test/exit');
const { noMatchExitCode, frameworkIds } = require('@omega.js/devkit/test/scope');
const { setEnvironment } = require('@omega.js/config/environment');
const { ensureTarget } = require('./lib/ensure-target.js');
const { electronDriver } = require('../test/runners/electron.js');
const { bootDriver } = require('../test/runners/boot.js');

const logger = build.logger('test');

const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');
const SUITES_DIR = path.join(__dirname, '..', 'test', 'suites');
const FIXTURE_APP = path.join(__dirname, '..', 'test', 'fixtures', 'consumer-app');

const EXTENDED_MODE_LINES = [
  'Tests that hit real external services (Firebase, analytics, update feeds) are ENABLED!',
  'This will make real network calls against live backends.',
];

/**
 * The runner config of one `omega test` run. A self-test has no project root;
 * the framework `boot/` suites join on a self-test alone, by the runner's own discovery rule.
 * @param {{projectRoot: string, selfTest: boolean}} options - The target root (the desktop package on a self-test).
 * @returns {object} The `createRunner` config.
 */
function runnerConfig({ projectRoot, selfTest }) {
  const roots = [{ source: 'framework', dir: SUITES_DIR }];
  if (!selfTest) roots.push({ source: 'project', dir: path.join(projectRoot, 'test') });
  return {
    framework: 'desktop',
    title: '@omega.js/desktop Tests',
    projectRoot,
    roots,
    packageName: '@omega.js/desktop',
    frameworkAliases: frameworkIds('@omega.js/desktop'),
    drivers: { main: electronDriver('main'), renderer: electronDriver('renderer'), boot: bootDriver },
    extendedModeLines: EXTENDED_MODE_LINES,
    defaultTimeout: 30000,
  };
}

module.exports = async function (options) {
  // Every suite and every electron/boot child reads `testing`; the runner verbs
  // read it too (utils/runner-env.js) and refuse to touch a real runner home.
  setEnvironment('testing');

  const cwd = process.cwd();
  attachLogFile(path.join(cwd, 'logs', 'test.log'));

  const manifest = jetpack.read(path.join(cwd, 'package.json'), 'json');
  const selfTest = Boolean(manifest) && manifest.name === '@omega.js/desktop';
  const runOptions = {
    targets: (options._ || []).slice(1),
    filter: options.filter,
    layer: options.layer,
    lane: options.lane,
    extended: options.extended,
    reporter: options.reporter,
  };

  if (selfTest) {
    // The self-test has no consumer app of its own: its boot suites boot the bundled fixture.
    if (!process.env.OMEGA_TEST_BOOT_PROJECT) process.env.OMEGA_TEST_BOOT_PROJECT = FIXTURE_APP;
  } else {
    // Under json, stdout carries the runner's one document; the target step prints to stderr.
    const restoreStdout = runOptions.reporter === 'json' ? guardStdout({ strict: true }) : () => {};
    try {
      await ensureTarget({ projectDir: cwd, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });
    } finally {
      restoreStdout();
    }
  }

  // A case that ends the process (process.exit) before the report is written never passes.
  guardEarlyExit();

  let results;
  try {
    results = await createRunner(runnerConfig({ projectRoot: selfTest ? DESKTOP_ROOT : cwd, selfTest })).run(runOptions);
  } catch (e) {
    console.error(e.stack || String(e));
    exitFlushed(1);
    return;
  }
  if (results.noMatch) exitFlushed(noMatchExitCode());
  else exitFlushed(results.failed > 0 ? 1 : 0);
};

module.exports.runnerConfig = runnerConfig;
