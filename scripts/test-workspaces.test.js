/**
 * test-workspaces.js: the package pool. Each case builds a temp workspace whose
 * packages run a real `npm test`, a node program that marks its start and end
 * in one file and prints its own lines, then reads the marks and the output.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const SCRIPT = path.join(__dirname, 'test-workspaces.js');

// The package's test: `mark.js <name> [--peers=N] [--last] [--code=N]`.
// `--peers` holds it at two barriers until N packages reached each one, so N
// packages are in flight together; `--last` holds its end until every other
// peer ended. The bound inside only turns a lost peer into a red, never a hang.
const MARK = `
const fs = require('node:fs');
const path = require('node:path');
const [name, ...flags] = process.argv.slice(2);
const flag = (key) => (flags.find((f) => f.startsWith('--' + key + '=')) || '').split('=')[1];
const peers = Number(flag('peers') || 0);
const marks = path.join(__dirname, 'marks.txt');
const count = (kind) => fs.readFileSync(marks, 'utf8').split('\\n').filter((l) => l.startsWith(kind + ' ')).length;
const bound = Date.now() + 10000;
const hold = (kind, n) => { while (count(kind) < n && Date.now() < bound) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
fs.appendFileSync(marks, 'start ' + name + '\\n');
console.log(name + ' line 1');
hold('start', peers);
console.log(name + ' line 2');
fs.appendFileSync(marks, 'mid ' + name + '\\n');
hold('mid', peers);
console.log(name + ' line 3');
console.log(name + ' line 4');
if (flags.includes('--last')) hold('end', peers - 1);
fs.appendFileSync(marks, 'end ' + name + '\\n');
process.exitCode = Number(flag('code') || 0);
`;

/**
 * A workspace in a fresh temp folder, removed when the case ends: `packages`
 * maps each package name to the flags its test passes to mark.js.
 */
function workspace(ctx, packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-pool-'));
  ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pool-fixture', private: true, workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(root, 'mark.js'), MARK);
  fs.writeFileSync(path.join(root, 'marks.txt'), '');
  for (const [name, flags] of Object.entries(packages)) {
    const dir = path.join(root, 'packages', name);
    fs.mkdirSync(dir, { recursive: true });
    const test = ['node ../../mark.js', name, ...flags].join(' ');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test } }));
  }
  return root;
}

// Run the pool over `root`, collecting everything it printed.
async function pool(root, knobs) {
  const { run } = require(SCRIPT);
  let printed = '';
  const out = new Writable({
    write(chunk, encoding, done) {
      printed += chunk.toString();
      done();
    },
  });
  const { code, results } = await run({ root, out, ...knobs });
  const text = printed.replace(/\x1b\[[0-9;]*m/g, '');
  const marks = fs.readFileSync(path.join(root, 'marks.txt'), 'utf8').split('\n').filter(Boolean);
  return { code, results, text, marks };
}

// The summary's rows, `<mark> packages/<name>`, in the order printed.
function summaryRows(text) {
  return [...text.matchAll(/^\s*([✓✗]) (packages\/[\w-]+)/gm)].map(([, mark, name]) => `${mark} ${name}`);
}

module.exports = defineCases({
  type: 'group',
  description: 'test-workspaces',
  tests: [
    {
      name: 'three packages are in flight together and the summary lists them in discovery order',
      run: async (ctx) => {
        const root = workspace(ctx, { alpha: ['--peers=3', '--last'], bravo: ['--peers=3'], charlie: ['--peers=3'] });
        const { code, results, text, marks } = await pool(root, { serial: [], size: 3 });

        ctx.expect(code, text).toBe(0);
        const lastStart = Math.max(...['alpha', 'bravo', 'charlie'].map((name) => marks.indexOf(`start ${name}`)));
        const firstEnd = marks.findIndex((mark) => mark.startsWith('end '));
        ctx.expect(lastStart, `every package started before any ended: ${marks.join(', ')}`).toBeLessThan(firstEnd);
        ctx.expect(marks[marks.length - 1], 'alpha ended last').toBe('end alpha');
        ctx.expect(results.map((r) => r.name)).toEqual(['packages/alpha', 'packages/bravo', 'packages/charlie']);
        ctx.expect(summaryRows(text), text).toEqual(['✓ packages/alpha', '✓ packages/bravo', '✓ packages/charlie']);
      },
    },
    {
      name: 'a package in the serial list starts after every pool package ended',
      run: async (ctx) => {
        const root = workspace(ctx, { first: [], 'pool-a': ['--peers=2'], 'pool-b': ['--peers=2'] });
        const { code, results, text, marks } = await pool(root, { serial: ['packages/first'], size: 3 });

        ctx.expect(code, text).toBe(0);
        const start = marks.indexOf('start first');
        ctx.expect(start, marks.join(', ')).toBeGreaterThan(marks.indexOf('end pool-a'));
        ctx.expect(start, marks.join(', ')).toBeGreaterThan(marks.indexOf('end pool-b'));
        ctx.expect(results.map((r) => r.name)).toEqual(['packages/pool-a', 'packages/pool-b', 'packages/first']);
      },
    },
    {
      name: 'a package that exits 1 is marked in the summary and fails the run, and the others still run',
      run: async (ctx) => {
        const root = workspace(ctx, { alpha: [], bravo: ['--code=1'], charlie: [] });
        const { code, results, text, marks } = await pool(root, { serial: [], size: 3 });

        ctx.expect(code, text).toBe(1);
        ctx.expect(results.map((r) => [r.name, r.code])).toEqual([['packages/alpha', 0], ['packages/bravo', 1], ['packages/charlie', 0]]);
        ctx.expect(summaryRows(text), text).toEqual(['✓ packages/alpha', '✗ packages/bravo', '✓ packages/charlie']);
        ctx.expect(marks.filter((mark) => mark.startsWith('end ')).sort()).toEqual(['end alpha', 'end bravo', 'end charlie']);
      },
    },
    {
      name: 'a package\'s output arrives whole though it printed while another package printed',
      run: async (ctx) => {
        const root = workspace(ctx, { alpha: ['--peers=2'], bravo: ['--peers=2'] });
        const { code, text } = await pool(root, { serial: [], size: 2 });

        ctx.expect(code, text).toBe(0);
        const lines = [...text.matchAll(/^(alpha|bravo) line \d$/gm)].map(([line]) => line);
        const whole = (first, second) => [1, 2, 3, 4].map((n) => `${first} line ${n}`).concat([1, 2, 3, 4].map((n) => `${second} line ${n}`));
        const grouped = [whole('alpha', 'bravo'), whole('bravo', 'alpha')].map((order) => JSON.stringify(order));
        ctx.expect(grouped, text).toContain(JSON.stringify(lines));
      },
    },
    {
      name: 'a serial name that matches no package fails the run naming it, before any package runs',
      run: async (ctx) => {
        const root = workspace(ctx, { alpha: [], bravo: [] });
        const { run } = require(SCRIPT);
        const out = new Writable({ write: (chunk, encoding, done) => done() });

        await ctx.expect(run({ root, out, serial: ['packages/alpha', 'packages/missing'], size: 2 })).rejects.toThrow('packages/missing');
        ctx.expect(fs.readFileSync(path.join(root, 'marks.txt'), 'utf8')).toBe('');
      },
    },
  ],
});
