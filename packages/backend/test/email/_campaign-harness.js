/**
 * The campaign send path, run for real against a fake SendGrid and Beehiiv API.
 *
 * The providers capture `wonderful-fetch` at module load, so the email library
 * and the crons are loaded FRESH behind a stub in the require cache (the idiom
 * of email/marketing/custom-fields-catalog.test.js), and every cache entry is
 * put back afterwards: the runner shares one process. The fake answers only
 * the endpoints a send reaches and throws on anything else, so no call can
 * leave the machine. `_`-prefixed: a helper, never a suite.
 */
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');
const FRESH_DIRS = [
  path.join(DIST, 'omega', 'libraries', 'email') + path.sep,
  path.join(DIST, 'omega', 'events', 'cron') + path.sep,
];
const FETCH_PATH = require.resolve('wonderful-fetch');
const omega = require('../../dist/omega/index.js');

const BRAND = {
  id: 'acme',
  name: 'Acme',
  url: 'https://acme.test',
  contact: { email: 'support@acme.test' },
  images: {},
};

const GROUPS = { orders: 1, hello: 2, account: 3, marketing: 4, security: 5, newsletter: 6, internal: 7 };
const PUBLICATION_ID = 'pub_acme';

/** The brand config every case starts from: both roles on, each provider configured. */
function brandConfig() {
  return {
    brand: structuredClone(BRAND),
    marketing: {
      campaigns: { enabled: true, providers: { sendgrid: { listId: 'lst_acme', groups: { ...GROUPS } } } },
      newsletter: { enabled: true, providers: { beehiiv: { publicationId: PUBLICATION_ID } }, content: { template: 'clean', categories: ['platforms'] } },
      prune: { enabled: true },
    },
  };
}

/**
 * In-memory Firestore: `docs` maps a doc path to its data, seeded from `seed`,
 * and every write is also recorded in order. Queries match a collection's
 * direct children on top-level `==` / `<=` filters, and a transaction runs on
 * the same map. A user lookup by email finds nobody unless seeded.
 */
function memoryAdmin(seed = {}) {
  const docs = new Map(Object.entries(structuredClone(seed)));
  const writes = [];
  let autoId = 0;

  const write = (docPath, data, merge) => {
    docs.set(docPath, { ...(merge ? docs.get(docPath) || {} : {}), ...data });
    writes.push({ path: docPath, data });
  };

  const docRef = (docPath) => ({
    id: docPath.split('/').pop(),
    path: docPath,
    set: async (data, options) => write(docPath, data, options?.merge),
    update: async (data) => write(docPath, data, true),
    get: async () => ({ id: docPath.split('/').pop(), exists: docs.has(docPath), data: () => structuredClone(docs.get(docPath)) }),
  });

  const matches = (data, { field, op, value }) => {
    const actual = field.split('.').reduce((current, key) => current?.[key], data);
    return op === '<=' ? actual <= value : actual === value;
  };

  const query = (name, filters, cap) => ({
    where: (field, op, value) => query(name, [...filters, { field, op, value }], cap),
    orderBy: () => query(name, filters, cap),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const found = [...docs.keys()]
        .filter((docPath) => docPath.startsWith(`${name}/`) && !docPath.slice(name.length + 1).includes('/'))
        .filter((docPath) => filters.every((filter) => matches(docs.get(docPath), filter)))
        .slice(0, cap ?? Infinity)
        .map((docPath) => ({ id: docPath.split('/').pop(), data: () => structuredClone(docs.get(docPath)), ref: docRef(docPath) }));

      return { empty: found.length === 0, size: found.length, docs: found };
    },
  });

  const firestore = {
    doc: docRef,
    collection: (name) => ({
      ...query(name, []),
      doc: (id) => docRef(`${name}/${id || `auto_${++autoId}`}`),
      add: async (data) => {
        const id = `auto_${++autoId}`;
        write(`${name}/${id}`, data);
        return { id };
      },
    }),
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, data, options) => { write(ref.path, data, options?.merge); },
      update: (ref, data) => { write(ref.path, data, true); },
    }),
  };

  return { admin: { firestore: () => firestore }, docs, writes };
}

/**
 * The account's verified senders: one per SENDERS row, at the contact-email
 * domain, built by the backend's own `senderFrom`.
 */
function rowSenders() {
  const { SENDERS, senderFrom } = require('../../dist/omega/libraries/email/constants.js');
  const domain = BRAND.contact.email.split('@')[1];

  return Object.keys(SENDERS).map((key, index) => ({
    id: 9 + index,
    from_email: senderFrom(key, { brandName: BRAND.name, domain }).email,
    verified: true,
  }));
}

/**
 * A fake of the two provider APIs. `sendgridSegments` is the account's
 * segment list, `{ key: { id, query } }` (a null query is a segment with no
 * query_dsl); `beehiivSegments` is the publication's, `{ key: id }`. A null
 * list is a listing outage: the call fails with no code, as a 503 does.
 * `verifiedSenders` is the account's sender list, the row-built one unless given.
 */
function fakeProviderApi({ sendgridSegments = {}, beehiivSegments = {}, verifiedSenders = rowSenders() } = {}) {
  const calls = [];
  let nextId = 0;

  const sendgridById = Object.fromEntries(Object.entries(sendgridSegments || {}).map(([name, segment]) => [segment.id, { name, ...segment }]));

  const notFound = (url) => {
    const error = new Error(`404 Not Found: ${url}`);
    error.status = 404;
    return error;
  };

  const listing = (list, url, answer) => {
    if (!list) {
      throw new Error(`503 Service Unavailable: ${url}`);
    }

    return answer(Object.entries(list));
  };

  const routes = [
    ['GET', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0$/, (url) => listing(sendgridSegments, url, (entries) => ({
      results: entries.map(([name, segment]) => ({ id: segment.id, name })),
    }))],
    ['GET', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0\/([^/?]+)$/, (url, match) => {
      const segment = sendgridById[match[1]];

      if (!segment) {
        throw notFound(url);
      }

      return { id: segment.id, name: segment.name, ...(segment.query ? { query_dsl: segment.query } : {}) };
    }],
    ['POST', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0$/, () => ({ id: `seg_temp_${++nextId}` })],
    ['DELETE', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0\/[^/?]+$/, () => ({})],
    ['GET', /api\.sendgrid\.com\/v3\/verified_senders/, () => ({ results: structuredClone(verifiedSenders) })],
    ['POST', /api\.sendgrid\.com\/v3\/marketing\/singlesends$/, () => ({ id: `ss_${++nextId}` })],
    ['PUT', /api\.sendgrid\.com\/v3\/marketing\/singlesends\/[^/]+\/schedule$/, () => ({ send_at: 'now', status: 'scheduled' })],
    ['GET', /api\.beehiiv\.com\/v2\/publications\/[^/]+\/segments/, (url) => listing(beehiivSegments, url, (entries) => ({
      data: entries.map(([name, id]) => ({ id, name })),
    }))],
    ['POST', /api\.beehiiv\.com\/v2\/publications\/[^/]+\/posts$/, () => ({ data: { id: `post_${++nextId}` } })],
  ];

  const fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;

    const call = { method, url, body };

    calls.push(call);

    for (const [routeMethod, pattern, answer] of routes) {
      const match = method === routeMethod && url.match(pattern);

      if (match) {
        call.response = answer(url, match);
        return call.response;
      }
    }

    throw new Error(`fake provider API: unexpected ${method} ${url}`);
  };

  const to = (method, pattern) => calls.filter((call) => call.method === method && pattern.test(call.url));

  return {
    fetch,
    calls,
    segmentListings: () => [
      ...to('GET', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0$/),
      ...to('GET', /api\.beehiiv\.com\/v2\/publications\/[^/]+\/segments/),
    ],
    singleSends: () => to('POST', /api\.sendgrid\.com\/v3\/marketing\/singlesends$/),
    tempSegments: () => to('POST', /api\.sendgrid\.com\/v3\/marketing\/segments\/2\.0$/),
    beehiivPosts: () => to('POST', /api\.beehiiv\.com\/v2\/publications\/[^/]+\/posts$/),
  };
}

const freshEntry = (key) => FRESH_DIRS.some((dir) => key.startsWith(dir));

function setEnv(values) {
  const saved = {};

  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }

  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/**
 * Run `fn(load, api)` with the fake API behind `wonderful-fetch` and both
 * provider keys set. `load(relative)` requires a module under dist/omega
 * fresh, so it and everything it pulls from the email library see the fake.
 * `config` is the brand config the providers read off the Omega instance.
 */
async function withProviderApi(api, fn, config = brandConfig()) {
  const savedFetch = require.cache[FETCH_PATH];
  const savedFresh = Object.keys(require.cache).filter(freshEntry).map((key) => [key, require.cache[key]]);
  const savedConfig = omega.config;
  const restoreEnv = setEnv({
    SENDGRID_API_KEY: 'sg-test-key',
    BEEHIIV_API_KEY: 'bh-test-key',
    UNSUBSCRIBE_HMAC_KEY: 'test-hmac-key',
  });

  savedFresh.forEach(([key]) => { delete require.cache[key]; });
  require.cache[FETCH_PATH] = { id: FETCH_PATH, filename: FETCH_PATH, loaded: true, exports: api.fetch };
  omega.config = config;

  const load = (relative) => require(path.join(DIST, 'omega', relative));

  try {
    return await fn(load, api);
  } finally {
    Object.keys(require.cache).filter(freshEntry).forEach((key) => { delete require.cache[key]; });
    savedFresh.forEach(([key, entry]) => { require.cache[key] = entry; });

    if (savedFetch) {
      require.cache[FETCH_PATH] = savedFetch;
    } else {
      delete require.cache[FETCH_PATH];
    }

    omega.config = savedConfig;
    restoreEnv();
  }
}

/**
 * The ctx a send runs on: the brand config, an in-memory store, and every log
 * level recorded. `email.sendCampaign` is the real Marketing library loaded by
 * `load`, the door a cron reaches it through. `config` replaces the brand config.
 */
function campaignCtx(load, { admin = memoryAdmin().admin, config = brandConfig(), ...extra } = {}) {
  const Marketing = load('libraries/email/marketing/index.js');
  const logs = [];
  const record = (...args) => logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  const ctx = {
    omega: { config, project: { websiteUrl: BRAND.url }, firebase: { admin }, isProduction: () => false },
    isTesting: () => false,
    log: record,
    debug: () => {},
    warn: record,
    error: record,
    logs,
    ...extra,
  };

  ctx.email = { ...(extra.email || {}), sendCampaign: (settings) => new Marketing(ctx).sendCampaign(settings) };

  return ctx;
}

const NEWSLETTER_FIXTURE = require('./fixtures/clean.json');

// One source the newsletter is written from, in the resolver's shape.
const NEWSLETTER_SOURCES = [{
  type: 'feed',
  id: 'src_1',
  title: 'Platforms tighten identity checks',
  subject: 'Platforms tighten identity checks',
  url: 'https://news.test/identity',
  content: 'Three platforms now verify business identity.',
  ai: { headline: 'Platforms tighten identity checks', summary: 'Three platforms now verify business identity.', takeaways: ['Document attribution'] },
  trackingData: {},
}];

/** The paid AI: a fit score for each source, then the clean fixture's structure. */
async function newsletterAi(request) {
  if ((request.schema?.required || []).includes('scores')) {
    return { content: { scores: NEWSLETTER_SOURCES.map(({ id }) => ({ id, fit: 9, reason: 'on brand' })) } };
  }

  return { content: structuredClone(NEWSLETTER_FIXTURE) };
}

/** The GitHub asset upload, answered with URLs; call before loading the generator. */
function stubAssetUpload(load) {
  load('libraries/email/generators/lib/image-host.js').uploadAssets = async () => ({
    urls: [],
    paths: [],
    htmlUrl: 'https://assets.test/newsletter.html',
    previewUrl: 'https://assets.test/preview',
    folderUrl: 'https://assets.test/folder',
    commitSha: 'abc1234',
  });
}

/**
 * Run with the clock pinned to the 1st of the CURRENT month: the prune cron
 * acts on that day alone, so a case on any other day would return before
 * reaching what it asserts. The current month keeps relative ages honest.
 */
async function onPruneDay(run) {
  const RealDate = Date;
  const today = new RealDate();
  const frozen = new RealDate(today.getFullYear(), today.getMonth(), 1, 12, 0, 0).getTime();

  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozen]));
    }

    static now() {
      return frozen;
    }
  }

  global.Date = FrozenDate;

  try {
    return await run();
  } finally {
    global.Date = RealDate;
  }
}

/** A send's visible text: tags dropped, entities decoded, whitespace collapsed. */
function visibleText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&#x27;|&apos;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

module.exports = {
  BRAND,
  brandConfig,
  memoryAdmin,
  rowSenders,
  fakeProviderApi,
  withProviderApi,
  campaignCtx,
  NEWSLETTER_FIXTURE,
  NEWSLETTER_SOURCES,
  newsletterAi,
  stubAssetUpload,
  onPruneDay,
  visibleText,
};
