// Main-layer tests for lib/protocol.js — single-instance lock + custom URL scheme.

const defineCases = require('@omega.js/devkit/test/define-cases');

module.exports = defineCases({
  type: 'suite',
  layer: 'main',
  description: 'protocol (main)',
  tests: [
    {
      name: 'protocol module is loaded on the omega instance',
      run: (ctx) => {
        ctx.expect(ctx.omega.protocol).toBeDefined();
        ctx.expect(ctx.omega.protocol._initialized).toBe(true);
      },
    },
    {
      name: 'hasSingleInstanceLock returns true (test process owns the lock)',
      run: (ctx) => {
        ctx.expect(ctx.omega.protocol.hasSingleInstanceLock()).toBe(true);
      },
    },
    {
      name: 'getSchemes returns brand.id when configured',
      run: (ctx) => {
        const schemes = ctx.omega.protocol.getSchemes();
        ctx.expect(Array.isArray(schemes)).toBe(true);
        const brandId = ctx.omega.config?.brand?.id;
        if (brandId) {
          ctx.expect(schemes).toContain(brandId);
        }
      },
    },
    {
      name: 'getSchemes returns a fresh copy each call (mutation safe)',
      run: (ctx) => {
        const a = ctx.omega.protocol.getSchemes();
        const b = ctx.omega.protocol.getSchemes();
        ctx.expect(a).not.toBe(b);   // different array instances
        ctx.expect(a).toEqual(b);    // same contents
      },
    },
    {
      name: 'isOurScheme matches registered scheme',
      run: (ctx) => {
        const brandId = ctx.omega.config?.brand?.id;
        if (!brandId) return ctx.skip('no brand.id configured');
        ctx.expect(ctx.omega.protocol.isOurScheme(`${brandId}://auth/token?t=abc`)).toBe(true);
      },
    },
    {
      name: 'isOurScheme rejects unregistered schemes',
      run: (ctx) => {
        ctx.expect(ctx.omega.protocol.isOurScheme('https://example.com')).toBe(false);
        ctx.expect(ctx.omega.protocol.isOurScheme('imaginary-scheme://x')).toBe(false);
      },
    },
    {
      name: 'isOurScheme: non-string input returns false (no throw)',
      run: (ctx) => {
        ctx.expect(ctx.omega.protocol.isOurScheme(null)).toBe(false);
        ctx.expect(ctx.omega.protocol.isOurScheme(undefined)).toBe(false);
        ctx.expect(ctx.omega.protocol.isOurScheme(42)).toBe(false);
        ctx.expect(ctx.omega.protocol.isOurScheme({})).toBe(false);
      },
    },
    {
      name: 'initialize is idempotent — re-calling does not change schemes',
      run: async (ctx) => {
        const before = ctx.omega.protocol.getSchemes();
        await ctx.omega.protocol.initialize(ctx.omega);
        const after = ctx.omega.protocol.getSchemes();
        ctx.expect(after).toEqual(before);
      },
    },
    {
      name: 'protocol.singleInstance false: the lock is never requested and the process keeps running',
      run: (ctx) => {
        const { app } = require('electron');
        const protocol = ctx.omega.protocol;
        const origProtocolConfig = ctx.omega.config.protocol;
        const origRequest = app.requestSingleInstanceLock;
        let requests = 0;
        app.requestSingleInstanceLock = (...args) => { requests++; return origRequest.apply(app, args); };
        ctx.omega.config.protocol = { singleInstance: false };
        protocol._initialized = false;
        protocol._hasLock = false;
        try {
          protocol.initialize(ctx.omega);
          ctx.expect(requests).toBe(0);
          ctx.expect(protocol.hasSingleInstanceLock()).toBe(true);
        } finally {
          app.requestSingleInstanceLock = origRequest;
          if (origProtocolConfig !== undefined) ctx.omega.config.protocol = origProtocolConfig; else delete ctx.omega.config.protocol;
          protocol._hasLock = true;
          protocol._initialized = true;
        }
      },
    },
    {
      // The harness's parent process stands in for a holder still alive at launch
      name: 'a launch that finds a live holder and gets the lock logs the takeover',
      run: (ctx) => {
        const fs = require('fs');
        const path = require('path');
        const { app } = require('electron');
        const LoggerLite = require('../../../lib/logger-lite.js');
        const protocol = ctx.omega.protocol;
        const holderFile = path.join(app.getPath('userData'), 'single-instance-holder.pid');
        const line = `single-instance lock taken over from a holder that exited (pid ${process.ppid})`;
        const count = () => fs.readFileSync(LoggerLite.getLogFilePath(), 'utf8').split('\n').filter((l) => l.includes(line)).length;

        const before = count();
        fs.writeFileSync(holderFile, String(process.ppid));
        protocol._initialized = false;
        try {
          protocol.initialize(ctx.omega);
          ctx.expect(protocol.hasSingleInstanceLock()).toBe(true);
          ctx.expect(count()).toBe(before + 1);
          ctx.expect(fs.readFileSync(holderFile, 'utf8')).toBe(String(process.pid));
        } finally {
          fs.writeFileSync(holderFile, String(process.pid));
          protocol._hasLock = true;
          protocol._initialized = true;
        }
      },
    },
  ],
});
