#!/usr/bin/env node

/**
 * @omega.js/backend test entry: the child the `omega test` verb starts inside the
 * emulator's environment. It reads the run's config from OMEGA_TEST_CONFIG,
 * boots firebase-admin and the real omega instance as a runner host, then runs
 * the devkit runner with the backend's `emulator` layer driver.
 */

const path = require('path');
const { createRunner } = require('@omega.js/devkit/test/runner');
const { noMatchExitCode, frameworkIds } = require('@omega.js/devkit/test/scope');
const { exitFlushed, guardEarlyExit } = require('@omega.js/devkit/test/exit');
const { declaredLanes } = require('../utils/test-lanes.js');
const { createEmulatorDriver } = require('./emulator-driver.js');
const { testRoots } = require('./seed.js');
const { EXTENDED_MODE_LINES } = require('./extended-mode-lines.js');

// The package root: its manifest names the self-test.
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

async function main() {
  // Parse config from base64-encoded env var
  const configBase64 = process.env.OMEGA_TEST_CONFIG || '';
  const testConfig = configBase64
    ? JSON.parse(Buffer.from(configBase64, 'base64').toString('utf8'))
    : {};

  // Initialize Firebase Admin with emulator settings
  let admin = null;
  try {
    const firebaseAdmin = require('firebase-admin');

    // Check if already initialized
    if (firebaseAdmin.apps.length === 0) {
      // When running in emulator, we can initialize without credentials
      // The emulator environment variables tell it where to connect
      firebaseAdmin.initializeApp({
        projectId: process.env.GCLOUD_PROJECT || testConfig.cloud?.config?.projectId,
      });
    }
    admin = firebaseAdmin;
  } catch (error) {
    console.error('Warning: Could not initialize Firebase Admin:', error.message);
  }

  // Boot the real instance as a runner host: config and the services load, and
  // what needs a Functions runtime stays off. The instance and a Context reach
  // every case and `_init.js` factory, so a suite reads omega.email, ctx.ai and
  // new User() exactly like production code does: no per-test stub.
  let omega = null;
  let ctx = null;
  try {
    const projectDir = testConfig.projectDir || process.cwd();
    const Context = require('../omega/context.js');

    // The staged output tree (src/dist pillar): the same cwd the emulator's
    // function workers boot with, so config/SA resolve identically
    omega = require('../omega/index.js').initialize({ cwd: path.join(projectDir, 'dist'), runnerHost: true });
    ctx = new Context(omega, {}, { functionName: 'backend-test-runner', accept: 'json' });
  } catch (error) {
    console.error('Warning: Could not initialize @omega.js/backend for tests:', error.message);
  }

  // The self-test runs from the package itself: its manifest is what opens the boot/ suites
  const projectRoot = testConfig.isFrameworkSelfTest ? BACKEND_ROOT : testConfig.projectDir;
  const options = {
    targets: testConfig.testPaths,
    filter: testConfig.filter,
    layer: testConfig.layer,
    lane: process.env.OMEGA_TEST_LANE,
    extended: Boolean(process.env.TEST_EXTENDED_MODE),
    reporter: testConfig.reporter,
  };
  const driver = createEmulatorDriver({ config: testConfig, admin, omega, ctx });

  const runner = createRunner({
    framework: 'backend',
    title: '@omega.js/backend Integration Tests',
    projectRoot,
    roots: testRoots(testConfig.projectDir).map(({ dir, label }) => ({ source: label, dir })),
    packageName: '@omega.js/backend',
    frameworkAliases: frameworkIds('@omega.js/backend'),
    lanes: declaredLanes(),
    extendedModeLines: EXTENDED_MODE_LINES,
    drivers: { emulator: driver },
    init: {
      factoryArgs: { config: testConfig, omega, ctx },
      // An `_init.js` setup runs after the seed, with the seeded accounts
      setupContext: async ({ hooks }) => {
        const handle = await driver.start({ hooks });
        return { admin, config: testConfig, accounts: handle.accounts, omega, ctx };
      },
    },
    defaultTimeout: testConfig.timeout || 30000,
  });

  let results;
  try {
    results = await runner.run(options);
  } catch (error) {
    // A pre-flight failure is its one line; any other run-level error keeps its stack
    console.error(error.name === 'PreflightError' ? error.message : error.stack);
    return exitFlushed(1);
  }

  // A target that named files and matched none answers with its own code: 1
  // standalone, distinct inside a brand-root fan-out, so the manager counts a miss
  if (results.noMatch) {
    return exitFlushed(noMatchExitCode());
  }
  return exitFlushed(results.failed > 0 ? 1 : 0);
}

// A case that ends the process (process.exit) before the report is written never passes
guardEarlyExit();
main().catch(error => {
  console.error('Test runner failed:', error);
  exitFlushed(1);
});
