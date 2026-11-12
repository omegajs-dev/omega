/**
 * Usage.consume() — the counted-feature gate
 * ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
 *
 * The promises, all of them things a caller or a customer can be misled by:
 *  - ONE call checks, counts and writes, and a refusal is a 429 that says WHICH
 *    counter hit — the day ("try again tomorrow") or the month ("upgrade");
 *  - the MONTH cap always holds, so a spent month is never sold as "tomorrow";
 *  - the day's share is the month limit spread over the days of THIS month, so
 *    a quota cannot be burned on day one — and `pace: false` opts a feature out;
 *  - a per-user override wins over the plan's number, and the day share derives
 *    from the EFFECTIVE number;
 *  - a write carries the touched feature's counters and nothing else, so two
 *    features counted at once cannot overwrite each other;
 *  - mirrors come from the CATALOG and the account's owned docs, never a
 *    call-site API;
 *  - init is LAZY: building the counter reads nothing, and an unused counter
 *    never resolves an account;
 *  - a key is EXPLICIT: forKey() is a separate counter, so a signed-in user's
 *    own counters can never be moved into the anonymous store;
 *  - a feature the catalog does not define, or a perk, is a 500 — a limit
 *    nothing enforces must never look like one that does.
 *
 * Plain-node unit test (no emulator, no network): the gate's decision, its
 * arithmetic and its write COMPOSITION are pure given a ctx and a config, so
 * the only thing standing in for I/O is `write()` — recorded rather than sent,
 * which is what makes the payload assertable at all.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');

const Usage = require('../../dist/omega/services/usage.js');
const { User } = require('../../dist/omega/helpers/account.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// A 31-day month, so ceil(100 / 31) = 4 is a number the assertions can name.
const IN_MARCH = new Date('2026-03-10T12:00:00.000Z');

const CATALOG = {
  saves: {
    name: 'Saves',
    icon: 'feather',
    definition: 'Notes you can save.',
    usage: { mirror: ['teams'] },
  },
  exports: { name: 'Exports', usage: { pace: false } },
  support: { name: 'Priority support', icon: 'headset' },
};

const PRODUCTS = [
  { id: 'basic', name: 'Basic', features: { saves: 100, exports: 20 } },
  { id: 'premium', name: 'Premium', features: { saves: -1, exports: 500, support: true } },
];

// `options.docs` is the Firestore the counter can read, by path; every path
// asked for lands in `state.reads`, and a path not in the map does not exist.
function makeOmega(options, state) {
  options = options || {};

  const docs = options.docs || {};
  const firestore = {
    doc: (path) => ({
      get: async () => {
        state.reads.push(path);

        const data = docs[path];

        return { id: path.split('/').pop(), exists: data !== undefined, data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))) };
      },
    }),
  };

  return {
    config: {
      features: options.catalog === undefined ? CATALOG : options.catalog,
      payment: { products: PRODUCTS },
    },
    storage: () => ({ get: () => ({ value: () => ({}) }), set: () => ({ write: () => {} }) }),
    firebase: { admin: { firestore: () => firestore } },
  };
}

// A ctx that answers exactly what the counter asks it: who the caller is (a
// User, as authenticate() resolves one), and where to put a log line. `report`
// returns the decorated Error ctx.report does.
function makeCtx(account, options) {
  options = options || {};

  const state = { authenticated: 0, reads: [], lines: [] };
  const record = (...args) => state.lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

  return {
    omega: makeOmega(options, state),
    state: state,
    log: record,
    warn: record,
    error: record,
    isDevelopment: () => true,
    isTesting: () => true,
    report: (e, opts) => {
      const error = e instanceof Error ? e : new Error(e);
      error.code = (opts || {}).code || 500;
      record(`report(${error.code}): ${error.message}`);
      return error;
    },
    authenticate: async () => {
      state.authenticated++;
      return new User(JSON.parse(JSON.stringify(account || {})));
    },
    request: { data: {}, geolocation: { ip: options.ip || '203.0.113.7' } },
  };
}

// A counter whose writes are RECORDED instead of sent — the one I/O boundary.
function attach(account, options) {
  options = options || {};

  const ctx = makeCtx(account, options);
  const usage = new Usage(ctx).configure({ log: false, today: options.today || IN_MARCH });

  return { usage, ctx, writes: recordWrites(usage) };
}

// The recorder `attach` installs, for a counter `forUser` hands back: `uid` is
// the account whose document `write()` targets.
function recordWrites(usage) {
  const writes = [];

  usage.write = async function (feature) {
    writes.push({ feature: feature, uid: this.user.auth.uid, paths: this.mirrorPaths(feature), patch: this.countersPatch(feature) });
  };

  return writes;
}

function account(overrides) {
  return {
    auth: { uid: 'user-647', email: 'user@test.dev' },
    api: { clientId: 'client-647', privateKey: 'sk_test_fake' },
    subscription: { product: { id: 'basic' }, status: 'active' },
    usage: {},
    ...overrides,
  };
}

// Another account, as its document sits in Firestore: the one a forUser()
// counter is bound to while the request's caller is someone else.
const SELLER_UID = 'seller-uid';

function seller(overrides) {
  return {
    auth: { uid: SELLER_UID, email: 'seller@test.dev' },
    api: { clientId: 'client-seller', privateKey: 'sk_test_seller' },
    subscription: { product: { id: 'basic' }, status: 'active' },
    usage: {},
    ...overrides,
  };
}

module.exports = defineCases({
  description: 'Usage.consume() — the counted-feature gate',
  type: 'group',

  tests: [
    {
      name: 'building the counter reads nothing — the account resolves on the FIRST consume',

      async run() {
        const { usage, ctx } = attach(account());

        expect(ctx.state.authenticated, 'building the counter must cost no read').toBe(0);
        expect(usage.resolved).toBe(false);

        await usage.consume('saves');
        await usage.consume('saves');

        expect(ctx.state.authenticated, 'the account resolves once, on first use').toBe(1);
      },
    },

    {
      name: 'the counter counts on the account authenticate() resolved, read once',

      async run() {
        const { usage, ctx } = attach(account({ usage: { saves: { monthly: 7, daily: 0 } } }));

        const state = await usage.read('saves');

        await usage.read('saves');

        expect(ctx.state.authenticated, 'no second token verification, no second user-doc read').toBe(1);
        expect(state.used, 'and the counter reads the account authenticate() resolved').toBe(7);
      },
    },

    {
      name: 'a signed-OUT caller is refused loudly, never routed to the anonymous store',

      async run() {
        // What ctx.authenticate() resolves for a caller with no credential: a
        // full account SHAPE whose uid is null. Writing that would land on
        // `users/null`, one document every anonymous caller on earth shares.
        const { usage } = attach(null);

        const consumed = await usage.consume('saves').catch((e) => e);
        const read = await usage.read('saves').catch((e) => e);

        for (const error of [consumed, read]) {
          expect(error instanceof Error, 'a signed-out caller must be refused').toBeTruthy();
          expect(error.message, error.message).toMatch(/no signed-in account to count against/i);
          expect(error.message, 'and pointed at the explicit anonymous counter').toMatch(/usage\.forKey/);
        }
      },
    },

    {
      name: 'consume counts, writes, and returns what is left of both counters',

      async run() {
        const { usage, writes } = attach(account({ usage: { saves: { monthly: 30, daily: 1, total: 500 } } }));

        const left = await usage.consume('saves');

        expect(left, JSON.stringify(left)).toEqual({ used: 31, left: 69, day: { used: 2, left: 2 } });
        expect(writes.length, 'one write per consume').toBe(1);
        expect(writes[0].patch.usage.saves.total, 'total never resets and still moved').toBe(501);
      },
    },

    {
      name: 'a write carries the touched feature ONLY — never the whole usage object',

      async run() {
        const { usage, writes } = attach(account({
          usage: { saves: { monthly: 1, daily: 1 }, exports: { monthly: 9, daily: 9 } },
        }));

        await usage.consume('saves');

        expect(Object.keys(writes[0].patch.usage), JSON.stringify(writes[0].patch)).toEqual(['saves']);
      },
    },

    {
      name: 'the DAY share refuses first when the month still has room',

      async run() {
        // ceil(100/31) = 4 a day; 4 already spent today, 4 spent this month
        const { usage } = attach(account({ usage: { saves: { monthly: 4, daily: 4 } } }));

        const error = await usage.consume('saves').catch((e) => e);

        expect(error instanceof Error, 'over the day share must refuse').toBeTruthy();
        expect(error.code).toBe(429);
        expect(error.message, error.message).toMatch(/try again tomorrow/i);
      },
    },

    {
      name: 'a spent MONTH is never sold as "tomorrow" — the month is checked first',

      async run() {
        // The month is gone, but today's counter is untouched
        const { usage } = attach(account({ usage: { saves: { monthly: 100, daily: 0 } } }));

        const error = await usage.consume('saves').catch((e) => e);

        expect(error.code).toBe(429);
        expect(error.message, error.message).toMatch(/upgrade/i);
        expect(error.message, error.message).not.toMatch(/tomorrow/i);
      },
    },

    {
      name: 'a refusal counts nothing and writes nothing',

      async run() {
        const { usage, writes } = attach(account({ usage: { saves: { monthly: 100, daily: 0 } } }));

        await usage.consume('saves').catch(() => {});

        expect(writes, 'a refused call must leave the counters alone').toEqual([]);
        expect(usage.user.usage.saves.monthly).toBe(100);
      },
    },

    {
      name: 'an amount larger than what is left refuses before it counts',

      async run() {
        const { usage } = attach(account({ usage: { saves: { monthly: 98, daily: 0 } } }));

        const error = await usage.consume('saves', 3).catch((e) => e);

        expect(error.code, 'consuming 3 with 2 left must refuse, not overshoot').toBe(429);
      },
    },

    {
      name: 'pace: false has no day cap — the month is the only gate',

      async run() {
        const { usage } = attach(account({ usage: { exports: { monthly: 0, daily: 19 } } }));

        const left = await usage.consume('exports');

        expect(left.day, JSON.stringify(left)).toEqual({ used: 20, left: -1 });
      },
    },

    {
      name: 'a per-user override wins over the plan, day share and all',

      async run() {
        const { usage } = attach(account({
          usage: { saves: { monthly: 100, daily: 0 }, overrides: { saves: 300 } },
        }));

        const left = await usage.consume('saves');

        expect(left.used, 'the plan said 100 — the override says otherwise').toBe(101);
        expect(left.left).toBe(199);
        expect(left.day.left, 'ceil(300/31) = 10, one just spent').toBe(9);
      },
    },

    {
      name: 'unlimited never refuses and still counts',

      async run() {
        const { usage } = attach(account({
          subscription: { product: { id: 'premium' }, status: 'active' },
          usage: { saves: { monthly: 99999, daily: 5000 } },
        }));

        const left = await usage.consume('saves');

        expect(left.left, 'unlimited stays unlimited').toBe(-1);
        expect(left.used, 'and the record stays honest').toBe(100000);
      },
    },

    {
      name: 'a feature the plan never names is a limit of zero — every call refuses',

      async run() {
        // `support` is a perk on premium and absent from basic; `saves` here is
        // the counted case: a plan that names no number promises nothing
        const { usage } = attach(account({
          subscription: { product: { id: 'nonexistent-tier' }, status: 'active' },
          usage: {},
        }));

        // An unknown product id falls back to `basic`, which does name saves —
        // so pin the case on a plan that genuinely omits the number
        usage.getProduct = () => ({ id: 'hollow', features: {} });

        const error = await usage.consume('saves').catch((e) => e);

        expect(error.code, error.message).toBe(429);
        expect(error.message, error.message).toMatch(/all 0 of your Saves/i);
      },
    },

    {
      name: 'mirrors come from the CATALOG and the account owns the documents',

      async run() {
        const { usage, writes } = attach(account({ owns: { teams: ['team-a', 'team-b'] } }));

        await usage.consume('saves');

        expect(writes[0].paths, JSON.stringify(writes[0].paths)).toEqual(['teams/team-a', 'teams/team-b']);
      },
    },

    {
      name: 'a feature the catalog does not mirror writes nowhere else',

      async run() {
        const { usage, writes } = attach(account({ owns: { teams: ['team-a'] } }));

        await usage.consume('exports');

        expect(writes[0].paths, JSON.stringify(writes[0].paths)).toEqual([]);
      },
    },

    {
      name: 'read() reports without counting',

      async run() {
        const { usage, writes } = attach(account({ usage: { saves: { monthly: 30, daily: 1 } } }));

        const state = await usage.read('saves');

        expect(state.used).toBe(30);
        expect(state.left).toBe(70);
        expect(writes, 'read must never write').toEqual([]);
      },
    },

    {
      name: 'forKey is a SEPARATE counter — a key never moves the signed-in user',

      async run() {
        const { usage } = attach(account({ usage: { saves: { monthly: 30, daily: 1 } } }));

        const keyed = usage.forKey('203.0.113.7');

        expect(keyed, 'forKey returns its own counter').not.toBe(usage);
        expect(keyed.key).toBe('203.0.113.7');
        expect(usage.key, 'the original counter is untouched').toBe(null);
        expect(keyed.mirrorPaths('saves'), 'an anonymous key owns nothing to mirror to').toEqual([]);
      },
    },

    {
      name: 'a feature the catalog does not define is a 500, not a silent gate',

      async run() {
        const { usage } = attach(account());

        const error = await usage.consume('teleport').catch((e) => e);

        expect(error.code, error.message).toBe(500);
        expect(error.message, error.message).toMatch(/features catalog/i);
      },
    },

    {
      name: 'a PERK cannot be consumed — it carries no meter',

      async run() {
        const { usage } = attach(account());

        const error = await usage.consume('support').catch((e) => e);

        expect(error.code, error.message).toBe(500);
        expect(error.message, error.message).toMatch(/perk/i);
      },
    },

    {
      name: 'an EXPLICIT limit gates a counter the catalog never defines',

      async run() {
        // The signup-by-IP shape: a security control with its own config key
        const { usage, writes } = attach(account({ usage: { signups: { monthly: 1, daily: 1 } } }), { catalog: {} });

        const left = await usage.consume('signups', 1, { limit: 2 });

        expect(left.used).toBe(2);
        expect(left.left).toBe(0);
        expect(writes.length).toBe(1);

        const error = await usage.consume('signups', 1, { limit: 2 }).catch((e) => e);

        expect(error.code, error.message).toBe(429);
      },
    },

    {
      name: 'a whitelisted API key never gets refused, and still counts',

      async run() {
        const { usage } = attach(account({ usage: { saves: { monthly: 100, daily: 100 } } }));

        usage.addWhitelistKeys('sk_test_fake');

        const left = await usage.consume('saves');

        expect(left.used, 'the record stays honest even when the gate stands down').toBe(101);
      },
    },

    {
      name: 'limits() reports every counted feature, overrides applied; perks are not limits',

      async run() {
        const { usage } = attach(account({ usage: { overrides: { saves: 250 } } }));

        expect(usage.limits(), 'nothing is known before the counter resolves').toEqual({});

        await usage.read('saves');

        expect(usage.limits(), JSON.stringify(usage.limits())).toEqual({ saves: 250, exports: 20 });
      },
    },

    {
      name: 'forUser refuses a missing or non-string uid at the call, before any I/O',

      async run() {
        const { usage, ctx } = attach(account());

        for (const uid of [undefined, null, 42, { uid: SELLER_UID }]) {
          let thrown = null;

          try {
            usage.forUser(uid);
          } catch (e) {
            thrown = e;
          }

          expect(thrown instanceof Error, `forUser(${JSON.stringify(uid)}) must throw synchronously`).toBeTruthy();
        }

        expect(usage.forUser(SELLER_UID), 'a string uid builds a counter').toBeTruthy();
        expect(ctx.state.reads, 'building a counter reads nothing').toEqual([]);
      },
    },

    {
      name: 'forUser(uid).read() reports the OTHER account\'s plan and counters, not the caller\'s',

      async run() {
        // The caller is on basic (exports 20) with 3 used; the seller is on
        // premium (exports 500) with 12 used
        const { usage, ctx } = attach(account({ usage: { exports: { monthly: 3, daily: 3 } } }), {
          docs: { [`users/${SELLER_UID}`]: seller({ subscription: { product: { id: 'premium' }, status: 'active' }, usage: { exports: { monthly: 12, daily: 2 } } }) },
        });

        const state = await usage.forUser(SELLER_UID).read('exports');

        expect(state.limit, JSON.stringify(state)).toBe(500);
        expect(state.used, JSON.stringify(state)).toBe(12);
        expect(state.left, JSON.stringify(state)).toBe(488);
        expect(ctx.state.reads, 'the account is read from its own document').toEqual([`users/${SELLER_UID}`]);
      },
    },

    {
      name: 'forUser(uid).consume() writes the other account and its mirrors, and never the caller',

      async run() {
        const { usage, writes } = attach(account({ owns: { teams: ['team-caller'] } }), {
          docs: { [`users/${SELLER_UID}`]: seller({ owns: { teams: ['team-seller'] }, usage: { saves: { monthly: 3, daily: 0 } } }) },
        });

        const other = usage.forUser(SELLER_UID);
        const otherWrites = recordWrites(other);

        const left = await other.consume('saves');

        expect(left.used, JSON.stringify(left)).toBe(4);
        expect(otherWrites.length, 'one write per consume').toBe(1);
        expect(otherWrites[0].uid, 'the write targets the other account\'s document').toBe(SELLER_UID);
        expect(otherWrites[0].paths, JSON.stringify(otherWrites[0].paths)).toEqual(['teams/team-seller']);
        expect(otherWrites[0].patch.usage.saves.monthly).toBe(4);
        expect(writes, 'the caller\'s own counter must write nothing').toEqual([]);
      },
    },

    {
      name: 'forUser(uid).consume() refuses past the other account\'s month, however rich the caller',

      async run() {
        // The caller's premium saves are unlimited; the seller's basic month is spent
        const { usage } = attach(account({ subscription: { product: { id: 'premium' }, status: 'active' } }), {
          docs: { [`users/${SELLER_UID}`]: seller({ usage: { saves: { monthly: 100, daily: 0 } } }) },
        });

        const other = usage.forUser(SELLER_UID);
        const otherWrites = recordWrites(other);

        const error = await other.consume('saves').catch((e) => e);

        expect(error instanceof Error, 'over the other account\'s month must refuse').toBeTruthy();
        expect(error.code, error.message).toBe(429);
        expect(otherWrites, 'a refusal writes nothing').toEqual([]);
      },
    },

    {
      name: 'a whitelisted caller key buys no free uses on another account',

      async run() {
        const { usage } = attach(account(), {
          docs: { [`users/${SELLER_UID}`]: seller({ usage: { saves: { monthly: 100, daily: 0 } } }) },
        });

        usage.addWhitelistKeys('sk_test_fake');

        const other = usage.forUser(SELLER_UID);

        recordWrites(other);

        const error = await other.consume('saves').catch((e) => e);

        expect(error instanceof Error, 'the caller\'s whitelist must not stand the other account\'s gate down').toBeTruthy();
        expect(error.code, error.message).toBe(429);
      },
    },

    {
      name: 'a uid with no account document is a 404 naming the uid, and nothing is written',

      async run() {
        const { usage, writes } = attach(account(), { docs: {} });

        const other = usage.forUser('ghost-uid');
        const otherWrites = recordWrites(other);

        const resolved = await Promise.resolve().then(() => other.resolve()).catch((e) => e);

        expect(resolved instanceof Error, 'resolve() must refuse a missing account').toBeTruthy();
        expect(resolved.code, resolved.message).toBe(404);
        expect(resolved.message, resolved.message).toContain('ghost-uid');

        const consumed = await other.consume('saves').catch((e) => e);

        expect(consumed instanceof Error, 'consume() must refuse a missing account').toBeTruthy();
        expect(consumed.code, consumed.message).toBe(404);
        expect(otherWrites, 'a missing account is never created').toEqual([]);
        expect(writes, 'and the caller is never charged instead').toEqual([]);
      },
    },

    {
      name: 'a signed-OUT caller can count against another account: authenticate() is never called',

      async run() {
        const { usage, ctx } = attach(null, {
          docs: { [`users/${SELLER_UID}`]: seller({ usage: { saves: { monthly: 30, daily: 1 } } }) },
        });

        const other = usage.forUser(SELLER_UID);

        recordWrites(other);

        const state = await other.read('saves');
        const left = await other.consume('saves');

        expect(state.used, JSON.stringify(state)).toBe(30);
        expect(left.used, JSON.stringify(left)).toBe(31);
        expect(ctx.state.authenticated, 'the caller\'s identity is never asked for').toBe(0);
      },
    },

    {
      name: 'an account document with no auth.uid still counts under users/{uid}',

      async run() {
        const { usage } = attach(account(), {
          docs: { [`users/${SELLER_UID}`]: seller({ auth: {}, usage: { saves: { monthly: 3, daily: 0 } } }) },
        });

        const other = usage.forUser(SELLER_UID);
        const otherWrites = recordWrites(other);

        const left = await other.consume('saves');

        expect(left.used, JSON.stringify(left)).toBe(4);
        expect(otherWrites.length, 'one write per consume').toBe(1);
        expect(otherWrites[0].uid, 'the uid the counter was bound to fills the document\'s missing one').toBe(SELLER_UID);
      },
    },
  ],
});
