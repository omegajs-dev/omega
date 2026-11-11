// defineCases: the wrapper every OMEGA case file exports its spec through.
// A file the runner requires passes its spec through untouched. A file loaded
// by `node --test <file>` or run as `node <file>` (the main module) registers its
// own cases with node:test, so they RUN: a host layer with no ctx extras runs as
// the runner runs it, any other layer registers one failing case naming `npx omega test`.

const path = require('path');

// The argument a runner hands each process-isolated child, carrying its default timeout.
const TIMEOUT_ARG = '--omega-default-timeout=';

/**
 * The default timeout the runner handed this child, if any.
 * @returns {number|undefined} Milliseconds, or undefined when run directly.
 */
function handedTimeout() {
  const arg = process.argv.find((value) => value.startsWith(TIMEOUT_ARG));
  return arg ? Number(arg.slice(TIMEOUT_ARG.length)) : undefined;
}

/**
 * Resolve the file that called defineCases.
 * @returns {string|null} Absolute path, or null when the stack is unreadable.
 */
function callerFile() {
  const original = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    const error = new Error();
    Error.captureStackTrace(error, defineCases);
    const frames = error.stack;
    return (frames && frames[0] && frames[0].getFileName()) || null;
  } catch (e) {
    return null;
  } finally {
    Error.prepareStackTrace = original;
  }
}

/**
 * The runner-scoped path a human types to run just this file, derived from the
 * case file's position under its test root (`test/suites/` or `test/`).
 * @param {string} file - Absolute path of the case file.
 * @returns {string} A path filter, or '' when the file sits outside a test root.
 */
function scopedPath(file) {
  const normalized = file.split(path.sep).join('/');
  const root = ['/test/suites/', '/test/'].find((marker) => normalized.includes(marker));
  if (!root) return '';
  // FIRST occurrence anchors on the package's test root: a nested test/ dir
  // (backend test/routes/test/) must stay part of the filter, not swallow it.
  return normalized
    .slice(normalized.indexOf(root) + root.length)
    .replace(/\.test\.js$/, '')
    .replace(/\.js$/, '');
}

/**
 * Was the case file loaded to run its cases: by `node --test`, or as the main
 * module? A `node --test` child runs the file as its main module; a runner
 * requires it, so it is never main there.
 * @param {string} file - Absolute path of the case file.
 * @returns {boolean} True when nothing else will run the cases.
 */
function loadedToRun(file) {
  return process.execArgv.includes('--test')
    || Boolean(require.main && require.main.filename === file);
}

/**
 * The framework that owns a case file, by the dispatcher's rule: the nearest
 * package.json's own name when it is a framework; any other `@omega.js/*` package
 * is `node`; else the framework it depends on (a brand target), else `node`.
 * @param {string} file - Absolute path of the case file.
 * @returns {string} A LAYERS key.
 */
function frameworkOf(file) {
  const fs = require('fs');
  const { nearestManifest } = require('../scaffold-guard.js');
  const { OMEGA_SCOPE, frameworksOf } = require('../omega-bin.js');
  const { frameworkIds } = require('./scope.js');

  const found = nearestManifest(path.dirname(file));
  if (!found) return 'node';
  const pkg = JSON.parse(fs.readFileSync(found.manifestPath, 'utf8'));
  const [ownId] = frameworkIds(pkg.name);
  if (ownId) return ownId;
  if (typeof pkg.name === 'string' && pkg.name.startsWith(OMEGA_SCOPE)) return 'node';
  const dependedOn = frameworksOf(pkg)[0];
  return dependedOn ? frameworkIds(dependedOn)[0] : 'node';
}

/**
 * Register a case file's own cases with node:test.
 * @param {object|Array} spec - The case spec.
 * @param {string} file - Absolute path of the case file.
 * @returns {void}
 */
function registerSelf(spec, file) {
  const { normalizeSpec } = require('./run-case.js');
  const { layersFor, defaultLayer, needsDriver } = require('./layers.js');
  const { hostSession, registerSuite } = require('./register-suite.js');
  const expect = require('./expect.js');

  const framework = frameworkOf(file);
  const normalized = normalizeSpec(spec, { file });
  const layer = normalized.layer || defaultLayer(framework);
  const row = layersFor(framework).find((candidate) => candidate.name === layer);
  const suite = { ...normalized, layer };
  const label = suite.description || path.basename(file);

  if (row && !needsDriver(row)) {
    registerSuite(suite, { label, session: hostSession(suite, { expect, defaultTimeout: handedTimeout() }) });
    return;
  }

  const filter = scopedPath(file);
  const { it } = require('node:test');
  it(label, () => {
    throw new Error([
      `${file} runs on the ${framework} "${layer}" layer, which only the OMEGA runner can drive:`,
      '',
      `  npx omega test framework:${filter}   (a framework suite)`,
      `  npx omega test ${filter}             (a project's own test/)`,
    ].join('\n'));
  });
}

/**
 * Return a case spec; a file loaded to run registers its own cases.
 * @param {object|Array} spec - The case-runner spec (suite, group, standalone, or array form).
 * @returns {object|Array} The same spec, unchanged.
 */
function defineCases(spec) {
  const file = callerFile();
  if (file && loadedToRun(file)) registerSelf(spec, file);

  return spec;
}

module.exports = defineCases;
module.exports.TIMEOUT_ARG = TIMEOUT_ARG;
