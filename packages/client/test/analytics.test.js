const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('fs');
const path = require('path');
const { getOmega, TEST_CONFIG, createOmega, clearStorage, disposeOmega } = require('./helpers.js');

const beforeEachHook = clearStorage;

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'modules', 'analytics.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');
const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

module.exports = defineCases({
  type: 'group',
  description: 'analytics',
  setup: createOmega,
  cleanup: disposeOmega,
  tests: [
    {
      name: 'Analytics Module (C4 cp106a — de-ITW) > carries ZERO baked-in GA4 credentials',
      run: async (ctx) => {
        await beforeEachHook();
        ctx.expect(!SOURCE.includes('DEV_CREDENTIALS'), 'dev-credentials table is gone').toBeTruthy();
        ctx.expect(!/G-[A-Z0-9]{6,}/.test(SOURCE), 'no measurement ids in source').toBeTruthy();
        ctx.expect(SOURCE.includes('config.measurementId || config.id'), 'ids come from config alone').toBeTruthy();
      },
    },

    {
      name: 'Analytics Module (C4 cp106a — de-ITW) > flat analytics handoff is dead — canonical providers shape only',
      run: async (ctx) => {
        await beforeEachHook();
        ctx.expect(!INDEX_SOURCE.includes('googleSecret'), 'flat googleSecret handoff gone from index.js').toBeTruthy();
        ctx.expect(INDEX_SOURCE.includes('analytics?.providers?.google'), 'index.js reads the canonical providers shape').toBeTruthy();
      },
    },

    {
      name: 'Analytics Module (C4 cp106a — de-ITW) > dev mode logs events without posting; production posts',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;


        // Minimal browser surface for the module's page/event paths
        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        const fetchCalls = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          fetchCalls.push(url);
          return Promise.resolve({ ok: true });
        };

        try {
          // Dev: initializes with config creds, logs, never posts
          const dev = new Analytics({
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => true,
          });
          dev.init({ id: 'G-TESTONLY', secret: 'test-secret' });
          dev.event('app_launch');
          ctx.expect(fetchCalls.length, 'dev mode must never hit the Measurement Protocol').toBe(0);

          // Production: same config posts for real
          const prod = new Analytics({
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => false,
          });
          prod.init({ id: 'G-TESTONLY', secret: 'test-secret' });
          ctx.expect(fetchCalls.length > 0, 'production posts via the Measurement Protocol').toBeTruthy();
          ctx.expect(fetchCalls[0].includes('measurement_id=G-TESTONLY'), 'config id rides the request').toBeTruthy();

          // No config at all → inert (no invented fallbacks)
          const bare = new Analytics({
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => true,
          });
          bare.init({});
          ctx.expect(bare.initialized, 'no config → no analytics, no fallback creds').toBe(false);
        } finally {
          global.fetch = realFetch;
        }
      },
    },

    {
      name: 'Analytics Module (C4 cp106a — de-ITW) > identity: uuidv5 client_id/user_id in the project namespace (desktop convention)',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;
        const { v5: uuidv5 } = require('uuid');

        // localStorage shim so the device id persists between instances
        const store = new Map();
        global.localStorage = {
          getItem: (key) => (store.has(key) ? store.get(key) : null),
          setItem: (key, value) => store.set(key, value),
        };
        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        const sent = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          sent.push({ url, body: JSON.parse(options.body) });
          return Promise.resolve({ ok: true });
        };

        try {
          const omega = {
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => false,
          };

          // Same device + same project → same client_id on every instance,
          // and it is exactly uuidv5(deviceId, uuidv5(projectId, URL-ns))
          const a = new Analytics(omega);
          a.init({ id: 'G-TESTONLY', secret: 's', projectId: 'proj-x' });
          const b = new Analytics(omega);
          b.init({ id: 'G-TESTONLY', secret: 's', projectId: 'proj-x' });

          const ns = uuidv5('proj-x', uuidv5.URL);
          ctx.expect(a.clientId, 'client_id = uuidv5(deviceId, ns)').toBe(uuidv5(store.get('_omega_device_id'), ns));
          ctx.expect(a.clientId, 'stable across instances').toBe(b.clientId);

          // user_id = uuidv5(uid, ns) — the raw uid never leaves the device.
          // The fires below run on `b`, the host that init'd LAST: the facade holds
          // one transport per process, so the most recent host owns it. A runtime
          // has exactly one client singleton, so only a test ever has two.
          b.setUserId('firebase-uid-1');
          ctx.expect(b.userId).toBe(uuidv5('firebase-uid-1', ns));
          ctx.expect(b.userId).not.toBe('firebase-uid-1');

          sent.length = 0;
          b.event('app_launch');
          ctx.expect(sent.length, 'production event posts').toBe(1);
          ctx.expect(sent[0].body.user_id, 'payload carries the hashed user_id').toBe(uuidv5('firebase-uid-1', ns));
          ctx.expect(sent[0].body.client_id).toBe(b.clientId);

          // Logout clears it
          b.setUserId(null);
          ctx.expect(b.userId).toBe(null);

          // user properties ride wrapped as { value }
          b.setUserProperties({ plan: 'premium' });
          sent.length = 0;
          b.event('app_launch');
          ctx.expect(sent[0].body.user_properties).toEqual({ plan: { value: 'premium' } });
        } finally {
          global.fetch = realFetch;
          delete global.localStorage;
        }
      },
    },

    {
      name: 'Analytics Module (C4 cp106a — de-ITW) > the device id is the shared derivation, storage-backed, always a real UUID (#396)',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        // The wiring: one derivation for every surface, and the only thing this
        // runtime supplies is where it persists (no machine seed exists on a page).
        ctx.expect(SOURCE.includes('core.deriveDeviceId'), 'the client hosts the shared derivation').toBeTruthy();
        ctx.expect(!SOURCE.includes('crypto.randomUUID'), 'the local generator is gone').toBeTruthy();
        ctx.expect(!SOURCE.includes('Math.random'), 'the weak non-UUID fallback is gone').toBeTruthy();

        const store = new Map();
        global.localStorage = {
          getItem: (key) => (store.has(key) ? store.get(key) : null),
          setItem: (key, value) => store.set(key, value),
        };
        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        // An insecure origin: `crypto.getRandomValues` is there, `crypto.randomUUID`
        // is NOT — where the old fallback minted `<base36>.<timestamp>` (#396)
        const realCrypto = globalThis.crypto;
        Object.defineProperty(globalThis, 'crypto', {
          value: { getRandomValues: (array) => realCrypto.getRandomValues(array) },
          configurable: true,
        });

        try {
          const omega = {
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          };

          const first = new Analytics(omega);
          first.init({ projectId: 'proj-x' });

          const deviceId = store.get('_omega_device_id');
          ctx.expect(deviceId, 'a UUID even with no crypto.randomUUID to make one').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

          // Persisted, so the next boot on this browser is the same GA client
          const second = new Analytics(omega);
          second.init({ projectId: 'proj-x' });
          ctx.expect(store.get('_omega_device_id'), 'the stored id is never re-derived').toBe(deviceId);
          ctx.expect(second.clientId).toBe(first.clientId);
        } finally {
          Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
          delete global.localStorage;
        }
      },
    },

    {
      name: 'Analytics on web (#159: gtag delegation) > web events delegate to the page gtag; the Measurement Protocol stays off web',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        const calls = [];
        const fetchCalls = [];
        const realFetch = global.fetch;
        // The page global as a browser has it: `window.gtag` IS the bare `gtag` the
        // guarded transport checks for.
        globalThis.gtag = (...args) => calls.push(args);
        global.fetch = (url) => {
          fetchCalls.push(url);
          return Promise.resolve({ ok: true });
        };

        try {
          const web = new Analytics({
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          });

          // No measurement id, no secret: the gtag config is page-side (web core
          // foot.html emits it), and the api_secret must never reach a page
          web.init({ projectId: 'proj-x' });
          ctx.expect(web.initialized, 'web initializes without an id or a secret').toBe(true);
          ctx.expect(calls.length, 'the page gtag config already fired the page_view, so no second one').toBe(0);

          web.event('vert_click', { vert_id: 'omega-promo', vert_lane: 'promo' });

          ctx.expect(fetchCalls.length, 'web must never post to the Measurement Protocol').toBe(0);
          ctx.expect(calls.length, 'the event reaches the page gtag').toBe(1);
          const [command, name, params] = calls[0];
          ctx.expect(command).toBe('event');
          ctx.expect(name, 'the catalog decides the native name').toBe('vert_click');
          ctx.expect(params.vert_id, 'caller params ride along').toBe('omega-promo');
          ctx.expect(params.page_location, 'page data merges in').toBe(global.window.location.href);

          // A secret handed in anyway is dropped on the floor, never stored
          const withSecret = new Analytics({
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          });
          withSecret.init({ id: 'G-TESTONLY', secret: 'test-secret' });
          ctx.expect(withSecret.secret, 'the api_secret is never read on web').toBe(null);

          // gtag absent (blocked, or consent not granted so the loader never
          // injected it) → silent no-op, never a throw and never a fallback
          delete globalThis.gtag;
          web.event('vert_click');
          ctx.expect(fetchCalls.length, 'a missing gtag never falls back to the fetch path').toBe(0);
        } finally {
          global.fetch = realFetch;
          delete globalThis.gtag;
        }
      },
    },

    {
      name: 'Analytics on web (#159: gtag delegation) > the Omega instance initializes web analytics with no provider config (the vert_click chain)',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();

        const calls = [];
        globalThis.gtag = (...args) => calls.push(args);

        try {
          await omega.initialize(TEST_CONFIG);
          ctx.expect(omega.analytics.initialized, 'web analytics initializes on a brand with no google id').toBe(true);

          omega.analytics.event('vert_click', { vert_lane: 'promo' });
          const events = calls.filter((entry) => entry[0] === 'event' && entry[1] === 'vert_click');
          ctx.expect(events.length, 'vert_click reaches gtag through the instance').toBe(1);
          ctx.expect(events[0][2].vert_lane).toBe('promo');
        } finally {
          delete globalThis.gtag;
        }
      },
    },

    {
      name: 'Analytics in desktop\'s renderer (#411: one sender, reached over IPC) > a bridged renderer forwards every event to main and never sends one itself',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        const fetchCalls = [];
        const realFetch = global.fetch;
        global.fetch = (url) => {
          fetchCalls.push(url);
          return Promise.resolve({ ok: true });
        };

        // The preload's surface: fire-and-forget IPC into the main process, whose
        // sender owns the device id, the session id and the engagement time.
        const forwarded = [];
        const properties = [];
        const bridge = {
          event: (name, params) => forwarded.push({ name, params }),
          setUserProperties: (props) => properties.push(props),
        };

        try {
          // An Electron window sets no config.runtime, so a desktop renderer
          // resolves as the WEB runtime — the bridge, not the runtime name, is
          // what makes this client a forwarder.
          const renderer = new Analytics({
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          });
          renderer.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x', bridge });

          ctx.expect(renderer.initialized, 'a bridged renderer initializes').toBe(true);
          ctx.expect(renderer.secret, 'the Measurement Protocol secret is never held in a renderer').toBe(null);
          ctx.expect(renderer.clientId, 'and no second device id is ever minted here').toBe(null);

          renderer.event('vert_click', { vert_id: 'omega-promo' });
          ctx.expect(forwarded.length, 'the event forwards exactly once').toBe(1);
          ctx.expect(forwarded[0], 'the canonical name and the caller params are all that cross — main owns the page context').toEqual({ name: 'vert_click', params: { vert_id: 'omega-promo' } });
          ctx.expect(fetchCalls.length, 'a bridged renderer never posts to the Measurement Protocol').toBe(0);

          renderer.setUserProperties({ plan: 'premium' });
          ctx.expect(properties, 'user properties ride the same bridge, unwrapped').toEqual([{ plan: 'premium' }]);

          // Main's auth bridge fires login/logout off the same Firebase user, so a
          // bridged renderer firing its own would double-count every sign-in.
          forwarded.length = 0;
          renderer.handleAuthChange({ uid: 'uid-1', providerId: 'google' });
          ctx.expect(forwarded, 'login stays main\'s to fire').toEqual([]);

          // The drop is the BRIDGE's doing, not web's: an electron-runtime client
          // handed credentials keeps neither, so the guard holds wherever a host
          // wires the bridge.
          const electron = new Analytics({
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => false,
          });
          electron.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x', bridge });

          ctx.expect(electron.secret, 'a bridged electron client drops the api_secret too').toBe(null);
          ctx.expect(electron.clientId, 'and mints no device id of its own').toBe(null);

          fetchCalls.length = 0;
          forwarded.length = 0;
          electron.event('vert_click');
          ctx.expect(fetchCalls.length, 'it never reaches the Measurement Protocol').toBe(0);
          ctx.expect(forwarded.length, 'it forwards instead').toBe(1);
        } finally {
          global.fetch = realFetch;
        }
      },
    },

    {
      name: 'Analytics in desktop\'s renderer (#411: one sender, reached over IPC) > a forward never throws at the caller, and an unknown name never leaves the renderer',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        const forwarded = [];
        const bridge = {
          event: (name, params) => forwarded.push({ name, params }),
          setUserProperties: () => {},
        };
        // What an IPC bridge does when handed something structured clone cannot
        // carry (a DOM node, a function): it throws where the caller stands.
        const uncloneable = {
          event: () => { throw new Error('An object could not be cloned.'); },
          setUserProperties: () => { throw new Error('An object could not be cloned.'); },
        };

        // An uncatalogued name is a PROGRAMMER error, and it is the renderer's
        // programmer: it must surface at this call site in development, not as a
        // warn in the main process's log with nothing to blame.
        const dev = new Analytics({
          utilities: { getRuntime: () => 'web' },
          isDevelopment: () => true,
        });
        dev.init({ projectId: 'proj-x', bridge });

        ctx.expect(() => dev.event('signup-completed!'), 'dev throws at the call site').toThrow(/Unknown analytics event/);
        ctx.expect(forwarded.length, 'and nothing crossed to main').toBe(0);

        const prod = new Analytics({
          utilities: { getRuntime: () => 'web' },
          isDevelopment: () => false,
        });
        prod.init({ projectId: 'proj-x', bridge });

        forwarded.length = 0;
        prod.event('signup-completed!');
        ctx.expect(forwarded.length, 'production skips it instead of shipping junk to main').toBe(0);

        const broken = new Analytics({
          utilities: { getRuntime: () => 'web' },
          isDevelopment: () => false,
        });
        broken.init({ projectId: 'proj-x', bridge: uncloneable });

        broken.event('vert_click', { vert_id: 'x' });
        broken.setUserProperties({ plan: 'premium' });
      },
    },

    {
      name: 'Analytics in desktop\'s renderer (#411: one sender, reached over IPC) > identity is main\'s: a renderer-side setUserId raises instead of no-opping (#480)',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        // The preload's surface carries setUserProperties and NO setUserId — main's
        // auth bridge flips user_id off the same Firebase user, so identity is the
        // one thing this bridge does not carry.
        const forwarded = [];
        const bridge = {
          event: (name, params) => forwarded.push({ name, params }),
          setUserProperties: () => {},
        };

        const renderer = new Analytics({
          utilities: { getRuntime: () => 'web' },
          isDevelopment: () => false,
        });
        renderer.init({ projectId: 'proj-x', bridge });

        ctx.expect(() => renderer.setUserId('firebase-uid-1'), 'a renderer that sets an id nothing would ever read must say so').toThrow(/the main process owns identity/);
        ctx.expect(renderer.userId, 'and nothing was stored on the way out').toBe(null);

        // The one path that calls it on every runtime keeps working: identity
        // crosses no bridge, so the auth callback never reaches the throw.
        renderer.handleAuthChange({ uid: 'uid-1', providerId: 'google' });
        ctx.expect(renderer.userId, 'auth leaves the renderer\'s identity untouched').toBe(null);
        ctx.expect(forwarded, 'and fires nothing main already fires').toEqual([]);
      },
    },

    {
      name: 'Analytics in desktop\'s renderer (#411: one sender, reached over IPC) > the seam is the host\'s injected config value alone — a global can never bridge a page',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        const savedConfig = omega.config;

        const calls = [];
        globalThis.gtag = (...args) => calls.push(args);

        try {
          const injected = { event: () => {} };

          omega.config = { analyticsBridge: injected };
          ctx.expect(omega._resolveAnalyticsBridge(), 'the injected surface IS the seam').toBe(injected);

          omega.config = {};
          ctx.expect(omega._resolveAnalyticsBridge(), 'a host that injects nothing gets no bridge').toBe(null);

          // The global is inert BY CONSTRUCTION now: a page carrying a
          // `window.desktop.analytics` (a brand's own script, an extension, a
          // stray global) bridges nothing, so a brand's analytics can never be
          // silently routed into a void.
          global.window.desktop = { analytics: { event: () => { throw new Error('a global must never bridge'); } } };
          ctx.expect(omega._resolveAnalyticsBridge(), 'a planted window.desktop is not a seam').toBe(null);

          // A host that injects a broken surface is a broken host — loud, never a
          // quiet fall back to the sender a desktop renderer must not have.
          omega.config = { analyticsBridge: { pageview: () => {} } };
          ctx.expect(() => omega._resolveAnalyticsBridge(), 'a malformed injection raises').toThrow(/carries no event\(\)/);

          // And web is untouched with that same global still planted: no bridge was
          // injected, so the event goes to the page's gtag exactly as before.
          const Analytics = (await import(SOURCE_PATH)).default;
          const web = new Analytics({
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          });
          web.init({ projectId: 'proj-x' });

          calls.length = 0;
          web.event('vert_click', { vert_lane: 'promo' });
          ctx.expect(calls.length, 'the event still reaches the page gtag').toBe(1);
          ctx.expect(calls[0][1]).toBe('vert_click');
        } finally {
          omega.config = savedConfig;
          delete global.window.desktop;
          delete globalThis.gtag;
        }
      },
    },

    {
      name: 'Analytics rides the shared catalog (#328 stage E) > the catalog decides the name, and an unknown one is never posted',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        const bodies = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          bodies.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true });
        };

        try {
          const prod = new Analytics({
            utilities: { getRuntime: () => 'electron' },
            isDevelopment: () => false,
          });
          prod.init({ id: 'G-TESTONLY', secret: 'test-secret' });
          bodies.length = 0;

          // A canonical name posts under the GA4 mapping's NATIVE name
          prod.event('screen_view', { screen_name: 'settings' });
          const names = bodies.flatMap((b) => (b.events || []).map((e) => e.name));
          ctx.expect(names.includes('screen_view'), `the catalog's GA4 name rides the payload (got: ${names.join(', ')})`).toBeTruthy();

          // A name no catalog entry declares is a programmer error: production logs
          // and skips it rather than shipping junk into the property
          bodies.length = 0;
          prod.event('signup-completed!');
          ctx.expect(bodies.length, 'an uncatalogued name is never posted').toBe(0);
        } finally {
          global.fetch = realFetch;
        }
      },
    },

    {
      name: 'Analytics rides the shared catalog (#328 stage E) > the Measurement Protocol answers false for a provider whose row has none',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;
        const facade = require('@omega.js/analytics');
        const { clientConfig } = require('@omega.js/config');

        global.window = global.window || { location: { pathname: '/t', href: 'http://t/t' } };
        global.document = global.document || { title: 't' };

        const bodies = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          bodies.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true });
        };

        try {
          // The host carries the build's bake as a real one does; the module reads the
          // rows themselves from its own import of @omega.js/config/analytics-providers
          const config = clientConfig({ analytics: { providers: { google: { id: 'G-TESTONLY' } } } });
          const extension = new Analytics({
            config: config,
            utilities: { getRuntime: () => 'browser-extension' },
            isDevelopment: () => false,
          });
          extension.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x' });
          await new Promise((resolve) => setImmediate(resolve));
          bodies.length = 0;

          // sign_up maps every provider, so each descriptor reaches the client's transport
          const { results } = facade.event('sign_up', { method: 'email' });
          const outcomes = Object.fromEntries(results.map((result) => [result.descriptor.provider, result.outcome]));

          ctx.expect(outcomes, 'only the provider whose row has a Measurement Protocol is delivered').toEqual({ google: 'sent', meta: 'blocked (no global)', tiktok: 'blocked (no global)' });
          ctx.expect(bodies.map((body) => body.events[0].name), 'one post, under the GA4 name').toEqual(['sign_up']);
        } finally {
          global.fetch = realFetch;
        }
      },
    },

    {
      name: 'Analytics rides the shared catalog (#328 stage E) > login/logout fire off auth change on the runtimes that own them',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        const bodies = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          bodies.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true });
        };

        const namesOf = () => bodies.flatMap((b) => (b.events || []).map((e) => e.name));

        try {
          const extension = new Analytics({
            utilities: { getRuntime: () => 'browser-extension' },
            isDevelopment: () => false,
          });
          extension.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x' });

          bodies.length = 0;
          extension.handleAuthChange({ uid: 'uid-1', providerId: 'google' });
          ctx.expect(namesOf(), 'signing in fires login').toEqual(['login']);

          bodies.length = 0;
          extension.handleAuthChange({ uid: 'uid-1', providerId: 'google' });
          ctx.expect(namesOf(), 'a repeat callback for the same session fires nothing').toEqual([]);

          // `logout` is in the catalog with NO provider mapping — a logout is not
          // an ad signal, and GA4 reads the session end on its own — so the proof
          // that it FIRED is the facade's dev line, not a delivery.
          const dev = new Analytics({
            utilities: { getRuntime: () => 'browser-extension' },
            isDevelopment: () => true,
          });
          dev.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x' });

          const lines = [];
          const realLog = console.log;
          console.log = (...args) => lines.push(args.join(' '));
          try {
            dev.handleAuthChange({ uid: 'uid-1', providerId: 'google' });
            dev.handleAuthChange(null);
          } finally {
            console.log = realLog;
          }

          ctx.expect(lines.some((line) => line.includes('login → ')), 'the login fire logs its walk').toBeTruthy();
          ctx.expect(lines.some((line) => line.includes('logout → ')), 'signing out fires logout').toBeTruthy();
          ctx.expect(dev.userId, 'and the identity is cleared').toBe(null);

          // Web's auth pages own login (they know the METHOD), so the shared
          // wiring stays out of their way — identity still follows auth.
          const calls = [];
          globalThis.gtag = (...args) => calls.push(args);

          const web = new Analytics({
            utilities: { getRuntime: () => 'web' },
            isDevelopment: () => false,
          });
          web.init({ projectId: 'proj-x' });

          bodies.length = 0;
          calls.length = 0;
          web.handleAuthChange({ uid: 'uid-1', providerId: 'google' });

          ctx.expect(namesOf(), 'web never posts to the Measurement Protocol').toEqual([]);
          ctx.expect(calls.filter(([command, name]) => command === 'event' && name === 'login'), 'and never double-fires the login the auth page already counted').toEqual([]);
          ctx.expect(calls[0], 'the identity is sent (#159)').toEqual(['set', { user_id: web.userId }]);
        } finally {
          global.fetch = realFetch;
          delete globalThis.gtag;
        }
      },
    },

    {
      name: 'Analytics session id in an extension context (#412) > a reopened popup rejoins the live session, and rotates after 30 idle minutes',
      run: async (ctx) => {
        await beforeEachHook();
        const Analytics = (await import(SOURCE_PATH)).default;

        // chrome.storage.local survives a popup close; sessionStorage does not —
        // that difference IS the bug, so the stub keeps one store for the whole test
        const store = {};
        global.chrome = {
          storage: {
            local: {
              get: async (key) => (key in store ? { [key]: store[key] } : {}),
              set: async (entries) => { Object.assign(store, entries); },
            },
          },
        };

        const bodies = [];
        const realFetch = global.fetch;
        global.fetch = (url, options) => {
          bodies.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true });
        };

        // Every open is a fresh top-level context: a new client, an empty
        // sessionStorage, and the launch page_view fired once the cache has loaded
        const openPopup = async () => {
          global.sessionStorage.clear();

          const popup = new Analytics({
            utilities: { getRuntime: () => 'browser-extension' },
            isDevelopment: () => false,
          });
          popup.init({ id: 'G-TESTONLY', secret: 'test-secret', projectId: 'proj-x' });
          await new Promise((resolve) => setImmediate(resolve));

          return popup;
        };

        try {
          const first = await openPopup();
          const firstId = first._getSessionId();
          ctx.expect(store._ga_session_id, 'the session cache lands in chrome.storage, not sessionStorage').toBeTruthy();
          ctx.expect(sessionStorage.getItem('_ga_session_id'), 'an extension never writes the storage a popup close wipes').toBe(null);

          // Reopened seconds later — same session, because GA4 counts one visit
          const second = await openPopup();
          ctx.expect(second._getSessionId(), 'a reopened popup rejoins the session it left').toBe(firstId);

          const launch = bodies.at(-1);
          ctx.expect(launch.events[0].name, 'the reopen fires its launch page_view').toBe('page_view');
          ctx.expect(launch.events[0].params.session_id, 'and it rides the SAME session id').toBe(firstId);

          // 31 minutes idle: GA4's window has closed, so the next open is a new visit.
          // The idle session is as old as its silence: an id made this same
          // millisecond would equal the rotated one and hide the rotation.
          const idleSince = Date.now() - (31 * 60 * 1000);
          store._ga_session_id = { id: `${idleSince}`, lastActive: idleSince };

          const third = await openPopup();
          ctx.expect(third._getSessionId(), 'a session idle past 30 minutes rotates').not.toBe(`${idleSince}`);
        } finally {
          global.fetch = realFetch;
          global.sessionStorage.clear();
          delete global.chrome;
        }
      },
    },
  ],
});
