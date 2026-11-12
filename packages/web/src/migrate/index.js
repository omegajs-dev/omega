/**
 * index.js: the web leg of the brand root's `omega migrate`, one call that
 * converts a UJM consumer to @omega.js/web. In order: config (legacy configs →
 * an omega.json5 of declared keys only), codemod (rules.js over src/** templates and
 * consumer JS, plus consumer-assets.js), lint over the rewritten templates,
 * legacy-file removal, the legacy test harness (reported, never rewritten), and
 * bare requires (devkit's scan, shared with the backend leg; web adds its
 * bundler aliases). Report only by default, in memory; `execute: true` writes.
 * `migrateTarget` folds the report into the three line lists every leg answers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveConfigPath, findBrandConfigPath } = require('@omega.js/config');
const { convertConfig, readLegacyConfigs, serializeOmega } = require('./config-convert.js');
const { mergeIntoBrand } = require('./brand-config.js');
const { runCodemod, collectTemplateFiles } = require('./codemod.js');
const { configReads: configReadsRule } = require('./rules.js');
const { lintText } = require('./lint.js');
const { migrateConsumerAssets } = require('./consumer-assets.js');
const { collectBareRequires, formatBareRequire } = require('@omega.js/devkit/bare-requires');

const BUNDLER_ALIASES = ['__main_assets__', '__theme__', '@omega.js/client'];

// The legacy framework's own package. consumer-assets rewrites or flags every
// import of it, so the dependency scan never asks a consumer to install it.
const LEGACY_PACKAGE = 'ultimate-jekyll-manager';

// Legacy files deleted by a real migration (relative to the consumer root)
const LEGACY_FILES = [
  'src/_config.yml',
  'config/ultimate-jekyll-manager.json',
  'Gemfile',
  'Gemfile.lock',
  '.ruby-version',
];

// The legacy UJM harness. Its runner discovered ALL of `test/**/*.js`
// (excluding `_`-prefixed files and any `_`-prefixed directory — helpers,
// fixtures, `_init.js`) and read the layer from the module's own export, never
// from the path; `omega test` runs `node --test 'test/**/*.test.js'`, which
// matches almost none of them and reports a green `pass 0` — a migrated
// brand's whole regression suite goes dark without a word
// ([#248](https://github.com/Omega-JS-Stack/omega/issues/248)).
//
// Detection is by SHAPE, not by name: a harness module named `config.test.js`
// IS discovered by node:test, loads, registers no tests, and counts as a pass —
// the loudest false green there is. So a file that exports a module and never
// touches node:test is legacy whatever it is called, and a file that requires
// node:test is ported whatever it is called. Cheap enough to read: no execution.
const NODE_TEST_IMPORT = /(?:require\(\s*|from\s+)['"]node:test['"]/;
const MODULE_EXPORT = /(?:^|\n)\s*(?:module\.exports\s*=|exports\.[\w$]+\s*=|export\s+default\b)/;

/**
 * Whether a test-dir file is a legacy-harness module rather than a node:test
 * file, judged by its content.
 * @param {string} text - the file's source
 * @returns {boolean}
 */
function isLegacyHarnessFile(text) {
  if (NODE_TEST_IMPORT.test(text)) return false;
  return MODULE_EXPORT.test(text);
}

/**
 * Collect the legacy-harness test files `omega test` cannot discover (or
 * discovers and silently counts as an empty pass).
 * @param {string} root - consumer project root
 * @returns {string[]} paths relative to the root
 */
function collectLegacyTests(root) {
  const testDir = path.join(root, 'test');
  if (!fs.existsSync(testDir)) return [];

  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('_')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.js') continue;
      if (isLegacyHarnessFile(fs.readFileSync(full, 'utf8'))) files.push(path.relative(root, full));
    }
  };
  walk(testDir);
  return files.sort();
}

/**
 * Migrate a UJM consumer: a full report, and the writes only with `execute`.
 * @param {string} root - consumer project root
 * @param {object} [options]
 * @param {boolean} [options.execute] - write the conversion (default: report only)
 * @param {string} [options.brandRoot] - the brand this target belongs to: its
 *   root config is then the one the conversion merges into
 * @param {string} [options.name] - the target's folder name (required with brandRoot)
 * @returns {object} report
 */
function runMigration(root, options = {}) {
  const execute = options.execute === true;
  const report = { root, execute, config: null, codemod: null, lint: [], removed: [], legacyTests: [], bareRequires: [], errors: [] };
  if (options.brandRoot && !options.name) throw new Error('runMigration: a brandRoot needs the target\'s folder name');

  // ---- 1. Config conversion
  const { jekyll, ujm, files: legacySources } = readLegacyConfigs(root);
  const omegaPath = path.join(root, 'config', 'omega.json5');
  const sources = legacySources.map((file) => path.relative(root, file));
  // The legacy guard runs FIRST, and stays first: a root that still carries
  // _config.yml / ultimate-jekyll-manager.json is MID-conversion — the
  // omega.json5 beside (or above) it is an earlier partial run or the brand
  // layer, and the legacy sources are the truth to convert from. Probing for a
  // converted config before this check would skip those roots forever.
  if (options.brandRoot) {
    // Inside a brand the root config is the one home of the conversion; the
    // target's own config/omega.json5 is its override layer, left alone.
    const brandFile = resolveConfigPath(options.brandRoot);
    // A brand root is found BY its config/omega.json5 (resolveBrandRoot)
    if (!brandFile) throw new Error(`${options.brandRoot} carries no config/omega.json5, so it is not a brand root`);
    const where = { path: path.relative(root, brandFile), home: `the brand root ${path.relative(options.brandRoot, brandFile)}` };
    if (jekyll || ujm) {
      const { omega, notes } = convertConfig({ jekyll, ujm, name: options.name });
      const merge = mergeIntoBrand(brandFile, { name: options.name, converted: omega, execute });
      report.config = { ...where, brand: true, sources, notes, ...merge };
    } else {
      report.config = { ...where, skipped: true };
    }
  } else if (!jekyll && !ujm) {
    // Pre-converted is the fleet-standard order, not a failure
    // ([#297](https://github.com/Omega-JS-Stack/omega/issues/297)): the brand
    // root's omega.json5 lands first and the target's UJM configs are gone before
    // migrate ever runs, so the config step is DONE and the codemods below are
    // the rest of the job. Only a root with neither legacy configs NOR a
    // resolvable omega.json5 is genuinely broken.
    //
    // The omega.json5 the loadConfig contract resolves for this root: its own
    // file, else its brand root's (a target inside a brand monorepo rides the
    // brand config alone — the local-layer file is optional there).
    const converted = resolveConfigPath(root) || findBrandConfigPath(root);
    // Whether that config LOADS is the brand-root run's to judge, once after
    // the walk: a target leg reports its own files only.
    if (converted) {
      report.config = { skipped: true, path: path.relative(root, converted) };
    } else {
      report.errors.push('no legacy configs found (src/_config.yml / config/ultimate-jekyll-manager.json)');
    }
  } else {
    const { omega, notes } = convertConfig({ jekyll, ujm });
    report.config = { path: path.relative(root, omegaPath), sources, notes, omega };
    if (execute) {
      fs.mkdirSync(path.dirname(omegaPath), { recursive: true });
      fs.writeFileSync(omegaPath, serializeOmega(omega));
    }
  }

  // ---- 2. Codemod over src/** templates + the consumer asset layer
  report.codemod = runCodemod(root, { execute });
  const assets = migrateConsumerAssets(root, { execute });
  report.removed.push(...assets.removed);
  report.lint.push(...assets.findings);
  if (assets.edits.length > 0) {
    report.codemod.files.push(...assets.edits.map((edit) => ({ path: edit.file, edits: [edit] })));
    report.codemod.totalEdits += assets.edits.length;
  }

  // ---- 2b. The config file's own string values: a `{{ site.<section> }}` read
  // there renders empty like any template's. Rewritten in the FILE so comments
  // survive; a report on a legacy root scans the config the run WOULD write.
  const resolvedConfigPath = report.config && report.config.path && path.resolve(root, report.config.path);
  const configExists = Boolean(resolvedConfigPath) && fs.existsSync(resolvedConfigPath);
  // A report inside a brand scans the root as the merge WOULD leave it
  const pendingText = !execute && report.config && report.config.brand ? report.config.text : null;
  const configText = pendingText !== null ? pendingText
    : configExists ? fs.readFileSync(resolvedConfigPath, 'utf8')
      : (resolvedConfigPath && report.config.omega ? serializeOmega(report.config.omega) : null);
  if (configText !== null) {
    const rel = report.config.home || path.relative(root, resolvedConfigPath);
    const { text, edits, findings } = configReadsRule.apply(configText);
    if (edits.length > 0) {
      // `execute` implies the file exists: the conversion branch above wrote it,
      // and the skip branch resolved one that was already there.
      if (execute) fs.writeFileSync(resolvedConfigPath, text);
      report.codemod.files.push({ path: rel, edits });
      report.codemod.totalEdits += edits.length;
      report.lint.push(...findings.map((finding) => ({ ...finding, file: rel })));
    }
  }

  // ---- 3. Liquid-lint over the (post-rewrite) templates
  for (const filePath of collectTemplateFiles(path.join(root, 'src'))) {
    report.lint.push(...lintText(fs.readFileSync(filePath, 'utf8'), path.relative(root, filePath)));
  }
  report.lint.push(...report.codemod.findings);

  // ---- 4. Legacy file hygiene
  for (const rel of LEGACY_FILES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    if (execute) fs.rmSync(full);
    report.removed.push(rel);
  }

  // ---- 5. Legacy test harness (reported, never rewritten — porting a suite
  // to node:test is by hand)
  report.legacyTests = collectLegacyTests(root);

  // ---- 6. Dependency resolution (#600): a bare require that only the legacy
  // FLAT install answered. Reported with the fix, never installed. The scan is
  // devkit's, shared with @omega.js/backend's own migrate; what web adds is its
  // BUNDLER ALIASES, the specifiers the build resolves for the consumer,
  // subpaths included ([index.md](../../../../docs/web/index.md): `__main_assets__/*`
  // to the core layer, `__theme__/*` to the active theme, `@omega.js/client` to
  // the client package). None is a dependency a consumer may declare, since
  // installing `@omega.js/client` beside the framework is a SECOND client
  // runtime, so naming them would hand the report a fix that breaks the project.
  report.bareRequires = collectBareRequires(root, { aliases: [...BUNDLER_ALIASES, LEGACY_PACKAGE] });

  return report;
}

/**
 * The web target's leg of the brand root's `omega migrate`: runMigration's
 * report as plain lines. What the run writes is `due` in report mode and
 * `changed` under `execute`; what only a human can port (lint findings, config
 * notes, the legacy harness, undeclared requires) is `due` either way.
 * @param {string} targetDir - the web target's root
 * @param {object} [options]
 * @param {boolean} [options.execute] - write the conversion (default: report only)
 * @param {string} [options.brandRoot] - the brand root, whose config the conversion merges into
 * @param {string} [options.name] - the target's folder name, its key under `targets`
 * @returns {{ due: string[], changed: string[], errors: string[] }}
 */
function migrateTarget(targetDir, options = {}) {
  const execute = options.execute === true;
  const report = runMigration(targetDir, { execute, brandRoot: options.brandRoot, name: options.name });
  const writes = [];
  const byHand = [];
  const errors = [...report.errors];

  if (report.config && report.config.brand) {
    const { home, added, kept } = report.config;
    const from = report.config.sources.join(' + ');
    writes.push(`${execute ? 'converted' : 'convert'} ${from} into ${home}`);
    writes.push(...added.map((entry) => `${execute ? 'added' : 'add'} ${entry.path} to ${home} (from ${from})`));
    byHand.push(...kept.map((entry) => `${execute ? 'kept' : 'keep'} ${entry.path} = ${JSON.stringify(entry.value)} in ${home} over ${JSON.stringify(entry.incoming)} from ${from}`));
  } else if (report.config && !report.config.skipped) {
    writes.push(`${execute ? 'converted' : 'convert'} ${report.config.sources.join(' + ')} into ${report.config.path}`);
  }
  if (report.config && report.config.notes) byHand.push(...report.config.notes.map((note) => `config note: ${note}`));

  for (const file of report.codemod.files) {
    const byRule = {};
    for (const edit of file.edits) byRule[edit.rule] = (byRule[edit.rule] || 0) + 1;
    const rules = Object.entries(byRule).map(([rule, count]) => `${rule}×${count}`).join(', ');
    writes.push(`${execute ? 'rewrote' : 'rewrite'} ${file.path}: ${rules}`);
  }

  writes.push(...report.removed.map((rel) => `${execute ? 'removed' : 'remove'} ${rel}`));

  byHand.push(...report.lint.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`));
  byHand.push(...report.legacyTests.map((rel) => `${rel}: a legacy harness file \`omega test\` never discovers (it runs test/**/*.test.js), port it to node:test`));
  byHand.push(...report.bareRequires.map((entry) => formatBareRequire(entry)));

  return execute
    ? { due: byHand, changed: writes, errors }
    : { due: [...writes, ...byHand], changed: [], errors };
}

module.exports = { runMigration, migrateTarget, LEGACY_FILES };
