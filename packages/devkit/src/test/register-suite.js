/**
 * Binds normalized case suites (run-case.js) to node:test. Every case is one
 * node:test test (an `it`, or a subtest of its file's `it` when the file loads
 * lazily), and every one waits on its own case event, reported by id
 * from a SESSION: a host suite run through `runSuite`, or an app layer whose
 * driver runs the cases inside the app. The first case to begin starts its
 * session, so setup, state, stop-on-failure and cleanup follow `runSuite` exactly.
 *
 * Shared by the runner and by `defineCases` when a file registers itself.
 */

const { runSuite, errorOf, SkipError } = require('./run-case.js');

function rebuildError(error) {
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  if (error.stack) rebuilt.stack = error.stack;
  return rebuilt;
}

/**
 * A session over a set of cases: `report(event)` settles one case by id, and
 * when `start(report)` settles, every case still unreported fails. A second
 * report for a settled case is a driver bug: with `fail` given it lands as its
 * own failing entry, so the run fails even when every case already passed.
 * @param {{cases: Array<{id: string, name: string}>, start: Function, endedMessage: string, fail?: Function}} options
 * @returns {{wait: Function, report: Function}} `wait(id)` starts the session once and resolves to that case's event.
 */
function createCaseSession({ cases, start, endedMessage, fail }) {
  const waiting = new Map();
  for (const caseDef of cases) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    waiting.set(caseDef.id, { name: caseDef.name, promise, resolve, settled: false });
  }

  function report(event) {
    const entry = waiting.get(event.id);
    if (!entry) throw new Error(`A case event arrived for a case this run does not hold: ${event.id}`);
    if (entry.settled) {
      const error = new Error(`Case ${event.id} reported twice`);
      if (!fail) throw error;
      fail({ id: `${event.id}#twice`, name: entry.name, error });
      return;
    }
    entry.settled = true;
    entry.resolve(event);
  }

  function endAll(error) {
    for (const [id, entry] of waiting) {
      if (!entry.settled) report({ id, name: entry.name, status: 'fail', durationMs: 0, error });
    }
  }

  let started = null;
  function wait(id) {
    if (!started) {
      started = Promise.resolve()
        .then(() => start(report))
        .then(
          () => endAll(errorOf(new Error(endedMessage))),
          (e) => endAll({ ...errorOf(e), message: `${endedMessage}: ${errorOf(e).message}` }),
        );
    }
    return waiting.get(id).promise;
  }

  // Resolves once the session has run to its end (setup, cases and cleanup), or at once when it never started.
  function finished() {
    return started || Promise.resolve();
  }

  return { wait, report, finished };
}

/**
 * Which cases node:test actually calls: a name pattern (`--test-name-pattern`)
 * filters an `it` out without calling it, so its case body must never run.
 * node:test calls a suite's `it`s in order, so a case is out once a later one
 * is called, or once the suite ends.
 * @param {Array<{id: string}>} cases - The suite's cases, in order.
 * @returns {{called: Function, wanted: Function, end: Function}} The gate.
 */
function createCallGate(cases) {
  const order = new Map(cases.map((caseDef, position) => [caseDef.id, position]));
  const pending = new Map();
  let reached = -1;
  let ended = false;
  const called = new Set();

  function settle() {
    for (const [id, resolve] of pending) {
      if (called.has(id)) resolve(true);
      else if (ended || order.get(id) < reached) resolve(false);
      else continue;
      pending.delete(id);
    }
  }

  return {
    called(id) {
      called.add(id);
      reached = Math.max(reached, order.get(id));
      settle();
    },
    wanted(id) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        settle();
      });
    },
    end() {
      ended = true;
      settle();
    },
  };
}

/**
 * A session that runs one suite on the host through `runSuite`.
 * @param {object} suite - A normalized suite, its `layer` set.
 * @param {{expect: Function, defaultTimeout?: number, extrasFrom?: Function}} options - `extrasFrom()` resolves the ctx extras when the session starts.
 * @returns {{wait: Function, report: Function, finished: Function, end: Function}} The session; `end()` settles the cases node:test never called and resolves once the suite has run, or rejects with the error of a cleanup that passed its limit.
 */
function hostSession(suite, { expect, defaultTimeout, extrasFrom }) {
  const gate = createCallGate(suite.cases);
  // A case node:test filtered out reports a skip nobody waits on, and its body never runs.
  const cases = suite.cases.map((caseDef) => ({
    ...caseDef,
    run: async (ctx) => {
      if (!(await gate.wanted(caseDef.id))) throw new SkipError('filtered out by name');
      return caseDef.run(ctx);
    },
  }));

  let lateCleanup = null;
  const session = createCaseSession({
    cases: suite.cases,
    endedMessage: `the ${suite.layer} layer ended before this case reported`,
    start: async (report) => {
      const extras = extrasFrom ? await extrasFrom() : undefined;
      lateCleanup = await runSuite({ ...suite, cases }, { expect, extras, defaultTimeout, report });
    },
  });

  return {
    ...session,
    wait(id) {
      gate.called(id);
      return session.wait(id);
    },
    // A cleanup past its limit rejects the end, so the run records it as a failure.
    async end() {
      gate.end();
      await session.finished();
      if (lateCleanup) throw lateCleanup;
    },
  };
}

// One case's node:test body: it waits on the case's event and settles as the case did.
function caseBody(caseDef, session, onEvent) {
  return async (t) => {
    const event = await session.wait(caseDef.id);
    if (onEvent) onEvent(event, caseDef);
    if (event.status === 'skip') {
      t.skip(event.reason);
      return;
    }
    if (event.status === 'fail') throw rebuildError(event.error);
  };
}

/**
 * Register one suite with node:test: a `describe` holding one `it` per case.
 * @param {object} suite - A normalized suite.
 * @param {{label: string, session: object, onEvent?: Function}} options - `onEvent(event, caseDef)` sees each case event.
 * @returns {void}
 */
function registerSuite(suite, { label, session, onEvent }) {
  const { describe, it, after } = require('node:test');
  describe(label, () => {
    // A host suite ends inside its describe: its cleanup has run before the next suite begins.
    if (session.end) after(() => session.end());
    for (const caseDef of suite.cases) it(caseDef.name, caseBody(caseDef, session, onEvent));
  });
}

/**
 * Register suite files that load only when the run reaches them: one `it` per
 * file, whose body loads the file and runs each case as a subtest. The file's
 * host session ends inside that body, so its cleanup has run before the next file loads.
 * @param {Array<{rel: string}>} files - The discovered files, in run order.
 * @param {Function} load - `load(file)` resolves `{ suite, session, onEvent }` from a host session, or null when the file has no case to run.
 * @returns {void}
 */
function registerLazySuites(files, load) {
  const { it } = require('node:test');
  for (const file of files) {
    it(file.rel, async (t) => {
      const loaded = load(file);
      if (!loaded) return;
      const { suite, session, onEvent } = loaded;
      try {
        for (const caseDef of suite.cases) await t.test(caseDef.name, caseBody(caseDef, session, onEvent));
      } finally {
        await session.end();
      }
    });
  }
}

module.exports = { createCaseSession, hostSession, registerSuite, registerLazySuites };
