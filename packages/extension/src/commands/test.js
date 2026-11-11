/**
 * `omega test`: ONE devkit runner run, in this process, over extension's own
 * suites (`framework:` / `omega:` / `extension:`) and the target's `test/`.
 * `build` runs here; `background` and `view` run in Chrome on the harness
 * extension; `boot` loads the project's built extension. A self-test (the cwd
 * is @omega.js/extension) boots the bundled fixture extension.
 */
const path = require('path');
const jetpack = require('fs-jetpack');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { createRunner } = require('@omega.js/devkit/test/runner');
const { guardStdout } = require('@omega.js/devkit/test/guard-stdout');
const { exitFlushed, guardEarlyExit } = require('@omega.js/devkit/test/exit');
const { noMatchExitCode, frameworkIds } = require('@omega.js/devkit/test/scope');
const { setEnvironment } = require('@omega.js/config/environment');
const build = require('../build.js');
const { ensureTarget } = require('./lib/ensure-target.js');
const { chromiumDriver } = require('../test/runners/chromium.js');
const { bootDriver } = require('../test/runners/boot.js');

const logger = build.logger('test');

const SUITES_DIR = path.join(__dirname, '..', 'test', 'suites');
const FIXTURE_EXTENSION = path.join(__dirname, '..', 'test', 'fixtures', 'consumer-extension');

/**
 * The runner config of one `omega test` run. A self-test has no project root;
 * the framework `boot/` suites join on a self-test alone, by the runner's own discovery rule.
 * @param {{projectRoot: string, selfTest: boolean}} options - The target root (the extension package on a self-test).
 * @returns {object} The `createRunner` config.
 */
function runnerConfig({ projectRoot, selfTest }) {
  const roots = [{ source: 'framework', dir: SUITES_DIR }];
  if (!selfTest) roots.push({ source: 'project', dir: path.join(projectRoot, 'test') });
  return {
    framework: 'extension',
    title: '@omega.js/extension Tests',
    projectRoot,
    roots,
    packageName: '@omega.js/extension',
    frameworkAliases: frameworkIds('@omega.js/extension'),
    drivers: {
      background: chromiumDriver('background'),
      view: chromiumDriver('view'),
      boot: bootDriver,
    },
    extendedModeLines: [
      'Tests that hit real external services (Firebase via @omega.js/client, push, any network call) are ENABLED!',
      'This makes real network calls from the background service worker, popup, and content scripts against live backends.',
    ],
    defaultTimeout: 30000,
  };
}

module.exports = async function (options) {
  // Every suite, the project `_init.js` and the bundles a build case makes read `testing`.
  setEnvironment('testing');

  const projectRoot = process.cwd();
  attachLogFile(path.join(projectRoot, 'logs', 'test.log'));

  const manifest = jetpack.read(path.join(projectRoot, 'package.json'), 'json');
  const selfTest = Boolean(manifest) && manifest.name === '@omega.js/extension';
  const runOptions = {
    targets: (options._ || []).slice(1),
    filter: options.filter,
    layer: options.layer,
    lane: options.lane,
    extended: options.extended,
    reporter: options.reporter,
  };

  if (selfTest) {
    // The framework has no project extension of its own: boot the bundled fixture.
    if (!process.env.OMEGA_TEST_BOOT_PROJECT) process.env.OMEGA_TEST_BOOT_PROJECT = FIXTURE_EXTENSION;
  } else {
    // Under json, stdout carries the runner's one document; the target step prints to stderr.
    const restoreStdout = runOptions.reporter === 'json' ? guardStdout({ strict: true }) : () => {};
    try {
      await ensureTarget({ projectDir: projectRoot, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });
    } finally {
      restoreStdout();
    }
  }

  // A case that ends the process (process.exit) before the report is written never passes.
  guardEarlyExit();

  let results;
  try {
    results = await createRunner(runnerConfig({ projectRoot, selfTest })).run(runOptions);
  } catch (e) {
    console.error(e.stack || String(e));
    exitFlushed(1);
    return;
  }
  if (results.noMatch) exitFlushed(noMatchExitCode());
  else exitFlushed(results.failed > 0 ? 1 : 0);
};

module.exports.runnerConfig = runnerConfig;
