/**
 * src/process-tree.js on a real tree of three processes: a node process, its
 * child in a session of its own, and that child's child, which ignores the
 * terminate signal.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const defineCases = require('../src/test/define-cases.js');
const { readProcessTable, descendantsOf, endProcesses } = require('../src/process-tree.js');
const { tempPath, takeFile, alive, endAlive } = require('./runner/_fixtures/helpers.js');

const PATIENCE = 20000;

// One level of the tree: record `<level>:<pid>`, stay alive, start the level below.
// Level 3 starts level 2 detached, in its own session; level 1 ignores SIGTERM.
const LEVEL = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [out, level] = process.argv.slice(1);
fs.appendFileSync(out, level + ':' + process.pid + '\\n');
setInterval(() => {}, 60000);
if (level === '1') process.on('SIGTERM', () => {});
else spawn(process.execPath, ['-e', process.env.TREE_LEVEL, out, String(level - 1)], { detached: level === '3', stdio: 'ignore' });
`;

// The pids recorded so far, by level.
function recorded(out) {
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => line.split(':').map(Number)));
}

// The pids by level, once all three levels have written theirs.
function allLevels(out) {
  const levels = recorded(out);
  return levels[1] && levels[2] && levels[3] ? levels : null;
}

const pidOf = (entry) => Number(typeof entry === 'object' ? entry.pid : entry);

module.exports = defineCases({
  type: 'group',
  description: 'process tree',
  tests: [
    {
      name: 'case-8 descendantsOf walks a real three-deep tree into a child\'s own session, and endProcesses ends it, forcing the deaf one',
      skip: process.platform === 'win32' && 'the process tree is not swept on Windows',
      async run(ctx) {
        const out = tempPath('tree.txt');
        const top = spawn(process.execPath, ['-e', LEVEL, out, '3'], {
          env: { ...process.env, TREE_LEVEL: LEVEL },
          stdio: 'ignore',
        });
        ctx.after(() => {
          endAlive([top.pid, ...Object.values(recorded(out))]);
          takeFile(out);
        });

        const levels = await ctx.waitFor(() => allLevels(out), PATIENCE);
        ctx.expect(levels[3]).toBe(top.pid);

        const below = descendantsOf(readProcessTable(), top.pid).map(pidOf).filter((pid) => pid !== top.pid);
        ctx.expect(below.sort((x, y) => x - y)).toEqual([levels[2], levels[1]].sort((x, y) => x - y));

        await endProcesses([levels[3], levels[2], levels[1]], { grace: 200 });
        for (const level of [3, 2, 1]) {
          ctx.expect(alive(levels[level]), `level ${level} (pid ${levels[level]}) still alive`).toBe(false);
        }
      },
    },
  ],
});
