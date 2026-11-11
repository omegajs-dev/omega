const defineCases = require('@omega.js/devkit/test/define-cases');
const { getOmega, TEST_CONFIG, createOmega, clearStorage, disposeOmega } = require('./helpers.js');

const beforeEachHook = clearStorage;

module.exports = defineCases({
  type: 'group',
  description: 'omega',
  setup: createOmega,
  cleanup: disposeOmega,
  tests: [
    {
      name: 'Omega methods > should detect development environment',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({ ...TEST_CONFIG, environment: 'development' });
        ctx.expect(omega.isDevelopment()).toBe(true);
      },
    },

    {
      name: 'Omega methods > should detect production environment',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({ ...TEST_CONFIG, environment: 'production' });
        ctx.expect(omega.isDevelopment()).toBe(false);
      },
    },

    {
      name: 'Omega methods > #817: the full environment surface, derived from the ONE baked input',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();

        // The same four calls every other OMEGA target answers, from the same
        // module. The three checks DERIVE from getEnvironment(), so exactly one is
        // true in each lane and isProduction() is a real positive check.
        for (const name of ['development', 'testing', 'production']) {
          await omega.initialize({ ...TEST_CONFIG, environment: name });
          ctx.expect(omega.getEnvironment()).toBe(name);
          ctx.expect(omega.isDevelopment(), `isDevelopment in ${name}`).toBe(name === 'development');
          ctx.expect(omega.isTesting(), `isTesting in ${name}`).toBe(name === 'testing');
          ctx.expect(omega.isProduction(), `isProduction in ${name}`).toBe(name === 'production');
          const trueCount = [omega.isDevelopment(), omega.isTesting(), omega.isProduction()].filter(Boolean).length;
          ctx.expect(trueCount, `exactly one is*() true in ${name}`).toBe(1);
        }
      },
    },

    {
      name: 'Omega methods > should validate redirect URLs for current host',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize(TEST_CONFIG);
        ctx.expect(omega.isValidRedirectUrl('http://localhost:3000/page')).toBe(true);
      },
    },

    {
      name: 'Omega methods > should validate path-relative redirect URLs against the page origin (#160)',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize(TEST_CONFIG);
        ctx.expect(omega.isValidRedirectUrl('/pricing')).toBe(true);
        ctx.expect(omega.isValidRedirectUrl('/dashboard/account?tab=billing')).toBe(true);
        // Absolute same-host keeps working, cross-host stays rejected in both forms
        ctx.expect(omega.isValidRedirectUrl('http://localhost:3000/pricing')).toBe(true);
        ctx.expect(omega.isValidRedirectUrl('https://evil.com/pricing')).toBe(false);
        ctx.expect(omega.isValidRedirectUrl('//evil.com/pricing')).toBe(false);
        ctx.expect(omega.isValidRedirectUrl('not-a-url')).toBe(false);
      },
    },

    {
      name: 'Omega methods > should reject redirect URLs for unknown hosts',
      run: async (ctx) => {
        await beforeEachHook();
        ctx.expect(getOmega().isValidRedirectUrl('http://evil.com')).toBe(false);
      },
    },

    {
      name: 'Omega methods > should allow redirect URLs for configured hosts',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          validRedirectHosts: ['trusted.com'],
        });
        ctx.expect(omega.isValidRedirectUrl('http://trusted.com/callback')).toBe(true);
      },
    },

    {
      name: 'Omega methods > should reject malformed redirect URLs',
      run: async (ctx) => {
        await beforeEachHook();
        ctx.expect(getOmega().isValidRedirectUrl('not-a-url')).toBe(false);
      },
    },

    {
      name: 'Omega methods > should allow loopback redirect URLs on any port when site runs in development',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({ ...TEST_CONFIG, environment: 'development' });
        ctx.expect(omega.isValidRedirectUrl('http://127.0.0.1:49152/auth/token?state=abc')).toBe(true);
        ctx.expect(omega.isValidRedirectUrl('http://localhost:49152/auth/token')).toBe(true);
        ctx.expect(omega.isValidRedirectUrl('http://[::1]:49152/auth/token')).toBe(true);
      },
    },

    {
      name: 'Omega methods > should reject loopback redirect URLs on foreign ports in production',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({ ...TEST_CONFIG, environment: 'production' });
        ctx.expect(omega.isValidRedirectUrl('http://127.0.0.1:49152/auth/token')).toBe(false);
        // Same-host loopback still passes via the host check, not the dev branch
        ctx.expect(omega.isValidRedirectUrl('http://localhost:3000/page')).toBe(true);
      },
    },

    {
      name: 'Omega methods > should return Functions URL for production',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
        });
        ctx.expect(omega.getFunctionsUrl()).toBe('https://us-central1-my-project.cloudfunctions.net');
      },
    },

    {
      name: 'Omega methods > should return Functions URL for development',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          environment: 'development',
          firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
          // The resolved map is the only source of a dev port (#834): a real dev
          // build always bakes one, so a test that wants a number states one.
          dev: { ports: { functions: 5001 } },
        });
        ctx.expect(omega.getFunctionsUrl()).toBe('http://127.0.0.1:5001/my-project/us-central1');
      },
    },

    {
      name: 'Omega methods > should allow overriding environment in getFunctionsUrl',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
          dev: { ports: { functions: 5001 } },
        });
        ctx.expect(omega.getFunctionsUrl('development')).toBe('http://127.0.0.1:5001/my-project/us-central1');
      },
    },

    {
      name: 'Omega methods > #925: a testing run talks to the local stack only when it was handed a dev port map',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        const firebase = { app: { enabled: false, config: { projectId: 'my-project' } } };

        // A testing page with no map has no local stack to reach: live, as before.
        await omega.initialize({ ...TEST_CONFIG, firebase });
        ctx.expect(omega._localStack()).toBe(false);
        ctx.expect(omega.getFunctionsUrl()).toBe('https://us-central1-my-project.cloudfunctions.net');

        // The desktop boot lane and the extension's emulator run bake one: local.
        await omega.initialize({ ...TEST_CONFIG, firebase, dev: { ports: { functions: 5001 } } });
        ctx.expect(omega._localStack()).toBe(true);
        ctx.expect(omega.getFunctionsUrl()).toBe('http://127.0.0.1:5001/my-project/us-central1');

        // Development is local with or without the question; production never is.
        await omega.initialize({ ...TEST_CONFIG, firebase, environment: 'development' });
        ctx.expect(omega._localStack()).toBe(true);
        await omega.initialize({ ...TEST_CONFIG, firebase, environment: 'production', dev: { ports: { functions: 5001 } } });
        ctx.expect(omega._localStack()).toBe(false);
        ctx.expect(omega.getFunctionsUrl()).toBe('https://us-central1-my-project.cloudfunctions.net');
      },
    },

    {
      name: 'Omega methods > should throw when getFunctionsUrl called without projectId',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize(TEST_CONFIG);
        ctx.expect(() => omega.getFunctionsUrl()).toThrow(/project ID/i);
      },
    },

    {
      name: 'Omega methods > should return API URL for development',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          environment: 'development',
          dev: { ports: { https: 5002 } },
        });
        ctx.expect(omega.getApiUrl()).toBe('https://localhost:5002');
      },
    },

    {
      name: 'Omega methods > should derive the production API URL from brand.url, never authDomain (wave-5 F9)',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          brand: { ...TEST_CONFIG.brand, url: 'https://playground.omegajs.dev' },
          // authDomain is an auth-only concern (the brand host, with /__/auth/*
          // self-hosted at build time) — the API base never derives from it.
          firebase: { app: { enabled: false, config: { authDomain: 'example.firebaseapp.com' } } },
        });
        ctx.expect(omega.getApiUrl()).toBe('https://api.playground.omegajs.dev');
      },
    },

    {
      name: 'Omega methods > a brand on a default Pages host reaches its API at the project\'s Cloud Functions address',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          brand: { ...TEST_CONFIG.brand, url: 'https://ian.github.io/site' },
          firebase: { app: { enabled: false, config: { projectId: 'omegajs-playground' } } },
        });
        ctx.expect(omega.getApiUrl()).toBe('https://us-central1-omegajs-playground.cloudfunctions.net/omega_api');
      },
    },

    {
      name: 'Omega methods > a brand on a default Pages host with no project id has no API address and says which key is missing',
      run: async (ctx) => {
        await beforeEachHook();
        const omega = getOmega();
        await omega.initialize({
          ...TEST_CONFIG,
          brand: { ...TEST_CONFIG.brand, url: 'https://ian.github.io/site' },
        });
        ctx.expect(() => omega.getApiUrl()).toThrow(/cloud\.config\.projectId/);
      },
    },

    ...(() => {
      const cases = [];
      // Every module is a plain PROPERTY of the instance. A leftover zero-arg
      // accessor (`auth()`) would be a function here, so it fails loudly.
      const MODULES = [
        'storage', 'utilities', 'analytics', 'auth', 'bindings', 'firestore',
        'notifications', 'serviceWorker', 'sentry', 'device', 'verts', 'dom',
        'triggers', 'icons', 'motion',
      ];

      let beforeHookRun;
      const beforeHook = (ctx) => (beforeHookRun ||= Promise.resolve().then(() => (async () => {
        await getOmega().initialize(TEST_CONFIG);
      })()));

      for (const name of MODULES) {
        cases.push({
          name: `Module properties > exposes ${name} as an object property, never a method`,
          run: async (ctx) => {
            await beforeHook(ctx);
            await beforeEachHook();
            const value = getOmega()[name];
            ctx.expect(typeof value, `omega.${name} is an object`).toBe('object');
            ctx.expect(value, `omega.${name} is built`).not.toBe(null);
          },
        });
      }

      cases.push({
        name: 'Module properties > keeps request() a method: it takes arguments',
        run: async (ctx) => {
          await beforeHook(ctx);
          await beforeEachHook();
          ctx.expect(typeof getOmega().request).toBe('function');
        },
      });
      return cases;
    })(),

    {
      name: 'The package export > exports the Omega class and no instance',
      run: async (ctx) => {
        await beforeEachHook();
        const mod = await import('../src/index.js');

        ctx.expect(typeof mod.default, 'the default export is the class').toBe('function');
        ctx.expect(typeof mod.default.prototype.initialize, 'whose prototype carries initialize').toBe('function');
        ctx.expect(mod.default, 'the named export is the same class').toBe(mod.Omega);
        ctx.expect(Object.keys(mod).sort(), 'nothing else rides the entry, no instance').toEqual(['Omega', 'default']);
      },
    },

    {
      name: 'omega.ready > is a promise that resolves to the instance once initialize() settles',
      run: async (ctx) => {
        await beforeEachHook();
        const { Omega } = await import('../src/index.js');
        const omega = new Omega();

        try {
          ctx.expect(omega.ready instanceof Promise, 'ready exists before initialize() runs').toBeTruthy();

          const returned = await omega.initialize(TEST_CONFIG);
          ctx.expect(returned, 'initialize() returns the instance').toBe(omega);
          ctx.expect(await omega.ready, 'ready resolves to the same instance').toBe(omega);
        } finally {
          clearInterval(omega._versionCheckInterval);
        }
      },
    },

    {
      name: 'omega.ready > rejects with the error initialize() rethrows',
      run: async (ctx) => {
        await beforeEachHook();
        const { Omega } = await import('../src/index.js');
        const omega = new Omega();
        const realError = console.error;
        console.error = () => {};

        try {
          // A bridge with no event() is a broken host: initialize() raises
          await ctx.expect((() => omega.initialize({ ...TEST_CONFIG, analyticsBridge: {} }))()).rejects.toThrow(/carries no event\(\)/);
          await ctx.expect(omega.ready, 'a consumer awaiting ready sees the same error').rejects.toThrow(/carries no event\(\)/);
        } finally {
          console.error = realError;
          clearInterval(omega._versionCheckInterval);
        }
      },
    },

    ...(() => {
      const cases = [];
      const afterEachHook = () => {
        delete global.window.__OMEGA_DEV_PORTS__;
      };

      cases.push({
        name: 'Dev ports (N7) > should read dev.ports from the baked chrome for functions + api URLs',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
            dev: { ports: { functions: 5003, hosting: 5004 } },
          });
          ctx.expect(omega.getFunctionsUrl()).toBe('http://127.0.0.1:5003/my-project/us-central1');
          ctx.expect(omega.getApiUrl()).toBe('http://127.0.0.1:5004');
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should let the BAKED CHROME win over the runtime channel, which only fills what the chrome omits (#300)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
            dev: { ports: { functions: 5003, hosting: 5004 } },
          });
          // The chrome is written per render by the dev server that served this page
          // — a driver's injected map is a fallback for pages that carry none, and
          // must never be able to mask a wrong (or right) baked map
          global.window.__OMEGA_DEV_PORTS__ = { functions: 5103, hosting: 5104, auth: 9199 };
          ctx.expect(omega.getFunctionsUrl()).toBe('http://127.0.0.1:5003/my-project/us-central1');
          ctx.expect(omega.getApiUrl()).toBe('http://127.0.0.1:5004');
          ctx.expect(omega._devPort('auth'), 'a key the chrome omits still comes from the runtime channel').toBe(9199);
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should throw, naming the build step, for a dev port nobody resolved (#834)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();

          // Only this server's own port resolved: every emulator number used to be
          // an assumed classic with a warning beside it. The classics are gone: a
          // number nobody resolved is a guess about somebody else's stack, so the
          // read fails at the call that needed it and names where the map comes from.
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            dev: { ports: { website: 4001 } },
          });

          for (const name of ['auth', 'firestore', 'functions', 'hosting']) {
            ctx.expect(() => omega._devPort(name), `${name} throws rather than assuming a classic`).toThrow((error) => {
              ctx.expect(error.message, 'names the port it wanted').toMatch(new RegExp(`dev port for \`${name}\``));
              ctx.expect(error.message, 'names the channel').toMatch(/OMEGA_BUILD_JSON\.config\.dev/);
              ctx.expect(error.message, 'names the build step that writes it').toMatch(/bundle tasks at build time/);
              return true;
            });
          }

          // A resolved map answers every one of them, with no warning and no guess.
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            dev: { ports: { auth: 9100, firestore: 8081, functions: 5002, hosting: 5003 } },
          });
          ctx.expect(omega._devPort('auth')).toBe(9100);
          ctx.expect(omega._devPort('firestore')).toBe(8081);
          ctx.expect(omega._devPort('functions')).toBe(5002);
          ctx.expect(omega._devPort('hosting')).toBe(5003);
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should answer the dev website origin from the resolved map, and say so when it has to assume (#262)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          const realWarn = console.warn;
          let warnings = [];
          console.warn = (...args) => warnings.push(args.join(' '));
          const originLines = () => warnings.filter((line) => line.includes('No resolved dev website origin'));

          try {
            // The stack published its origin — protocol and port both, and a bumped
            // https run is exactly the case a port-only map could never express
            await omega.initialize({
              ...TEST_CONFIG,
              environment: 'development',
              dev: { ports: { website: 4001 }, origin: 'https://localhost:4001' },
            });
            ctx.expect(omega.getDevWebsiteOrigin()).toBe('https://localhost:4001');
            ctx.expect(originLines().length, 'a resolved fact says nothing').toBe(0);

            // Nothing published one: the classic https://localhost:4000 assumption is
            // gone (#834). A wrong dev origin fails as a silent connection refusal,
            // so the miss is loud at the read instead.
            warnings = [];
            await omega.initialize({ ...TEST_CONFIG, environment: 'development' });
            ctx.expect(() => omega.getDevWebsiteOrigin()).toThrow((error) => {
              ctx.expect(error.message).toMatch(/dev website origin/);
              ctx.expect(error.message, 'names the channel').toMatch(/OMEGA_BUILD_JSON\.config\.dev/);
              ctx.expect(error.message, 'names the build step that writes it').toMatch(/`omega dev` \(into the page chrome, per response\)/);
              return true;
            });
            ctx.expect(originLines().length, 'nothing is assumed, so nothing is warned about').toBe(0);
          } finally {
            console.warn = realWarn;
          }
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should prefer an https (mkcert proxy) entry over plain-http hosting',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            dev: { ports: { https: 5443, hosting: 5004 } },
          });
          ctx.expect(omega.getApiUrl()).toBe('https://localhost:5443');
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should point the auth emulator at the SITE origin when the dev server proxies it (#156)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            dev: { ports: { auth: 9099 }, authEmulatorProxy: true },
          });
          // Same-origin is the whole point: the OAuth handler's sessionStorage and
          // the SDK's helper iframe land in the page's own storage partition
          ctx.expect(omega._authEmulatorUrl()).toBe('http://localhost:3000');
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should point the auth emulator at its own port when no proxy is declared',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            dev: { ports: { auth: 9199 } },
          });
          ctx.expect(omega._authEmulatorUrl()).toBe('http://127.0.0.1:9199');
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should throw, naming the build step, when no dev map was baked at all (#834)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'development',
            firebase: { app: { enabled: false, config: { projectId: 'my-project' } } },
          });

          // The two URL getters that used to answer with a classic number.
          ctx.expect(() => omega.getApiUrl()).toThrow(/dev port for `hosting`/);
          ctx.expect(() => omega.getApiUrl()).toThrow(/OMEGA_BUILD_JSON\.config\.dev/);
          ctx.expect(() => omega.getFunctionsUrl()).toThrow(/dev port for `functions`/);

          // Production is untouched: it has no local stack to resolve and never did.
          ctx.expect(omega.getApiUrl('production')).toMatch(/^https:\/\/api\./);
        },
      });

      cases.push({
        name: 'Dev ports (N7) > should version-check /build.json only — the retired npm-build shape carries no timestamp (#148)',
        run: async (ctx) => {
          await beforeEachHook();
          ctx.after(afterEachHook);
          const omega = getOmega();
          await omega.initialize({
            ...TEST_CONFIG,
            environment: 'production',
            buildTime: '2020-01-01T00:00:00.000Z',
          });

          const urls = [];
          const originalFetch = global.fetch;
          const originalReload = global.window.location.reload;
          let reloads = 0;
          global.window.location.reload = () => { reloads++; };

          try {
            // The retired shape: fetched, parsed, and rejected — no /@output/ probe
            global.fetch = async (url) => {
              urls.push(url);
              return { ok: true, json: async () => ({ 'npm-build': { timestamp: new Date(Date.now() + 86400000).toISOString() } }) };
            };
            await omega._checkVersion();
            ctx.expect(urls.length, 'exactly one path is probed').toBe(1);
            ctx.expect(urls[0].startsWith('/build.json?cb='), '/build.json is the one path').toBeTruthy();
            ctx.expect(reloads, 'the retired key never reloads the page').toBe(0);

            // The current shape: a newer timestamp reloads
            global.fetch = async () => ({ ok: true, json: async () => ({ timestamp: new Date(Date.now() + 86400000).toISOString() }) });
            await omega._checkVersion();
            ctx.expect(reloads, 'a newer build.json timestamp reloads').toBe(1);
          } finally {
            global.fetch = originalFetch;
            global.window.location.reload = originalReload;
          }
        },
      });
      return cases;
    })(),
  ],
});
