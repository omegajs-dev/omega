/**
 * Facade tests — the one consumer call: consent, resolution, transport,
 * the dev log, and the unknown-name contract.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const analytics = require('../src/index.js');

// A transport that records instead of reaching a page. Returns `delivered` so
// the "blocked global" path is testable without page globals.
function recordingTransport(delivered = true) {
  const sent = [];
  return {
    sent,
    send(descriptor) {
      sent.push(descriptor);
      return delivered;
    },
  };
}

// Every test starts from the package defaults — module state is process-wide.
function reset(options = {}) {
  return analytics.configure({
    transport: null,
    consent: analytics.createConsentGate(() => ({ analytics: true, marketing: true })),
    context: {},
    environment: 'production',
    ...options,
  });
}

// Capture the dev log without letting it reach the runner's stdout.
function captureLog(run) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    run();
  } finally {
    console.log = real;
  }
  return lines;
}

module.exports = defineCases({
  type: 'group',
  description: 'facade',
  tests: [
    {
      name: 'a mapped event reaches every provider through the transport',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        const result = analytics.event('sign_up', { method: 'email' });

        ctx.expect(transport.sent.map((d) => d.provider)).toEqual(['google', 'meta', 'tiktok']);
        ctx.expect(transport.sent.map((d) => d.name)).toEqual(['sign_up', 'CompleteRegistration', 'CompleteRegistration']);
        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['sent', 'sent', 'sent']);
      },
    },

    {
      name: 'an unmapped provider is skipped, never a throw',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        const result = analytics.event('vert_click', { vert_id: 'omega-promo', vert_lane: 'promo' });

        ctx.expect(transport.sent.map((d) => d.provider), 'only the mapped provider is executed').toEqual(['google']);
        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['sent', 'skipped (no mapping)', 'skipped (no mapping)']);
      },
    },

    {
      name: 'a zero-provider event fires nothing and dev-logs all-skipped',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport, environment: 'development' });

        let result;
        const lines = captureLog(() => {
          result = analytics.event('logout');
        });

        ctx.expect(transport.sent, 'logout reaches no provider').toEqual([]);
        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['skipped (no mapping)', 'skipped (no mapping)', 'skipped (no mapping)']);
        ctx.expect(lines).toEqual(['[@omega.js/analytics:events] logout → google skipped (no mapping), meta skipped (no mapping), tiktok skipped (no mapping)']);
      },
    },

    {
      name: 'the dev log prints one tagged line per fire',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport, environment: 'development' });

        const lines = captureLog(() => analytics.event('sign_up', { method: 'email' }));

        ctx.expect(lines).toEqual(['[@omega.js/analytics:events] sign_up → google sent, meta sent, tiktok sent']);
      },
    },

    {
      name: 'production prints nothing per fire',
      run: (ctx) => {
        reset({ transport: recordingTransport() });

        const lines = captureLog(() => analytics.event('sign_up', { method: 'email' }));

        ctx.expect(lines).toEqual([]);
      },
    },

    {
      name: 'an unknown event name throws in development',
      run: (ctx) => {
        reset({ transport: recordingTransport(), environment: 'development' });

        ctx.expect(() => analytics.event('sign_upp', { method: 'email' })).toThrow(/Unknown analytics event "sign_upp"/);
      },
    },

    {
      name: 'a providers option naming no provider row throws in development',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport, environment: 'development' });

        // The retired GA4 id: a restriction that matched nothing would silently drop the fire
        ctx.expect(() => analytics.event('purchase', { value: 10 }, { providers: ['ga4'] })).toThrow(/ga4/);
        ctx.expect(transport.sent, 'nothing is sent').toEqual([]);
      },
    },

    {
      name: 'an unknown event name is logged and skipped in production',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        const warnings = [];
        const real = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        let result;
        try {
          result = analytics.event('sign_upp', { method: 'email' });
        } finally {
          console.warn = real;
        }

        ctx.expect(result.results, 'nothing resolves').toEqual([]);
        ctx.expect(transport.sent, 'nothing is sent').toEqual([]);
        ctx.expect(warnings[0]).toMatch(/^\[@omega\.js\/analytics:events\] Unknown event "sign_upp"/);
      },
    },

    {
      name: 'marketing denied blocks meta and tiktok; google still fires',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({
          transport,
          consent: analytics.createConsentGate(() => ({ analytics: true, marketing: false })),
        });

        const result = analytics.event('purchase', { value: 10, currency: 'USD', items: [{ item_id: 'pro' }] });

        ctx.expect(transport.sent.map((d) => d.provider)).toEqual(['google']);
        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['sent', 'skipped (consent: marketing)', 'skipped (consent: marketing)']);
      },
    },

    {
      name: 'analytics denied blocks google while the ad platforms still fire',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({
          transport,
          consent: analytics.createConsentGate(() => ({ analytics: false, marketing: true })),
        });

        analytics.event('purchase', { value: 10, currency: 'USD', items: [{ item_id: 'pro' }] });

        ctx.expect(transport.sent.map((d) => d.provider)).toEqual(['meta', 'tiktok']);
      },
    },

    {
      name: 'the consent gate is read live, so a mid-session accept counts',
      run: (ctx) => {
        const transport = recordingTransport();
        let marketing = false;
        reset({
          transport,
          consent: analytics.createConsentGate(() => ({ analytics: true, marketing })),
        });

        analytics.event('sign_up', { method: 'email' });
        ctx.expect(transport.sent.map((d) => d.provider)).toEqual(['google']);

        marketing = true;
        analytics.event('sign_up', { method: 'email' });
        ctx.expect(transport.sent.map((d) => d.provider)).toEqual(['google', 'google', 'meta', 'tiktok']);
      },
    },

    {
      name: 'a missing consent category reads as denied',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport, consent: analytics.createConsentGate(() => ({})) });

        analytics.event('sign_up', { method: 'email' });

        ctx.expect(transport.sent, 'nothing is granted by omission').toEqual([]);
      },
    },

    {
      name: 'with no transport configured the walk still resolves and reports',
      run: (ctx) => {
        reset();

        const result = analytics.event('sign_up', { method: 'email' });

        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['skipped (no transport)', 'skipped (no transport)', 'skipped (no transport)']);
        ctx.expect(result.results[0].descriptor.name).toBe('sign_up');
      },
    },

    {
      name: 'a transport that could not deliver reports blocked, never throws',
      run: (ctx) => {
        reset({ transport: recordingTransport(false), environment: 'development' });

        let result;
        const lines = captureLog(() => {
          result = analytics.event('page_view', { page_path: '/' });
        });

        ctx.expect(result.results[0].outcome).toBe('blocked (no global)');
        ctx.expect(lines).toEqual(['[@omega.js/analytics:events] page_view → google blocked (no global), meta blocked (no global), tiktok blocked (no global)']);
      },
    },

    // ─── The two-half fire (a browser twin of a server event) ───

    {
      name: 'an eventId rides onto every descriptor the fire resolves',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        analytics.event('sign_up', { method: 'email' }, { eventId: 'sign_up.uid-9' });

        ctx.expect(transport.sent.map((d) => d.eventId), 'both halves of a conversion can name the same id').toEqual(['sign_up.uid-9', 'sign_up.uid-9', 'sign_up.uid-9']);
      },
    },

    {
      name: 'without an eventId no descriptor carries one',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        analytics.event('sign_up', { method: 'email' });

        ctx.expect(transport.sent.map((d) => d.eventId)).toEqual([undefined, undefined, undefined]);
      },
    },

    {
      name: 'a providers restriction fires only the half this side owns',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({ transport });

        // A half naming the providers it owns. (The live purchase pixel names all
        // three — GA4 dedupes on transaction_id, [#656] — so this is the mechanism
        // under test, not that page's policy.)
        const result = analytics.event(
          'purchase',
          { transaction_id: 'ORD-1', value: 10, currency: 'USD', items: [{ item_id: 'pro' }] },
          { providers: ['meta', 'tiktok'], eventId: 'purchase.ORD-1' },
        );

        ctx.expect(transport.sent.map((d) => d.provider), 'GA4 is never asked').toEqual(['meta', 'tiktok']);
        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['skipped (not selected)', 'sent', 'sent']);
        ctx.expect(transport.sent.map((d) => d.eventId)).toEqual(['purchase.ORD-1', 'purchase.ORD-1']);
      },
    },

    {
      name: 'selection comes before consent — an unselected provider is never asked',
      run: (ctx) => {
        const transport = recordingTransport();
        reset({
          transport,
          consent: analytics.createConsentGate(() => ({ analytics: true, marketing: false })),
        });

        const result = analytics.event('purchase', { value: 10 }, { providers: ['google'] });

        ctx.expect(result.results.map((r) => r.outcome)).toEqual(['sent', 'skipped (not selected)', 'skipped (not selected)']);
      },
    },

    {
      name: 'the pure pieces are exported for hosts that skip the facade',
      run: (ctx) => {
        ctx.expect(analytics.catalog.purchase, 'the catalog').toBeTruthy();
        ctx.expect(analytics.adapters.google && analytics.adapters.meta && analytics.adapters.tiktok, 'the adapters').toBeTruthy();
        ctx.expect(typeof analytics.core.deriveNamespace, 'the moved core').toBe('function');
        ctx.expect(typeof analytics.transports.browser.send, 'the browser transport').toBe('function');
        ctx.expect(analytics.CONSENT_CATEGORIES).toEqual(['analytics', 'marketing']);
      },
    },
  ],
});
