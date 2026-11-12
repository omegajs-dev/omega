/**
 * The one reader of the process table, the one walk from a pid to everything
 * under it, and the ask (SIGTERM), grace and force (SIGKILL) the test runner
 * ends a set of pids with. The table is read once, while the tree is still
 * linked: a process whose parent dies is handed to PID 1, and the walk loses it.
 *
 * A failed read answers with no rows, never a partial table: what cannot be
 * seen is never signalled. Windows has no `ps`, so there the table is empty.
 *
 * Stdlib-only on purpose: a vendored module must not push a dependency onto
 * its hosts.
 */

const { execSync } = require('child_process');

// One snapshot of every process on the machine, in the four fields a caller needs.
const PROCESS_TABLE_COMMAND = 'ps -A -o pid=,ppid=,uid=,command=';

// A busy machine prints a few hundred KB of table, and a command line can be
// long; the default 1MB buffer is a limit this must never bump into.
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const PROCESS_READ_TIMEOUT_MS = 5000;

// How long an asked process gets before it is forced, and how often the wait looks.
const STOP_GRACE_MS = 2000;
const POLL_INTERVAL_MS = 100;

/**
 * Rows from one `ps -A -o pid=,ppid=,uid=,command=` snapshot.
 *
 * A line that does not read as three numbers and a command is dropped rather
 * than guessed at: a half-parsed row would be a kill order built on nothing.
 * @param {string} text - The raw ps output.
 * @returns {Array<{pid: number, ppid: number, uid: number, command: string}>}
 */
function parseProcessTable(text) {
  return String(text || '')
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((match) => !!match)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      command: match[4],
    }));
}

/**
 * One `ps -A` snapshot of the whole machine, as ps printed it.
 * @returns {string} The raw ps output, or '' when it could not be read.
 */
function readProcessTableText() {
  try {
    return execSync(PROCESS_TABLE_COMMAND, {
      encoding: 'utf8',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER,
      timeout: PROCESS_READ_TIMEOUT_MS,
    });
  } catch (error) {
    return '';
  }
}

/**
 * One snapshot of the whole machine, as rows.
 * @returns {Array<{pid: number, ppid: number, uid: number, command: string}>} No rows when it could not be read.
 */
function readProcessTable() {
  return parseProcessTable(readProcessTableText());
}

/**
 * Every process under `pid` in one snapshot, children before grandchildren.
 * A child in its own session or process group still names its parent, so it is found.
 * @param {Array<{pid: number, ppid: number}>} rows - From readProcessTable.
 * @param {number} pid - The root; it is not in the answer.
 * @returns {number[]} The descendants' pids.
 */
function descendantsOf(rows, pid) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }

  const found = new Set([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) || []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  found.delete(pid);
  return [...found];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// One refusal never stops the rest of the list. Only ESRCH means the process is
// gone; one that refuses the signal (EPERM) is still alive, and isAlive keeps it.
function signal(pids, name) {
  for (const pid of pids) {
    try { process.kill(pid, name); } catch (error) { /* ESRCH: gone; EPERM: alive, the wait sees it */ }
  }
}

async function waitGone(pids, ms) {
  const deadline = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    alive = alive.filter(isAlive);
  }
  return alive;
}

/**
 * End a set of processes: SIGTERM to each, `grace` ms for them to leave, then
 * SIGKILL to whatever is still alive, and the same wait again.
 * @param {number[]} pids - The processes to end.
 * @param {{grace?: number}} [options] - Milliseconds a process gets after the ask.
 * @returns {Promise<number[]>} The pids still alive after the force (one stuck in the kernel), else empty.
 */
async function endProcesses(pids, { grace = STOP_GRACE_MS } = {}) {
  signal(pids, 'SIGTERM');
  const survivors = await waitGone(pids, grace);
  signal(survivors, 'SIGKILL');
  return waitGone(survivors, grace);
}

module.exports = {
  readProcessTable,
  readProcessTableText,
  parseProcessTable,
  descendantsOf,
  endProcesses,
  STOP_GRACE_MS,
};
