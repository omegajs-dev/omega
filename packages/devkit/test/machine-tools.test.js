// Unit tests for src/machine-tools.js: the one list of the tools a target type
// needs on the machine (npm installs none of them), and the one helper that
// names what an enabled set of targets is missing.
//
// The probes run through an injected execFn that throws for a missing tool, the
// way a failed child does, so no case here touches the real java or firebase.

const defineCases = require('@omega.js/devkit/test/define-cases');
const { MACHINE_TOOLS, SNAPCRAFT, machineToolsFor, missingMachineTools, missingTool, machineToolLine } = require('../src/machine-tools.js');

const PLATFORMS = ['darwin', 'win32', 'linux'];

/** The list entry for one tool of the backend type. */
const backendTool = (name) => MACHINE_TOOLS.backend.find((tool) => tool.name === name);

/**
 * An execFn stand-in: records every probe it is handed, and throws for the
 * tools named in `missing` ('*' fails every probe).
 */
function probeRunner(missing = []) {
  const calls = [];
  const nameOf = Object.fromEntries(Object.values(MACHINE_TOOLS).flat().map((tool) => [tool.probe[0], tool.name]));
  const execFn = (file, args) => {
    calls.push([file, ...(args || [])]);
    if (missing.includes('*') || missing.includes(nameOf[file])) {
      throw Object.assign(new Error(`spawnSync ${file} ENOENT`), { code: 'ENOENT' });
    }
    return '';
  };
  return { execFn, calls };
}

module.exports = defineCases({
  type: 'group',
  description: 'machine-tools',
  tests: [
    {
      name: 'exports the expected surface',
      run: (ctx) => {
        ctx.expect(typeof MACHINE_TOOLS).toBe('object');
        ctx.expect(typeof machineToolsFor).toBe('function');
        ctx.expect(typeof missingMachineTools).toBe('function');
        ctx.expect(typeof machineToolLine).toBe('function');
      },
    },

    {
      name: 'the list: a backend needs java and firebase, the other types need nothing npm does not bring',
      run: (ctx) => {
        ctx.expect(Object.keys(MACHINE_TOOLS).sort()).toEqual(['backend', 'desktop', 'extension', 'web']);
        ctx.expect(MACHINE_TOOLS.backend.map((tool) => tool.name)).toEqual(['java', 'firebase']);
        for (const type of ['web', 'desktop', 'extension']) ctx.expect(MACHINE_TOOLS[type], type).toEqual([]);
      },
    },

    {
      name: 'every entry carries a probe, a reason and an install command per platform',
      run: (ctx) => {
        for (const tool of Object.values(MACHINE_TOOLS).flat()) {
          ctx.expect(Array.isArray(tool.probe) && tool.probe.length > 0, `${tool.name}: probe is [file, ...args]`).toBeTruthy();
          ctx.expect(typeof tool.probe[0], `${tool.name}: the probe opens on the file to run`).toBe('string');
          ctx.expect(typeof tool.why === 'string' && tool.why.length > 0, `${tool.name}: why`).toBeTruthy();
          ctx.expect(Object.keys(tool.install).sort(), `${tool.name}: one command per platform`).toEqual([...PLATFORMS].sort());
          for (const platform of PLATFORMS) {
            ctx.expect(typeof tool.install[platform] === 'string' && tool.install[platform].length > 0, `${tool.name} on ${platform}`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'machineToolsFor: a Firebase backend gets the backend list, a custom backend and every other type get none',
      run: (ctx) => {
        ctx.expect(machineToolsFor({ type: 'backend' }).map((tool) => tool.name), 'firebase is the default project type').toEqual(['java', 'firebase']);
        ctx.expect(machineToolsFor({ type: 'backend', projectType: 'firebase' }).map((tool) => tool.name)).toEqual(['java', 'firebase']);
        ctx.expect(machineToolsFor({ type: 'backend', projectType: 'custom' })).toEqual([]);
        for (const type of ['web', 'desktop', 'extension']) ctx.expect(machineToolsFor({ type }), type).toEqual([]);
      },
    },

    {
      name: 'missingTool: the snapcraft row probes snapcraft, and a failed probe is a row with the platform\'s install command',
      run: (ctx) => {
        const target = { name: 'desktop', type: 'desktop' };
        const absent = probeRunner(['*']);

        ctx.expect(missingTool(SNAPCRAFT, target, { platform: 'darwin', execFn: absent.execFn })).toEqual({
          target: 'desktop',
          type: 'desktop',
          name: 'snapcraft',
          why: SNAPCRAFT.why,
          install: SNAPCRAFT.install.darwin,
        });
        ctx.expect(absent.calls).toEqual([SNAPCRAFT.probe]);
        ctx.expect(SNAPCRAFT.probe[0]).toBe('snapcraft');
        ctx.expect(Object.keys(SNAPCRAFT.install).sort(), 'one command per platform').toEqual([...PLATFORMS].sort());

        ctx.expect(missingTool(SNAPCRAFT, target, { platform: 'linux', execFn: probeRunner([]).execFn }), 'installed: no row').toBe(null);
      },
    },

    {
      name: '#1032 case 1: a backend whose Java probe fails gets one java row, with the platform\'s install command',
      run: (ctx) => {
        for (const platform of PLATFORMS) {
          const { execFn } = probeRunner(['java']);

          const missing = missingMachineTools([{ name: 'backend', type: 'backend' }], { platform, execFn });

          ctx.expect(missing.length, `${platform}: ${JSON.stringify(missing)}`).toBe(1);
          ctx.expect(missing[0]).toEqual({
            target: 'backend',
            type: 'backend',
            name: 'java',
            why: backendTool('java').why,
            install: backendTool('java').install[platform],
          });
        }
        ctx.expect(backendTool('java').install.darwin, 'the install command is picked per platform').not.toBe(backendTool('java').install.win32);
      },
    },

    {
      name: '#1032 case 1: machineToolLine holds the name, the target and the install command',
      run: (ctx) => {
        const line = machineToolLine({
          target: 'api',
          type: 'backend',
          name: 'java',
          why: 'the Firebase emulators run on it',
          install: 'brew install openjdk',
        });

        ctx.expect(line).toBe('java is not installed (the api target needs it: the Firebase emulators run on it). Install with: brew install openjdk');
      },
    },

    {
      name: '#1032 case 1: the row the helper returns reads as the one line',
      run: (ctx) => {
        const { execFn } = probeRunner(['java']);
        const [miss] = missingMachineTools([{ name: 'backend', type: 'backend' }], { platform: 'linux', execFn });

        const line = machineToolLine(miss);

        ctx.expect(line.startsWith('java is not installed (the backend target needs it: '), line).toBeTruthy();
        ctx.expect(line.endsWith(`). Install with: ${backendTool('java').install.linux}`), line).toBeTruthy();
      },
    },

    {
      name: '#1032 case 2: with both probes passing, nothing is missing',
      run: (ctx) => {
        const { execFn, calls } = probeRunner([]);

        ctx.expect(missingMachineTools([{ name: 'backend', type: 'backend' }], { platform: 'darwin', execFn })).toEqual([]);
        ctx.expect(calls, 'each tool was probed with its own probe').toEqual(MACHINE_TOOLS.backend.map((tool) => tool.probe));
      },
    },

    {
      name: '#1032 case 3: a custom backend, or a web, desktop or extension target, is missing nothing even with every probe failing',
      run: (ctx) => {
        const targets = [
          { name: 'api', type: 'backend', projectType: 'custom' },
          { name: 'web', type: 'web' },
          { name: 'desktop', type: 'desktop' },
          { name: 'extension', type: 'extension' },
        ];
        const { execFn } = probeRunner(['*']);

        ctx.expect(missingMachineTools(targets, { platform: 'darwin', execFn })).toEqual([]);
      },
    },

    {
      name: '#1032 case 4: a brand with no backend target runs no Java or Firebase probe at all',
      run: (ctx) => {
        const { execFn, calls } = probeRunner(['*']);

        missingMachineTools([{ name: 'web', type: 'web' }, { name: 'desktop', type: 'desktop' }], { platform: 'darwin', execFn });
        missingMachineTools([], { platform: 'darwin', execFn });

        ctx.expect(calls).toEqual([]);
      },
    },

    {
      name: 'one row per missing tool per target, each naming its own target',
      run: (ctx) => {
        const { execFn } = probeRunner(['java', 'firebase']);

        const missing = missingMachineTools([
          { name: 'api', type: 'backend' },
          { name: 'web', type: 'web' },
          { name: 'admin', type: 'backend' },
        ], { platform: 'darwin', execFn });

        ctx.expect(missing.map((row) => `${row.target}:${row.name}`).sort()).toEqual(['admin:firebase', 'admin:java', 'api:firebase', 'api:java']);
      },
    },

    {
      name: 'the probe\'s shell flag follows the host, never the platform passed in for the install line',
      run: (ctx) => {
        const shells = [];
        const execFn = (file, args, options) => { shells.push(options.shell); return ''; };

        missingMachineTools([{ name: 'backend', type: 'backend' }], { platform: process.platform === 'win32' ? 'linux' : 'win32', execFn });

        ctx.expect(shells).toEqual(MACHINE_TOOLS.backend.map(() => process.platform === 'win32'));
      },
    },
  ],
});
