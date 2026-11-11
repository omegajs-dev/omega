/**
 * omega-bin dispatcher — context detection (target framework / brand root) +
 * dispatch. Real execution, no mocks: committed fixtures for detection, an
 * os.tmpdir() scratch with a fake installed package for each dispatch case.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findTarget, isBrandRoot, verbOf, isBoxVerbArgv, TARGET_SUBDIRS, MANAGER, run } = require('../src/omega-bin.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'local');
const BRAND = path.join(FIXTURES, 'brand');
const DISPATCH = path.join(__dirname, 'fixtures', 'dispatch');

// ─── TARGET_SUBDIRS: functions/ and dist/ are target VIEWS, never roots (#307) ───

/**
 * A backend target staged by `omega build`: the target root declares the framework,
 * and dist/ carries the GENERATED tree — a derived manifest (runtime
 * dependencies only, so a devDependency-declared framework is absent from it)
 * beside the composed config/omega.json5.
 * @returns {{ brandRoot: string, targetDir: string, distDir: string }}
 */
function makeStagedBackend() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-staged-'));
  const brandRoot = path.join(scratch, 'acme');
  const targetDir = path.join(brandRoot, 'targets', 'backend-api');
  const distDir = path.join(targetDir, 'dist');

  fs.mkdirSync(path.join(brandRoot, '.git'), { recursive: true }); // bound the walk
  fs.mkdirSync(path.join(brandRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(brandRoot, 'config', 'omega.json5'), '{ brand: { id: "acme" } }\n');
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify({ name: 'acme-backend', devDependencies: { '@omega.js/backend': '*' } })
  );
  fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify({ name: 'acme-backend-functions', dependencies: { 'firebase-admin': '^13.0.0' } })
  );
  fs.writeFileSync(
    path.join(distDir, 'config', 'omega.json5'),
    '// Staged by `omega build`\n{ "brand": { "id": "acme" } }\n'
  );

  return { brandRoot, targetDir, distDir };
}

/** A fake @omega.js/manager installed under `root`, whose CLI's run() is `body`. */
function installManager(root, body) {
  const dir = path.join(root, 'node_modules', '@omega.js', 'manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@omega.js/manager', exports: { './cli': './cli.js' } }));
  fs.writeFileSync(path.join(dir, 'cli.js'), `module.exports = { run() { ${body} } };`);
}

/**
 * A targetless cwd with a fake @omega.js/manager installed above it: the fresh
 * brand-template clone after `npm i --save-dev @omega.js/manager`, where the
 * backend won npm's .bin/omega link because the manager depends on it (#908).
 * @returns {{ workDir: string, marker: string }}
 */
function stageInstalledManager() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-mgr-'));
  fs.mkdirSync(path.join(scratch, '.git'), { recursive: true }); // bound the walk
  const workDir = path.join(scratch, 'clone');
  fs.mkdirSync(workDir);

  const marker = path.join(scratch, 'marker.txt');
  installManager(scratch, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'manager-dispatched');`);

  return { workDir, marker };
}

// ─── Contextless-verb guard (#699) ───────────────────────────────────────────

/**
 * A targetless cwd with the dispatcher wired to a host that only ANNOUNCES
 * itself — a real run in a child process, since the refusal exits the process.
 * @returns {{ workDir: string, invoke: (args: string[]) => object }}
 */
function stageTargetless() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-guard-'));
  const workDir = path.join(scratch, 'work');
  fs.mkdirSync(workDir);
  const runner = path.join(scratch, 'runner.js'); // outside workDir — it must stay empty
  fs.writeFileSync(
    runner,
    `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'omega-bin.js'))})`
      + `.run({ hostName: '@omega.js/desktop', hostRun: () => console.log('HOST-RAN') });`
  );

  return {
    workDir,
    invoke: (args) => require('child_process').spawnSync(
      process.execPath, [runner, ...args], { cwd: workDir, encoding: 'utf8' }
    ),
  };
}

// ─── A verb runs wherever one of its owners is; brand-wide verbs refuse below the root ───

const BIN = path.join(__dirname, '..', 'src', 'omega-bin.js');

/**
 * Run the dispatcher as a real process (a refusal exits it), wired to a host
 * that only announces itself.
 */
function invokeBin({ scratch, hostName, cwd, args }) {
  const runner = path.join(scratch, 'runner.js');
  fs.writeFileSync(runner, `require(${JSON.stringify(BIN)}).run({ hostName: ${JSON.stringify(hostName)}, hostRun: () => console.log('HOST-RAN') });`);
  return require('child_process').spawnSync(process.execPath, [runner, ...args], { cwd, encoding: 'utf8' });
}

/**
 * A brand with one web target, and a deep dir inside it. Realpaths throughout:
 * the child's cwd resolves macOS's /var symlink, and the refusal prints that path.
 * @returns {{ scratch: string, brandRoot: string, targetDir: string, deep: string }}
 */
function stageBrandTarget() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-root-')));
  const brandRoot = path.join(scratch, 'acme');
  const targetDir = path.join(brandRoot, 'targets', 'site');
  const deep = path.join(targetDir, 'src', 'pages');
  fs.mkdirSync(path.join(brandRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(brandRoot, 'config'), { recursive: true });
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(brandRoot, 'config', 'omega.json5'), '{ brand: { id: "acme" } }\n');
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ name: 'acme-site', devDependencies: { '@omega.js/web': '*' } }));
  return { scratch, brandRoot, targetDir, deep };
}

/**
 * A monorepo checkout as the dispatcher sees it: a root named "omega" with a
 * packages/devkit workspace, two framework packages that ship the `omega` bin and
 * a `./cli` (extension devDepends on web, the shape that misread as a target),
 * the manager, and a package with neither.
 * @returns {{ root: string, marker: string }}
 */
function stageMonorepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-mono-')));
  const marker = path.join(root, 'marker.txt');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'omega', workspaces: ['packages/*'] }));

  const write = (dirName, manifest) => {
    const dir = path.join(root, 'packages', dirName);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(dir, 'dist', 'cli-run.js'),
      `module.exports = { run() { require('fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(manifest.name)}); } };\n`
        + 'if (require.main === module) module.exports.run();\n'
    );
  };
  const framework = (name, deps = {}) => ({ name, bin: { omega: 'bin/omega' }, exports: { './cli': './dist/cli-run.js' }, devDependencies: deps });
  write('devkit', { name: '@omega.js/devkit' });
  write('extension', framework('@omega.js/extension', { '@omega.js/web': '*' }));
  write('web', framework('@omega.js/web'));
  write('config', { name: '@omega.js/config' });
  // Ships the bin, but its CLI's `test` is the brand fan-out: never a monorepo pick
  write('manager', framework('@omega.js/manager'));
  return { root, marker };
}

// The signing box's verbs with NO target context: a box is a machine, not a
// project, so `omega runner` / `omega sign-windows` run from any directory
// through @omega.js/desktop — the host when it is desktop, else desktop
// resolved from the cwd, else a refusal naming the install (#337).
function stageBox({ hostName, installDesktop }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-box-'));
  const workDir = path.join(scratch, 'work');
  fs.mkdirSync(workDir);
  const marker = path.join(scratch, 'marker.txt');
  if (installDesktop) {
    const fwDir = path.join(scratch, 'node_modules', '@omega.js', 'desktop');
    fs.mkdirSync(fwDir, { recursive: true });
    fs.writeFileSync(path.join(fwDir, 'package.json'), JSON.stringify({ name: '@omega.js/desktop', exports: { './cli': './cli.js' } }));
    fs.writeFileSync(path.join(fwDir, 'cli.js'), `module.exports = { run() { require('fs').writeFileSync(${JSON.stringify(marker)}, 'desktop-dispatched'); } };`);
  }
  const runner = path.join(scratch, 'runner.js');
  fs.writeFileSync(
    runner,
    `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'omega-bin.js'))})`
      + `.run({ hostName: ${JSON.stringify(hostName)}, hostRun: () => console.log('HOST-RAN') });`
  );
  return {
    workDir,
    marker,
    invoke: (args) => require('child_process').spawnSync(process.execPath, [runner, ...args], { cwd: workDir, encoding: 'utf8' }),
  };
}

module.exports = defineCases({
  type: 'group',
  description: 'omega-bin',
  tests: [
    {
      name: 'the dispatcher\'s frameworks are the target type rows\' frameworks: each one is a target, a package no row names is not',
      run: (ctx) => {
        // The dispatcher stays stdlib-only, so its framework list is a twin of the rows
        const { TARGET_TYPE_ROWS } = require('@omega.js/config/target-types');
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-rows-'));
        const stage = (dir, framework) => {
          const targetDir = path.join(scratch, dir);
          fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true }); // bound the walk
          fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ name: dir, devDependencies: { [framework]: '*' } }));
          return targetDir;
        };

        for (const row of TARGET_TYPE_ROWS.filter((entry) => entry.framework)) {
          const targetDir = stage(row.id, row.framework);
          ctx.expect(findTarget(targetDir), row.id).toEqual({ kind: 'framework', name: row.framework, dir: targetDir });
        }
        for (const other of ['@omega.js/client', '@omega.js/mobile']) {
          ctx.expect(findTarget(stage(other.split('/')[1], other)), `${other} is no target framework`).toBe(null);
        }
        ctx.expect(MANAGER).toBe('@omega.js/manager');
      },
    },

    {
      name: 'the verb table\'s twin of the target type rows matches config\'s rows: id, framework and walkRank, row for row',
      run: (ctx) => {
        const pick = (row) => ({ id: row.id, framework: row.framework, walkRank: row.walkRank });
        const twin = require('../src/verbs.js').TARGET_TYPE_TWIN;
        const rows = require('@omega.js/config/target-types').TARGET_TYPE_ROWS;

        ctx.expect(twin.map(pick)).toEqual(rows.map(pick));
      },
    },

    {
      name: 'findTarget: web target via devDependency',
      run: (ctx) => {
        const hit = findTarget(path.join(BRAND, 'targets', 'site'));
        ctx.expect(hit).toEqual({ kind: 'framework', name: '@omega.js/web', dir: path.join(BRAND, 'targets', 'site') });
      },
    },

    {
      name: 'findTarget: backend target via target-root manifest (src/dist pillar — no functions/ peek)',
      run: (ctx) => {
        const hit = findTarget(path.join(BRAND, 'targets', 'backend-api'));
        ctx.expect(hit).toEqual({
          kind: 'framework',
          name: '@omega.js/backend',
          dir: path.join(BRAND, 'targets', 'backend-api'),
        });
      },
    },

    {
      name: 'findTarget: inside functions/ walks up to the target root',
      run: (ctx) => {
        const hit = findTarget(path.join(BRAND, 'targets', 'backend-api', 'functions'));
        ctx.expect(hit.name).toBe('@omega.js/backend');
        ctx.expect(hit.dir).toBe(path.join(BRAND, 'targets', 'backend-api'));
      },
    },

    {
      name: 'findTarget: a deep (even nonexistent) dir inside a target walks up to the target its refusal names',
      run: (ctx) => {
        const hit = findTarget(path.join(BRAND, 'targets', 'site', 'src', 'pages', 'deep'));
        ctx.expect(hit.name).toBe('@omega.js/web');
      },
    },

    {
      name: 'findTarget: standalone project (desktop devDep)',
      run: (ctx) => {
        const hit = findTarget(path.join(FIXTURES, 'standalone-project'));
        ctx.expect(hit.name).toBe('@omega.js/desktop');
      },
    },

    {
      name: 'findTarget: no framework anywhere up the chain → null',
      run: (ctx) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-null-'));
        ctx.expect(findTarget(scratch)).toBe(null);
      },
    },

    // ─── Brand-root detection (cp94b) ────────────────────────────────────────────

    {
      name: 'findTarget: a brand root (config/omega.json5, no framework dep) → brand kind',
      run: (ctx) => {
        const hit = findTarget(path.join(DISPATCH, 'brand'));
        ctx.expect(hit).toEqual({ kind: 'brand', dir: path.join(DISPATCH, 'brand') });
      },
    },

    {
      name: 'findTarget: deep non-target dir inside a brand walks up to the brand root',
      run: (ctx) => {
        const hit = findTarget(path.join(DISPATCH, 'brand', 'config'));
        ctx.expect(hit).toEqual({ kind: 'brand', dir: path.join(DISPATCH, 'brand') });
      },
    },

    {
      name: 'findTarget: a target inside a brand still dispatches as the target (nearest context wins)',
      run: (ctx) => {
        const hit = findTarget(path.join(DISPATCH, 'brand', 'targets', 'site'));
        ctx.expect(hit).toEqual({
          kind: 'framework',
          name: '@omega.js/web',
          dir: path.join(DISPATCH, 'brand', 'targets', 'site'),
        });
      },
    },

    {
      name: 'findTarget: a target-of-brand config with no framework dep is skipped, resolving the brand above',
      run: (ctx) => {
        const hit = findTarget(path.join(DISPATCH, 'brand', 'targets', 'rogue'));
        ctx.expect(hit).toEqual({ kind: 'brand', dir: path.join(DISPATCH, 'brand') });
      },
    },

    {
      name: 'findTarget: standalone consumer with BOTH framework dep and config → framework wins',
      run: (ctx) => {
        const hit = findTarget(path.join(DISPATCH, 'standalone-consumer'));
        ctx.expect(hit.kind).toBe('framework');
        ctx.expect(hit.name).toBe('@omega.js/desktop');
      },
    },

    {
      name: 'isBrandRoot: true at a brand root, false for a target-of-brand config dir',
      run: (ctx) => {
        ctx.expect(isBrandRoot(path.join(DISPATCH, 'brand'))).toBe(true);
        ctx.expect(isBrandRoot(path.join(DISPATCH, 'brand', 'targets', 'rogue'))).toBe(false);
        ctx.expect(isBrandRoot(path.join(DISPATCH, 'brand', 'targets', 'site'))).toBe(false);
      },
    },

    {
      name: 'findTarget: inside a staged backend\'s dist/ walks up to the target root (#307)',
      run: (ctx) => {
        const { targetDir, distDir } = makeStagedBackend();

        ctx.expect(findTarget(distDir)).toEqual({
          kind: 'framework',
          name: '@omega.js/backend',
          dir: targetDir,
        });
      },
    },

    {
      name: 'isBrandRoot: an TARGET_SUBDIR view (functions/, dist/) is never a brand root, config or not (#307)',
      run: (ctx) => {
        const { distDir } = makeStagedBackend();
        ctx.expect(isBrandRoot(distDir), 'a staged dist/ carries a composed config but is output, not a root').toBe(false);

        // functions/ — the pre-pillar runtime cwd, same rule (both live in TARGET_SUBDIRS)
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-functions-'));
        fs.mkdirSync(path.join(scratch, 'functions', 'config'), { recursive: true });
        fs.writeFileSync(path.join(scratch, 'functions', 'config', 'omega.json5'), '{ brand: { id: "legacy" } }\n');
        ctx.expect(isBrandRoot(path.join(scratch, 'functions'))).toBe(false);
      },
    },

    {
      name: 'TARGET_SUBDIRS: the stdlib twin mirrors @omega.js/config\'s canonical list (#307)',
      run: (ctx) => {
        // The dispatcher cannot REQUIRE @omega.js/config (it is vendored into every
        // framework dist), so the list is copied — this pins the copy to the
        // canonical one so the twin can never drift again.
        ctx.expect(TARGET_SUBDIRS).toEqual(require('@omega.js/config/load').TARGET_SUBDIRS);
      },
    },

    // ─── Repo boundary (#73) ─────────────────────────────────────────────────────

    {
      name: 'findTarget: the walk stops at the nearest .git — a context outside the repo is never adopted',
      run: (ctx) => {
        // Outer dir = a framework target; inner repo = an unconfigured project. An
        // unbounded walk would climb out of the repo and dispatch the outer target.
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-gitbound-'));
        fs.writeFileSync(
          path.join(outer, 'package.json'),
          JSON.stringify({ name: 'outer', dependencies: { '@omega.js/web': '*' } })
        );
        const repo = path.join(outer, 'repo');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });

        ctx.expect(findTarget(path.join(repo, 'src', 'deep'))).toBe(null);
        ctx.expect(findTarget(repo)).toBe(null);

        // The git root itself is still CHECKED before the walk stops
        fs.writeFileSync(
          path.join(repo, 'package.json'),
          JSON.stringify({ name: 'inner', devDependencies: { '@omega.js/desktop': '*' } })
        );
        ctx.expect(findTarget(path.join(repo, 'src', 'deep'))).toEqual({
          kind: 'framework',
          name: '@omega.js/desktop',
          dir: repo,
        });

        fs.rmSync(outer, { recursive: true, force: true });
      },
    },

    // ─── run() dispatch ──────────────────────────────────────────────────────────

    {
      name: 'run(): no target context and no manager installed falls back to the HOST CLI (bootstrap case, e.g. a verb in a fresh dir)',
      run: async (ctx) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-boot-'));
        const cwd0 = process.cwd();
        const error0 = console.error;
        const notes = [];
        let ran = 0;
        console.error = (...args) => { notes.push(args.join(' ')); };
        process.chdir(scratch);
        try {
          await run({ hostName: '@omega.js/web', hostRun: () => { ran += 1; } });
        } finally {
          process.chdir(cwd0);
          console.error = error0;
        }
        ctx.expect(ran).toBe(1);
        // The manager preference (#908) must not swallow this lane: with nothing
        // installed there is no manager CLI to hand over to.
        const note = notes.join('\n');
        ctx.expect(note).toMatch(/no target context found from [\s\S]*running @omega\.js\/web/);
        ctx.expect(note).not.toMatch(/running @omega\.js\/manager/);
      },
    },

    {
      name: 'run(): no target context dispatches to an INSTALLED manager, never the hoist-winner host (#908)',
      run: async (ctx) => {
        // The reported break: `npx omega onboard` in a fresh clone that had installed
        // only @omega.js/manager reached the BACKEND's CLI, which knows no such verb.
        const { workDir, marker } = stageInstalledManager();
        const cwd0 = process.cwd();
        const error0 = console.error;
        const notes = [];
        console.error = (...args) => { notes.push(args.join(' ')); };
        process.chdir(workDir);
        try {
          await run({
            hostName: '@omega.js/backend',
            hostRun: () => { throw new Error('must not run the backend'); },
            argv: ['onboard', '--id=notifly'],
          });
        } finally {
          process.chdir(cwd0);
          console.error = error0;
        }

        ctx.expect(fs.readFileSync(marker, 'utf8')).toBe('manager-dispatched');
        const note = notes.join('\n');
        ctx.expect(note).toMatch(/no target context found from .*: running @omega\.js\/manager/);
        ctx.expect(note.includes(fs.realpathSync(workDir)), `the note names the cwd: ${note}`).toBeTruthy();
      },
    },

    {
      name: 'run(): an installed manager never rescues a REFUSED verb with no target context (#699)',
      run: async (ctx) => {
        // Order stands: the contextless-verb guard runs ahead of every dispatch, so a
        // mutating verb is still refused before the manager is even resolved.
        const { workDir, marker } = stageInstalledManager();
        const runner = path.join(path.dirname(workDir), 'runner.js');
        fs.writeFileSync(
          runner,
          `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'omega-bin.js'))})`
            + `.run({ hostName: '@omega.js/backend', hostRun: () => console.log('HOST-RAN') });`
        );

        const out = require('child_process').spawnSync(
          process.execPath, [runner, 'deploy', '--yes'], { cwd: workDir, encoding: 'utf8' }
        );

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stdout.includes('HOST-RAN')).toBe(false);
        ctx.expect(out.stderr).toMatch(/refusing to run "deploy"/);
        ctx.expect(fs.existsSync(marker), 'the manager CLI never started').toBe(false);
      },
    },

    {
      name: 'run(): host match executes hostRun (no dispatch)',
      run: async (ctx) => {
        const cwd0 = process.cwd();
        let ran = 0;
        process.chdir(path.join(BRAND, 'targets', 'site'));
        try {
          await run({ hostName: '@omega.js/web', hostRun: () => { ran += 1; } });
        } finally {
          process.chdir(cwd0);
        }
        ctx.expect(ran).toBe(1);
      },
    },

    {
      name: 'run(): cross-framework dispatch resolves the target\'s ./cli and calls run()',
      run: async (ctx) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-x-'));
        const targetDir = path.join(scratch, 'targets', 'site');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(
          path.join(targetDir, 'package.json'),
          JSON.stringify({ name: 'site', dependencies: { '@omega.js/web': '*' } })
        );

        // Fake installed framework, hoisted to the scratch root (resolution walks up).
        const fwDir = path.join(scratch, 'node_modules', '@omega.js', 'web');
        fs.mkdirSync(fwDir, { recursive: true });
        fs.writeFileSync(
          path.join(fwDir, 'package.json'),
          JSON.stringify({ name: '@omega.js/web', exports: { './cli': './cli.js' } })
        );
        const marker = path.join(scratch, 'marker.txt');
        fs.writeFileSync(
          path.join(fwDir, 'cli.js'),
          `module.exports = { run() { require('fs').writeFileSync(${JSON.stringify(marker)}, 'dispatched'); } };`
        );

        const cwd0 = process.cwd();
        process.chdir(targetDir);
        try {
          await run({
            hostName: '@omega.js/desktop',
            hostRun: () => { throw new Error('hostRun must not fire on cross-dispatch'); },
          });
        } finally {
          process.chdir(cwd0);
        }
        ctx.expect(fs.readFileSync(marker, 'utf8')).toBe('dispatched');
      },
    },

    {
      name: 'run(): a brand-SHAPED dir with no manager installed falls back to the HOST CLI with a note (#194)',
      run: async (ctx) => {
        // A verb's ensureTarget scaffolds config/omega.json5 into a STANDALONE project before
        // the framework dep lands in its package.json — brand-shaped, but no manager to
        // dispatch to. The dispatcher must not dead-end there.
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-nomgr-'));
        const targetDir = path.join(scratch, 'fresh-target');
        fs.mkdirSync(path.join(targetDir, 'config'), { recursive: true });
        fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true }); // bound the walk inside the scratch
        fs.writeFileSync(
          path.join(targetDir, 'package.json'),
          JSON.stringify({ name: 'fresh-target', dependencies: {} })
        );
        fs.writeFileSync(path.join(targetDir, 'config', 'omega.json5'), '{ brand: { id: "fresh-target" } }\n');

        const cwd0 = process.cwd();
        const error0 = console.error;
        const notes = [];
        let ran = 0;
        console.error = (...args) => { notes.push(args.join(' ')); };
        process.chdir(targetDir);
        try {
          await run({ hostName: '@omega.js/web', hostRun: () => { ran += 1; } });
        } finally {
          process.chdir(cwd0);
          console.error = error0;
        }

        ctx.expect(ran).toBe(1);
        const note = notes.join('\n');
        ctx.expect(note).toMatch(/@omega\.js\/manager is not installed/);
        ctx.expect(note).toMatch(/running @omega\.js\/web/);
        ctx.expect(note.includes(targetDir), `note names the brand-shaped dir: ${note}`).toBeTruthy();
      },
    },

    {
      name: 'run(): the MANAGER host in a brand-shaped dir never says to install what it is running (#276)',
      run: async (ctx) => {
        // The fresh brand-template clone: brand-shaped, nothing installed, and the
        // host IS the manager. "Install @omega.js/manager" would name the thing
        // about to run — that wording is for framework hosts only.
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-mgrhost-'));
        const cloneDir = path.join(scratch, 'clone');
        fs.mkdirSync(path.join(cloneDir, 'config'), { recursive: true });
        fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true }); // bound the walk inside the scratch
        fs.writeFileSync(
          path.join(cloneDir, 'package.json'),
          JSON.stringify({ name: 'clone', dependencies: {} })
        );
        fs.writeFileSync(path.join(cloneDir, 'config', 'omega.json5'), '{ brand: { id: "clone" } }\n');

        const cwd0 = process.cwd();
        const error0 = console.error;
        const notes = [];
        let ran = 0;
        console.error = (...args) => { notes.push(args.join(' ')); };
        process.chdir(cloneDir);
        try {
          await run({ hostName: '@omega.js/manager', hostRun: () => { ran += 1; } });
        } finally {
          process.chdir(cwd0);
          console.error = error0;
        }

        ctx.expect(ran).toBe(1);
        const note = notes.join('\n');
        ctx.expect(note, `the self-contradicting wording must not fire for the manager host: ${note}`).not.toMatch(/is not installed/);
        ctx.expect(note).toMatch(/running the bundled @omega\.js\/manager/);
        ctx.expect(note.includes(cloneDir), `note names the brand-shaped dir: ${note}`).toBeTruthy();
      },
    },

    {
      name: 'run(): an unresolvable CROSS-FRAMEWORK target still hard-fails (never falls back to the wrong CLI)',
      run: (ctx) => {
        // The brand fallback (#194) must not soften this branch: the target names a
        // DIFFERENT framework, so running the host's CLI would run the wrong tool.
        // Real execution in a child process — this path calls process.exit(1).
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-xfail-'));
        const targetDir = path.join(scratch, 'site');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(
          path.join(targetDir, 'package.json'),
          JSON.stringify({ name: 'site', dependencies: { '@omega.js/web': '*' } })
        );
        const runner = path.join(scratch, 'runner.js');
        fs.writeFileSync(
          runner,
          `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'omega-bin.js'))})`
            + `.run({ hostName: '@omega.js/desktop', hostRun: () => console.log('HOST-RAN') });`
        );

        const out = require('child_process').spawnSync(process.execPath, [runner], { cwd: targetDir, encoding: 'utf8' });
        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stdout.includes('HOST-RAN')).toBe(false);
        ctx.expect(out.stderr).toMatch(/could not resolve '@omega\.js\/web\/cli'/);
      },
    },

    {
      name: 'run(): a MUTATING verb with no target context is REFUSED, and writes nothing (#699)',
      run: (ctx) => {
        // The accident: `omega deploy --yes` outside any target fell back to the
        // hoist-winner CLI, whose deploy scaffolded a whole target into the cwd.
        const { workDir, invoke } = stageTargetless();
        const out = invoke(['deploy', '--yes']);

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stdout.includes('HOST-RAN'), 'the host CLI must never start').toBe(false);
        ctx.expect(out.stderr).toMatch(/refusing to run "deploy"/);
        ctx.expect(out.stderr.includes(workDir), `the refusal names the cwd: ${out.stderr}`).toBeTruthy();
        ctx.expect(out.stderr).toMatch(/Nothing was scaffolded/);
        ctx.expect(fs.readdirSync(workDir), 'the cwd is untouched').toEqual([]);
      },
    },

    {
      name: 'run(): the refusal lists every verb that still runs, onboard aliases included (#706)',
      run: (ctx) => {
        // The message named onboard/help/version/cwd/logs while the allowlist also
        // carried `create` and `new` — a reader following it typed the one spelling
        // it mentioned and never learned the other two work.
        const { invoke } = stageTargetless();
        const out = invoke(['deploy']);

        ctx.expect(['onboard (create, new)', 'help', 'version', 'cwd', 'logs', 'status'].filter((verb) => !(out.stderr.match(/only (.+) run/) || ['', ''])[1].includes(verb)), out.stderr).toEqual([]);
      },
    },

    {
      name: 'run(): every mutating verb spelling is refused — positional and flag-style alias (#699)',
      run: (ctx) => {
        const { invoke } = stageTargetless();
        for (const args of [['build'], ['package'], ['test'], ['install', 'local'], ['--deploy'], ['-b'], ['update']]) {
          const out = invoke(args);
          ctx.expect(out.status, `${args.join(' ')} must be refused: ${out.stderr}`).toBe(1);
          ctx.expect(out.stdout.includes('HOST-RAN')).toBe(false);
        }
      },
    },

    {
      name: 'run(): the bootstrap and read-only verbs still dispatch with no target context (#276)',
      run: (ctx) => {
        const { invoke } = stageTargetless();
        for (const args of [[], ['onboard'], ['new'], ['status'], ['help'], ['--help'], ['deploy', '--help'], ['version'], ['-v'], ['cwd'], ['logs']]) {
          const out = invoke(args);
          ctx.expect(out.status, `${args.join(' ') || '(bare)'} must still run: ${out.stderr}`).toBe(0);
          ctx.expect(out.stdout.includes('HOST-RAN'), `${args.join(' ') || '(bare)'} reaches the host CLI`).toBeTruthy();
        }
      },
    },

    {
      name: 'verbOf: --help wins over a positional, then the positional, then a flag alias',
      run: (ctx) => {
        ctx.expect(verbOf([])).toBe(null);
        ctx.expect(verbOf(['deploy', '--yes'])).toBe('deploy');
        ctx.expect(verbOf(['--yes', 'deploy'])).toBe('deploy');
        ctx.expect(verbOf(['deploy', '--help'])).toBe('help');
        ctx.expect(verbOf(['-h'])).toBe('help');
        ctx.expect(verbOf(['--deploy'])).toBe('--deploy');
      },
    },

    {
      name: 'run(): brand root dispatches to @omega.js/manager\'s ./cli',
      run: async (ctx) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bin-brand-'));
        const brandRoot = path.join(scratch, 'my-brand');
        fs.mkdirSync(path.join(brandRoot, 'config'), { recursive: true });
        fs.writeFileSync(path.join(brandRoot, 'package.json'), JSON.stringify({ name: 'my-brand', private: true, workspaces: ['targets/*'] }));
        fs.writeFileSync(path.join(brandRoot, 'config', 'omega.json5'), '{ brand: { id: "my-brand" } }\n');

        // Fake installed manager at the brand root (resolution walks up from there).
        const marker = path.join(scratch, 'marker.txt');
        installManager(brandRoot, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'brand-dispatched');`);

        const cwd0 = process.cwd();
        process.chdir(brandRoot);
        try {
          await run({
            hostName: '@omega.js/web',
            hostRun: () => { throw new Error('hostRun must not fire at a brand root'); },
            argv: ['build'],
          });
          ctx.expect(process.env.OMEGA_ROOT_DISPATCH, 'an accepted root run sets no env marker for its children').toBe(undefined);
        } finally {
          process.chdir(cwd0);
        }
        ctx.expect(fs.readFileSync(marker, 'utf8')).toBe('brand-dispatched');
      },
    },

    {
      name: 'run(): a verb only the manager owns that needs no brand runs the manager inside a target, and exits 1 naming the install with none',
      run: (ctx) => {
        const { scratch, brandRoot, targetDir } = stageBrandTarget();
        const none = invokeBin({ scratch, hostName: '@omega.js/web', cwd: targetDir, args: ['status'] });
        ctx.expect(none.status === 1 && !none.stdout.includes('HOST-RAN') && /@omega\.js\/manager/.test(none.stderr) && /project root/.test(none.stderr), `no manager: ${none.status} ${none.stdout}${none.stderr}`).toBeTruthy();
        installManager(brandRoot, "console.log('MANAGER-RAN');");
        for (const args of [['status'], ['status', '--json'], ['onboard', '--id=acme']]) {
          const out = invokeBin({ scratch, hostName: '@omega.js/web', cwd: targetDir, args });
          ctx.expect(out.status === 0 && out.stdout.includes('MANAGER-RAN') && !out.stdout.includes('HOST-RAN'), `${args.join(' ')} in a target: ${out.stdout}${out.stderr}`).toBeTruthy();
        }
      },
    },

    {
      name: 'run(): a verb the target\'s framework owns runs in place, in the target dir and deep inside it',
      run: (ctx) => {
        const { scratch, targetDir, deep } = stageBrandTarget();
        for (const cwd of [targetDir, deep]) {
          for (const verb of ['test', 'build', 'dev']) {
            const out = invokeBin({ scratch, hostName: '@omega.js/web', cwd, args: [verb, '--dry-run'] });
            ctx.expect(out.status, `${verb} in ${cwd}: ${out.stderr}`).toBe(0);
            ctx.expect(out.stdout.includes('HOST-RAN'), `${verb} ran the target framework's CLI in ${cwd}`).toBeTruthy();
            ctx.expect(out.stderr.includes('refusing'), out.stderr).toBe(false);
          }
        }
      },
    },

    {
      name: 'run(): ownership reads every row a token selects: `serve` runs in a web target (dev\'s alias) and in a backend target (its own verb)',
      run: (ctx) => {
        const { scratch, targetDir } = stageBrandTarget();
        const web = invokeBin({ scratch, hostName: '@omega.js/web', cwd: targetDir, args: ['serve'] });
        ctx.expect(web.status, web.stderr).toBe(0);
        ctx.expect(web.stdout.includes('HOST-RAN')).toBeTruthy();

        const backendDir = path.join(path.dirname(targetDir), 'api');
        fs.mkdirSync(backendDir);
        fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({ name: 'acme-api', dependencies: { '@omega.js/backend': '*' } }));
        const backend = invokeBin({ scratch, hostName: '@omega.js/backend', cwd: backendDir, args: ['serve'] });
        ctx.expect(backend.status, backend.stderr).toBe(0);
        ctx.expect(backend.stdout.includes('HOST-RAN')).toBeTruthy();

        const desktopDir = path.join(path.dirname(targetDir), 'app');
        fs.mkdirSync(desktopDir);
        fs.writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({ name: 'acme-app', dependencies: { '@omega.js/desktop': '*' } }));
        const desktop = invokeBin({ scratch, hostName: '@omega.js/desktop', cwd: desktopDir, args: ['serve'] });
        ctx.expect(desktop.status, desktop.stderr).toBe(0);
        ctx.expect(desktop.stdout.includes('HOST-RAN'), '`serve` is dev\'s alias, and desktop owns dev').toBeTruthy();
      },
    },

    {
      name: 'run(): `dev` runs in place in a backend, desktop and extension target, and the brand root hands it to the manager',
      run: (ctx) => {
        const { scratch, brandRoot, targetDir } = stageBrandTarget();
        for (const [dir, framework] of [['api', 'backend'], ['app', 'desktop'], ['ext', 'extension']]) {
          const cwd = path.join(path.dirname(targetDir), dir);
          fs.mkdirSync(cwd);
          fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: `acme-${dir}`, devDependencies: { [`@omega.js/${framework}`]: '*' } }));
          const out = invokeBin({ scratch, hostName: `@omega.js/${framework}`, cwd, args: ['dev'] });
          ctx.expect(out.status, `${framework}: ${out.stderr}`).toBe(0);
          ctx.expect(out.stdout.includes('HOST-RAN'), `${framework} ran its own dev in place`).toBeTruthy();
        }

        installManager(brandRoot, "console.log('MANAGER-RAN');");
        const root = invokeBin({ scratch, hostName: '@omega.js/backend', cwd: brandRoot, args: ['dev'] });
        ctx.expect(root.status, root.stderr).toBe(0);
        ctx.expect(root.stdout.includes('MANAGER-RAN'), root.stdout).toBeTruthy();
        ctx.expect(root.stdout.includes('HOST-RAN'), 'the brand root runs the manager, never the host framework').toBe(false);
      },
    },

    {
      name: 'run(): a brand-wide verb inside a target refuses and prints the brand-root form, no picker',
      run: (ctx) => {
        const { scratch, brandRoot, targetDir, deep } = stageBrandTarget();
        for (const cwd of [targetDir, deep]) {
          for (const verb of ['install', 'manage', 'migrate']) {
            const out = invokeBin({ scratch, hostName: '@omega.js/web', cwd, args: [verb, 'local'] });
            ctx.expect(out.status, `${verb} in ${cwd} must refuse: ${out.stdout}`).toBe(1);
            ctx.expect(out.stdout.includes('HOST-RAN'), 'the target CLI never started').toBe(false);
            ctx.expect(out.stderr).toMatch(/this verb runs at the brand root/);
            ctx.expect(out.stderr.includes(`Run: cd ${brandRoot} && npx omega ${verb} local`), out.stderr).toBeTruthy();
            ctx.expect(out.stderr.includes('--target='), `a brand-wide verb picks no target: ${out.stderr}`).toBe(false);
          }
        }
      },
    },

    {
      name: 'run(): a verb the target\'s framework does not own refuses with the brand-root form and its picker',
      run: (ctx) => {
        const { scratch, brandRoot, deep } = stageBrandTarget();
        const out = invokeBin({ scratch, hostName: '@omega.js/web', cwd: deep, args: ['package', '--quick'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stdout.includes('HOST-RAN')).toBe(false);
        ctx.expect(out.stderr.includes(`cd ${brandRoot} && npx omega package --target=site --quick`), out.stderr).toBeTruthy();
      },
    },

    {
      name: 'run(): a brand subfolder that is no framework target still refuses every verb',
      run: (ctx) => {
        const { scratch, brandRoot } = stageBrandTarget();
        const docs = path.join(brandRoot, 'docs');
        fs.mkdirSync(docs);
        const out = invokeBin({ scratch, hostName: '@omega.js/web', cwd: docs, args: ['build'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stderr.includes(`cd ${brandRoot} && npx omega build`), out.stderr).toBeTruthy();
      },
    },

    {
      name: 'run(): framework source is never a target: every verb inside a framework package refuses with the monorepo root form',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const deep = path.join(root, 'packages', 'extension', 'test', 'boot');
        fs.mkdirSync(deep, { recursive: true });

        // Each refusal prints the one form the monorepo root accepts for that verb
        const forms = {
          test: 'npx omega test --target=extension boot/manifest',
          build: 'npm run build --workspaces --if-present',
          clean: 'npm run clean --workspaces --if-present',
        };
        for (const [verb, ...rest] of [['test', 'boot/manifest'], ['build', '--dry-run'], ['clean']]) {
          const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: deep, args: [verb, ...rest] });
          ctx.expect(out.status, `${verb} must refuse: ${out.stdout}`).toBe(1);
          ctx.expect(fs.existsSync(marker), `${verb}: no package CLI started`).toBe(false);
          ctx.expect(out.stderr).toMatch(/this verb runs at the monorepo root/);
          ctx.expect(out.stderr.includes(`Run: cd ${root} && ${forms[verb]}`), out.stderr).toBeTruthy();
        }
      },
    },

    {
      name: 'run(): a verb the package does not own refuses with the monorepo root form',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: path.join(root, 'packages', 'extension'), args: ['package', '--quick'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(fs.existsSync(marker), 'no package CLI started').toBe(false);
        ctx.expect(out.stderr).toMatch(/this verb runs at the monorepo root/);
        ctx.expect(out.stderr.includes(`Run: cd ${root} && npm run package --workspaces --if-present`), out.stderr).toBeTruthy();
      },
    },

    {
      name: 'run(): the manager package is source too: its own verbs refuse there',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: path.join(root, 'packages', 'manager'), args: ['manage'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(fs.existsSync(marker)).toBe(false);
        ctx.expect(out.stderr.includes(`Run: cd ${root} && npm run manage --workspaces --if-present`), out.stderr).toBeTruthy();

        const dev = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: path.join(root, 'packages', 'manager'), args: ['dev'] });
        ctx.expect(dev.stderr.includes(`Run: cd ${root} && npm start`), dev.stderr).toBeTruthy();
      },
    },

    {
      name: 'run(): a package that owns no verb refuses every one',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: path.join(root, 'packages', 'devkit'), args: ['test'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(fs.existsSync(marker)).toBe(false);
        // devkit is no framework pick, so its suite is its own workspace's npm test
        ctx.expect(out.stderr.includes(`Run: cd ${root} && npm test --workspace packages/devkit`), out.stderr).toBeTruthy();
      },
    },

    {
      name: 'run(): a contextless verb and a box verb run from a subfolder',
      run: (ctx) => {
        const { scratch, deep } = stageBrandTarget();
        const version = invokeBin({ scratch, hostName: '@omega.js/web', cwd: deep, args: ['version'] });
        ctx.expect(version.status, version.stderr).toBe(0);
        ctx.expect(version.stdout.includes('HOST-RAN'), 'version ran inside the target subfolder').toBeTruthy();

        const { root } = stageMonorepo();
        const inside = path.join(root, 'packages', 'web', 'src');
        fs.mkdirSync(inside, { recursive: true });
        const box = invokeBin({ scratch: root, hostName: '@omega.js/desktop', cwd: inside, args: ['runner', 'status'] });
        ctx.expect(box.status, box.stderr).toBe(0);
        ctx.expect(box.stdout.includes('HOST-RAN'), 'the box verb reached desktop from inside a package').toBeTruthy();
      },
    },

    {
      name: 'findTarget: the monorepo root answers kind monorepo, and a package inside it names that package',
      run: (ctx) => {
        const { root } = stageMonorepo();
        ctx.expect(findTarget(root)).toEqual({ kind: 'monorepo', dir: root });

        // Identity beats dependency: extension devDepends on web, and is still no web target
        ctx.expect(findTarget(path.join(root, 'packages', 'extension', 'test'))).toEqual({
          kind: 'monorepo',
          dir: root,
          package: { name: '@omega.js/extension', dir: path.join(root, 'packages', 'extension') },
        });

        const real = path.join(__dirname, '..', '..', '..');
        ctx.expect(findTarget(real), 'this checkout is one').toEqual({ kind: 'monorepo', dir: path.resolve(real) });
      },
    },

    {
      name: 'run(): monorepo `test --target=` spawns each picked package\'s CLI file in its dir, in registry order',
      run: async (ctx) => {
        const { root } = stageMonorepo();
        const calls = [];
        const cwd0 = process.cwd();
        const error0 = console.error;
        console.error = () => {};
        process.chdir(root);
        try {
          await run({
            hostName: '@omega.js/web',
            hostRun: () => { throw new Error('the host never runs at the monorepo root'); },
            argv: ['test', '--target=extension,web', 'framework:'],
            spawn: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
          });
        } finally {
          process.chdir(cwd0);
          console.error = error0;
        }

        ctx.expect(calls.map((call) => call.args), 'web before extension (the registry order), each through its own CLI file, never the dispatcher').toEqual([
          [path.join(root, 'packages', 'web', 'dist', 'cli-run.js'), 'test', 'framework:'],
          [path.join(root, 'packages', 'extension', 'dist', 'cli-run.js'), 'test', 'framework:'],
        ]);
        ctx.expect(calls[0].command).toBe(process.execPath);
        ctx.expect(calls[0].options.cwd).toBe(path.join(root, 'packages', 'web'));
        ctx.expect(calls[0].options.env, 'the child inherits this process env').toBe(undefined);
        ctx.expect(process.env.OMEGA_ROOT_DISPATCH, 'no env marker rides into the children').toBe(undefined);
      },
    },

    {
      name: 'run(): the monorepo root really runs the picked package\'s own CLI, which the in-package refusal never sees',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: root, args: ['test', '--target=extension'] });

        ctx.expect(out.status, out.stderr).toBe(0);
        ctx.expect(out.stderr.includes('refusing'), out.stderr).toBe(false);
        ctx.expect(fs.readFileSync(marker, 'utf8')).toBe('@omega.js/extension');
      },
    },

    {
      name: 'run(): the monorepo test stops at the first failing package with its exit code',
      run: async (ctx) => {
        const { root } = stageMonorepo();
        const calls = [];
        const cwd0 = process.cwd();
        const error0 = console.error;
        console.error = () => {};
        process.chdir(root);
        try {
          await run({
            hostName: '@omega.js/web',
            hostRun: () => {},
            argv: ['test', '--target', '@omega.js/web,extension'],
            spawn: (command, args) => { calls.push(args); return { status: 7 }; },
          });
          ctx.expect(process.exitCode).toBe(7);
        } finally {
          process.exitCode = undefined;
          process.chdir(cwd0);
          console.error = error0;
        }
        ctx.expect(calls.length, 'extension never ran after web failed').toBe(1);
      },
    },

    {
      name: 'run(): an unknown --target at the monorepo root refuses naming the known packages',
      run: (ctx) => {
        const { root } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: root, args: ['test', '--target=wbe'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stderr).toMatch(/unknown --target "wbe": the monorepo's packages are web, extension\. Nothing ran\./);
      },
    },

    {
      name: 'run(): no --target at the monorepo root refuses and prints the picker',
      run: (ctx) => {
        const { root } = stageMonorepo();
        const out = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: root, args: ['test', 'framework:'] });

        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stderr).toMatch(/npx omega test --target=web framework:/);
        ctx.expect(out.stderr).toMatch(/The packages are web, extension; the whole battery is npm test/);
      },
    },

    {
      name: 'run(): any verb but test at the monorepo root refuses naming the root npm script',
      run: (ctx) => {
        const { root, marker } = stageMonorepo();
        const build = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: root, args: ['-b'] });
        ctx.expect(build.status).toBe(1);
        ctx.expect(build.stderr).toMatch(/for "-b" run the root npm script: npm run build --workspaces --if-present/);

        const dev = invokeBin({ scratch: root, hostName: '@omega.js/web', cwd: root, args: ['dev'] });
        ctx.expect(dev.status).toBe(1);
        ctx.expect(dev.stderr).toMatch(/run the root npm script: npm start/);
        ctx.expect(fs.existsSync(marker)).toBe(false);
      },
    },

    {
      name: 'isBoxVerbArgv: a box verb answers to its bare token AND its -- flag spelling (#337)',
      run: (ctx) => {
        // The desktop CLI's alias table takes `--runner` and `--sign-windows`, so both
        // spellings reach the same command — and both must be recognised HERE, or the
        // flag form loads a project's .env cascade onto the box.
        for (const argv of [
          ['runner'], ['runner', 'status'], ['sign-windows', '--smoke'],
          ['--runner'], ['--runner', 'status'], ['--sign-windows'], ['--sign-windows', '--smoke'],
        ]) {
          ctx.expect(isBoxVerbArgv(argv), `${argv.join(' ')} is a box invocation`).toBe(true);
        }
        for (const argv of [[], ['build'], ['--deploy'], ['test', 'runner'], ['runner', '--help'], ['--runner', '--help']]) {
          ctx.expect(isBoxVerbArgv(argv), `${argv.join(' ') || '(bare)'} is not a box invocation`).toBe(false);
        }
      },
    },

    {
      name: 'run(): the signing-box verbs run with no target when desktop IS the host (a bare global install) (#337)',
      run: (ctx) => {
        const { workDir, invoke } = stageBox({ hostName: '@omega.js/desktop', installDesktop: false });
        for (const args of [['runner', 'status'], ['runner', 'install'], ['sign-windows', '--smoke'], ['--runner', 'status'], ['--sign-windows', '--smoke']]) {
          const out = invoke(args);
          ctx.expect(out.status, `${args.join(' ')} must run: ${out.stderr}`).toBe(0);
          ctx.expect(out.stdout.includes('HOST-RAN'), `${args.join(' ')} reaches desktop's CLI`).toBeTruthy();
        }
        ctx.expect(fs.readdirSync(workDir), 'nothing was scaffolded into the cwd').toEqual([]);
      },
    },

    {
      name: 'run(): the signing-box verbs dispatch to an installed desktop when another framework won the bin link (#337)',
      run: (ctx) => {
        const { workDir, marker, invoke } = stageBox({ hostName: '@omega.js/backend', installDesktop: true });
        const out = invoke(['runner', 'status']);
        ctx.expect(out.status, out.stderr).toBe(0);
        ctx.expect(out.stdout.includes('HOST-RAN'), 'the backend host must not run a desktop verb').toBe(false);
        ctx.expect(fs.readFileSync(marker, 'utf8')).toBe('desktop-dispatched');
        ctx.expect(out.stderr).toMatch(/signing-box verb, running @omega\.js\/desktop/);
        ctx.expect(fs.readdirSync(workDir)).toEqual([]);
      },
    },

    {
      name: 'run(): the signing-box verbs refuse, naming the install, when desktop is nowhere (#337)',
      run: (ctx) => {
        const { workDir, invoke } = stageBox({ hostName: '@omega.js/backend', installDesktop: false });
        const out = invoke(['sign-windows', '--smoke']);
        ctx.expect(out.status).toBe(1);
        ctx.expect(out.stdout.includes('HOST-RAN')).toBe(false);
        ctx.expect(out.stderr).toMatch(/npm i -g @omega\.js\/desktop/);
        ctx.expect(out.stderr.includes(workDir), `the refusal names the cwd: ${out.stderr}`).toBeTruthy();
        ctx.expect(fs.readdirSync(workDir)).toEqual([]);
      },
    },
  ],
});
