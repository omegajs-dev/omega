/**
 * The one OMEGA test runner: discovers `defineCases` files under its roots, runs
 * the `_init.js` hooks once, then every case on node:test in THIS process, layer
 * row by layer row (src/test/layers.js): a `host` row through run-case.js, an
 * `app` row's driver wherever its bodies run. `config.isolation: 'process'`
 * runs each file as its own node:test child instead, up to `config.concurrency`
 * at once (default `poolSize()`), then each `config.serial` file alone; a child
 * that outlives `config.fileTimeout` (default ten minutes) ends with every
 * process under it as a `file deadline` failure (src/test/file-deadline.js).
 * `createRunner(config).run(options)` resolves `{ passed, failed, skipped, noMatch, durationMs, tests }`.
 */

const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const os = require('os');
const path = require('path');

const expect = require('./expect.js');
const { normalizeSpec, errorOf } = require('./run-case.js');
const { layersFor, defaultLayer, needsDriver } = require('./layers.js');
const { discoverSuites } = require('./discovery.js');
const { runInitSetups, InitHookError } = require('./init-hooks.js');
const { noMatchMessage } = require('./scope.js');
const { makeExtendedModeWarning } = require('./extended-mode-warning.js');
const { createReporter } = require('./reporter.js');
const { createCaseSession, hostSession, registerSuite, registerLazySuites } = require('./register-suite.js');
const { guardStdout } = require('./guard-stdout.js');
const { TIMEOUT_ARG } = require('./define-cases.js');
const attachLogFile = require('../attach-log-file.js');
const { mapLimited, poolSize } = require('../map-limited.js');
const { fileDeadline } = require('./file-deadline.js');

const ISOLATIONS = ['none', 'process'];
const EVAL_FLAGS = ['-e', '--eval', '-p', '--print'];
// The extended-mode warning's detail lines when a framework passes none of its own.
const EXTENDED_MODE_LINES = ['Suites call REAL external services instead of skipping them.'];
// The preload each `process` child takes, the one every package script names.
// Resolved, never loaded here, and named so a host's vendor copy carries it.
const STDOUT_GUARD = require.resolve('./stdout-guard.js');
// The most one file's process may live under isolation: 'process'.
const DEFAULT_FILE_TIMEOUT = 600000;

// Registrations waiting for their bootstrap file to load inside node:test's run().
const plans = new Map();
let planCount = 0;

/**
 * Called by a run's bootstrap file, inside node:test's run(): registers the
 * plan's rows, suites and cases.
 * @param {string} id - The plan id.
 * @returns {void}
 */
function registerPlan(id) {
  const { describe, after } = require('node:test');
  const plan = plans.get(id);
  describe(plan.rootName, () => {
    for (const layer of plan.layers) {
      describe(layer.row.name, () => {
        after(() => layer.stop());
        const onEventOf = (entry) => (event, caseDef) => plan.onEvent(event, caseDef, entry, layer.row);
        if (layer.load) {
          registerLazySuites(layer.files, (file) => {
            const entry = layer.load(file);
            return entry && { suite: entry.suite, session: entry.session, onEvent: onEventOf(entry) };
          });
          return;
        }
        for (const entry of layer.entries) {
          registerSuite(entry.suite, { label: entry.label, session: entry.session, onEvent: onEventOf(entry) });
        }
      });
    }
  });
}

// Each host case runs in its own async scope, so an error nobody awaited (a
// timer that throws, a promise nobody handles) is traced to the case that raised it.
const caseScope = new AsyncLocalStorage();

/**
 * Watch for errors no case awaited. One raised by a case while it runs fails
 * that case; any other is kept as `loose`, for the run to report on its own.
 * @returns {{loose: Array, watch: Function, settled: Function, stop: Function}} The watch.
 */
function watchStrayErrors() {
  const loose = [];
  const running = new Map();
  const onError = (error) => {
    const failCase = running.get(caseScope.getStore());
    if (failCase) failCase(error);
    else loose.push(error);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);

  // The case's own settle waits one turn of the event loop, so a rejection it
  // raised in its last tick surfaces while it still counts as running.
  const watch = (caseDef) => ({
    ...caseDef,
    run: (ctx) => new Promise((resolve, reject) => {
      running.set(caseDef.id, reject);
      const later = (settle) => (value) => setImmediate(() => settle(value));
      caseScope.run(caseDef.id, () => {
        new Promise((done) => done(caseDef.run(ctx))).then(later(resolve), later(reject));
      });
    }).finally(() => running.delete(caseDef.id)),
  });

  return {
    loose,
    watch,
    settled: (id) => running.delete(id),
    stop() {
      process.off('uncaughtException', onError);
      process.off('unhandledRejection', onError);
    },
  };
}

/**
 * Build a runner for one framework's suites.
 * @param {object} config - See the file header; `framework` is a LAYERS key.
 * @returns {{run: Function}} The runner.
 */
function createRunner(config) {
  const rows = layersFor(config.framework);
  const isolation = config.isolation === undefined ? 'none' : config.isolation;
  if (!ISOLATIONS.includes(isolation)) {
    throw new Error(`Unknown isolation "${isolation}" (known: ${ISOLATIONS.join(', ')})`);
  }
  const processOnly = ['concurrency', 'serial', 'fileTimeout'].filter((key) => config[key] !== undefined);
  if (isolation !== 'process' && processOnly.length > 0) {
    throw new Error(`${processOnly[0]} needs isolation: 'process' (this runner's isolation is '${isolation}')`);
  }
  const fallback = isolation === 'process' ? poolSize() : 1;
  const concurrency = config.concurrency === undefined ? fallback : config.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency is the most files in flight, a whole number of 1 or more (got ${JSON.stringify(config.concurrency)})`);
  }
  const serial = config.serial === undefined ? [] : config.serial;
  if (!Array.isArray(serial)) throw new Error(`serial is a list of directory names (got ${JSON.stringify(serial)})`);
  const fileTimeout = config.fileTimeout === undefined ? DEFAULT_FILE_TIMEOUT : config.fileTimeout;
  if (!Number.isInteger(fileTimeout) || fileTimeout < 1) {
    throw new Error(`fileTimeout is the most milliseconds one file's process may live, a whole number of 1 or more (got ${JSON.stringify(config.fileTimeout)})`);
  }
  // node hands each child its parent's own options, an eval script included, so
  // every child of a `node -e` host would rerun that script instead of its file.
  if (isolation === 'process' && process.execArgv.some((arg) => EVAL_FLAGS.includes(arg.split('=')[0]))) {
    throw new Error("isolation: 'process' cannot run in a `node -e` or `node -p` process: node passes that script to every child it spawns. Start the runner from a file.");
  }

  function record(results, reporter, test) {
    results.tests.push(test);
    if (test.status === 'pass') results.passed += 1;
    else if (test.status === 'skip') results.skipped += 1;
    else results.failed += 1;
    reporter.result(test);
  }

  function recordFailure(results, reporter, fields) {
    record(results, reporter, {
      id: fields.id || fields.name,
      source: fields.source || null,
      file: fields.file || null,
      suite: null,
      name: fields.name,
      layer: fields.layer || null,
      status: 'fail',
      durationMs: 0,
      error: errorOf(fields.error),
    });
  }

  // Require and normalize one discovered file; a file that is no spec fails the run.
  function loadSuite(entry, results, reporter, filter) {
    let suite;
    try {
      delete require.cache[require.resolve(entry.file)];
      suite = normalizeSpec(require(entry.file), { file: entry.file });
    } catch (e) {
      recordFailure(results, reporter, { id: entry.file, source: entry.source, file: entry.file, name: entry.rel, error: e });
      return null;
    }

    const layer = suite.layer || defaultLayer(config.framework);
    if (!rows.some((row) => row.name === layer)) {
      const known = rows.map((row) => row.name).join(', ');
      const error = new Error(`${entry.file} names the layer "${layer}", which ${config.framework} does not have (layers: ${known})`);
      recordFailure(results, reporter, { id: entry.file, source: entry.source, file: entry.file, name: entry.rel, layer, error });
      return null;
    }

    const label = suite.description || entry.rel.split(path.sep).join('/');
    const cases = suite.cases.filter((caseDef) => !filter || caseDef.name.includes(filter) || label.includes(filter));
    return { ...entry, label, suite: { ...suite, layer, cases } };
  }

  // One row's driver, started once, by the row's first case: `start({ projectRoot,
  // options, suites, hooks, report })`, `report` on an app row alone. A one-row
  // framework passes no `suites` key: no file is loaded when the driver starts.
  function rowDriver(row, driver, context) {
    let started = null;
    return {
      start(report) {
        if (!started) {
          started = Promise.resolve(driver.start({
            projectRoot: config.projectRoot,
            options: context.options,
            ...(context.suites ? { suites: context.suites } : {}),
            hooks: context.hooks,
            ...(row.kind === 'app' ? { report } : {}),
          }));
        }
        return started;
      },
      async stop() {
        if (!started) return;
        const handle = await started.catch(() => null);
        if (handle) await handle.stop();
      },
    };
  }

  // A host suite's session: its cases under the stray watch, its ctx extras from the
  // row's driver, and a cleanup past its limit recorded as its own failure.
  function hostEntrySession(entry, control, context) {
    const session = hostSession({ ...entry.suite, cases: entry.suite.cases.map(context.stray.watch) }, {
      expect,
      defaultTimeout: config.defaultTimeout,
      extrasFrom: control ? async () => {
        const handle = await control.start();
        return (info) => handle.extras(info);
      } : undefined,
    });
    const fields = { id: `${entry.file}#cleanup`, source: entry.source, file: entry.file, name: entry.label, layer: entry.suite.layer };
    return { ...session, end: () => session.end().catch((error) => context.recordFailure({ ...fields, error })) };
  }

  function rowStop(row, control, context) {
    return async () => {
      if (!control) return;
      try {
        await control.stop();
      } catch (e) {
        context.recordFailure({ id: `${row.name}#stop`, name: `${row.name} layer stop`, layer: row.name, error: e });
      }
    };
  }

  function layerPlan(row, driver, entries, context) {
    const control = driver ? rowDriver(row, driver, { ...context, suites: entries.map((entry) => entry.suite) }) : null;
    const endedMessage = `the ${row.name} layer ended before this case reported`;

    if (row.kind === 'app') {
      const session = createCaseSession({
        cases: entries.flatMap((entry) => entry.suite.cases),
        endedMessage,
        fail: (fields) => context.recordFailure({ ...fields, layer: row.name }),
        start: async (report) => {
          const handle = await control.start(report);
          await handle.finished;
        },
      });
      entries.forEach((entry) => { entry.session = session; });
    } else {
      entries.forEach((entry) => { entry.session = hostEntrySession(entry, control, context); });
    }

    return { row, entries, stop: rowStop(row, control, context) };
  }

  // A host row: each file loads when the run reaches it, after the previous
  // file's cleanup.
  function lazyLayerPlan(row, driver, files, context) {
    const control = driver ? rowDriver(row, driver, context) : null;
    const load = (file) => {
      const entry = context.load(file);
      if (!entry || entry.suite.cases.length === 0) return null;
      return { ...entry, session: hostEntrySession(entry, control, context) };
    };
    return { row, files, load, stop: rowStop(row, control, context) };
  }

  // Register the layers with node:test and resolve once the plan's root suite ends.
  async function runOnNodeTest(layers, onEvent, recordFail) {
    const { run } = require('node:test');
    const id = `${process.pid}-${planCount += 1}`;
    const rootName = `omega-runner-${id}`;
    // A fresh file per run: node:test imports each file once per process.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-runner-'));
    const bootstrap = path.join(dir, 'register.cjs');
    fs.writeFileSync(bootstrap, `require(${JSON.stringify(__filename)}).registerPlan(${JSON.stringify(id)});\n`);
    plans.set(id, { rootName, layers, onEvent });

    try {
      await new Promise((resolve) => {
        const stream = run({ files: [bootstrap], isolation: 'none' });
        // The stream itself ends only when the event loop drains; the root suite's
        // own event is the end of the run.
        const finish = (event) => {
          if (event.nesting !== 0) return;
          if (event.name !== rootName) {
            recordFail({ id: event.name, name: event.name, error: event.details.error || new Error('node:test failed outside the run') });
          }
          resolve();
        };
        stream.on('test:pass', finish);
        stream.on('test:fail', finish);
        stream.resume();
      });
    } finally {
      plans.delete(id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // The error a node:test failure carries: the case's own error is its cause.
  function failureOf(error) {
    const cause = error && error.cause;
    const source = cause && typeof cause === 'object' && typeof cause.message === 'string' ? cause : error;
    return { name: source.name || 'Error', message: String(source.message), stack: source.stack };
  }

  // Run one file in its own node:test child, where it registers its cases through
  // defineCases. One run() per file: node stamps a case event with where its `it`
  // was called (register-suite.js), never with the file whose child sent it.
  // Everything the file reports goes through `hold`, to be released in file order.
  async function runInProcess(entry, { options, reporter, results, layer, cwd, hold: holdOp }) {
    const { run } = require('node:test');
    const deadline = fileDeadline({ file: entry.file, rel: entry.rel, limit: fileTimeout });
    // Past the file's deadline its one failure is all it reports.
    const hold = (op) => { if (!deadline.expired()) holdOp(op); };
    const fail = (error) => hold(() => recordFailure(results, reporter, { id: entry.file, source: entry.source, file: entry.file, name: entry.rel, layer, error }));
    const ancestors = [];
    const headed = new Set();
    let count = 0;
    const diagnostics = [];

    const settled = (status) => (data) => {
      const { details } = data;

      // node:test names a test for the file itself when the child reported no test of
      // its own, or when the child failed outside them (an error after its case ended).
      if (data.nesting === 0 && data.name === entry.file) {
        if (status === 'fail') {
          const when = count > 0 ? 'after its cases reported' : 'before any case reported';
          const why = diagnostics.length > 0 ? `: ${diagnostics.join('\n')}` : ' (its stderr is above)';
          fail(new Error(`${entry.rel}: its test process failed ${when}${why}`));
        } else if (!options.filter) fail(new Error(`${entry.rel} reported no cases: it exports no \`defineCases\` spec, or its process ended before its report`));
        return;
      }

      const suite = ancestors.slice(0, data.nesting).join(' > ') || null;
      if (details.type === 'suite') {
        if (status === 'fail' && details.error.failureType !== 'subtestsFailed') {
          // recordFailure takes an Error: a plain failureOf object would read as "[object Object]".
          const { name, message, stack } = failureOf(details.error);
          const error = Object.assign(new Error(message), { name, stack });
          hold(() => recordFailure(results, reporter, { id: `${entry.file}#${data.name}`, source: entry.source, file: entry.file, name: data.name, layer, error }));
        }
        return;
      }

      if (suite && !headed.has(suite)) {
        headed.add(suite);
        hold(() => reporter.suite(suite));
      }
      const skipped = status === 'pass' && data.skip !== undefined;
      const test = {
        id: `${entry.file}#${count++}`,
        source: entry.source,
        file: entry.file,
        suite,
        name: data.name,
        layer,
        status: skipped ? 'skip' : status,
        durationMs: Math.round(details.duration_ms),
        ...(skipped ? { reason: typeof data.skip === 'string' ? data.skip : 'skipped' } : {}),
        ...(status === 'fail' ? { error: failureOf(details.error) } : {}),
      };
      hold(() => record(results, reporter, test));
    };

    // run() skips every file when this process carries NODE_TEST_CONTEXT (a runner
    // started inside a test file inherits it). Its check is synchronous, and each
    // child it spawns gets a NODE_TEST_CONTEXT of its own.
    const inherited = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let stream;
    try {
      stream = run({
        files: [entry.file],
        isolation: 'process',
        execArgv: ['--require', STDOUT_GUARD],
        ...(config.defaultTimeout !== undefined ? { argv: [`${TIMEOUT_ARG}${config.defaultTimeout}`] } : {}),
        ...(cwd ? { cwd } : {}),
        ...(options.filter ? { testNamePatterns: [new RegExp(options.filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))] } : {}),
        signal: deadline.signal,
      });
    } finally {
      if (inherited !== undefined) process.env.NODE_TEST_CONTEXT = inherited;
    }
    stream.on('test:start', (data) => {
      ancestors.length = data.nesting;
      ancestors.push(data.name);
    });
    stream.on('test:pass', settled('pass'));
    stream.on('test:fail', settled('fail'));
    // A child's own output reaches this process's streams, so the reporter's run and the tee hold it.
    stream.on('test:stdout', (data) => hold(() => process.stdout.write(data.message)));
    stream.on('test:stderr', (data) => hold(() => process.stderr.write(data.message)));
    // Only a child's diagnostics carry its file (an error raised after its case ended);
    // the run's own count lines carry none and repeat the Results block.
    stream.on('test:diagnostic', (data) => {
      if (!data.file) return;
      diagnostics.push(data.message);
      hold(() => process.stderr.write(`${data.message}\n`));
    });
    const error = await deadline.watch(stream);
    if (error) holdOp(() => recordFailure(results, reporter, { id: `${entry.file}#deadline`, source: entry.source, file: entry.file, name: 'file deadline', layer, error }));
  }

  function rootOf(entry) {
    return config.roots.find((candidate) => path.resolve(config.projectRoot, candidate.dir) === entry.root);
  }

  // A root's `cwd` is its files' child cwd; with none, the child takes the runner's own.
  function childCwd(entry) {
    const root = rootOf(entry);
    return root && root.cwd ? path.resolve(config.projectRoot, root.cwd) : undefined;
  }

  // node's run() honors `cwd` from Node 23 on; Node 22 drops it without a word, which
  // matters only for a selected file whose root cwd is not this process's own.
  function cwdNeedsNewerNode(files) {
    if (Number(process.versions.node.split('.')[0]) >= 23) return null;
    const ownCwd = fs.realpathSync(process.cwd());
    const entry = files.find((file) => {
      const dir = childCwd(file);
      return dir !== undefined && (!fs.existsSync(dir) || fs.realpathSync(dir) !== ownCwd);
    });
    if (!entry) return null;
    const root = rootOf(entry);
    return new Error(`A root's cwd needs Node 23 or later under isolation: 'process' (this is Node ${process.versions.node}; the root ${root.dir} sets cwd ${root.cwd})`);
  }

  // Up to `concurrency` files in flight, then each `serial` file alone. A file's
  // report is held until it ends and released in discovery order, so the output
  // reads as a one-at-a-time run reads.
  async function runFilesInProcesses(files, context) {
    const held = files.map(() => null);
    let next = 0;
    const runOne = async (index) => {
      const ops = [];
      await runInProcess(files[index], { ...context, cwd: childCwd(files[index]), hold: (op) => ops.push(op) });
      held[index] = ops;
      for (; next < files.length && held[next]; next += 1) held[next].forEach((op) => op());
    };
    const isSerial = (entry) => path.dirname(entry.rel).split(path.sep).some((dir) => serial.includes(dir));
    const indexes = files.map((_, index) => index);
    await mapLimited(indexes.filter((index) => !isSerial(files[index])), concurrency, runOne);
    await mapLimited(indexes.filter((index) => isSerial(files[index])), 1, runOne);
  }

  const driverFor = (row) => config.drivers && config.drivers[row.name];

  // A row that needs a driver and has none fails the run naming the layer.
  function lacksDriver(row, context) {
    if (driverFor(row) || !needsDriver(row)) return false;
    context.recordFailure({ name: `${row.name} layer`, layer: row.name, error: new Error(`The ${row.name} layer needs a driver to run its suites, and this runner has none`) });
    return true;
  }

  // Every file loads once up front, since only its spec names its row. An app
  // row keeps those suites (its driver needs them all to start); a host row
  // loads each file again when the run reaches it, so what a file saves at load
  // time is what an earlier suite's cleanup left behind.
  function upFrontLayers(wanted, files, context) {
    const byLayer = new Map(rows.map((row) => [row.name, []]));
    for (const entry of files) {
      const loaded = context.load(entry);
      if (loaded && loaded.suite.cases.length > 0) byLayer.get(loaded.suite.layer).push(loaded);
    }
    return wanted
      .filter((row) => byLayer.get(row.name).length > 0 && !lacksDriver(row, context))
      .map((row) => (row.kind === 'app'
        ? layerPlan(row, driverFor(row), byLayer.get(row.name), context)
        : lazyLayerPlan(row, driverFor(row), byLayer.get(row.name).map(({ suite, label, ...file }) => file), context)));
  }

  function lazyLayers(wanted, files, context) {
    const row = wanted[0];
    return lacksDriver(row, context) ? [] : [lazyLayerPlan(row, driverFor(row), files, context)];
  }

  async function execute(options, reporter, results, stray) {
    const fail = (fields) => recordFailure(results, reporter, fields);

    reporter.start();

    if (process.env.TEST_EXTENDED_MODE) {
      makeExtendedModeWarning(config.extendedModeLines || EXTENDED_MODE_LINES).forEach((line) => reporter.note(line));
    }

    let wanted = rows;
    if (options.layer) {
      wanted = rows.filter((row) => row.name === options.layer);
      if (wanted.length === 0) {
        const known = rows.map((row) => row.name).join(', ');
        fail({ name: `--layer=${options.layer}`, error: new Error(`Unknown layer "${options.layer}" for ${config.framework} (layers: ${known})`) });
        return;
      }
    }

    const lanes = config.lanes || [];
    if (options.lane && !lanes.includes(options.lane)) {
      fail({ name: `--lane=${options.lane}`, error: new Error(`Unknown lane "${options.lane}" (lanes: ${lanes.join(', ') || 'none declared'})`) });
      return;
    }

    const { files, noMatch, invalid } = discoverSuites(config, options);
    invalid.forEach((bad) => reporter.note(`⚠ Unknown test scope prefix ignored: ${bad}`));
    if (noMatch) {
      results.noMatch = noMatch;
      reporter.note(noMatchMessage(noMatch));
    }
    if (files.length === 0) {
      if (!noMatch) reporter.note('No test files found.');
      return;
    }

    const tooOld = isolation === 'process' ? cwdNeedsNewerNode(files) : null;
    if (tooOld) {
      fail({ name: `a root cwd on Node ${process.versions.node}`, error: tooOld });
      return;
    }

    let hooks;
    try {
      const initRoots = config.roots.map((root) => ({ dir: path.resolve(config.projectRoot, root.dir), label: root.source }));
      hooks = await runInitSetups(initRoots, config.projectRoot, config.init || {});
    } catch (e) {
      if (!(e instanceof InitHookError)) throw e;
      fail({ id: e.file, file: e.file, name: path.relative(config.projectRoot, e.file), error: e });
      return;
    }

    if (isolation === 'process') {
      await runFilesInProcesses(files, { options, reporter, results, layer: wanted[0].name });
      return;
    }

    const context = { options, hooks, stray, recordFailure: fail, load: (entry) => loadSuite(entry, results, reporter, options.filter) };
    // A one-row framework needs no up-front load: its only row is a host row.
    const layers = rows.length === 1 ? lazyLayers(wanted, files, context) : upFrontLayers(wanted, files, context);
    if (layers.length === 0) return;

    const headed = new Set();
    const onEvent = (event, caseDef, entry, row) => {
      stray.settled(event.id);
      if (!headed.has(entry)) {
        headed.add(entry);
        reporter.suite(entry.label);
      }
      record(results, reporter, {
        id: event.id,
        source: entry.source,
        file: entry.file,
        suite: entry.label,
        name: event.name || caseDef.name,
        layer: row.name,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.status === 'skip' && event.reason ? { reason: event.reason } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
    };

    await runOnNodeTest(layers, onEvent, fail);
  }

  /**
   * Run the suites once.
   * @param {{targets?: string[], filter?: string, layer?: string, lane?: string, extended?: boolean, reporter?: string}} [options]
   * @returns {Promise<{passed: number, failed: number, skipped: number, noMatch: string|null, durationMs: number, tests: object[]}>}
   */
  async function run(options = {}) {
    const reporter = createReporter(options.reporter || 'pretty', { title: config.title });
    const restoreTee = attachLogFile.mark();
    if (config.log) attachLogFile(config.log);
    // In json mode stdout carries the one document; everything else goes to stderr.
    const restoreStdout = options.reporter === 'json' ? guardStdout({ strict: true }) : () => {};
    const stray = watchStrayErrors();

    const priorExtended = process.env.TEST_EXTENDED_MODE;
    if (options.extended) process.env.TEST_EXTENDED_MODE = 'true';

    const results = { passed: 0, failed: 0, skipped: 0, noMatch: null, durationMs: 0, tests: [] };
    const startTime = Date.now();
    try {
      await execute(options, reporter, results, stray);
    } finally {
      stray.stop();
      stray.loose.forEach((error, index) => recordFailure(results, reporter, {
        id: `uncaught#${index + 1}`,
        name: 'an error raised outside any running case (a timer or promise a case left behind)',
        error,
      }));
      results.durationMs = Date.now() - startTime;
      if (priorExtended === undefined) delete process.env.TEST_EXTENDED_MODE;
      else process.env.TEST_EXTENDED_MODE = priorExtended;
      restoreStdout();
      reporter.finish(results);
      restoreTee();
    }
    return results;
  }

  return { run };
}

module.exports = { createRunner, registerPlan };
