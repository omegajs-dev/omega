/**
 * Brand-root `omega deploy` fan-out (D13 brand layer) — real execution over a
 * staged fixture brand: fake framework packages whose `omega` bins record
 * every invocation (cwd + argv) to a log, so ordering (backend FIRST), flag
 * forwarding, filtering, and the stop-on-failure bail are asserted from what
 * actually got spawned.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');

// ─── The delivery lane's boundary (#678) ─────────────────────────────────────
// The lane deploy runs before it fans out is manage's own runner, stubbed HERE
// (dev.test.js's pattern) so the ORDER — lane first, then the targets — is
// observable in the same call log the fake framework bins write to, and no
// service walk ever touches a fixture brand.
const managePath = require.resolve('../src/manage.js');
const manageCalls = [];
let manageReport = { hasErrors: false, results: {}, brand: {} };

require.cache[managePath] = {
  id: managePath,
  filename: managePath,
  path: path.dirname(managePath),
  loaded: true,
  exports: {
    runManage: async (startDir, options) => {
      manageCalls.push({ startDir, options });
      fs.appendFileSync(path.join(startDir, 'calls.log'), `${JSON.stringify({ name: 'delivery-lane', cwd: startDir, argv: [] })}\n`);
      return manageReport;
    },
  },
};

// ─── The root's ONE delivery (#901, #915) ────────────────────────────────────
// The lane and its delivery are devkit's, patched HERE the way runManage is
// above, and only where this run needs them: the LANE is the one every brand
// takes, and the DELIVERY is devkit's real `deliverLane` driven through its own
// `steps` seam, so the fixture records what the root was asked to check, to
// compose and to push instead of reaching GitHub. Everything else in that
// module stays the real thing (the dispatch repo is derived from the fixture's
// own config).
const devkitDeployPath = require.resolve('@omega.js/devkit/deploy');
const realDevkitDeploy = require(devkitDeployPath);

const pushes = [];
const refWaits = [];
const composes = [];

// Every brand takes the ONE lane now (#915), so every case here runs a delivery
// and the delivery resolves a token: the fixture's, never the machine's `gh`
// session.
process.env.GH_TOKEN = 'fixture-token';

// Recorded in the call log too, so WHEN a delivery happened is asserted in the
// same sequence the spawns are: every target's scaffold composes its workflow
// into the brand root, and the push is what carries those files to the runner
// (#901).
function recordStep(name, brandRoot) {
  fs.appendFileSync(path.join(brandRoot, 'calls.log'), `${JSON.stringify({ name, cwd: brandRoot, argv: [] })}\n`);
}

const laneSteps = {
  // The registry lane's lockfile gate (#938) runs first in the ONE delivery;
  // devkit's own tests hold its verdicts, so here it only says WHEN it ran.
  lockfile: (options) => recordStep('lockfile-gate', options.root),
  defaultBranch: async () => 'main',
  behind: (options) => recordStep('behind-check', options.cwd),
  // The ONE write a deploy makes to the default branch (#915): the composed
  // workflows, and only when they differ.
  workflows: async (options) => {
    composes.push(options);
    recordStep('compose-workflows', options.brandRoot);
    return { pushed: [], sha: null };
  },
  stage: async () => ({ staged: [], restore: async () => {} }),
  push: (options) => {
    pushes.push(options);
    recordStep('snapshot-push', options.brandRoot);
    return 'sha1234567890abcdef';
  },
  // The ref the whole run dispatches against has to RESOLVE to that push before
  // a single target is spawned (#902). The step knows the repo, not the folder,
  // so the push it follows is what says where this fixture's log lives.
  waitRef: async (options) => {
    refWaits.push(options);
    recordStep('snapshot-wait-ref', pushes[pushes.length - 1].brandRoot);
  },
};

function patchModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    exports,
  };
}

patchModule(devkitDeployPath, {
  ...realDevkitDeploy,
  resolveDeployLane: ({ dir }) => ({
    mode: 'snapshot',
    ref: 'omega-deploy',
    // The fixture brand is its OWN repo's toplevel, which is the brand shape
    // the behind check applies to (#915).
    nested: false,
    linked: false,
    repo: true,
    // A target dir is <brand>/targets/<name>
    brandRoot: path.resolve(dir, '..', '..'),
  }),
  deliverLane: (options) => realDevkitDeploy.deliverLane({ ...options, steps: laneSteps }),
});

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const deployCommand = require('../src/commands/deploy.js');
const { selectTargets, buildForwardedFlags } = deployCommand;
const { BOOT_SERVICES } = require('../src/config.js');

// ─── Fixture staging (test-command.test.js pattern) ──────────────────────────

/**
 * Fake framework bin: appends { name, phase, cwd, argv } to <brand>/calls.log
 * on the way in and on the way out, holds the process between the two, and
 * exits 1 when this run's sentinel exists (`FAIL-<name>`). The two phases are
 * what makes concurrency observable (#901): the names in a `GROUP` sentinel
 * wait for one another's START before they END, so a sequential fan-out
 * leaves the first of them waiting alone to its deadline.
 *
 * `SKIP-<name>` is the other sentinel: the verb prints ONE line and exits 0,
 * which is what a framework verb does when it steps aside on purpose (the
 * backend's `cloud.shared` skip, #882).
 */
function fakeBinSource(name) {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const brandRoot = path.resolve(__dirname, '..', '..', '..');
const record = (phase) => fs.appendFileSync(path.join(brandRoot, 'calls.log'), JSON.stringify({
  name: ${JSON.stringify(name)},
  phase: phase,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}) + '\\n');
record('start');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const groupFile = path.join(brandRoot, 'GROUP');
const group = fs.existsSync(groupFile) ? fs.readFileSync(groupFile, 'utf8').trim().split(',') : [];
const started = () => fs.readFileSync(path.join(brandRoot, 'calls.log'), 'utf8').split('\\n')
  .filter(Boolean).map((row) => JSON.parse(row)).filter((row) => row.phase === 'start').map((row) => row.name);
// A group member ends only once every member has started (or the deadline
// passes): no machine speed can make a sequential fan-out pass this.
const deadline = Date.now() + 8000;
if (group.includes(${JSON.stringify(name)})) {
  while (Date.now() < deadline && !group.every((member) => started().includes(member))) pause(50);
  if (!group.every((member) => started().includes(member))) console.error(${JSON.stringify(name)} + ': gave up waiting for the group to start');
} else {
  pause(120);
}
record('end');
if (fs.existsSync(path.join(brandRoot, 'SKIP-' + ${JSON.stringify(name)}))) {
  console.log('  Skipping the ' + ${JSON.stringify(name)} + ' deploy: cloud.shared is true');
  process.exit(0);
}
if (fs.existsSync(path.join(brandRoot, 'FAIL-' + ${JSON.stringify(name)}))) process.exit(1);
`;
}

/**
 * Fake framework scaffold: the `ensureTarget` the fan-out calls IN-PROCESS
 * through `@omega.js/<framework>/ensure-target` (#901). It records the same
 * `{ name, phase, cwd, argv }` row the bins write, so the ordering assertions
 * read a scaffold exactly as they always did, and throws when this run's
 * `FAIL-scaffold-<name>` sentinel exists, so a case can break a target's
 * scaffold without breaking its deploy.
 */
function fakeEnsureTargetSource(name) {
  return `const fs = require('fs');
const path = require('path');
const brandRoot = path.resolve(__dirname, '..', '..', '..');

exports.ensureTarget = async ({ projectDir }) => {
  fs.appendFileSync(path.join(brandRoot, 'calls.log'), JSON.stringify({
    name: ${JSON.stringify(name)},
    phase: 'scaffold',
    cwd: projectDir,
    argv: ['scaffold'],
  }) + '\\n');

  if (fs.existsSync(path.join(brandRoot, 'FAIL-scaffold-' + ${JSON.stringify(name)}))) {
    throw new Error('scaffold refused');
  }

  return { written: [], merged: [], changed: [] };
};
`;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Stage a brand monorepo with a web target and a backend target (LISTED so the
 * web dir sorts before backend, proving the order comes from
 * TARGET_ORDER, not the directory listing), plus fake framework packages. The
 * config names a repo owner, because a snapshot-lane run derives its push
 * address from it (#901).
 *
 * @param {string[]} [extra] - Further target types to stage ('desktop', …), the
 *   surfaces that deploy TOGETHER after the backend.
 * @returns {{ scratch: string, brand: string }} the staged tree
 */
function stageBrand(extra = []) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-deploy-cmd-')));
  const brand = path.join(scratch, 'brand');
  const types = ['web', 'backend', ...extra];

  write(path.join(brand, 'package.json'), JSON.stringify({
    name: 'fixture-brand', private: true, workspaces: ['targets/*'],
  }));
  write(path.join(brand, 'config', 'omega.json5'), `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  repo: { provider: 'github', owner: 'Fixture-Org' },
  targets: { ${types.map((type) => `${type}: { type: '${type}' }`).join(', ')} },
}
`);

  for (const type of types) {
    write(path.join(brand, 'targets', type, 'package.json'), JSON.stringify({
      name: type, private: true, dependencies: { [`@omega.js/${type}`]: '*' }, scripts: { deploy: 'omega deploy' },
    }));

    const pkgDir = path.join(brand, 'node_modules', `@omega.js/${type}`);
    write(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: `@omega.js/${type}`, bin: { omega: './bin.js' },
    }));
    write(path.join(pkgDir, 'bin.js'), fakeBinSource(type));
    write(path.join(pkgDir, 'ensure-target.js'), fakeEnsureTargetSource(type));

    // The target's own `omega` on its npm-script PATH: `npm run deploy` reaches the fake bin
    const binDir = path.join(brand, 'targets', type, 'node_modules', '.bin');
    fs.chmodSync(path.join(pkgDir, 'bin.js'), 0o755);
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(pkgDir, 'bin.js'), path.join(binDir, 'omega'));
  }

  return { scratch, brand };
}

/**
 * The spawns of ONE verb from the brand's call log, in the order they STARTED
 * (`deploy` by default, which is what most cases are about). The root's own
 * steps record themselves there too: the delivery lane, which must run before
 * the first spawn (#678), and the snapshot push, which must run after every
 * scaffold (#901). `{ all: true }` is how the ordering assertions see the whole
 * run, and `{ phases: true }` keeps each bin's end marker for the concurrency
 * assertion (#901).
 */
function readCalls(brand, { all = false, phases = false, verb = 'deploy' } = {}) {
  const logPath = path.join(brand, 'calls.log');
  if (!fs.existsSync(logPath)) return [];
  const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const started = phases ? entries : entries.filter((entry) => entry.phase !== 'end');
  return all ? started : started.filter((entry) => entry.argv[0] === verb);
}

/** `<target>:<verb>` per row of the whole run, the root's own steps by name. */
function readSequence(brand) {
  return readCalls(brand, { all: true }).map((entry) => (entry.argv.length > 0 ? `${entry.name}:${entry.argv[0]}` : entry.name));
}

/** Run the command from `cwd` with parsed options, restoring cwd + exitCode. */
async function runDeployCommand(cwd, options = {}) {
  manageCalls.length = 0;
  pushes.length = 0;
  refWaits.length = 0;
  composes.length = 0;
  const cwd0 = process.cwd();
  const restoreTee = require('@omega.js/devkit/attach-log-file').mark();
  process.chdir(cwd);
  try {
    await deployCommand({ _: ['deploy'], ...options });
    return process.exitCode;
  } finally {
    // The verb tees to <brandRoot>/logs/<verb>.log (#623) — release the writers
    // so the next case starts from an unpatched stdout.
    restoreTee();
    process.chdir(cwd0);
    process.exitCode = undefined;
  }
}

/** Run the command as runDeployCommand does, keeping every console.log line it printed, colors stripped. */
async function runCapturingLog(cwd, options = {}) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(stripVTControlCharacters(args.map(String).join(' ')));

  try {
    const code = await runDeployCommand(cwd, options);
    // The summary is what follows its heading: earlier `⊘ <name>:` lines are the run's own notes.
    const heading = lines.findLastIndex((line) => line.trim() === 'Deploy summary');
    const summary = heading === -1 ? '' : lines.slice(heading + 1).join('\n');
    return { code, lines, printed: lines.join('\n'), summary };
  } finally {
    console.log = originalLog;
  }
}

/** Add a custom target to a staged brand: its config entry and a package.json carrying `scripts`. */
function addCustomTarget(brand, name, scripts = {}) {
  const configPath = path.join(brand, 'config', 'omega.json5');
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('targets: {', `targets: { ${name}: { type: 'custom' },`));
  write(path.join(brand, 'targets', name, 'package.json'), JSON.stringify({ name, private: true, scripts }));
}

// A stepped-aside summary row: its name, a colon, then a reason.
const skippedRow = (name) => new RegExp(`^\\s*⊘ ${name}: \\S`, 'm');
const NOT_ATTEMPTED = /not attempted after the failure/;

module.exports = defineCases({
  type: 'group',
  description: 'deploy-command',
  tests: [
    // ─── Execution over the staged brand ─────────────────────────────────────────

    {
      name: 'a custom target\'s own deploy script runs bare: no --snapshot, no brand flag',
      run: async (ctx) => {
        const { brand } = stageBrand();
        const configPath = path.join(brand, 'config', 'omega.json5');
        fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace("targets: {", "targets: { api: { type: 'custom' },"));
        const record = "node -e \"require('fs').appendFileSync(require('path').join(process.cwd(),'..','..','calls.log'), JSON.stringify({name:'api',phase:'start',cwd:process.cwd(),argv:['deploy'].concat(process.argv.slice(1))})+'\\n')\"";
        write(path.join(brand, 'targets', 'api', 'package.json'), JSON.stringify({ name: 'api', private: true, scripts: { deploy: record } }));

        const code = await runDeployCommand(brand, { direct: false, platforms: 'mac' });

        const api = readCalls(brand).find((call) => call.name === 'api');
        ctx.expect(api, 'the custom target deployed').toBeTruthy();
        ctx.expect(api.argv, 'the brand\'s own script hears neither the root\'s --snapshot nor a brand flag').toEqual(['deploy']);
        const web = readCalls(brand).find((call) => call.name === 'web');
        ctx.expect(web.argv.includes('--snapshot=sha1234567890abcdef'), 'while the framework\'s own `omega deploy` still hears them').toBeTruthy();
        ctx.expect(code).toBe(undefined);
      },
    },

    {
      name: 'bare run fans out to every target, BACKEND FIRST, each spawned `deploy` in its own cwd',
      run: async (ctx) => {
        const { brand } = stageBrand();
        const code = await runDeployCommand(brand);

        const calls = readCalls(brand);
        ctx.expect(calls.length).toBe(2);
        // Order is TARGET_ORDER (backend → web), not the directory listing
        ctx.expect(calls.map((c) => c.name)).toEqual(['backend', 'web']);
        for (const call of calls) {
          // The only flag a bare run carries is the root's own word about the
          // delivery it performed for the whole run (#901), never a user flag.
          ctx.expect(call.argv, 'bare per-target: the deploy command and the root delivery hand-off').toEqual(['deploy', '--snapshot=sha1234567890abcdef']);
        }
        ctx.expect(calls[0].cwd).toBe(path.join(brand, 'targets', 'backend'));
        ctx.expect(calls[1].cwd).toBe(path.join(brand, 'targets', 'web'));
        ctx.expect(code, 'all targets green → no error exit code').toBe(undefined);
      },
    },

    {
      name: 'flags forward verbatim to every target; --target= is consumed here',
      run: async (ctx) => {
        const { brand } = stageBrand();
        // The parse shape: kebab original + camelCase twin (the twin must NOT forward twice)
        await runDeployCommand(brand, { 'dry-run': true, dryRun: true, direct: true });

        const calls = readCalls(brand);
        ctx.expect(calls.length).toBe(2);
        for (const call of calls) {
          ctx.expect(call.argv).toEqual(['deploy', '--dry-run', '--direct']);
        }
      },
    },

    {
      name: '--target= picks by target NAME; nothing else runs',
      run: async (ctx) => {
        const { brand } = stageBrand();
        await runDeployCommand(brand, { target: 'web' });

        let calls = readCalls(brand);
        ctx.expect(calls.map((c) => c.name)).toEqual(['web']);
        ctx.expect(calls[0].argv, '--target= never forwards').toEqual(['deploy', '--snapshot=sha1234567890abcdef']);

        fs.rmSync(path.join(brand, 'calls.log'));
        await runDeployCommand(brand, { target: 'backend,web' });
        calls = readCalls(brand);
        ctx.expect(calls.map((c) => c.name), 'order stays backend-first regardless of the flag order').toEqual(['backend', 'web']);
      },
    },

    // The retired pickers (#780) — `--only` is firebase's own flag on the backend
    // target, so accepting it at the brand root would mean two things at once
    {
      name: '--only and --except are REFUSED, not ignored and not aliased — zero spawns',
      run: async (ctx) => {
        const { brand } = stageBrand();

        await ctx.expect((() => runDeployCommand(brand, { only: 'web' }))()).rejects.toThrow((error) => {
            ctx.expect(error.refusal, 'a refusal prints its message alone (no stack)').toBe(true);
            ctx.expect(error.message).toMatch(/--only is retired: pick targets with --target=/);
            ctx.expect(error.message, 'the sentence names where the firebase flag DOES belong').toMatch(/firebase's own --only hosting runs from targets\/backend/);
            return true;
          });
        await ctx.expect((() => runDeployCommand(brand, { except: 'backend' }))()).rejects.toThrow(/--except is retired/);

        ctx.expect(readCalls(brand, { all: true }), 'not even the delivery lane ran').toEqual([]);
      },
    },

    {
      name: 'a --target= token matching nothing STOPS the run — never a matched subset, never deploy-everything',
      run: async (ctx) => {
        const { brand } = stageBrand();

        await ctx.expect((() => runDeployCommand(brand, { target: 'hosting' }))()).rejects.toThrow((error) => {
            ctx.expect(error.refusal).toBe(true);
            ctx.expect(error.message).toMatch(/Unknown --target token "hosting"/);
            ctx.expect(error.message, 'the error names what the brand actually has').toMatch(/this brand's targets are backend, web/);
            return true;
          });

        // A typo BESIDE a real target must not quietly deploy the matched half
        await ctx.expect((() => runDeployCommand(brand, { target: 'web,hosting' }))()).rejects.toThrow(/Unknown --target token "hosting"/);

        ctx.expect(readCalls(brand, { all: true }), 'not even the delivery lane ran').toEqual([]);
      },
    },

    {
      name: 'a failing backend STOPS the run before web (later targets depend on it) — exit 1',
      run: async (ctx) => {
        const { brand } = stageBrand();
        fs.writeFileSync(path.join(brand, 'FAIL-backend'), '');
        const code = await runDeployCommand(brand);

        ctx.expect(readCalls(brand).map((c) => c.name), 'web never deployed after the backend failure').toEqual(['backend']);
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: 'a backend that SKIPS (one line, exit 0) never stops the group, and reads green (#882)',
      run: async (ctx) => {
        const { brand } = stageBrand();
        // What the backend verb does on a shared cloud project: it prints its skip
        // line and exits 0. The gate ahead of the group stops the run on FAILURE
        // only, so the fan-out has nothing to add: the verb's own line rides through
        // its inherited stdout and the summary ticks the target.
        fs.writeFileSync(path.join(brand, 'SKIP-backend'), '');

        const { code, printed } = await runCapturingLog(brand);

        ctx.expect(readCalls(brand).map((c) => c.name), 'web still deploys after the skipped backend').toEqual(['backend', 'web']);
        ctx.expect(code, 'a skip is not a failure: the run stays green').toBe(undefined);
        ctx.expect(printed.includes('✓ backend'), `the summary ticks the skipped target (printed: ${printed})`).toBeTruthy();
      },
    },

    {
      name: '--continue-on-error keeps going past the failure, still exit 1',
      run: async (ctx) => {
        const { brand } = stageBrand();
        fs.writeFileSync(path.join(brand, 'FAIL-backend'), '');
        const code = await runDeployCommand(brand, { 'continue-on-error': true, continueOnError: true });

        const calls = readCalls(brand);
        ctx.expect(calls.map((c) => c.name)).toEqual(['backend', 'web']);
        for (const call of calls) {
          ctx.expect(call.argv, 'the brand-level bail switch never forwards').toEqual(['deploy', '--snapshot=sha1234567890abcdef']);
        }
        ctx.expect(code).toBe(1);
      },
    },

    // ─── The summary: stepped aside versus never attempted ───────────────────────

    {
      name: 'a custom target with no deploy script is its own skipped row, and a passing run names no failure',
      run: async (ctx) => {
        const { brand } = stageBrand();
        addCustomTarget(brand, 'factory');

        const { code, printed, summary } = await runCapturingLog(brand);

        ctx.expect(skippedRow('factory').test(summary), `the custom target reads as stepped aside, with its reason (printed: ${printed})`).toBeTruthy();
        ctx.expect(printed.includes('✓ web'), `the web deploy passed (printed: ${printed})`).toBeTruthy();
        ctx.expect(NOT_ATTEMPTED.test(printed), `nothing failed, so nothing went unattempted (printed: ${printed})`).toBe(false);
        ctx.expect(code, 'the run exits 0').toBe(undefined);
      },
    },

    {
      name: 'a --dry-run plans a custom target\'s script: a skipped row, and no "not attempted" line',
      run: async (ctx) => {
        const { brand } = stageBrand();
        addCustomTarget(brand, 'api', { deploy: 'node -e "process.exit(0)"' });

        const { printed, summary } = await runCapturingLog(brand, { 'dry-run': true, dryRun: true });

        ctx.expect(skippedRow('api').test(summary), `the planned custom target reads as stepped aside (printed: ${printed})`).toBeTruthy();
        ctx.expect(NOT_ATTEMPTED.test(printed), `a dry run stopped nothing (printed: ${printed})`).toBe(false);
      },
    },

    {
      name: 'a failing backend counts the group it stopped as not attempted, and exits 1',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop']);
        fs.writeFileSync(path.join(brand, 'FAIL-backend'), '');

        const { code, printed } = await runCapturingLog(brand);

        ctx.expect(/⊘ 2 targets? not attempted after the failure/.test(printed), `web and desktop never ran (printed: ${printed})`).toBeTruthy();
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: '--continue-on-error past a failing backend: failed, passed and skipped rows, and no "not attempted" line',
      run: async (ctx) => {
        const { brand } = stageBrand();
        addCustomTarget(brand, 'factory');
        fs.writeFileSync(path.join(brand, 'FAIL-backend'), '');

        const { code, printed, summary } = await runCapturingLog(brand, { 'continue-on-error': true, continueOnError: true });

        ctx.expect(/^\s*✗ backend/m.test(summary), `the backend reads as failed (printed: ${printed})`).toBeTruthy();
        ctx.expect(/^\s*✓ web/m.test(summary), `the web target reads as passed (printed: ${printed})`).toBeTruthy();
        ctx.expect(skippedRow('factory').test(summary), `the custom target reads as stepped aside (printed: ${printed})`).toBeTruthy();
        ctx.expect(NOT_ATTEMPTED.test(printed), `every target was attempted (printed: ${printed})`).toBe(false);
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: 'outside any brand: errors with exit 1',
      run: async (ctx) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-deploy-cmd-nobrand-'));
        const code = await runDeployCommand(scratch);
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: 'cli routes `deploy` through ALIASES to the command file',
      run: (ctx) => {
        const Main = require('../src/cli.js');
        ctx.expect(Object.prototype.hasOwnProperty.call(Main.config.aliases, 'deploy')).toBeTruthy();
        ctx.expect(fs.existsSync(path.join(Main.config.commandsDir, 'deploy.js'))).toBeTruthy();
      },
    },

    // ─── The delivery lane (#678) ────────────────────────────────────────────────

    {
      name: 'the delivery lane runs ONCE, before the first target — brand inputs land before anything publishes',
      run: async (ctx) => {
        const { brand } = stageBrand();
        await runDeployCommand(brand);

        ctx.expect(readSequence(brand)).toEqual(['delivery-lane', 'backend:scaffold', 'web:scaffold', 'lockfile-gate', 'behind-check', 'compose-workflows', 'snapshot-push', 'snapshot-wait-ref', 'backend:deploy', 'web:deploy']);
        ctx.expect(manageCalls.length, 'one lane pass for the whole fan-out, not one per target').toBe(1);
        ctx.expect(manageCalls[0].startDir).toBe(brand);
      },
    },

    {
      name: 'the lane deploy runs IS the boot lane — one constant, two triggers',
      run: async (ctx) => {
        const { brand } = stageBrand();
        await runDeployCommand(brand);

        // The lane is asked for BY NAME, so its service list can never be a second
        // copy of BOOT_SERVICES: manage resolves 'boot' to that constant
        // (manage.test.js pins the resolution), and deploy hand-picks nothing.
        ctx.expect(manageCalls[0].options.lane).toBe('boot');
        ctx.expect(manageCalls[0].options.service).toBe(undefined);
        ctx.expect(BOOT_SERVICES.includes('disperse'), 'the delivery services are the boot lane\'s').toBeTruthy();
      },
    },

    {
      name: '--dry-run reaches the lane too — a planned deploy plans its delivery',
      run: async (ctx) => {
        const { brand } = stageBrand();
        await runDeployCommand(brand, { 'dry-run': true, dryRun: true });

        ctx.expect(manageCalls[0].options.dryRun).toBe(true);
      },
    },

    {
      name: 'a delivery lane with errors stops the deploy — nothing publishes on broken inputs',
      run: async (ctx) => {
        const { brand } = stageBrand();
        manageReport = { hasErrors: true, results: {}, brand: {} };

        try {
          const code = await runDeployCommand(brand);

          ctx.expect(code).toBe(1);
          ctx.expect(readCalls(brand), 'no target was spawned').toEqual([]);
        } finally {
          manageReport = { hasErrors: false, results: {}, brand: {} };
        }
      },
    },

    // ─── The one push, and the parallel group (#901) ─────────────────────────────

    {
      name: 'the ONE lane pushes ONCE at the root, and every target dispatches against that sha (#901, #915)',
      run: async (ctx) => {
        const { brand } = stageBrand();
        const code = await runDeployCommand(brand);

        ctx.expect(pushes.length, 'one push for the whole fan-out, never one per target').toBe(1);
        ctx.expect(pushes[0].brandRoot, 'the BRAND folder is what rides').toBe(brand);
        ctx.expect(pushes[0].ref, 'the one branch CI ever builds').toBe('omega-deploy');
        ctx.expect({ owner: pushes[0].owner, repo: pushes[0].repo }, 'the push address is the brand repo the config names').toEqual({ owner: 'Fixture-Org', repo: 'fixture-brand-omega' });

        // And the ref has to CARRY that push before a target dispatches against it
        // (#902): GitHub resolves the branch on its side, so a dispatch sent in the
        // same second can start a run on the snapshot before this one.
        ctx.expect(refWaits.length, 'the root waits for the ref once, for the whole run').toBe(1);
        ctx.expect({ ref: refWaits[0].ref, sha: refWaits[0].sha }, 'it waits for the very sha the root just pushed').toEqual({ ref: 'omega-deploy', sha: 'sha1234567890abcdef' });

        const sequence = readSequence(brand);
        ctx.expect(sequence.indexOf('snapshot-push') < sequence.indexOf('snapshot-wait-ref')
          && sequence.indexOf('snapshot-wait-ref') < sequence.indexOf('backend:deploy'), `the wait sits between the push and the first dispatch (got ${JSON.stringify(sequence)})`).toBeTruthy();

        const calls = readCalls(brand);
        ctx.expect(calls.map((call) => call.name)).toEqual(['backend', 'web']);
        for (const call of calls) {
          ctx.expect(call.argv, 'every target is told the sha the root pushed').toEqual(['deploy', '--snapshot=sha1234567890abcdef']);
        }
        ctx.expect(code, 'all targets green → no error exit code').toBe(undefined);
      },
    },

    {
      name: 'the snapshot address composes the PRODUCTION config, never the machine\'s (#856, #915)',
      run: async (ctx) => {
        const { brand } = stageBrand();
        // A brand whose production layer names a different repo: the snapshot is a
        // production artifact, and an address read off this machine's ambient
        // environment (a terminal answers `development`) would push it to a repo the
        // targets never dispatch against.
        write(path.join(brand, 'config', 'omega.production.json5'), `{
  repo: { provider: 'github', owner: 'Prod-Org' },
}
`);

        // The machine stating what a developer's terminal states.
        const ambient = process.env.OMEGA_ENVIRONMENT;
        process.env.OMEGA_ENVIRONMENT = 'development';

        try {
          await runDeployCommand(brand);
        } finally {
          if (ambient === undefined) delete process.env.OMEGA_ENVIRONMENT;
          else process.env.OMEGA_ENVIRONMENT = ambient;
        }

        ctx.expect(pushes[0].owner, 'the push goes to the production org').toBe('Prod-Org');
        ctx.expect(composes[0].owner, 'and the composed workflows to the same repo').toBe('Prod-Org');
      },
    },

    {
      name: 'the root checks it is current and composes the workflows ONCE, before the group, and commits nothing (#915)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop']);

        await runDeployCommand(brand);

        ctx.expect(composes.length, 'one workflow compare for the whole fan-out, never one per target').toBe(1);
        ctx.expect({ brandRoot: composes[0].brandRoot, branch: composes[0].branch, repo: composes[0].repo }, 'the composed files of THIS brand go to its repo\'s default branch').toEqual({ brandRoot: brand, branch: 'main', repo: 'fixture-brand-omega' });

        // Both run before a single target is spawned, and in this order: a refusal
        // has to land before anything is written anywhere (#915).
        const sequence = readSequence(brand);
        const firstDeploy = sequence.findIndex((entry) => entry.endsWith(':deploy'));
        ctx.expect(sequence.indexOf('lockfile-gate') !== -1
          && sequence.indexOf('lockfile-gate') < sequence.indexOf('behind-check')
          && sequence.indexOf('behind-check') < sequence.indexOf('compose-workflows')
          && sequence.indexOf('compose-workflows') < sequence.indexOf('snapshot-push')
          && sequence.indexOf('snapshot-push') < firstDeploy, `gate the lockfile, check, compose, push, then the targets (got ${JSON.stringify(sequence)})`).toBeTruthy();

        for (const call of readCalls(brand)) {
          ctx.expect(call.argv, 'the root delivered: no child repeats it').toEqual(['deploy', '--snapshot=sha1234567890abcdef']);
          ctx.expect(!call.argv.includes('--no-sync'), 'the flag is retired with the push lane (#915)').toBeTruthy();
        }
      },
    },

    {
      name: 'a --dry-run and a --direct run deliver NOTHING at the root (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand();

        await runDeployCommand(brand, { 'dry-run': true, dryRun: true });
        ctx.expect(pushes.length, 'a dry run promises to send nothing at all').toBe(0);
        ctx.expect(composes.length, 'the default branch is not touched either').toBe(0);

        await runDeployCommand(brand, { direct: true });
        ctx.expect(pushes.length, 'a --direct run publishes from this machine without dispatching').toBe(0);
        for (const call of readCalls(brand, { verb: 'deploy' })) {
          ctx.expect(!call.argv.includes('--snapshot=sha1234567890abcdef'), 'and neither forwards a sha for a delivery nobody ran').toBeTruthy();
        }
      },
    },

    {
      name: 'a --dry-run pushes NOTHING: the run promises to send nothing at all (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand();

        await runDeployCommand(brand, { 'dry-run': true, dryRun: true });

        ctx.expect(pushes.length).toBe(0);
        for (const call of readCalls(brand)) {
          ctx.expect(call.argv, 'and no sha is forwarded for a snapshot nobody pushed').toEqual(['deploy', '--dry-run']);
        }
      },
    },

    {
      name: 'web, desktop and extension deploy CONCURRENTLY, after the backend (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop', 'extension']);
        fs.writeFileSync(path.join(brand, 'GROUP'), 'web,desktop,extension');
        const code = await runDeployCommand(brand);

        const calls = readCalls(brand, { phases: true }).filter((entry) => entry.name !== 'delivery-lane');
        const starts = calls.filter((entry) => entry.phase === 'start').map((entry) => entry.name);
        const ends = calls.filter((entry) => entry.phase === 'end').map((entry) => entry.name);

        ctx.expect(starts[0], 'the API goes live before the surfaces that call it').toBe('backend');
        ctx.expect(starts.slice(1).sort(), 'and the three surfaces all ran').toEqual(['desktop', 'extension', 'web']);
        ctx.expect(ends[0], 'the backend is finished before the group is spawned').toBe('backend');

        // The group's three all START before the first of them ENDS: a sequential
        // fan-out could not produce this order.
        const groupStarts = calls.filter((entry) => entry.phase === 'start' && entry.name !== 'backend');
        const firstGroupEnd = calls.findIndex((entry) => entry.phase === 'end' && entry.name !== 'backend');
        ctx.expect(groupStarts.length).toBe(3);
        for (const start of groupStarts) {
          ctx.expect(calls.indexOf(start) < firstGroupEnd, `${start.name} started before any of the group had finished`).toBeTruthy();
        }

        ctx.expect(code).toBe(undefined);
      },
    },

    {
      name: 'a failing member of the group lets its siblings finish, then exits 1 naming it (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop', 'extension']);
        // The FIRST of the group: a run that stopped at a failure would leave
        // extension and desktop unpublished behind it.
        fs.writeFileSync(path.join(brand, 'FAIL-web'), '');

        const code = await runDeployCommand(brand);
        const ended = readCalls(brand, { phases: true }).filter((entry) => entry.phase === 'end').map((entry) => entry.name);

        ctx.expect(ended.sort(), 'every sibling ran to the end').toEqual(['backend', 'desktop', 'extension', 'web']);
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: '--target=web,desktop: no backend, and the two run together (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop', 'extension']);
        fs.writeFileSync(path.join(brand, 'GROUP'), 'web,desktop');
        await runDeployCommand(brand, { target: 'web,desktop' });

        const calls = readCalls(brand, { phases: true }).filter((entry) => entry.name !== 'delivery-lane');
        ctx.expect(calls.filter((entry) => entry.phase === 'start').map((entry) => entry.name).sort(), 'the picked set, and nothing else: no backend, no extension').toEqual(['desktop', 'web']);

        const firstEnd = calls.findIndex((entry) => entry.phase === 'end');
        ctx.expect(calls.slice(0, firstEnd).filter((entry) => entry.phase === 'start').length, 'both started before either finished').toBe(2);
      },
    },

    // ─── The scaffold, before the push (#901) ────────────────────────────────────

    {
      name: 'every selected target is SCAFFOLDED first, in order, before the push and before any deploy (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop']);
        const code = await runDeployCommand(brand);

        // A target's scaffold composes its workflow into the brand root, and the
        // snapshot is what carries it to the runner: scaffolding after the push
        // would dispatch a workflow the mirror does not hold yet.
        ctx.expect(readSequence(brand).slice(0, 6), 'every scaffold ran, in TARGET_ORDER, before the run\'s one delivery').toEqual([
          'delivery-lane',
          'backend:scaffold',
          'web:scaffold',
          'desktop:scaffold',
          'lockfile-gate',
          'behind-check',
        ]);

        for (const call of readCalls(brand, { verb: 'scaffold' })) {
          ctx.expect(call.argv, 'the bare verb: no flags are forwarded to a scaffold').toEqual(['scaffold']);
          ctx.expect(call.cwd, 'each one runs in its own target dir').toBe(path.join(brand, 'targets', call.name));
        }

        ctx.expect(code).toBe(undefined);
      },
    },

    {
      name: 'a --dry-run scaffolds too, and still pushes nothing (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand();
        await runDeployCommand(brand, { 'dry-run': true, dryRun: true });

        ctx.expect(readCalls(brand, { verb: 'scaffold' }).map((call) => call.name), 'a dry run of a deploy scaffolds, exactly as every verb does').toEqual(['backend', 'web']);
        ctx.expect(pushes.length).toBe(0);
      },
    },

    {
      name: 'a scaffold failure stops the run BEFORE the push: nothing pushed, nothing deployed (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand();
        fs.writeFileSync(path.join(brand, 'FAIL-scaffold-backend'), '');

        const code = await runDeployCommand(brand);

        ctx.expect(readCalls(brand, { verb: 'scaffold' }).map((call) => call.name), 'the run stops at the first failing scaffold').toEqual(['backend']);
        ctx.expect(pushes.length, 'nothing was pushed').toBe(0);
        ctx.expect(readCalls(brand), 'and no target deployed').toEqual([]);
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: '--target=web scaffolds web ONLY: the picked set is the scaffolded set (#901)',
      run: async (ctx) => {
        const { brand } = stageBrand(['desktop']);
        await runDeployCommand(brand, { target: 'web' });

        ctx.expect(readCalls(brand, { verb: 'scaffold' }).map((call) => call.name)).toEqual(['web']);
        ctx.expect(readCalls(brand).map((call) => call.name)).toEqual(['web']);
      },
    },

    // ─── Units ───────────────────────────────────────────────────────────────────

    {
      name: 'selectTargets: full TARGET_ORDER, backend, web, then the rest',
      run: (ctx) => {
        const targets = [
          { name: 'desktop', target: 'desktop' },
          { name: 'web', target: 'web' },
          { name: 'extension', target: 'extension' },
          { name: 'backend', target: 'backend' },
        ];
        const { selected } = selectTargets({ targets });
        ctx.expect(selected.map((entry) => entry.target)).toEqual(['backend', 'web', 'extension', 'desktop']);
      },
    },

    {
      name: 'selectTargets: an unknown token throws — a matched subset is never returned',
      run: (ctx) => {
        const targets = [{ name: 'web', target: 'web' }];

        ctx.expect(() => selectTargets({ targets, target: 'web,hosting' })).toThrow((error) => {
            ctx.expect(error.refusal).toBe(true);
            ctx.expect(error.message).toMatch(/Unknown --target token "hosting": this brand's targets are web\. Nothing ran\./);
            return true;
          });

        ctx.expect(selectTargets({ targets, target: 'web' }).selected.map((entry) => entry.name)).toEqual(['web']);
      },
    },

    {
      name: 'buildForwardedFlags: values, booleans, --no- forms; brand-level keys consumed',
      run: (ctx) => {
        const flags = buildForwardedFlags({
          _: ['deploy'],
          target: 'web',
          'continue-on-error': true,
          continueOnError: true,
          'dry-run': true,
          dryRun: true,
          secrets: false,
          platforms: 'mac,win',
        });
        ctx.expect(flags).toEqual(['--dry-run', '--no-secrets', '--platforms=mac,win']);
      },
    },
  ],
});
