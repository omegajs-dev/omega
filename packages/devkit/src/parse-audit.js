/**
 * Parse-audit: vm-parse every .js file under a tree WITHOUT executing it, so a
 * file that fails to PARSE in a corner no test ever loads (CLI commands,
 * scaffold templates, setup machinery) still fails the run.
 *
 * CJS first (Module.wrap: the same wrapper node itself compiles modules
 * with); files that fail the CJS parse are re-checked as ESM by node's own
 * parser, all of them in ONE child process, so browser/ESM sources don't
 * false-positive. Only files failing BOTH parses are reported.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Build output and dependency trees never gate a source audit
const DEFAULT_SKIP = ['node_modules', 'dist', '.temp', '.cache', 'coverage', 'packaged', 'release'];

// The child's script: reads a JSON list of files on stdin, prints the ones that
// do not parse as an ES module. A SourceTextModule parses without linking or running.
const ESM_CHECK = `
const fs = require('node:fs');
const vm = require('node:vm');
const files = JSON.parse(fs.readFileSync(0, 'utf8'));
const failing = files.filter((file) => {
  try {
    new vm.SourceTextModule(fs.readFileSync(file, 'utf8').replace(/^#!.*/, ''), { identifier: file });
    return false;
  } catch (error) {
    return true;
  }
});
process.stdout.write(JSON.stringify(failing));
`;

/**
 * The files of a list that do not parse as an ES module, checked in one child.
 * @param {string[]} files - Absolute paths.
 * @returns {Set<string>} The failing paths.
 */
function failEsmParse(files) {
  if (files.length === 0) {
    return new Set();
  }

  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', ESM_CHECK], {
    input: JSON.stringify(files),
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });

  return new Set(JSON.parse(String(output)));
}

/**
 * Recursively parse-check every .js file under rootDir.
 * @param {string} rootDir - Tree to audit (absolute or cwd-relative).
 * @param {object} [options]
 * @param {string[]} [options.skipDirs] - Directory NAMES to skip at any depth (replaces the default list).
 * @returns {{ checked: number, failures: Array<{ file: string, error: string }> }}
 *   `file` is relative to rootDir; `error` is the first line of the parse error.
 */
function parseAuditTree(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const skipDirs = new Set(options.skipDirs || DEFAULT_SKIP);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.js')) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);

  // The CJS error of each file that fails the CJS parse, in walk order
  const cjsErrors = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');

    try {
      new vm.Script(Module.wrap(source), { filename: file });
    } catch (cjsError) {
      cjsErrors.set(file, cjsError);
    }
  }

  const esmFailing = failEsmParse([...cjsErrors.keys()]);
  const failures = [...cjsErrors]
    .filter(([file]) => esmFailing.has(file))
    .map(([file, cjsError]) => ({
      file: path.relative(root, file),
      error: String(cjsError.message).split('\n')[0],
    }));

  return { checked: files.length, failures };
}

module.exports = { parseAuditTree };
