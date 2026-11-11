/**
 * Process isolation's `concurrency` and `serial` knobs and a root's `cwd`.
 * Each run is one createRunner config of _fixtures/concurrency/drive.js in
 * its own process; a fixture case records its start and end, or its cwd.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('../../src/test/define-cases.js');
const { DEVKIT, cleanEnv, fixtureDir, tempPath, removeAll, takeFile } = require('./_fixtures/helpers.js');

const DRIVE = path.join(fixtureDir('concurrency'), 'drive.js');
const SPAWN_TIMEOUT = 60000;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

// A runner config that is valid apart from the knob a case varies.
const BASE = {
  framework: 'node',
  title: 'concurrency knobs',
  projectRoot: DEVKIT,
  roots: [{ source: 'project', dir: path.join(DEVKIT, 'test') }],
  drivers: {},
  packageName: 'fixture-conc-knobs',
  frameworkAliases: [],
};

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// Every `<label>.json` a fixture case wrote, by label.
function readRecords(dir) {
  const records = {};
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    records[record.label] = record;
  }
  return records;
}

/**
 * Drive one config. stdout and stderr share one file, so `output` keeps the
 * order the reporter wrote in. The tee is skipped under CI, so the child runs
 * as a local one; `env` adds to the child's clean env.
 */
function drive(config, env = {}) {
  const out = tempPath('conc.json');
  const recordDir = tempPath('conc-records');
  const combined = tempPath('conc-output.txt');
  fs.mkdirSync(recordDir);
  const fd = fs.openSync(combined, 'w');
  let child;
  try {
    child = spawnSync(process.execPath, [DRIVE, JSON.stringify(config), out], {
      cwd: DEVKIT,
      env: cleanEnv({ FIXTURE_OUT: recordDir, CI: undefined, GITHUB_ACTIONS: undefined, ...env }),
      stdio: ['ignore', fd, fd],
      timeout: SPAWN_TIMEOUT,
    });
  } finally {
    fs.closeSync(fd);
  }
  const output = stripAnsi(takeFile(combined) || '');
  const written = takeFile(out);
  const log = stripAnsi(takeFile(`${out}.log`) || '');
  const records = readRecords(recordDir);
  removeAll(recordDir);
  if (!written) throw new Error(`drive.js wrote no result (exit ${child.status}):\n${output}`);
  return { ...JSON.parse(written), output, log, records };
}

const overlaps = (x, y) => x.start < y.end && y.start < x.end;

// Every pair of recorded runs whose spans overlap, as `x+y`.
function overlappingPairs(records) {
  const runs = Object.values(records);
  return runs.flatMap((x, i) => runs.slice(i + 1).filter((y) => overlaps(x, y)).map((y) => `${x.label}+${y.label}`));
}

const order = (result) => result.tests.map((t) => `${path.basename(t.file)}:${t.name}`);

// The owner of each marker, in the order the markers appear in `text`.
function ownersInOrder(text, markers) {
  return Object.entries(markers)
    .flatMap(([owner, list]) => list.map((marker) => ({ owner, marker, at: text.indexOf(marker) })))
    .sort((x, y) => x.at - y.at)
    .map(({ owner, marker, at }) => (at === -1 ? `${owner}:missing ${marker}` : owner));
}

module.exports = defineCases({
  type: 'group',
  description: 'concurrency',
  timeout: 90000,
  tests: [
    {
      name: 'case-128 concurrency 3 overlaps file runs, concurrency 1 runs them one at a time',
      run(ctx) {
        const wide = drive({ fixture: 'overlap', isolation: 'process', concurrency: 3 });
        ctx.expect(wide.error, wide.output).toBeNull();
        ctx.expect(Object.keys(wide.records).sort(), wide.output).toEqual(['a', 'b', 'c']);
        ctx.expect(overlappingPairs(wide.records).length, JSON.stringify(wide.records)).toBeGreaterThanOrEqual(1);

        const narrow = drive({ fixture: 'overlap', isolation: 'process', concurrency: 1 });
        ctx.expect(narrow.error, narrow.output).toBeNull();
        ctx.expect(Object.keys(narrow.records).sort(), narrow.output).toEqual(['a', 'b', 'c']);
        ctx.expect(overlappingPairs(narrow.records), JSON.stringify(narrow.records)).toEqual([]);
      },
    },
    {
      name: 'process isolation with no concurrency set overlaps file runs',
      skip: os.availableParallelism() < 3 && 'the parallel default needs three or more cores',
      run(ctx) {
        const run = drive({ fixture: 'overlap', isolation: 'process' });
        ctx.expect(run.error, run.output).toBeNull();
        ctx.expect(Object.keys(run.records).sort(), run.output).toEqual(['a', 'b', 'c']);
        ctx.expect(overlappingPairs(run.records).length, JSON.stringify(run.records)).toBeGreaterThanOrEqual(1);
      },
    },
    {
      name: 'case-129 under concurrency the report lists files in discovery order though the first ended last',
      run(ctx) {
        const wide = drive({ fixture: 'overlap', isolation: 'process', concurrency: 3, reporter: 'pretty' });
        ctx.expect(wide.error, wide.output).toBeNull();
        const { a, b, c } = wide.records;
        ctx.expect(a && b && c, wide.output).toBeTruthy();
        ctx.expect(a.end, 'a ended after b').toBeGreaterThan(b.end);
        ctx.expect(a.end, 'a ended after c').toBeGreaterThan(c.end);

        const at = (name) => wide.output.indexOf(name);
        ctx.expect(at('a runs longest'), wide.output).toBeGreaterThan(-1);
        ctx.expect(at('a runs longest'), wide.output).toBeLessThan(at('b runs short'));
        ctx.expect(at('b runs short'), wide.output).toBeLessThan(at('c runs short'));

        const narrow = drive({ fixture: 'overlap', isolation: 'process', concurrency: 1 });
        ctx.expect(narrow.error, narrow.output).toBeNull();
        ctx.expect(order(wide.result)).toEqual(order(narrow.result));
      },
    },
    {
      name: 'case-130 under concurrency a line a file writes to stdout sits with its own cases, in the output and the log',
      run(ctx) {
        const run = drive({ fixture: 'output', isolation: 'process', concurrency: 2, reporter: 'pretty' });
        ctx.expect(run.error, run.output).toBeNull();
        ctx.expect(run.result.passed, run.output).toBe(2);

        const markers = {
          alpha: ['output alpha', 'ALPHA LINE', 'alpha case'],
          beta: ['output beta', 'BETA LINE', 'beta case'],
        };
        const grouped = ['alpha', 'alpha', 'alpha', 'beta', 'beta', 'beta'];
        ctx.expect(ownersInOrder(run.output, markers), run.output).toEqual(grouped);
        ctx.expect(ownersInOrder(run.log, markers), run.log).toEqual(grouped);
      },
    },
    {
      name: 'case-131 a serial directory runs alone, after every other file ended',
      run(ctx) {
        const run = drive({ fixture: 'serial', isolation: 'process', concurrency: 3, serial: ['watch'] });
        ctx.expect(run.error, run.output).toBeNull();
        const { alpha, zulu, 'watch-one': one, 'watch-two': two } = run.records;
        ctx.expect(alpha && zulu && one && two, JSON.stringify(run.records)).toBeTruthy();

        const records = JSON.stringify(run.records);
        for (const watched of [one, two]) {
          const others = Object.values(run.records).filter((record) => record !== watched);
          ctx.expect(others.filter((other) => overlaps(watched, other)).map((o) => o.label), `${watched.label} ran alone: ${records}`).toEqual([]);
          ctx.expect(watched.start, `${watched.label} started after the others ended: ${records}`).toBeGreaterThanOrEqual(Math.max(alpha.end, zulu.end));
        }
      },
    },
    {
      name: 'case-132 createRunner refuses a concurrency that is not a whole number of 1 or more, and either knob without process isolation',
      run(ctx) {
        const { createRunner } = require('../../src/test/runner.js');

        ctx.expect(() => createRunner({ ...BASE, isolation: 'process', concurrency: 2, serial: ['watch'] }), 'a valid config').not.toThrow();
        for (const concurrency of [0, 1.5, '2']) {
          ctx.expect(() => createRunner({ ...BASE, isolation: 'process', concurrency }), `concurrency ${JSON.stringify(concurrency)}`).toThrow('concurrency');
        }
        ctx.expect(() => createRunner({ ...BASE, isolation: 'none', concurrency: 2 })).toThrow("isolation: 'process'");
        ctx.expect(() => createRunner({ ...BASE, isolation: 'none', serial: ['watch'] })).toThrow("isolation: 'process'");
      },
    },
    {
      name: 'case-133 a root cwd is its files\' cwd under process isolation, and a root without one takes the runner\'s',
      skip: NODE_MAJOR < 23 && 'a root cwd under process isolation needs Node 23',
      run(ctx) {
        const run = drive({
          fixture: 'cwd',
          isolation: 'process',
          roots: [{ dir: 'with-cwd', cwd: '.' }, { dir: 'without-cwd' }],
        });
        ctx.expect(run.error, run.output).toBeNull();
        const { 'with-cwd': withCwd, 'without-cwd': withoutCwd } = run.records;
        ctx.expect(withCwd && withoutCwd, `${JSON.stringify(run.records)}\n${run.output}`).toBeTruthy();

        ctx.expect(fs.realpathSync(withCwd.cwd)).toBe(fs.realpathSync(path.join(fixtureDir('concurrency'), 'cwd')));
        ctx.expect(fs.realpathSync(withoutCwd.cwd)).toBe(fs.realpathSync(DEVKIT));
      },
    },
    {
      name: 'below Node 23 a run that selects a file from a root whose cwd is not the runner\'s fails before any file runs, naming the version and the root',
      run(ctx) {
        const fixture = path.join(fixtureDir('concurrency'), 'cwd');
        const roots = [{ dir: 'with-cwd', cwd: '.' }, { dir: 'without-cwd' }];

        const refused = drive({ fixture: 'cwd', isolation: 'process', roots, node: '22.12.0' });
        ctx.expect(refused.error, refused.output).toBeNull();
        ctx.expect(refused.result.failed, JSON.stringify(refused.result.tests)).toBe(1);
        ctx.expect(refused.result.passed).toBe(0);
        const { message } = refused.result.tests[0].error;
        ctx.expect(message).toContain('Node 22.12.0');
        ctx.expect(message).toContain(`${path.join(fixture, 'with-cwd')} sets cwd ${fixture}`);
        ctx.expect(refused.records, 'no file ran').toEqual({});

        // A scope that selects none of that root's files runs on Node 22 as before.
        const scoped = drive({ fixture: 'cwd', isolation: 'process', roots, node: '22.12.0', targets: ['y'] });
        ctx.expect(scoped.error, scoped.output).toBeNull();
        ctx.expect(scoped.result.failed, JSON.stringify(scoped.result.tests)).toBe(0);
        ctx.expect(scoped.result.passed, scoped.output).toBe(1);
        ctx.expect(Object.keys(scoped.records)).toEqual(['without-cwd']);

        // A root whose cwd is the runner's own needs no newer Node.
        const own = drive({ fixture: 'cwd', isolation: 'process', roots: [{ dir: 'with-cwd', cwd: path.relative(fixture, DEVKIT) }], node: '22.12.0' });
        ctx.expect(own.error, own.output).toBeNull();
        ctx.expect(own.result.passed, JSON.stringify(own.result.tests)).toBe(1);
      },
    },
    {
      name: 'a process-isolated runner started under an inherited NODE_TEST_CONTEXT still runs its files\' cases',
      run(ctx) {
        const run = drive({ fixture: 'overlap', isolation: 'process', concurrency: 3 }, { NODE_TEST_CONTEXT: 'child-v8' });
        ctx.expect(run.error, run.output).toBeNull();
        ctx.expect(run.result.failed, JSON.stringify(run.result.tests)).toBe(0);
        ctx.expect(run.result.passed, run.output).toBe(3);
        ctx.expect(Object.keys(run.records).sort()).toEqual(['a', 'b', 'c']);
      },
    },
    {
      name: 'createRunner under process isolation refuses a node -e host, naming -e',
      run(ctx) {
        const runner = path.join(DEVKIT, 'src', 'test', 'runner.js');
        const config = JSON.stringify({ ...BASE, isolation: 'process' });
        const script = `try { require(${JSON.stringify(runner)}).createRunner(${config}); console.log('no refusal'); } catch (e) { console.log(e.message); }`;
        const result = spawnSync(process.execPath, ['-e', script], { cwd: DEVKIT, env: cleanEnv(), encoding: 'utf8', timeout: SPAWN_TIMEOUT });
        ctx.expect(result.status, result.stderr).toBe(0);
        ctx.expect(result.stdout, result.stderr).toContain('`node -e`');
        ctx.expect(result.stdout).not.toContain('no refusal');
      },
    },
    {
      name: 'case-134 one failing file under concurrency fails the run and leaves the other files passed',
      run(ctx) {
        const run = drive({ fixture: 'failing', isolation: 'process', concurrency: 3 });
        ctx.expect(run.error, run.output).toBeNull();
        ctx.expect(run.result.failed, JSON.stringify(run.result.tests)).toBe(1);
        ctx.expect(run.result.passed).toBe(2);

        const statusOf = (name) => (run.result.tests.find((t) => t.name === name) || {}).status;
        ctx.expect(statusOf('a passes')).toBe('pass');
        ctx.expect(statusOf('c passes')).toBe('pass');
        ctx.expect(statusOf('b fails on purpose')).toBe('fail');
      },
    },
    {
      name: 'the runner\'s defaultTimeout reaches each process-isolated child',
      run(ctx) {
        const short = drive({ fixture: 'timeout', isolation: 'process', defaultTimeout: 50 });
        ctx.expect(short.error, short.output).toBeNull();
        ctx.expect(short.result.failed, JSON.stringify(short.result.tests)).toBe(1);
        ctx.expect(short.result.tests[0].error.message, short.output).toBe('Test timeout');

        const long = drive({ fixture: 'timeout', isolation: 'process', defaultTimeout: 1000 });
        ctx.expect(long.error, long.output).toBeNull();
        ctx.expect(long.result.passed, JSON.stringify(long.result.tests)).toBe(1);
      },
    },
  ],
});
