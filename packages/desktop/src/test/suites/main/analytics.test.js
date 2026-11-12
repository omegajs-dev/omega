// Main-layer tests for lib/analytics.js — disabled-without-creds path,
// uuidv5 cross-platform identity, event-name normalization, queueing,
// auth-bridge user_id flipping, IPC handlers.

const { v5: uuidv5 } = require('uuid');
const defineCases = require('@omega.js/devkit/test/define-cases');

async function reinit(ctx, env, configOverrides) {
  ctx.omega.analytics.shutdown();
  const saved = {
    GOOGLE_ANALYTICS_SECRET: process.env.GOOGLE_ANALYTICS_SECRET,
  };
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const cfgOrig = ctx.omega.config.analytics;
  if (configOverrides !== undefined) {
    ctx.omega.config.analytics = configOverrides;
  }
  ctx.omega.analytics.initialize(ctx.omega);
  return () => {
    ctx.omega.analytics.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    ctx.omega.config.analytics = cfgOrig;
    ctx.omega.analytics.initialize(ctx.omega);
  };
}

module.exports = defineCases({
  type: 'suite',
  layer: 'main',
  description: 'analytics (main)',
  cleanup: async (ctx) => {
    ctx.omega.analytics.shutdown();
    delete process.env.GOOGLE_ANALYTICS_SECRET;
    ctx.omega.analytics.initialize(ctx.omega);
  },
  tests: [
    {
      name: 'analytics module wired on omega',
      run: (ctx) => {
        ctx.expect(ctx.omega.analytics).toBeDefined();
      },
    },
    {
      name: 'enabled=false: short-circuits, no measurementId, no clientId',
      run: async (ctx) => {
        const restore = await reinit(ctx, {}, { enabled: false });
        try {
          ctx.expect(ctx.omega.analytics._enabled).toBe(false);
          ctx.expect(ctx.omega.analytics._clientId).toBe(null);
        } finally { await restore(); }
      },
    },
    {
      name: 'no measurement ID: disabled with warning, no clientId',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: '' } },
        });
        try {
          ctx.expect(ctx.omega.analytics._enabled).toBe(false);
        } finally { await restore(); }
      },
    },
    {
      name: 'no API secret: disabled (matches @omega.js/backend env-var convention)',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: null }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          ctx.expect(ctx.omega.analytics._enabled).toBe(false);
        } finally { await restore(); }
      },
    },
    {
      name: 'fully configured: enabled, has clientId (uuidv5 of deviceId)',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          ctx.expect(ctx.omega.analytics._enabled).toBe(true);
          ctx.expect(typeof ctx.omega.analytics._clientId).toBe('string');
          ctx.expect(ctx.omega.analytics._clientId.length).toBe(36);
          // Confirm it's a stable derivation: same deviceId + same namespace should
          // produce the same uuidv5 every time.
          const ns = ctx.omega.analytics._namespace;
          const deviceId = ctx.omega.context.session.deviceId;
          ctx.expect(ctx.omega.analytics._clientId).toBe(uuidv5(deviceId, ns));
        } finally { await restore(); }
      },
    },
    {
      // #396: a missing deviceId is a broken boot order, never a runtime
      // condition — an id minted here would persist nowhere and make every
      // launch a new GA client, so initialize raises instead of limping.
      name: 'no context.session.deviceId: initialize raises (the boot-order invariant)',
      run: async (ctx) => {
        const savedDeviceId = ctx.omega.context.session.deviceId;
        const savedSecret   = process.env.GOOGLE_ANALYTICS_SECRET;
        const savedConfig   = ctx.omega.config.analytics;

        ctx.omega.analytics.shutdown();
        ctx.omega.context.session.deviceId = null;
        process.env.GOOGLE_ANALYTICS_SECRET  = 'fake-secret';
        ctx.omega.config.analytics = { enabled: true, providers: { google: { id: 'G-TESTID12' } } };

        try {
          await ctx.expect(() => ctx.omega.analytics.initialize(ctx.omega)).toThrow(/boot sequence/);
        } finally {
          ctx.omega.context.session.deviceId = savedDeviceId;
          ctx.omega.config.analytics = savedConfig;
          if (savedSecret == null) delete process.env.GOOGLE_ANALYTICS_SECRET;
          else process.env.GOOGLE_ANALYTICS_SECRET = savedSecret;
          ctx.omega.analytics.shutdown();
          ctx.omega.analytics.initialize(ctx.omega);
        }
      },
    },
    {
      name: 'cross-platform identity: same firebase uid → same uuidv5 across surfaces',
      run: async (ctx) => {
        // The whole point: @omega.js/client and @omega.js/backend seeing the same firebase uid
        // produce identical uuidv5 outputs for user_id, given same projectId namespace.
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          const a = ctx.omega.analytics;
          const ns = a._namespace;
          a.setUserId('firebase-uid-abc-123');
          const expected = uuidv5('firebase-uid-abc-123', ns);
          ctx.expect(a._userId).toBe(expected);
          // Re-derive from a fresh uuidv5 call — must match (deterministic).
          ctx.expect(uuidv5('firebase-uid-abc-123', ns)).toBe(expected);
        } finally { await restore(); }
      },
    },
    {
      // wave-5 F5: a pre-init setUserId stored _pendingUid that initialize()
      // never read — the uid was silently discarded.
      name: 'setUserId before initialize is applied at init (pending uid)',
      run: async (ctx) => {
        // Hand-rolled (not reinit()): the helper's leading shutdown() would
        // wipe the very _pendingUid this test plants.
        const a = ctx.omega.analytics;
        a.shutdown(); // _namespace null — the pre-init state

        a.setUserId('early-uid-before-boot');
        ctx.expect(a._pendingUid).toBe('early-uid-before-boot');

        const savedSecret = process.env.GOOGLE_ANALYTICS_SECRET;
        process.env.GOOGLE_ANALYTICS_SECRET = 'fake-secret';
        const cfgOrig = ctx.omega.config.analytics;
        ctx.omega.config.analytics = { enabled: true, providers: { google: { id: 'G-TESTID12' } } };
        try {
          a.initialize(ctx.omega);
          ctx.expect(a._pendingUid).toBe(null);
          ctx.expect(a._userId).toBe(uuidv5('early-uid-before-boot', a._namespace));
        } finally {
          a.shutdown();
          if (savedSecret == null) delete process.env.GOOGLE_ANALYTICS_SECRET;
          else process.env.GOOGLE_ANALYTICS_SECRET = savedSecret;
          ctx.omega.config.analytics = cfgOrig;
          a.initialize(ctx.omega);
        }
      },
    },
    {
      name: 'setUserId(null) clears user_id',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          ctx.omega.analytics.setUserId('some-uid');
          ctx.expect(ctx.omega.analytics._userId).not.toBe(null);
          ctx.omega.analytics.setUserId(null);
          ctx.expect(ctx.omega.analytics._userId).toBe(null);
        } finally { await restore(); }
      },
    },
    {
      // The catalog owns the NAME now (#328 stage E): this module no longer
      // normalizes free-typed strings, it fires canonical events and the shared
      // adapters decide what GA4 is told. An uncatalogued name is a programmer
      // error — logged and skipped rather than posted as junk.
      name: 'the shared catalog decides the name; an unknown one never posts',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });

        const a = ctx.omega.analytics;
        const origSend = a._send;
        const sent = [];
        a._send = (descriptor) => { sent.push(descriptor); return true; };

        try {
          a.event('screen_view', { screen_name: 'Settings' });
          ctx.expect(sent.length).toBe(1);
          ctx.expect(sent[0].provider).toBe('google');
          ctx.expect(sent[0].name).toBe('screen_view');
          ctx.expect(sent[0].payload.screen_name).toBe('Settings');
          // The enrichment desktop still owns rides the payload
          ctx.expect(typeof sent[0].payload.session_id).toBe('string');
          ctx.expect(typeof sent[0].payload.engagement_time_msec).toBe('number');

          sent.length = 0;
          a.event('Hello World!', { x: 1 });
          ctx.expect(sent.length).toBe(0);
        } finally {
          a._send = origSend;
          await restore();
        }
      },
    },
    {
      // Main's sender is the Measurement Protocol alone, so a descriptor for a
      // provider whose row has none is refused rather than posted to Google.
      name: 'the sender answers false for a provider whose row has no Measurement Protocol',
      run: async (ctx) => {
        const { ANALYTICS_PROVIDERS } = require('@omega.js/config');
        const { adapters } = require('@omega.js/analytics');
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });

        try {
          const without = Object.values(ANALYTICS_PROVIDERS).filter((row) => !row.measurementProtocol).map((row) => row.id).sort();
          ctx.expect(without, 'the ad platforms have no Measurement Protocol').toEqual(['meta', 'tiktok']);

          for (const provider of without) {
            const descriptor = adapters[provider].resolve('sign_up', { method: 'email' });
            ctx.expect(ctx.omega.analytics._send(descriptor), `${provider} is never posted`).toBe(false);
          }
        } finally {
          await restore();
        }
      },
    },
    {
      name: '_enrichParams adds session_id + engagement_time_msec',
      run: (ctx) => {
        const params = ctx.omega.analytics._enrichParams({ custom: 'value' });
        ctx.expect(params.custom).toBe('value');
        ctx.expect(typeof params.session_id).toBe('string');
        ctx.expect(typeof params.engagement_time_msec).toBe('number');
        ctx.expect(params.engagement_time_msec >= 1).toBe(true);
        ctx.expect('page_location' in params).toBe(true);
        ctx.expect('page_title' in params).toBe(true);
      },
    },
    {
      name: 'event() with disabled analytics is a no-op (no throw)',
      run: async (ctx) => {
        const restore = await reinit(ctx, {}, { enabled: false });
        try {
          // Should not throw.
          ctx.omega.analytics.event('app_launch', { x: 1 });
          ctx.expect(true).toBe(true);
        } finally { await restore(); }
      },
    },
    {
      name: 'event() before init queues, queue is bounded',
      run: (ctx) => {
        const a = ctx.omega.analytics;
        a.shutdown();   // back to uninitialized state
        a.event('queued_one');
        a.event('queued_two');
        ctx.expect(a._queue.length).toBe(2);
        ctx.omega.analytics.initialize(ctx.omega);   // restore for downstream tests
      },
    },
    {
      name: 'queue flushes on init',
      run: async (ctx) => {
        // Force a "before init" state with a couple of queued items.
        ctx.omega.analytics.shutdown();
        ctx.omega.analytics._queue.push({ name: 'x', params: {} });
        ctx.omega.analytics._queue.push({ name: 'y', params: {} });
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          // After init, queue should be drained.
          ctx.expect(ctx.omega.analytics._queue.length).toBe(0);
        } finally { await restore(); }
      },
    },
    {
      name: 'auth bridge: setUserId fires on auth, clears on logout',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          const a = ctx.omega.analytics;
          // Simulate auth bridge firing.
          a._handleAuthChange({ uid: 'user-123' });
          ctx.expect(a._userId).not.toBe(null);
          // Logout.
          a._handleAuthChange({ uid: null });
          ctx.expect(a._userId).toBe(null);
        } finally { await restore(); }
      },
    },
    {
      name: 'setUserProperties merges into _userProperties as { value: ... }',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          ctx.omega.analytics.setUserProperties({ plan: 'premium', custom_flag: true });
          ctx.expect(ctx.omega.analytics._userProperties.plan).toEqual({ value: 'premium' });
          ctx.expect(ctx.omega.analytics._userProperties.custom_flag).toEqual({ value: true });
        } finally { await restore(); }
      },
    },
    {
      name: 'IPC handler desktop:analytics:status returns the JSON snapshot',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          const snap = await ctx.omega.ipc.invoke('desktop:analytics:status');
          ctx.expect(snap.enabled).toBe(true);
          ctx.expect(snap.measurementId).toBe('G-TESTID12');
        } finally { await restore(); }
      },
    },
    {
      name: 'IPC listener desktop:analytics:event routes to analytics.event',
      run: async (ctx) => {
        const a = ctx.omega.analytics;
        const origEvent = a.event;
        let captured = null;
        a.event = (name, params) => { captured = { name, params }; };
        try {
          // Simulate an inbound IPC call (renderer would do ipcRenderer.send).
          const listeners = ctx.omega.ipc._listeners?.['desktop:analytics:event'];
          ctx.expect(listeners).toBeDefined();
          listeners.forEach((fn) => fn({ name: 'rendererEvent', params: { x: 1 } }));
          ctx.expect(captured).toEqual({ name: 'rendererEvent', params: { x: 1 } });
        } finally { a.event = origEvent; }
      },
    },
    {
      name: 'toJSON exposes safe inspection state (no secret)',
      run: async (ctx) => {
        const restore = await reinit(ctx, { GOOGLE_ANALYTICS_SECRET: 'fake-secret' }, {
          enabled: true,
          providers: { google: { id: 'G-TESTID12' } },
        });
        try {
          const j = ctx.omega.analytics.toJSON();
          ctx.expect(j.enabled).toBe(true);
          ctx.expect(j.measurementId).toBe('G-TESTID12');
          ctx.expect(typeof j.clientId).toBe('string');
          ctx.expect('userId' in j).toBe(true);
          ctx.expect('queueLength' in j).toBe(true);
          // Secret must NOT leak.
          ctx.expect('apiSecret' in j).toBe(false);
          ctx.expect(JSON.stringify(j).indexOf('fake-secret')).toBe(-1);
        } finally { await restore(); }
      },
    },
  ],
});
