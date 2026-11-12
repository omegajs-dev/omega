/**
 * run-consumer-hook: the one hook runner desktop and extension share. A hook
 * file is an ES module whose default export runs with the payload; a
 * `module.exports` hook is refused by name, and a missing one is skipped.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultExport, runConsumerHook } = require('../src/run-consumer-hook.js');

const REFUSAL = 'must be an ES module with one default export (export default async (...) => {})';

/** An ES module hook that writes the payload it was handed, less `build`, beside the project. */
const RECORDING_HOOK = `import fs from 'node:fs';
import path from 'node:path';

export default async ({ build, ...rest }) => {
  fs.writeFileSync(path.join(rest.projectRoot, 'hook-ran.json'), JSON.stringify({ ...rest, hasBuild: typeof build.getConfig === 'function' }));
};
`;

/**
 * A consumer project in a temp dir holding the given files, with cwd moved
 * into it until the case ends.
 */
function project(ctx, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-hook-')));
  const cwd = process.cwd();

  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"devkit-hook-consumer"}');
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }

  process.chdir(dir);
  ctx.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The payload every OMEGA hook receives: `{ build, projectRoot, mode }`. */
function payload(projectRoot) {
  return { build: { getConfig: () => ({}) }, projectRoot, mode: 'production' };
}

/** The error a call raises, sync or async, else null. */
async function caught(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

module.exports = defineCases({
  type: 'group',
  description: 'run-consumer-hook: an ES module hook runs, the old form is refused',
  tests: [
    {
      name: 'an ES module hook with imports runs its default export with the payload',
      run: async (ctx) => {
        const root = project(ctx, { 'hooks/build/pre.js': RECORDING_HOOK });

        await runConsumerHook('build/pre', payload(root));

        const ran = JSON.parse(fs.readFileSync(path.join(root, 'hook-ran.json'), 'utf8'));
        ctx.expect(ran).toEqual({ projectRoot: root, mode: 'production', hasBuild: true });
      },
    },

    {
      name: 'a module.exports hook is refused, naming the file and the form it must take',
      run: async (ctx) => {
        const root = project(ctx, {
          'hooks/deploy/pre.js': "module.exports = async () => { require('node:fs').writeFileSync('hook-ran.json', '{}'); };\n",
        });

        const error = await caught(() => runConsumerHook('deploy/pre', payload(root)));

        ctx.expect(error, 'the old form never runs').not.toBeNull();
        ctx.expect(error.message).toContain(`${path.join('hooks', 'deploy', 'pre.js')} ${REFUSAL}`);
        ctx.expect(fs.existsSync(path.join(root, 'hook-ran.json')), 'its function was never called').toBe(false);
      },
    },

    {
      name: 'a project with no hook file runs nothing and does not throw',
      run: async (ctx) => {
        const root = project(ctx, {});

        ctx.expect(await caught(() => runConsumerHook('build/post', payload(root)))).toBeNull();
      },
    },

    {
      name: 'an error the hook throws reaches the caller',
      run: async (ctx) => {
        const root = project(ctx, { 'hooks/release/pre.js': "export default async () => { throw new Error('hook bug'); };\n" });

        const error = await caught(() => runConsumerHook('release/pre', payload(root)));

        ctx.expect(error && error.message).toBe('hook bug');
      },
    },

    {
      name: 'a hook file that does not parse fails the call',
      run: async (ctx) => {
        const root = project(ctx, { 'hooks/build/pre.js': 'export default async () => { this is not valid javascript\n' });

        ctx.expect(await caught(() => runConsumerHook('build/pre', payload(root)))).not.toBeNull();
      },
    },

    {
      name: 'the array kind answers an ES module array and refuses a module.exports one with the array form',
      run: async (ctx) => {
        const root = project(ctx, {
          'esm/mcp.js': "export default [{ name: 'list_notes' }];\n",
          'cjs/mcp.js': "module.exports = [{ name: 'list_notes' }];\n",
        });
        const esm = path.join(root, 'esm', 'mcp.js');
        const cjs = path.join(root, 'cjs', 'mcp.js');

        ctx.expect(defaultExport(esm, require(esm), 'array')).toEqual([{ name: 'list_notes' }]);

        const error = await caught(() => defaultExport(cjs, require(cjs), 'array'));

        ctx.expect(error && error.message).toBe(`${cjs} must be an ES module with one default export (export default [ ... ])`);
      },
    },
  ],
});
