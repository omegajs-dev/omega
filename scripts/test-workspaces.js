/**
 * Workspace test aggregation: the root `npm test` packages spine. Not
 * `npm run test --workspaces`: npm 11 does not carry a mid-list workspace
 * failure into its exit code, so a failed package could ride a green run.
 *
 * Packages run in a pool, `poolSize()` at once, each one's output held and
 * printed whole in a stable order. A package in `SERIAL` shares a fixed port,
 * a path or CPU it cannot spare, so it runs alone after the pool's last exit.
 * `run({ root, serial, size, out })` resolves `{ code, results }`.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { mapLimited, poolSize } = require('@omega.js/devkit/map-limited');
const { exitFlushed } = require('@omega.js/devkit/test/exit');

const ROOT = path.join(__dirname, '..');

// The serial tail, run one at a time in this order after the pool.
const SERIAL = [
  // Its fixed 428xx port windows are also web's.
  'packages/config',
  // Its `test` script re-prepares the dist other suites read.
  'packages/client',
  // A real emulator stack from the classic ports.
  'packages/backend',
  // Real emulators, and it rewrites the sandbox brand mid-run.
  'packages/manager',
  // Its live Chrome service worker starves of CPU beside the pool.
  'packages/extension',
];

/**
 * The workspace packages with a `test` script, in discovery order.
 * packages/* only: the brands/* workspaces have their own root lanes.
 * @param {string} root - The workspace root.
 * @returns {{name: string, dir: string}[]} Each package's printed name and folder.
 */
function testablePackages(root) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dirs = (rootPackage.workspaces || []).filter((pattern) => pattern.startsWith('packages/')).flatMap((pattern) => {
    const parent = path.join(root, pattern.replace(/\/\*$/, ''));
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent)
      .map((name) => path.join(parent, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
  });

  return dirs
    .filter((dir) => Boolean(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test))
    .map((dir) => ({ name: path.relative(root, dir), dir }));
}

/**
 * Run one package's `npm test`, holding its stdout and stderr in arrival order.
 * Piped, never inherited: an inherited pipe holds the lane open past the exit.
 * @param {string} dir - The package folder.
 * @param {boolean} color - Whether the children may color their output.
 * @returns {Promise<{code: number, text: string}>} The exit code (a signal counts as 1) and the output.
 */
function testPackage(dir, color) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn('npm', ['test'], {
      cwd: dir,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...(color ? { FORCE_COLOR: '1' } : {}), ...process.env },
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(`${error.message}\n`);
      resolve({ code: 1, text: chunks.join('') });
    });
    // 'close', not 'exit': every byte the package wrote is held before it is released.
    child.on('close', (code) => resolve({ code: code ?? 1, text: chunks.join('') }));
  });
}

/**
 * Run every package's tests: the pool first, then the serial tail.
 * @param {object} [options]
 * @param {string} [options.root] - The workspace root (default the repo root).
 * @param {string[]} [options.serial] - Package names that run alone after the pool (default `SERIAL`); a name no testable package carries throws.
 * @param {number} [options.size] - The most packages in flight at once (default `poolSize()`).
 * @param {NodeJS.WritableStream} [options.out] - Where everything prints (default stdout).
 * @returns {Promise<{code: number, results: {name: string, code: number, seconds: number}[]}>}
 */
async function run({ root = ROOT, serial = SERIAL, size = poolSize(), out = process.stdout } = {}) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`size is the most packages in flight, a whole number of 1 or more (got ${JSON.stringify(size)})`);
  }

  const packages = testablePackages(root);
  const unknown = serial.filter((name) => !packages.some((entry) => entry.name === name));
  if (unknown.length > 0) {
    throw new Error(`serial names no package with a test script under ${root}: ${unknown.join(', ')}`);
  }
  const pool = packages.filter((entry) => !serial.includes(entry.name));
  const tail = serial.map((name) => packages.find((entry) => entry.name === name));
  const order = [...pool, ...tail];

  const results = new Array(order.length);
  const held = new Array(order.length);
  let next = 0;

  // A package's output is released once it and every package before it have ended.
  const runOne = async (index) => {
    const startedAt = Date.now();
    const { code, text } = await testPackage(order[index].dir, Boolean(out.isTTY));
    results[index] = { name: order[index].name, code, seconds: Math.round((Date.now() - startedAt) / 1000) };
    held[index] = text;
    for (; next < order.length && held[next] !== undefined; next += 1) {
      out.write(`\n━━━ ${order[next].name} ━━━\n${held[next]}`);
    }
  };

  const indexes = order.map((_, index) => index);
  await mapLimited(indexes.slice(0, pool.length), size, runOne);
  await mapLimited(indexes.slice(pool.length), 1, runOne);

  out.write('\n━━━ workspace test summary ━━━\n');
  for (const result of results) {
    const ok = result.code === 0;
    out.write(`  ${ok ? '✓' : '✗'} ${result.name}${ok ? '' : ` (exit ${result.code})`} [${result.seconds}s]\n`);
  }

  return { code: results.some((result) => result.code !== 0) ? 1 : 0, results };
}

module.exports = { run, SERIAL };

if (require.main === module) {
  run().then(({ code }) => exitFlushed(code));
}
