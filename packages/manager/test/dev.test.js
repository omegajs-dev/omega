// `omega dev` (brand root) — target-selection rules plus the boot SEQUENCE
// (freshness sweep, manage cycle, then the target legs). The spawn plumbing is composition of
// tested pieces (discoverTargets, resolveTargetNode, watch-all's forwarding
// pattern); the SELECTION is the behavior with rules worth pinning: default
// set, --target=/--all, unknown tokens, backend-first ordering.
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { withoutCI } = require('@omega.js/devkit/test/without-ci');

// ─── Boot-sequence instrumentation ───────────────────────────────────────────
// Every boundary dev.js binds at load time (child_process.spawn, manage's
// runManage, devkit's freshnessSweep) is replaced BEFORE it is required, so
// their order is observable in-process without booting anything real.

const boot = [];
let manageReport = { hasErrors: false, results: {}, brand: {} };
// What the manage cycle does to the brand before it reports (the scripts step writes a fresh target's scripts)
let manageSideEffect = () => {};

// What OMEGA_NON_INTERACTIVE reads as at each boundary (#228): '1' during the
// boot manage cycle, back to its prior value by the time a leg spawns.
const nonInteractiveAt = { manage: [], spawn: [], spawnEnv: [] };

// What FORCE_COLOR each leg is spawned with (#395) — the legs pipe, so chalk
// downstream reads this switch instead of a TTY.
const forceColorAt = [];

// Whether each leg was spawned into its OWN process group (#690) — shutdown
// signals the group, so a same-group leg would leak its grandchild.
const spawnDetached = [];

// The env every leg was spawned with, whole — the certificate trust (#795)
// asks whether a KEY is there at all, not only what it holds.
const legEnvs = [];

// What each boot cycle asks runManage for — the lane lives here (#228)
const manageOptions = [];

// The command line every leg was spawned with, by target dir
const legCommands = [];

// Every child the boot spawned, so a leg's output can be driven by hand (#230)
const spawned = [];

childProcess.spawn = (command, args, options) => {
  boot.push(`spawn:${path.basename(options.cwd)}`);
  // A LEG is spawned with an explicit env; the watch child (#587) inherits
  // this process' own, so record only what a leg carried.
  if (options.env) {
    nonInteractiveAt.spawn.push(process.env.OMEGA_NON_INTERACTIVE);
    nonInteractiveAt.spawnEnv.push(options.env.OMEGA_NON_INTERACTIVE);
    forceColorAt.push(options.env.FORCE_COLOR);
    spawnDetached.push(options.detached);
    legEnvs.push(options.env);
    legCommands.push(`${path.basename(options.cwd)}: ${[command, ...args].join(' ')}`);
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // devkit's watch forwarder sets an encoding before reading; the legs do not.
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  child.kill = (signal) => { child.killedWith = signal; };
  spawned.push(child);
  return child;
};

// The hoisted freshness sweep (#340): stubbed at its module boundary so its
// ORDER in the boot and the lane hosts it is handed are observable without a
// real linked dist on disk.
let sweepResult = { checked: [], healed: [], staleLinked: [], healFailed: [], failed: [] };
const sweepHosts = [];

// The monorepo the staged brand's @omega.js deps resolve into (#587). Only the
// RESOLUTION is stubbed — the watch start below is devkit's real lock-aware
// function, spawning through the fake above, so the lock behavior is the real
// one and no watch ever runs.
let linkedMonorepo = null;
const realLocal = require('@omega.js/devkit/local');
const localPath = require.resolve('@omega.js/devkit/local');
require.cache[localPath] = {
  id: localPath,
  filename: localPath,
  path: path.dirname(localPath),
  loaded: true,
  exports: {
    ...realLocal,
    freshnessSweep: ({ hosts }) => {
      boot.push(`sweep:${hosts.map((host) => host.packageName).join(',') || 'none'}`);
      sweepHosts.push(hosts);
      return sweepResult;
    },
    resolveLinkedMonorepo: () => linkedMonorepo,
    resolveMonorepoRoot: () => '/the/monorepo',
    linkLocalPackages: async ({ dir, monorepoRoot }) => {
      boot.push(`link:${dir}<-${monorepoRoot}`);
      return [];
    },
  },
};

// The local certificate's root (#795): the helper is stubbed at its module
// boundary so a leg's trust is observable on a host with no mkcert, and so the
// "resolved ONCE per boot" rule is countable.
let caRootPem = null;
let caRootPemCalls = 0;
const httpsPath = require.resolve('@omega.js/devkit/local-https');
require.cache[httpsPath] = {
  id: httpsPath,
  filename: httpsPath,
  path: path.dirname(httpsPath),
  loaded: true,
  exports: {
    ...require('@omega.js/devkit/local-https'),
    mkcertCaRootPem: () => {
      caRootPemCalls += 1;
      return caRootPem;
    },
  },
};

const managePath = require.resolve('../src/manage.js');
require.cache[managePath] = {
  id: managePath,
  filename: managePath,
  path: path.dirname(managePath),
  loaded: true,
  exports: {
    runManage: async (startDir, options) => {
      boot.push(`manage:${startDir}`);
      nonInteractiveAt.manage.push(process.env.OMEGA_NON_INTERACTIVE);
      manageOptions.push(options);
      manageSideEffect(startDir);
      return manageReport;
    },
  },
};

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const devCommand = require('../src/commands/dev.js');
const { STOP_SIGNALS } = require('@omega.js/devkit/stop-signals');
const { selectDevTargets, createLineDeduper } = devCommand;

// The selector takes DISCOVERED targets ({ name, target: the type }): the name
// is the picker word, the type is what orders the boot (#886).
const ALL_TARGETS = ['web', 'backend', 'desktop', 'extension'].map((type) => ({ name: type, target: type }));
const named = (...pairs) => pairs.map(([name, target]) => ({ name, target }));

/** Stage a brand monorepo with a single web target. */
function stageBrand() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-manager-dev-')));

  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  targets: { web: { type: 'web' } },
}
`);

  const web = path.join(root, 'targets', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({
    name: 'fixture-web',
    private: true,
    dependencies: { '@omega.js/web': '*' }, // the target declares its framework, as every real one does
    scripts: { start: 'omega dev' },
  }));

  return root;
}

/**
 * Boot the dev command from `cwd`. It never resolves by design (it holds the
 * orchestrator alive while children run), so the run races a settle timer;
 * a rejection still surfaces.
 */
async function bootDev(cwd, options = {}) {
  const cwd0 = process.cwd();
  process.chdir(cwd);
  try {
    return await Promise.race([
      devCommand({ execFn: require('./lib/tool-probe.js').toolProbe(), ...options }), // every machine tool probe passes
      new Promise((resolve) => setTimeout(() => resolve('running'), 250)),
    ]);
  } finally {
    process.chdir(cwd0);
  }
}

// ─── Quiet boot (#228) ───────────────────────────────────────────────────────

/** Clear the boot recorder and the env/options observations before a boot. */
function resetRecorders() {
  boot.length = 0;
  manageOptions.length = 0;
  forceColorAt.length = 0;
  legEnvs.length = 0;
  legCommands.length = 0;
  caRootPemCalls = 0;
  Object.values(nonInteractiveAt).forEach((seen) => { seen.length = 0; });
}

/** Run fn with console.log captured; returns the joined lines. */
async function captureLogAsync(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

// ─── Hoisted freshness sweep (#340) ──────────────────────────────────────────

/**
 * Stage a brand with one target per type (web and backend by default), each
 * declaring its framework and the `start` script its scaffold writes. A type
 * listed in `withoutStart` declares no scripts; `custom` adds a custom target.
 */
function stageFanOutBrand({ types = ['web', 'backend'], withoutStart = [], custom = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-manager-dev-')));
  const targets = types.map((type) => `${type}: { type: '${type}' }`);
  if (custom) targets.push(`${custom}: { type: 'custom' }`);

  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  targets: { ${targets.join(', ')} },
}
`);

  for (const type of types) {
    const targetPath = path.join(root, 'targets', type);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, 'package.json'), JSON.stringify({
      name: `fixture-${type}`,
      private: true,
      dependencies: { [`@omega.js/${type}`]: '*' },
      ...(withoutStart.includes(type) ? {} : { scripts: { start: 'omega dev' } }),
    }));
  }
  if (custom) {
    fs.mkdirSync(path.join(root, 'targets', custom), { recursive: true });
    fs.writeFileSync(path.join(root, 'targets', custom, 'package.json'), JSON.stringify({ name: `fixture-${custom}`, scripts: { start: 'node server.js' } }));
  }

  return root;
}

/** Clear the sweep recorders and put the result back to an all-fresh brand. */
function resetSweep() {
  sweepHosts.length = 0;
  sweepResult = { checked: [], healed: [], staleLinked: [], healFailed: [], failed: [] };
}

// ─── The monorepo watch as a session child (#587) ────────────────────────────

/** A monorepo-root-shaped temp dir the watch lock can live in. */
function stageMonorepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-monorepo-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'omega', private: true }));
  return root;
}

/** Poll until spawned holds count children (the boot spawns them across ticks). */
async function waitForSpawn(count) {
  const deadline = Date.now() + 2000;
  while (spawned.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${spawned.length} of ${count} children spawned`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return spawned[count - 1];
}

/**
 * Say what a real watch says once its initial prepare has landed (#670): the
 * roster line the count comes from, then every package's ready line.
 */
function reportWatchReady(child, packages) {
  child.stdout.emit('data', `Watching ${packages.length} packages (src→dist): ${packages.join(', ')}\n`);
  packages.forEach((name) => child.stdout.emit('data', `[${name}] [17:47:26] 'prepare-package': Ready for changes!\n`));
}

/** Exit hooks registered during fn, removed again; returns them. */
async function exitHooksAddedBy(fn) {
  const before = process.listeners('exit');
  await fn();
  const added = process.listeners('exit').filter((hook) => !before.includes(hook));
  added.forEach((hook) => process.removeListener('exit', hook));
  return added;
}

/**
 * Give the staged monorepo the log a running watch tees (#197): the header
 * naming the pid that owns it, the roster the count comes from, then a ready
 * line for every package whose initial prepare has landed.
 */
function stageWatchLog(monorepo, { pid, packages, reported }) {
  const logPath = path.join(monorepo, '.temp', 'logs', 'watch-all.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${[
    `# omega log — ${new Date().toISOString()} — pid=${pid}`,
    `Watching ${packages.length} packages (src→dist): ${packages.join(', ')}`,
    ...reported.map((name) => `[${name}] [02:00:00] 'prepare-package': Ready for changes!`),
  ].join('\n')}\n`);
  return logPath;
}

// ─── Leg output dedup (#230) ─────────────────────────────────────────────────

/** Feed a whole stream through one deduper, flush included; lines in → out. */
function dedupe(lines) {
  const deduper = createLineDeduper();
  return lines.flatMap((line) => deduper.push(line)).concat(deduper.flush());
}

const LOADED = 'i  functions: Loaded environment variables from .env.';

// ─── Leg color passthrough (#395) ────────────────────────────────────────────

/** Boot one leg with the parent's TTY state (and inherited switch) staged; reports what the leg got. */
async function forceColorForLeg({ isTTY, inherited }) {
  resetRecorders();
  manageReport = { hasErrors: false, results: {}, brand: {} };
  const root = stageBrand();

  const priorTTY = process.stdout.isTTY;
  const priorForceColor = process.env.FORCE_COLOR;
  process.stdout.isTTY = isTTY;
  if (inherited === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = inherited; }

  try {
    await bootDev(root, { target: 'web' });
  } finally {
    process.stdout.isTTY = priorTTY;
    if (priorForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = priorForceColor; }
  }

  return forceColorAt;
}

// ─── The local certificate's trust (#795) ────────────────────────────────────

/**
 * Boot with the mkcert helper's answer and the shell's own variable staged;
 * reports the env each leg was spawned with.
 */
async function bootWithCaPem({ pem, inherited, brandRoot }) {
  resetRecorders();
  manageReport = { hasErrors: false, results: {}, brand: {} };

  const prior = process.env.NODE_EXTRA_CA_CERTS;
  caRootPem = pem;
  if (inherited === undefined) { delete process.env.NODE_EXTRA_CA_CERTS; } else { process.env.NODE_EXTRA_CA_CERTS = inherited; }

  try {
    await bootDev(brandRoot);
  } finally {
    caRootPem = null;
    if (prior === undefined) { delete process.env.NODE_EXTRA_CA_CERTS; } else { process.env.NODE_EXTRA_CA_CERTS = prior; }
  }

  return legEnvs;
}

module.exports = defineCases({
  type: 'group',
  description: 'dev',
  tests: [
    {
      name: 'default set is the local web loop — web + backend, GUI targets stay down',
      run: (ctx) => {
        const { selected } = selectDevTargets({ available: ALL_TARGETS });

        ctx.expect(selected, 'backend boots first (publishes the port map)').toEqual(['backend', 'web']);
      },
    },

    {
      name: 'the boot order is by TYPE: a backend NAMED api still boots first',
      run: (ctx) => {
        const available = named(['site', 'web'], ['api', 'backend']);

        ctx.expect(selectDevTargets({ available, target: 'site,api' }).selected, 'the emulator publishes the port map the web leg reads, whatever it is called').toEqual(['api', 'site']);
        ctx.expect(selectDevTargets({ available, all: true }).selected).toEqual(['api', 'site']);
      },
    },

    {
      name: '--target= is the exact set; --all boots every leg',
      run: (ctx) => {
        ctx.expect(selectDevTargets({ available: ALL_TARGETS, target: 'web' }).selected).toEqual(['web']);
        ctx.expect(selectDevTargets({ available: ALL_TARGETS, target: 'desktop,web' }).selected, '--target= can opt GUI targets in — a GUI leg still needs naming').toEqual(['desktop', 'web']);
        ctx.expect(selectDevTargets({ available: ALL_TARGETS, all: true }).selected, 'backend still first under --all').toEqual(['backend', 'web', 'desktop', 'extension']);
      },
    },

    {
      name: 'a token naming no dev leg STOPS the boot — never a matched subset',
      run: (ctx) => {
        ctx.expect(() => selectDevTargets({ available: named(['web', 'web']), target: 'web,mobile' })).toThrow((error) => {
            ctx.expect(error.refusal).toBe(true);
            ctx.expect(error.message, 'no mobile dev leg exists (MAM parked)').toMatch(/Unknown --target token "mobile"/);
            ctx.expect(error.message, 'the error names the legs this brand HAS').toMatch(/this brand's targets are web/);
            return true;
          });
      },
    },

    // The vocabulary is the brand's declared NAMES, the same list `test`, `deploy`
    // and `update` take (#886): a type word this brand never named is a typo, and
    // a typo stops the boot instead of quietly booting the rest.
    {
      name: 'a type word that names no target in THIS brand is refused, not skipped',
      run: (ctx) => {
        ctx.expect(() => selectDevTargets({ available: named(['web', 'web']), target: 'web,backend' })).toThrow((error) => {
            ctx.expect(error.refusal).toBe(true);
            ctx.expect(error.message).toMatch(/Unknown --target token "backend"/);
            ctx.expect(error.message).toMatch(/this brand's targets are web/);
            return true;
          });

        // A brand whose web target is NAMED site answers to `site`, never to `web`
        ctx.expect(selectDevTargets({ available: named(['site', 'web']), target: 'site' }).selected).toEqual(['site']);
        ctx.expect(() => selectDevTargets({ available: named(['site', 'web']), target: 'web' })).toThrow(/Unknown --target token "web"/);
      },
    },

    {
      name: 'a web-only brand defaults to just web — no phantom backend leg',
      run: (ctx) => {
        const { selected } = selectDevTargets({ available: named(['web', 'web']) });

        ctx.expect(selected, 'the default set adapts to the brand instead of warning').toEqual(['web']);
      },
    },

    // The retired pickers (#780) — refused before anything boots, never ignored
    // and never aliased onto --target=
    {
      name: '--only and --except are REFUSED, naming --target=',
      run: async (ctx) => {
        const root = stageBrand();

        await ctx.expect((() => bootDev(root, { only: 'web' }))()).rejects.toThrow((error) => {
            ctx.expect(error.refusal, 'a refusal prints its message alone (no stack)').toBe(true);
            ctx.expect(error.message).toMatch(/--only is retired: pick targets with --target=/);
            return true;
          });
        await ctx.expect((() => bootDev(root, { except: 'backend' }))()).rejects.toThrow(/--except is retired/);
        await ctx.expect((() => bootDev(root, { target: 'mobile' }))()).rejects.toThrow(/Unknown --target token "mobile"/);
      },
    },

    // ─── Boot sequence ───────────────────────────────────────────────────────────

    {
      name: 'boot opens with the manage cycle, THEN spawns the target legs — brand asset edits land on restart',
      run: async (ctx) => {
        boot.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        const outcome = await bootDev(root, { target: 'web' });

        ctx.expect(outcome, 'the orchestrator stays alive after booting').toBe('running');
        ctx.expect(boot, 'the full service walk runs against the brand root before any target leg starts').toEqual(['sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
      },
    },

    {
      name: 'a manage cycle with errors stops dev boot loudly — no target leg spawns',
      run: async (ctx) => {
        boot.length = 0;
        manageReport = { hasErrors: true, results: {}, brand: {} };
        const root = stageBrand();

        await ctx.expect((() => bootDev(root, { target: 'web' }))()).rejects.toThrow(/manage/i);
        ctx.expect(boot, 'nothing booted on top of a broken brand').toEqual(['sweep:@omega.js/web', `manage:${root}`]);
      },
    },

    {
      name: 'the boot manage cycle runs non-interactive — human gates skip instead of blocking the boot',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        await bootDev(root, { target: 'web' });

        ctx.expect(nonInteractiveAt.manage, 'the boot walk runs under OMEGA_NON_INTERACTIVE — no console confirm, consent flow, or secret paste can stall it').toEqual(['1']);
      },
    },

    {
      name: 'the non-interactive switch is restored before any leg spawns — the dev servers stay interactive',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        await bootDev(root, { target: 'web' });

        ctx.expect(boot, 'the boot still runs manage, then the leg').toEqual(['sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
        ctx.expect(nonInteractiveAt.spawn, 'the switch is off the process env again by spawn time').toEqual([undefined]);
        ctx.expect(nonInteractiveAt.spawnEnv, "the leg's inherited env carries no switch").toEqual([undefined]);
        ctx.expect(process.env.OMEGA_NON_INTERACTIVE, 'and nothing leaks past the boot').toBe(undefined);
      },
    },

    {
      name: 'omega dev --local links the whole brand from the monorepo once, before the sweep and the legs',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        await bootDev(root, { target: 'web', local: true });

        ctx.expect(boot).toEqual([`link:${root}<-/the/monorepo`, 'sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
      },
    },

    {
      name: 'a clean report with pending human gates still boots the legs — pending is not an error',
      run: async (ctx) => {
        resetRecorders();
        manageReport = {
          hasErrors: false,
          brand: {},
          results: {
            cloud: {
              status: 'warned',
              output: { billing: { needsInteractive: 'pick a billing account' } },
            },
          },
        };
        const root = stageBrand();

        const outcome = await bootDev(root, { target: 'web' });

        ctx.expect(outcome).toBe('running');
        ctx.expect(boot, "the summary's ⚑ pending list is the report — the stack boots regardless").toEqual(['sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
      },
    },

    {
      name: '--target= takes the target NAME, the one token every brand-root verb takes (#780, #886)',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        const outcome = await bootDev(root, { target: 'web' });

        ctx.expect(outcome).toBe('running');
        ctx.expect(boot, 'the name IS the folder, so one word picks the leg').toEqual(['sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
      },
    },

    {
      name: 'a pre-existing OMEGA_NON_INTERACTIVE survives the boot — the restore is not a blind delete',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();
        process.env.OMEGA_NON_INTERACTIVE = '1';

        try {
          await bootDev(root, { target: 'web' });

          ctx.expect(nonInteractiveAt.manage).toEqual(['1']);
          ctx.expect(process.env.OMEGA_NON_INTERACTIVE, "the caller's own switch is put back, not dropped").toBe('1');
          ctx.expect(nonInteractiveAt.spawnEnv, 'so the legs inherit what the caller asked for').toEqual(['1']);
        } finally {
          delete process.env.OMEGA_NON_INTERACTIVE;
        }
      },
    },

    // ─── Boot lane (#228) ────────────────────────────────────────────────────────

    {
      name: 'the boot walks the LOCAL lane only, and says where the full setup lives',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        const log = await captureLogAsync(() => bootDev(root, { target: 'web' }));

        ctx.expect(manageOptions, 'the dev legs consume the local slice — the slow services must not hold the boot').toEqual([{ lane: 'boot' }]);
        ctx.expect(log, 'and the boot names the one command that runs the rest').toMatch(/npm run manage/);
        ctx.expect(boot, 'still manage, then the legs').toEqual(['sweep:@omega.js/web', `manage:${root}`, 'spawn:web']);
      },
    },

    {
      name: 'omega dev --full boots on the whole manage walk instead of the lane',
      run: async (ctx) => {
        resetRecorders();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        const log = await captureLogAsync(() => bootDev(root, { target: 'web', full: true }));

        ctx.expect(manageOptions, 'no lane — the full walk').toEqual([{}]);
        ctx.expect(nonInteractiveAt.manage, 'and it is still quiet').toEqual(['1']);
        ctx.expect(!/local lane/.test(log), 'nothing to point at — this run WAS the full setup').toBeTruthy();
      },
    },

    {
      name: 'omega dev --full is declared boolean, so it never eats the next token',
      run: (ctx) => {
        const { BOOLEAN_FLAGS } = require('../src/cli-run.js');
        const { parseArgv } = require('@omega.js/devkit/argv');
        ctx.expect(BOOLEAN_FLAGS.includes('full'), '--full takes no value, so it must be declared boolean').toBeTruthy();
        ctx.expect(parseArgv(['dev', '--full', 'web'], { booleans: BOOLEAN_FLAGS })._).toEqual(['dev', 'web']);
      },
    },

    {
      name: 'omega manage --execute is declared boolean, so it never eats the next token',
      run: (ctx) => {
        const { BOOLEAN_FLAGS } = require('../src/cli-run.js');
        const { parseArgv } = require('@omega.js/devkit/argv');
        ctx.expect(BOOLEAN_FLAGS.includes('execute'), '--execute takes no value, so it must be declared boolean').toBeTruthy();
        ctx.expect(parseArgv(['manage', '--execute', 'users'], { booleans: BOOLEAN_FLAGS })._).toEqual(['manage', 'users']);
      },
    },

    {
      name: 'every target\'s dev leg is its own `npm run start`, whatever its kind',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand({ types: ['web', 'backend', 'desktop', 'extension'], custom: 'api' });

        const outcome = await bootDev(root, { all: true });

        ctx.expect(outcome).toBe('running');
        ctx.expect([...legCommands].sort(), 'one leg for every kind: the target\'s own start script').toEqual([
          'api: npm run start',
          'backend: npm run start',
          'desktop: npm run start',
          'extension: npm run start',
          'web: npm run start',
        ]);
        ctx.expect(legCommands[0], 'the backend still boots first').toBe('backend: npm run start');
      },
    },

    {
      name: 'every flag the fan-out does not consume reaches the leg after --, and --target stays the root\'s',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const { BOOLEAN_FLAGS } = require('../src/cli-run.js');
        const { parseArgv } = require('@omega.js/devkit/argv');
        const root = stageFanOutBrand();

        await bootDev(root, parseArgv(['dev', '--target=web', '--port=3001', '--no-https'], { booleans: BOOLEAN_FLAGS }));

        ctx.expect(legCommands, 'web\'s start hears its own flags as typed, never the picker').toEqual(['web: npm run start -- --port=3001 --no-https']);
      },
    },

    {
      name: 'omega dev --target=backend boots the backend\'s own dev leg: the root form of its serve',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const { BOOLEAN_FLAGS } = require('../src/cli-run.js');
        const { parseArgv } = require('@omega.js/devkit/argv');
        const root = stageFanOutBrand();

        await bootDev(root, parseArgv(['dev', '--target=backend'], { booleans: BOOLEAN_FLAGS }));

        ctx.expect(legCommands, 'one leg, the backend\'s start (its omega dev, the emulator suite)').toEqual(['backend: npm run start']);
      },
    },

    {
      name: 'a selected target with no `start` script is skipped loudly, and nothing spawns for it',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand({ withoutStart: ['backend'] });

        const log = await captureLogAsync(() => bootDev(root));

        ctx.expect(legCommands, 'only the target with a start script boots').toEqual(['web: npm run start']);
        ctx.expect(log, `the skip names the target and the missing script: ${log}`).toMatch(/backend: no `start` script/);
      },
    },

    {
      name: 'a fresh target gains its `start` script from the manage cycle and boots (onboard, then dev)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand({ withoutStart: ['web', 'backend'] });
        manageSideEffect = (brandRoot) => {
          for (const type of ['web', 'backend']) {
            const manifestPath = path.join(brandRoot, 'targets', type, 'package.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, scripts: { start: 'omega dev' } }));
          }
        };

        try {
          const outcome = await bootDev(root);

          ctx.expect(outcome).toBe('running');
          ctx.expect(legCommands, 'both legs boot on the scripts the cycle wrote').toEqual(['backend: npm run start', 'web: npm run start']);
        } finally {
          manageSideEffect = () => {};
        }
      },
    },

    {
      name: 'the freshness sweep runs ONCE, before the manage cycle and before any leg spawns (#340)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();

        await bootDev(root);

        ctx.expect(boot, 'one check pass covers every lane — a lane that rebuilds after the fan-out purges a sibling\'s dispatcher').toEqual([
          'sweep:@omega.js/backend,@omega.js/web',
          `manage:${root}`,
          'spawn:backend',
          'spawn:web',
        ]);
        ctx.expect(sweepHosts.length, 'ONE sweep, not one per lane').toBe(1);
      },
    },

    {
      name: 'the sweep is handed each selected lane\'s framework host, resolved from its target (#340)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();

        await bootDev(root);

        ctx.expect(sweepHosts[0], 'each host resolves from the target that declares it — the same chain the lane itself would walk').toEqual([
          { packageName: '@omega.js/backend', fromDir: path.join(root, 'targets', 'backend') },
          { packageName: '@omega.js/web', fromDir: path.join(root, 'targets', 'web') },
        ]);
      },
    },

    {
      name: 'a lane whose framework is unpicked is not swept — --target= narrows the pass too (#340)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();

        await bootDev(root, { target: 'web' });

        ctx.expect(sweepHosts[0].map((host) => host.packageName)).toEqual(['@omega.js/web']);
      },
    },

    {
      name: 'a stale monorepo-linked dist stops the boot before the manage cycle — nothing spawns (#340)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        sweepResult = {
          checked: [],
          healed: [],
          staleLinked: [{ packageName: '@omega.js/web', reason: 'dist/ is missing' }],
          healFailed: [],
          failed: [],
        };
        const root = stageFanOutBrand();

        await ctx.expect((() => bootDev(root, { target: 'web' }))()).rejects.toThrow(/@omega\.js\/web/);
        ctx.expect(boot, 'the watch owns that dist — half-booting the stack on it is what the loud stop prevents').toEqual(['sweep:@omega.js/web']);
      },
    },

    {
      name: 'a monorepo-linked dist whose sweep heal FAILED stops the boot too (#398)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        sweepResult = {
          checked: [],
          healed: [],
          staleLinked: [],
          healFailed: [{ packageName: '@omega.js/web', reason: 'dist/ is missing' }],
          failed: [],
        };
        const root = stageFanOutBrand();

        await ctx.expect((() => bootDev(root, { target: 'web' }))()).rejects.toThrow(/@omega\.js\/web/);
        ctx.expect(boot, 'with the watch down and the rebuild broken, no leg boots on that dist').toEqual(['sweep:@omega.js/web']);
      },
    },

    {
      name: 'a heal before the fan-out is announced, so the boot pause has a reason (#340)',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        sweepResult = { checked: [], healed: ['@omega.js/web'], staleLinked: [], healFailed: [], failed: [] };
        const root = stageFanOutBrand();

        const log = await captureLogAsync(() => bootDev(root, { target: 'web' }));

        ctx.expect(log).toMatch(/@omega\.js\/web/);
      },
    },

    {
      name: '#587: a locally-linked brand boots the monorepo watch — after the manage cycle, before the legs',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        spawned.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();
        const monorepo = stageMonorepo();
        linkedMonorepo = monorepo;

        try {
          const booting = bootDev(root);
          const watchChild = await waitForSpawn(1);

          // #670: a fresh watch rewrites every dist in its initial prepare pass, so
          // the legs stay down until it reports ready — a leg booting into that
          // rewrite loads a half-written CLI.
          ctx.expect(boot, 'no leg boots while the watch is still preparing').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
            `spawn:${path.basename(monorepo)}`,
          ]);

          reportWatchReady(watchChild, ['backend', 'web']);
          await booting;

          ctx.expect(boot, 'the watch starts after the sweep has settled every dist, and before any leg reads one').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
            `spawn:${path.basename(monorepo)}`,
            'spawn:backend',
            'spawn:web',
          ]);
          ctx.expect(spawned.length, 'ONE watch child, plus the two legs').toBe(3);
        } finally {
          linkedMonorepo = null;
          fs.rmSync(monorepo, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#587: the watch dies with the session — one exit hook, and it kills the child',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        spawned.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();
        const monorepo = stageMonorepo();
        linkedMonorepo = monorepo;

        try {
          const hooks = await exitHooksAddedBy(() => bootDev(root));
          const watch = spawned[0];

          ctx.expect(watch.killedWith, 'nothing killed while the session runs').toBe(undefined);

          // The boot registers other exit hooks too (the log-file tee closes its fd),
          // so the watch's own is identified by what it DOES.
          const killers = hooks.filter((hook) => {
            watch.killedWith = undefined;
            hook();
            return watch.killedWith === 'SIGTERM';
          });

          ctx.expect(killers.length, 'the session ending takes the watch with it, once — no orphan, no pile-up').toBe(1);
        } finally {
          linkedMonorepo = null;
          fs.rmSync(monorepo, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#587: a watch already running is reused, never doubled',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();
        const monorepo = stageMonorepo();
        linkedMonorepo = monorepo;
        realLocal.acquireWatchLock(monorepo); // held by a live process — this one

        try {
          await bootDev(root);

          ctx.expect(boot, 'the lock says a watch is already on the job — the legs boot, nothing else spawns').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
            'spawn:backend',
            'spawn:web',
          ]);
        } finally {
          realLocal.releaseWatchLock(monorepo);
          linkedMonorepo = null;
          fs.rmSync(monorepo, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#622: an already-running watch mid-prepare still holds the legs — the boot reads its log',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        spawned.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();
        const monorepo = stageMonorepo();
        linkedMonorepo = monorepo;
        realLocal.acquireWatchLock(monorepo); // held by a live process — this one
        const logPath = stageWatchLog(monorepo, { pid: process.pid, packages: ['backend', 'web'], reported: ['backend'] });

        try {
          await bootDev(root);

          // The playground's normal branch: Ian keeps the root watch up, so the boot
          // never spawns one — and skipping the wait let a leg require a dist the
          // watch was mid-purge on.
          ctx.expect(boot, 'web has not reported — no leg boots on a dist the running watch is still writing').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
          ]);

          fs.appendFileSync(logPath, `[web] [02:00:01] 'prepare-package': Ready for changes!\n`);
          await waitForSpawn(2);

          ctx.expect(boot, 'the pass landed in the log — the legs boot, and nothing extra spawned').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
            'spawn:backend',
            'spawn:web',
          ]);
        } finally {
          realLocal.releaseWatchLock(monorepo);
          linkedMonorepo = null;
          fs.rmSync(monorepo, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#622: a long-idle watch costs the boot nothing — its log says every package reported',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        spawned.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();
        const monorepo = stageMonorepo();
        linkedMonorepo = monorepo;
        realLocal.acquireWatchLock(monorepo); // held by a live process — this one
        stageWatchLog(monorepo, { pid: process.pid, packages: ['backend', 'web'], reported: ['backend', 'web'] });

        try {
          await bootDev(root);

          ctx.expect(boot, 'nothing is in flight — the gate reads the log and lets the boot straight through').toEqual([
            'sweep:@omega.js/backend,@omega.js/web',
            `manage:${root}`,
            'spawn:backend',
            'spawn:web',
          ]);
        } finally {
          realLocal.releaseWatchLock(monorepo);
          linkedMonorepo = null;
          fs.rmSync(monorepo, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#587: a registry-installed brand spawns no watch, and says so once',
      run: async (ctx) => {
        resetRecorders();
        resetSweep();
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageFanOutBrand();

        const log = await captureLogAsync(() => bootDev(root));

        ctx.expect(boot, 'nothing to watch — the frameworks came from the registry').toEqual([
          'sweep:@omega.js/backend,@omega.js/web',
          `manage:${root}`,
          'spawn:backend',
          'spawn:web',
        ]);
        ctx.expect(log, 'the skip is stated, not silent').toMatch(/registry/);
        ctx.expect(log.match(/registry/g).length, 'one line, not one per target').toBe(1);
      },
    },

    {
      name: 'consecutive duplicates collapse to the first line plus one count note',
      run: (ctx) => {
        ctx.expect(dedupe([LOADED, LOADED, LOADED, LOADED, '✔  functions: emulator started']), 'the emulator re-prints its infra lines once per function instance — a human reads them once').toEqual([LOADED, '  (repeated 3×)', '✔  functions: emulator started']);
      },
    },

    {
      name: 'the rule is consecutive duplicates, not a list of known noisy lines',
      run: (ctx) => {
        ctx.expect(dedupe(['[watch] rebuilding…', '[watch] rebuilding…', 'done'])).toEqual(['[watch] rebuilding…', '  (repeated 1×)', 'done']);
      },
    },

    {
      name: 'a line that comes back later is not a duplicate — only runs collapse',
      run: (ctx) => {
        ctx.expect(dedupe(['A', 'B', 'A'])).toEqual(['A', 'B', 'A']);
      },
    },

    {
      name: 'the pending count surfaces at end of stream — a leg that goes quiet never eats it',
      run: (ctx) => {
        ctx.expect(dedupe(['A', 'A', 'A'])).toEqual(['A', '  (repeated 2×)']);
      },
    },

    {
      name: 'blank lines pass through — a note in place of them reads louder than they do',
      run: (ctx) => {
        ctx.expect(dedupe(['', '', 'A'])).toEqual(['', '', 'A']);
      },
    },

    {
      name: 'each stream carries its own run — legs never dedup against each other',
      run: (ctx) => {
        const backend = createLineDeduper();
        const web = createLineDeduper();

        ctx.expect(backend.push(LOADED)).toEqual([LOADED]);
        ctx.expect(web.push(LOADED), "the sibling leg still prints its own first line").toEqual([LOADED]);
      },
    },

    {
      name: 'the booted leg prints the collapsed stream — the chatter lands once, then the count',
      run: async (ctx) => {
        resetRecorders();
        spawned.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        const log = await captureLogAsync(async () => {
          await bootDev(root, { target: 'web' });
          spawned[0].stdout.emit('data', Buffer.from(`${LOADED}\n${LOADED}\n${LOADED}\n✔  ready\n`));
        });

        ctx.expect((log.match(/Loaded environment variables/g) || []).length, 'the repeated infra line reaches the terminal exactly once').toBe(1);
        ctx.expect(log, 'and the repeats are counted, not silently dropped').toMatch(/\(repeated 2×\)/);
        ctx.expect(log, 'the leg prefix still rides every line').toMatch(/\[web\] ✔  ready/);
      },
    },

    {
      name: 'a leg booted from a terminal carries FORCE_COLOR — piped stdio would strip chalk at the source (#395)',
      run: async (ctx) => {
        ctx.expect(await forceColorForLeg({ isTTY: true }), 'the leg pipes to the orchestrator, so chalk downstream reads the switch instead of a TTY it will never see').toEqual(['1']);
      },
    },

    {
      name: 'no terminal, no forced color — and a caller that asked for it still wins (#395)',
      run: async (ctx) => {
        ctx.expect(await forceColorForLeg({ isTTY: false }), 'nothing is painting for — a runner\'s capture stays plain').toEqual(['0']);
        ctx.expect(await forceColorForLeg({ isTTY: false, inherited: '1' }), "the caller's own switch passes straight through").toEqual(['1']);
      },
    },

    {
      name: 'every leg trusts the local certificate — one CAROOT lookup, handed to all of them (#795)',
      run: async (ctx) => {
        const envs = await bootWithCaPem({ pem: '/fixture/mkcert/rootCA.pem', brandRoot: stageFanOutBrand() });

        ctx.expect(envs.map((env) => env.NODE_EXTRA_CA_CERTS), "a brand's own leg calling the public https port VERIFIES the mkcert certificate instead of reaching for the proxy's internal port").toEqual(['/fixture/mkcert/rootCA.pem', '/fixture/mkcert/rootCA.pem']);
        ctx.expect(caRootPemCalls, 'resolved once before the leg loop, not per leg').toBe(1);
      },
    },

    {
      name: 'a shell-set NODE_EXTRA_CA_CERTS wins verbatim — the boot never overwrites a trust the caller chose',
      run: async (ctx) => {
        const envs = await bootWithCaPem({ pem: '/fixture/mkcert/rootCA.pem', inherited: '/corp/bundle.pem', brandRoot: stageBrand() });

        ctx.expect(envs.map((env) => env.NODE_EXTRA_CA_CERTS)).toEqual(['/corp/bundle.pem']);
      },
    },

    {
      name: 'no mkcert on the host → the key is ABSENT, never an empty path Node would fail to read',
      run: async (ctx) => {
        const envs = await bootWithCaPem({ pem: null, brandRoot: stageBrand() });

        ctx.expect('NODE_EXTRA_CA_CERTS' in envs[0]).toBe(false);
      },
    },

    // ─── Verb log (#197, #231) ───────────────────────────────────────────────────

    {
      name: 'boot tees the brand-level fan-out to <brandRoot>/logs/dev.log, ANSI stripped',
      run: async (ctx) => {
        boot.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        // The tee declines under a runner by design; this asserts what it does when
        // it does not decline, so the signal is lifted for the duration.
        const restoreTee = require('@omega.js/devkit/attach-log-file').mark();
        try {
          await withoutCI(() => bootDev(root, { target: 'web' }));
        } finally {
          // dev() never returns, so nothing else would restore the writers.
          restoreTee();
        }

        const contents = fs.readFileSync(path.join(root, 'logs', 'dev.log'), 'utf8');
        ctx.expect(contents, "the boot banner is in the brand's dev log").toMatch(/omega dev — booting web/);
        ctx.expect(!contents.includes('\x1B['), 'the file is ANSI-free').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(root, 'logs', 'manage.log')), 'manage.log stays the service walk\'s record — a boot never truncates it (#231)').toBeTruthy();
      },
    },

    // ─── Shutdown signals the whole chain (#690) ─────────────────────────────────

    {
      name: 'legs spawn detached — each leg owns its process group, so shutdown can reach the grandchild (#690)',
      run: async (ctx) => {
        boot.length = 0;
        spawnDetached.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        await bootDev(root, { target: 'web' });

        ctx.expect(spawnDetached, 'a leg is a chain (npm → the real server); a same-group leg leaks the grandchild on a programmatic stop').toEqual([true]);
      },
    },

    {
      name: 'stopChild signals the process GROUP, and falls back to the direct child when the group is gone (#690)',
      run: (ctx) => {
        const calls = [];
        const child = { pid: 4242, kill: (signal) => calls.push(`direct:${signal}`) };

        devCommand.stopChild(child, (pid, signal) => calls.push(`group:${pid}:${signal}`));
        ctx.expect(calls, 'the group signal reaches npm AND the emulator behind it').toEqual(['group:-4242:SIGTERM']);

        calls.length = 0;
        devCommand.stopChild(child, () => { throw new Error('ESRCH'); });
        ctx.expect(calls, 'a dead group still gets the direct kill').toEqual(['direct:SIGTERM']);
      },
    },

    {
      name: '#629: the boot registers the ONE stop-signal list — a closed terminal (SIGHUP) unwinds the legs too',
      run: async (ctx) => {
        boot.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        // A signal with no listener is not a shutdown: node kills the orchestrator
        // outright, and the legs (detached, so its group signal never reaches them)
        // orphan with the emulator tree behind them. So the diff is per signal, and
        // the list is the devkit one every supervisor registers, never a subset
        // typed here.
        const before = Object.fromEntries(STOP_SIGNALS.map((signal) => [signal, process.listeners(signal)]));
        const added = {};

        await bootDev(root, { target: 'web' });

        try {
          STOP_SIGNALS.forEach((signal) => {
            added[signal] = process.listeners(signal).filter((fn) => !before[signal].includes(fn));

            ctx.expect(added[signal].length, `${signal} must reach the orchestrator's shutdown, or the run dies with its legs still up`).toBe(1);
          });
        } finally {
          // This process outlives the case; a handler left behind would answer for
          // every case after it.
          STOP_SIGNALS.forEach((signal) => (added[signal] || []).forEach((fn) => process.removeListener(signal, fn)));
        }
      },
    },

    // ─── The lockstep gate (#794) ────────────────────────────────────────────────

    {
      name: 'a drifted @omega.js version REFUSES the boot before anything runs — no sweep, no manage, no leg',
      run: async (ctx) => {
        boot.length = 0;
        manageReport = { hasErrors: false, results: {}, brand: {} };
        const root = stageBrand();

        // The target's installed framework is a release behind the manager: what
        // `omega update` exists to fix, and what nothing downstream can see
        const installed = path.join(root, 'targets', 'web', 'node_modules', '@omega.js', 'web');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@omega.js/web', version: '0.0.1' }));

        await ctx.expect((() => bootDev(root, { target: 'web' }))()).rejects.toThrow((error) => {
            ctx.expect(error.refusal, 'a refusal prints its message alone').toBe(true);
            ctx.expect(error.message).toMatch(/@omega\.js\/web 0\.0\.1/);
            ctx.expect(error.message).toMatch(/fix: run `omega update` at the brand root/);
            return true;
          });

        ctx.expect(boot, 'the gate is the FIRST thing the boot does — the sweep never even ran').toEqual([]);
      },
    },
  ],
});
