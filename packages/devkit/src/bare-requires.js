/**
 * "Does this project declare everything its sources require?" Under the legacy
 * FLAT install a ported file could `require('fs-jetpack')` and be right; under
 * OMEGA a bare require of something the consumer never declared resolves only
 * by HOISTING, and the LAZY ones load fine and 500 the first time they run.
 * REPORT ONLY, by the consumer's own manifest: every bare specifier that is
 * neither a Node built-in, nor an alias the caller's framework resolves, nor a
 * declared dependency, named file:line with the fix, never installed. Two
 * readers share it: the web and backend legs of the brand root's `omega
 * migrate`, and `nudgeBareRequires`, the warning each framework's scaffold
 * prints on every verb, where a package the framework itself declares also
 * names the framework's door to its own copy. Stdlib-only, like every vendorable module.
 */
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { frameworkDependencyNames } = require('./framework-deps.js');
const { bareSpecifiers, packageName } = require('./load-forms.js');

// Both spellings of every built-in: `require('fs')` and `require('node:fs')`.
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

// Build output, vendored trees and the archive dirs a port leaves behind: none
// of them is source this project ships, and scanning them reports findings
// nobody can act on.
const SKIP_DIRS = ['node_modules', 'dist', '_site', '_legacy', '_backup', '.git'];

// The dependency fields npm resolves a bare specifier from at RUNTIME or in a
// build. A peer the consumer declares is installed beside it like any other.
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Every `.js` file under a dir, build output and archive dirs skipped.
 *
 * @param {string} dir
 * @returns {string[]} Absolute paths, sorted.
 */
function collectScriptFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(entry.name)) walk(full);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name) === '.js') files.push(full);
    }
  };

  if (fs.existsSync(dir)) walk(dir);

  return files.sort();
}

/**
 * Every package name the consumer's own package.json declares.
 *
 * @param {string} root - Consumer project root.
 * @returns {Set<string>|null} null when there is no manifest to judge against.
 */
function declaredPackages(root) {
  const manifestPath = path.join(root, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null; // an unparseable manifest says nothing about what is declared
  }

  const declared = new Set();
  for (const field of MANIFEST_FIELDS) {
    for (const name of Object.keys(manifest[field] || {})) declared.add(name);
  }

  return declared;
}

/**
 * Scan a consumer's sources for bare requires and imports of packages it does not declare.
 * @param {string} root - Consumer project root (the manifest is judged from here).
 * @param {object} [options]
 * @param {string[]} [options.aliases] - Package names the framework RESOLVES for the
 *   consumer (a bundler alias, a runtime it owns): never a dependency to declare.
 * @param {string} [options.srcDir] - The tree to scan, relative to root. Defaults to `src`.
 * @param {string} [options.frameworkRoot] - The calling framework's package root:
 *   a finding its declared set carries is marked `framework: true`.
 * @returns {Array<{ file: string, line: number, module: string, fix: string, framework: boolean }>}
 *   One entry per file+package, at its first sighting.
 */
function collectBareRequires(root, options = {}) {
  const aliases = options.aliases || [];
  const declared = declaredPackages(root);
  if (!declared) return [];

  const frameworkDeps = new Set(options.frameworkRoot ? frameworkDependencyNames(options.frameworkRoot) : []);

  const found = [];
  for (const filePath of collectScriptFiles(path.join(root, options.srcDir || 'src'))) {
    const source = fs.readFileSync(filePath, 'utf8');
    const seen = new Set();

    for (const { specifier, index } of bareSpecifiers(source)) {
      if (BUILTINS.has(specifier)) continue;

      const name = packageName(specifier);
      if (aliases.includes(name)) continue;
      if (declared.has(name) || seen.has(name)) continue;
      seen.add(name);

      found.push({
        file: path.relative(root, filePath),
        line: source.slice(0, index).split('\n').length,
        module: name,
        fix: `add it to this project's package.json (\`npm install ${name}\`), it resolved through the legacy flat install and resolves under OMEGA only by hoisting`,
        framework: frameworkDeps.has(name),
      });
    }
  }

  return found;
}

/**
 * One finding as its one line. A package the framework declares names both
 * fixes when the caller hands its door; every other finding is declare-only.
 * @param {{ file: string, line: number, module: string, fix: string, framework: boolean }} entry - a collectBareRequires finding
 * @param {function(string): string} [door] - The framework's call form for a module, `omega.require('<module>')` on the backend.
 * @returns {string}
 */
function formatBareRequire(entry, door) {
  if (entry.framework && door) {
    return `${entry.file}:${entry.line}: \`${entry.module}\` is not declared in this project's package.json: declare it (\`npm install ${entry.module}\`), or load the framework's copy with ${door(entry.module)}`;
  }

  return `${entry.file}:${entry.line}: \`${entry.module}\` is not declared: ${entry.fix}`;
}

/**
 * The scaffold's dependency nudge: one warning per undeclared bare require,
 * never an error, because a consumer may declare its own version and it wins.
 *
 * @param {object} input
 * @param {string} input.root - Consumer project root.
 * @param {string} [input.srcDir] - The tree to scan, relative to root.
 * @param {string} input.frameworkRoot - The calling framework's package root.
 * @param {string[]} [input.aliases] - Names the framework resolves itself.
 * @param {function(string): string} input.door - The framework's call form for a module.
 * @param {function(string): void} input.warn - Warning logger, one call per finding.
 * @returns {Array<object>} The findings, as collectBareRequires returns them.
 */
function nudgeBareRequires({ root, srcDir, frameworkRoot, aliases, door, warn }) {
  const findings = collectBareRequires(root, { aliases, srcDir, frameworkRoot });

  for (const entry of findings) warn(formatBareRequire(entry, door));

  return findings;
}

module.exports = { collectBareRequires, formatBareRequire, nudgeBareRequires };
