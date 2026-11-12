/**
 * Test: the seven handler loaders read an ES module's default export, and
 * refuse a `module.exports` handler by name
 *
 * Run: npx omega test backend:helpers/handler-loaders
 *
 * Routes, schemas, events, cron jobs, auth hooks, payment transitions and the
 * consumer `mcp.js` each load a file through the one loader. Per site, an ES
 * module handler runs with the payload that site hands it, and a CommonJS one
 * is refused naming its file; so too the admin cron and hook routes. Every
 * handler is a real file in scratch, run by the real loader at its call site.
 */
const path = require('node:path');
const pipeline = require('../../dist/omega/pipeline.js');
const events = require('../../dist/omega/events.js');
const { loadAndExecuteJobs } = require('../../dist/omega/cron.js');
const Context = require('../../dist/omega/context.js');
const { runAuthHook } = require('../../dist/omega/events/auth/utils.js');
const transitions = require('../../dist/omega/events/firestore/payments-webhooks/transitions/index.js');
const { loadConsumerTools } = require('../../dist/mcp/utils.js');
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const { bootOmega } = require('./_boot-omega.js');
const { captureOutput } = require('./_capture-output.js');
const { scratch, settle } = require('./_handler-cases.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const TRANSITIONS_DIR = path.dirname(require.resolve('../../dist/omega/events/firestore/payments-webhooks/transitions/index.js'));
const CRON_ROUTE = require.resolve('../../dist/omega/routes/admin/cron/post.js');
const HOOK_ROUTE = require.resolve('../../dist/omega/routes/admin/hook/post.js');

// The folder the admin cron route reads `<id>.js` under
const CRON_DIR = path.resolve(path.dirname(CRON_ROUTE), '../../../events/cron');

// The one refusal every loader answers a CommonJS handler with
const refusal = (file) => `${file} must be an ES module with one default export (export default async (...) => {})`;

// A fresh instance whose report() captures land in `reported`
function makeOmega(cwd) {
  const omega = bootOmega();

  omega.cwd = cwd || '/nonexistent-cwd';
  omega.handlers = {};
  omega.reported = [];
  omega.sentry = { captureException: (e) => omega.reported.push(e) };

  return omega;
}

// One real request through pipeline.run() on a real express app, answered and closed
async function request(omega, urlPath, options) {
  const app = require('express')();

  app.use((req, res) => pipeline.run(omega, 'thing', req, res, { authenticate: false, ...options }));

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.close();
  }
}

// An error's message and every cause under it, as one text
function errorText(error) {
  const lines = [];

  for (let e = error; e; e = e.cause) {
    lines.push(e.message);
  }

  return lines.join('\n');
}

// An admin route's payload, called directly; its answers land in `responses`
function adminCall(omega, data) {
  const responses = [];
  const ctx = {
    omega,
    log: () => {},
    error: () => {},
    setLogPrefix: () => {},
    isProduction: () => false,
    respond: (body, options) => responses.push({ body, code: options?.code || 200 }),
  };

  return {
    responses,
    payload: { ctx, omega, user: { authenticated: true, roles: { admin: true } }, data, analytics: { event: () => {} } },
  };
}

// The route that answers with the payload the pipeline handed it
const ECHO_ROUTE = `export default async ({ ctx, omega, user, data, usage, analytics }) => ctx.respond({
  data,
  signedOut: !user.auth.uid,
  hasOmega: omega === ctx.omega,
  hasUsage: !!usage,
  hasAnalytics: !!analytics,
});
`;

module.exports = defineCases({
  description: 'The handler loaders: an ES module runs, a module.exports handler is refused',
  type: 'group',

  tests: [
    // ─── Routes ───

    {
      name: 'routes-an-es-module-route-runs-with-the-request-payload',
      async run({ expect, after }) {
        const routesDir = scratch(after, { 'thing/get.js': ECHO_ROUTE });

        const answer = await request(makeOmega(), '/thing?n=7', { routesDir, validate: false });

        expect(answer.status, answer.text).toBe(200);
        expect(JSON.parse(answer.text)).toEqual({ data: { n: '7' }, signedOut: true, hasOmega: true, hasUsage: true, hasAnalytics: true });
      },
    },

    {
      name: 'routes-a-module-exports-route-is-refused-by-name',
      async run({ expect, after }) {
        const routesDir = scratch(after, { 'thing/get.js': "module.exports = async ({ ctx }) => ctx.respond({ ran: true });\n" });

        const answer = await request(makeOmega(), '/thing', { routesDir, validate: false });

        expect(answer.status, 'the route never answered').not.toBe(200);
        expect(answer.text).toContain(refusal(path.join(routesDir, 'thing', 'get.js')));
      },
    },

    // ─── Schemas ───

    {
      name: 'schemas-an-es-module-schema-runs-with-the-request-parts',
      async run({ expect, after }) {
        const routesDir = scratch(after, { 'thing/get.js': ECHO_ROUTE });
        const schemasDir = scratch(after, {
          'thing/get.js': `export default (context) => ({
            n: { type: 'number', default: 0 },
            parts: { type: 'string', default: Object.keys(context).sort().join(',') },
          });
          `,
        });

        const answer = await request(makeOmega(), '/thing?n=7', { routesDir, schemasDir });

        expect(answer.status, answer.text).toBe(200);
        expect(JSON.parse(answer.text).data).toEqual({ n: 7, parts: 'body,geolocation,headers,method,path,query,user' });
      },
    },

    {
      name: 'schemas-a-module-exports-schema-is-refused-by-name',
      async run({ expect, after }) {
        const routesDir = scratch(after, { 'thing/get.js': ECHO_ROUTE });
        const schemasDir = scratch(after, { 'thing/get.js': "module.exports = () => ({ n: { type: 'number', default: 0 } });\n" });

        const answer = await request(makeOmega(), '/thing?n=7', { routesDir, schemasDir });

        expect(answer.status, 'the route never answered').not.toBe(200);
        expect(answer.text).toContain(refusal(path.join(schemasDir, 'thing', 'get.js')));
      },
    },

    // ─── Events ───

    {
      name: 'events-an-es-module-handler-runs-with-the-trigger-payload',
      async run({ expect, after }) {
        const dir = scratch(after, {
          'handler.js': `export default async ({ ctx, omega, user, context, change, snapshot }) => ({
            hasCtx: typeof ctx.log === 'function',
            hasOmega: omega === ctx.omega,
            user,
            eventId: context.eventId,
            change,
            snapshot,
          });
          `,
        });
        const payload = { user: { uid: 'uid_1' }, context: { eventId: 'evt_1' }, change: { before: 'a', after: 'b' }, snapshot: { id: 'doc_1' } };

        const outcome = await settle(events.run(makeOmega(), path.join(dir, 'handler.js'), payload));

        expect(outcome.resolved).toEqual({ hasCtx: true, hasOmega: true, user: { uid: 'uid_1' }, eventId: 'evt_1', change: { before: 'a', after: 'b' }, snapshot: { id: 'doc_1' } });
      },
    },

    {
      name: 'events-a-module-exports-handler-is-refused-by-name',
      async run({ expect, after }) {
        const dir = scratch(after, { 'handler.js': "module.exports = async () => 'ran';\n" });
        const file = path.join(dir, 'handler.js');

        const outcome = await settle(events.run(makeOmega(), file, {}));

        expect(outcome.rejected instanceof Error, 'the trigger rejects').toBe(true);
        expect(errorText(outcome.rejected)).toContain(refusal(file));
      },
    },

    // ─── Cron jobs ───

    {
      name: 'cron-an-es-module-job-runs-with-its-payload',
      async run({ expect, after }) {
        const jobsDir = scratch(after, {
          'job.js': `export default async ({ ctx, omega, context }) => {
            context.ran = { hasCtx: typeof ctx.log === 'function', hasOmega: omega === ctx.omega };
          };
          `,
        });
        const omega = makeOmega();
        const context = {};

        await loadAndExecuteJobs('daily', jobsDir, omega, context);

        expect(context.ran).toEqual({ hasCtx: true, hasOmega: true });
        expect(omega.reported.length, 'the job raised nothing').toBe(0);
      },
    },

    {
      name: 'cron-a-module-exports-job-is-refused-by-name',
      async run({ expect, after }) {
        const jobsDir = scratch(after, { 'job.js': 'module.exports = async ({ context }) => { context.ran = true; };\n' });
        const omega = makeOmega();
        const context = {};

        await loadAndExecuteJobs('daily', jobsDir, omega, context);

        expect(context.ran, 'the job never ran').toBe(undefined);
        expect(omega.reported.map(errorText).join('\n')).toContain(refusal(`${jobsDir}/job.js`));
      },
    },

    // ─── The admin cron and hook routes ───

    {
      // The route reads <events/cron>/<id>.js, so the id is the climb to the scratch job
      name: 'admin-cron-route-runs-an-es-module-job-and-answers-its-result',
      async run({ expect, after }) {
        const dir = scratch(after, {
          'job.js': `export default async ({ ctx, omega, context }) => ({
            hasCtx: typeof ctx.respond === 'function',
            hasOmega: omega === ctx.omega,
            context,
          });
          `,
        });
        const call = adminCall({}, { id: path.relative(CRON_DIR, path.join(dir, 'job')) });

        await loadHandler(CRON_ROUTE)(call.payload);

        expect(call.responses).toEqual([{ body: { hasCtx: true, hasOmega: true, context: {} }, code: 200 }]);
      },
    },

    {
      name: 'admin-hook-route-fails-loudly-on-a-module-exports-hook-naming-the-file',
      async run({ expect, after }) {
        const cwd = scratch(after, { 'old-hook.js': 'module.exports = async () => ({ ran: true });\n' });
        const call = adminCall({ cwd }, { path: 'old-hook' });

        const outcome = await settle(loadHandler(HOOK_ROUTE)(call.payload));

        expect(call.responses, 'the route never answers "Hook not found"').toEqual([]);
        expect(errorText(outcome.rejected)).toContain(refusal(path.join(cwd, 'old-hook.js')));
      },
    },

    // ─── Auth hooks ───

    {
      name: 'auth-hooks-an-es-module-hook-runs-with-the-trigger-args',
      async run({ expect, after }) {
        const cwd = scratch(after, {
          'hooks/auth/on-create.js': `export default async (args) => {
            args.context.seen = { uid: args.user.uid, keys: Object.keys(args).sort() };
          };
          `,
        });
        const omega = makeOmega(cwd);
        const context = {};

        await runAuthHook('on-create', { omega, ctx: new Context(omega), user: { uid: 'uid_1' }, context });

        expect(context.seen).toEqual({ uid: 'uid_1', keys: ['context', 'ctx', 'omega', 'user'] });
      },
    },

    {
      name: 'auth-hooks-a-module-exports-hook-is-refused-by-name',
      async run({ expect, after }) {
        const cwd = scratch(after, { 'hooks/auth/on-create.js': 'module.exports = async ({ context }) => { context.seen = true; };\n' });
        const omega = makeOmega(cwd);
        const context = {};

        const outcome = await settle(runAuthHook('on-create', { omega, ctx: new Context(omega), user: { uid: 'uid_1' }, context }));

        expect(context.seen, 'the hook never ran').toBe(undefined);
        expect(errorText(outcome.rejected)).toContain(refusal(`${cwd}/hooks/auth/on-create.js`));
      },
    },

    // ─── Payment transitions ───

    {
      // dispatch() reads <transitions>/<category>/<name>.js, so the category
      // is the climb from the framework's transitions folder to the scratch one
      name: 'transitions-an-es-module-handler-runs-with-the-transition-context',
      async run({ expect, after, waitFor }) {
        const dir = scratch(after, { 'scratch-transition.js': 'export default async (context) => { context.ran = typeof context.ctx.log; };\n' });
        const omega = makeOmega();
        const context = { ctx: new Context(omega), omega };

        transitions.dispatch('scratch-transition', path.relative(TRANSITIONS_DIR, dir), context);

        await waitFor(() => context.ran);
        expect(context.ran).toBe('function');
      },
    },

    {
      name: 'transitions-a-module-exports-handler-is-refused-by-name',
      async run({ expect, after }) {
        const dir = scratch(after, { 'scratch-transition.js': 'module.exports = async (context) => { context.ran = true; };\n' });
        const omega = makeOmega();
        const context = { ctx: new Context(omega), omega };

        const output = await captureOutput(() => transitions.dispatch('scratch-transition', path.relative(TRANSITIONS_DIR, dir), context));

        expect(context.ran, 'the handler never ran').toBe(undefined);
        expect(output.stdout + output.stderr, 'the log says the file failed to load, not that it is missing').toContain('failed to load');
        expect(omega.reported.map(errorText).join('\n'), 'the load failure is reported').toContain(refusal(path.join(dir, 'scratch-transition.js')));
      },
    },

    // ─── The consumer mcp.js ───

    {
      name: 'mcp-an-es-module-tool-list-loads',
      async run({ expect, after }) {
        const cwd = scratch(after, {
          'mcp.js': "export default [{ name: 'list_notes', description: 'List notes', method: 'GET', path: '/notes' }];\n",
        });

        expect(loadConsumerTools(cwd)).toEqual([
          { name: 'list_notes', description: 'List notes', method: 'GET', path: '/notes', role: 'admin', _consumer: true },
        ]);
      },
    },

    {
      // A CommonJS tool list throws by name rather than answering no tools
      name: 'mcp-a-module-exports-tool-list-is-refused-by-name',
      async run({ expect, after }) {
        const cwd = scratch(after, {
          'mcp.js': "module.exports = [{ name: 'list_notes', description: 'List notes', method: 'GET', path: '/notes' }];\n",
        });

        // The one handler whose default export is an array, so its refusal names that form
        expect(() => loadConsumerTools(cwd)).toThrow(`${path.join(cwd, 'mcp.js')} must be an ES module with one default export (export default [ ... ])`);
      },
    },
  ],
});
