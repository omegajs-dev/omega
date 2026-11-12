/**
 * Process isolation's `fileTimeout`: a file whose process outlives it is ended
 * with everything it started and fails as `file deadline`. Each run is one
 * createRunner config of _fixtures/deadline/drive.js in its own process.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const defineCases = require('../../src/test/define-cases.js');
const { DEVKIT, cleanEnv, tempPath, takeFile, alive, endAlive } = require('./_fixtures/helpers.js');

const DRIVE = path.join(__dirname, '_fixtures', 'deadline', 'drive.js');
const PATIENCE = 30000;
// Cases 1 and 2 need a child to start and report inside it, which a loaded machine slows.
const FILE_TIMEOUT = 8000;
const ON_WINDOWS = process.platform === 'win32';

// A runner config that is valid apart from the knob a case varies.
const BASE = {
  framework: 'node',
  title: 'file deadline',
  projectRoot: DEVKIT,
  roots: [{ source: 'project', dir: path.join(DEVKIT, 'test') }],
  drivers: {},
  packageName: 'fixture-deadline-knobs',
  frameworkAliases: [],
};

/**
 * Drive one config and read back `{ result, error, reads }`. Every pid the
 * fixture records is force-ended in the case's `after`, whatever the result.
 */
function drive(ctx, config) {
  const out = tempPath('deadline.json');
  const recorded = tempPath('deadline-pids.txt');
  const pids = {};
  ctx.after(() => endAlive(Object.values(pids).flat()));

  const child = spawnSync(process.execPath, [DRIVE, JSON.stringify(config), out], {
    cwd: DEVKIT,
    env: cleanEnv({ FIXTURE_OUT: recorded }),
    encoding: 'utf8',
    timeout: PATIENCE,
  });
  for (const line of (takeFile(recorded) || '').split('\n').filter(Boolean)) {
    const [label, pid] = line.split(':');
    (pids[label] = pids[label] || []).push(Number(pid));
  }
  const written = takeFile(out);
  takeFile(`${out}.log`);
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  if (!written) throw new Error(`drive.js wrote no result (exit ${child.status}, signal ${child.signal}):\n${output}`);
  return { ...JSON.parse(written), pids, output };
}

const deadlines = (result) => result.tests.filter((t) => t.name === 'file deadline');

// The one `file deadline` failure of a run, after checking it is the only one.
function theDeadline(ctx, run) {
  ctx.expect(run.error, run.output).toBeNull();
  const found = deadlines(run.result);
  ctx.expect(found.length, JSON.stringify(run.result.tests)).toBe(1);
  ctx.expect(found[0].status).toBe('fail');
  return found[0];
}

module.exports = defineCases({
  type: 'group',
  description: 'file deadline',
  timeout: 90000,
  tests: [
    {
      name: 'case-1 a file that lingers after its last case fails as file deadline, saying every case reported, and the other file keeps its pass',
      run(ctx) {
        const run = drive(ctx, { fixture: 'deadline/linger', fileTimeout: FILE_TIMEOUT });
        const deadline = theDeadline(ctx, run);

        ctx.expect(path.basename(deadline.file)).toBe('b-linger.test.js');
        const { message } = deadline.error;
        ctx.expect(message).toContain(`file deadline ${FILE_TIMEOUT}ms`);
        ctx.expect(message).toContain('b-linger.test.js');
        ctx.expect(message).toContain('never exited');
        ctx.expect(message).toContain('every case');
        ctx.expect(run.result.failed, JSON.stringify(run.result.tests)).toBe(1);

        const quick = run.result.tests.find((t) => t.name === 'a quick file passes and exits');
        ctx.expect(quick, JSON.stringify(run.result.tests)).toHaveProperty('status', 'pass');
      },
    },
    {
      name: 'case-2 a file whose case outwaits fileTimeout fails as file deadline, naming the case in flight',
      run(ctx) {
        const run = drive(ctx, { fixture: 'deadline/in-flight', fileTimeout: FILE_TIMEOUT });
        const deadline = theDeadline(ctx, run);

        ctx.expect(deadline.error.message).toContain(`file deadline ${FILE_TIMEOUT}ms`);
        ctx.expect(deadline.error.message).toContain('waits on a reply that never comes');
      },
    },
    {
      name: 'case-3 a detached child the file started is gone after the deadline, and the failure carries its command',
      skip: ON_WINDOWS && 'the runner sweeps no process tree on Windows',
      run(ctx) {
        const run = drive(ctx, { fixture: 'deadline/detached', fileTimeout: FILE_TIMEOUT });
        const deadline = theDeadline(ctx, run);
        const [sleep] = run.pids.sleep || [];

        ctx.expect(sleep, run.output).toBeTruthy();
        ctx.expect(alive(sleep), `sleep ${sleep} outlived the file`).toBe(false);
        ctx.expect(alive(run.pids.pid[0]), 'the file process outlived its deadline').toBe(false);
        ctx.expect(deadline.error.message).toContain('sleep 300');
      },
    },
    {
      name: 'case-4 a file whose process ignores the terminate signal is gone once the run ends',
      run(ctx) {
        const run = drive(ctx, { fixture: 'deadline/deaf', fileTimeout: FILE_TIMEOUT });
        theDeadline(ctx, run);
        const [pid] = run.pids.pid || [];

        ctx.expect(pid, run.output).toBeTruthy();
        ctx.expect(alive(pid), `the deaf file process ${pid} outlived the grace`).toBe(false);
      },
    },
    {
      name: 'case-5 files that exit inside fileTimeout report as before and read no process table',
      run(ctx) {
        const run = drive(ctx, { fixture: 'pids', fileTimeout: 60000 });
        ctx.expect(run.error, run.output).toBeNull();
        ctx.expect(run.result.tests.map((t) => `${t.name}:${t.status}`).sort()).toEqual(['records pid one:pass', 'records pid two:pass']);
        ctx.expect(run.result.failed).toBe(0);
        ctx.expect(run.reads, 'process table reads').toBe(0);

        // The count sees the runner's reads: a file past its deadline makes one.
        const late = drive(ctx, { fixture: 'deadline/linger', fileTimeout: FILE_TIMEOUT });
        ctx.expect(late.reads, late.output).toBeGreaterThanOrEqual(1);
      },
    },
    {
      name: 'case-6 createRunner refuses a fileTimeout that is not a whole number of 1 or more, naming the key',
      run(ctx) {
        const { createRunner } = require('../../src/test/runner.js');

        ctx.expect(() => createRunner({ ...BASE, isolation: 'process', fileTimeout: 60000 }), 'a valid config').not.toThrow();
        for (const fileTimeout of [0, 1.5, '60000']) {
          ctx.expect(() => createRunner({ ...BASE, isolation: 'process', fileTimeout }), `fileTimeout ${JSON.stringify(fileTimeout)}`).toThrow('fileTimeout');
        }
      },
    },
    {
      name: 'case-7 createRunner refuses fileTimeout under isolation none, naming the key and the isolation',
      run(ctx) {
        const { createRunner } = require('../../src/test/runner.js');

        ctx.expect(() => createRunner({ ...BASE, isolation: 'none', fileTimeout: 60000 })).toThrow('fileTimeout');
        ctx.expect(() => createRunner({ ...BASE, isolation: 'none', fileTimeout: 60000 })).toThrow("'none'");
      },
    },
  ],
});
