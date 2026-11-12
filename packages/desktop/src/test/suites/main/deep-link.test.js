// Main-process tests for lib/deep-link.js — pattern matching, dispatch pipeline, built-ins, override semantics.

const { spawn } = require('child_process');
const { app } = require('electron');
const defineCases = require('@omega.js/devkit/test/define-cases');

// A real process standing in for a forwarded launch: alive until `end()`, which
// closes its stdin and resolves once it has exited.
async function forwardedLaunch() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise((resolve) => { child.once('exit', resolve); });
  return { pid: child.pid, alive: () => child.exitCode === null, end: () => { child.stdin.end(); return exited; } };
}

// The second-instance event a duplicate with this pid sends the holder
function forward(pid) {
  app.emit('second-instance', {}, ['/bin/app'], '/x', { argv: ['/bin/app'], cwd: '/x', pid });
}

// Swap app methods for counters for the length of `fn`: the real ones would end the harness.
async function withAppCounts(names, fn) {
  const real = Object.fromEntries(names.map((name) => [name, app[name]]));
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  names.forEach((name) => { app[name] = () => { counts[name] += 1; }; });
  try {
    await fn(counts);
  } finally {
    names.forEach((name) => { app[name] = real[name]; });
  }
}

// The next turn of the event loop, after the second-instance event's own turn
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

module.exports = defineCases({
  type: 'suite',
  layer: 'main',
  description: 'deep-link (main)',
  cleanup: (ctx) => {
    // Drop all consumer handlers we registered. Built-ins stay (they're idempotent).
    ctx.omega.deepLink._handlers = ctx.omega.deepLink._handlers.filter((h) => h.builtin);
  },
  tests: [
    {
      name: 'initialize ran during boot',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._initialized).toBe(true);
      },
    },
    {
      name: 'built-in handlers are registered for auth/token, app/show, app/quit',
      run: (ctx) => {
        const patterns = ctx.omega.deepLink.getHandlers().map((h) => h.pattern);
        ctx.expect(patterns).toContain('auth/token');
        ctx.expect(patterns).toContain('app/show');
        ctx.expect(patterns).toContain('app/quit');
      },
    },
    {
      name: '_parseUrl extracts scheme, route, query for a flat path',
      run: (ctx) => {
        const parsed = ctx.omega.deepLink._parseUrl('myapp://auth/token?token=abc&x=1');
        ctx.expect(parsed.scheme).toBe('myapp');
        ctx.expect(parsed.route).toBe('auth/token');
        ctx.expect(parsed.query).toEqual({ token: 'abc', x: '1' });
      },
    },
    {
      name: '_parseUrl handles nested paths',
      run: (ctx) => {
        const parsed = ctx.omega.deepLink._parseUrl('myapp://user/profile/42');
        ctx.expect(parsed.route).toBe('user/profile/42');
      },
    },
    {
      name: '_parseUrl returns null for malformed urls',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._parseUrl('not a url')).toBeNull();
      },
    },
    {
      name: '_matchPattern: exact match returns empty params',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._matchPattern('auth/token', 'auth/token')).toEqual({});
      },
    },
    {
      name: '_matchPattern: param match returns named params',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._matchPattern('user/profile/42', 'user/profile/:id'))
          .toEqual({ id: '42' });
        ctx.expect(ctx.omega.deepLink._matchPattern('org/foo/repo/bar', 'org/:slug/repo/:repo'))
          .toEqual({ slug: 'foo', repo: 'bar' });
      },
    },
    {
      name: '_matchPattern: mismatched length or static segment returns null',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._matchPattern('auth/token', 'auth/token/extra')).toBeNull();
        ctx.expect(ctx.omega.deepLink._matchPattern('user/x/42', 'user/profile/:id')).toBeNull();
      },
    },
    {
      name: '_matchPattern: wildcard always matches',
      run: (ctx) => {
        ctx.expect(ctx.omega.deepLink._matchPattern('anything/at/all', '*')).toEqual({});
      },
    },
    {
      name: 'on() registers a handler and returns an unsubscribe fn',
      run: (ctx) => {
        const before = ctx.omega.deepLink.getHandlers().length;
        const off = ctx.omega.deepLink.on('test/route', () => {});
        ctx.expect(ctx.omega.deepLink.getHandlers().length).toBe(before + 1);
        off();
        ctx.expect(ctx.omega.deepLink.getHandlers().length).toBe(before);
      },
    },
    {
      name: 'on() validates inputs',
      run: (ctx) => {
        ctx.expect(() => ctx.omega.deepLink.on('', () => {})).toThrow(/non-empty string/);
        ctx.expect(() => ctx.omega.deepLink.on('x', null)).toThrow(/must be a function/);
      },
    },
    {
      name: 'dispatch() fires the matching handler with parsed ctx',
      run: (ctx) => {
        let received;
        const off = ctx.omega.deepLink.on('user/profile/:id', (c) => { received = c; });
        ctx.omega.deepLink.dispatch('myapp://user/profile/42?ref=tray');
        off();

        ctx.expect(received).toBeTruthy();
        ctx.expect(received.url).toBe('myapp://user/profile/42?ref=tray');
        ctx.expect(received.scheme).toBe('myapp');
        ctx.expect(received.route).toBe('user/profile/42');
        ctx.expect(received.pattern).toBe('user/profile/:id');
        ctx.expect(received.params).toEqual({ id: '42' });
        ctx.expect(received.query).toEqual({ ref: 'tray' });
        ctx.expect(received.source).toBe('manual');
      },
    },
    {
      name: 'multiple handlers for the same route fire in order',
      run: (ctx) => {
        const calls = [];
        const off1 = ctx.omega.deepLink.on('foo/bar', () => { calls.push('a'); });
        const off2 = ctx.omega.deepLink.on('foo/bar', () => { calls.push('b'); });
        ctx.omega.deepLink.dispatch('myapp://foo/bar');
        off1(); off2();
        ctx.expect(calls).toEqual(['a', 'b']);
      },
    },
    {
      name: 'consumer handler runs BEFORE built-in for the same route',
      run: (ctx) => {
        const calls = [];
        const off = ctx.omega.deepLink.on('app/show', () => { calls.push('consumer'); });
        // Built-in for app/show calls omega.windows.show — temporarily stub to record the call.
        const origShow = ctx.omega.windows.show;
        ctx.omega.windows.show = () => { calls.push('builtin'); };

        try {
          ctx.omega.deepLink.dispatch('myapp://app/show');
          ctx.expect(calls).toEqual(['consumer', 'builtin']);
        } finally {
          ctx.omega.windows.show = origShow;
          off();
        }
      },
    },
    {
      name: 'ctx.handled = true suppresses subsequent handlers (including built-ins)',
      run: (ctx) => {
        const calls = [];
        const off = ctx.omega.deepLink.on('app/show', (c) => {
          calls.push('consumer');
          c.handled = true;
        });
        const origShow = ctx.omega.windows.show;
        ctx.omega.windows.show = () => { calls.push('builtin'); };

        try {
          ctx.omega.deepLink.dispatch('myapp://app/show');
          ctx.expect(calls).toEqual(['consumer']);
        } finally {
          ctx.omega.windows.show = origShow;
          off();
        }
      },
    },
    {
      name: 'wildcard handler runs only when no concrete handler matched',
      run: (ctx) => {
        const calls = [];
        const offWild     = ctx.omega.deepLink.on('*', () => { calls.push('wild'); });
        const offConcrete = ctx.omega.deepLink.on('foo/bar', () => { calls.push('concrete'); });

        // Concrete match → wildcard does NOT fire.
        ctx.omega.deepLink.dispatch('myapp://foo/bar');

        // No concrete match → wildcard fires.
        ctx.omega.deepLink.dispatch('myapp://nothing/here');

        offWild(); offConcrete();

        ctx.expect(calls).toEqual(['concrete', 'wild']);
      },
    },
    {
      name: 'built-in app/show calls omega.windows.show with query.window',
      run: (ctx) => {
        let shownName = null;
        const orig = ctx.omega.windows.show;
        ctx.omega.windows.show = (name) => { shownName = name; };

        try {
          ctx.omega.deepLink.dispatch('myapp://app/show?window=settings');
          ctx.expect(shownName).toBe('settings');

          shownName = null;
          ctx.omega.deepLink.dispatch('myapp://app/show');
          ctx.expect(shownName).toBe('main');
        } finally {
          ctx.omega.windows.show = orig;
        }
      },
    },
    {
      name: 'built-in auth/token calls auth.handleToken when available',
      run: (ctx) => {
        let receivedToken = null;
        const origHandler = ctx.omega.auth.handleToken;
        ctx.omega.auth.handleToken = (token) => { receivedToken = token; };

        try {
          ctx.omega.deepLink.dispatch('myapp://auth/token?authToken=abc123');
          ctx.expect(receivedToken).toBe('abc123');
        } finally {
          ctx.omega.auth.handleToken = origHandler;
        }
      },
    },
    {
      // MODERN shape only: ?authToken= (what the website's token page sends).
      // Older formats (?token=, ?payload=) are ignored.
      name: 'built-in auth/token reads ONLY ?authToken= (legacy ?token=/?payload= ignored)',
      run: (ctx) => {
        let called = false;
        const origHandler = ctx.omega.auth.handleToken;
        ctx.omega.auth.handleToken = () => { called = true; };

        try {
          ctx.omega.deepLink.dispatch('myapp://auth/token?token=legacy1');
          const payload = encodeURIComponent(JSON.stringify({ token: 'legacy2' }));
          ctx.omega.deepLink.dispatch(`myapp://auth/token?payload=${payload}`);
          ctx.expect(called).toBe(false);
        } finally {
          ctx.omega.auth.handleToken = origHandler;
        }
      },
    },
    {
      name: '_extractUrlFromArgv finds the url in argv',
      run: (ctx) => {
        const argv = ['/path/to/electron', 'main.js', '--flag', 'myapp://auth/token?token=x'];
        ctx.expect(ctx.omega.deepLink._extractUrlFromArgv(argv)).toBe('myapp://auth/token?token=x');
      },
    },
    {
      name: '_extractUrlFromArgv returns null when no scheme matches',
      run: (ctx) => {
        const argv = ['/path/to/electron', 'main.js', '--flag', 'https://example.com'];
        ctx.expect(ctx.omega.deepLink._extractUrlFromArgv(argv)).toBeNull();
      },
    },
    {
      // wave-5 F1: a cold-start auth/token used to dispatch via setImmediate,
      // long before auth booted Firebase, the token was dropped.
      name: 'dispatches before markOmegaReady() are queued and drained on it',
      run: (ctx) => {
        const dl = ctx.omega.deepLink;
        const calls = [];
        const off = dl.on('queued/route', (c) => calls.push(c.query.v));
        const origReady = dl._omegaReady;
        try {
          dl._omegaReady = false;
          dl._handle('myapp://queued/route?v=early', 'cold-start');
          ctx.expect(calls).toEqual([]);            // held, not dispatched
          ctx.expect(dl._bootQueue.length).toBe(1);

          dl.markOmegaReady();
          ctx.expect(calls).toEqual(['early']);     // drained in order
          ctx.expect(dl._bootQueue.length).toBe(0);
          ctx.expect(dl._omegaReady).toBe(true);
        } finally {
          dl._omegaReady = origReady;
          off();
        }
      },
    },
    {
      // Ahead of every second-instance case here; app.quit is stubbed, as the real one would end the harness.
      name: 'omega.quit() outside a second-instance event quits at once',
      run: (ctx) => {
        const { app } = require('electron');
        const realQuit = app.quit;
        const allowQuit = ctx.omega._allowQuit;
        let quits = 0;
        app.quit = () => { quits += 1; };

        try {
          ctx.omega.quit();
          ctx.expect(quits).toBe(1);
        } finally {
          app.quit = realQuit;
          ctx.omega._allowQuit = allowQuit;
        }
      },
    },
    {
      // #921: Electron re-serializes the duplicate's command line before second-instance
      // fires (switches first, values detached at the end), so the duplicate's REAL argv
      // rides along in additionalData. The event list below carries no url on purpose, so
      // the case can only pass by reading the fourth argument.
      name: 'second-instance reads argv/cwd from additionalData when it rides along',
      run: (ctx) => {
        const brandId = ctx.omega.config.brand.id;
        const url = `${brandId}://dup/launch?k=v`;
        let received;
        const off = ctx.omega.deepLink.on('dup/launch', (c) => { received = c; });

        try {
          ctx.omega.protocol._electron.app.emit(
            'second-instance',
            {},
            ['/bin/app', '--title', '--message', '--allow-file-access-from-files', 'B', 'two'],
            '/x',
            { argv: ['/bin/app', '--title', 'B', url], cwd: '/y' },
          );

          ctx.expect(received).toBeTruthy();
          ctx.expect(received.url).toBe(url);
          ctx.expect(received.route).toBe('dup/launch');
          ctx.expect(received.query).toEqual({ k: 'v' });
          ctx.expect(received.source).toBe('warm-start');
          ctx.expect(received.argv).toEqual(['/bin/app', '--title', 'B', url]);
          ctx.expect(received.cwd).toBe('/y');
        } finally {
          off();
        }
      },
    },
    {
      // A duplicate built before #921 passes no object, so the event's own argv still dispatches.
      name: 'second-instance falls back to the event argv when no additionalData rides along',
      run: (ctx) => {
        const brandId = ctx.omega.config.brand.id;
        const url = `${brandId}://dup/fallback?k=v`;
        let received;
        const off = ctx.omega.deepLink.on('dup/fallback', (c) => { received = c; });

        try {
          ctx.omega.protocol._electron.app.emit('second-instance', {}, ['/bin/app', url], '/z');

          ctx.expect(received).toBeTruthy();
          ctx.expect(received.url).toBe(url);
          ctx.expect(received.argv).toEqual(['/bin/app', url]);
          ctx.expect(received.cwd).toBe('/z');
        } finally {
          off();
        }
      },
    },
    {
      // The harness registers its brand listener before the framework module loads.
      name: 'the framework hears second-instance before a brand listener registered ahead of it',
      run: (ctx) => {
        const order = global.__omegaTestSecondInstanceOrder;
        const url = `${ctx.omega.config.brand.id}://dup/order`;
        const off = ctx.omega.deepLink.on('dup/order', () => { order.push('framework'); });

        try {
          order.length = 0;
          ctx.omega.protocol._electron.app.emit('second-instance', {}, ['/bin/app', url], '/x', { argv: ['/bin/app', url], cwd: '/x' });
          ctx.expect(order).toEqual(['framework', 'brand']);
        } finally {
          off();
        }
      },
    },
    {
      // The fake schedule runs each look at once and adds up the time it was asked to wait.
      name: 'a held quit whose forwarded launch never exits quits anyway at the 5 s limit, logging one line',
      run: async (ctx) => {
        const launch = await forwardedLaunch();
        const realWarn = console.warn;
        const warnings = [];
        console.warn = (...args) => { warnings.push(args.join(' ')); };
        try {
          forward(launch.pid);
          let waited = 0;
          let quitAt = null;
          const looks = [];
          ctx.omega.protocol.afterForwardedExit(() => { quitAt = waited; }, {
            schedule: (look, ms) => { looks.push({ look, ms }); },
          });
          while (quitAt === null && looks.length > 0) {
            const { look, ms } = looks.shift();
            waited += ms;
            look();
          }

          ctx.expect(quitAt !== null && quitAt >= 5000).toBe(true);
          ctx.expect(launch.alive()).toBe(true);
          ctx.expect(warnings.filter((line) => line.includes('[@omega.js/desktop:protocol]')).length).toBe(1);
        } finally {
          console.warn = realWarn;
          await launch.end();
        }
      },
    },
    {
      name: 'a quit asked while the forwarded launch is alive is held, and runs once it has exited',
      run: async (ctx) => {
        const launch = await forwardedLaunch();
        await withAppCounts(['quit'], async (counts) => {
          forward(launch.pid);
          await nextTurn();
          ctx.omega.quit();
          await nextTurn();
          ctx.expect(counts.quit).toBe(0);

          await launch.end();
          // Well under the 5 s limit, so only the launch's exit can release it.
          await ctx.waitFor(() => counts.quit === 1, 2000);
        });
      },
    },
    {
      name: 'omega.relaunch() asked while the forwarded launch is alive is held the same way',
      run: async (ctx) => {
        const launch = await forwardedLaunch();
        await withAppCounts(['quit', 'relaunch'], async (counts) => {
          forward(launch.pid);
          await nextTurn();
          ctx.omega.relaunch();
          await nextTurn();
          ctx.expect(counts).toEqual({ quit: 0, relaunch: 0 });

          await launch.end();
          await ctx.waitFor(() => counts.quit === 1, 2000);
          ctx.expect(counts.relaunch).toBe(1);
        });
      },
    },
    {
      name: 'handler errors do not stop subsequent handlers',
      run: (ctx) => {
        const calls = [];
        const off1 = ctx.omega.deepLink.on('error/route', () => { throw new Error('boom'); });
        const off2 = ctx.omega.deepLink.on('error/route', () => { calls.push('after-error'); });

        // Should not throw to the caller.
        ctx.omega.deepLink.dispatch('myapp://error/route');
        off1(); off2();

        ctx.expect(calls).toEqual(['after-error']);
      },
    },
  ],
});
