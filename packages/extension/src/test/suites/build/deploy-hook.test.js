// Build-layer test for the deploy verb's consumer hook
// ([#900](https://github.com/Omega-JS-Stack/omega/issues/900)).
//
// `omega deploy` runs the consumer's `hooks/deploy/pre.js` after the local
// scaffold and BEFORE the `--direct` branch and the network precheck, on both
// lanes, through the package task's own hook loader (the one `hooks/build/pre.js`
// already goes through: one loader per surface). A dry run skips it: a hook may
// act on the world (the playground's prunes its GitHub releases), and a dry run
// promises to send nothing. The VERSION comes from `omega bump` at the brand
// root (#869), and a target that drifted from it is refused before the hook.
//
// The desktop sibling of this suite is
// `packages/desktop/src/test/suites/build/deploy-hook.test.js` (#899).

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const defineCases = require('@omega.js/devkit/test/define-cases');

const COMMANDS = path.join(__dirname, '..', '..', '..', 'commands');
const DEPLOY = path.join(COMMANDS, 'deploy.js');

/**
 * Swap ONE module for a recorder and hand back the undo (the deploy-direct
 * test's seam: the scaffold and the precheck are the two steps around the
 * hook, and everything else in the verb is the real code).
 *
 * @param {string} file - The module to replace.
 * @param {object} exports - What it exports for the duration.
 * @returns {Function} The restore.
 */
function stubModule(file, exports) {
  const resolved = require.resolve(file);
  const previous = require.cache[resolved];
  const stub = new Module(resolved);

  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;

  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

/**
 * Run the deploy verb against a consumer dir whose `hooks/deploy/pre.js`
 * records its call, with the precheck stubbed to stop the run right there.
 *
 * @param {object} options - The verb's options.
 * @returns {Promise<string[]>} The steps that ran, in order.
 */
async function runDeploy(options) {
  const ran = [];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-deploy-hook-')));

  fs.mkdirSync(path.join(tmp, 'hooks', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"extension-deploy-hook-test"}');
  fs.writeFileSync(
    path.join(tmp, 'hooks', 'deploy', 'pre.js'),
    `export default async (ctx) => { global.__omegaDeployHookRan.push('deploy/pre:' + (ctx.projectRoot === process.cwd() && typeof ctx.build === 'object' && ctx.mode === 'production' ? 'ctx ok' : 'ctx wrong')); };`,
  );

  const restores = [
    stubModule(path.join(COMMANDS, 'lib', 'ensure-target.js'), { ensureTarget: async () => ran.push('ensure-target') }),
    stubModule(path.join(COMMANDS, 'lib', 'deploy-precheck.js'), { deployPrecheck: async () => { ran.push('precheck'); throw new Error('STOP AT PRECHECK'); } }),
  ];
  const resolved = require.resolve(DEPLOY);
  const cached = require.cache[resolved];
  const origCwd = process.cwd();

  delete require.cache[resolved];
  global.__omegaDeployHookRan = ran;

  try {
    // Required BEFORE the chdir: the verb loads its build module at load time from
    // the real target; only the hook lookup reads cwd, at call time.
    const deploy = require(resolved);
    process.chdir(tmp);
    await deploy(options).catch((e) => ran.push(e.message));
    return ran;
  } finally {
    process.chdir(origCwd);
    delete global.__omegaDeployHookRan;
    for (const restore of restores) restore();
    if (cached) require.cache[resolved] = cached;
    else delete require.cache[resolved];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The same seam, run inside a DRIFTED brand: the root says 0.0.3 and this
 * target still says 0.0.2 ([#869](https://github.com/Omega-JS-Stack/omega/issues/869)).
 *
 * @returns {Promise<string[]>} The steps that ran, in order.
 */
async function runDriftedDeploy() {
  const ran = [];
  const brand = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-deploy-drift-')));
  const target = path.join(brand, 'targets', 'extension');

  fs.mkdirSync(path.join(brand, 'config'), { recursive: true });
  fs.writeFileSync(path.join(brand, 'config', 'omega.json5'), '{ brand: { id: \'fixture\' }, targets: { extension: { type: \'extension\' } } }');
  fs.writeFileSync(path.join(brand, 'package.json'), '{"name":"fixture-brand","version":"0.0.3"}');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), '{"name":"fixture-extension","version":"0.0.2"}');

  const restores = [
    stubModule(path.join(COMMANDS, 'lib', 'ensure-target.js'), { ensureTarget: async () => ran.push('ensure-target') }),
    stubModule(path.join(COMMANDS, 'lib', 'deploy-precheck.js'), { deployPrecheck: async () => { ran.push('precheck'); throw new Error('STOP AT PRECHECK'); } }),
  ];
  const resolved = require.resolve(DEPLOY);
  const cached = require.cache[resolved];
  const origCwd = process.cwd();

  delete require.cache[resolved];

  try {
    const deploy = require(resolved);
    process.chdir(target);
    await deploy({}).catch((e) => ran.push(e.message));
    return ran;
  } finally {
    process.chdir(origCwd);
    for (const restore of restores) restore();
    if (cached) require.cache[resolved] = cached;
    else delete require.cache[resolved];
    fs.rmSync(brand, { recursive: true, force: true });
  }
}

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'deploy: the consumer\'s hooks/deploy/pre.js runs before the precheck (#900)',
  tests: [
    {
      name: 'the hook runs after the scaffold and before the network precheck, with { build, projectRoot, mode: production }',
      run: async (ctx) => {
        const ran = await runDeploy({});
        ctx.expect(ran).toEqual(['ensure-target', 'deploy/pre:ctx ok', 'precheck', 'STOP AT PRECHECK']);
      },
    },
    {
      name: 'a dry run skips the hook: a hook may act on the world, and a dry run sends nothing',
      run: async (ctx) => {
        const ran = await runDeploy({ dryRun: true });
        ctx.expect(ran).toEqual(['ensure-target', 'precheck', 'STOP AT PRECHECK']);
      },
    },
    {
      name: 'a target whose version drifted from the brand root is refused before the hook and the precheck (#869)',
      run: async (ctx) => {
        const ran = await runDriftedDeploy();

        ctx.expect(ran.length).toBe(2);
        ctx.expect(ran[0]).toBe('ensure-target');
        ctx.expect(ran[1]).toContain('targets/extension is 0.0.2 but the brand is 0.0.3');
        ctx.expect(ran[1]).toContain('omega bump');
        // The precheck never ran: a drifted target must not push its secrets.
        ctx.expect(ran).not.toContain('precheck');
      },
    },
  ],
});
