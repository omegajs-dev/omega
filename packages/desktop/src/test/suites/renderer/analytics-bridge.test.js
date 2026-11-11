// Renderer-layer round-trip tests for window.desktop.{analytics,context,usage,remoteConfig}.
// Verifies the contextBridge surfaces actually round-trip through IPC into main.

const defineCases = require('@omega.js/devkit/test/define-cases');

module.exports = defineCases({
  type: 'suite',
  layer: 'renderer',
  description: 'analytics + context + usage + remote-config bridges (renderer)',
  tests: [
    {
      name: 'window.desktop.analytics has event / pageview / screenview / setUserProperties / getStatus',
      run: (ctx) => {
        ctx.expect(typeof window.desktop.analytics.event).toBe('function');
        ctx.expect(typeof window.desktop.analytics.pageview).toBe('function');
        ctx.expect(typeof window.desktop.analytics.screenview).toBe('function');
        ctx.expect(typeof window.desktop.analytics.setUserProperties).toBe('function');
        ctx.expect(typeof window.desktop.analytics.getStatus).toBe('function');
      },
    },
    {
      name: 'window.desktop.analytics.getStatus round-trips main state',
      run: async (ctx) => {
        const status = await window.desktop.analytics.getStatus();
        ctx.expect(status).toBeDefined();
        // Should always have the enabled boolean — even when analytics is off.
        ctx.expect(typeof status.enabled).toBe('boolean');
      },
    },
    {
      name: 'window.desktop.analytics.event is fire-and-forget (no throw)',
      run: (ctx) => {
        // No await — send is one-way. Just verify it doesn't throw.
        window.desktop.analytics.event('renderer_test_event', { from: 'renderer' });
        window.desktop.analytics.pageview('/test/path');
        window.desktop.analytics.screenview('TestScreen');
        ctx.expect(true).toBe(true);
      },
    },
    {
      // #411: a renderer's own `omega.analytics.event(...)` used to no-op
      // silently — the embedded client had no way to deliver. It now forwards
      // over this bridge, and main's sender is the one that fires it.
      name: 'a renderer-originated omega.analytics event reaches main\'s sender exactly once, with main\'s identity',
      run: async (ctx) => {
        const read = () => window.desktop.ipc.invoke('desktop:__test:read-analytics-sends');
        const baseline = (await read()).length;

        window.__omegaTestClientAnalytics.event('vert_click', { vert_id: 'pin-411' });

        // The forward is fire-and-forget IPC — poll until main records it.
        let sends = [];
        const t0 = Date.now();
        while (sends.length <= baseline) {
          // The client's own state says WHY when this fails: an unbridged one
          // carries a client id of its own — the identity fork (#411).
          if (Date.now() - t0 > 3000) throw new Error(`timed out waiting for main to record the forwarded event, client state ${JSON.stringify(window.__omegaTestClientAnalytics.state())}`);
          await new Promise((r) => setTimeout(r, 25));
          sends = await read();
        }

        const fired = sends.slice(baseline).filter((s) => s.name === 'vert_click');
        ctx.expect(fired.length).toBe(1);
        ctx.expect(fired[0].provider).toBe('google');
        ctx.expect(fired[0].payload.vert_id).toBe('pin-411');

        // Main's identity, never a renderer-minted one — asserted on the WIRE
        // payload: the `client_id` GA would receive is the one main reports
        // over its own status channel, and the session id is the one main
        // minted for this launch, with real engagement time.
        const status = await window.desktop.analytics.getStatus();
        const snapshot = await window.desktop.context.get();
        ctx.expect(fired[0].body.client_id).toBe(status.clientId);
        ctx.expect(fired[0].body.events[0].name).toBe('vert_click');
        ctx.expect(fired[0].body.events[0].params.session_id).toBe(snapshot.session.id);
        ctx.expect(fired[0].body.events[0].params.engagement_time_msec > 0).toBe(true);
      },
    },
    {
      name: 'the bridged renderer holds no sender of its own — no secret, no second device id',
      run: (ctx) => {
        const state = window.__omegaTestClientAnalytics.state();
        ctx.expect(state.initialized).toBe(true);
        ctx.expect(state.bridged).toBe(true);
        ctx.expect(state.secret).toBe(null);
        ctx.expect(state.clientId).toBe(null);
      },
    },
    {
      name: 'window.desktop.context.get returns the context snapshot',
      run: async (ctx) => {
        const snap = await window.desktop.context.get();
        ctx.expect(snap).toBeDefined();
        ctx.expect(snap.session).toBeDefined();
        ctx.expect(snap.client).toBeDefined();
        ctx.expect(typeof snap.session.id).toBe('string');
        ctx.expect(snap.session.id.length).toBe(36);   // uuid
        ctx.expect(typeof snap.client.platform).toBe('string');
      },
    },
    {
      name: 'window.desktop.usage.get returns the usage snapshot',
      run: async (ctx) => {
        const snap = await window.desktop.usage.get();
        ctx.expect(snap).toBeDefined();
        ctx.expect(typeof snap.opens).toBe('number');
        ctx.expect(typeof snap.hoursTotal).toBe('number');
        ctx.expect(typeof snap.hoursThisSession).toBe('number');
      },
    },
    {
      name: 'window.desktop.remoteConfig.get / refreshNow / onUpdate are functions',
      run: (ctx) => {
        ctx.expect(typeof window.desktop.remoteConfig.get).toBe('function');
        ctx.expect(typeof window.desktop.remoteConfig.refreshNow).toBe('function');
        ctx.expect(typeof window.desktop.remoteConfig.onUpdate).toBe('function');
      },
    },
    {
      name: 'window.desktop.remoteConfig.onUpdate returns an unsub function',
      run: (ctx) => {
        const off = window.desktop.remoteConfig.onUpdate(() => {});
        ctx.expect(typeof off).toBe('function');
        off();
      },
    },
  ],
});
