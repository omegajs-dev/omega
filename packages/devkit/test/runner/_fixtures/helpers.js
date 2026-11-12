/**
 * Shared plumbing for the runner's own suites: spawn `cli.js` on a fixture,
 * spawn a bare `node` run, run a createRunner scenario, and hand out temp
 * paths that each case removes when it is done.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVKIT = path.join(__dirname, '..', '..', '..');
const CLI = path.join(DEVKIT, 'src', 'test', 'cli.js');
const DRIVE_RUNNER = path.join(__dirname, 'drive-runner.js');
const SPAWN_TIMEOUT = 20000;

let tempCount = 0;

// A child starts clean: no inherited node:test child context or extended mode.
// An `extra` key set to undefined removes that variable too.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_EXTENDED_MODE;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function fixtureDir(name) {
  return path.join(__dirname, name);
}

// A fresh path under the OS temp dir; nothing is created.
function tempPath(label) {
  tempCount += 1;
  return path.join(os.tmpdir(), `omega-runner-test-${process.pid}-${tempCount}-${label}`);
}

function removeAll(...paths) {
  for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
}

// Read a temp output file a fixture wrote, then remove it.
function takeFile(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  removeAll(file);
  return text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function settle(result) {
  return {
    status: result.status,
    signal: result.signal,
    pid: result.pid,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

/**
 * Run `node cli.js` in a fixture dir. The log always goes to a temp path so a
 * fixture never grows a `logs/` dir; the caller removes `run.log`.
 */
function runCli(fixture, args = [], { reporter = 'json', env = {}, log = tempPath('cli.log') } = {}) {
  const result = spawnSync(process.execPath, [CLI, `--reporter=${reporter}`, `--log=${log}`, ...args], {
    cwd: fixtureDir(fixture),
    env: cleanEnv(env),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT,
  });
  const settled = settle(result);
  return { ...settled, log, json: reporter === 'json' ? parseJson(settled.stdout) : null };
}

// Run `node [...nodeArgs] <file>` in a fixture dir, outside any runner.
function runNode(fixture, nodeArgs, { env = {} } = {}) {
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: fixtureDir(fixture),
    env: cleanEnv(env),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT,
  });
  return settle(result);
}

/**
 * Run one createRunner scenario of drive-runner.js in its own process and
 * read back `{ result, error, calls }`, plus the child's own output.
 */
function runScenario(name, arg = '') {
  const out = tempPath(`${name}.json`);
  const result = spawnSync(process.execPath, [DRIVE_RUNNER, name, out, arg], {
    cwd: DEVKIT,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT,
  });
  const settled = settle(result);
  const written = fs.existsSync(out) ? parseJson(fs.readFileSync(out, 'utf8')) : null;
  removeAll(out, `${out}.log`);
  if (!written) {
    throw new Error(`scenario ${name} wrote no result (exit ${settled.status}):\n${settled.output}`);
  }
  return { ...written, ...settled };
}

/**
 * A run that failed either rejected or resolved with a failure. Returns the
 * text that can name the reason: the rejection, each case error, and stderr.
 */
function failureOf(scenario) {
  const failed = scenario.error !== null || (scenario.result && scenario.result.failed >= 1);
  const caseErrors = scenario.result
    ? scenario.result.tests.map((t) => (t.error ? t.error.message : '')).join('\n')
    : '';
  const text = [scenario.error ? scenario.error.message : '', caseErrors, scenario.stderr].join('\n');
  return { failed, text };
}

// Whether a pid names a live process; EPERM means one we may not signal, still alive.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Force-end each pid a case started that is still alive, so no run outlives its case.
function endAlive(pids) {
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}

function basenames(json) {
  return [...new Set(json.tests.map((t) => path.basename(t.file)))].sort();
}

function names(json) {
  return json.tests.map((t) => t.name).sort();
}

module.exports = {
  DEVKIT,
  cleanEnv,
  fixtureDir,
  tempPath,
  removeAll,
  takeFile,
  runCli,
  runNode,
  runScenario,
  failureOf,
  alive,
  endAlive,
  basenames,
  names,
};
