/**
 * target-checks — the AUDIT half of the retired `omega setup`
 * ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)).
 *
 * The setup command had two halves: write the local files if missing (now
 * `ensureTarget()`, which every verb runs through `ensureStaged`) and CHECK
 * the target, healing what it can. The checks ride `omega test` and, offline,
 * `omega dev`: the registry under cli/commands/setup-tests runs before the
 * emulator boots, and a check nothing can fix halts the run.
 *
 * The registry reads its state off the `main` object (`self.package`,
 * `self.gitignore`, `self.omegaConfigJSON`, `self.projectId`, the generated
 * rules on `self.default`), so `loadFiles` + `getRulesFile` below are the
 * preamble every run needs — the same one `runSetup()` did before the split.
 */
const path = require('path');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');
const JSON5 = require('json5');
const omegaConfig = require('@omega.js/config');

const ui = require('./ui');

// Rules-marker regex shared with the rules checks (used by getRulesFile)
const { omegaAllRulesRegex } = require('../commands/setup-tests/helpers.js');

// The rules SCHEMA version — the stamp in `database.rules.json`'s open marker
// and in the compiled firestore artifact's header. Owned by the rules compiler
// (src/cli/utils/compile-rules.js) and re-exported here, the address every
// caller already knows.
const { RULES_VERSION } = require('./compile-rules');

/** Read a JSON5 file, `{}` when it is missing or empty. */
function loadJSON(filePath) {
  const contents = jetpack.read(filePath);
  return contents ? JSON5.parse(contents) : {};
}

function hasContent(object) {
  return Object.keys(object).length > 0;
}

/**
 * Load the target files every check reads onto `main`.
 *
 * @param {object} main - The CLI's Main instance (firebaseProjectPath).
 * @returns {object} The same main, for chaining.
 */
function loadFiles(main) {
  // THE target manifest (target root — scripts + runtime deps; the staged
  // dist/package.json derives from it at stage time)
  main.package = loadJSON(`${main.firebaseProjectPath}/package.json`);
  main.firebaseJSON = loadJSON(`${main.firebaseProjectPath}/firebase.json`);
  main.firebaseRC = loadJSON(`${main.firebaseProjectPath}/.firebaserc`);
  // Target root — where setup-tests/remoteconfig-template-file.js writes it.
  // The old `functions/` spelling is the pre-src/dist layout and always
  // read {}.
  main.remoteconfigJSON = loadJSON(`${main.firebaseProjectPath}/remoteconfig.template.json`);
  main.projectPackage = main.package;
  // Resolved through @omega.js/config (local ← brand root, no framework-defaults
  // layer). Throws on secrets/parse errors (the checks ARE the audit — hard
  // failures are correct here). The omega-config check validates the resolved
  // config against the shared schema (friction #5). A brand target carries no
  // file of its own — the brand root's config resolves alone.
  main.omegaConfigJSON = (omegaConfig.hasOmegaConfig(main.firebaseProjectPath)
    || omegaConfig.findBrandRoot(main.firebaseProjectPath))
    ? omegaConfig.loadConfig(main.firebaseProjectPath, 'backend').config
    : {};
  main.gitignore = jetpack.read(`${main.firebaseProjectPath}/.gitignore`) || '';

  return main;
}

/**
 * Generate the realtime-database rules the rules checks compare against, onto
 * `main.default`. firestore.rules is COMPILED (#255), not marker-managed: the
 * brand's file is pure source and the framework half ships in templates/, so
 * nothing here generates it. database.rules.json keeps the marker model.
 *
 * @param {object} main - The CLI's Main instance.
 * @returns {object} `main.default`, carrying the generated rules.
 */
function getRulesFile(main) {
  main.default.databaseRulesWhole = jetpack
    .read(path.resolve(`${__dirname}/../../../templates/database.rules.json`))
    .replace('(v0.0.0)', `(v${RULES_VERSION})`);
  main.default.databaseRulesCore = main.default.databaseRulesWhole.match(omegaAllRulesRegex)[0];

  return main.default;
}

/**
 * Run the check registry against the target, healing what it can.
 *
 * Every check reports through `main.test()` — pass, warn, or fix-then-pass —
 * and an unfixable one calls `main.haltSetup()`, which prints the summary and
 * exits 1. Loud by design: a target that cannot be made whole must not go on
 * to boot an emulator against it.
 *
 * @param {object} main - The CLI's Main instance.
 * @returns {Promise<{ passed: boolean, total: number }>}
 */
async function runTargetChecks(main) {
  const testRegistry = require('../commands/setup-tests');
  const helpers = require('../commands/setup-tests/helpers');

  // Fresh state for this run (the check runner records into the summary and
  // prints it on a hard failure; we print it here on success).
  main.testCount = 0;
  main.testTotal = 0;
  main.warnCount = 0;
  main.setupSummary = new ui.Summary().start();

  loadFiles(main);

  if (!hasContent(main.package)) {
    ui.status('fail', `Missing ${chalk.bold('package.json')} at the target root`);
    ui.note(`Run an OMEGA verb from a backend target root (a package.json with the ${chalk.bold('@omega.js/backend')} dependency).`);
    process.exit(1);
  }

  getRulesFile(main);
  // The rules SCHEMA version rides in the block's open marker:
  // `// ========== OMEGA Rules (v2.0.0) ==========`
  main.default.rulesVersionRegex = new RegExp(`========== OMEGA Rules \\(v${RULES_VERSION.replace(/\./g, '\\.')}\\) ==========`);

  // Resolve project info — the checks read projectId (demo-* gating, live
  // index sync, campaign seeding). ensureTarget() guarantees .firebaserc.
  main.projectId = main.firebaseRC.projects?.default;
  main.projectUrl = `https://console.firebase.google.com/project/${main.projectId}`;
  main.apiUrl = omegaConfig.apiAddress(main.omegaConfigJSON.brand?.url || '', main.projectId);

  const tests = testRegistry.getTests({
    main,
    package: main.package,
    packageJSON: main.packageJSON,
    gitignore: main.gitignore,
    hasContent: helpers.hasContent,
    loadJSON: helpers.loadJSON,
  });

  // Expose the total count so the per-check `[N]` prefix can right-align its
  // width (single- vs double-digit indices stay aligned).
  main.testTotalExpected = tests.length;

  for (const test of tests) {
    await main.test(
      test.getName(),
      async () => test.run(),
      async () => test.fix(),
      { details: () => test.getWarning() },
    );
  }

  main.setupSummary.print();

  return { passed: main.testCount + main.warnCount === main.testTotal, total: main.testTotal };
}

module.exports = { runTargetChecks, loadFiles, getRulesFile, RULES_VERSION };
