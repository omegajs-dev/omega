/**
 * ensure-target — the LOCAL, idempotent scaffold every verb runs
 * ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)).
 *
 * `omega setup` used to own this half and nothing ran it for you, so a target
 * drifted until someone remembered the command per target. It is retired: the
 * "write it if missing" steps live here and build/package/publish/test/deploy
 * all call it first, so every verb heals the tree on the way past.
 *
 * What it guarantees, in this order:
 *
 *   package.json      the omega verb scripts, `private`, and the electron main
 *                     entry — pure manifest edits, so they land before anything
 *                     that can throw
 *   .nvmrc            SEEDED from the framework's pinned Electron runtime when
 *                     the file is missing; the postinstall sync-nvmrc script is
 *                     the one live reader of the Electron releases feed and
 *                     keeps it current from there (one writer per fact)
 *   node version      a WARNING when the running major is not the pin
 *   peer dependencies installed when missing or behind (a satisfied target
 *                     installs nothing)
 *   defaults tree     src/defaults/** — copy-if-missing, marker merges for
 *                     .env/.gitignore, workflows re-rendered
 *   AGENTS.md         standalone only, through devkit's one builder
 *   locality          a WARNING when the framework is a `file:` link
 *   dependency nudge  a WARNING per bare require under hooks/ the target
 *                     never declared (docs/shared/local-dev.md)
 *
 * Everything here is copy-if-missing, marker-merge or write-if-changed. What
 * needs the network is NOT here — cert validation, repo provisioning, secret
 * publication and the framework freshness check are `omega deploy` prechecks
 * (deploy-precheck.js).
 */
const path = require('path');
const jetpack = require('fs-jetpack');
const version = require('wonderful-version');
const build = require('../../build.js');
const { ensurePeerDependencies, readProject } = require('./dependencies.js');
const { renderSecretsBlock } = require('@omega.js/config/env-delivery');
const { composeTargetWorkflows, renderInstallFirewall, renderInstallWorkspace } = require('@omega.js/devkit/ci-workflows');
const { assertScaffoldable } = require('@omega.js/devkit/scaffold-guard');
const { nudgeBareRequires } = require('@omega.js/devkit/bare-requires');
const { scaffoldAgentsMd } = require('@omega.js/devkit/agents-md');
const { projectScripts } = require('@omega.js/devkit/verb-scripts');
const { writeJson, formatJson } = require('@omega.js/devkit/write-json');

const logger = build.logger('ensure-target');
const package = build.getPackage('main');

/**
 * Sync the consumer manifest: the omega verb scripts, the npm-private latch,
 * the license (#884, seeded only when the manifest states none), and the
 * electron main entry (the gulp `bundle` task's output bundle).
 * Identical content is not a write (#590).
 */
function setupScripts(projectDir, result) {
  projectDir = projectDir || build.getRootPath('project');
  result = result || { changed: [] };

  const project = readProject(projectDir);

  // The verb table's scripts for this framework, the manifest's declarations over them
  project.scripts = { ...project.scripts, ...projectScripts(package) };

  // Electron consumer projects should not be published to npm
  project.private = true;

  // The license every OMEGA target states when it states none of its own
  // ([#884](https://github.com/Omega-JS-Stack/omega/issues/884)): UNLICENSED is
  // npm's word for closed-source commercial code, and electron-builder reads
  // the field for the packaged app's metadata. A brand's own license is kept.
  project.license = project.license || 'UNLICENSED';

  // Point electron at the built main bundle.
  // The gulp `bundle` task emits dist/main.bundle.js; the consumer's src/main.js is the *source* entry.
  project.main = 'dist/main.bundle.js';

  // Save the project, and only when its bytes differ
  const projectPath = path.join(projectDir, 'package.json');

  if (jetpack.read(projectPath) === formatJson(project)) {
    return;
  }

  writeJson(projectPath, project);
  result.changed.push('package.json (scripts + main + private + license)');
}

/**
 * Seed .nvmrc from the framework's pinned Electron runtime when it is missing.
 * An existing pin is left alone: `scripts/sync-nvmrc.js` (the consumer's
 * postinstall) is the ONE reader of the Electron releases feed and owns keeping
 * it current, so this offline seed can never fight it.
 */
function ensureNvmrc(projectDir, requiredMajor, result) {
  const nvmrcPath = path.join(projectDir, '.nvmrc');

  if (jetpack.exists(nvmrcPath)) {
    return;
  }

  jetpack.write(nvmrcPath, `v${requiredMajor}/*\n`);
  result.written.push('.nvmrc');
}

/**
 * Warn when the running Node major is not the target's pin. Never fatal (#15):
 * the pin is written, the remaining steps complete, and manage runs spawn
 * verbs under the app's own Node anyway.
 */
function checkNodeVersion(projectDir, requiredMajor, warn) {
  const installedMajor = version.clean(process.version).split('.')[0];

  if (String(installedMajor) === String(requiredMajor)) {
    return;
  }

  warn(
    `Node version mismatch: running v${installedMajor} but Electron requires v${requiredMajor} (matches Electron's bundled Node). `
    + `Standalone shells: run \`nvm use\` (the .nvmrc is pinned to v${requiredMajor}/*) before the next build.`,
  );
}

/**
 * Apply the framework's defaults tree (src/defaults/**) to the target root via
 * the shared devkit engine.
 *
 * @param {string} projectDir - The target root.
 * @param {object} log - `{ log, warn, error }` handed to the engine.
 */
async function copyDefaults(projectDir, engineLogger) {
  projectDir = projectDir || build.getRootPath('project');
  engineLogger = engineLogger || logger;

  const defaultsDir = path.resolve(__dirname, '..', '..', 'defaults');

  if (!jetpack.exists(defaultsDir)) {
    engineLogger.warn(`Defaults directory not found at ${defaultsDir}`);
    return;
  }

  // Template substitution context — `{{ versions.node }}` etc. resolved at scaffold time.
  // Source of truth is @omega.js/desktop's pinned `omega.nodeRuntime` (the Electron-bundled
  // Node major; consumers' .nvmrc additionally self-syncs from the live Electron feed via
  // scripts/sync-nvmrc.js). `engines.node` is deliberately NOT used here — it's the honest
  // dev floor (`>=24`), not a renderable version.
  // `githubSecrets` is the build workflow's env block, GENERATED from the env
  // schema ([#627](https://github.com/Omega-JS-Stack/omega/issues/627)): one
  // `KEY: ${{ secrets.KEY }}` line per key the schema delivers to desktop, at
  // the token's two-space indent. The yml rule below re-renders on every verb,
  // so the block tracks the schema like the node version tracks the pin.
  // The composed half (#835): the brand's PRODUCTION values name the keys the
  // schema cannot, which on desktop is the consumer's own `.env` lines. NAMES
  // only ever reach the workflow file; no value is rendered anywhere.
  const { composeTargetEnv } = require('@omega.js/config');
  const { values: composed } = composeTargetEnv({ targetDir: projectDir, target: 'desktop', environment: 'production' });

  const templateContext = {
    versions: { ...(package.engines || {}), node: package.omega.nodeRuntime },
    githubSecrets: renderSecretsBlock('desktop', { indent: '  ', values: composed }),
  };

  // Scaffolding runs through the shared devkit engine (vendored at prepare time).
  // Engine built-ins cover @omega.js/desktop's structural rules: `_.` renames (`_.gitignore` → `.gitignore`),
  // archive-dir skips (`_mas/` reference plists ship in the package, never to
  // consumers — `_`-prefixed FILENAMES like `test/_init.js` still copy), and
  // write-only-if-changed.
  const { applyDefaults } = require('@omega.js/devkit/defaults-engine');
  const { renderTokens } = require('@omega.js/devkit/tokens');

  // Layer-aware config (cp121c/cp122d): brand targets carry NO local-layer
  // omega.json5 — the brand file's `targets.*` is the per-target home, and
  // the local file is the STANDALONE escape hatch only. Inside a brand
  // monorepo the template's config must not scaffold at all (the old
  // targets-only seed kept resurrecting deleted local files on every run).
  const { resolveSeedMode } = require('@omega.js/config');
  const seed = resolveSeedMode(projectDir);
  const isBrandTarget = !seed.standalone;

  const applied = applyDefaults({
    defaultsDir,
    outputDir: projectDir,
    fileMap: {
      // Consumers own their files — never overwrite what exists.
      '**/*': { overwrite: false },
      ...(isBrandTarget ? { 'config/omega.json5': { skip: true } } : {}),
      // Marker-section merges: framework owns the Default section, consumer owns
      // everything below the Custom marker. Every verb keeps the framework
      // section live-synced without clobbering the consumer's values.
      // The target-root .env is NOT scaffolded ([#678](https://github.com/Omega-JS-Stack/omega/issues/678)):
      // the brand root's .env is the one file humans and the manager edit, a
      // target .env is an optional per-key override a HUMAN writes, and no
      // machine writes a target .env — so the template is gone.
      '_.gitignore': { mergeLines: true, template: templateContext },
      // The one TRACKED file under config/certs/ ([#913](https://github.com/Omega-JS-Stack/omega/issues/913)),
      // and framework-owned like the workflow YAMLs: it explains where signing
      // material really lives, so a target keeps the explanation that matches
      // the ignore rules the scaffold just wrote, never an older one.
      'config/certs/README.md': { overwrite: true },
      // Scaffolded docs are generated output: the framework rewrites the Default
      // section from this source on every verb, the project's notes live under Custom.
      'test/README.md': { mergeLines: true },
      // In a brand the BRAND ROOT is the one doc home: per-target CHANGELOG.md
      // and docs/ never scaffold, and framework-owned copies are swept (consumer
      // content is kept). Last-match-wins over the rules above.
      ...(isBrandTarget ? {
        'CHANGELOG.md': { retire: true },
        'docs/**/*': { retire: true },
      } : {}),
      // Workflow YAMLs are framework-owned: always re-rendered so they track changes in
      // @omega.js/desktop's defaults (e.g. engines.node bumping when Electron updates). The
      // renderer is tolerant — GitHub Actions' `${{ secrets.X }}` survives — and
      // the engine skips the write when the rendered content is byte-identical.
      '**/*.{yml,yaml}': { overwrite: true, template: templateContext },
      // CI (#265): GitHub runs workflows from the REPO ROOT only, so a per-target
      // .github/workflows/ in a brand monorepo can never fire — the #627 secrets
      // block was rendering into a file Actions would never execute. It is
      // composed into the brand root below instead, scoped to this target's
      // path, exactly as web and the extension do. Last-match-wins over the yml
      // rule above; a STANDALONE target (its own git root) keeps its own copy.
      ...(isBrandTarget ? { '.github/**/*': { skip: true } } : {}),
    },
    // The firewall step and the workspace flag are devkit's, rendered wherever
    // a workflow is WRITTEN ([#872](https://github.com/Omega-JS-Stack/omega/issues/872),
    // [#898](https://github.com/Omega-JS-Stack/omega/issues/898)): the brand
    // lane gets both inside composeWorkflow below, a STANDALONE target here, on
    // the copy this engine writes. The action, its pin and the flag live in ONE
    // place, so none of the four templates restates them. A standalone target
    // is its own repo root and declares no workspaces, so the flag renders to
    // nothing here.
    transform: (contents) => renderInstallWorkspace(renderInstallFirewall(contents)),
    logger: engineLogger,
  });

  // The project-root AGENTS.md, through devkit's one builder.
  scaffoldAgentsMd({ outputDir: projectDir, standalone: seed.standalone, result: applied, logger: engineLogger });

  if (isBrandTarget) {
    // The same templateContext the yml rule uses, so the composed copy carries
    // the generated `githubSecrets` block — a composed workflow with the raw
    // token in it would be the only file CI actually runs, and broken.
    composeTargetWorkflows({
      sourceDir: path.join(defaultsDir, '.github', 'workflows'),
      targetDir: projectDir,
      brandRoot: seed.brandRoot,
      transform: (contents) => renderTokens(contents, templateContext),
      logger: engineLogger,
    });
  }

  removeRetiredCertsIgnore(projectDir, engineLogger);

  return applied;
}

/**
 * Remove the sibling `config/certs/.gitignore` left over from the era when
 * `config/certs/` was ignored whole
 * ([#913](https://github.com/Omega-JS-Stack/omega/issues/913)). The directory's
 * README is the one tracked explanation of where signing material really lives,
 * and a nested ignore file of `*` + `!.gitignore` beats the parent file, so it
 * keeps hiding the README on a target scaffolded before the new rules. The
 * parent's own retired `config/certs/` line needs no healing: the marker merge
 * drops it with the rest of the framework block
 * ([#926](https://github.com/Omega-JS-Stack/omega/issues/926)). A copy an
 * EARLIER run already moved into the consumer's Custom section is the
 * consumer's by that rule and is left alone.
 *
 * The sibling is framework-written and known byte for byte, so only that exact
 * shape is removed. Anything a consumer wrote stays.
 *
 * @param {string} projectDir - The target root.
 * @param {object} engineLogger - `{ log, warn }`.
 */
function removeRetiredCertsIgnore(projectDir, engineLogger) {
  const siblingPath = path.join(projectDir, 'config', 'certs', '.gitignore');
  const sibling = jetpack.read(siblingPath);

  if (sibling && sibling.replace(/\r\n/g, '\n').trim() === '*\n!.gitignore') {
    jetpack.remove(siblingPath);
    engineLogger.log('Healed → config/certs/.gitignore (retired: the target .gitignore owns this directory)');
  }
}

/**
 * The framework must BE a dependency of the target: everything below it reads
 * the installed version. A `file:` spec is no finding of its own
 * ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)): the deploy
 * snapshot packs every locally linked package into the mirror it pushes, so a
 * local install is exactly what the deploy is built for.
 */
function checkLocality(projectDir) {
  const project = readProject(projectDir);
  const installedVersion = project.devDependencies[package.name] || project.dependencies[package.name];

  if (!installedVersion) {
    throw new Error(`No installed version of ${package.name} found in dependencies or devDependencies.`);
  }
}

/**
 * Make the target whole — idempotent, offline, and quiet when there is
 * nothing to do.
 *
 * @param {object} [options]
 * @param {string} [options.projectDir] - The target root (default: cwd).
 * @param {function} [options.log] - Line logger (silent by default).
 * @param {function} [options.warn] - Warning logger (silent by default).
 * @returns {Promise<{ written: string[], merged: string[], changed: string[] }>}
 *   Target-relative paths per outcome — empty on a no-op run.
 */
async function ensureTarget(options) {
  options = options || {};
  const projectDir = options.projectDir || build.getRootPath('project');
  const log = options.log || (() => {});
  const warn = options.warn || (() => {});
  const result = { written: [], merged: [], changed: [] };

  // The framework's own tree is not a consumer target. Running the framework's
  // suite from packages/desktop puts the framework at the cwd, and a verb that
  // scaffolds unconditionally would install its own peer deps into itself and
  // scatter the consumer defaults through the package. Refuse, quietly: this is
  // a normal state, not a broken one.
  if (readProject(projectDir).name === package.name) {
    return result;
  }

  // A workspace ROOT is not a target either — and unlike the case above, landing
  // there is an accident (a verb run from the wrong cwd), so it fails LOUD (#699).
  assertScaffoldable(projectDir);

  // The Electron-bundled Node major, offline: the framework's pinned runtime.
  // `engines.node` is the honest dev FLOOR (`>=24`), never a version.
  const requiredMajor = version.clean(package.omega.nodeRuntime).split('.')[0];

  // Manifest edits FIRST — they don't depend on the Node version or the peer
  // deps being right, and the consumer needs the postinstall script wired up
  // regardless of what the steps below find.
  setupScripts(projectDir, result);
  ensureNvmrc(projectDir, requiredMajor, result);
  checkNodeVersion(projectDir, requiredMajor, warn);

  await ensurePeerDependencies({ projectDir, package, log, warn });

  const applied = await copyDefaults(projectDir, { log: () => {}, warn, error: warn });
  if (applied) {
    result.written.push(...applied.written);
    result.merged.push(...applied.merged);
  }

  checkLocality(projectDir);

  // Consumer hooks run under plain node outside the bundle, so a framework
  // dependency they never declared resolves only by hoisting: name both fixes.
  nudgeBareRequires({
    root: projectDir,
    srcDir: 'hooks',
    frameworkRoot: build.getRootPath('main'),
    door: (name) => `desktop.require('${name}') after import desktop from '@omega.js/desktop'`,
    warn,
  });

  for (const [label, files] of [['Created', result.written], ['Merged', result.merged], ['Synced', result.changed]]) {
    if (files.length > 0) log(`${label} ${files.join(', ')}`);
  }

  return result;
}

module.exports = { ensureTarget, setupScripts, copyDefaults };
