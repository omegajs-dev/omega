/**
 * Test: every framework handler is an ES module the one loader answers
 *
 * Run: npx omega test backend:helpers/handler-trees
 *
 * Each file a loader loads under dist/omega's routes, schemas and events goes
 * through loadHandler and must answer a function. Loading is the proof: a file
 * keeping `module.exports` is refused, and an ES module keeping a top-level
 * `require(` throws, since an ES module has no `require`. The handler set is
 * each loader's own rule: a route or schema method file, an auth trigger, a
 * cron schedule and its jobs, a Firestore trigger, a payment transition.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const DIST = path.join(__dirname, '..', '..', 'dist', 'omega');
const LOADER = path.join(DIST, 'libraries', 'load-handler.js');

const METHOD_FILE = /^(get|post|put|patch|delete|index)\.js$/;
const NOT_A_ROUTE_DIR = (segment) => ['providers', 'templates', 'lib'].includes(segment) || segment.startsWith('_');
const EVENT_HANDLER = [
  /^auth\/(before|on)-[a-z-]+\.js$/,
  /^cron\/[a-z]+\.js$/,
  /^firestore\/.+\/on-[a-z-]+\.js$/,
  /^firestore\/payments-webhooks\/transitions\/(subscription|one-time)\/[^/]+\.js$/,
];

// A cron job is a file in a schedule's folder, and a schedule is a `cron/<name>.js` beside it
function isCronJob(rel, files) {
  const match = /^cron\/([a-z]+)\/[^/]+\.js$/.exec(rel);

  return Boolean(match) && files.includes(`cron/${match[1]}.js`);
}

// Every file under a tree, as paths relative to it
function walk(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? walk(root, path.join(dir, entry.name))
    : [path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/')]));
}

function handlerFiles() {
  const methodFiles = (tree) => walk(path.join(DIST, tree))
    .filter((rel) => METHOD_FILE.test(path.posix.basename(rel)) && !rel.split('/').some(NOT_A_ROUTE_DIR))
    .map((rel) => path.join(DIST, tree, rel));
  const events = walk(path.join(DIST, 'events'));
  const eventFiles = events
    .filter((rel) => EVENT_HANDLER.some((rule) => rule.test(rel)) || isCronJob(rel, events))
    .map((rel) => path.join(DIST, 'events', rel));

  return [...methodFiles('routes'), ...methodFiles('schemas'), ...eventFiles];
}

// A child process loads them: an ES module cannot be unloaded, and this one
// process is shared with every later suite that swaps a module in require.cache
const CHILD = `
const fs = require('node:fs');
const [loader, list, out] = process.argv.slice(2);
const { loadHandler } = require(loader);
const failures = [];
for (const file of JSON.parse(fs.readFileSync(list, 'utf8'))) {
  try {
    const handler = loadHandler(file);
    if (typeof handler !== 'function') failures.push(file + ': answers ' + typeof handler);
  } catch (e) {
    failures.push(file + ': ' + e.message.split('\\n')[0]);
  }
}
fs.writeFileSync(out, JSON.stringify(failures));
`;

module.exports = defineCases({
  description: 'Every framework handler loads through loadHandler as a function',
  type: 'group',

  tests: [
    {
      name: 'every-handler-under-routes-schemas-and-events-answers-a-function',
      async run({ expect, after }) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-handler-trees-'));
        after(() => fs.rmSync(dir, { recursive: true, force: true }));

        const files = handlerFiles();
        expect(files.length, 'the handler set the loaders load').toBe(195);

        fs.writeFileSync(path.join(dir, 'child.js'), CHILD);
        fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(files));

        const child = spawnSync(process.execPath, [path.join(dir, 'child.js'), LOADER, path.join(dir, 'files.json'), path.join(dir, 'failures.json')], { encoding: 'utf8' });
        expect(child.status, child.stderr).toBe(0);

        expect(JSON.parse(fs.readFileSync(path.join(dir, 'failures.json'), 'utf8'))).toEqual([]);
      },
    },
  ],
});
