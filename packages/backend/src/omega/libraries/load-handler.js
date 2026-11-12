/**
 * The one handler loader: every route, schema, event, cron job, auth hook and
 * payment transition is loaded through it.
 *
 * A handler is an ES module with one default export, a function. Node's
 * require() loads one natively, and devkit's one read of a default export
 * answers it; a CommonJS file is refused by name, never read a second way.
 */
const { defaultExport } = require('@omega.js/devkit/run-consumer-hook');

/**
 * Load a handler file and answer its default export.
 *
 * @param {string} filePath - Absolute path of the handler file
 * @returns {Function} The module's default export
 * @throws {Error} The require's own error when the file cannot load; the refusal
 *   naming the file when it is not an ES module whose default export is a function
 */
function loadHandler(filePath) {
  return defaultExport(filePath, require(filePath));
}

module.exports = { loadHandler };
