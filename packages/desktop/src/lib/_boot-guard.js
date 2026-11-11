// Boot guard: one timer over the main-process boot, so a boot that stalls (an
// Electron `ready` that never resolves after a single-instance takeover) ends by
// name instead of holding the lock in silence. main.js makes the one guard with
// the defaults; the limit is fixed, and no config or env key sets it.

const LoggerLite = require('./logger-lite.js');

const BOOT_LIMIT_MS = 60000;

/**
 * Make a boot guard. `start()` arms the timer, `step(name)` records the step the
 * boot has reached, `stop()` disarms it. When the limit runs out first, the guard
 * writes one line naming the last step reached and exits with code 1.
 * @param {object} [options]
 * @param {number} [options.limitMs] - the limit, BOOT_LIMIT_MS by default.
 * @param {(line: string) => void} [options.write] - writes the line, one line appended to runtime.log by default.
 * @param {(code: number) => void} [options.exit] - ends the app, the process's real exit by default.
 * @returns {{ start: () => void, step: (name: string) => void, stop: () => void }}
 */
function createBootGuard(options) {
  options = options || {};

  const limitMs = options.limitMs || BOOT_LIMIT_MS;
  const write = options.write || ((line) => new LoggerLite('boot-guard').error(line));
  const exit = options.exit || ((code) => process.exit(code));

  let timer = null;
  let lastStep = 'start';

  return {
    start() {
      if (timer) return;

      timer = setTimeout(() => {
        timer = null;
        write(`boot did not finish within ${limitMs / 1000} s; last step: ${lastStep}`);
        exit(1);
      }, limitMs);
    },

    step(name) {
      lastStep = name;
    },

    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { BOOT_LIMIT_MS, createBootGuard };
