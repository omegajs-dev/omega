// Loads a consumer integration file from an arbitrary path on disk (e.g. the consumer's
// src/integrations/tray/index.js) and answers its default export.
//
// Used by tray/menu/context-menu. A bundler would normally try to resolve `require(<dynamicPath>)`
// at build time, which can never work for a runtime path, so we use Node's
// `module.createRequire(...)` to get a real require function.

const path   = require('path');
const fs     = require('fs');
const Module = require('module');
const { defaultExport } = require('@omega.js/devkit/run-consumer-hook');

// Returns the file's default export, or null if the file doesn't exist.
// THROWS if the file fails to load, or is not an ES module with one default export.
// Node never reloads an edited ES module, so an edit shows on the next launch.
function loadConsumerFile(absPath) {
  if (!fs.existsSync(absPath)) return null;

  const consumerRequire = Module.createRequire(path.join(process.cwd(), 'package.json'));
  return defaultExport(absPath, consumerRequire(absPath));
}

module.exports = loadConsumerFile;
