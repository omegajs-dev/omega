// Strip ELECTRON_RUN_AS_NODE: see src/cli-run.js for the full story. Belt-and-suspenders
// at the gulp boundary too because gulp can be invoked outside of mgr (e.g. `npx gulp build`).
delete process.env.ELECTRON_RUN_AS_NODE;

// Libraries
const build = require('../build.js');
const logger = build.logger('main');
const argv = build.getArguments();
const { series, parallel } = require('gulp');
const path = require('path');
const glob = require('glob').globSync;

// Load packages
const package = build.getPackage('main');
const project = build.getPackage('project');
const projectRoot = build.getRootPath('project');

// Resolve the .env cascade from the project root (shell > app > brand > company)
// and derive the signing paths the brand's signing tree implies. gulp is its own
// PROCESS (npm start invokes it with no CLI above it), so it asks the same
// wrapper the CLI asks and gets the same answer
// ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)). The load has to
// precede the log tee (the tee reads the env it populates), so what it derived
// is REPORTED below instead: the derived lines are what a CI signing failure is
// diagnosed from, and they belong in build.log.
const { loadDesktopEnv, reportSigningEnv } = require('../utils/load-env.js');
const signingEnv = loadDesktopEnv(projectRoot);

// Empty-string signing placeholders (CSC_LINK="" etc. from the .env template)
// must read as UNSET — app-builder-lib only null-checks and would resolve ''
// to the project root ("<projectRoot> not a file"). See utils/sanitize-signing-env.js.
const sanitizedSigningKeys = require('../utils/sanitize-signing-env.js')(process.env);
if (sanitizedSigningKeys.length) {
  logger.log(`Ignoring empty signing env placeholders: ${sanitizedSigningKeys.join(', ')}`);
}

// Tee all stdout/stderr to <projectRoot>/logs/<dev|build>.log for easy `tail -f` / grep / Claude
// inspection. build.log for production builds/packages (OMEGA_BUILD_MODE=true), dev.log for `npm start`.
// Disable via OMEGA_LOG_FILE=false. Override path via OMEGA_LOG_FILE=<path>.
const attachLogFile = require('../utils/attach-log-file.js');
const logFileEnv = process.env.OMEGA_LOG_FILE;
if (logFileEnv !== 'false' && logFileEnv !== '0') {
  const defaultName = build.isBuildMode() ? 'build.log' : 'dev.log';
  const logPath = (logFileEnv && logFileEnv !== 'true') ? logFileEnv : path.join(projectRoot, 'logs', defaultName);
  attachLogFile(logPath);
  logger.log(`Logs tee'd to ${logPath}`);
}

// What the env load derived, now that build.log is catching lines.
reportSigningEnv(signingEnv, logger);

logger.log('Starting...', argv);

// Auto-load tasks from src/gulp/tasks/*.js
const tasks = glob('*.js', { cwd: `${__dirname}/tasks` });

// Globals (the same pair @omega.js/extension's gulp sets)
global.tasks = {};
global.websocket = null;

tasks.forEach((file) => {
  const name = file.replace('.js', '');
  logger.log('Loading task:', name);
  exports[name] = require(path.join(__dirname, 'tasks', file));
});

global.tasks = exports;

// Lifecycle hook tasks — each invokes the consumer's <projectRoot>/hooks/<name>.js file if it
// exists, or no-ops. Inserted around the build/release stages so consumers can extend the
// pipeline without forking gulp tasks.
const { runConsumerHook } = require('@omega.js/devkit/run-consumer-hook');
function makeHookTask(name) {
  const fn = async () => {
    await runConsumerHook(name, { build, projectRoot: process.cwd(), mode: process.env.OMEGA_BUILD_MODE === 'true' ? 'production' : 'development' });
  };
  // Set displayName for nicer gulp logs.
  Object.defineProperty(fn, 'name', { value: `hook:${name.replace('/', ':')}` });
  return fn;
}
exports['hook:build:pre']   = makeHookTask('build/pre');
exports['hook:build:post']  = makeHookTask('build/post');
exports['hook:release:pre'] = makeHookTask('release/pre');
exports['hook:release:post'] = makeHookTask('release/post');

// Build pipeline: hook:build:pre → defaults → distribute → (sass | bundle | html in parallel)
// → audit → build-config → hook:build:post.
// build-config generates dist/electron-builder.yml entirely from @omega.js/desktop defaults +
// config/omega.json5 (no consumer-shipped electron-builder.yml). Mode-dependent
// injections (e.g. LSUIElement for tray-only) happen here. Must run BEFORE package/release.
exports.build = series(
  exports['hook:build:pre'],
  exports.defaults,
  exports.distribute,
  parallel(exports.sass, exports.bundle, exports.html),
  exports.audit,
  exports['build-config'],
  exports['hook:build:post'],
);

// Production package: build + electron-builder package (no publish)
exports.packageBuild = series(
  exports.build,
  exports.package,
);

// Quick package: build + electron-builder --dir for host platform/arch only.
// Skips DMG/zip/universal/notarize. Output: release/<platform>-<arch>/<ProductName>.app
// (or .exe-folder on win, linux-unpacked on linux). ~20-30s. For local smoke-testing
// production code paths (config loading, packaged-mode behavior) without the full pipeline.
exports.packageQuick = series(
  exports.build,
  exports['package-quick'],
);

// Publish: build + hook:release:pre + electron-builder release + hook:release:post.
// Single sign+notarize pass. The artifacts land in the brand's ONE public releases
// repo under versionless names (#620/#799), which is what the site links: there is
// no mirror step any more.
exports.publish = series(
  exports.build,
  exports['hook:release:pre'],
  exports.release,
  exports['hook:release:post'],
);

// Default dev pipeline: build, then launch electron.
exports.default = series(
  exports.build,
  exports.serve,
);
