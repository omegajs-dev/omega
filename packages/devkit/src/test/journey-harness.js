/**
 * The standing wizard-journey e2e: the whole consumer story OUTSIDE the monorepo.
 * Birth clones the brand template and runs the REAL onboard (flags mode) in it;
 * link is one `omega i local` at the brand root; boot is `omega dev` plus a
 * homepage probe; manage runs headless, judged by its run file. Spec-driven,
 * heavy by design: each stage is a `JourneyRun` method the root journey lane runs
 * as one case, and `checkPreconditions` names what the machine lacks to run it.
 * Install legs keep the machine env; runtime legs run credential-scrubbed.
 *
 * Layering: bins are spawned by path and @omega.js/manager is never required
 * (the manager depends on devkit), save the manager's template marker source and
 * template fixture, read by path at run time to judge the clone.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { isDeepStrictEqual } = require('node:util');
const { spawn, spawnSync } = require('node:child_process');
const { afterExit } = require('./boot-child.js');
const { scrubCredentialEnv } = require('./credential-scrub.js');
const { targetOfType } = require('./target-of-type.js');
const { resolvePackageRealDir } = require('../local.js');
const { missingMachineTools, machineToolLine } = require('../machine-tools.js');
const { ENV_FILE } = require('../env-file.js');
const { TARGET_TYPE_TWIN } = require('../verbs.js');

// Ceilings, not expectations — cold-cache registry installs and the four
// real target builds dominate; a warm rerun finishes far inside them.
const TIMEOUTS = {
  clone: 120000,
  onboard: 120000,
  link: 1800000,
  bootReady: 420000,
  probe: 120000,
  manage: 2400000,
};

// The type ids in schema order, a cosmetic boot ordering: the targets come from
// the scaffold output on disk. A type id is also the name the wizard gives a
// brand's first target of that type.
const TARGET_TYPE_IDS = TARGET_TYPE_TWIN.map((row) => row.id);

// Lockstep with @omega.js/backend cli/commands/emulator.js (same marker the
// devkit e2e-harness waits for — it fires AFTER persona seeding).
const EMULATOR_READY = /Emulator ready\. Press Ctrl\+C/i;
// The backend's persona seed (cli/commands/emulator.js): a boot whose functions
// never loaded cannot print the seeded line, and the journey brand has a
// brand.url, so a skipped or broken seed is a broken boot.
const PERSONAS_SEEDED = /✓ Personas seeded \(\d+ accounts\)/;
const PERSONA_SEED_FAILED = /Persona seeding (failed|completed with errors)|Skipping persona seeding/;
// The manager's line when one target's leg exits under a brand-root `omega dev`.
const LEG_EXITED = /✖ \w+ exited \(code \d+\)/;
// The web dev server's announce line (packages/web src/commands/dev.js).
const DEV_SERVER_URL = /Dev server: (https?:\/\/localhost:\d+)/;
// The two template files a clone carries the marker in and onboard replaces.
const TEMPLATE_FILES = ['package.json', 'README.md'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether an https URL answers at all (any status), within 8s. */
function reachable(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 8000 }, (response) => {
      response.resume();
      resolve(response.statusCode > 0);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

/**
 * Journey preconditions: the npm registry (framework dep trees install for
 * real), the brand template's host (the brand is born from a clone) and
 * the machine tools its backend needs (devkit's machine-tools list).
 *
 * @param {string} templateUrl - The brand template repo the birth step clones
 * @returns {Promise<{ ok: boolean, missing: string[] }>}
 */
async function checkPreconditions(templateUrl) {
  const missing = [];

  if (!await reachable('https://registry.npmjs.org/-/ping')) {
    missing.push('npm registry unreachable (network)');
  }
  if (!await reachable(templateUrl)) {
    missing.push(`brand template unreachable (network): ${templateUrl}`);
  }

  // The brand the journey births has a Firebase backend, the emulators' host
  missing.push(...missingMachineTools([{ name: 'backend', type: 'backend' }]).map(machineToolLine));

  return { ok: missing.length === 0, missing };
}

/** Newest run file in <brandRoot>/.omega/runs (ISO-stamped names sort). */
function latestRunFile(brandRoot) {
  const runsDir = path.join(brandRoot, '.omega', 'runs');
  let names;
  try {
    names = fs.readdirSync(runsDir).filter((name) => name.endsWith('.json')).sort();
  } catch (e) {
    return null;
  }
  return names.length > 0 ? path.join(runsDir, names.at(-1)) : null;
}

/** The brand's target dirs (scaffold output truth), in TARGET_TYPE_IDS order. */
function discoverBrandTargets(brandRoot) {
  const targetsDir = path.join(brandRoot, 'targets');
  let entries;
  try {
    entries = fs.readdirSync(targetsDir);
  } catch (e) {
    return [];
  }
  return entries
    .filter((name) => fs.existsSync(path.join(targetsDir, name, 'package.json')))
    .sort((a, b) => {
      const rank = (name) => { const i = TARGET_TYPE_IDS.indexOf(name); return i === -1 ? TARGET_TYPE_IDS.length : i; };
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .map((name) => path.join(targetsDir, name));
}

/** GET a URL (self-signed ok), resolving { status, body }. */
function fetchPage(url) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { rejectUnauthorized: false, timeout: 15000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => { request.destroy(new Error(`timeout fetching ${url}`)); });
    request.on('error', reject);
  });
}

/** The manager's own template answers, read by path (the layering note's exception). */
function templateAnswers(monorepoRoot) {
  const managerDir = path.join(monorepoRoot, 'packages', 'manager');
  const { TEMPLATE_URL, carriesTemplateMarker } = require(path.join(managerDir, 'src', 'lib', 'template-marker.js'));
  const { TEMPLATE_PACKAGE } = require(path.join(managerDir, 'test', 'lib', 'brand-template.js'));
  return { TEMPLATE_URL, carriesTemplateMarker, TEMPLATE_PACKAGE, managerBin: path.join(managerDir, 'dist', 'cli-run.js') };
}

/**
 * One wizard journey for one brand spec: each stage is a method returning its
 * detail line, run in order by the root journey lane, and `finish()` tears down.
 *
 * @param {Object} options
 * @param {string} options.monorepoRoot - The omega monorepo (framework source)
 * @param {Object} options.spec - { id, origin, url, targets: string[], expect: { brandName, themeId }, allowedServiceErrors? }; origin is the clone's own repo URL
 * @param {string} options.logDir - Where stage logs land (created; survives the run)
 * @param {boolean} [options.keep] - Keep the temp brand even on success
 * @param {Function} [options.log] - Line sink (default console.log)
 */
class JourneyRun {
  constructor(options) {
    this.monorepoRoot = fs.realpathSync(options.monorepoRoot);
    this.spec = options.spec;
    this.keep = Boolean(options.keep);
    this.logDir = options.logDir;
    this.log = options.log || console.log;
    fs.mkdirSync(this.logDir, { recursive: true });

    this.tempRoot = null;
    this.brandRoot = null;
    this.devStack = null; // live `omega dev` handle
    this.orphansAtBoot = null;
    this.complete = false; // set by the last stage: anything short of it is a red run
    this.logIndex = 0;
  }

  /** Birth: a real clone of the brand template, its origin the spec's own repo. */
  async clone() {
    const { spec } = this;
    const { TEMPLATE_URL, carriesTemplateMarker, TEMPLATE_PACKAGE } = templateAnswers(this.monorepoRoot);
    if (!spec.origin) {
      throw new Error('spec.origin is required: the repo a "Use this template" copy has as its origin');
    }
    this.tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'omega-journey-'));
    this.brandRoot = path.join(this.tempRoot, spec.id);

    await this.runToExit('clone', 'git', ['clone', '--depth', '1', TEMPLATE_URL, this.brandRoot],
      { cwd: this.tempRoot, env: this.childEnv(), timeout: TIMEOUTS.clone });
    // A user's copy has their own repo as origin; it is never fetched
    await this.runToExit('origin', 'git', ['remote', 'set-url', 'origin', spec.origin],
      { cwd: this.brandRoot, env: this.childEnv(), timeout: TIMEOUTS.clone });

    const pkg = JSON.parse(fs.readFileSync(path.join(this.brandRoot, 'package.json'), 'utf8'));
    if (!isDeepStrictEqual(pkg, TEMPLATE_PACKAGE)) {
      throw new Error(`the template's package.json drifted from TEMPLATE_PACKAGE (packages/manager/test/lib/brand-template.js): ${JSON.stringify(pkg)}`);
    }
    const unmarked = TEMPLATE_FILES.filter((file) => !carriesTemplateMarker(path.join(this.brandRoot, file)));
    if (unmarked.length > 0) {
      throw new Error(`the clone's ${unmarked.join(' and ')} carry no template marker`);
    }
    return `${TEMPLATE_URL} → ${this.brandRoot}, origin ${spec.origin}`;
  }

  /** The real wizard (flags mode) replaces the template with the spec's brand. */
  async onboard() {
    const { spec } = this;
    const { carriesTemplateMarker, managerBin } = templateAnswers(this.monorepoRoot);
    // The local manager by path, never the template's `npm start`: its npm install
    // fetches the published manager. --no-dev leaves install and boot to the legs below.
    await this.runToExit('onboard', process.execPath, [
      managerBin, 'onboard',
      `--id=${spec.id}`, `--url=${spec.url}`, `--targets=${spec.targets.join(',')}`, '--no-dev',
    ], { cwd: this.brandRoot, env: this.childEnv(), timeout: TIMEOUTS.onboard });

    for (const file of ['config/omega.json5', 'package.json', ENV_FILE, '.gitignore']) {
      if (!fs.existsSync(path.join(this.brandRoot, file))) {
        throw new Error(`scaffold missing ${file}`);
      }
    }
    const marked = TEMPLATE_FILES.filter((file) => carriesTemplateMarker(path.join(this.brandRoot, file)));
    if (marked.length > 0) {
      throw new Error(`the first run left the template's ${marked.join(' and ')} in place`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(this.brandRoot, 'package.json'), 'utf8'));
    if (pkg.name !== spec.id || pkg.omega?.template !== undefined) {
      throw new Error(`package.json is not the generated brand manifest (name ${pkg.name}, omega ${JSON.stringify(pkg.omega)})`);
    }
    return this.brandRoot;
  }

  /** One `i local` at the brand root links the whole tree to the monorepo. */
  async link() {
    const targets = discoverBrandTargets(this.brandRoot);
    // The manager's own entry: nothing is installed in the brand yet for a dispatcher to resolve it from
    const { managerBin } = templateAnswers(this.monorepoRoot);
    await this.runToExit('link', process.execPath, [managerBin, 'i', 'local'],
      { cwd: this.brandRoot, env: this.childEnv(), timeout: TIMEOUTS.link });

    // Every target's framework, and the brand root's manager, must resolve
    // to the monorepo copy (realpath through the hoisted symlinks).
    const misses = [];
    for (const dir of [this.brandRoot, ...targets]) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (!name.startsWith('@omega.js/')) continue;
        const real = resolvePackageRealDir(name, dir);
        if (!real || !real.startsWith(this.monorepoRoot)) {
          misses.push(`${path.basename(dir)}:${name} → ${real || 'unresolved'}`);
        }
      }
    }
    if (misses.length > 0) {
      throw new Error(`not linked to the monorepo: ${misses.join(', ')}`);
    }
    return `${targets.length} targets + brand root`;
  }

  /** The boot legs resolve by TYPE: a backend named `api` boots exactly like a web target named `site`. */
  bootTargets() {
    return { web: targetOfType(this.brandRoot, 'web'), backend: targetOfType(this.brandRoot, 'backend') };
  }

  /** `omega dev` at the brand root, ready once every booted target announces itself and a backend seeds its personas. */
  async bootDev() {
    const { web, backend } = this.bootTargets();
    if (!web && !backend) return 'no web or backend target: nothing to boot';
    this.orphansAtBoot = emulatorOrphans();

    const readyPatterns = {};
    // Any leg that exits is a failed boot, whichever target it was.
    const failPatterns = { leg: LEG_EXITED };
    if (web) readyPatterns.web = DEV_SERVER_URL;
    if (backend) {
      readyPatterns.backend = EMULATOR_READY;
      readyPatterns.seeded = PERSONAS_SEEDED;
      failPatterns.seed = PERSONA_SEED_FAILED;
    }

    this.devStack = this.startServer('dev', this.dispatcherBin(this.brandRoot), ['dev'], {
      cwd: this.brandRoot,
      env: this.childEnv({ OMEGA_NON_INTERACTIVE: '1' }, { scrub: true }),
      readyPatterns,
      failPatterns,
      timeout: TIMEOUTS.bootReady,
    });
    await this.devStack.ready;
    return web ? this.devStack.matches.web[1] : 'emulator ready';
  }

  /** The booted homepage carries the spec's brand name and theme. */
  async homepage() {
    const { spec } = this;
    if (!this.bootTargets().web) return 'no web target';
    const url = this.devStack.matches.web[1];
    const deadline = Date.now() + TIMEOUTS.probe;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const page = await fetchPage(`${url}/`);
        last = `status ${page.status}`;
        if (page.status === 200
          && page.body.includes(spec.expect.brandName)
          && page.body.includes(`data-theme-id="${spec.expect.themeId}"`)) {
          return `${url}/ → 200, "${spec.expect.brandName}", theme ${spec.expect.themeId}`;
        }
        if (page.status === 200) {
          const missing = [
            !page.body.includes(spec.expect.brandName) && `brand name "${spec.expect.brandName}"`,
            !page.body.includes(`data-theme-id="${spec.expect.themeId}"`) && `theme id "${spec.expect.themeId}"`,
          ].filter(Boolean);
          last = `200 but missing ${missing.join(' + ')}`;
        }
      } catch (error) {
        last = error.message;
      }
      await sleep(2000);
    }
    throw new Error(`homepage never satisfied the probe (last: ${last})`);
  }

  /**
   * Dev boot materializes the sample filler under the web target's gitignored
   * .omega/sample-content with LIVE rolling dates: no OMEGA_SAMPLE_ANCHOR pin, so
   * the newest post lands ~10 days before today (±1 day absorbs a UTC midnight).
   */
  async sampleContent() {
    const { web } = this.bootTargets();
    if (!web) return 'no web target';
    const sampleRoot = path.join(web.dir, '.omega', 'sample-content');
    const posts = fs.readdirSync(path.join(sampleRoot, '_posts')).sort();
    if (posts.length !== 11) throw new Error(`expected 11 sample posts, found ${posts.length}`);
    if (fs.readFileSync(path.join(sampleRoot, '.gitignore'), 'utf8') !== '*\n') {
      throw new Error('self-.gitignore missing: the tree must be uncommittable');
    }
    const newest = posts[posts.length - 1].slice(0, 10);
    const ageDays = Math.round((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000);
    if (ageDays < 9 || ageDays > 11) {
      throw new Error(`newest sample post is dated ${newest} (${ageDays}d ago): rolling dates broken`);
    }
    return `11 posts, newest ${newest} (~10d ago), self-gitignored`;
  }

  /** The dev stack stops, and no emulator it started is left orphaned on pid 1. */
  async shutdown() {
    const { web, backend } = this.bootTargets();
    if (!web && !backend) return 'nothing booted';
    await this.devStack.stop();
    this.devStack = null;
    await this.assertNoOrphans();
    return this.orphansAtBoot === null ? 'stopped (no ps: orphan check skipped)' : 'no orphaned emulator left behind';
  }

  /**
   * A shutdown that killed npm but not the emulator leaves NEW pid-1 processes
   * holding the ports. The tail of the backend's own sweep can lag the stop by
   * a beat, so poll briefly.
   */
  async assertNoOrphans() {
    if (this.orphansAtBoot === null) return;
    const before = new Set(this.orphansAtBoot.map((proc) => proc.pid));
    const deadline = Date.now() + 5000;
    let leaked = [];
    for (;;) {
      leaked = (emulatorOrphans() || []).filter((proc) => !before.has(proc.pid));
      if (leaked.length === 0 || Date.now() > deadline) break;
      await sleep(250);
    }
    if (leaked.length > 0) {
      throw new Error(`emulator leaked onto pid 1 (#690): ${leaked.map((proc) => `${proc.pid} ${proc.command}`).join('; ')}`);
    }
  }

  /** Headless, creds scrubbed, judged by the run file: update builds every target. */
  async manage() {
    const { spec } = this;
    // Exit code is judged via the run file: a designed testing-service error (live
    // probe of a never-deployed brand) may flip the exit. A headless run cannot
    // collect the ship credentials a declared store format needs, so the publishing
    // service refuses by design; the walk keeps going and the allowed set names it.
    await this.runToExit('manage', this.dispatcherBin(this.brandRoot), ['manage', '--continue-on-error'], {
      cwd: this.brandRoot,
      env: this.childEnv({ OMEGA_NON_INTERACTIVE: '1' }, { scrub: true }),
      timeout: TIMEOUTS.manage,
      allowNonzeroExit: true,
    });

    const runFile = latestRunFile(this.brandRoot);
    if (!runFile) {
      throw new Error('manage left no .omega/runs/*.json run file');
    }
    const services = (JSON.parse(fs.readFileSync(runFile, 'utf8')).services || []);
    const byName = Object.fromEntries(services.map((entry) => [entry.service, entry]));

    if (byName.update?.status !== 'success') {
      throw new Error(`update service ${byName.update ? byName.update.status : 'missing'}: ${byName.update?.error || 'no error detail'} (${runFile})`);
    }
    const allowedErrors = new Set(spec.allowedServiceErrors || ['testing']);
    const unexpected = services.filter((entry) => entry.status === 'error' && !allowedErrors.has(entry.service));
    if (unexpected.length > 0) {
      throw new Error(`unexpected service errors: ${unexpected.map((entry) => `${entry.service} (${entry.error || 'no detail'})`).join(', ')} (${runFile})`);
    }

    const { web } = this.bootTargets();
    if (web && !fs.existsSync(path.join(web.dir, 'dist', 'index.html'))) {
      throw new Error(`update reported success but ${web.name}/dist/index.html is missing`);
    }
    this.complete = true;
    return `${services.length} services; update success; errors only in {${[...allowedErrors].join(', ')}}`;
  }

  /**
   * Teardown: stop a dev stack a red run left live, keep the temp brand on a red
   * run (or by request) for debugging, else remove it; then the orphan check
   * against that stop.
   */
  async finish() {
    const live = this.devStack !== null;
    if (live) {
      await this.devStack.stop().catch(() => {});
      this.devStack = null;
    }
    if (this.tempRoot && this.complete && !this.keep) {
      fs.rmSync(this.tempRoot, { recursive: true, force: true });
    } else if (this.tempRoot) {
      this.log(`\n  brand kept for inspection: ${this.brandRoot}`);
    }
    if (live) await this.assertNoOrphans();
  }

  logFile(stage) {
    this.logIndex += 1;
    return path.join(this.logDir, `${String(this.logIndex).padStart(2, '0')}-${stage}.log`);
  }

  /**
   * Spawn a child (own process group), tee output to a stage log, and
   * resolve on exit — rejecting on timeout or nonzero exit.
   */
  runToExit(stage, command, args, options) {
    const logFile = this.logFile(stage);
    const logStream = fs.createWriteStream(logFile);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stopGroup(child); // graceful escalation continues in the background
        reject(new Error(`${stage} exceeded ${options.timeout / 60000} min (log: ${logFile})`));
      }, options.timeout);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        logStream.end();
        if (code === 0 || (code !== null && options.allowNonzeroExit)) {
          resolve({ code, logFile });
        } else {
          reject(new Error(`${stage} exited ${code} (log: ${logFile})`));
        }
      });
    });
  }

  /**
   * Spawn a long-lived server child and resolve once every ready pattern
   * has matched a line of its output; a fail pattern's match stops the child
   * and rejects at once. Returns { child, matches, stop }.
   */
  startServer(stage, command, args, options) {
    const logFile = this.logFile(stage);
    const logStream = fs.createWriteStream(logFile);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const matches = {};
    const pending = new Map(Object.entries(options.readyPatterns));
    const failPatterns = Object.entries(options.failPatterns || {});
    let buffered = '';
    let failed = false; // later chunks still match: stop the group once

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stopGroup(child); // graceful escalation continues in the background
        reject(new Error(`${stage} not ready after ${options.timeout / 60000} min — waiting on: ${[...pending.keys()].join(', ')} (log: ${logFile})`));
      }, options.timeout);

      const scan = (chunk) => {
        const text = chunk.toString();
        logStream.write(text);
        buffered = (buffered + text).slice(-65536);
        for (const [name, pattern] of pending) {
          const match = buffered.match(pattern);
          if (match) {
            matches[name] = match;
            pending.delete(name);
          }
        }
        // Only while the boot is pending: once ready settled, the stack is the stages' to stop.
        for (const [key, pattern] of (pending.size ? failPatterns : [])) {
          const match = buffered.match(pattern);
          if (match && !failed) {
            failed = true;
            clearTimeout(timer);
            stopGroup(child);
            // The whole line the pattern sat on: the text after the match is the detail.
            const lineStart = buffered.lastIndexOf('\n', match.index) + 1;
            const lineEnd = buffered.indexOf('\n', match.index);
            const line = buffered.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
            reject(new Error(`${stage} failed on ${key}: ${line} (log: ${logFile})`));
            return;
          }
        }
        if (pending.size === 0) {
          clearTimeout(timer);
          resolve();
        }
      };

      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('exit', () => clearTimeout(timer));
      afterExit(child, logStream).then((code) => {
        if (pending.size > 0) {
          reject(new Error(`${stage} exited early (code ${code}, log: ${logFile})`));
        }
      });
    });

    const stop = () => stopGroup(child);

    return { child, matches, ready, stop, logFile };
  }

  /** The consumer entrypoint: the brand's own hoisted dispatcher bin. */
  dispatcherBin(fromDir) {
    for (const dir of [fromDir, this.brandRoot]) {
      const bin = path.join(dir, 'node_modules', '.bin', 'omega');
      if (fs.existsSync(bin)) return bin;
    }
    throw new Error(`no omega bin under ${fromDir} or the brand root — did the link leg run?`);
  }

  childEnv(extra, { scrub = false } = {}) {
    const base = scrub ? scrubCredentialEnv(process.env, this.tempRoot) : { ...process.env };
    // A throwaway Claude Code config: the plugin steps of onboard, `i local`
    // and manage never reach the developer's own.
    const claudeConfig = path.join(this.tempRoot, 'claude');
    return { ...base, OMEGA_MONOREPO: this.monorepoRoot, CLAUDE_CONFIG_DIR: claudeConfig, ...extra };
  }
}

function killGroup(child, signal = 'SIGKILL') {
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    try { child.kill(signal); } catch (e2) { /* already gone */ }
  }
}

/**
 * Graceful group shutdown: SIGINT first (firebase-tools reaps its java
 * emulators on SIGINT; an immediate SIGKILL orphans them — cp195 leak),
 * escalate to SIGKILL only if the group is still alive after the grace
 * window.
 */
async function stopGroup(child, graceMs = 20000) {
  // A child taken by a signal has no exitCode; it is just as gone.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Unref'd grace timers: a child that exits first must not hold the process open for the rest.
  const grace = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
  killGroup(child, 'SIGINT');
  const outcome = await Promise.race([exited.then(() => 'clean'), grace(graceMs)]);
  if (outcome !== 'clean') {
    killGroup(child, 'SIGKILL');
    await Promise.race([exited, grace(5000)]);
  }
}

/**
 * Emulator processes already orphaned onto pid 1 — the #690 leak signature.
 * Read before boot and again after shutdown: only NEW pids indict this run
 * (another session's leftovers are not this journey's verdict). Returns null
 * where `ps` is unavailable, and the caller skips the check.
 */
function emulatorOrphans() {
  const ps = spawnSync('ps', ['ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (ps.error || ps.status !== 0) return null;
  return ps.stdout.split('\n').reduce((orphans, line) => {
    const match = line.match(/^\s*(\d+)\s+1\s+(.*)$/);
    if (match && /firebase emulators:start|cloud-firestore-emulator|pubsub-emulator/.test(match[2])) {
      orphans.push({ pid: Number(match[1]), command: match[2] });
    }
    return orphans;
  }, []);
}

module.exports = { JourneyRun, TIMEOUTS, checkPreconditions, latestRunFile, discoverBrandTargets };
