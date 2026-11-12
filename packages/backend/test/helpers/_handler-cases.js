/**
 * The two tools a handler-loading case reads: a scratch tree of real handler
 * files, and the outcome a promise settled with.
 * (Underscore-prefixed: the runner skips _ files in discovery.)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A scratch tree of real files, removed once the case settles.
 * @param {Function} after - The case's teardown registrar.
 * @param {Object<string, string>} files - Source by path relative to the tree.
 * @returns {string} The tree's real path (an ES module's import.meta.dirname is resolved through links, macOS /var).
 */
function scratch(after, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-handlers-')));

  for (const [relative, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), source);
  }

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/**
 * What a promise settled with, flattened for assertion.
 * @param {Promise<*>} promise - The call under test.
 * @returns {Promise<{ resolved: * } | { rejected: * }>} Its value, or its rejection.
 */
async function settle(promise) {
  try {
    return { resolved: await promise };
  } catch (e) {
    return { rejected: e };
  }
}

module.exports = { scratch, settle };
