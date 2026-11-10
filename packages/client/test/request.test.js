const defineCases = require('@omega.js/devkit/test/define-cases');
const http = require('node:http');
const { getOmega, TEST_CONFIG, createOmega, clearStorage, disposeOmega } = require('./helpers.js');

const beforeEachHook = clearStorage;

// Node's own fetch, kept before any case swaps or deletes the global.
const realFetch = global.fetch;

// createRequest is pure wiring (deps-injected) — testable without the singleton.
// The real-wire proof (live emulator, real backend, real omega-properties) is
// the root `npm run test:auth` lane.
let createRequest;
let mergeUsageIntoBindings;
let WAKEUP_ROUTE;

// Minimal fetch stand-in: the only seam is the network itself (stubbing the
// transport boundary, not our own modules). Each call records the request and
// returns the queued response.
function fetchStub(queue) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift() || {};
    const headers = new Map(Object.entries(next.headers || {}));
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      headers: {
        get: (name) => headers.get(name.toLowerCase()) || null,
      },
      json: async () => next.json,
      text: async () => next.text || '',
    };
  };
  return calls;
}

module.exports = defineCases({
  type: 'group',
  description: 'request',
  setup: createOmega,
  cleanup: disposeOmega,
  tests: [
    ...(() => {
      const cases = [];
      let beforeHookRun;
      const beforeHook = (ctx) => (beforeHookRun ||= Promise.resolve().then(() => (async () => {
        const mod = await import('../src/modules/request.js');
        createRequest = mod.createRequest;
        mergeUsageIntoBindings = mod.mergeUsageIntoBindings;
        WAKEUP_ROUTE = mod.WAKEUP_ROUTE;
      })()));

      const afterEachHook = () => {
        delete global.fetch;
      };

      cases.push({
        name: 'Request Module > should require getApiUrl and getIdToken deps',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          ctx.expect(() => createRequest({})).toThrow(/getApiUrl and getIdToken/);
        },
      });

      cases.push({
        name: 'Request Module > should default to POST when a body is present (GET with a body is a guaranteed fetch TypeError)',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ headers: { 'content-type': 'application/json' }, json: {} }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => null,
          });

          await request('/omega/marketing/contact', { auth: false, body: { email: 'a@b.co' } });
          await request('/omega/verts/serve', { auth: false });

          ctx.expect(calls[0].options.method, 'body and no method infers POST').toBe('POST');
          ctx.expect(calls[1].options.method, 'no body stays GET').toBe('GET');
        },
      });

      cases.push({
        name: 'Request Module > should resolve route-relative paths through getApiUrl and attach a Bearer token',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ headers: { 'content-type': 'application/json' }, json: { token: 'abc' } }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => 'id-token-123',
          });

          const data = await request('/omega/user/token', { method: 'POST', body: {} });

          ctx.expect(calls[0].url).toBe('https://api.example.com/omega/user/token');
          ctx.expect(calls[0].options.headers['Authorization']).toBe('Bearer id-token-123');
          ctx.expect(calls[0].options.headers['Content-Type']).toBe('application/json');
          ctx.expect(calls[0].options.body).toBe('{}');
          ctx.expect(data.token).toBe('abc');
        },
      });

      cases.push({
        name: 'Request Module > a default Pages brand composes a route under its omega_api Cloud Functions address',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            brand: { ...TEST_CONFIG.brand, url: 'https://ian.github.io/site' },
            firebase: { app: { enabled: false, config: { projectId: 'omegajs-playground' } } },
          });
          const calls = fetchStub([{ headers: { 'content-type': 'application/json' }, json: { status: 'ok' } }]);

          await omega.request('/omega/health', { auth: false });

          ctx.expect(calls[0].url).toBe('https://us-central1-omegajs-playground.cloudfunctions.net/omega_api/omega/health');
        },
      });

      cases.push({
        name: 'Request Module > should pass absolute urls through untouched',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ text: 'ok' }]);
          const request = createRequest({
            getApiUrl: () => { throw new Error('must not be called'); },
            getIdToken: () => null,
          });

          await request('https://elsewhere.example.com/thing', { auth: false });
          ctx.expect(calls[0].url).toBe('https://elsewhere.example.com/thing');
        },
      });

      cases.push({
        name: 'Request Module > should skip Authorization with auth: false',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ text: 'ok' }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => { throw new Error('must not be called'); },
          });

          await request('/omega/verts/serve', { auth: false });
          ctx.expect(calls[0].options.headers['Authorization']).toBe(undefined);
        },
      });

      cases.push({
        name: 'Request Module > should send without Authorization when signed out (getIdToken null)',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ text: 'ok' }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => null,
          });

          await request('/omega/public');
          ctx.expect(calls[0].options.headers['Authorization']).toBe(undefined);
        },
      });

      cases.push({
        name: 'Request Module > wakeup: the ping carries the param, skips the token, and never awaits a body',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ headers: { 'content-type': 'application/json' }, json: { wakeup: true } }]);
          let tokenAsked = false;
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => { tokenAsked = true; return 'id-token-123'; },
          });

          const answer = await request('/omega/payments/intent', { wakeup: true });

          ctx.expect(calls[0].url, 'the param the backend middleware reads rides the url').toBe('https://api.example.com/omega/payments/intent?wakeup=true');
          ctx.expect(calls[0].options.method, 'a wakeup is a GET').toBe('GET');
          ctx.expect(tokenAsked, 'the middleware answers a wakeup before it authenticates, so no token is minted for it').toBe(false);
          ctx.expect(answer, 'nothing is read back — the caller is not waiting on an answer').toBe(undefined);
        },
      });

      cases.push({
        name: 'Request Module > wakeup: the ONE route every surface pings is exported here, route-relative',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          // Web pages, the desktop renderer's auth bridge and the extension's
          // surfaces all name this constant rather than a route of their own: a
          // wakeup never runs a route, so there is nothing to name per caller
          // ([#644](https://github.com/Omega-JS-Stack/omega/issues/644)). It stays
          // route-relative so each surface resolves it through its own getApiUrl —
          // an absolute url here would ping ONE brand's backend from every install.
          const calls = fetchStub([{ text: 'ok' }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => null,
          });

          ctx.expect(WAKEUP_ROUTE.startsWith('/'), 'route-relative, never a host').toBe(true);

          await request(WAKEUP_ROUTE, { wakeup: true });

          ctx.expect(calls[0].url, 'it resolves through the caller\'s own api url').toBe(`https://api.example.com${WAKEUP_ROUTE}?wakeup=true`);
        },
      });

      cases.push({
        name: 'Request Module > wakeup: an existing query string keeps its params',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const calls = fetchStub([{ text: 'ok' }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => null,
          });

          await request('https://api.example.com/omega/payments/intent?product=premium', { wakeup: true });

          ctx.expect(calls[0].url).toBe('https://api.example.com/omega/payments/intent?product=premium&wakeup=true');
        },
      });

      cases.push({
        name: 'Request Module > wakeup: a dead network resolves instead of throwing',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          global.fetch = async () => { throw new Error('network down'); };
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => null,
          });

          await request('/omega/payments/intent', { wakeup: true });
        },
      });

      cases.push({
        name: 'Request Module > a browser with no AbortSignal.timeout still aborts a timed-out request, on time',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          // A real server that takes the request and never answers it.
          const received = [];
          const server = http.createServer((req) => received.push(req.url));
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const url = `http://127.0.0.1:${server.address().port}/never`;

          const original = AbortSignal.timeout;
          delete AbortSignal.timeout;
          global.fetch = realFetch;
          try {
            const request = createRequest({ getApiUrl: () => 'unused', getIdToken: () => null });
            const started = Date.now();
            const error = await request(url, { auth: false, timeout: 200 }).catch((e) => e);
            const elapsed = Date.now() - started;

            ctx.expect(error instanceof Error, 'the request rejected').toBeTruthy();
            ctx.expect(['AbortError', 'TimeoutError'].includes(error.name), `an abort, not a ${error.name}: ${error.message}`).toBeTruthy();
            ctx.expect(received, 'the request reached the server before it aborted').toEqual(['/never']);
            ctx.expect(elapsed >= 150 && elapsed < 2000, `aborted at the timeout, took ${elapsed}ms`).toBeTruthy();
          } finally {
            AbortSignal.timeout = original;
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        },
      });

      cases.push({
        name: 'Request Module > a browser with no AbortSignal.timeout still aborts a body that never finishes, on time',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          // Headers at once, then a body that never ends: the fetch resolves, and
          // only the signal still armed through the body read can end the request.
          const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('partial');
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const url = `http://127.0.0.1:${server.address().port}/stalled`;

          const original = AbortSignal.timeout;
          delete AbortSignal.timeout;
          global.fetch = realFetch;
          let hang;
          try {
            const request = createRequest({ getApiUrl: () => 'unused', getIdToken: () => null });
            const started = Date.now();
            const stalled = new Promise((resolve) => { hang = setTimeout(() => resolve(new Error('HUNG')), 3000); });
            const error = await Promise.race([request(url, { auth: false, timeout: 200 }).then(() => new Error('RESOLVED'), (e) => e), stalled]);
            const elapsed = Date.now() - started;

            ctx.expect(['AbortError', 'TimeoutError'].includes(error.name), `an abort, not ${error.name}: ${error.message}`).toBeTruthy();
            ctx.expect(elapsed >= 150 && elapsed < 2000, `aborted at the timeout, took ${elapsed}ms`).toBeTruthy();
          } finally {
            clearTimeout(hang);
            AbortSignal.timeout = original;
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        },
      });

      cases.push({
        name: 'Request Module > should throw on non-ok responses with code, message, and data attached',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          fetchStub([{
            ok: false,
            status: 401,
            headers: { 'content-type': 'application/json' },
            json: { message: 'Unauthorized caller' },
          }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => 'tok',
          });

          const error = await request('/omega/user/token', { method: 'POST' }).catch(e => e);
          ctx.expect(error instanceof Error).toBeTruthy();
          ctx.expect(error.message).toBe('Unauthorized caller');
          ctx.expect(error.code).toBe(401);
          ctx.expect(error.data.message).toBe('Unauthorized caller');
        },
      });

      cases.push({
        name: 'Request Module > should probe the session on a 401 and still reject the request (#798)',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          fetchStub([
            { ok: false, status: 401, headers: { 'content-type': 'application/json' }, json: { message: 'Unauthorized caller' } },
            { ok: false, status: 401, text: 'nope' },
            { ok: false, status: 403, text: 'forbidden' },
          ]);
          const probes = [];
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => 'tok',
            // The probe rejecting must never become the caller's failure
            onUnauthorized: () => { probes.push('probe'); return Promise.reject(new Error('probe blew up')); },
          });

          const error = await request('/omega/user/token', { method: 'POST' }).catch(e => e);
          ctx.expect(probes.length, 'a 401 is a moment of doubt').toBe(1);
          ctx.expect(error.code, 'and the caller still gets its error, unchanged').toBe(401);

          // A public route's 401 is not this user's session: nothing was sent for it
          await request('/omega/verts/serve', { auth: false }).catch(e => e);
          ctx.expect(probes.length, 'auth: false never probes').toBe(1);

          await request('/omega/user/thing').catch(e => e);
          ctx.expect(probes.length, 'a 403 is an authorization answer, not a dead session').toBe(1);
        },
      });

      cases.push({
        name: 'Request Module > should parse omega-properties and call onProperties on success AND error',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const properties = { code: 200, usage: { current: { credits: { monthly: 5 } }, limits: { credits: 100 } } };
          fetchStub([
            { headers: { 'content-type': 'application/json', 'omega-properties': JSON.stringify(properties) }, json: {} },
            { ok: false, status: 429, headers: { 'omega-properties': JSON.stringify({ code: 429 }) }, text: 'limit' },
          ]);
          const seen = [];
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => 'tok',
            onProperties: (p) => seen.push(p),
          });

          await request('/omega/a');
          await request('/omega/b').catch(e => e);

          ctx.expect(seen.length).toBe(2);
          ctx.expect(seen[0].usage.current.credits.monthly).toBe(5);
          ctx.expect(seen[1].code).toBe(429);
        },
      });

      cases.push({
        name: 'Request Module > should return the complete shape with output: complete',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          fetchStub([{ status: 201, headers: { 'content-type': 'application/json' }, json: { id: 'x' } }]);
          const request = createRequest({
            getApiUrl: () => 'https://api.example.com',
            getIdToken: () => 'tok',
          });

          const complete = await request('/omega/things', { method: 'POST', output: 'complete' });
          ctx.expect(complete.status).toBe(201);
          ctx.expect(complete.ok).toBe(true);
          ctx.expect(complete.data.id).toBe('x');
        },
      });

      cases.push({
        name: 'Request Module > mergeUsageIntoBindings should merge current + limits into the usage key',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const context = { usage: { credits: { monthly: 2, daily: 1, limit: 50 } } };
          const updates = [];
          const bindings = {
            getContext: () => context,
            update: (data) => updates.push(data),
          };

          mergeUsageIntoBindings(bindings, {
            usage: { current: { credits: { monthly: 6 } }, limits: { credits: 100 } },
          });

          ctx.expect(updates.length).toBe(1);
          ctx.expect(updates[0].usage.credits).toEqual({ monthly: 6, daily: 1, limit: 100 });
        },
      });

      cases.push({
        name: 'Request Module > mergeUsageIntoBindings should no-op without usage counters',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const updates = [];
          const bindings = { getContext: () => ({}), update: (data) => updates.push(data) };

          mergeUsageIntoBindings(bindings, null);
          mergeUsageIntoBindings(bindings, { usage: { current: {} } });

          ctx.expect(updates.length).toBe(0);
        },
      });

      cases.push({
        name: 'Request Module > mergeUsageIntoBindings should keep the seeded limit when the payload omits a feature limit (wave-4 F8)',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.after(afterEachHook);
          const context = { usage: { credits: { monthly: 2, limit: 50 } } };
          const updates = [];
          const bindings = {
            getContext: () => context,
            update: (data) => updates.push(data),
          };

          mergeUsageIntoBindings(bindings, {
            usage: { current: { credits: { monthly: 6 } }, limits: {} },
          });

          ctx.expect(updates[0].usage.credits).toEqual({ monthly: 6, limit: 50 });

          // An explicit server limit of 0 still wins (?? keeps 0, only null/undefined fall back)
          mergeUsageIntoBindings(bindings, {
            usage: { current: { credits: { monthly: 6 } }, limits: { credits: 0 } },
          });
          ctx.expect(updates[1].usage.credits.limit).toBe(0);
        },
      });
      return cases;
    })(),
  ],
});
