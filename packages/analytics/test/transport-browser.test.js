/**
 * Browser transport tests — the #306 contract: a missing or blocked page
 * global is a silent no-op, never a ReferenceError that takes the customer's
 * action with it.
 *
 * The globals are set on globalThis and deleted again, so each case runs
 * against the state a real page would be in.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { ANALYTICS_PROVIDERS } = require('@omega.js/config');

const browser = require('../src/transports/browser.js');
const google = require('../src/adapters/google.js');
const meta = require('../src/adapters/meta.js');
const tiktok = require('../src/adapters/tiktok.js');

function clearGlobals() {
  delete globalThis.gtag;
  delete globalThis.fbq;
  delete globalThis.ttq;
}

module.exports = defineCases({
  type: 'group',
  description: 'transport-browser',
  tests: [
    {
      name: 'the browser senders are exactly the rows that say browserSender',
      run: (ctx) => {
        const rows = Object.values(ANALYTICS_PROVIDERS);
        const withSender = rows.filter((row) => row.browserSender).map((row) => row.id).sort();

        ctx.expect(Object.keys(browser.SENDERS).sort(), 'a sender for every row that says it has one, and none for a row that does not').toEqual(withSender);
        ctx.expect(withSender, 'every provider has a page pixel').toEqual(['google', 'meta', 'tiktok']);
      },
    },

    {
      name: 'no globals at all: every provider no-ops without throwing',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        for (const adapter of [google, meta, tiktok]) {
          const descriptor = adapter.resolve('sign_up', { method: 'email' });
          ctx.expect(browser.send(descriptor), `${adapter.provider} reports it could not deliver`).toBe(false);
        }
      },
    },

    {
      name: 'gtag takes the event command with the native name and payload',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.gtag = (...args) => calls.push(args);

        ctx.expect(browser.send(google.resolve('sign_up', { method: 'email' }))).toBe(true);
        ctx.expect(calls).toEqual([['event', 'sign_up', { method: 'email' }]]);
      },
    },

    {
      name: 'fbq picks track or trackCustom by the mapping kind',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.fbq = (...args) => calls.push(args);

        browser.send(meta.resolve('sign_up', { method: 'email' }));        // standard
        browser.send(meta.resolve('login', { method: 'email' }));          // custom

        ctx.expect(calls[0]).toEqual(['track', 'CompleteRegistration', { method: 'email' }]);
        ctx.expect(calls[1]).toEqual(['trackCustom', 'Login', { method: 'email' }]);
      },
    },

    {
      name: 'ttq.track takes the native name and payload',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.ttq = { track: (...args) => calls.push(args) };

        ctx.expect(browser.send(tiktok.resolve('search', { search_term: 'omega' }))).toBe(true);
        ctx.expect(calls).toEqual([['Search', { search_string: 'omega' }]]);
      },
    },

    {
      name: 'a mapping that names a pixel METHOD calls it instead of ttq.track',
      run: (ctx) => {
        // TikTok documents its page view as the SDK-managed `ttq.page()`, and
        // `ttq.track('Pageview')` appears nowhere in that surface — sending one would
        // risk a Pageview metric that silently reads zero
        // ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)). So the catalog
        // names the method and the transport calls exactly that.
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.ttq = {
          page: (...args) => calls.push(['page', ...args]),
          track: (...args) => calls.push(['track', ...args]),
        };

        ctx.expect(browser.send(tiktok.resolve('page_view', { page_path: '/pricing' }))).toBe(true);
        ctx.expect(calls, 'the pixel method takes no name and no payload').toEqual([['page']]);
      },
    },

    {
      name: 'a named method the pixel does not have is a no-op, not a throw',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        // The blocked-global contract (#306) reaches the method lane too: an older
        // pixel build, or a stub an extension left behind, has no `page`.
        globalThis.ttq = { track: () => {} };

        ctx.expect(browser.send(tiktok.resolve('page_view', { page_path: '/' }))).toBe(false);
      },
    },

    {
      name: 'a dedupe id rides in each platform\'s own option slot',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.fbq = (...args) => calls.push(['fbq', ...args]);
        globalThis.ttq = { track: (...args) => calls.push(['ttq', ...args]) };
        globalThis.gtag = (...args) => calls.push(['gtag', ...args]);

        const params = { transaction_id: 'ORD-1', value: 10, currency: 'USD', items: [{ item_id: 'pro' }] };
        const withId = (descriptor) => Object.assign(descriptor, { eventId: 'purchase.ORD-1' });

        browser.send(withId(meta.resolve('purchase', params)));
        browser.send(withId(tiktok.resolve('purchase', params)));
        browser.send(withId(google.resolve('purchase', params)));

        ctx.expect(calls[0].at(-1), 'Meta reads eventID from the fourth argument').toEqual({ eventID: 'purchase.ORD-1' });
        ctx.expect(calls[1].at(-1), 'TikTok reads event_id from the third').toEqual({ event_id: 'purchase.ORD-1' });
        ctx.expect(calls[2].length, 'gtag takes no dedupe option — GA4 has no cross-source dedupe').toBe(4);
      },
    },

    {
      name: 'a half-present ttq (object without track) still no-ops',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        globalThis.ttq = {};

        ctx.expect(browser.send(tiktok.resolve('search', { search_term: 'omega' }))).toBe(false);
      },
    },

    {
      name: 'blockers are per-list: Google allowed still counts while Meta is gone',
      run: (ctx) => {
        clearGlobals();
        ctx.after(clearGlobals);

        const calls = [];
        globalThis.gtag = (...args) => calls.push(args);

        ctx.expect(browser.send(google.resolve('sign_up', { method: 'email' }))).toBe(true);
        ctx.expect(browser.send(meta.resolve('sign_up', { method: 'email' }))).toBe(false);
        ctx.expect(calls.length).toBe(1);
      },
    },

    {
      name: 'an unknown provider is a no-op, not a crash',
      run: (ctx) => {
        ctx.expect(browser.send({ provider: 'pinterest', name: 'X', kind: 'standard', payload: {} })).toBe(false);
      },
    },
  ],
});
