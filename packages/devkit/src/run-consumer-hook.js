/**
 * The ONE consumer hook runner, shared by @omega.js/desktop and
 * @omega.js/extension: `runConsumerHook(name, ...args)` loads
 * `<cwd>/hooks/<name>.js` through `require()` and runs its default export.
 * A hook file is an ES module with one default export; a missing file is a
 * logged skip, any other form is refused by name, and a load error or a throw
 * inside the hook fails the caller loudly. `defaultExport(file, loaded, kind)`
 * is the read itself, for a framework's own loader of consumer files.
 */
const fs = require('node:fs');
const path = require('node:path');

// The kinds a default export may be: its check, and the form a refusal names
const KINDS = {
  function: { is: (value) => typeof value === 'function', form: 'export default async (...) => {}' },
  array: { is: Array.isArray, form: 'export default [ ... ]' },
};

/**
 * The default export of a consumer file `require()` loaded, or a throw naming
 * the file and the one form it must take.
 * @param {string} file - The file's absolute path, for the refusal.
 * @param {*} loaded - What `require(file)` answered.
 * @param {'function'|'array'} [kind='function'] - What the default export must be.
 * @returns {Function|Array} The default export.
 */
function defaultExport(file, loaded, kind = 'function') {
  // require() of an ES module answers its namespace object; a CommonJS file
  // answers its module.exports, which is never one.
  const isModule = Object.prototype.toString.call(loaded) === '[object Module]';

  if (!isModule || !KINDS[kind].is(loaded.default)) {
    throw new Error(`${file} must be an ES module with one default export (${KINDS[kind].form})`);
  }

  return loaded.default;
}

/**
 * Run the consumer's `hooks/<name>.js`, when it exists.
 * @param {string} name - The hook's path under `hooks/`, no extension (`build/pre`).
 * @param {...*} args - Handed to the hook as they are.
 * @returns {Promise<*>} What the hook answers, or undefined when there is no file.
 */
async function runConsumerHook(name, ...args) {
  // Built per run, so a framework's runtime that reads only defaultExport
  // never constructs a build-time logger.
  const Logger = require('./logger.js');
  const logger = new Logger('hooks');
  const file = path.join(process.cwd(), 'hooks', `${name}.js`);

  if (!fs.existsSync(file)) {
    logger.log(`hook "${name}" not present at ${file}, skipping`);
    return undefined;
  }

  const hook = defaultExport(file, require(file));

  logger.log(`running hook "${name}"`);
  return await hook(...args);
}

module.exports = { defaultExport, runConsumerHook };
