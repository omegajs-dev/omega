/**
 * The confirmation page's purchase PIXEL — revived, deduped, and classified
 * ([#386](https://github.com/Omega-JS-Stack/omega/issues/386), stage E of
 * [#328](https://github.com/Omega-JS-Stack/omega/issues/328); the two carried
 * bugs are specced on [#302](https://github.com/Omega-JS-Stack/omega/issues/302)).
 *
 * Three things were wrong at once, and each has a case here:
 *
 *  1. THE CALL WAS COMMENTED OUT. The backend's webhook captured the revenue,
 *     but the browser never told Meta or TikTok anything — so every purchase
 *     was invisible to the retargeting that paid for it.
 *  2. THE CLASSIFIER READ THE FREQUENCY STRING. `state.frequency ? 'subscription'
 *     : 'one-time'` called a one-time buy a subscription, because checkout sends
 *     `frequency=once` for one (#282, the same bug the receipt copy carried).
 *  3. NO DEDUPE ID. A browser half and a server half of the same purchase with
 *     no shared id are two purchases to Meta and TikTok.
 *
 * Two more landed on 2026-08-27, and each has its case below too:
 *
 *  4. A TRIAL CHECKOUT FIRED A PURCHASE
 *     ([#654](https://github.com/Omega-JS-Stack/omega/issues/654)). `?track=true`
 *     rides EVERY checkout, so a $0 trial sent a browser Purchase while the
 *     webhook sent `trial_start`. The value was already 0 (the intent route puts
 *     `amount=0` on a trial's confirmation URL); the NAME was the defect — two
 *     different event names never deduplicate, so each platform counted the
 *     browser half as a second conversion on top of the server's trial.
 *  5. GA4 WAS LEFT OFF THE PURCHASE
 *     ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)). GA4
 *     deduplicates `purchase` on `transaction_id`, so the browser half can carry
 *     the session and the campaign a webhook has none of, and GA4 still counts
 *     one purchase.
 *
 * The module is browser code behind two bundler aliases, so the harness drives
 * the REAL file through esbuild — and through the REAL catalog, adapters and
 * guarded transport, so what the page globals receive is what a live pixel
 * would (the convention analytics-blocked.test.js sets).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { ANALYTICS_PROVIDERS, clientConfig } = require('@omega.js/config');

const PKG = path.join(__dirname, '..');
const ROOT = path.resolve(PKG, '..', '..');
const CORE_DIR = path.join(PKG, 'core');
const CONFIRMATION = path.join(CORE_DIR, 'js', 'pages', 'payment', 'confirmation');
const TRACKING_ENTRY = path.join(CONFIRMATION, 'modules', 'tracking.js');

// The client's built module — the door web core reaches the analytics package
// through, vendored copy and all.
const CLIENT_ANALYTICS = path.join(ROOT, 'packages', 'client', 'dist', 'modules', 'analytics.js');

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-confirmation-pixel-'));
const BUNDLE = path.join(BUNDLE_DIR, 'tracking.cjs');

let building = null;

function bundleOnce() {
  building ||= esbuild.build({
    entryPoints: [TRACKING_ENTRY],
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
        // The REAL client module: the catalog, the adapters and the guarded
        // transport are the contract under test, never a stub of them.
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

/** A page with the pixels loaded and the visitor consented to everything. */
function wirePage(brandConfig) {
  const tracked = [];
  const stored = new Map([
    // The tracking-consent record the banner writes (#383). Without a granted
    // record the marketing category is closed and no pixel may be told anything.
    ['trackingConsent', { analytics: true, marketing: true, region: 'opt-out', version: 1 }],
  ]);

  globalThis.window = {
    location: { pathname: '/payment/confirmation', search: '?track=true', href: 'https://brand.test/payment/confirmation?track=true' },
    history: { replaceState: () => {} },
  };
  globalThis.document = { title: 'Confirmation', cookie: '' };
  globalThis.__omegaClient = {
    // The build's own bake, so the provider rows ride it as analytics.capabilities
    config: clientConfig(brandConfig),
    storage: {
      get: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback),
      set: (key, value) => stored.set(key, value),
    },
  };

  globalThis.gtag = (...args) => tracked.push(['gtag', ...args]);
  globalThis.fbq = (...args) => tracked.push(['fbq', ...args]);
  globalThis.ttq = { track: (...args) => tracked.push(['ttq', ...args]) };

  return { tracked, stored };
}

// The page global each provider row's pixel answers on
const PIXEL_GLOBAL = { google: 'gtag', meta: 'fbq', tiktok: 'ttq' };

/** The pixel globals of the rows a predicate picks, in row order */
function pixelsOf(predicate) {
  return Object.values(ANALYTICS_PROVIDERS).filter(predicate).map((row) => PIXEL_GLOBAL[row.id]);
}

function clearPage() {
  for (const name of ['gtag', 'fbq', 'ttq', 'window', 'document', '__omegaClient']) {
    delete globalThis[name];
  }
}

/** The state the page parses out of the provider's redirect. */
function purchaseState(overrides = {}) {
  return {
    orderId: 'ORD-1',
    productId: 'premium',
    productName: 'Premium',
    amount: 19,
    currency: 'USD',
    frequency: 'monthly',
    paymentMethod: 'stripe',
    hasFreeTrial: false,
    ...overrides,
  };
}

async function trackOnce(state, brandConfig = { analytics: { providers: { meta: { id: 'META-1' } } } }) {
  await bundleOnce();

  const page = wirePage(brandConfig);

  delete require.cache[require.resolve(BUNDLE)];
  const tracking = require(BUNDLE);

  tracking.trackPurchaseIfNeeded(state);

  return page;
}

module.exports = defineCases({
  type: 'group',
  description: 'confirmation-purchase-pixel',
  tests: [
    {
      name: '#386/#656: the purchase pixel fires to all three, GA4 included',
      run: async (ctx) => {
        ctx.after(clearPage);

        const { tracked } = await trackOnce(purchaseState());

        ctx.expect(tracked.map(([provider]) => provider), 'a purchase reaches every provider: GA4 deduplicates against the webhook on transaction_id (#656)').toEqual(pixelsOf(() => true));
        ctx.expect(pixelsOf(() => true)).toEqual(['gtag', 'fbq', 'ttq']);

        const [google, meta, tiktok] = tracked;
        ctx.expect(google[1]).toBe('event');
        ctx.expect(google[2]).toBe('purchase');
        ctx.expect(google[3].transaction_id, 'the id the webhook sends too — GA4 collapses the two halves on it').toBe('ORD-1');
        ctx.expect(google[3].value, 'and the browser half carries the real amount').toBe(19);
        ctx.expect(meta[1], 'Purchase is one of Meta\'s standard events').toBe('track');
        ctx.expect(meta[2]).toBe('Purchase');
        ctx.expect(tiktok[1], 'TikTok retired CompletePayment for its own Purchase (#652)').toBe('Purchase');
      },
    },

    {
      name: '#386: both halves name the same dedupe id, derived from the order',
      run: async (ctx) => {
        ctx.after(clearPage);

        const { tracked } = await trackOnce(purchaseState());

        const [, meta, tiktok] = tracked;

        // The backend keys the two browser-twinned events on the ORDER
        // (payments-webhooks/analytics.js resolveEventId) — the only id a browser holds.
        ctx.expect(meta.at(-1), 'Meta deduplicates on (event_name, event_id)').toEqual({ eventID: 'purchase.ORD-1' });
        ctx.expect(tiktok.at(-1), 'and TikTok on event_id').toEqual({ event_id: 'purchase.ORD-1' });
      },
    },

    {
      name: '#654: a trial checkout fires trial_start with value 0 — never a purchase',
      run: async (ctx) => {
        ctx.after(clearPage);

        const { tracked } = await trackOnce(purchaseState({ hasFreeTrial: true }));

        ctx.expect(tracked.map(([provider]) => provider), 'a trial reaches only the providers that dedupe on the event id: the webhook owns the rest').toEqual(pixelsOf((row) => row.dedupesOnEventId));
        ctx.expect(pixelsOf((row) => row.dedupesOnEventId)).toEqual(['fbq', 'ttq']);

        const [meta, tiktok] = tracked;

        ctx.expect(meta[2], 'Meta\'s own event for the start of a free trial').toBe('StartTrial');
        ctx.expect(meta[3].value, 'a trial charges nothing, whatever amount the confirmation URL carried').toBe(0);
        ctx.expect(meta[3].currency).toBe('USD');
        ctx.expect(meta.at(-1), 'and the id the webhook now derives the same way').toEqual({ eventID: 'trial_start.ORD-1' });

        ctx.expect(tiktok[1]).toBe('StartTrial');
        ctx.expect(tiktok[2].value).toBe(0);
        ctx.expect(tiktok.at(-1)).toEqual({ event_id: 'trial_start.ORD-1' });
      },
    },

    {
      name: '#654: a trial never sends a Purchase to any platform',
      run: async (ctx) => {
        ctx.after(clearPage);

        // The state's `amount: 19` is DEFENSIVE, not what a live trial arrives with:
        // the intent route already puts `amount=0` on a trial's confirmation URL. The
        // fixture proves the pixel's own guard, not the URL's.
        const { tracked } = await trackOnce(purchaseState({ hasFreeTrial: true }));

        const names = JSON.stringify(tracked);

        ctx.expect(names.includes('Purchase'), `a $0 trial must book no purchase anywhere: ${names}`).toBe(false);
        ctx.expect(names.includes('19'), 'nor the plan price nobody was charged').toBe(false);
      },
    },

    {
      name: 'a trial confirmation on a brand with no analytics section tracks without throwing',
      run: async (ctx) => {
        ctx.after(clearPage);

        // The bake carries the provider rows for every brand, so the trial's recipients resolve with nothing configured
        const { tracked } = await trackOnce(purchaseState({ hasFreeTrial: true }), { brand: { id: 'acme' } });

        ctx.expect(tracked.map(([provider]) => provider)).toEqual(pixelsOf((row) => row.dedupesOnEventId));
      },
    },

    {
      name: '#386: a one-time buy is not a subscription (the frequency-string bug)',
      run: async (ctx) => {
        ctx.after(clearPage);

        // Checkout sends `frequency=once` for a one-time purchase, so the old
        // `state.frequency ? 'subscription' : 'one-time'` called every one of them a
        // subscription — the same truthiness bug the receipt copy carried (#282).
        const { tracked } = await trackOnce(purchaseState({ frequency: 'once' }));

        const [, meta] = tracked;
        ctx.expect(meta[3].content_type, 'the item still rides as a product').toBe('product');

        const { tracked: subscription } = await trackOnce(purchaseState({ frequency: 'monthly' }));
        ctx.expect(subscription.length, 'a subscription purchase still fires').toBeTruthy();
      },
    },

    {
      name: '#386: the classifier reads the product, never the frequency string',
      run: async (ctx) => {
        await bundleOnce();

        const { buildItems } = require(BUNDLE);

        ctx.expect(buildItems(purchaseState({ frequency: 'once' }))[0].item_category, 'frequency=once is a one-time purchase').toBe('one-time');
        ctx.expect(buildItems(purchaseState({ frequency: 'monthly' }))[0].item_category, 'a real billing cadence is a subscription').toBe('subscription');
        ctx.expect(buildItems(purchaseState({ frequency: '' }))[0].item_category, 'and no frequency at all is not a subscription either').toBe('one-time');
      },
    },

    {
      name: '#668: a one-time purchase reports itself as one to every platform',
      run: async (ctx) => {
        await bundleOnce();

        const { buildItems } = require(BUNDLE);

        // The live buy (order 5434-3892-3088) reached this file as
        // `frequency=annually` — checkout resolved a cadence for a product that has
        // none — so the browser purchase told GA4, Meta and TikTok that a $49.99
        // one-time buy was a subscription. The redirect now carries what was bought
        // outright, so even that URL is classified by the TYPE and the cadence beside
        // it decides nothing.
        const [stale] = buildItems(purchaseState({
          productId: 'launch-kit',
          productName: 'Starter Library',
          amount: 49.99,
          type: 'one-time',
          frequency: 'annually',
        }));

        ctx.expect(stale.item_category, 'the conversion is categorized by what was bought, not by the cadence beside it').toBe('one-time');
        ctx.expect(stale.item_variant, 'and a stale link never reports a cadence on a one-time buy').toBe('once');
        ctx.expect(stale.price, 'at the price the card was charged').toBe(49.99);

        // And checkout now sends the word a one-time buy actually bills on, so a
        // freshly minted link names no cadence the buyer will never be billed on.
        const [item] = buildItems(purchaseState({
          productId: 'launch-kit',
          productName: 'Starter Library',
          amount: 49.99,
          type: 'one-time',
          frequency: 'once',
        }));

        ctx.expect(item.item_category, 'still a one-time purchase').toBe('one-time');
        ctx.expect(item.item_variant, 'and its variant is the one-time word, not a cadence').toBe('once');
      },
    },

    {
      name: '#386: the page really calls the tracker — the commented-out state is gone',
      run: (ctx) => {
        const source = fs.readFileSync(path.join(CONFIRMATION, 'index.js'), 'utf8');

        // Comments blanked, line structure intact: a call that only exists inside a
        // comment is exactly the bug this pins.
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/.*$/gm, (match, before) => before + ' '.repeat(match.length - before.length));

        ctx.expect(code, 'the confirmation page calls the purchase tracker in live code').toMatch(/trackPurchaseIfNeeded\(state\)/);
      },
    },
  ],
});
