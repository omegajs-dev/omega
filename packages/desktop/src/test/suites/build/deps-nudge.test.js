// The deps nudge, desktop half: a consumer hook importing a package
// @omega.js/desktop declares, without declaring it, keeps working by hoisting,
// and every verb's ensure-target prints ONE warning naming both fixes: declare
// it, or load the framework's copy through the desktop door. Never an error.
//
// The fixture manifest already satisfies the peer dependencies, so nothing installs.

const path = require('path');
const fs = require('fs');
const os = require('os');
const jetpack = require('fs-jetpack');

const SRC = path.join(__dirname, '..', '..', '..');
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const build = require(path.join(SRC, 'build.js'));
const { ensureTarget } = require(path.join(SRC, 'commands', 'lib', 'ensure-target.js'));
const defineCases = require('@omega.js/devkit/test/define-cases');

const package = build.getPackage('main');
const DOOR = "desktop.require('fs-jetpack') after import desktop from '@omega.js/desktop'";

// A consumer whose peer deps are satisfied, its hooks/build/pre.js importing fs-jetpack.
function stageConsumer(dependencies) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-deps-nudge-')));
  const devDependencies = { [package.name]: `^${package.version}`, ...package.peerDependencies };
  jetpack.write(path.join(tmp, 'package.json'), `${JSON.stringify({ name: 'staged-app', version: '1.0.0', dependencies, devDependencies }, null, 2)}\n`);
  jetpack.write(path.join(tmp, 'hooks', 'build', 'pre.js'), "import jetpack from 'fs-jetpack';\n\nexport default async () => jetpack;\n");
  return tmp;
}

// ensureTarget with every line it prints captured: its log, its warn, and the console its logger writes to.
async function runEnsureTarget(projectDir) {
  const lines = [];
  const methods = ['log', 'warn', 'error'];
  const originals = methods.map((method) => console[method]);
  methods.forEach((method) => { console[method] = (...args) => lines.push(args.map(String).join(' ')); });
  try {
    await ensureTarget({ projectDir, log: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) });
  } finally {
    methods.forEach((method, i) => { console[method] = originals[i]; });
  }
  return lines;
}

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'deps-nudge: an undeclared framework dependency in a consumer hook names the desktop door',
  tests: [
    {
      name: 'an undeclared import of a desktop-declared package gets one warning naming the door',
      run: async (ctx) => {
        const tmp = stageConsumer({});

        try {
          const lines = await runEnsureTarget(tmp);
          const nudges = lines.filter((line) => line.includes(DOOR));

          ctx.expect(nudges.length, `one warning line for the one package: ${lines.join(' | ')}`).toBe(1);
          ctx.expect(nudges[0], 'and it names the other fix too').toMatch(/npm install fs-jetpack/);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'a declared one gets no warning',
      run: async (ctx) => {
        const tmp = stageConsumer({ 'fs-jetpack': '^5.1.0' });

        try {
          const lines = await runEnsureTarget(tmp);

          ctx.expect(lines.filter((line) => line.includes('fs-jetpack'))).toEqual([]);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: "the door returns the framework's own copy of the module",
      run: (ctx) => {
        const door = require('@omega.js/desktop').require('fs-jetpack');
        const frameworkCopy = require(require.resolve('fs-jetpack', { paths: [FRAMEWORK_ROOT] }));

        ctx.expect(door === frameworkCopy, 'the same module object the framework resolves').toBe(true);
      },
    },
  ],
});
