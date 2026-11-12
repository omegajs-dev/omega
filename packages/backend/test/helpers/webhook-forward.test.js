/**
 * Test: marketing/webhook/forward route — unit-style coverage
 *
 * Why this exists as a unit test (not an emulator test):
 *
 * The forwarder is gated on omega.isParent(): the brand names no company, or
 * names itself as one (`company: { id: 'self' }`, #677). In real test runs
 * we run AGAINST a child brand's @omega.js/backend (Somiibo, etc.), so the route is invisible
 * (404). To verify the fan-out logic, we exercise the route handler directly
 * against a mocked admin SDK + mocked fetch, no HTTP needed.
 *
 * What's covered:
 *   - Gate: returns 404 if omega.isParent() returns false (the brand belongs to a company)
 *   - Auth: returns 401 if key missing/wrong
 *   - Provider validation: returns 400 if missing
 *   - Brand iteration: reads brands collection, derives API URLs
 *   - URL derivation: brand.url 'https://somiibo.com' → 'https://api.somiibo.com/omega/marketing/webhook?provider=X&key=Y'
 *   - Body forwarding: raw body POSTed to every child unchanged
 *   - Failure isolation: one failed child doesn't break the others
 *   - Brands without brand.url skipped silently
 */

const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const route = loadHandler(require.resolve('../../dist/omega/routes/marketing/webhook/forward/post.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// The stand-in sits at globalThis.fetch, the network boundary wonderful-fetch
// calls on every request. Each call is recorded as it reached the wire: the
// URL less wonderful-fetch's `cb` cache breaker, and the JSON body.
const realFetch = globalThis.fetch;
const fetchCalls = [];
let fetchMockBehavior = () => ({ received: true });

async function standInFetch(url, init) {
  const target = new URL(url);

  target.searchParams.delete('cb');

  const call = { url: target.toString(), body: JSON.parse(init.body) };

  fetchCalls.push(call);

  return new Response(JSON.stringify(fetchMockBehavior(call.url)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Test scaffolding ---

function makeFirestoreMock(brandDocs) {
  return {
    collection: (name) => {
      if (name !== 'brands') {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return {
        get: async () => ({
          forEach: (cb) => {
            for (const { id, data } of brandDocs) {
              cb({ id, data: () => data });
            }
          },
        }),
      };
    },
  };
}

function makeAdminMock(brandDocs) {
  const fs = makeFirestoreMock(brandDocs);
  return { firestore: () => fs };
}

function makeAssistant({ query, body }) {
  const responses = [];
  return {
    request: { query: query || {} },
    req: { body: body !== undefined ? body : [] },
    log: () => {},
    error: () => {},
    respond: (data, opts) => {
      responses.push({ data, code: opts?.code || 200 });
      return { data, code: opts?.code || 200 };
    },
    _responses: responses,
  };
}

function makeOmega(configOverrides) {
  const config = {
    company: { id: 'self', url: 'https://itwcreativeworks.com', images: {} },
    ...configOverrides,
  };
  return {
    config,
    // The real gate's rule (#677): no company, or this brand IS the company
    isParent: () => !config.company?.id || config.company.id === 'self',
  };
}

function resetFetchMock() {
  fetchCalls.length = 0;
  fetchMockBehavior = () => ({ received: true });
}

// Saves and restores process.env so tests don't leak side effects
function withEnv(envOverrides, fn) {
  const saved = {};
  for (const k of Object.keys(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = envOverrides[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(envOverrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

module.exports = defineCases({
  description: 'webhook/forward unit tests (mocked admin + fetch)',
  type: 'group',

  setup() {
    globalThis.fetch = standInFetch;
  },

  cleanup() {
    globalThis.fetch = realFetch;
  },

  tests: [
    // ─── Gating ───

    {
      name: 'returns-404-when-the-brand-belongs-to-a-company',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' } });
          const omega = makeOmega({ company: { id: 'itw-creative-works', url: 'https://itwcreativeworks.com', images: {} } }); // belongs to a company
          const admin = makeAdminMock([]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(ctx._responses.length, 'should respond once').toBe(1);
          expect(ctx._responses[0].code, 'should return 404').toBe(404);
          expect(fetchCalls.length, 'should NOT call fetch when gated').toBe(0);
        });
      },
    },

    {
      name: 'allows-route-when-the-brand-is-the-company',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' } });
          const omega = makeOmega({ company: { id: 'self', url: 'https://itwcreativeworks.com', images: {} } });
          const admin = makeAdminMock([]); // No brands — but route still reaches the fan-out step

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(ctx._responses[0].code, "should return 200 when company.id is 'self'").toBe(200);
          expect(ctx._responses[0].data.forwarded, 'no brands means 0 forwarded').toBe(0);
        });
      },
    },

    // ─── Auth ───

    {
      name: 'rejects-missing-provider',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { key: 'test-key' } }); // no provider
          const omega = makeOmega();
          const admin = makeAdminMock([]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(ctx._responses[0].code, 'missing provider → 400').toBe(400);
        });
      },
    },

    {
      name: 'rejects-missing-key',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid' } }); // no key
          const omega = makeOmega();
          const admin = makeAdminMock([]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(ctx._responses[0].code, 'missing key → 401').toBe(401);
        });
      },
    },

    {
      name: 'rejects-wrong-key',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'real-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'wrong-key' } });
          const omega = makeOmega();
          const admin = makeAdminMock([]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(ctx._responses[0].code, 'wrong key → 401').toBe(401);
        });
      },
    },

    // ─── Fan-out logic ───

    {
      name: 'derives-api-url-from-brand-url-and-fans-out',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const body = [{ sg_event_id: 'evt1', event: 'group_unsubscribe', email: 't@example.com' }];
          const ctx = makeAssistant({
            query: { provider: 'sendgrid', key: 'test-key' },
            body,
          });
          const omega = makeOmega();
          const admin = makeAdminMock([
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
            { id: 'chatsy', data: { brand: { id: 'chatsy', url: 'https://chatsy.com' } } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length, 'should fan out to both brands').toBe(2);
          expect(fetchCalls[0].url, 'first child URL derived correctly').toBe('https://api.somiibo.com/omega/marketing/webhook?provider=sendgrid&key=test-key');
          expect(fetchCalls[1].url, 'second child URL derived correctly').toBe('https://api.chatsy.com/omega/marketing/webhook?provider=sendgrid&key=test-key');
          expect(fetchCalls[0].body, 'raw body forwarded unchanged').toEqual(body);
          expect(ctx._responses[0].data.succeeded, '2 children succeeded').toBe(2);
        });
      },
    },

    {
      name: 'forwards-raw-body-unchanged-for-beehiiv',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const body = {
            id: 'beehiiv-evt1',
            event: 'subscription.unsubscribed',
            email: 'x@example.com',
            publication_id: 'pub_abc',
          };
          const ctx = makeAssistant({
            query: { provider: 'beehiiv', key: 'test-key' },
            body,
          });
          const omega = makeOmega();
          const admin = makeAdminMock([
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length).toBe(1);
          expect(fetchCalls[0].url.includes('provider=beehiiv'), 'provider param preserved').toBeTruthy();
          expect(fetchCalls[0].body, 'raw Beehiiv body forwarded unchanged').toEqual(body);
        });
      },
    },

    {
      name: 'skips-brands-without-brand-url',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' }, body: [] });
          const omega = makeOmega();
          const admin = makeAdminMock([
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
            { id: 'partial-brand', data: { brand: { id: 'partial-brand' /* no url */ } } },
            { id: 'no-brand-key', data: { /* no brand at all */ } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length, 'only the brand with a URL should be fanned to').toBe(1);
          expect(fetchCalls[0].url.includes('api.somiibo.com'), 'somiibo was the one called').toBeTruthy();
        });
      },
    },

    {
      name: 'failure-isolation-one-bad-child-does-not-break-others',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          fetchMockBehavior = (url) => {
            if (url.includes('chatsy.com')) {
              throw new Error('connection refused');
            }
            return { received: true };
          };

          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' }, body: [] });
          const omega = makeOmega();
          const admin = makeAdminMock([
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
            { id: 'chatsy', data: { brand: { id: 'chatsy', url: 'https://chatsy.com' } } },
            { id: 'dashqr', data: { brand: { id: 'dashqr', url: 'https://dashqr.com' } } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length, 'all 3 children attempted').toBe(3);
          const response = ctx._responses[0];
          expect(response.code, 'response is still 200 — provider should not retry parent').toBe(200);
          expect(response.data.succeeded, '2 children succeeded').toBe(2);
          expect(response.data.failed, '1 child failed').toBe(1);
          expect(response.data.failures, 'failures array populated').toBeTruthy();
          expect(response.data.failures[0].brandId, 'failure entry names the brand').toBe('chatsy');
        });
      },
    },

    {
      name: 'invalid-brand-url-counted-as-failure-not-thrown',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' }, body: [] });
          const omega = makeOmega();
          const admin = makeAdminMock([
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
            { id: 'broken', data: { brand: { id: 'broken', url: 'not-a-valid-url' } } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          const response = ctx._responses[0];
          expect(response.code, 'route still returns 200').toBe(200);
          expect(response.data.succeeded, 'somiibo succeeded').toBe(1);
          expect(response.data.failed, 'broken brand counted as failed').toBe(1);
          expect(fetchCalls.length, 'only the valid URL was actually fetched').toBe(1);
        });
      },
    },

    {
      name: 'self-is-included-in-fanout',
      async run({ expect }) {
        // The parent's own brand IS expected to be in the brands collection.
        // It should be fanned to via HTTP like any other brand, so its own
        // @omega.js/backend processes its own user updates the same way as siblings.
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' }, body: [] });
          const omega = makeOmega({ brand: { id: 'itw-creative-works' } });
          const admin = makeAdminMock([
            { id: 'itw-creative-works', data: { brand: { id: 'itw-creative-works', url: 'https://itwcreativeworks.com' } } },
            { id: 'somiibo', data: { brand: { id: 'somiibo', url: 'https://somiibo.com' } } },
          ]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length, 'parent fans out to ALL brands including itself').toBe(2);
          expect(fetchCalls.some(c => c.url.includes('api.itwcreativeworks.com')), 'self IS in the fan-out target list').toBeTruthy();
        });
      },
    },

    {
      name: 'zero-brands-handled-gracefully',
      async run({ expect }) {
        await withEnv({ OMEGA_WEBHOOK_KEY: 'test-key' }, async () => {
          resetFetchMock();
          const ctx = makeAssistant({ query: { provider: 'sendgrid', key: 'test-key' }, body: [] });
          const omega = makeOmega();
          const admin = makeAdminMock([]);

          await route({ ctx, omega: { ...omega, firebase: { admin } } });

          expect(fetchCalls.length).toBe(0);
          expect(ctx._responses[0].code, 'still 200 with no brands').toBe(200);
          expect(ctx._responses[0].data.forwarded).toBe(0);
        });
      },
    },
  ],
});
