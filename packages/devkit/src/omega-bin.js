/**
 * omega-bin: the context-aware dispatcher behind every framework's `omega`/`omg`/`mgr`
 * bin. npm links one arbitrary winner of those bins, so this resolves the ROOT that owns
 * the cwd (a brand root, a standalone target, the monorepo root) and runs THAT root's CLI.
 * Below a root, a verb runs in place only inside a target of one of its owner frameworks;
 * any other verb refuses and prints the root form. A verb that needs no brand and that
 * only the manager owns runs the manager wherever it is typed. Stdlib plus its data
 * siblings (verbs.js, target-picker.js): it is vendored into every framework dist.
 * The contract: docs/devkit/index.md.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const { VERBS, TARGET_TYPE_TWIN, TARGET_ORDER, tokensOf, findVerb } = require('./verbs.js');
const { PICKER_FLAG, takePicker } = require('./target-picker.js');
const { isMonorepoRoot } = require('./monorepo-root.js');

// The framework packages, in the type rows' order: a multi-framework manifest
// dispatches the first framework in this order among those it declares.
const FRAMEWORK_NAMES = TARGET_TYPE_TWIN.map((row) => row.framework).filter(Boolean);

const MANAGER = '@omega.js/manager';

// Every package in the OMEGA monorepo carries this name prefix; no consumer
// target ever does. A manifest with it IS the package, never a project built
// on top of one (#757).
const OMEGA_SCOPE = '@omega.js/';

// Dirs that are a VIEW of the target one level up, never a context of their own:
// a backend's runtime cwd (functions/) and its staged build output (dist/,
// which carries a COMPOSED config/omega.json5 that would otherwise read as a
// brand root). Stdlib twin of @omega.js/config's TARGET_SUBDIRS — that module is
// the canonical list ([#307](https://github.com/Omega-JS-Stack/omega/issues/307)).
const TARGET_SUBDIRS = ['functions', 'dist'];

// The verbs that run with NO target context, every spelling (a flag-style alias
// selects a verb too): the registry's contextless rows. Any other verb run where
// no target exists would scaffold one into the cwd.
const CONTEXTLESS_VERBS = new Set(VERBS.filter((entry) => entry.scope === 'contextless').flatMap(tokensOf));

// The signing box's verbs. A box that hosts the Windows EV signing runner is a
// MACHINE, not a project: `omega runner` and `omega sign-windows` read their
// configuration from the runner home and run from any directory. Both belong
// to @omega.js/desktop, so with no target they go to desktop's CLI — the host
// when desktop won the bin link (a bare `npm i -g @omega.js/desktop`), else
// desktop resolved from the cwd (a monorepo checkout, a brand root) — and
// refuse naming the install when it is nowhere. They scaffold nothing
// ([#337](https://github.com/Omega-JS-Stack/omega/issues/337)).
const BOX_VERBS = new Set(VERBS.filter((entry) => entry.scope === 'box').map((entry) => entry.name));
const DESKTOP = '@omega.js/desktop';

// The contextless verbs only the manager answers, every spelling (onboard,
// status): no framework CLI knows them, so they run the manager wherever they
// are typed, inside a target included.
const MANAGER_VERBS = new Set(VERBS
  .filter((entry) => entry.scope === 'contextless' && entry.owners.every((owner) => owner === MANAGER))
  .flatMap(tokensOf));

/**
 * The signing-box verb this invocation selects, or null. The ONE reading of
 * "is this the box's", shared by the dispatcher below and by
 * @omega.js/desktop's CLI (which skips the project `.env` cascade for exactly
 * these) — two readings would drift, and the drift is a brand's token reaching
 * the box.
 *
 * Both spellings count: the bare token (`omega runner status`) and the `--`
 * flag desktop's alias table takes (`omega --runner`, `omega --sign-windows
 * --smoke`). `--help` is never one: it prints help, in every spelling. A box
 * verb sitting in an ARGUMENT position is not one either — `omega test runner`
 * runs the test verb — so the first positional has to be the box verb itself.
 *
 * @param {string[]} argv - Arguments after the bin name.
 * @returns {string|null} The box verb's canonical name, or null.
 */
function boxVerbOf(argv) {
  argv = argv || [];
  if (argv.includes('--help') || argv.includes('-h')) return null;

  const positional = argv.find((arg) => !arg.startsWith('-'));
  if (positional && BOX_VERBS.has(positional)) return positional;

  const flag = argv.find((arg) => arg.startsWith('--') && BOX_VERBS.has(arg.slice(2)));
  return flag ? flag.slice(2) : null;
}

/**
 * Boolean half of boxVerbOf — what callers that only need the yes/no ask.
 *
 * @param {string[]} argv - Arguments after the bin name.
 * @returns {boolean}
 */
function isBoxVerbArgv(argv) {
  return boxVerbOf(argv) !== null;
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function frameworksOf(pkg) {
  if (!pkg) return [];
  const declared = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  return FRAMEWORK_NAMES.filter((name) => declared[name]);
}

/**
 * Is `dir` a brand-monorepo root? Carries a config/omega.json5 that is not
 * itself a TARGET_SUBDIR view (functions/, dist/) and not a TARGET of a brand above
 * it (directly under a targets/ dir whose parent also carries a brand config).
 * Stdlib twin of @omega.js/config's resolveBrandRoot rule — that module is the
 * canonical definition; this copy exists because the dispatcher cannot depend
 * on @omega.js/config.
 */
function isBrandRoot(dir) {
  if (TARGET_SUBDIRS.includes(path.basename(path.resolve(dir)))) return false;
  if (!fs.existsSync(path.join(dir, 'config', 'omega.json5'))) return false;

  const parent = path.dirname(dir);
  const isTargetOfBrand = path.basename(parent) === 'targets'
    && fs.existsSync(path.join(path.dirname(parent), 'config', 'omega.json5'));

  return !isTargetOfBrand;
}

/**
 * Walk up from startDir to the nearest dispatch context: a dir declaring a
 * framework (a target), then a brand root, then the monorepo root. An `@omega.js/*`
 * package's own root is never a target (its devDependencies on sibling frameworks
 * would read as one), so the walk passes it and keeps the nearest for the monorepo's
 * root form. The walk stops at the nearest `.git`, that directory still checked.
 *
 * @returns {{ kind: 'framework', name: string, dir: string }
 *   | { kind: 'brand', dir: string }
 *   | { kind: 'monorepo', dir: string, package?: { name: string, dir: string } } | null}
 */
function findTarget(startDir) {
  let dir = path.resolve(startDir);
  let omegaPackage = null;
  while (true) {
    const pkg = readPackage(dir);
    const isOmegaPackage = !!pkg && typeof pkg.name === 'string' && pkg.name.startsWith(OMEGA_SCOPE);

    if (isOmegaPackage) {
      omegaPackage = omegaPackage || { name: pkg.name, dir };
    } else {
      const matches = frameworksOf(pkg);
      if (matches.length > 1) {
        // Targets are one-framework-per-target by design: a multi-framework
        // manifest dispatches by FRAMEWORK_NAMES order, which must never be silent.
        console.error(`omega: ${dir} declares ${matches.length} frameworks (${matches.join(', ')}): dispatching ${matches[0]}`);
      }
      const own = matches[0] || null;
      if (own) return { kind: 'framework', name: own, dir };

      if (isBrandRoot(dir)) {
        return { kind: 'brand', dir };
      }
    }

    if (isMonorepoRoot(dir)) {
      return omegaPackage ? { kind: 'monorepo', dir, package: omegaPackage } : { kind: 'monorepo', dir };
    }

    // Repo boundary — stop here rather than statting out through the host
    // filesystem to /.
    if (fs.existsSync(path.join(dir, '.git'))) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The root a context runs its verbs from, what kind of root it is, and the
 * `--target=` word that picks the cwd's target or package there (null when the
 * cwd sits in none).
 *
 * @returns {{ dir: string, kind: 'brand'|'target'|'monorepo', target: string|null }}
 */
function rootOf(context, cwd) {
  if (context.kind === 'framework') {
    const targetsDir = path.dirname(context.dir);
    const brandRoot = path.dirname(targetsDir);
    // A target under a brand's targets/ runs from the brand root; a standalone target is its own root
    if (path.basename(targetsDir) === 'targets' && isBrandRoot(brandRoot)) {
      return { dir: brandRoot, kind: 'brand', target: path.basename(context.dir) };
    }
    return { dir: context.dir, kind: 'target', target: null };
  }

  if (context.kind === 'monorepo') {
    return { dir: context.dir, kind: 'monorepo', target: context.package ? path.basename(context.package.dir) : null };
  }

  // A brand: a dir under targets/ with no framework dep is still a target (a custom one)
  const [top, name] = path.relative(context.dir, cwd).split(path.sep);
  return { dir: context.dir, kind: 'brand', target: top === 'targets' && name ? name : null };
}

/** Does the verb this token selects run in place below its root? */
function ownsInPlace(context, token) {
  // Only in a TARGET of one of its owner frameworks (a brand target or a standalone project); framework source is never a target
  if (context.kind !== 'framework') return false;
  // Every row the token selects counts: `serve` is web's dev alias and the backend's own verb
  return VERBS.some((row) => tokensOf(row).includes(token) && row.owners.includes(context.name));
}

/** Refuse a verb run below its root, printing the one command that runs it. */
function refuseOutsideRoot(verb, argv, root, row) {
  const rest = argv.filter((arg, index) => index !== argv.indexOf(verb));
  // A brand-wide verb (only the manager owns it) runs once for the whole brand, so it picks no target
  const brandWide = root.kind === 'brand' && !!row && row.owners.every((owner) => owner === MANAGER);
  const picker = root.target && !brandWide ? ` --${PICKER_FLAG}=${root.target}` : '';
  const form = root.kind === 'monorepo'
    ? monorepoForm(root.dir, verb, rest, root.target)
    : [`npx omega ${verb}${picker}`, ...rest].join(' ');
  console.error(`omega: refusing to run "${verb}" in ${process.cwd()}: this verb runs at the ${root.kind} root. Run: cd ${root.dir} && ${form}`);
  process.exit(1);
}

/**
 * Resolve a dispatch target's ./cli from where it is declared.
 * @returns {{ cliPath: string } | { error: Error }} — callers decide whether an
 *   unresolvable target is fatal (cross-framework) or falls back (brand).
 */
function tryResolveCli(name, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  try {
    return { cliPath: req.resolve(`${name}/cli`) };
  } catch (e) {
    return { error: e };
  }
}

/** Resolve a dispatch target's ./cli from where it is declared, with a clear failure. */
function resolveCli(name, fromDir, hint) {
  const { cliPath, error } = tryResolveCli(name, fromDir);
  if (error) {
    console.error(`omega: found ${name} context (${fromDir}) but could not resolve '${name}/cli': ${error.message}`);
    console.error(hint);
    process.exit(1);
  }
  return cliPath;
}

/**
 * The verb an invocation resolves to, as far as the dispatcher can see it: the
 * frameworks' own resolution rules minus their per-framework alias tables.
 * `--help`/`-h` wins outright (cli-router routes it ahead of positionals, so
 * `omega deploy --help` prints help), then the first positional token, then the
 * first flag-style alias. A bare `omega` has no verb — every CLI defaults to help.
 *
 * @param {string[]} argv - Arguments after the bin name.
 * @returns {string|null} The selecting token, or null for a bare invocation.
 */
function verbOf(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  return argv.find((arg) => !arg.startsWith('-')) || argv[0] || null;
}

/**
 * The framework packages, in the registry's target order: their CLI's `test` runs
 * their own suite. The manager's `test` is the brand fan-out, so its suite is `npm test`.
 */
function monorepoPackages(root) {
  const packagesDir = path.join(root, 'packages');
  const rank = (dirName) => (TARGET_ORDER.includes(dirName) ? TARGET_ORDER.indexOf(dirName) : TARGET_ORDER.length);
  return fs.readdirSync(packagesDir)
    .map((dirName) => ({ dirName, dir: path.join(packagesDir, dirName), manifest: readPackage(path.join(packagesDir, dirName)) }))
    .filter((pkg) => pkg.manifest && FRAMEWORK_NAMES.includes(pkg.manifest.name) && pkg.manifest.bin && pkg.manifest.bin.omega)
    .sort((a, b) => rank(a.dirName) - rank(b.dirName) || a.dirName.localeCompare(b.dirName));
}

/**
 * The ONE command the monorepo root accepts for a verb, shared by the root's own
 * refusal and the in-package refusal so the two cannot drift: `test` picks a
 * framework package (any other package's suite is its own workspace's npm test),
 * `dev` is the root watch, and every other verb is a workspace script.
 *
 * @param {string} root - The monorepo root.
 * @param {string} verb - The verb as typed.
 * @param {string[]} rest - The args after the verb.
 * @param {string|null} pkg - The package dir name the cwd sits in, if any.
 * @returns {string}
 */
function monorepoForm(root, verb, rest, pkg) {
  const entry = findVerb(verb);
  if (entry && entry.name === 'test') {
    if (pkg && !monorepoPackages(root).some((candidate) => candidate.dirName === pkg)) return `npm test --workspace packages/${pkg}`;
    return [`npx omega test --${PICKER_FLAG}=${pkg || '<package>'}`, ...rest].join(' ');
  }
  if (entry && entry.name === 'dev') return 'npm start';
  return `npm run ${entry ? entry.name : verb} --workspaces --if-present`;
}

/**
 * The monorepo root: `test` runs each package `--target=` picks through its own
 * CLI file, never the dispatcher (which refuses inside a package), in the package
 * dir, stopping at the first failure; every other verb is a root npm script and
 * refuses naming it.
 */
function runMonorepoRoot({ root, argv, verb, spawn }) {
  const entry = findVerb(verb);
  if (!entry || entry.name !== 'test') {
    console.error(`omega: the monorepo root runs only \`npx omega test --${PICKER_FLAG}=<package>\`; for "${verb}" run the root npm script: ${monorepoForm(root, verb, [])}`);
    process.exit(1);
  }

  const packages = monorepoPackages(root);
  const known = packages.map((pkg) => pkg.dirName).join(', ');
  const { tokens, rest } = takePicker(argv.filter((arg, index) => index !== argv.indexOf(verb)));

  // The monorepo has no "all" default: the whole battery is `npm test`
  if (tokens.length === 0) {
    console.error(`omega: pick the packages to test: npx omega test --${PICKER_FLAG}=<package>[,...] [scope], e.g. npx omega test --${PICKER_FLAG}=web framework:. The packages are ${known}; the whole battery is npm test.`);
    process.exit(1);
  }

  const matches = (pkg, token) => token === pkg.dirName || token === pkg.manifest.name;
  const unknown = tokens.filter((token) => !packages.some((pkg) => matches(pkg, token)));
  if (unknown.length > 0) {
    console.error(`omega: unknown --${PICKER_FLAG} ${unknown.map((token) => `"${token}"`).join(', ')}: the monorepo's packages are ${known}. Nothing ran.`);
    process.exit(1);
  }

  for (const pkg of packages.filter((candidate) => tokens.some((token) => matches(candidate, token)))) {
    const { cliPath, error } = tryResolveCli(pkg.manifest.name, pkg.dir);
    if (!cliPath) {
      console.error(`omega: ${pkg.manifest.name}'s './cli' did not resolve (${error.message}; an unbuilt dist? run its prepare). Nothing ran for it.`);
      process.exitCode = 1;
      return;
    }

    console.error(`omega: ${pkg.manifest.name}: omega test ${rest.join(' ')}`.trimEnd());
    const result = spawn(process.execPath, [cliPath, 'test', ...rest], {
      cwd: pkg.dir,
      stdio: 'inherit',
    });

    // A child killed by a signal (or never spawned) has no status, and failed all the same
    const code = typeof result.status === 'number' ? result.status : 1;
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

async function run({ hostName, hostRun, argv = process.argv.slice(2), spawn = spawnSync }) {
  const cwd = process.cwd();
  const target = findTarget(cwd);
  const verb = verbOf(argv);
  // A contextless or box verb has no root to run from, and a bare `omega` prints help
  const rootless = verb === null || CONTEXTLESS_VERBS.has(verb) || boxVerbOf(argv) !== null;

  if (target && !rootless) {
    const root = rootOf(target, cwd);
    const row = findVerb(verb);
    if (cwd !== root.dir && !ownsInPlace(target, verb)) refuseOutsideRoot(verb, argv, root, row);
  }

  // Inside a brand or a target, a manager-only verb skips the target's own
  // framework, which does not know it; the no-context branch below prefers the manager too
  if (target && target.kind !== 'monorepo' && MANAGER_VERBS.has(verb)) {
    const manager = tryResolveCli(MANAGER, cwd);
    if (manager.cliPath) return require(manager.cliPath).run();
    if (hostName === MANAGER) return hostRun();
    console.error(`omega: "${verb}" is ${MANAGER}'s, which is not installed from ${cwd}. Run npm install at the project root, then run it again.`);
    process.exit(1);
  }

  // No context — the bootstrap case (a verb run in a fresh directory has
  // no framework dep yet, by definition). Run the INSTALLED @omega.js/manager
  // when one resolves, else the HOST framework's CLI exactly like the
  // pre-dispatcher bins did, and say which one so a hoist-winner at a brand
  // root is never a silent mystery.
  if (!target || (target.kind === 'monorepo' && rootless)) {
    // …but ONLY for a verb that cannot write. The fallback hands a mutating verb
    // to whichever framework won npm's bin link, and that verb scaffolds its own
    // target into the cwd — a directory that owns no target is never where that
    // should land (#699). Twin of ensure-target's refusal (devkit scaffold-guard.js).
    const boxVerb = boxVerbOf(argv);
    if (boxVerb) {
      if (hostName === DESKTOP) return hostRun();
      const { cliPath } = tryResolveCli(DESKTOP, process.cwd());
      if (!cliPath) {
        console.error(`omega: "${boxVerb}" is ${DESKTOP}'s — a signing box runs it from any directory, but ${DESKTOP} is not installed here (from ${process.cwd()}). \`npm i -g ${DESKTOP}\`, then run it again.`);
        process.exit(1);
      }
      console.error(`omega: no target context found from ${process.cwd()} — "${boxVerb}" is a signing-box verb, running ${DESKTOP}`);
      return require(cliPath).run();
    }
    if (verb && !CONTEXTLESS_VERBS.has(verb)) {
      console.error(`omega: refusing to run "${verb}" — ${process.cwd()} is not inside an OMEGA target (no framework dependency and no config/omega.json5 above it). Nothing was scaffolded.`);
      console.error('Run it from a root (a brand root or a standalone target), or `npx omega onboard` to create one here. Without a target, only onboard (create, new), status, help, version, cwd and logs run; the signing box\'s runner and sign-windows run through @omega.js/desktop.');
      process.exit(1);
    }

    // The manager wins a contextless run whenever the install carries one: the
    // verbs that survive the refusal above are the ones that run where no
    // target exists yet (onboard, create, new), and those are the manager's own.
    // Without this, a fresh brand-template clone that installed ONLY
    // @omega.js/manager still ran the backend, because the manager DEPENDS on
    // the backend and npm's arbitrary hoist winner linked the backend's bin:
    // `npx omega onboard` answered `Unknown command`
    // ([#908](https://github.com/Omega-JS-Stack/omega/issues/908)).
    const manager = tryResolveCli(MANAGER, process.cwd());
    if (manager.cliPath) {
      console.error(`omega: no target context found from ${process.cwd()}: running ${MANAGER}`);
      return require(manager.cliPath).run();
    }

    console.error(`omega: no target context found from ${process.cwd()} — running ${hostName}`);
    return hostRun();
  }

  // Below the monorepo root every verb refused above, so this is the root, which runs `test` over its packages
  if (target.kind === 'monorepo') return runMonorepoRoot({ root: target.dir, argv, verb, spawn });

  // A brand root — the manager owns brand-level commands (`omega test` fans
  // out over targets/*). Resolve it from the brand root and hand over.
  if (target.kind === 'brand') {
    const { cliPath } = tryResolveCli(MANAGER, target.dir);

    // Brand-SHAPED is not always a brand: every verb's ensureTarget scaffolds
    // config/omega.json5 into a standalone project before its framework dep lands
    // in package.json, so the walk classifies a fresh target as a brand root. With
    // no manager installed there is no brand-level CLI to hand over to — fall
    // back to the host framework rather than dead-ending (#194). A real brand
    // root still dispatches to the manager the moment it exists.
    if (!cliPath) {
      // When the HOST is the manager itself (its own bin in a fresh template
      // clone), "install the manager" would name the thing about to run —
      // that message is for framework hosts only.
      if (hostName === MANAGER) {
        console.error(`omega: brand-shaped directory at ${target.dir} with no installed ${MANAGER} — running the bundled ${hostName} (run npm install to use the pinned version)`);
      } else {
        console.error(`omega: brand-shaped directory at ${target.dir} but ${MANAGER} is not installed, running ${hostName} instead (install ${MANAGER} at the brand root if this really is a brand)`);
      }
      return hostRun();
    }
    return require(cliPath).run();
  }

  // The bin that won npm's .bin link belongs to this target's framework: run it directly.
  if (target.name === hostName) {
    return hostRun();
  }

  // The target belongs to a DIFFERENT framework: resolve its CLI from where the
  // dependency is declared and hand over.
  const cliPath = resolveCli(target.name, target.dir,
    'Is the framework installed? Try npm install, or `npx omega i local` at the brand root for a monorepo link.');
  return require(cliPath).run();
}

module.exports = { run, findTarget, frameworksOf, OMEGA_SCOPE, isBrandRoot, isMonorepoRoot, verbOf, isBoxVerbArgv, TARGET_SUBDIRS, CONTEXTLESS_VERBS, BOX_VERBS, MANAGER };
