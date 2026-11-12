// Unit tests for src/ci-workflows.js — brand-monorepo CI composition (#265).
//
// GitHub only executes workflows from the REPO ROOT's .github/workflows/, so a
// per-target `targets/<dir>/.github/workflows/*.yml` scaffolded into a brand monorepo
// is dead on arrival: CI builds and store publishes silently never exist. Setup
// composes the target's workflow into the root dir instead, scoped to the target's
// path, one file per target, regenerated (never duplicated) on every setup.
//
// Each test builds a brand tree under .temp/ programmatically.

const defineCases = require('@omega.js/devkit/test/define-cases');
const path = require('path');
const jetpack = require('fs-jetpack');
const { composeWorkflow, composeTargetWorkflows, composedWorkflowName, composedWorkflowNameFor, reconcileComposedWorkflows, renderInstallWorkspace, FIREWALL_ACTION, FIREWALL_STEP_ID, INSTALL_WORKSPACE_TOKEN, INSTALL_WORKSPACE_FLAG } = require('../src/ci-workflows');

const TEMP = path.join(__dirname, '..', '.temp', `ci-workflows-${process.pid}`);
let caseIndex = 0;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// The web template's two cache steps, each restoring its one cache from the workspace
// root: optimized images keyed on the images' hash, brand images keyed per commit.
const IMAGEMIN_CACHE = /^ {10}path: \$\{\{ github\.workspace \}\}\/\.omega\/cache\/imagemin\n {10}key: omega-imagemin-\$\{\{ hashFiles\(/m;
const BRAND_IMAGE_CACHE = /^ {10}path: \$\{\{ github\.workspace \}\}\/\.omega\/cache\/brand-image\n {10}key: omega-brand-image-\$\{\{ github\.sha \}\}\n {10}restore-keys: \|\n {12}omega-brand-image-$/m;

// A workflow template shaped like the ones the frameworks ship — including the
// `run:` step that executes BEFORE actions/checkout. A fixture that checked out
// first hid the composition bug that killed every composed run on step 1.
const TEMPLATE = `# Deliberate deploys: commits never auto-publish.
name: Build and Publish Extension

on:
  workflow_dispatch:

concurrency:
  group: \${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '22'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Setup git config
        run: |
          git config --global user.name "$GITHUB_ACTOR"

      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Build
        run: npx omega setup && npm run build
`;

// Every workflow template the frameworks actually ship, read from source. The
// composition has to survive THESE, not only the fixture above.
function frameworkTemplates() {
  const packagesDir = path.resolve(__dirname, '..', '..');
  const templates = [];

  for (const pkg of jetpack.list(packagesDir).sort()) {
    if (jetpack.exists(path.join(packagesDir, pkg)) !== 'dir') {
      continue;
    }

    // The two homes a framework keeps its scaffolded workflows in
    for (const defaults of [['src', 'defaults'], ['scaffold']]) {
      const workflowsDir = path.join(packagesDir, pkg, ...defaults, '.github', 'workflows');
      if (jetpack.exists(workflowsDir) !== 'dir') {
        continue;
      }

      for (const name of jetpack.list(workflowsDir).sort()) {
        templates.push({ label: `${pkg}/${name}`, contents: jetpack.read(path.join(workflowsDir, name)) });
      }
    }
  }

  return templates;
}

// The job blocks of a composed workflow (job keys sit at two spaces).
// The one command shape a template may run a framework verb with (#877): the
// framework's own bin FILE, under the workspace root npm hoists it to.
function frameworkBin(framework) {
  return `node "${'${{ github.workspace }}'}/node_modules/@omega.js/${framework}/bin/omega"`;
}

// The install steps of a workflow, the ones that install the TREE. A global
// install (the backend's firebase-tools) names no workspace and is not one.
function installLines(contents) {
  return contents
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /\bnpm(?:\.cmd)? (?:ci|install)\b/.test(line) && !/ -g /.test(line));
}

function jobBlocks(composed) {
  return composed
    .slice(composed.indexOf('\njobs:\n'))
    .split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/)
    .slice(1);
}

// Stage a brand root with `targets/<name>/.github/workflows/<file>` sources.
function stageBrand(targets) {
  const brandRoot = path.join(TEMP, `case-${caseIndex++}`);
  jetpack.write(path.join(brandRoot, 'package.json'), '{ "name": "brand" }');

  const staged = {};
  for (const [name, workflows] of Object.entries(targets)) {
    const targetDir = path.join(brandRoot, 'targets', name);
    const sourceDir = path.join(targetDir, '__defaults', '.github', 'workflows');
    for (const [file, contents] of Object.entries(workflows)) {
      jetpack.write(path.join(sourceDir, file), contents);
    }
    staged[name] = { targetDir, sourceDir };
  }

  return { brandRoot, targets: staged };
}

const rootWorkflow = (brandRoot, file) => path.join(brandRoot, '.github', 'workflows', file);

module.exports = defineCases({
  type: 'group',
  description: 'ci-workflows',
  tests: [
    {
      name: 'composeWorkflow: scopes the run to the target, keeps the workflow itself intact',
      run: (ctx) => {
        const composed = composeWorkflow(TEMPLATE, { targetPath: 'targets/extension', targetName: 'extension' });

        // Says where it came from and that setup owns it
        ctx.expect(composed).toMatch(/omega setup/);
        ctx.expect(composed).toMatch(/targets\/extension/);

        // Every `run:` step AFTER the checkout executes in the target dir — the whole
        // point of composing
        ctx.expect(composed).toMatch(/ {6}- name: Build\n {8}working-directory: targets\/extension\n {8}run: npx omega setup && npm run build\n/);

        // …and the step that runs BEFORE the checkout is left at the repo root: the
        // target dir does not exist yet, so scoping it kills the job on step 1
        ctx.expect(composed).toMatch(/ {6}- name: Setup git config\n {8}run: \|\n/);

        // No workflow-level default — it would scope those pre-checkout steps too
        ctx.expect(composed).not.toMatch(/^defaults:/m);

        // Per-target identity: two targets' runs never cancel each other, and the
        // Actions list shows which target a run belongs to
        ctx.expect(composed).toMatch(/^name: Build and Publish Extension \(targets\/extension\)$/m);
        ctx.expect(composed).toMatch(/^ {2}group: extension-\$\{\{ github\.ref \}\}$/m);

        // The workflow's own content is carried over verbatim
        ctx.expect(composed).toMatch(/uses: actions\/checkout@v4/);
        ctx.expect(composed).toMatch(/run: npx omega setup && npm run build/);
        ctx.expect(composed).toMatch(/^ {2}workflow_dispatch:$/m);
      },
    },

    {
      name: 'the REAL framework templates: nothing before a job\'s checkout is scoped to the target dir',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length > 0, 'no framework workflow templates found — the pin would be vacuous').toBeTruthy();

        for (const template of templates) {
          const composed = composeWorkflow(template.contents, { targetPath: 'targets/extension', targetName: 'extension' });
          const scoped = 'working-directory: targets/extension';

          // A workflow-level default applies to every job, including the ones that
          // run a command before (or entirely without) a checkout
          ctx.expect(composed, template.label).not.toMatch(/^defaults:/m);

          for (const job of jobBlocks(composed)) {
            if (!job.includes(scoped)) {
              continue;
            }

            const checkout = job.indexOf('uses: actions/checkout');
            ctx.expect(checkout, `${template.label}: a job with no checkout scopes a step to a dir it never creates`).not.toBe(-1);
            ctx.expect(checkout < job.indexOf(scoped), `${template.label}: a step before the checkout is scoped to a dir that does not exist yet`).toBeTruthy();
          }
        }
      },
    },

    // `repository_dispatch` names an event TYPE, never a ref, so such a run checks
    // out the DEFAULT branch, which since #915 never carries the deploy tree.
    // Nothing in OMEGA ever sent one (devkit's `dispatchWorkflow` posts
    // `workflow_dispatch` only), so the trigger is gone from every template and
    // `workflow_dispatch` at ref `omega-deploy` is the one way in (#923).
    {
      name: 'the REAL framework templates: workflow_dispatch is the only dispatch trigger (#923)',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length > 0, 'no framework workflow templates found, so the pin would be vacuous').toBeTruthy();

        for (const template of templates) {
          ctx.expect(template.contents, `${template.label}: the manual dispatch is the one way in`).toMatch(/^on:\n {2}workflow_dispatch:$/m);
          ctx.expect(template.contents, `${template.label}: a repository_dispatch run checks out the default branch, which never carries the deploy tree`).not.toMatch(/repository_dispatch/);
        }
      },
    },

    {
      name: 'the REAL extension template: the git config step stays at the root, the build step runs in the target',
      run: (ctx) => {
        const template = frameworkTemplates().find((entry) => entry.label === 'extension/publish.yml');
        ctx.expect(template, 'the extension publish template is missing').toBeTruthy();

        const composed = composeWorkflow(template.contents, { targetPath: 'targets/extension', targetName: 'extension' });

        // Step 1 of the shipped template: a `run:` before actions/checkout
        ctx.expect(composed).toMatch(/ {6}- name: Setup git config\n {8}run: \|\n/);

        // Post-checkout `run:` steps carry the scope, in both YAML shapes, and the
        // install is scoped a second way, to this target's workspace alone (#898).
        ctx.expect(composed).toMatch(/ {6}- name: Install dependencies\n {8}working-directory: targets\/extension\n {8}run: sfw npm ci --workspace \.\n/);
        ctx.expect(composed).toMatch(/ {6}- name: Build and publish extension\n {8}working-directory: targets\/extension\n {8}run: \|\n/);

        // `uses:` steps are never scoped: checkout and friends want the repo root.
        // The version is left open here: the pin itself is one test's job (#880).
        ctx.expect(composed).toMatch(/ {6}- name: Checkout repository\n {8}uses: actions\/checkout@\S+\n/);
        ctx.expect(composed).toMatch(/ {6}- name: Setup Node\.js\n {8}uses: actions\/setup-node@\S+\n/);
      },
    },

    {
      name: 'the REAL templates: no hashFiles() pattern is left pointing at the repo root',
      run: (ctx) => {
        for (const template of frameworkTemplates()) {
          const composed = composeWorkflow(template.contents, { targetPath: 'targets/extension', targetName: 'extension' });

          for (const [, pattern] of composed.matchAll(/hashFiles\(\s*['"]([^'"]+)['"]/g)) {
            // hashFiles() globs from GITHUB_WORKSPACE whatever step it sits in — a
            // root-relative pattern in a composed target workflow hashes nothing
            ctx.expect(pattern.startsWith('targets/extension/'), `${template.label}: hashFiles('${pattern}') never sees the target`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'the REAL web template: the cache key is target-scoped, and the cache path stays at the workspace root',
      run: (ctx) => {
        const template = frameworkTemplates().find((entry) => entry.label === 'web/build.yml');
        ctx.expect(template, 'the web build template is missing').toBeTruthy();

        const composed = composeWorkflow(template.contents, { targetPath: 'targets/web', targetName: 'web' });

        // The build writes its image caches under the BRAND root, which is the runner's
        // workspace, so the path lines stay the standalone ones, with no target prefix
        ctx.expect(composed).toMatch(IMAGEMIN_CACHE);
        ctx.expect(composed).toMatch(BRAND_IMAGE_CACHE);

        // `working-directory:` is a `run:` key: an action's inputs ignore it, so the
        // key's hash still has to name the target's images itself
        ctx.expect(composed).toMatch(/hashFiles\('targets\/web\/src\/assets\/images\/\*\*'\)/);

        // The publish is the framework's own verb since #883, a plain `run:` step
        // that `working-directory:` scopes like any other: no third-party action, so
        // no `publish_dir` for the table to rewrite.
        ctx.expect(composed).not.toMatch(/peaceiris|publish_dir/);

        // A standalone project IS the repo root: the scaffolded template is unchanged,
        // scoping belongs to composition alone
        ctx.expect(template.contents).toMatch(IMAGEMIN_CACHE);
        ctx.expect(template.contents).toMatch(BRAND_IMAGE_CACHE);
        ctx.expect(template.contents).not.toMatch(/targets\//);
      },
    },

    {
      name: 'the REAL desktop template: artifact paths ride the target dir, in both YAML shapes',
      run: (ctx) => {
        const template = frameworkTemplates().find((entry) => entry.label === 'desktop/build.yml');
        ctx.expect(template, 'the desktop build template is missing').toBeTruthy();

        const composed = composeWorkflow(template.contents, { targetPath: 'targets/desktop', targetName: 'desktop' });

        // upload-artifact's `path:` is a block scalar — every line is a repo-root glob
        ctx.expect(composed).toMatch(/^ {12}targets\/desktop\/release\/\*\.exe$/m);
        ctx.expect(composed).toMatch(/^ {12}targets\/desktop\/release\/\*\.yml$/m);
        ctx.expect(composed).toMatch(/^ {12}targets\/desktop\/release\/\*\.blockmap$/m);

        // download-artifact lands where the (target-scoped) signing run step looks
        ctx.expect(composed).toMatch(/^ {10}path: targets\/desktop\/release$/m);
        ctx.expect(composed).toMatch(/^ {10}name: windows-unsigned$/m);

        // the unsigned upload is an in-run intermediate: kept one day, not GitHub's 90 (#939)
        ctx.expect(composed).toMatch(/^ {10}retention-days: 1$/m);

        // checkout's own inputs are never rewritten — they are not paths in the tree
        // (the depth itself went shallow in #880; the point here is that composition
        // leaves it alone)
        ctx.expect(composed).toMatch(/^ {10}fetch-depth: 1$/m);
      },
    },

    {
      name: 'the REAL extension template: a target with no path-bearing action inputs is unchanged beyond its run steps',
      run: (ctx) => {
        const template = frameworkTemplates().find((entry) => entry.label === 'extension/publish.yml');
        const composed = composeWorkflow(template.contents, { targetPath: 'targets/extension', targetName: 'extension' });

        ctx.expect(composed).not.toMatch(/^ {8}(?:path|publish_dir):/m);
        ctx.expect(composed.match(/targets\/extension/g).length).toBe(composed.match(/working-directory: targets\/extension/g).length + 3); // + the 3 header lines
      },
    },

    {
      name: 'the sweep is unaffected: the target copy of a REAL template still compares byte-equal',
      run: (ctx) => {
        const template = frameworkTemplates().find((entry) => entry.label === 'web/build.yml');
        const { brandRoot, targets } = stageBrand({ web: { 'build.yml': template.contents } });

        // What a prior target-level scaffold wrote: the framework template, untouched.
        // Scoping happens at COMPOSE time, so this still matches and is still swept —
        // a token rendered into the template would have made every dead copy "differ".
        jetpack.write(path.join(targets.web.targetDir, '.github', 'workflows', 'build.yml'), template.contents);

        const warnings = [];
        const result = composeTargetWorkflows({
          sourceDir: targets.web.sourceDir,
          targetDir: targets.web.targetDir,
          brandRoot,
          logger: { ...quiet, warn: (message) => warnings.push(message) },
        });

        ctx.expect(result.removed).toEqual(['.github/workflows/build.yml']);
        ctx.expect(warnings).toEqual([]);
        ctx.expect(jetpack.exists(path.join(targets.web.targetDir, '.github'))).toBe(false);
      },
    },

    {
      name: 'two-target monorepo: one root workflow per target, each scoped to its own dir',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({
          extension: { 'publish.yml': TEMPLATE },
          web: { 'build.yml': TEMPLATE.replace('Build and Publish Extension', 'Compile and Build Site') },
        });

        for (const name of ['extension', 'web']) {
          composeTargetWorkflows({
            sourceDir: targets[name].sourceDir,
            targetDir: targets[name].targetDir,
            brandRoot,
            logger: quiet,
          });
        }

        const composedFiles = jetpack.list(path.join(brandRoot, '.github', 'workflows')).sort();
        ctx.expect(composedFiles).toEqual(['extension-publish.yml', 'web-build.yml']);

        const extension = jetpack.read(rootWorkflow(brandRoot, 'extension-publish.yml'));
        const web = jetpack.read(rootWorkflow(brandRoot, 'web-build.yml'));
        ctx.expect(extension).toMatch(/working-directory: targets\/extension/);
        ctx.expect(web).toMatch(/working-directory: targets\/web/);
        ctx.expect(extension).toMatch(/group: extension-/);
        ctx.expect(web).toMatch(/group: web-/);

        // No per-target .github/ in a monorepo — GitHub would never run it
        ctx.expect(jetpack.exists(path.join(targets.extension.targetDir, '.github'))).toBe(false);
        ctx.expect(jetpack.exists(path.join(targets.web.targetDir, '.github'))).toBe(false);
      },
    },

    {
      name: 'idempotent: re-running setup updates the target\'s file and never duplicates',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({ extension: { 'publish.yml': TEMPLATE } });
        const compose = () => composeTargetWorkflows({
          sourceDir: targets.extension.sourceDir,
          targetDir: targets.extension.targetDir,
          brandRoot,
          logger: quiet,
        });

        const first = compose();
        ctx.expect(first.written).toEqual(['.github/workflows/extension-publish.yml']);

        const contents = jetpack.read(rootWorkflow(brandRoot, 'extension-publish.yml'));

        // Second run: identical content is not a write, and nothing is appended twice
        const second = compose();
        ctx.expect(second.written).toEqual([]);
        ctx.expect(second.skipped).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.read(rootWorkflow(brandRoot, 'extension-publish.yml'))).toBe(contents);
        ctx.expect(contents.match(/working-directory:/g).length).toBe(1);
        ctx.expect(contents.match(/^name:/gm).length).toBe(1);
        ctx.expect(jetpack.list(path.join(brandRoot, '.github', 'workflows')).length).toBe(1);

        // A changed template updates the composed file in place
        jetpack.write(path.join(targets.extension.sourceDir, 'publish.yml'), TEMPLATE.replace('ubuntu-latest', 'ubuntu-24.04'));
        const third = compose();
        ctx.expect(third.written).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.read(rootWorkflow(brandRoot, 'extension-publish.yml'))).toMatch(/ubuntu-24\.04/);
        ctx.expect(jetpack.list(path.join(brandRoot, '.github', 'workflows')).length).toBe(1);
      },
    },

    {
      name: 'sweeps the dead per-target copy, keeps one the consumer edited',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({
          extension: { 'publish.yml': TEMPLATE },
          web: { 'build.yml': TEMPLATE },
        });

        // What a prior setup scaffolded into the target dirs: one untouched, one edited
        const deadCopy = path.join(targets.extension.targetDir, '.github', 'workflows', 'publish.yml');
        const editedCopy = path.join(targets.web.targetDir, '.github', 'workflows', 'build.yml');
        jetpack.write(deadCopy, TEMPLATE);
        jetpack.write(editedCopy, `${TEMPLATE}      - name: My own step\n        run: echo hi\n`);

        const warnings = [];
        const logger = { ...quiet, warn: (message) => warnings.push(message) };

        const extension = composeTargetWorkflows({ sourceDir: targets.extension.sourceDir, targetDir: targets.extension.targetDir, brandRoot, logger });
        const web = composeTargetWorkflows({ sourceDir: targets.web.sourceDir, targetDir: targets.web.targetDir, brandRoot, logger });

        // Framework-owned: deleted, and the empty .github/ goes with it
        ctx.expect(jetpack.exists(deadCopy)).toBe(false);
        ctx.expect(jetpack.exists(path.join(targets.extension.targetDir, '.github'))).toBe(false);
        ctx.expect(extension.removed).toEqual(['.github/workflows/publish.yml']);

        // Consumer content is NEVER destroyed — it is reported instead
        ctx.expect(jetpack.exists(editedCopy)).toBe('file');
        ctx.expect(web.removed).toEqual([]);
        ctx.expect(warnings.length).toBe(1);
        ctx.expect(warnings[0]).toMatch(/targets\/web\/\.github\/workflows\/build\.yml/);
        // A kept copy carries lines the current template does not ship, which is all
        // the compare can prove, so the warning never claims edits by name; it does
        // name the composed file to compare against
        ctx.expect(warnings[0]).not.toMatch(/your own edits/);
        ctx.expect(warnings[0]).toMatch(/differs from the current .*template/);
        ctx.expect(warnings[0]).toMatch(/\.github\/workflows\/web-build\.yml/);
      },
    },

    {
      name: 'sweeps a copy left by a superseded template, keeps one that changed a line',
      run: (ctx) => {
        // What #189 did to the shipped web template: it GAINED a generated block, so
        // every copy a prior setup wrote is now a strict subset of what the template
        // renders today ([#334](https://github.com/Omega-JS-Stack/omega/issues/334)).
        const current = TEMPLATE.replace(
          `  NODE_VERSION: '22'\n`,
          `  NODE_VERSION: '22'\n  # Generated from the brand's .env cascade by \`omega setup\`.\n  API_KEY: \${{ secrets.API_KEY }}\n`,
        );

        const { brandRoot, targets } = stageBrand({
          extension: { 'publish.yml': current },
          web: { 'build.yml': current },
        });

        // One copy is the superseded generation verbatim; the other CHANGED a line
        // the framework wrote, which no template of this framework ever shipped
        const supersededCopy = path.join(targets.extension.targetDir, '.github', 'workflows', 'publish.yml');
        const editedCopy = path.join(targets.web.targetDir, '.github', 'workflows', 'build.yml');
        jetpack.write(supersededCopy, TEMPLATE);
        jetpack.write(editedCopy, current.replace('ubuntu-latest', 'ubuntu-24.04'));

        const warnings = [];
        const logger = { ...quiet, warn: (message) => warnings.push(message) };

        const extension = composeTargetWorkflows({ sourceDir: targets.extension.sourceDir, targetDir: targets.extension.targetDir, brandRoot, logger });
        const web = composeTargetWorkflows({ sourceDir: targets.web.sourceDir, targetDir: targets.web.targetDir, brandRoot, logger });

        // The superseded copy is framework-owned: swept, empty .github/ pruned with it
        ctx.expect(jetpack.exists(supersededCopy)).toBe(false);
        ctx.expect(jetpack.exists(path.join(targets.extension.targetDir, '.github'))).toBe(false);
        ctx.expect(extension.removed).toEqual(['.github/workflows/publish.yml']);

        // The changed line is content no framework template wrote: kept and warned
        ctx.expect(jetpack.exists(editedCopy)).toBe('file');
        ctx.expect(web.removed).toEqual([]);
        ctx.expect(warnings.length).toBe(1);
        ctx.expect(warnings[0]).toMatch(/targets\/web\/\.github\/workflows\/build\.yml/);
      },
    },

    {
      name: 'composedWorkflowName: the root name in a monorepo, the plain name standalone',
      run: (ctx) => {
        ctx.expect(composedWorkflowName({
          targetDir: '/brand/targets/extension',
          brandRoot: '/brand',
          workflow: 'publish.yml',
        })).toBe('extension-publish.yml');

        ctx.expect(composedWorkflowName({
          targetDir: '/standalone-extension',
          brandRoot: null,
          workflow: 'publish.yml',
        })).toBe('publish.yml');

        // The TARGET DIR prefixes the name, not the framework: a `web` target and
        // desktop's `desktop` both ship a `build.yml`, and the two composed files sit
        // side by side at the brand root. Desktop's release/deploy verbs read this
        // name too (#799).
        ctx.expect(composedWorkflowName({
          targetDir: '/brand/targets/desktop',
          brandRoot: '/brand',
          workflow: 'build.yml',
        })).toBe('desktop-build.yml');

        ctx.expect(composedWorkflowName({
          targetDir: '/brand/targets/web',
          brandRoot: '/brand',
          workflow: 'build.yml',
        })).toBe('web-build.yml');

        ctx.expect(composedWorkflowName({
          targetDir: '/standalone-desktop-app',
          brandRoot: null,
          workflow: 'build.yml',
        })).toBe('build.yml');
      },
    },

    // P4: a caller that holds a target NAME and no path (the backend's CMS deploy
    // dispatch reads the target off a request, on a machine with no checkout) used
    // to pass the bare name as a `targetDir` with a fake `brandRoot: '.'` and rely
    // on `path.basename` handing it back. The rule is one function either way.
    {
      name: 'composedWorkflowNameFor: the same name from a bare target name, and the path form is built on it',
      run: (ctx) => {
        ctx.expect(composedWorkflowNameFor('web', 'build.yml')).toBe('web-build.yml');
        ctx.expect(composedWorkflowNameFor('community', 'build.yml')).toBe('community-build.yml');

        ctx.expect(composedWorkflowName({ targetDir: '/brand/targets/community', brandRoot: '/brand', workflow: 'build.yml' }), 'the path form is the name form plus a basename, never a second spelling').toBe(composedWorkflowNameFor('community', 'build.yml'));
      },
    },

    {
      name: 'a transform hook renders the template before composing (site tokens)',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({
          extension: { 'publish.yml': TEMPLATE.replace(`'22'`, `'[versions.node]'`) },
        });

        composeTargetWorkflows({
          sourceDir: targets.extension.sourceDir,
          targetDir: targets.extension.targetDir,
          brandRoot,
          transform: (contents) => contents.replace('[versions.node]', '22'),
          logger: quiet,
        });

        const composed = jetpack.read(rootWorkflow(brandRoot, 'extension-publish.yml'));
        ctx.expect(composed).toMatch(/NODE_VERSION: '22'/);
        ctx.expect(composed.includes('[versions.node]')).toBe(false);
      },
    },

    // ─── Reconcile: a dropped target's composed files go (#636) ──────────────────

    {
      name: 'reconcile: a target the config no longer enables loses its composed files',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({
          extension: { 'publish.yml': TEMPLATE },
          web: { 'build.yml': TEMPLATE.replace('Build and Publish Extension', 'Compile and Build Site') },
        });
        for (const name of ['extension', 'web']) {
          composeTargetWorkflows({ sourceDir: targets[name].sourceDir, targetDir: targets[name].targetDir, brandRoot, logger: quiet });
        }

        // `targets.extension` is deleted from omega.json5 — the dir may well still be
        // on disk, but the brand no longer enables it
        const result = reconcileComposedWorkflows({ brandRoot, liveTargets: ['web'], logger: quiet });

        ctx.expect(result.removed).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.list(path.join(brandRoot, '.github', 'workflows')).sort()).toEqual(['web-build.yml']);
      },
    },

    {
      name: 'reconcile: a human-authored workflow with a colliding name is NEVER deleted',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({ extension: { 'publish.yml': TEMPLATE } });
        composeTargetWorkflows({ sourceDir: targets.extension.sourceDir, targetDir: targets.extension.targetDir, brandRoot, logger: quiet });

        // The brand's own file, named exactly the composed way but written by a human:
        // no GENERATED header, so the first lock never opens
        const handWritten = `name: Extension smoke tests\n\non:\n  workflow_dispatch:\n`;
        jetpack.write(rootWorkflow(brandRoot, 'extension-smoke.yml'), handWritten);
        // …and one that is not named the composed way at all
        jetpack.write(rootWorkflow(brandRoot, 'release.yml'), handWritten);

        const result = reconcileComposedWorkflows({ brandRoot, liveTargets: [], logger: quiet });

        ctx.expect(result.removed).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.read(rootWorkflow(brandRoot, 'extension-smoke.yml'))).toBe(handWritten);
        ctx.expect(jetpack.read(rootWorkflow(brandRoot, 'release.yml'))).toBe(handWritten);
      },
    },

    {
      name: 'reconcile: an enabled target keeps its files, and a rerun is a no-op',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({ extension: { 'publish.yml': TEMPLATE } });
        composeTargetWorkflows({ sourceDir: targets.extension.sourceDir, targetDir: targets.extension.targetDir, brandRoot, logger: quiet });

        ctx.expect(reconcileComposedWorkflows({ brandRoot, liveTargets: ['extension'], logger: quiet }).removed).toEqual([]);
        ctx.expect(jetpack.exists(rootWorkflow(brandRoot, 'extension-publish.yml'))).toBe('file');

        // Set → unset → rerun: the drop removes once, the next walk finds nothing left
        ctx.expect(reconcileComposedWorkflows({ brandRoot, liveTargets: [], logger: quiet }).removed).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(reconcileComposedWorkflows({ brandRoot, liveTargets: [], logger: quiet }).removed).toEqual([]);
      },
    },

    {
      name: 'reconcile: a dry run names the files and deletes nothing',
      run: (ctx) => {
        const { brandRoot, targets } = stageBrand({ extension: { 'publish.yml': TEMPLATE } });
        composeTargetWorkflows({ sourceDir: targets.extension.sourceDir, targetDir: targets.extension.targetDir, brandRoot, logger: quiet });

        const result = reconcileComposedWorkflows({ brandRoot, liveTargets: [], dryRun: true, logger: quiet });

        ctx.expect(result.removed).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.exists(rootWorkflow(brandRoot, 'extension-publish.yml'))).toBe('file');
      },
    },

    {
      name: 'reconcile: a composed file carrying the LEGACY header is still recognised',
      run: (ctx) => {
        const { brandRoot } = stageBrand({});

        // What a target dropped BEFORE this wave left behind: composed by the old
        // `omega setup` wording, never rewritten since — the exact case the reconcile
        // exists for
        const legacy = `# GENERATED by \`omega setup\` for targets/extension \u2014 do not edit.\n${TEMPLATE}`;
        jetpack.write(rootWorkflow(brandRoot, 'extension-publish.yml'), legacy);
        // …and a human file in the same dir, which no header lock ever opens
        const handWritten = `name: Extension smoke tests\n\non:\n  workflow_dispatch:\n`;
        jetpack.write(rootWorkflow(brandRoot, 'extension-smoke.yml'), handWritten);

        const result = reconcileComposedWorkflows({ brandRoot, liveTargets: ['web'], logger: quiet });

        ctx.expect(result.removed).toEqual(['.github/workflows/extension-publish.yml']);
        ctx.expect(jetpack.exists(rootWorkflow(brandRoot, 'extension-publish.yml'))).toBe(false);
        ctx.expect(jetpack.read(rootWorkflow(brandRoot, 'extension-smoke.yml'))).toBe(handWritten);
      },
    },

    {
      name: 'reconcile: a brand with no .github/workflows dir is a clean no-op',
      run: (ctx) => {
        const { brandRoot } = stageBrand({});

        ctx.expect(reconcileComposedWorkflows({ brandRoot, liveTargets: [], logger: quiet })).toEqual({ removed: [] });
      },
    },

    {
      name: 'the {{ installFirewall }} token renders the pinned action and its cmd shim, at the token\'s own indentation (#872)',
      run: (ctx) => {
        const template = [
          'name: Build',
          '',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      {{ installFirewall }}',
          '      - name: Install dependencies',
          '        run: sfw npm ci',
          '',
        ].join('\n');

        const composed = composeWorkflow(template, { targetPath: 'targets/web', targetName: 'web' });
        const binary = `\\$\\{\\{ steps\\.${FIREWALL_STEP_ID}\\.outputs\\.firewall-path-binary \\}\\}`;

        // Both steps land where the token stood, spelled as list items at its indent.
        // The shim is the Windows half: the action caches an EXTENSION-LESS `sfw` and
        // cmd.exe cannot run one, so a copy named `sfw.exe` goes beside it (#872).
        ctx.expect(composed).toMatch(new RegExp([
          '      - uses: actions/checkout@v4\\n',
          '(?:      #[^\\n]*\\n)*',
          '      - name: [^\\n]+\\n',
          `        id: ${FIREWALL_STEP_ID}\\n`,
          `        uses: ${FIREWALL_ACTION.replace('/', '\\/')}\\n`,
          '        with:\\n',
          '          mode: firewall-free\\n',
          '(?:      #[^\\n]*\\n)*',
          '      - name: [^\\n]+\\n',
          "        if: runner\\.os == 'Windows'\\n",
          '        shell: cmd\\n',
          // The shim is a `run:` step, so the composition scopes it like any other:
          // harmless, because the path it copies is the absolute one the action reports
          '        working-directory: targets/web\\n',
          `        run: copy "${binary}" "${binary}\\.exe"\\n`,
          '      - name: Install dependencies\\n',
        ].join('')));

        // No token survives, and no template ever names the action itself
        ctx.expect(composed).not.toMatch(/\{\{ installFirewall \}\}/);
        ctx.expect(template).not.toMatch(/SocketDev/);

        // A `uses:` step is never scoped to the target: the action runs at the root
        ctx.expect(composed).not.toMatch(/uses: SocketDev\/action@[^\n]*\n\s+working-directory:/);
        // ...while the install it wraps still is
        ctx.expect(composed).toMatch(/working-directory: targets\/web\n\s+run: sfw npm ci/);
      },
    },

    {
      name: 'a template carrying no token is left exactly as it was (#872)',
      run: (ctx) => {
        const template = 'name: Build\n\njobs:\n  build:\n    steps:\n      - run: echo hi\n';

        ctx.expect(composeWorkflow(template, { targetPath: 'targets/web', targetName: 'web' }).includes('SocketDev')).toBe(false);
      },
    },

    {
      name: 'the REAL templates: every firewalled install job gets its binary from the pinned official action (#871)',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length, 'no framework template found').toBeTruthy();

        for (const template of templates) {
          // The npm launcher fetches the binary through GitHub's ANONYMOUS API and a
          // hosted runner's shared address exhausts that quota; the action downloads
          // with the job's own token. And no template quietly installs unfirewalled.
          ctx.expect(template.contents, `${template.label}: installs the firewall through npm`).not.toMatch(/npm install -g sfw/);
          ctx.expect(template.contents, `${template.label}: falls back to an unfirewalled install`).not.toMatch(/falling back to plain npm/);

          const composed = composeWorkflow(template.contents, { targetPath: 'targets/extension', targetName: 'extension' });
          for (const job of jobBlocks(composed)) {
            // `npm.cmd` is the Windows spelling (#872): the firewall resolves the command
            // literally, with no PATHEXT, so a cmd-shelled leg names the file it wants.
            const install = job.search(/\bsfw npm(?:\.cmd)? (ci|install)\b/);
            if (install === -1) {
              continue;
            }

            const action = job.search(/uses: SocketDev\/action@v\d+\.\d+\.\d+\n\s+with:\n\s+mode: firewall-free\n/);
            ctx.expect(action, `${template.label}: a job runs sfw without installing it through the pinned action`).not.toBe(-1);
            ctx.expect(action < install, `${template.label}: the firewall is installed after the install it wraps`).toBeTruthy();
            // A `uses:` step is never scoped to the target: the action runs at the root
            ctx.expect(job, `${template.label}: the action step was scoped`).not.toMatch(/uses: SocketDev\/action@[^\n]*\n\s+working-directory:/);

            // And the Windows shim rides along on EVERY template (#872): a job that
            // forces `shell: cmd` (the desktop build does) cannot execute the
            // extension-less `sfw` the action caches on Windows. The `if` makes the
            // step a no-op on the other runners.
            const shim = job.search(new RegExp(`run: copy "\\$\\{\\{ steps\\.${FIREWALL_STEP_ID}\\.outputs\\.firewall-path-binary \\}\\}"`));
            ctx.expect(shim, `${template.label}: the firewall is installed without the Windows cmd shim`).not.toBe(-1);
            ctx.expect(action < shim && shim < install, `${template.label}: the shim does not sit between the action and the install it wraps`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'the REAL templates: a framework verb runs THIS framework\'s own bin file by path, and no step runs npx ([#877](https://github.com/Omega-JS-Stack/omega/issues/877))',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length, 'no framework template found').toBeTruthy();

        for (const template of templates) {
          // Comments are allowed to NAME a command a human types on a laptop; steps
          // are not: this reads the executable lines only.
          const framework = template.label.split('/')[0];
          const lines = template.contents.split('\n').filter((line) => !/^\s*#/.test(line));
          const steps = lines.join('\n');

          // npx is gone entirely (#877): `npx omega` on a runner that linked no
          // shared bin falls through to the npm REGISTRY (the playground's first
          // backend deploy ran a stranger's package with every secret in the job
          // env), and `npx --no-install omega-<framework>` needed a per-framework bin
          // that no longer exists.
          ctx.expect(steps, `${template.label}: a step runs npx, which can reach the registry`).not.toMatch(/\bnpx\b/);
          ctx.expect(steps, `${template.label}: names a removed per-framework bin`).not.toMatch(/\bomega-(backend|web|desktop|extension)\b/);

          // What it runs instead: the framework's own bin FILE. Which package won
          // npm's shared-bin link is an install-order accident, so nothing here
          // resolves a name, and the path is anchored at the workspace root because
          // npm hoists a workspace's dependencies there, out of reach of the
          // `./node_modules` a target-scoped step would see (#877, #898).
          const invocations = lines.filter((line) => line.includes('bin/omega'));
          ctx.expect(invocations.length, `${template.label}: runs no framework verb at all`).toBeTruthy();

          for (const line of invocations) {
            ctx.expect(line.includes(frameworkBin(framework)), `${template.label}: \`${line.trim()}\` does not run ${framework}'s own bin by path (${frameworkBin(framework)})`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'the REAL templates: every install names the ONE workspace token, and composition installs only this target ([#898](https://github.com/Omega-JS-Stack/omega/issues/898))',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length, 'no framework template found').toBeTruthy();

        for (const template of templates) {
          for (const line of installLines(template.contents)) {
            // One token, rendered from ONE devkit constant, so no template hand-types
            // a target path (a brand names its targets what it likes, #886).
            ctx.expect(line.trim().endsWith(INSTALL_WORKSPACE_TOKEN), `${template.label}: \`${line.trim()}\` installs without the ${INSTALL_WORKSPACE_TOKEN} token`).toBeTruthy();
          }

          // Composed into a brand root, every install is scoped to the target the job
          // belongs to: at the brand root npm installs EVERY target's workspace, and
          // the desktop job on Electron's node then installed the backend workspace
          // whose engines.node is the Firebase pin (#898). `.` is the target dir
          // itself: npm resolves --workspace against the cwd, and every composed run
          // step already carries `working-directory: targets/<name>`.
          const composed = composeWorkflow(template.contents, { targetPath: 'targets/thing', targetName: 'thing' });
          for (const line of installLines(composed)) {
            ctx.expect(line.trim().endsWith(INSTALL_WORKSPACE_FLAG), `${template.label}: composed, \`${line.trim()}\` installs the whole brand root`).toBeTruthy();
          }

          // A STANDALONE target is its own repo root and declares no workspaces at
          // all, so the flag would refuse the install ("No workspaces found"). The
          // same renderer writes that copy, with the token and its space removed.
          const standalone = renderInstallWorkspace(template.contents);
          ctx.expect(standalone, `${template.label}: a standalone copy keeps the raw token`).not.toMatch(/\{\{ installWorkspace \}\}/);
          ctx.expect(standalone, `${template.label}: a standalone copy passes --workspace, which has no workspaces to name`).not.toMatch(/--workspace/);
          for (const line of installLines(standalone)) {
            ctx.expect(line, `${template.label}: standalone, \`${line.trim()}\` is not a plain \`npm ci\``).toMatch(/npm(?:\.cmd)? ci$/);
          }
        }
      },
    },

    // One install step on every lane
    // ([#938](https://github.com/Omega-JS-Stack/omega/issues/938)): the runner
    // installs the brand's lockfile as pushed, `npm ci`, on all four frameworks.
    // `npm install` re-resolves around a stale lock instead of refusing it, which
    // is how web deployed off local-era link entries while desktop refused them.
    {
      name: 'the REAL templates: all four install with `npm ci`, composed as `sfw npm ci --workspace .` (#938)',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length, `expected the four framework templates, found ${templates.map((t) => t.label).join(', ')}`).toBe(4);

        for (const template of templates) {
          const composed = composeWorkflow(template.contents, { targetPath: 'targets/thing', targetName: 'thing' });
          const lines = installLines(composed).map((line) => line.trim().replace(/^(?:- )?run: /, ''));

          ctx.expect(lines.includes('sfw npm ci --workspace .'), `${template.label}: no \`sfw npm ci --workspace .\` install (got ${JSON.stringify(lines)})`).toBeTruthy();
          for (const line of lines) {
            // The cmd-shelled Windows legs spell it npm.cmd, and the self-hosted
            // signing box installs without the firewall (see deploys.md); still `ci`.
            ctx.expect(line, `${template.label}: \`${line}\` is not \`npm ci\``).toMatch(/^(?:sfw )?npm(?:\.cmd)? ci --workspace \.$/);
          }
        }
      },
    },

    // One action version across all four templates
    // ([#880](https://github.com/Omega-JS-Stack/omega/issues/880)): every runner
    // checks out and sets up node with the same two actions, so four templates
    // drifting apart is four upgrades to remember instead of one. The majors are
    // hard-coded on purpose: a pin read off the templates themselves would agree
    // with whatever they happen to say.
    {
      name: 'the REAL templates: all four pin the SAME actions/checkout and actions/setup-node (#880)',
      run: (ctx) => {
        const EXPECTED = { 'actions/checkout': 'v7', 'actions/setup-node': 'v7' };
        const templates = frameworkTemplates();
        // The four frameworks, and a fifth would join this pin the day it scaffolds one
        ctx.expect(templates.length, `expected the four framework templates, found ${templates.map((t) => t.label).join(', ')}`).toBe(4);

        for (const { label, contents } of templates) {

          for (const [action, version] of Object.entries(EXPECTED)) {
            const pinned = [...new Set([...contents.matchAll(new RegExp(`uses: ${action}@(\\S+)`, 'g'))].map(([, found]) => found))];
            // Empty means the template uses the action not at all, which is the same
            // defect from the other side: every one of the four does both.
            ctx.expect(pinned, `${label}: ${action} is pinned to [${pinned.join(', ')}], not the one ${version} all four share`).toEqual([version]);
          }
        }
      },
    },

    // A composed step runs in the target dir, where the target's framework owns every
    // verb it runs, so no template carries an env marker to let the bin through.
    {
      name: 'the REAL templates: no workflow carries a root-dispatch marker',
      run: (ctx) => {
        const templates = frameworkTemplates();
        ctx.expect(templates.length, `expected the four framework templates, found ${templates.map((t) => t.label).join(', ')}`).toBe(4);

        for (const { label, contents } of templates) {
          ctx.expect(contents.includes('OMEGA_ROOT_DISPATCH'), `${label}: the workflow still sets the root-dispatch marker`).toBe(false);
        }
      },
    },

    // A composed workflow lands in the consumer's repo, whose own guard may refuse
    // an em dash: neither the composer's header nor the web template may carry one.
    {
      name: 'a composed workflow carries no em dash: the composer\'s header and the REAL web template',
      run: (ctx) => {
        const web = frameworkTemplates().find((entry) => entry.label === 'web/build.yml');
        ctx.expect(web, 'the web build template is missing').toBeTruthy();

        for (const [label, contents] of [['fixture', TEMPLATE], [web.label, web.contents]]) {
          const composed = composeWorkflow(contents, { targetPath: 'targets/web', targetName: 'web' });
          ctx.expect(composed.includes('\u2014'), `${label}: the composed workflow carries an em dash`).toBe(false);
        }
      },
    },

    {
      name: 'reconcile: a composed file carrying the em dash header is still recognised',
      run: (ctx) => {
        const { brandRoot } = stageBrand({});

        // Every brand composed before the header lost its em dash carries this line
        const dashed = `# GENERATED by the targets/extension framework scaffold \u2014 do not edit.\n${TEMPLATE}`;
        jetpack.write(rootWorkflow(brandRoot, 'extension-publish.yml'), dashed);

        const result = reconcileComposedWorkflows({ brandRoot, liveTargets: ['web'], logger: quiet });

        ctx.expect(result.removed).toEqual(['.github/workflows/extension-publish.yml']);
      },
    },
  ],
});
