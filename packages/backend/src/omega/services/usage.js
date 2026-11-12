/**
 * Usage — the counted-feature gate
 * ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
 *
 * ONE call does the whole job:
 *
 *   const left = await ctx.usage.consume('saves');   // throws a 429 over limit
 *
 * `consume` checks both counters, refuses with a 429 that names WHICH one hit,
 * else counts, writes, and returns what is left. There is no separate
 * "validate then increment then update" dance for a caller to get half right —
 * every hand-rolled gate in the framework's own routes existed because there
 * was one.
 *
 * What a feature IS lives in config, once: the top-level `features` catalog
 * defines it (name, icon, definition, and the `usage` block that meters it)
 * and each product names only its VALUE. @omega.js/account's features module
 * owns every derivation from those two halves plus the user's counters — the
 * effective limit (a per-user override wins over the plan's number), the day
 * share, what is left — so this gate and the browser's account page can never
 * speak different numbers.
 *
 * Two counters per counted feature per user, month and day. The day's share is
 * the month limit spread over the days of this month, so a quota cannot be
 * burned on day one; `usage: { pace: false }` on the catalog entry opts out.
 * Either counter full refuses, and the month cap always holds.
 *
 * Init is LAZY: `ctx.usage` is a counter that resolves the account
 * on the first consume/read, so a route that never counts pays nothing.
 *
 * Anonymous counting is EXPLICIT: `ctx.usage.forKey(ip)` returns a separate
 * keyed counter. Passing a key can never silently move a signed-in user's
 * counters into the anonymous store, which is what the old `options.key` did.
 *
 * Mirrors are declared in the CATALOG (`usage: { mirror: ['teams'] }`), never
 * at the call site: `consume` writes the touched feature's counters — that
 * feature's, not the whole usage object — to the user doc and to every doc the
 * account owns of each named kind (`owns.teams`), in one parallel write.
 */

const env = require('../libraries/env.js');
const { User } = require('../helpers/account.js');

// @omega.js/account is a private workspace package: in the monorepo the bare
// specifier resolves via the workspace link (and the prepare-package vendor
// hook rewrites it in dist/), but src/ ships in the tarball UNREWRITTEN — so
// fall back to the copy vendored into dist/, which sits at the same depth from
// both trees. The same two-step helpers/account.js makes.
let features;
try {
  features = require('@omega.js/account/features');
} catch (e) {
  features = require('../../../dist/vendor/account/features.js');
}

// Where an anonymous key's counters live when the brand stores them in
// Firestore (the default) — one document per key, wiped daily by the cron.
const ANONYMOUS_COLLECTION = 'usage';

/**
 * The counted-feature gate for one request (`ctx.usage`), a request service.
 */
class Usage {
  /**
   * A counter for one request. Synchronous and I/O-free: nothing is read
   * until the first consume/read, so a route that never counts pays nothing.
   * @param {object} ctx - the request Context (the caller, the log, the Omega instance)
   */
  constructor(ctx) {
    this.ctx = ctx;

    // The request defaults (see configure()); the framework's own admin key always bypasses
    this.options = {
      unauthenticatedMode: 'firestore',
      whitelistKeys: [env.get('OMEGA_ADMIN_KEY')],
      today: undefined,
      log: false,
    };

    // The anonymous key this counter counts against, or null for the signed-in
    // user. Set ONLY by forKey(), never inferred from a request.
    this.key = null;

    // The account uid this counter counts against, or null for the caller. Set
    // ONLY by forUser().
    this.uid = null;

    // The account (or the keyed counter document) the counters live on, resolved
    // on first use.
    this.user = null;
    this.resolved = false;

    this.storage = null;
  }

  /**
   * Override this counter's options (the constructor holds the request defaults).
   *
   * @param {object} [options] - Counter options
   * @param {string} [options.unauthenticatedMode] - 'firestore' (default) or 'local', for keyed counters
   * @param {string[]} [options.whitelistKeys] - More API keys that never get refused
   * @param {Date} [options.today] - The day being counted (tests)
   * @param {boolean} [options.log] - Log the counter lines
   * @returns {Usage} this
   */
  configure(options) {
    const self = this;

    options = options || {};

    Object.assign(self.options, options, {
      whitelistKeys: self.options.whitelistKeys.concat(options.whitelistKeys || []),
    });

    return self;
  }

  /**
   * A counter for an anonymous key (an IP, an installation id) — a SEPARATE
   * counter, so a signed-in user's own counters are never moved into the
   * anonymous store by a caller that only meant to rate-limit by address.
   *
   * Keyed counters are day-only in practice: the reset cron wipes the whole
   * anonymous store every day (docs/backend/usage-rate-limiting.md).
   *
   * @param {string} key - The key to count against
   * @returns {Usage} A new counter bound to that key
   */
  forKey(key) {
    const self = this;

    const keyed = self.fork();

    keyed.key = `${key || 'unknown'}`;

    return keyed;
  }

  /**
   * A counter for ANOTHER account, `users/{uid}`: its plan, its overrides, its
   * counters and its mirrors, inside a request made by someone else. The
   * caller's roles are not checked; the route decides who may charge whom.
   *
   * Synchronous and I/O-free like forKey(): the account is read on the first
   * consume/read, and a uid with no document throws a 404 there.
   *
   * @param {string} uid - The account to count against
   * @returns {Usage} A new counter bound to that account
   * @throws {Error} When uid is missing or not a string (a programmer error)
   */
  forUser(uid) {
    const self = this;

    if (typeof uid !== 'string' || !uid) {
      throw new Error(`usage: forUser(uid) needs a uid string, got ${JSON.stringify(uid)}`);
    }

    const bound = self.fork();

    bound.uid = uid;

    return bound;
  }

  /**
   * A new counter on the same request with this one's options copied, so a
   * whitelist added to one never reaches the other.
   * @returns {Usage} The new counter, bound to nothing yet
   */
  fork() {
    const self = this;

    const forked = new Usage(self.ctx);

    forked.options = { ...self.options, whitelistKeys: [...self.options.whitelistKeys] };

    return forked;
  }

  /**
   * The brand's feature catalog.
   * @returns {object} config.features, keyed by feature id
   */
  catalog() {
    const self = this;

    return self.ctx.omega.config.features || {};
  }

  /**
   * The product whose numbers apply: the account's RESOLVED plan (a cancelled or
   * suspended subscription resolves to the free tier), else `basic`.
   * @param {string} [id] - Force a specific product id
   * @returns {object} The catalog entry, or {}
   */
  getProduct(id) {
    const self = this;

    const products = self.ctx.omega.config.payment?.products || [];

    // A keyed counter's document carries no subscription, so it is basic
    id = id || (self.key ? 'basic' : self.user.plan);

    return products.find((product) => product.id === id)
      || products.find((product) => product.id === 'basic')
      || {};
  }

  /**
   * Resolve the account (or the keyed counter document) this counter counts on.
   * Runs at most once — every consume/read awaits it first.
   * @returns {Promise<Usage>} this
   */
  async resolve() {
    const self = this;

    if (self.resolved) {
      return self;
    }

    if (self.key) {
      self.user = { usage: await self.loadKeyed() };
    } else if (self.uid) {
      self.user = await self.loadAccount();
    } else {
      // authenticate() settles ONCE per request: when the pipeline already
      // authenticated it, this is that same answer, never a second token
      // verify and user doc read
      self.user = await self.ctx.authenticate();
    }

    // A signed-OUT caller has no document to count on. `authenticate()` resolves
    // a full account SHAPE for one (uid null) and marks the request resolved all
    // the same, so without this the write below would land on `users/null` — one
    // document every anonymous caller on earth would share, and a limit none of
    // them could ever exceed. Silently routing to the anonymous store instead
    // would be the OTHER old bug: a key that switches storage behind the caller's
    // back. Anonymous counting is explicit, so this says so.
    if (!self.key && !self.user?.auth?.uid) {
      throw new Error('usage: no signed-in account to count against; use usage.forKey(<key>) for anonymous callers');
    }

    self.resolved = true;

    // Log — the counters this counter arrived with, never the document holding
    // them: it carries api.privateKey, consent and attribution, and a backend
    // line lands in Cloud Logging for the whole retention window
    // ([#632](https://github.com/Omega-JS-Stack/omega/issues/632)).
    self.log(`Usage.resolve(): Resolved ${self.key || self.user?.auth?.uid || 'unauthenticated'}`, self.user?.usage);

    return self;
  }

  /**
   * The account a forUser() counter counts on, read once. Never healed or
   * created: a uid with no document is a 404, and nothing is written.
   * @returns {Promise<User>} The account at users/{uid}
   * @throws {Error} 404 when users/{uid} does not exist
   */
  async loadAccount() {
    const self = this;

    const snapshot = await self.ctx.omega.firebase.admin.firestore().doc(`users/${self.uid}`).get();
    const data = snapshot.data();

    if (!data) {
      throw self.ctx.report(`usage: no account at users/${self.uid}`, { code: 404 });
    }

    return new User(data, { uid: self.uid });
  }

  /**
   * The stored counters for this counter's anonymous key.
   * @returns {Promise<object>} feature id → counters
   */
  async loadKeyed() {
    const self = this;

    if (self.options.unauthenticatedMode !== 'firestore') {
      self.storage = self.storage || self.ctx.omega.storage({ name: ANONYMOUS_COLLECTION, temporary: true, clear: false, log: false });

      return self.storage.get(`users.${self.key}.usage`, {}).value() || {};
    }

    const found = await self.ctx.omega.firebase.admin.firestore().doc(`${ANONYMOUS_COLLECTION}/${self.key}`)
      .get()
      .then((r) => r.data())
      .catch((e) => {
        self.ctx.report(`Usage.loadKeyed(): Error fetching usage data: ${e}`, { code: 500 });
      });

    return found || {};
  }

  /**
   * What this account's state is for a feature, WITHOUT counting: the effective
   * limit (overrides applied), both counters, and what is left of each.
   * @param {string} feature - Feature id from the catalog
   * @returns {Promise<object>} { id, name, limit, used, left, day: { limit, used, left }, ... }
   */
  async read(feature) {
    const self = this;

    await self.resolve();

    return self.state(feature);
  }

  /**
   * The resolved feature state, from what is already loaded (no I/O).
   * @param {string} feature - Feature id from the catalog
   * @returns {object} @omega.js/account's resolveFeature shape
   */
  state(feature) {
    const self = this;

    return features.resolveFeature(feature, {
      catalog: self.catalog(),
      product: self.getProduct(),
      account: self.user,
      now: self.options.today,
    });
  }

  /**
   * The state of a counter running against an EXPLICIT limit rather than the
   * plan's — same shape as state(), with no day share (see consume's options).
   * @param {string} feature - Counter id
   * @param {number} limit - The limit that applies
   * @returns {object} The resolveFeature shape
   */
  explicitState(feature, limit) {
    const self = this;

    return features.resolveFeature(feature, {
      catalog: { [feature]: { name: feature, usage: { pace: false } } },
      product: { features: { [feature]: limit } },
      account: self.user,
      now: self.options.today,
    });
  }

  /**
   * Count one use of a feature — the ONE call a route makes.
   *
   * Refuses with a 429 naming which counter hit: the MONTH is checked first (a
   * spent month is not "try again tomorrow"), then the day's share.
   *
   * `options.limit` is for the counters that are NOT plan features — a per-IP
   * signup gate is a security control with its own declared config key
   * (`targets.backend.auth.signup.maxPerIpPerDay`), not a tier anybody buys. An
   * explicit limit supplies the definition the catalog would have, so the
   * catalog lookup and the product read are skipped, and the counter is a plain
   * period counter with no day share (an anonymous key's store is wiped daily,
   * so its period IS the day).
   *
   * @param {string} feature - Feature id from the catalog
   * @param {number} [amount] - How much to count (default 1)
   * @param {object} [options] - Consume options
   * @param {number} [options.limit] - An explicit limit for a non-plan counter
   * @returns {Promise<object>} { used, left, day: { used, left } } after counting
   */
  async consume(feature, amount, options) {
    const self = this;
    const ctx = self.ctx;

    // Set amount
    amount = typeof amount === 'undefined' ? 1 : amount;

    // Set options
    options = options || {};

    const explicit = typeof options.limit === 'number';
    const entry = self.catalog()[feature];

    // A feature no catalog defines, or a perk, is a PROGRAMMER error: the route
    // asked to meter something the config never made countable, and counting it
    // anyway would build a limit nothing enforces.
    if (!explicit && !entry) {
      throw ctx.report(`Usage.consume(): "${feature}" is not defined in the features catalog (config.features)`, { code: 500 });
    }

    if (!explicit && !features.isCountedFeature(entry)) {
      throw ctx.report(`Usage.consume(): "${feature}" is a perk, not a counted feature — give features.${feature} a \`usage\` block to meter it`, { code: 500 });
    }

    await self.resolve();

    const state = explicit ? self.explicitState(feature, options.limit) : self.state(feature);
    const name = (entry && entry.name) || feature;

    // A whitelisted API key still COUNTS (the record stays honest) — it only
    // never gets refused.
    const whitelisted = self.options.whitelistKeys.some((key) => key && key === self.user?.api?.privateKey);

    if (!whitelisted) {
      if (state.limit >= 0 && state.used + amount > state.limit) {
        throw ctx.report(
          `You have used all ${state.limit} of your ${name} this month (${state.used}/${state.limit}). Upgrade your plan for more.`,
          { code: 429 },
        );
      }

      if (state.day.limit >= 0 && state.day.used + amount > state.day.limit) {
        throw ctx.report(
          `You have used today's ${name} (${state.day.used}/${state.day.limit} of the ${state.limit} on your plan this month). Try again tomorrow.`,
          { code: 429 },
        );
      }
    }

    self.count(feature, amount);

    await self.write(feature);

    const counted = explicit ? self.explicitState(feature, options.limit) : self.state(feature);

    return {
      used: counted.used,
      left: counted.left,
      day: { used: counted.day.used, left: counted.day.left },
    };
  }

  /**
   * Move the counters in memory. `total` never resets; `last` records when the
   * feature moved.
   * @param {string} feature - Feature id
   * @param {number} amount - How much to count
   * @returns {Usage} this
   */
  count(feature, amount) {
    const self = this;

    const now = self.options.today ? new Date(self.options.today) : new Date();

    self.user.usage = self.user.usage || {};

    const counters = self.user.usage[feature] || {};

    self.user.usage[feature] = {
      ...counters,
      monthly: (counters.monthly || 0) + amount,
      daily: (counters.daily || 0) + amount,
      total: (counters.total || 0) + amount,
      last: {
        timestamp: now.toISOString(),
        timestampUNIX: Math.floor(now.getTime() / 1000),
      },
    };

    // Log the counter this moved — not the whole user document (#632)
    self.log(`Usage.count(): Counted ${amount} ${feature} for ${self.key || self.user?.auth?.uid || 'unauthenticated'}`, self.user.usage[feature]);

    return self;
  }

  /**
   * The write payload for ONE feature: that feature's counters and nothing else,
   * so two features counted in the same second cannot overwrite each other.
   * @param {string} feature - Feature id
   * @returns {object} { usage: { <feature>: counters } }
   */
  countersPatch(feature) {
    const self = this;

    return { usage: { [feature]: (self.user.usage || {})[feature] } };
  }

  /**
   * The mirror documents this feature's counters also land on: every doc the
   * account owns of each kind the CATALOG names. Declared in config, never at
   * the call site.
   * @param {string} feature - Feature id
   * @returns {string[]} Firestore document paths
   */
  mirrorPaths(feature) {
    const self = this;

    // An anonymous key owns nothing
    if (self.key) {
      return [];
    }

    const owns = self.user?.owns || {};
    const paths = [];

    features.featureMirrors(self.catalog()[feature]).forEach((kind) => {
      const owned = owns[kind];
      const ids = Array.isArray(owned) ? owned : (owned ? [owned] : []);

      ids.forEach((id) => paths.push(`${kind}/${id}`));
    });

    return paths;
  }

  /**
   * Persist one feature's counters: the user document and every mirror, in ONE
   * parallel write.
   * @param {string} feature - Feature id
   * @returns {Promise<void>}
   */
  async write(feature) {
    const self = this;

    const admin = self.ctx.omega.firebase.admin;
    const counters = (self.user.usage || {})[feature];

    if (self.key) {
      if (self.options.unauthenticatedMode !== 'firestore') {
        self.storage = self.storage || self.ctx.omega.storage({ name: ANONYMOUS_COLLECTION, temporary: true, clear: false, log: false });
        self.storage.set(`users.${self.key}.usage.${feature}`, counters).write();

        self.log(`Usage.write(): Wrote ${feature} to local storage`, counters);

        return;
      }

      await admin.firestore().doc(`${ANONYMOUS_COLLECTION}/${self.key}`)
        .set({ [feature]: counters }, { merge: true })
        .catch((e) => {
          throw self.ctx.report(e, { code: 500 });
        });

      return;
    }

    const patch = self.countersPatch(feature);
    const paths = [`users/${self.user.auth.uid}`, ...self.mirrorPaths(feature)];

    await Promise.all(paths.map((path) => admin.firestore().doc(path).set(patch, { merge: true })))
      .then(() => {
        self.log(`Usage.write(): Wrote ${feature} to ${paths.length} document(s)`, counters);
      })
      .catch((e) => {
        throw self.ctx.report(e, { code: 500 });
      });
  }

  /**
   * The counters this account arrived with — the `omega-properties` header's
   * `usage.current`. Empty until the counter has RESOLVED: a route that never
   * counted read nothing, and the header must not force a read to report one.
   * @returns {object} feature id → counters
   */
  counters() {
    const self = this;

    return self.resolved ? (self.user?.usage || {}) : {};
  }

  /**
   * Every counted feature's EFFECTIVE limit for this account (overrides applied)
   * — the `omega-properties` header's `usage.limits`, which the client merges
   * into its `usage` bindings. Empty until the counter has resolved.
   * @returns {object} feature id → limit (-1 unlimited)
   */
  limits() {
    const self = this;

    if (!self.resolved) {
      return {};
    }

    const catalog = self.catalog();
    const limits = {};

    Object.keys(catalog).forEach((id) => {
      if (features.isCountedFeature(catalog[id])) {
        limits[id] = self.state(id).limit;
      }
    });

    return limits;
  }

  /**
   * Add API keys that never get refused (they still count).
   * @param {string|string[]} keys - Key(s) to whitelist
   * @returns {Usage} this
   */
  addWhitelistKeys(keys) {
    const self = this;

    // Make keys an array if not already
    keys = Array.isArray(keys) ? keys : [keys];

    // Add keys to whitelist
    self.options.whitelistKeys = self.options.whitelistKeys.concat(keys);

    return self;
  }

  log() {
    const self = this;

    // Log
    if (self.options.log) {
      self.ctx.log(...arguments);
    }
  }
}

module.exports = Usage;
