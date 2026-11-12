/**
 * SendGrid service tests — all 8 operations against method-level recording
 * fakes (SendGrid + Cloudflare). Proves skip semantics, the converged
 * zero-mutation no-op, the one-pass domain-auth flow (create → DNS diff-sync
 * → validate once), the link-branding flow (create → write both link CNAMEs →
 * validate → flip the emailurl CNAME proxied), sender recreation + the de-ITW'd address requirement,
 * list resolution through config/state/name/create, unsubscribe groups
 * matched by name with their ids written to config, SSOT-driven field and
 * segment reconciliation (type recreate, stale PATCH + fallback, __temp_
 * sweep), the min-diff event webhook, and the dry-run zero-mutation
 * guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const { fieldsFor, segmentsFor, BACKEND_GROUP_KEYS } = require('../src/lib/backend-marketing.js');
const { buildQueryDsl } = require('../src/services/campaigns/lib/segment-query.js');
const service = require('../src/services/campaigns/index.js');
const { GROUP_DEFINITIONS } = require('../src/services/campaigns/ensure/unsubscribe-groups.js');
const { openTtyPrompt } = require('./lib/interactive.js');
const { emailProviderForRole } = require('@omega.js/config');

const DOWN = '\x1B[B';

// Tests must never see real credentials from the shell environment
delete process.env.SENDGRID_API_KEY;
delete process.env.OMEGA_WEBHOOK_KEY;
delete process.env.CLOUDFLARE_TOKEN;

const DOMAIN = 'fixture-brand.test';
const BRAND_NAME = 'Fixture Brand';

// What each backend SENDERS row sends as for this brand, at its contact-email domain.
const SENDER_ROWS = {
  orders: { email: `orders@${DOMAIN}`, name: `${BRAND_NAME} Orders` },
  hello: { email: `hello@${DOMAIN}`, name: BRAND_NAME },
  account: { email: `account@${DOMAIN}`, name: `${BRAND_NAME} Account` },
  marketing: { email: `offers@${DOMAIN}`, name: BRAND_NAME },
  security: { email: `security@${DOMAIN}`, name: `${BRAND_NAME} Security` },
  newsletter: { email: `newsletter@${DOMAIN}`, name: BRAND_NAME },
  internal: { email: `alerts@${DOMAIN}`, name: `${BRAND_NAME} Alerts` },
};
const SENDER_KEYS = Object.keys(SENDER_ROWS);
const nicknameOf = (key) => `${BRAND_NAME} (${key})`;

// The account's verified senders as SendGrid lists them, one per row, ids from 220.
const rowSenders = () => SENDER_KEYS.map((key, i) => ({ id: 220 + i, nickname: nicknameOf(key), from_email: SENDER_ROWS[key].email, verified: true }));
const WEBHOOK_KEY = 'fixture-webhook-key';
const WEBHOOK_URL = `https://api.${DOMAIN}/omega/marketing/webhook/forward?provider=sendgrid&key=${WEBHOOK_KEY}`;

const SENDGRID_FIELDS = fieldsFor('sendgrid');
const SENDGRID_SEGMENTS = segmentsFor('sendgrid');
const GROUP_KEYS = Object.keys(GROUP_DEFINITIONS);

// The account's ASM groups as SendGrid answers them — id 100 + index, so an
// assertion names a real id instead of a magic number.
const GROUP_IDS = Object.fromEntries(GROUP_KEYS.map((key, i) => [key, 100 + i]));
const accountGroups = (keys = GROUP_KEYS) => keys.map((key) => ({ id: GROUP_IDS[key], name: GROUP_DEFINITIONS[key].name, description: GROUP_DEFINITIONS[key].description }));
const TYPE_MAP = { text: 'Text', number: 'Number', date: 'Date' };

const ADDRESS = { line1: '123 Fixture St', line2: 'Unit 4', city: 'Testville', region: 'CA', postalCode: '00000', country: 'USA' };

const DNS_FIXTURE = {
  mail_cname: { type: 'cname', host: `emailauth.${DOMAIN}`, data: 'u123.wl001.sendgrid.net' },
  dkim1: { type: 'cname', host: `s1._domainkey.${DOMAIN}`, data: 's1.domainkey.u123.wl001.sendgrid.net' },
  dkim2: { type: 'cname', host: `s2._domainkey.${DOMAIN}`, data: 's2.domainkey.u123.wl001.sendgrid.net' },
};

// Link branding (#693): the `emailurl.<domain>` host, and SendGrid's validate
// answer for it — a top-level `valid`, the same field the list read reports.
const LINK_SUBDOMAIN = 'emailurl';
const LINK_HOST = `${LINK_SUBDOMAIN}.${DOMAIN}`;
const LINK_OWNER_HOST = `123.${DOMAIN}`;
const LINK_DNS_FIXTURE = {
  domain_cname: { host: LINK_HOST, data: 'sendgrid.net', type: 'cname' },
  owner_cname: { host: LINK_OWNER_HOST, data: 'sendgrid.net', type: 'cname' },
};
const LINK_VALIDATION_OK = { id: 333, valid: true };
const LINK_VALIDATION_PENDING = { id: 333, valid: false, validation_results: { domain_cname: { valid: false } } };

// The unproxied emailurl CNAME the edge service already wrote this run — the
// record the flip patches.
const EMAILURL_RECORD = { id: 'rec-url', type: 'CNAME', name: LINK_HOST, content: 'sendgrid.net', proxied: false, comment: 'SendGrid URL tracking' };

const VALIDATION_OK = { validation_results: { mail_cname: { valid: true }, dkim1: { valid: true }, dkim2: { valid: true } } };
const VALIDATION_PENDING = { validation_results: { mail_cname: { valid: false }, dkim1: { valid: true }, dkim2: { valid: true } } };

// ─── Fixtures ────────────────────────────────────────────────────────────────

// `company` is the RESOLVED section (#677): a brand with no company of its own
// resolves to its OWN url, which is what the retired `parent: 'self'` said.
function brandConfig({ url = `https://${DOMAIN}`, company = null, webhooks = true, address = ADDRESS, listId = null, groups = null, campaigns = {} } = {}) {
  return {
    brand: {
      id: 'fixture-brand',
      name: BRAND_NAME,
      url,
      contact: { email: `support@${DOMAIN}` },
      ...(address ? { address } : {}),
    },
    company: { ...(company || { id: null, url, images: {} }), webhooks },
    marketing: {
      campaigns: {
        ...structuredClone(DEFAULTS.marketing.campaigns),
        providers: { sendgrid: { listId, ...(groups ? { groups } : {}) } },
        ...campaigns,
      },
    },
    targets: { web: { type: 'web' } },
  };
}

const READ_METHODS = [
  'getAuthenticatedDomains', 'getBrandedLinks', 'getVerifiedSenders', 'getLists', 'getListByName',
  'getList', 'getUnsubscribeGroups', 'getCustomFields', 'getSegments', 'getSegment',
  'getEventWebhookSettings',
];
const MUTATING_METHODS = [
  'authenticateDomain', 'validateDomain', 'createBrandedLink', 'validateBrandedLink',
  'createVerifiedSender', 'deleteVerifiedSender',
  'createList', 'createUnsubscribeGroup', 'createCustomField', 'deleteCustomField',
  'createSegment', 'updateSegment', 'deleteSegment', 'updateEventWebhookSettings',
];

/** Method-level recording fake — a call with no configured response throws LOUDLY. */
function fakeSendgrid(responses = {}) {
  const api = { calls: [] };

  for (const method of [...READ_METHODS, ...MUTATING_METHODS]) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`fakeSendgrid: unexpected call ${method}(${JSON.stringify(args)})`);
      }
      const responder = responses[method];
      return typeof responder === 'function' ? responder(...args) : structuredClone(responder);
    };
  }

  api.mutations = () => api.calls.filter((c) => MUTATING_METHODS.includes(c.method));
  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

/**
 * Recording fake Cloudflare client (zone lookup + raw DNS record requests).
 *
 * The zone is STATEFUL: a created record is visible to the next read, which is
 * what the link-branding flow depends on — it writes the branded-link CNAMEs
 * and then has to find one of them again to flip it proxied (#693).
 */
function fakeCf({ zone = { id: 'zone-1', name: DOMAIN }, records = [] } = {}) {
  const api = { requests: [] };
  const zoneRecords = structuredClone(records);
  let nextId = 1;

  api.getZoneByName = async (name) => {
    api.requests.push({ method: 'getZoneByName', name });
    return zone ? structuredClone(zone) : null;
  };

  api.makeRequest = async (path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    api.requests.push({ method, path, body });

    if (method === 'GET') {
      return { result: structuredClone(zoneRecords) };
    }

    if (method === 'POST') {
      zoneRecords.push({ id: `new-${nextId++}`, ...body });
    } else if (method === 'PATCH') {
      const id = path.split('/').pop();
      const existing = zoneRecords.find((r) => r.id === id);
      if (existing) Object.assign(existing, body);
    }

    return { result: {} };
  };

  api.writes = () => api.requests.filter((r) => r.method !== 'GET' && r.method !== 'getZoneByName');
  return api;
}

/** Everything already matches — the whole service should be reads only. */
function convergedResponses() {
  return {
    getAuthenticatedDomains: [{ id: 111, domain: DOMAIN, valid: true }],
    getBrandedLinks: [{ id: 333, domain: DOMAIN, subdomain: LINK_SUBDOMAIN, valid: true }],
    getVerifiedSenders: rowSenders(),
    getList: { id: 'lst_1', name: BRAND_NAME },
    getListByName: { id: 'lst_1', name: BRAND_NAME },
    getUnsubscribeGroups: accountGroups(),
    getCustomFields: SENDGRID_FIELDS.map((f, i) => ({ id: `f${i}`, name: f.name, field_type: TYPE_MAP[f.type] })),
    getSegments: SENDGRID_SEGMENTS.map((s, i) => ({ id: `seg${i}`, name: s.name })),
    getSegment: (id) => {
      const seg = SENDGRID_SEGMENTS[Number(String(id).replace('seg', ''))];
      return { id, name: seg.name, query_dsl: buildQueryDsl(seg.conditions, seg.logic) };
    },
    getEventWebhookSettings: {
      enabled: true, url: WEBHOOK_URL,
      bounce: true, dropped: true, spam_report: true, unsubscribe: true, group_unsubscribe: true,
    },
  };
}

/**
 * A sender account that remembers: what is created is listed, verified, on the
 * next read, and what is deleted is gone. Spread `responses` into fakeSendgrid.
 */
function senderAccount(initial = []) {
  const senders = structuredClone(initial);
  let nextId = 900;

  const responses = {
    getVerifiedSenders: () => structuredClone(senders),
    createVerifiedSender: (sender) => {
      const made = { id: nextId++, nickname: sender.nickname, from_email: sender.fromEmail, verified: true };
      senders.push(made);
      return structuredClone(made);
    },
    deleteVerifiedSender: (id) => {
      const index = senders.findIndex((sender) => sender.id === id);
      if (index < 0) throw new Error(`senderAccount: no sender ${id} to delete`);
      senders.splice(index, 1);
      return null;
    },
  };

  return { responses, senders };
}

/** Each create call's sender, ordered by address so a run's row order never matters. */
const createdSenders = (api) => api.callsTo('createVerifiedSender').map((call) => call.args[0]).sort((a, b) => a.fromEmail.localeCompare(b.fromEmail));

/** The sender a row is made with: its address, from name and nickname, the brand's reply-to and address. */
function expectedSender(key, address = ADDRESS) {
  return {
    nickname: nicknameOf(key),
    fromEmail: SENDER_ROWS[key].email,
    fromName: SENDER_ROWS[key].name,
    replyToEmail: `support@${DOMAIN}`,
    replyToName: BRAND_NAME,
    address: { street: address.line1, street2: address.line2, city: address.city, state: address.region, zip: address.postalCode, country: address.country },
  };
}

const expectedSenders = (keys, address) => keys.map((key) => expectedSender(key, address)).sort((a, b) => a.fromEmail.localeCompare(b.fromEmail));

const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

// Writeback target — the list op edits config/omega.json5 in the brand root;
// these comments must survive every service write byte-for-byte.
const WRITEBACK_CONFIG = `// Fixture Brand — hand-edited writeback target
{
  brand: {
    id: 'fixture-brand', // stays single-quoted
    name: "Fixture Brand",
  },
  marketing: {
    campaigns: {
      enabled: true,
    },
  },
}
`;

// The same file once the ids already landed — a converged rerun must leave it
// byte-identical.
const GROUPS_WRITEBACK_CONFIG = `// Fixture Brand — hand-edited writeback target
{
  brand: {
    id: 'fixture-brand', // stays single-quoted
    name: "Fixture Brand",
  },
  marketing: {
    campaigns: {
      enabled: true,
      providers: {
        sendgrid: {
          groups: {
${GROUP_KEYS.map((key) => `            ${key}: ${GROUP_IDS[key]},`).join('\n')}
          },
        },
      },
    },
  },
}
`;

function runService(config, { sendgrid, cloudflare = null, options = {}, serviceData = {}, webhookKey = true, brandRoot, companyConfig } = {}) {
  if (webhookKey) {
    process.env.OMEGA_WEBHOOK_KEY = WEBHOOK_KEY;
  } else {
    delete process.env.OMEGA_WEBHOOK_KEY;
  }

  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || makeBrandRoot(WRITEBACK_CONFIG), // the list op writes into config/omega.json5 here
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.campaigns,
    options,
    serviceData,
    sendgridApi: sendgrid,
    cloudflareApi: cloudflare,
    companyConfig,
  });
}

module.exports = defineCases({
  type: 'group',
  description: 'campaigns',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'campaigns: marketing.campaigns.enabled = false skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ campaigns: { enabled: false } }), { sendgrid: fakeSendgrid() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/marketing\.campaigns\.enabled/);
      },
    },

    {
      name: 'campaigns: a different campaigns provider skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ campaigns: { providers: { other: {} } } }), { sendgrid: fakeSendgrid() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/marketing\.campaigns\.providers\.other/);
      },
    },

    {
      name: 'campaigns: an empty providers block means none chosen — the service skips (#425)',
      run: async (ctx) => {
        const result = await runService(brandConfig({ campaigns: { providers: {} } }), { sendgrid: fakeSendgrid() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no marketing\.campaigns\.providers entry/);
      },
    },

    {
      name: 'campaigns: the service answers to the provider row of the campaigns role',
      run: async (ctx) => {
        const row = emailProviderForRole('campaigns');
        const otherRole = emailProviderForRole('newsletter');

        const unkeyed = await runService(brandConfig()); // no injected api, so the credential check applies
        ctx.expect(unkeyed.status).toBe('skipped');
        ctx.expect(unkeyed.reason, 'the missing credential is the row\'s env key').toContain(row.envKey);

        // The newsletter role's provider chosen under campaigns is not this service's
        const misrouted = await runService(brandConfig({ campaigns: { providers: { [otherRole.id]: {} } } }), { sendgrid: fakeSendgrid() });
        ctx.expect(misrouted.status).toBe('skipped');
        ctx.expect(misrouted.reason).toContain(`marketing.campaigns.providers.${otherRole.id}`);
      },
    },

    {
      name: 'campaigns: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { sendgrid: fakeSendgrid() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'campaigns: a default Pages brand.url is no domain, so setup skips with the one reason before any client call',
      run: async (ctx) => {
        const sendgrid = fakeSendgrid();
        const cloudflare = fakeCf();

        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { sendgrid, cloudflare });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(sendgrid.calls).toEqual([]);
        ctx.expect(cloudflare.requests).toEqual([]);
      },
    },

    {
      name: 'campaigns: the defaults carry no company parent URL',
      run: (ctx) => {
        // omega-manager defaulted parent to the company's brand URL — the manager
        // defaults layer must leave the choice to config. Since #677 the parent IS
        // the resolved company, and `parent` is retired outright.
        ctx.expect('parent' in DEFAULTS).toBe(false);
        ctx.expect(DEFAULTS.marketing.campaigns.providers.sendgrid.listId).toBe(null);
      },
    },

    // ─── Converged no-op ─────────────────────────────────────────────────────────

    {
      name: 'campaigns: fully converged brand is a zero-mutation no-op across all 6 operations',
      run: async (ctx) => {
        const api = fakeSendgrid(convergedResponses());

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(result.state.listId).toBe('lst_1');
        ctx.expect(result.output.customFields.created).toBe(0);
        ctx.expect(result.output.segments.created).toBe(0);
        ctx.expect(result.output.eventWebhook.url).toBe('converged');
      },
    },

    // ─── domain-auth ─────────────────────────────────────────────────────────────

    {
      name: 'campaigns: missing domain auth is created, DNS written, validated once — pending warns',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [],
          authenticateDomain: { id: 111, domain: DOMAIN, dns: DNS_FIXTURE },
          validateDomain: VALIDATION_PENDING,
        });
        const cf = fakeCf();

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.callsTo('authenticateDomain')[0].args).toEqual([DOMAIN, 'emailauth']);
        ctx.expect(api.callsTo('validateDomain').length).toBe(1); // ONCE — no poll loop

        const writes = cf.writes();
        ctx.expect(writes.length).toBe(3);
        ctx.expect(writes[0]).toEqual({
          method: 'POST',
          path: '/zones/zone-1/dns_records',
          body: { type: 'CNAME', name: `emailauth.${DOMAIN}`, content: 'u123.wl001.sendgrid.net', ttl: 1, proxied: false, comment: 'SendGrid mail_cname' },
        });
        ctx.expect(result.output.domainAuth.valid).toBe(false);
      },
    },

    {
      name: 'campaigns: invalid domain auth with a wrong DNS record patches it and converges when validation passes',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [{ id: 111, domain: DOMAIN, valid: false, dns: DNS_FIXTURE }],
          validateDomain: VALIDATION_OK,
        });
        const cf = fakeCf({
          records: [{ id: 'rec-1', type: 'CNAME', name: `emailauth.${DOMAIN}`, content: 'stale.sendgrid.net' }],
        });

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('authenticateDomain').length).toBe(0); // reused, not recreated

        const writes = cf.writes();
        ctx.expect(writes.length).toBe(3);
        ctx.expect(writes[0].method).toBe('PATCH');
        ctx.expect(writes[0].path).toBe('/zones/zone-1/dns_records/rec-1');
        ctx.expect(writes[1].method).toBe('POST');
        ctx.expect(result.output.domainAuth.valid).toBe(true);
      },
    },

    {
      name: 'campaigns: no Cloudflare token → manual records + validation still attempted',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [],
          authenticateDomain: { id: 111, domain: DOMAIN, dns: DNS_FIXTURE },
          validateDomain: VALIDATION_PENDING,
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.callsTo('validateDomain').length).toBe(1);
        ctx.expect(result.output.domainAuth.manualRecords.length).toBe(3);
        ctx.expect(result.output.domainAuth.manualRecords[0].name).toBe(`emailauth.${DOMAIN}`);
      },
    },

    // ─── link-branding (#693) ────────────────────────────────────────────────────

    // Run 1 on a fresh brand: the edge service wrote NO SendGrid records (its live
    // domain-auth read found nothing yet), so this operation owns both link CNAMEs
    // — and they must land BEFORE SendGrid is asked to validate them.
    {
      name: 'campaigns: a fresh brand gets both link CNAMEs written, then validated, then proxied',
      run: async (ctx) => {
        const cf = fakeCf(); // empty zone — nothing wrote the emailurl record yet
        let writesAtValidation = null;

        const api = fakeSendgrid({
          ...convergedResponses(),
          getBrandedLinks: [],
          createBrandedLink: { id: 333, domain: DOMAIN, subdomain: LINK_SUBDOMAIN, valid: false, dns: LINK_DNS_FIXTURE },
          validateBrandedLink: () => {
            writesAtValidation = cf.writes().length;
            return structuredClone(LINK_VALIDATION_OK);
          },
        });

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('createBrandedLink')[0].args).toEqual([DOMAIN, LINK_SUBDOMAIN]);
        ctx.expect(writesAtValidation, 'both CNAMEs land BEFORE SendGrid is asked to validate').toBe(2);

        const writes = cf.writes();
        ctx.expect(writes.length).toBe(3);
        ctx.expect(writes[0]).toEqual({
          method: 'POST',
          path: '/zones/zone-1/dns_records',
          body: { type: 'CNAME', name: LINK_HOST, content: 'sendgrid.net', ttl: 1, proxied: false, comment: 'SendGrid domain_cname' },
        });
        ctx.expect(writes[1].body).toEqual({ type: 'CNAME', name: LINK_OWNER_HOST, content: 'sendgrid.net', ttl: 1, proxied: false, comment: 'SendGrid owner_cname' });
        ctx.expect(writes[2].method, 'and only then does the record ride the proxy').toBe('PATCH');
        ctx.expect(writes[2].body.name).toBe(LINK_HOST);
        ctx.expect(writes[2].body.proxied).toBe(true);
        ctx.expect(result.output.linkBranding).toEqual({ id: 333, valid: true, proxied: true });
      },
    },

    {
      name: 'campaigns: missing link branding is created and validated once — pending warns',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getBrandedLinks: [],
          createBrandedLink: { id: 333, domain: DOMAIN, subdomain: LINK_SUBDOMAIN, valid: false, dns: LINK_DNS_FIXTURE },
          validateBrandedLink: LINK_VALIDATION_PENDING,
        });
        // The emailurl CNAME the edge service already wrote this run, grey
        const cf = fakeCf({ records: [EMAILURL_RECORD] });

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.callsTo('createBrandedLink')[0].args).toEqual([DOMAIN, LINK_SUBDOMAIN]);
        ctx.expect(api.callsTo('validateBrandedLink').length).toBe(1); // ONCE — no poll loop
        ctx.expect(result.output.linkBranding.valid).toBe(false);

        const writes = cf.writes();
        ctx.expect(writes.length, 'the matching emailurl record is left alone; only the owner CNAME is missing').toBe(1);
        ctx.expect(writes[0].body.name).toBe(LINK_OWNER_HOST);
        ctx.expect(!writes.some((w) => w.method === 'PATCH'), 'nothing is proxied until SendGrid validates').toBeTruthy();
      },
    },

    {
      name: 'campaigns: link branding that already validated is a read-only converge that still flips a grey record',
      run: async (ctx) => {
        const api = fakeSendgrid(convergedResponses());
        const cf = fakeCf({ records: [EMAILURL_RECORD] });

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('createBrandedLink').length).toBe(0);
        ctx.expect(api.callsTo('validateBrandedLink').length).toBe(0);
        ctx.expect(result.output.linkBranding).toEqual({ id: 333, valid: true });

        // A validated branding whose record is still grey costs no extra walk
        ctx.expect(cf.writes()).toEqual([{
          method: 'PATCH',
          path: '/zones/zone-1/dns_records/rec-url',
          body: { type: 'CNAME', name: LINK_HOST, content: 'sendgrid.net', ttl: 1, proxied: true, comment: 'SendGrid URL tracking' },
        }]);
      },
    },

    {
      name: 'campaigns: an interactive run waits for validation, then flips the emailurl CNAME proxied',
      run: async (ctx) => {
        let validations = 0;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getBrandedLinks: [{ id: 333, domain: DOMAIN, subdomain: LINK_SUBDOMAIN, valid: false, dns: LINK_DNS_FIXTURE }],
          validateBrandedLink: () => {
            validations++;
            return structuredClone(validations === 1 ? LINK_VALIDATION_PENDING : LINK_VALIDATION_OK);
          },
        });
        const cf = fakeCf({ records: [EMAILURL_RECORD] });
        const tty = openTtyPrompt();

        try {
          const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

          ctx.expect(result.status).toBe('success');
          ctx.expect(api.callsTo('createBrandedLink').length).toBe(0); // reused, not recreated
          ctx.expect(validations).toBe(2); // initial attempt + the poll's first re-check
          ctx.expect(result.output.linkBranding).toEqual({ id: 333, valid: true, proxied: true });

          const writes = cf.writes();
          ctx.expect(writes[0].body.name).toBe(LINK_OWNER_HOST); // the missing half of the record set
          ctx.expect(writes[1]).toEqual({
            method: 'PATCH',
            path: '/zones/zone-1/dns_records/rec-url',
            body: { type: 'CNAME', name: LINK_HOST, content: 'sendgrid.net', ttl: 1, proxied: true, comment: 'SendGrid URL tracking' },
          });
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'campaigns: no Cloudflare token → the validated branding warns with the manual flip',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getBrandedLinks: [{ id: 333, domain: DOMAIN, subdomain: LINK_SUBDOMAIN, valid: false, dns: LINK_DNS_FIXTURE }],
          validateBrandedLink: LINK_VALIDATION_OK,
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.linkBranding).toEqual({ id: 333, valid: true, proxied: false });
      },
    },

    // A subdomain brand's apex records belong to the PARENT brand's walk — the
    // same line the edge service draws — so a branding created here would wait on
    // CNAMEs this brand never writes.
    {
      name: 'campaigns: a subdomain project leaves link branding to the parent brand',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [],
          authenticateDomain: { id: 112, domain: `app.${DOMAIN}`, dns: DNS_FIXTURE },
          validateDomain: VALIDATION_OK,
        });
        const cf = fakeCf();

        // An unresolved company keeps the run to the operations under test: the
        // webhook op has nothing to point at, exactly as its own test pins.
        const result = await runService(brandConfig({ url: `https://app.${DOMAIN}`, company: { id: 'parent-brand', url: null, images: {} } }), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('getBrandedLinks').length, 'the operation steps aside before it reads').toBe(0);
        ctx.expect(result.output.linkBranding).toBe(undefined);
      },
    },

    // ─── sender-identity ─────────────────────────────────────────────────────────

    {
      name: 'campaigns: a brand with no verified sender gets one per backend sender row',
      run: async (ctx) => {
        const api = fakeSendgrid({ ...convergedResponses(), ...senderAccount().responses });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status, result.error).toBe('success');
        ctx.expect(createdSenders(api), 'each row made with its address, name and nickname').toEqual(expectedSenders(SENDER_KEYS));
        ctx.expect(api.callsTo('deleteVerifiedSender')).toEqual([]);
      },
    },

    {
      name: 'campaigns: a verified offers@ sender is kept whatever its nickname, and the other rows are made',
      run: async (ctx) => {
        const offers = { id: 222, nickname: BRAND_NAME, from_email: SENDER_ROWS.marketing.email, verified: true };
        const api = fakeSendgrid({ ...convergedResponses(), ...senderAccount([offers]).responses });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status, result.error).toBe('success');
        ctx.expect(api.callsTo('deleteVerifiedSender'), 'the verified offers@ sender is kept').toEqual([]);
        ctx.expect(createdSenders(api)).toEqual(expectedSenders(SENDER_KEYS.filter((key) => key !== 'marketing')));
      },
    },

    {
      name: 'campaigns: a second sender-identity run on a finished brand writes nothing',
      run: async (ctx) => {
        const account = senderAccount();
        const api = fakeSendgrid({ ...convergedResponses(), ...account.responses });

        await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });
        const firstRunWrites = api.mutations().length;

        ctx.expect(account.senders.map((sender) => sender.from_email).sort(), 'the first run finished every row').toEqual(SENDER_KEYS.map((key) => SENDER_ROWS[key].email).sort());

        const second = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(second.status, second.error).toBe('success');
        ctx.expect(api.mutations().slice(firstRunWrites), 'the second run makes no call that writes').toEqual([]);
      },
    },

    {
      name: 'campaigns: one row\'s unverified sender is remade and the other rows are left alone',
      run: async (ctx) => {
        const senders = rowSenders().map((sender) => (sender.from_email === SENDER_ROWS.hello.email ? { ...sender, verified: false } : sender));
        const unverified = senders.find((sender) => !sender.verified);
        const api = fakeSendgrid({ ...convergedResponses(), ...senderAccount(senders).responses });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status, result.error).toBe('success');
        ctx.expect(api.callsTo('deleteVerifiedSender').map((call) => call.args), 'only the unverified one is removed').toEqual([[unverified.id]]);
        ctx.expect(createdSenders(api), 'only that row is made again').toEqual([expectedSender('hello')]);
      },
    },

    {
      name: 'campaigns: a row\'s nickname on another address is replaced when unverified and warns when verified, for that row only',
      run: async (ctx) => {
        // The newsletter row's nickname holds an address from before the contact domain moved
        const squatted = (verified) => rowSenders().map((sender) => (sender.nickname === nicknameOf('newsletter')
          ? { id: 9376, nickname: sender.nickname, from_email: 'newsletter@old-domain.test', verified }
          : sender));

        const unverifiedApi = fakeSendgrid({ ...convergedResponses(), ...senderAccount(squatted(false)).responses });
        const replaced = await runService(brandConfig(), { sendgrid: unverifiedApi, serviceData: { listId: 'lst_1' } });

        ctx.expect(replaced.status, replaced.error).toBe('success');
        ctx.expect(unverifiedApi.callsTo('deleteVerifiedSender').map((call) => call.args), 'the unverified squatter is removed').toEqual([[9376]]);
        ctx.expect(createdSenders(unverifiedApi), 'and that row alone is made').toEqual([expectedSender('newsletter')]);

        const verifiedApi = fakeSendgrid({ ...convergedResponses(), ...senderAccount(squatted(true)).responses });
        const warned = await runService(brandConfig(), { sendgrid: verifiedApi, serviceData: { listId: 'lst_1' } });
        const identities = warned.output.senderIdentities;

        ctx.expect(warned.status).toBe('warned');
        ctx.expect(verifiedApi.mutations(), 'a verified squatter is never deleted, and nothing else is written').toEqual([]);
        ctx.expect(identities.newsletter.staleNickname, 'the warning is on the newsletter row').toBe('newsletter@old-domain.test');
        ctx.expect(SENDER_KEYS.filter((key) => key !== 'newsletter' && identities[key]?.staleNickname), 'no other row warns').toEqual([]);
      },
    },

    {
      name: 'campaigns: no brand.address and no prompt warns once and makes no sender',
      run: async (ctx) => {
        const api = fakeSendgrid({ ...convergedResponses(), ...senderAccount().responses });

        const result = await runService(brandConfig({ address: null }), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.warned.filter((entry) => entry.operation === 'sender-identity').length, 'one warning for the operation').toBe(1);
        ctx.expect(api.callsTo('createVerifiedSender')).toEqual([]);
      },
    },

    {
      name: 'campaigns: a missing brand.address is ASKED for once, behind ONE gate, and every row is made with it (#635)',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const api = fakeSendgrid({ ...convergedResponses(), ...senderAccount().responses });

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig({ address: null }), { sendgrid: api, serviceData: { listId: 'lst_1' }, brandRoot });
          await tty.answer('Set up now?', '\r');                       // ONE gate for all five fields
          await tty.answer('Street address', '500 Fixture Ave\r');
          await tty.answer('City', 'Testville\r');
          await tty.answer('State / region', 'CA\r');
          await tty.answer('Postal code', '90210\r');
          await tty.answer('Country', 'USA\r');
          const result = await run;

          // A second ask would wait on keys never typed, so the run settling proves one ask
          ctx.expect(result.status, result.error).toBe('success');
          ctx.expect(createdSenders(api), 'every row is made on the address just entered').toEqual(expectedSenders(SENDER_KEYS, {
            line1: '500 Fixture Ave', line2: '', city: 'Testville', region: 'CA', postalCode: '90210', country: 'USA',
          }));
          // ...and it landed as ONE brand.address object, comments intact
          const written = readConfigSource(brandRoot);
          ctx.expect(written).toMatch(/500 Fixture Ave/);
          ctx.expect(written).toMatch(/Testville/);
          ctx.expect(written).toMatch(/\/\/ stays single-quoted/);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'campaigns: skipping the address gate keeps the CAN-SPAM warn and writes nothing (#635)',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const api = fakeSendgrid({ ...convergedResponses(), getVerifiedSenders: [] });

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig({ address: null }), { sendgrid: api, serviceData: { listId: 'lst_1' }, brandRoot });
          await tty.answer('Set up now?', `${DOWN}\r`);                 // Skip for now
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.warned.filter((entry) => entry.operation === 'sender-identity').length).toBe(1);
          ctx.expect(api.callsTo('createVerifiedSender').length).toBe(0);
          ctx.expect(readConfigSource(brandRoot)).not.toMatch(/address/);
        } finally {
          tty.close();
        }
      },
    },

    // ─── list ────────────────────────────────────────────────────────────────────

    {
      name: 'campaigns: a configured listId is verified and kept',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getList: { id: 'lst_cfg', name: 'Renamed In SendGrid' },
        });

        const result = await runService(brandConfig({ listId: 'lst_cfg' }), { sendgrid: api });

        ctx.expect(api.callsTo('getList')[0].args).toEqual(['lst_cfg']);
        ctx.expect(api.callsTo('createList').length).toBe(0);
        ctx.expect(result.state.listId).toBe('lst_cfg');
      },
    },

    {
      name: 'campaigns: a stale known id falls back to name lookup',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getList: () => null,
          getListByName: { id: 'lst_2', name: BRAND_NAME },
        });

        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_gone' }, brandRoot });

        ctx.expect(result.state.listId).toBe('lst_2');
        ctx.expect(api.callsTo('createList').length).toBe(0);

        const written = readConfigSource(brandRoot);
        ctx.expect(written.includes('listId: "lst_2",')).toBeTruthy();
        ctx.expect(written.includes("id: 'fixture-brand', // stays single-quoted")).toBeTruthy();
      },
    },

    {
      name: 'campaigns: no list anywhere → created and stored in state',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getListByName: () => undefined,
          createList: { id: 'lst_new', name: BRAND_NAME },
        });

        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const result = await runService(brandConfig(), { sendgrid: api, brandRoot });

        ctx.expect(api.callsTo('createList')[0].args).toEqual([BRAND_NAME]);
        ctx.expect(result.state.listId).toBe('lst_new');
        ctx.expect(api.callsTo('getList').length).toBe(0); // nothing known to verify

        const written = readConfigSource(brandRoot);
        ctx.expect(written.includes('listId: "lst_new",')).toBeTruthy();
        ctx.expect(written.includes('// Fixture Brand — hand-edited writeback target')).toBeTruthy();
      },
    },

    {
      name: 'campaigns: config-known id writes nothing; a state-known id is promoted into omega.json5',
      run: async (ctx) => {
        // Config already carries the id — the file stays byte-identical (the group
        // ids are in the file too, or the unsubscribe-groups op would land them)
        const configuredRoot = makeBrandRoot(GROUPS_WRITEBACK_CONFIG);
        const before = readConfigSource(configuredRoot);
        await runService(brandConfig({ listId: 'lst_1', groups: GROUP_IDS }), { sendgrid: fakeSendgrid(convergedResponses()), brandRoot: configuredRoot });
        ctx.expect(readConfigSource(configuredRoot)).toBe(before);

        // The same id known only from state — promoted into the file
        const stateRoot = makeBrandRoot(WRITEBACK_CONFIG);
        await runService(brandConfig(), { sendgrid: fakeSendgrid(convergedResponses()), serviceData: { listId: 'lst_1' }, brandRoot: stateRoot });
        ctx.expect(readConfigSource(stateRoot).includes('listId: "lst_1",')).toBeTruthy();
      },
    },

    // ─── unsubscribe-groups ──────────────────────────────────────────────────────

    {
      name: 'campaigns: the group table covers every key @omega.js/backend sends through',
      run: (ctx) => {
        // The keys are @omega.js/backend's SSOT; the names/descriptions are this
        // service's. A key with no row would send through a group nothing provisions.
        ctx.expect(GROUP_KEYS).toEqual(BACKEND_GROUP_KEYS);
        for (const key of BACKEND_GROUP_KEYS) {
          ctx.expect(GROUP_DEFINITIONS[key].name, `${key} has a group name`).toBeTruthy();
          ctx.expect(GROUP_DEFINITIONS[key].description, `${key} has a recipient-facing description`).toBeTruthy();
        }
        // Brand-neutral names: sibling brands on ONE account must match the same groups
        const names = BACKEND_GROUP_KEYS.map((key) => GROUP_DEFINITIONS[key].name);
        ctx.expect(new Set(names).size, 'group names are unique').toBe(names.length);
        ctx.expect(!names.some((name) => name.includes(BRAND_NAME)), 'no brand name in a group name').toBeTruthy();
      },
    },

    {
      name: 'campaigns: an account with no groups gets all seven created, ids written to omega.json5',
      run: async (ctx) => {
        const created = [];
        const api = fakeSendgrid({
          ...convergedResponses(),
          getUnsubscribeGroups: [],
          createUnsubscribeGroup: (name, description) => {
            created.push({ name, description });
            const key = GROUP_KEYS.find((k) => GROUP_DEFINITIONS[k].name === name);
            return { id: GROUP_IDS[key], name, description };
          },
        });

        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' }, brandRoot });

        ctx.expect(result.status).toBe('success');
        ctx.expect(created).toEqual(GROUP_KEYS.map((key) => ({ name: GROUP_DEFINITIONS[key].name, description: GROUP_DEFINITIONS[key].description })));
        ctx.expect(result.output.unsubscribeGroups.created).toBe(GROUP_KEYS.length);

        const written = readConfigSource(brandRoot);
        for (const key of GROUP_KEYS) {
          ctx.expect(written.includes(`${key}: ${GROUP_IDS[key]},`), `${key} id landed in omega.json5`).toBeTruthy();
        }
        ctx.expect(written.includes('// Fixture Brand — hand-edited writeback target')).toBeTruthy();
      },
    },

    {
      name: 'campaigns: groups already on the account are matched by NAME, never recreated',
      run: async (ctx) => {
        // The sibling-brand case: another brand on this SendGrid account made them,
        // so this brand adopts the SAME ids instead of creating duplicates
        const api = fakeSendgrid(convergedResponses());

        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' }, brandRoot });

        ctx.expect(api.callsTo('createUnsubscribeGroup').length).toBe(0);
        ctx.expect(result.output.unsubscribeGroups.created).toBe(0);

        const written = readConfigSource(brandRoot);
        for (const key of GROUP_KEYS) {
          ctx.expect(written.includes(`${key}: ${GROUP_IDS[key]},`), `${key} id landed in omega.json5`).toBeTruthy();
        }
      },
    },

    {
      name: 'campaigns: only the groups missing from the account are created',
      run: async (ctx) => {
        const present = GROUP_KEYS.filter((key) => key !== 'security' && key !== 'internal');
        const api = fakeSendgrid({
          ...convergedResponses(),
          getUnsubscribeGroups: accountGroups(present),
          createUnsubscribeGroup: (name, description) => {
            const key = GROUP_KEYS.find((k) => GROUP_DEFINITIONS[k].name === name);
            return { id: GROUP_IDS[key], name, description };
          },
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' }, brandRoot: makeBrandRoot(WRITEBACK_CONFIG) });

        ctx.expect(api.callsTo('createUnsubscribeGroup').map((c) => c.args[0])).toEqual([GROUP_DEFINITIONS.security.name, GROUP_DEFINITIONS.internal.name]);
        ctx.expect(result.output.unsubscribeGroups.created).toBe(2);
      },
    },

    {
      name: 'campaigns: a brand whose config already carries the ids writes nothing',
      run: async (ctx) => {
        const configuredRoot = makeBrandRoot(GROUPS_WRITEBACK_CONFIG);
        const before = readConfigSource(configuredRoot);

        const result = await runService(
          brandConfig({ listId: 'lst_1', groups: GROUP_IDS }),
          { sendgrid: fakeSendgrid(convergedResponses()), brandRoot: configuredRoot },
        );

        ctx.expect(result.output.unsubscribeGroups.written).toBe(0);
        ctx.expect(readConfigSource(configuredRoot)).toBe(before);
      },
    },

    // ─── custom-fields ───────────────────────────────────────────────────────────

    {
      name: 'campaigns: the two name fields SendGrid stores natively are never custom fields (#695)',
      run: async (ctx) => {
        // First/last name live in SendGrid's RESERVED contact columns, native on its
        // provider row, so the one `fieldsForProvider()` derivation leaves them out on
        // BOTH sides: never provisioned here, never written by the contact sync.
        const names = SENDGRID_FIELDS.map((field) => field.name);
        ctx.expect(!names.includes('user_personal_name_first'), `the first-name field is native, got ${names.join(', ')}`).toBeTruthy();
        ctx.expect(!names.includes('user_personal_name_last'), `the last-name field is native, got ${names.join(', ')}`).toBeTruthy();

        // And an account carrying that view converges with nothing created — the two
        // names are not missing fields, they are fields SendGrid owns
        const api = fakeSendgrid(convergedResponses());

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.customFields.total).toBe(SENDGRID_FIELDS.length);
        ctx.expect(api.callsTo('createCustomField')).toEqual([]);
      },
    },

    {
      name: 'campaigns: missing and type-mismatched fields are created/recreated from the SSOT',
      run: async (ctx) => {
        const converged = convergedResponses().getCustomFields;
        const initial = converged.slice(1); // first field missing
        initial[0] = { ...initial[0], field_type: 'Text' === initial[0].field_type ? 'Number' : 'Text' }; // second mismatched

        let reads = 0;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getCustomFields: () => (reads += 1) === 1 ? structuredClone(initial) : structuredClone(converged),
          deleteCustomField: null,
          createCustomField: { id: 'f_new' },
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('deleteCustomField')[0].args).toEqual([initial[0].id]);
        ctx.expect(api.callsTo('createCustomField').length).toBe(2); // the missing one + the recreated one
        ctx.expect(result.output.customFields.created).toBe(1);
        ctx.expect(result.output.customFields.recreated).toBe(1);
      },
    },

    // ─── segments ────────────────────────────────────────────────────────────────

    {
      name: 'campaigns: stale segments PATCH in place, missing ones are created, __temp_ orphans are swept',
      run: async (ctx) => {
        const list = convergedResponses().getSegments;
        const initial = [{ id: 'tmp1', name: '__temp_leak' }, ...list.slice(1)]; // segment 0 missing
        const staleId = 'seg1';
        const expectedDsl = (i) => buildQueryDsl(SENDGRID_SEGMENTS[i].conditions, SENDGRID_SEGMENTS[i].logic);

        let reads = 0;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getSegments: () => (reads += 1) === 1 ? structuredClone(initial) : structuredClone(list),
          getSegment: (id) => id === staleId
            ? { id, name: SENDGRID_SEGMENTS[1].name, query_dsl: 'SELECT stale' }
            : convergedResponses().getSegment(id),
          updateSegment: {},
          deleteSegment: null,
          createSegment: { id: 'seg_new' },
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('deleteSegment')[0].args).toEqual(['tmp1']);
        ctx.expect(api.callsTo('updateSegment')[0].args).toEqual([staleId, SENDGRID_SEGMENTS[1].name, expectedDsl(1)]);
        ctx.expect(api.callsTo('createSegment')[0].args).toEqual([SENDGRID_SEGMENTS[0].name, expectedDsl(0)]);
      },
    },

    {
      name: 'campaigns: a rejected segment PATCH falls back to delete + recreate',
      run: async (ctx) => {
        const list = convergedResponses().getSegments;
        const staleId = 'seg2';

        let reads = 0;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getSegments: () => { reads += 1; return structuredClone(list); },
          getSegment: (id) => id === staleId
            ? { id, name: SENDGRID_SEGMENTS[2].name, query_dsl: 'SELECT stale' }
            : convergedResponses().getSegment(id),
          updateSegment: () => { throw new Error('PATCH not supported for this segment'); },
          deleteSegment: null,
          createSegment: { id: 'seg_recreated' },
        });

        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('deleteSegment')[0].args).toEqual([staleId]);
        ctx.expect(api.callsTo('createSegment')[0].args[0]).toBe(SENDGRID_SEGMENTS[2].name);
      },
    },

    // ─── event-webhook ───────────────────────────────────────────────────────────

    {
      name: 'campaigns: a missing OMEGA_WEBHOOK_KEY is MINTED in place — the webhook is managed, never skipped (#635)',
      run: async (ctx) => {
        const api = fakeSendgrid({ ...convergedResponses(), updateEventWebhookSettings: {} });

        await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' }, webhookKey: false });

        // OMEGA mints its own key, so the run never steps aside for it
        const minted = process.env.OMEGA_WEBHOOK_KEY;
        ctx.expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // ...and the freshly minted key is what the forwarder URL is built from
        ctx.expect(api.callsTo('getEventWebhookSettings').length).toBe(1);
        ctx.expect(api.callsTo('updateEventWebhookSettings').map((c) => c.args)).toEqual([
          [{ url: `https://api.${DOMAIN}/omega/marketing/webhook/forward?provider=sendgrid&key=${minted}` }],
        ]);
      },
    },

    {
      name: 'campaigns: a company that resolved no url → nothing to point the webhook at',
      run: async (ctx) => {
        const api = fakeSendgrid(convergedResponses());

        const result = await runService(brandConfig({ company: { id: 'parent-brand', url: null, images: {} } }), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('getEventWebhookSettings').length).toBe(0);
        ctx.expect(result.output.eventWebhook).toBe(undefined);
      },
    },

    {
      name: 'campaigns: a company on a default Pages host points the Event Webhook at its project\'s Cloud Functions forwarder',
      run: async (ctx) => {
        const api = fakeSendgrid({ ...convergedResponses(), updateEventWebhookSettings: {} });

        const result = await runService(
          brandConfig({ company: { id: 'parent-brand', url: 'https://parent-org.github.io/parent-brand-web', images: {} } }),
          { sendgrid: api, serviceData: { listId: 'lst_1' }, companyConfig: { cloud: { config: { projectId: 'parent-app' } } } },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('updateEventWebhookSettings')[0].args[0]).toEqual({
          url: `https://us-central1-parent-app.cloudfunctions.net/omega_api/omega/marketing/webhook/forward?provider=sendgrid&key=${WEBHOOK_KEY}`,
        });
      },
    },

    {
      name: 'campaigns: a company on a default Pages host with no project id is no forwarder to point the Event Webhook at',
      run: async (ctx) => {
        const api = fakeSendgrid(convergedResponses());

        const result = await runService(brandConfig({ company: { id: 'parent-brand', url: 'https://parent-org.github.io/parent-brand-web', images: {} } }), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('getEventWebhookSettings').length, 'never api.parent-org.github.io, a host nobody serves').toBe(0);
        ctx.expect(result.output.eventWebhook).toBe(undefined);
      },
    },

    {
      name: 'campaigns: company.webhooks = false is the deliberate account opt-out (#677)',
      run: async (ctx) => {
        // The playground's real state: the SendGrid ACCOUNT is shared with brands
        // this walk does not own, and its one account-level webhook is theirs.
        const api = fakeSendgrid(convergedResponses());

        const result = await runService(brandConfig({ webhooks: false }), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('getEventWebhookSettings').length).toBe(0);
        ctx.expect(result.output.eventWebhook).toBe(undefined);
      },
    },

    {
      name: 'campaigns: webhook drift is patched with the minimum diff against the parent forwarder',
      run: async (ctx) => {
        const parentUrl = `https://api.parent-brand.test/omega/marketing/webhook/forward?provider=sendgrid&key=${WEBHOOK_KEY}`;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getEventWebhookSettings: {
            enabled: true, url: 'https://old.example.com/hook',
            bounce: true, dropped: false, spam_report: true, unsubscribe: true, group_unsubscribe: true,
          },
          updateEventWebhookSettings: {},
        });

        const result = await runService(brandConfig({ company: { id: 'parent-brand', url: 'https://parent-brand.test', images: {} } }), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('updateEventWebhookSettings')[0].args[0]).toEqual({ url: parentUrl, dropped: true });
      },
    },

    // ─── no person ───────────────────────────────────────────────────────────────

    {
      name: 'campaigns: the walk has no contact-person operation and converges without a person',
      run: async (ctx) => {
        ctx.expect(OPERATIONS.campaigns.map((operation) => operation.name).includes('contact-person')).toBe(false);

        const api = fakeSendgrid(convergedResponses());
        const result = await runService(brandConfig(), { sendgrid: api, serviceData: { listId: 'lst_1' } });

        ctx.expect(result.status, result.error).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'campaigns: dry-run on a fully drifted brand performs zero mutations',
      run: async (ctx) => {
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [],
          getBrandedLinks: [],
          getVerifiedSenders: [],
          getListByName: () => undefined,
          getUnsubscribeGroups: [],
          getCustomFields: [],
          getSegments: [{ id: 'tmp1', name: '__temp_leak' }],
          getEventWebhookSettings: { enabled: false, url: '', bounce: false, dropped: false, spam_report: false, unsubscribe: false, group_unsubscribe: false },
        });
        const cf = fakeCf();

        const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, options: { dryRun: true } });

        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(cf.writes()).toEqual([]);
        ctx.expect(result.output.domainAuth.planned).toEqual(['authenticate-domain', 'dns-records', 'validate']);
        ctx.expect(result.output.linkBranding.planned).toEqual(['brand-links', 'dns-records', 'validate', 'proxy-record']);
        ctx.expect(Object.entries(result.output.senderIdentities || {}).map(([key, row]) => [key, row.planned]).sort(), 'one planned sender per row')
          .toEqual(SENDER_KEYS.map((key) => [key, 'create-sender']).sort());
        ctx.expect(result.output.list.planned).toBe('create');
        ctx.expect(result.output.unsubscribeGroups.planned.create).toEqual(GROUP_KEYS.map((key) => GROUP_DEFINITIONS[key].name));
        ctx.expect(result.output.customFields.planned.create.length).toBe(SENDGRID_FIELDS.length);
        ctx.expect(result.output.segments.planned.create.length).toBe(SENDGRID_SEGMENTS.length);
        ctx.expect(result.output.segments.planned.sweepOrphans).toBe(1);
        ctx.expect(result.output.eventWebhook.planned.includes('url')).toBeTruthy();
      },
    },

    // ─── domain-auth: interactive validation poll ────────────────────────────────

    {
      name: 'campaigns: interactive run polls validation until DNS propagates',
      run: async (ctx) => {
        let validations = 0;
        const api = fakeSendgrid({
          ...convergedResponses(),
          getAuthenticatedDomains: [],
          authenticateDomain: { id: 111, domain: DOMAIN, dns: DNS_FIXTURE },
          validateDomain: () => {
            validations++;
            return structuredClone(validations === 1 ? VALIDATION_PENDING : VALIDATION_OK);
          },
        });
        const cf = fakeCf();
        const tty = openTtyPrompt();

        try {
          const result = await runService(brandConfig(), { sendgrid: api, cloudflare: cf, serviceData: { listId: 'lst_1' } });

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.domainAuth.valid).toBe(true);
          ctx.expect(validations).toBe(2); // initial attempt + the poll's first re-check
        } finally {
          tty.close();
        }
      },
    },
  ],
});
