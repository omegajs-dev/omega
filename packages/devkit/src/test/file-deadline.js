/**
 * The deadline of one file's process under `isolation: 'process'`. node's run()
 * names no child pid, so at the limit the deadline reads the process table once,
 * while the tree is still linked, and takes the file's child (a direct child of
 * this process whose command line carries the file's path) and everything under
 * it. Then it aborts the run's signal, which asks the child to end, and ends
 * every process it found through ../process-tree.js. Windows has no table, so
 * there the signal alone ends the child.
 */

const processTree = require('../process-tree.js');

// The file's child and its descendants, as table rows.
function fileTree(rows, file) {
  const child = rows.find((row) => row.ppid === process.pid && row.command.includes(file));
  if (!child) return [];
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return [child, ...processTree.descendantsOf(rows, child.pid).map((pid) => byPid.get(pid))];
}

// What the run knew at the deadline: the case in flight, or that none was.
function progressOf(begun, reported) {
  const leaf = begun.filter((item) => !item.parent).pop();
  if (leaf) return `case in flight: ${leaf.name}`;
  return reported > 0 ? 'every case had reported' : 'no case had started';
}

/**
 * One file's deadline. Pass `signal` to node's run(), then `watch` its stream.
 * @param {{file: string, rel: string, limit: number}} options - The file, its root-relative path, the milliseconds it may live.
 * @returns {{signal: AbortSignal, expired: Function, watch: Function}} `expired()` is true from the deadline on;
 *   `watch(stream)` resumes the stream and resolves null when the file ends in time, else the `file deadline` error once its processes are ended.
 */
function fileDeadline({ file, rel, limit }) {
  const controller = new AbortController();
  // node sends a case's start only once it reports; its dequeue arrives as it begins.
  const begun = [];
  let reported = 0;
  let expired = false;

  function track(stream) {
    stream.on('test:dequeue', (data) => {
      if (data.nesting === 0 && data.name === file) return;
      begun.forEach((item) => { if (item.nesting < data.nesting) item.parent = true; });
      begun.push({ name: data.name, nesting: data.nesting, parent: false });
    });
    const settle = (data) => {
      const index = begun.findIndex((item) => item.nesting === data.nesting && item.name === data.name);
      if (index !== -1) begun.splice(index, 1);
      if (data.details.type === 'test' && !(data.nesting === 0 && data.name === file)) reported += 1;
    };
    stream.on('test:pass', settle);
    stream.on('test:fail', settle);
  }

  async function expire() {
    expired = true;
    const tree = fileTree(processTree.readProcessTable(), file);
    controller.abort();
    const alive = new Set(await processTree.endProcesses(tree.map((row) => row.pid)));
    // The child's own command line is node's whole option list; the file names it already.
    const label = (row) => (row === tree[0] ? 'its process' : row.command);
    const ended = tree.filter((row) => !alive.has(row.pid)).map(label);
    const survivors = tree.filter((row) => alive.has(row.pid)).map((row) => `${row.pid} ${label(row)}`);
    let outcome = tree.length > 0
      ? `ended: ${ended.length > 0 ? ended.join('; ') : 'none'}`
      : 'ended: no process table row named it, so only its run signal';
    if (survivors.length > 0) outcome += `; still alive after the force: ${survivors.join('; ')}`;
    return new Error(`file deadline ${limit}ms: ${rel} never exited (${progressOf(begun, reported)}; ${outcome})`);
  }

  function watch(stream) {
    track(stream);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => expire().then(resolve, reject), limit);
      stream.on('end', () => {
        if (expired) return;
        clearTimeout(timer);
        resolve(null);
      });
      stream.on('error', (error) => {
        if (expired) return;
        clearTimeout(timer);
        reject(error);
      });
      stream.resume();
    });
  }

  return { signal: controller.signal, expired: () => expired, watch };
}

module.exports = { fileDeadline };
