/**
 * The provider gate (`core/js/core/analytics-loader.js`, #383).
 *
 * The bug this replaces was structural: `core/foot.html` emitted the GA4, Meta
 * and TikTok snippets whenever an id was configured, so every visitor was
 * counted before the banner rendered, and the banner's Accept changed nothing.
 * Two things are pinned here — the chrome no longer ships a loader at all, and
 * the runtime injects one only for a category the visitor's consent allows.
 *
 * Google Consent Mode is the other half: the `consent default` command has to be
 * in dataLayer BEFORE gtag.js could ever read it, and a later change has to push
 * an `update` even when nothing loads (a denial still has to be told).
 *
 * The PAGE VIEW is the third thing pinned here (#409): the loader's raw
 * `fbq('track', 'PageView')` and `ttq.page()` retired, so what each pixel is
 * told now comes from the catalog through the facade, once per page load, with
 * GA4 left to its own `config` command.
 *
 * Browser code behind two bundler aliases, so the harness drives the REAL files
 * through esbuild — ONE entry exposing the loader and the consent state, so a
 * grant in the test reaches the same module instance the loader subscribed to
 * (the shared-chunk guarantee a real split build gives) — and the REAL facade
 * behind it, because the catalog is what decides who hears a page view.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { get: _get, set: _set } = require('lodash');
const { ANALYTICS_PROVIDERS, clientConfig } = require('@omega.js/config');

const PKG = path.join(__dirname, '..');
const ROOT = path.resolve(PKG, '..', '..');
const CORE_DIR = path.join(PKG, 'core');
const CORE_JS = path.join(CORE_DIR, 'js');

// The client's built module — the door web core reaches the analytics package
// (catalog, adapters, guarded transport) through. The REAL one, as
// analytics-blocked.test.js drives it: the catalog is what decides which
// provider hears a page view, so stubbing it would prove nothing.
const CLIENT_ANALYTICS = path.join(ROOT, 'packages', 'client', 'dist', 'modules', 'analytics.js');

// Everything the loader writes onto the page, cleared between boots.
const PAGE_GLOBALS = ['dataLayer', 'gtag', 'fbq', '_fbq', 'ttq', 'TiktokAnalyticsObject'];

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-consent-gating-'));
const BUNDLE = path.join(BUNDLE_DIR, 'analytics-loader.cjs');

const IDS = { google: 'G-TEST123', meta: '1234567890', tiktok: 'TTTEST' };

let building = null;

function bundleOnce() {
  building ||= esbuild.build({
    stdin: {
      contents: [
        `export { default } from './core/analytics-loader.js';`,
        `export { setTrackingConsent, getTrackingConsent } from './libs/tracking-consent.js';`,
      ].join('\n'),
      resolveDir: CORE_JS,
      loader: 'js',
    },
    outfile: BUNDLE,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    plugins: [{
      name: 'harness-aliases',
      setup(build) {
        build.onResolve({ filter: /^__main_assets__\// }, (args) => {
          return { path: path.join(CORE_DIR, args.path.slice('__main_assets__/'.length)) };
        });
        build.onResolve({ filter: /^@omega\.js\/client\/modules\/analytics\.js$/ }, () => {
          return { path: CLIENT_ANALYTICS };
        });
        build.onResolve({ filter: /^@omega\.js\/web\/runtime$/ }, () => {
          return { path: 'client', namespace: 'omega-client-stub' };
        });
        build.onLoad({ filter: /.*/, namespace: 'omega-client-stub' }, () => {
          return { contents: 'export default globalThis.__omegaClient;' };
        });
      },
    }],
  });

  return building;
}

/**
 * Boot the real loader in one region with one set of configured ids, and hand
 * back the seams: what was injected, and what was queued for gtag.
 */
async function boot({ timeZone, ids = IDS, storage = {} } = {}) {
  await bundleOnce();

  process.env.TZ = timeZone || 'America/New_York';

  const injected = [];

  // A page's `window` IS its global object, and the guarded transport checks the
  // BARE names (`typeof fbq`) an ad blocker leaves undefined (#306) — so the
  // harness has to be one object too, or a pixel this loader just installed
  // would read as blocked and the facade's page view would deliver nowhere.
  for (const name of PAGE_GLOBALS) {
    delete globalThis[name];
  }

  globalThis.window = globalThis;
  // The page's own analytics host reads the platform cookies at fire time.
  globalThis.document = { cookie: '' };
  globalThis.__omegaClient = {
    // The build's own bake, so the provider rows ride it as analytics.capabilities
    config: clientConfig({
      analytics: {
        providers: {
          google: ids.google ? { id: ids.google } : {},
          meta: ids.meta ? { id: ids.meta } : {},
          tiktok: ids.tiktok ? { id: ids.tiktok } : {},
        },
      },
    }),
    dom: {
      loadScript: (options) => {
        injected.push(options.src);
        return Promise.resolve({});
      },
    },
    storage: {
      get: (keyPath, defaultValue) => _get(storage, keyPath, defaultValue),
      set: (keyPath, value) => _set(storage, keyPath, value),
      remove: (keyPath) => _set(storage, keyPath, undefined),
    },
  };

  delete require.cache[require.resolve(BUNDLE)];
  const bundle = require(BUNDLE);

  bundle.default({ omega: globalThis.__omegaClient });

  return {
    injected,
    storage,
    setTrackingConsent: bundle.setTrackingConsent,
    // dataLayer holds `arguments` objects, exactly as the real snippet pushes.
    dataLayer: () => (globalThis.window.dataLayer || []).map((entry) => Array.from(entry)),
    consentCommands: () => (globalThis.window.dataLayer || [])
      .map((entry) => Array.from(entry))
      .filter(([command]) => command === 'consent'),
    // What each pixel was actually told, in the order it was told: the Meta
    // queue holds `arguments` objects, the TikTok queue plain arrays.
    metaCalls: () => (globalThis.fbq ? globalThis.fbq.queue : []).map((entry) => Array.from(entry)),
    tiktokCalls: () => (globalThis.ttq || []).map((entry) => Array.from(entry)),
    // Which provider each injected src belongs to.
    loaded: () => injected.map((src) => {
      if (src.includes('googletagmanager')) return 'google';
      if (src.includes('connect.facebook.net')) return 'meta';
      if (src.includes('analytics.tiktok.com')) return 'tiktok';
      return src;
    }),
  };
}

const ORIGINAL_TZ = process.env.TZ;

const DENIED = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' };
const GRANTED = { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' };

module.exports = defineCases({
  type: 'group',
  description: 'consent-gating',
  cleanup: () => {
    process.env.TZ = ORIGINAL_TZ;
    delete globalThis.window;
    delete globalThis.document;

    for (const name of PAGE_GLOBALS) {
      delete globalThis[name];
    }
  },
  tests: [
    {
      name: 'opt-in region: nothing loads, and Consent Mode is denied by default',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        ctx.expect(gate.loaded(), 'no provider script is injected before a grant').toEqual([]);
        ctx.expect(gate.consentCommands(), 'the default is queued, denied').toEqual([['consent', 'default', DENIED]]);

        // Queued BEFORE anything else gtag-related, which is the whole point: gtag.js
        // reads the head of dataLayer when it loads.
        ctx.expect(gate.dataLayer()[0][1], 'the consent default is the first thing in dataLayer').toBe('default');
      },
    },

    {
      name: 'opt-in region: Accept injects the loaders and updates Consent Mode',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        gate.setTrackingConsent({ analytics: true, marketing: true });

        ctx.expect(gate.loaded().sort(), 'all three load, with no reload').toEqual(['google', 'meta', 'tiktok']);
        ctx.expect(gate.consentCommands(), 'and the tag is told the flags flipped').toEqual([['consent', 'default', DENIED], ['consent', 'update', GRANTED]]);

        ctx.expect(gate.injected.some((src) => src.includes(`id=${IDS.google}`)), 'gtag.js carries the configured id').toBeTruthy();
        ctx.expect(gate.injected.some((src) => src.includes(`sdkid=${IDS.tiktok}`)), 'the TikTok pixel carries its sdkid').toBeTruthy();
        ctx.expect(gate.dataLayer().some((entry) => entry[0] === 'config' && entry[1] === IDS.google), 'GA4 is configured').toBeTruthy();
        ctx.expect(gate.metaCalls()[0], 'the Meta pixel is initialized').toEqual(['init', IDS.meta]);
      },
    },

    // ─── The page view (#409) ───

    {
      name: 'the page view is the facade\'s fire, and the raw pixel calls are gone',
      run: async (ctx) => {
        // The bypass this replaces: the loader fired `fbq('track', 'PageView')` and
        // `ttq.page()` itself, which were the ONLY page-view signal Meta and TikTok
        // got and the only two events on the page that walked past the catalog, the
        // per-event consent gate and the dedupe ids
        // ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)).
        const gate = await boot({ timeZone: 'America/New_York' });

        ctx.expect(gate.metaCalls(), 'Meta hears its standard PageView through the transport, once, after the init').toEqual([['init', IDS.meta], ['track', 'PageView', {}]]);

        ctx.expect(gate.tiktokCalls(), 'TikTok keeps its own documented method — the catalog names it and the TRANSPORT calls it').toEqual([['page']]);

        ctx.expect(gate.dataLayer().filter(([command]) => command === 'event'), 'GA4 counts the page view off its own `config` command, so nothing fires it a second time').toEqual([]);
      },
    },

    {
      name: 'a page view is counted once per pixel, however often consent is re-saved',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        gate.setTrackingConsent({ analytics: true, marketing: true });
        gate.setTrackingConsent({ analytics: true, marketing: true });

        ctx.expect(gate.metaCalls().filter(([command]) => command === 'track')).toEqual([['track', 'PageView', {}]]);
        ctx.expect(gate.tiktokCalls()).toEqual([['page']]);
      },
    },

    {
      name: 'the loader itself counts nothing — the raw calls cannot grow back',
      run: (ctx) => {
        // TikTok's half looks the same ON THE WIRE as the retired `ttq.page()`, which
        // is the point of the mapping — so the retirement gets its own pin. What may
        // not come back is this file firing a pixel itself: the fire belongs to the
        // facade, behind the catalog and the per-event consent gate.
        const loader = fs.readFileSync(path.join(CORE_JS, 'core', 'analytics-loader.js'), 'utf8');
        // Comment lines dropped: the retired calls are NAMED in that file's prose,
        // which is documentation of what moved, not a call.
        const code = loader.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

        ctx.expect(!/ttq\.page\(/.test(code), 'no raw ttq.page() at pixel init').toBeTruthy();
        ctx.expect(!/fbq\('track'/.test(code), 'no raw fbq track at pixel init').toBeTruthy();
        ctx.expect(code.includes('countPageView('), 'the page view goes through the facade').toBeTruthy();
      },
    },

    {
      name: 'a denied marketing category counts no page view at all',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        gate.setTrackingConsent({ analytics: true, marketing: false });

        ctx.expect(gate.loaded(), 'no marketing pixel exists to count one').toEqual(['google']);
        ctx.expect(gate.metaCalls(), 'and nothing is queued for one that never installed').toEqual([]);
        ctx.expect(gate.tiktokCalls()).toEqual([]);
      },
    },

    {
      name: 'a category is gated on its OWN provider — analytics alone loads GA4 alone',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        gate.setTrackingConsent({ analytics: true, marketing: false });

        ctx.expect(gate.loaded(), 'the marketing pair stays unloaded').toEqual(['google']);
        ctx.expect(gate.consentCommands().at(-1), 'the ad_* flags stay denied; only analytics_storage flips').toEqual(['consent', 'update', { ...DENIED, analytics_storage: 'granted' }]);
      },
    },

    {
      name: 'each provider loads on its own row\'s consent category, and no other',
      run: async (ctx) => {
        const rows = Object.values(ANALYTICS_PROVIDERS);

        for (const row of rows) {
          const gate = await boot({ timeZone: 'Europe/Berlin' });

          gate.setTrackingConsent({ analytics: false, marketing: false, [row.consentCategory]: true });

          const sameCategory = rows.filter((other) => other.consentCategory === row.consentCategory).map((other) => other.id).sort();
          ctx.expect(gate.loaded().sort(), `granting ${row.consentCategory} alone loads ${row.id} and only the providers that share its category`).toEqual(sameCategory);
        }
      },
    },

    {
      name: 'opt-out region: everything loads at boot and Consent Mode is granted',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'America/New_York' });

        ctx.expect(gate.loaded().sort(), 'no wait — the banner is informational here').toEqual(['google', 'meta', 'tiktok']);
        ctx.expect(gate.consentCommands()).toEqual([['consent', 'default', GRANTED]]);
      },
    },

    {
      name: 'opt-out region: a Customize opt-out updates Consent Mode, and never loads more',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'America/New_York' });

        gate.setTrackingConsent({ analytics: false, marketing: false });

        // Revoking cannot unload a running script — there is no such thing — so the
        // promise is the tag being TOLD, and nothing new arriving.
        ctx.expect(gate.loaded().sort(), 'no second injection').toEqual(['google', 'meta', 'tiktok']);
        ctx.expect(gate.consentCommands().at(-1), 'the tag is told to stop').toEqual(['consent', 'update', DENIED]);
      },
    },

    {
      name: 'a stored decision is honored at boot, ahead of the region default',
      run: async (ctx) => {
        const storage = {
          trackingConsent: { analytics: false, marketing: false, region: 'opt-out', timestamp: '2026-08-19T00:00:00.000Z', version: 1 },
        };

        const gate = await boot({ timeZone: 'America/New_York', storage });

        ctx.expect(gate.loaded(), 'a visitor who opted out stays opted out on every later page').toEqual([]);
        ctx.expect(gate.consentCommands()).toEqual([['consent', 'default', DENIED]]);
      },
    },

    {
      name: 'a re-grant of a loaded category never injects twice',
      run: async (ctx) => {
        const gate = await boot({ timeZone: 'Europe/Berlin' });

        gate.setTrackingConsent({ analytics: true, marketing: false });
        gate.setTrackingConsent({ analytics: true, marketing: false });
        gate.setTrackingConsent({ analytics: true, marketing: true });

        ctx.expect(gate.loaded().sort(), 'one script per provider, ever').toEqual(['google', 'meta', 'tiktok']);
      },
    },

    {
      name: 'an unconfigured provider is never loaded, and no id means no queue at all',
      run: async (ctx) => {
        const partial = await boot({ timeZone: 'America/New_York', ids: { google: IDS.google } });
        ctx.expect(partial.loaded(), 'only the configured provider loads').toEqual(['google']);

        const none = await boot({ timeZone: 'America/New_York', ids: {} });
        ctx.expect(none.loaded()).toEqual([]);
        ctx.expect(globalThis.window.dataLayer, 'nothing configured, nothing installed').toBe(undefined);
      },
    },

    {
      name: 'the chrome no longer ships a provider loader of its own',
      run: (ctx) => {
        // The regression that made the old banner decorative. The stubs for an
        // UNCONFIGURED provider stay (page code names the globals; #306 reads a stub
        // as present) — what may not come back is a loader.
        const foot = fs.readFileSync(path.join(CORE_DIR, '_includes', 'core', 'foot.html'), 'utf8');

        ctx.expect(!foot.includes('googletagmanager.com/gtag/js'), 'no gtag.js tag in the chrome').toBeTruthy();
        ctx.expect(!foot.includes('connect.facebook.net'), 'no Meta pixel snippet in the chrome').toBeTruthy();
        ctx.expect(!foot.includes('analytics.tiktok.com'), 'no TikTok pixel snippet in the chrome').toBeTruthy();
        ctx.expect(!foot.includes('facebook.com/tr?id='), 'and no ungated <noscript> tracking pixel').toBeTruthy();
      },
    },
  ],
});
