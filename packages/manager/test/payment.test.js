/**
 * Payment service tests — all 11 operations against method-level recording
 * fakes for Stripe, PayPal, and Chargebee. Proves skip semantics (enabled
 * flag, paid-product gate, per-provider credentials, --provider filter,
 * config `false` disables), the converged zero-mutation no-op across all
 * three providers, product resolution self-heal (Stripe by metadata,
 * PayPal by exact name, Chargebee by deterministic ID), price/plan drift
 * reconciliation, webhook create/diff/re-enable with exact payloads, the
 * no-API manual-guidance ops (radar/disputes warned until confirmed), and
 * the dry-run zero-mutation guarantee on a fully drifted account.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/payment/index.js');
const { openTtyPrompt } = require('./lib/interactive.js');

// Tests must never see real credentials from the shell environment
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_SECRET;
delete process.env.CHARGEBEE_API_KEY;
delete process.env.OMEGA_WEBHOOK_KEY;

const BRAND_ID = 'fixture-brand';
const DOMAIN = 'fixture-brand.test';
const BRAND_NAME = 'Fixture Brand';
const BRAND_URL = `https://${DOMAIN}`;
const BRAND_DESC = 'A fixture brand';
const CONTACT_EMAIL = `support@${DOMAIN}`;
// A brand with no domain of its own: brand.url is its GitHub Pages address
const PAGES_URL = 'https://dreamr-design.github.io/dreamr-web';
const BRANDMARK = `${BRAND_URL}/brandmark.png`;
const WEBHOOK_KEY = 'fixture-webhook-key';
const STRIPE_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?provider=stripe&key=${WEBHOOK_KEY}`;
const PAYPAL_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?provider=paypal&key=${WEBHOOK_KEY}`;
const CHARGEBEE_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?provider=chargebee&brand=${BRAND_ID}&key=${WEBHOOK_KEY}`;

// Legacy twins on the brand's OWN host (omega-manager wrote `?processor=`) and
// a stranger on another host: only the twins are stale (#570)
const STRIPE_LEGACY_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?processor=stripe&key=${WEBHOOK_KEY}`;
const PAYPAL_LEGACY_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?processor=paypal&key=${WEBHOOK_KEY}`;
const CHARGEBEE_LEGACY_WEBHOOK_URL = `https://api.${DOMAIN}/omega/payments/webhook?processor=chargebee&brand=${BRAND_ID}&key=${WEBHOOK_KEY}`;
const FOREIGN_WEBHOOK_URL = 'https://api.someone-else.test/omega/payments/webhook?provider=stripe&key=not-ours';

// Mirrors of the handlers' event lists (pins the desired sets)
const STRIPE_EVENTS = [
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'customer.subscription.trial_will_end',
  'invoice.created', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed',
  'invoice.payment_action_required',
  'checkout.session.completed', 'charge.succeeded', 'charge.failed', 'charge.refunded',
  'payment_intent.succeeded', 'payment_intent.payment_failed',
];
const PAYPAL_EVENTS = [
  'BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'CHECKOUT.ORDER.COMPLETED', 'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.DENIED', 'PAYMENT.SALE.REFUNDED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED',
  'INVOICING.INVOICE.CREATED', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED',
];
const CHARGEBEE_EVENTS = [
  'subscription_created', 'subscription_started', 'subscription_activated', 'subscription_changed',
  'subscription_cancelled', 'subscription_paused', 'subscription_resumed', 'subscription_renewed',
  'subscription_reactivated', 'subscription_trial_end_reminder',
  'payment_succeeded', 'payment_failed', 'payment_refunded',
  'invoice_generated', 'invoice_updated',
];

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Product set: a free tier (no prices — never reconciled), a subscription
 * with a trial, a one-time product, and an archived leftover (never
 * reconciled). Per-provider IDs are injected per test via `ids`.
 */
function makeProducts({ ids = {} } = {}) {
  return [
    { id: 'free', name: 'Free', type: 'subscription' },
    {
      id: 'plus',
      name: 'Plus',
      type: 'subscription',
      trial: { days: 14 },
      prices: { monthly: 10, annually: 100 },
      ...(ids.plus || {}),
    },
    {
      id: 'credits',
      name: 'Credits',
      type: 'one-time',
      prices: { once: 5 },
      ...(ids.credits || {}),
    },
    { id: 'old', name: 'Old', type: 'subscription', archived: true, prices: { monthly: 3 } },
  ];
}

function brandConfig({ url = BRAND_URL, products = makeProducts(), payment = {}, brandmark = BRANDMARK, firebase = {} } = {}) {
  const paymentDefaults = structuredClone(DEFAULTS.payment);
  return {
    brand: {
      id: BRAND_ID,
      name: BRAND_NAME,
      url,
      description: BRAND_DESC,
      contact: { email: CONTACT_EMAIL },
      images: brandmark ? { brandmark } : {},
    },
    cloud: { shared: false, ...firebase },
    payment: {
      ...paymentDefaults,
      ...payment,
      providers: { ...paymentDefaults.providers, ...(payment.providers || {}) },
      products,
    },
    targets: { web: { type: 'web' }, backend: { type: 'backend' } },
  };
}

/** Method-level recording fake — a call with no configured response throws LOUDLY. */
function makeFake(name, readMethods, mutatingMethods, responses, { syncMethods = [], props = {} } = {}) {
  const api = { calls: [], ...props };

  for (const method of [...readMethods, ...mutatingMethods]) {
    const respond = (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`${name}: unexpected call ${method}(${JSON.stringify(args)})`);
      }
      const responder = responses[method];
      const result = typeof responder === 'function' ? responder(...args) : structuredClone(responder);
      return result;
    };
    // getAccountInfo is synchronous on the real PayPalAPI
    api[method] = syncMethods.includes(method) ? respond : async (...args) => respond(...args);
  }

  api.mutations = () => api.calls.filter((c) => mutatingMethods.includes(c.method));
  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

const STRIPE_READS = ['getAccount', 'getProduct', 'listAllProducts', 'listPricesForProduct', 'listWebhookEndpoints'];
const STRIPE_MUTATIONS = ['updateAccount', 'createProduct', 'updateProduct', 'createRecurringPrice', 'createOneTimePrice', 'archivePrice', 'createWebhookEndpoint', 'updateWebhookEndpoint', 'deleteWebhookEndpoint'];
const fakeStripe = (responses = {}) => makeFake('fakeStripe', STRIPE_READS, STRIPE_MUTATIONS, responses);

const PAYPAL_READS = ['getAccessToken', 'getAccountInfo', 'listProducts', 'getProduct', 'listPlansForProduct', 'listWebhooks'];
const PAYPAL_MUTATIONS = ['createProduct', 'updateProduct', 'createPlan', 'deactivatePlan', 'createWebhook', 'updateWebhook', 'deleteWebhook'];
const fakePaypal = (responses = {}) => makeFake('fakePaypal', PAYPAL_READS, PAYPAL_MUTATIONS, responses, { syncMethods: ['getAccountInfo'] });

const CHARGEBEE_READS = ['makeRequest', 'getItemFamily', 'getItem', 'listItemPricesForItem', 'getPlan', 'listWebhooks'];
const CHARGEBEE_MUTATIONS = ['createItemFamily', 'updateItemFamily', 'createItem', 'updateItem', 'createItemPrice', 'updateItemPrice', 'createWebhook', 'updateWebhook', 'deleteWebhook'];
const fakeChargebee = (responses = {}) => makeFake('fakeChargebee', CHARGEBEE_READS, CHARGEBEE_MUTATIONS, responses, { props: { site: 'fixture-site' } });

// ─── Converged responders ────────────────────────────────────────────────────

const STRIPE_ACCOUNT = {
  id: 'acct_1',
  business_profile: { name: BRAND_NAME, url: BRAND_URL, support_email: CONTACT_EMAIL, support_url: BRAND_URL },
};

function stripeConverged() {
  return {
    getAccount: STRIPE_ACCOUNT,
    getProduct: (id) => ({
      id,
      active: true,
      name: id === 'prod_plus' ? `${BRAND_NAME} - Plus` : `${BRAND_NAME} - Credits`,
      description: BRAND_DESC,
      url: BRAND_URL,
      images: [BRANDMARK],
      metadata: { brandId: BRAND_ID, productId: id === 'prod_plus' ? 'plus' : 'credits' },
    }),
    listPricesForProduct: (id) => (id === 'prod_plus'
      ? [
        { id: 'price_m', active: true, recurring: { interval: 'month' }, unit_amount: 1000 },
        { id: 'price_y', active: true, recurring: { interval: 'year' }, unit_amount: 10000 },
      ]
      : [{ id: 'price_o', active: true, unit_amount: 500 }]),
    listWebhookEndpoints: { data: [{ id: 'we_1', url: STRIPE_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] }] },
  };
}

function paypalPlan(id, intervalUnit, value, trialDays) {
  const cycles = [];
  if (trialDays > 0) {
    cycles.push({ tenure_type: 'TRIAL', total_cycles: trialDays });
  }
  cycles.push({
    tenure_type: 'REGULAR',
    frequency: { interval_unit: intervalUnit },
    pricing_scheme: { fixed_price: { value } },
  });
  return { id, name: `plan ${id}`, status: 'ACTIVE', billing_cycles: cycles };
}

function paypalConverged() {
  return {
    getAccessToken: 'token',
    getAccountInfo: { appId: 'APP-1', environment: 'live', clientId: 'client-id-fixture' },
    getProduct: (id) => ({
      id,
      name: id === 'PROD-PLUS' ? `${BRAND_NAME} - Plus` : `${BRAND_NAME} - Credits`,
      description: BRAND_DESC,
      image_url: BRANDMARK,
      home_url: BRAND_URL,
    }),
    // Plus configures trial days, so each interval carries TWIN plans: the
    // trial twin and the skip-trial twin (#761)
    listPlansForProduct: (id) => (id === 'PROD-PLUS'
      ? [
        paypalPlan('P-M', 'MONTH', '10.00', 14),
        paypalPlan('P-M-NT', 'MONTH', '10.00', 0),
        paypalPlan('P-Y', 'YEAR', '100.00', 14),
        paypalPlan('P-Y-NT', 'YEAR', '100.00', 0),
      ]
      : []),
    listWebhooks: { webhooks: [{ id: 'WH-1', url: PAYPAL_WEBHOOK_URL, event_types: PAYPAL_EVENTS.map((name) => ({ name })) }] },
  };
}

function chargebeeConverged() {
  return {
    makeRequest: { list: [] }, // account probe
    getItemFamily: { id: BRAND_ID, name: BRAND_NAME },
    getItem: (id) => ({
      id,
      name: id === `${BRAND_ID}-plus` ? `${BRAND_NAME} - Plus` : `${BRAND_NAME} - Credits`,
      external_name: id === `${BRAND_ID}-plus` ? 'Plus' : 'Credits',
      description: BRAND_DESC,
      redirect_url: BRAND_URL,
      metadata: { brandId: BRAND_ID, productId: id === `${BRAND_ID}-plus` ? 'plus' : 'credits' },
    }),
    listItemPricesForItem: (id) => (id === `${BRAND_ID}-plus`
      ? [
        { id: `${BRAND_ID}-plus-monthly`, price: 1000, status: 'active', trial_period: 14, external_name: `${BRAND_NAME} - Plus (Monthly)` },
        { id: `${BRAND_ID}-plus-annually`, price: 10000, status: 'active', trial_period: 14, external_name: `${BRAND_NAME} - Plus (Annually)` },
      ]
      : []),
    listWebhooks: [{ id: 'cbwh_1', url: CHARGEBEE_WEBHOOK_URL, disabled: false }],
  };
}

// Config where every provider already knows its product IDs
const CONVERGED_IDS = {
  plus: { stripe: { productId: 'prod_plus' }, paypal: { productId: 'PROD-PLUS' } },
  credits: { stripe: { productId: 'prod_credits' }, paypal: { productId: 'PROD-CREDITS' } },
};

const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

/** Writeback target mirroring the config's products — matcher paths self-locate by id. */
function writebackSource(config) {
  const rows = (config.payment?.products || []).map((p) => `      { id: '${p.id}' }, // ${p.name || p.id}`).join('\n');
  return `// Payment fixture — comments must survive product-id writeback\n{\n  payment: {\n    products: [\n${rows}\n    ],\n  },\n}\n`;
}

/**
 * The two Dashboard-only confirmations live in config now (#434), so a
 * fixture brand that has already stamped them says so there.
 * true = both, 'radar' / 'disputes' = just that one.
 */
function withConfirmed(config, confirmed) {
  if (!confirmed) {
    return config;
  }

  const stripe = {
    ...config.payment?.providers?.stripe,
    ...(confirmed === true || confirmed === 'radar' ? { radarConfirmed: true } : {}),
    ...(confirmed === true || confirmed === 'disputes' ? { disputesConfirmed: true } : {}),
  };

  return {
    ...config,
    payment: { ...config.payment, providers: { ...config.payment?.providers, stripe } },
  };
}

function runService(rawConfig, { stripe = null, paypal = null, chargebee = null, options = {}, confirmed = false, webhookKey = true, brandRoot } = {}) {
  if (webhookKey) {
    process.env.OMEGA_WEBHOOK_KEY = WEBHOOK_KEY;
  } else {
    delete process.env.OMEGA_WEBHOOK_KEY;
  }

  const config = withConfirmed(rawConfig, confirmed);

  return service.run({
    brandId: BRAND_ID,
    brandRoot: brandRoot || makeBrandRoot(writebackSource(config)), // product ops write into config/omega.json5 here
    brandConfig: config,
    brand: { id: BRAND_ID, config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.payment,
    options,
    stripeApi: stripe,
    paypalApi: paypal,
    chargebeeApi: chargebee,
  });
}

// #348 (buyer half) — PayPal mints no sandbox buyer through any API, so the
// walk reminds instead of precreating: sandbox runs close paypal-products with
// the buyer note, live runs and unconfigured PayPal stay silent.

/** Capture console.log lines around a walk run (the walk's report is console output). */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

const BUYER_REMINDER = 'sandbox BUYER account';

// ─── Interactive provider credential entry (config-landing flow) ────────────

const { providerSetupFlow } = require('../src/services/payment/lib/provider-setup.js');
const { readFileSync, existsSync } = require('node:fs');
const { join: joinPath } = require('node:path');

const PROVIDER_FLOW_CONFIG = `{
  // Fixture Brand — provider writeback target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  payment: {
    providers: {
      stripe: { updateAccountInfo: true }, // publishableKey lands here
    },
  },
}
`;

function providerFlowContext(brandRoot) {
  return {
    brandId: 'fixture-brand',
    brandRoot,
    options: {},
    brandConfig: {
      brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
      payment: { providers: { stripe: { updateAccountInfo: true } } },
      // A payment secret is the backend's: a brand with no backend is never asked for one
      targets: { backend: { type: 'backend' } },
    },
  };
}

// ─── Coinbase Commerce: the ask with no public half (#642) ──────────────────

const COINBASE_FLOW_CONFIG = `{
  // Fixture Brand — provider writeback target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  payment: {
    providers: {
      coinbase: { enabled: true }, // the whole switch
    },
  },
}
`;

function coinbaseFlowContext(brandRoot) {
  return {
    brandId: 'fixture-brand',
    brandRoot,
    options: {},
    brandConfig: {
      brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
      payment: { providers: { coinbase: { enabled: true } } }, targets: { backend: { type: 'backend' } },
    },
  };
}

module.exports = defineCases({
  type: 'group',
  description: 'payment',
  tests: [
    // ─── Defaults pins ───────────────────────────────────────────────────────────

    {
      name: 'payment: manager defaults — enabled, null public keys, radar rules, NO company organizationId',
      run: (ctx) => {
        ctx.expect(DEFAULTS.payment.enabled).toBe(true);
        ctx.expect(DEFAULTS.payment.providers.stripe.publishableKey).toBe(null);
        ctx.expect(DEFAULTS.payment.providers.stripe.updateAccountInfo).toBe(true);
        ctx.expect(DEFAULTS.payment.providers.stripe.radar.length).toBe(9);
        ctx.expect(DEFAULTS.payment.providers.paypal.clientId).toBe(null);
        ctx.expect(DEFAULTS.payment.providers.chargebee.site).toBe(null);
        // #642: the coinbase provider is real again (Coinbase Commerce, crypto,
        // one-time purchases), so the default advertises one that exists — and it is
        // OFF, because its whole credential is a secret the manager cannot detect.
        // #636 deleted the stub for the opposite reason: back then nothing read it.
        ctx.expect(DEFAULTS.payment.providers.coinbase.enabled).toBe(false);
        ctx.expect(DEFAULTS.payment.products).toEqual([]);
        // De-ITW pins: no company Stripe org ID; product images come from
        // brand.images.brandmark, not a hardcoded company CDN
        ctx.expect(!('organizationId' in DEFAULTS.payment.providers.stripe)).toBeTruthy();
      },
    },

    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'payment: payment.enabled = false skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ payment: { enabled: false } }), { stripe: fakeStripe() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/payment\.enabled/);
      },
    },

    {
      name: 'payment: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { stripe: fakeStripe() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'payment: skips when no product has prices (free/archived only)',
      run: async (ctx) => {
        const products = [
          { id: 'free', name: 'Free', type: 'subscription' },
          { id: 'old', name: 'Old', type: 'subscription', archived: true, prices: { monthly: 3 } },
        ];
        const result = await runService(brandConfig({ products }), { stripe: fakeStripe() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no paid products/);
      },
    },

    {
      name: 'payment: skips without any provider credentials, naming all three',
      run: async (ctx) => {
        const result = await runService(brandConfig()); // no injected apis, env scrubbed
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/STRIPE_SECRET_KEY/);
        ctx.expect(result.reason).toMatch(/PAYPAL_CLIENT_SECRET/);
        ctx.expect(result.reason).toMatch(/CHARGEBEE_API_KEY/);
      },
    },

    {
      name: 'payment: --provider filter narrows to that provider and ignores the others’ clients',
      run: async (ctx) => {
        const stripe = fakeStripe();
        const paypal = fakePaypal(paypalConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, { stripe, paypal, options: { provider: 'paypal' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(stripe.calls.length).toBe(0); // filtered out — never touched, not even getAccount
        ctx.expect(paypal.calls.length > 0).toBeTruthy();
      },
    },

    {
      name: 'payment: unknown --provider skips with guidance',
      run: async (ctx) => {
        const result = await runService(brandConfig(), { stripe: fakeStripe(), options: { provider: 'venmo' } });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/unknown --provider "venmo"/);
      },
    },

    {
      name: 'payment: --provider=coinbase asks for the key and then says it reconciles nothing (#642)',
      run: async (ctx) => {
        // Coinbase Commerce is a real provider with ZERO operations: no catalog, no
        // webhook API. Narrowing a run to it must not answer the sibling sentence
        // ("not configured"), which would read as a setup failure on a brand that is
        // configured perfectly well. Non-interactive here, so no gate opens.
        const result = await runService(brandConfig(), { stripe: fakeStripe(), options: { provider: 'coinbase' } });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/coinbase has nothing to reconcile/);
        ctx.expect(result.reason, 'a configured brand is never told it is unconfigured').not.toMatch(/not configured/);
      },
    },

    {
      name: 'payment: providers.stripe = false disables Stripe even with credentials present',
      run: async (ctx) => {
        const stripe = fakeStripe();
        const paypal = fakePaypal(paypalConverged());
        const config = brandConfig({
          products: makeProducts({ ids: CONVERGED_IDS }),
          payment: { providers: { stripe: false, chargebee: false } },
        });

        const result = await runService(config, { stripe, paypal });

        ctx.expect(result.status).toBe('success');
        ctx.expect(stripe.calls.length).toBe(0);
        ctx.expect(paypal.calls.length > 0).toBeTruthy();
      },
    },

    // ─── The flagship: converged account = zero mutations ────────────────────────

    {
      name: 'payment: fully converged across all three providers — reads only, zero mutations',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const paypal = fakePaypal(paypalConverged());
        const chargebee = fakeChargebee(chargebeeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, {
          stripe, paypal, chargebee,
          confirmed: true,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(stripe.mutations()).toEqual([]);
        ctx.expect(paypal.mutations()).toEqual([]);
        ctx.expect(chargebee.mutations()).toEqual([]);

        // Setup resolves the account ID fresh and carries it to the deep-links
        ctx.expect(result.state.stripeAccountId).toBe('acct_1');

        // Free + archived products were never reconciled anywhere
        const stripeProductIds = stripe.callsTo('getProduct').map((c) => c.args[0]);
        ctx.expect(stripeProductIds.sort()).toEqual(['prod_credits', 'prod_plus']);
        const chargebeeItemIds = chargebee.callsTo('getItem').map((c) => c.args[0]);
        ctx.expect(chargebeeItemIds.sort()).toEqual([`${BRAND_ID}-credits`, `${BRAND_ID}-plus`]);
      },
    },

    // ─── Stripe ──────────────────────────────────────────────────────────────────

    {
      name: 'stripe-radar: warned with rules + account deep-link until confirmed',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, { stripe, confirmed: 'disputes' });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.stripeRadar.rules).toBe(9);
        ctx.expect(result.output.stripeRadar.radarUrl).toBe('https://dashboard.stripe.com/acct_1/radar/rules');
        ctx.expect(stripe.mutations()).toEqual([]);
      },
    },

    {
      name: 'stripe-disputes: warned with settings deep-link until confirmed',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, { stripe, confirmed: 'radar' });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.stripeDisputes.disputesUrl).toBe('https://dashboard.stripe.com/acct_1/settings/disputes');
        ctx.expect(stripe.mutations()).toEqual([]);
      },
    },

    {
      name: 'stripe-radar + disputes: Enter-gated opens + interactive confirms stamp both flags, service passes',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        // paypal/chargebee disabled — enabled-but-unconfigured providers would
        // offer their credential-entry flow first in an interactive run
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }), payment: { providers: { paypal: false, chargebee: false } } });

        // pressEnterToOpen launches via prompt's openInBrowser — stub it
        const promptModule = require('@omega.js/devkit/prompt');
        const opened = [];
        const realOpen = promptModule.openInBrowser;
        promptModule.openInBrowser = (url) => { opened.push(url); return true; };
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(writebackSource(config));

        try {
          const run = runService(config, { stripe, brandRoot });
          await tty.answer('Press Enter to open the Stripe Radar rules page', '\r');
          await tty.answer('Radar rules added in the Dashboard?', 'y\r');
          await tty.answer('Press Enter to open the Stripe dispute settings', '\r');
          await tty.answer('Enhanced Dispute Protection activated in the Dashboard?', 'y\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          // Both confirms stamp their home in omega.json5 (#434) — nothing else
          // can re-check them, so the next run believes the file
          const written = readConfigSource(brandRoot);
          ctx.expect(written).toMatch(/radarConfirmed: true/);
          ctx.expect(written).toMatch(/disputesConfirmed: true/);
          ctx.expect(opened).toEqual([
            'https://dashboard.stripe.com/acct_1/radar/rules',
            'https://dashboard.stripe.com/acct_1/settings/disputes',
          ]);
          ctx.expect(stripe.mutations()).toEqual([]);
        } finally {
          promptModule.openInBrowser = realOpen;
          tty.close();
        }
      },
    },

    {
      name: 'stripe-radar: interactive decline stays warned and unstamped',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }), payment: { providers: { paypal: false, chargebee: false } } });

        const promptModule = require('@omega.js/devkit/prompt');
        const realOpen = promptModule.openInBrowser;
        promptModule.openInBrowser = () => true;
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(writebackSource(config));

        try {
          const run = runService(config, { stripe, confirmed: 'disputes', brandRoot });
          await tty.answer('Press Enter to open the Stripe Radar rules page', '\r');
          await tty.answer('Radar rules added in the Dashboard?', 'n\r');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(!readConfigSource(brandRoot).includes('radarConfirmed')).toBeTruthy();
        } finally {
          promptModule.openInBrowser = realOpen;
          tty.close();
        }
      },
    },

    {
      name: 'stripe-radar: dry-run never prompts, even with a TTY',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(writebackSource(config));

        try {
          // No tty.answer — if the handler wrongly prompted, this would time out
          const result = await runService(config, {
            stripe, confirmed: 'disputes', options: { dryRun: true }, brandRoot,
          });

          ctx.expect(result.status).toBe('warned');
          ctx.expect(!readConfigSource(brandRoot).includes('radarConfirmed')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'stripe-account: business profile drift → minimal update payload',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.getAccount = {
          id: 'acct_1',
          business_profile: { name: 'Old Name', url: BRAND_URL, support_email: CONTACT_EMAIL, support_url: BRAND_URL },
        };
        responses.updateAccount = { id: 'acct_1' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('updateAccount').map((c) => c.args)).toEqual([
          ['acct_1', { business_profile: { name: BRAND_NAME } }],
        ]);
      },
    },

    {
      name: 'stripe-products: missing everywhere → exact create payloads + prices + config writeback',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = stripeConverged();
        responses.listAllProducts = []; // nothing to self-heal against
        responses.createProduct = { id: 'prod_new' };
        responses.listPricesForProduct = [];
        responses.createRecurringPrice = (productId, amount, interval) => ({ id: `price_${interval}` });
        const stripe = fakeStripe(responses);

        const config = brandConfig({ products });
        const brandRoot = makeBrandRoot(writebackSource(config));
        const result = await runService(config, {
          stripe, confirmed: true, brandRoot,
        });

        ctx.expect(stripe.callsTo('createProduct').map((c) => c.args)).toEqual([[{
          name: `${BRAND_NAME} - Plus`,
          brandId: BRAND_ID,
          productId: 'plus',
          description: BRAND_DESC,
          images: [BRANDMARK],
          url: BRAND_URL,
        }]]);
        ctx.expect(stripe.callsTo('createRecurringPrice').map((c) => c.args)).toEqual([
          ['prod_new', 10, 'monthly'],
          ['prod_new', 100, 'annually'],
        ]);
        const written = readConfigSource(brandRoot);
        ctx.expect(written.includes(`{ id: 'plus', stripe: { productId: "prod_new" } }, // Plus`)).toBeTruthy();
        ctx.expect(written.includes('// Payment fixture — comments must survive product-id writeback')).toBeTruthy();
      },
    },

    {
      name: 'stripe-products: an unconfigured id self-heals by metadata match — no create',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = stripeConverged();
        responses.listAllProducts = [structuredClone(responses.getProduct('prod_plus'))];
        const stripe = fakeStripe(responses);

        const config = brandConfig({ products });
        const brandRoot = makeBrandRoot(writebackSource(config));
        await runService(config, { stripe, confirmed: true, brandRoot });

        ctx.expect(stripe.callsTo('createProduct').length).toBe(0);
        ctx.expect(stripe.callsTo('getProduct').length).toBe(0); // list objects are full — no refetch
        ctx.expect(readConfigSource(brandRoot).includes(`{ id: 'plus', stripe: { productId: "prod_plus" } }, // Plus`)).toBeTruthy();
      },
    },

    {
      name: 'stripe-products: a self-healed id is also written back into omega.json5',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = stripeConverged();
        responses.listAllProducts = [structuredClone(responses.getProduct('prod_plus'))];
        const config = brandConfig({ products });
        const brandRoot = makeBrandRoot(writebackSource(config));

        await runService(config, {
          stripe: fakeStripe(responses), confirmed: true, brandRoot,
        });

        ctx.expect(readConfigSource(brandRoot).includes(`{ id: 'plus', stripe: { productId: "prod_plus" } }, // Plus`)).toBeTruthy();
      },
    },

    {
      name: 'stripe-products: price drift → stale actives archived, correct price created',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listPricesForProduct = (id) => (id === 'prod_plus'
          ? [
            { id: 'price_m_old', active: true, recurring: { interval: 'month' }, unit_amount: 900 }, // wrong amount
            { id: 'price_y', active: true, recurring: { interval: 'year' }, unit_amount: 10000 },    // converged
          ]
          : [{ id: 'price_o', active: true, unit_amount: 500 }]);
        responses.archivePrice = { id: 'price_m_old', active: false };
        responses.createRecurringPrice = { id: 'price_m_new' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('archivePrice').map((c) => c.args)).toEqual([['price_m_old']]);
        ctx.expect(stripe.callsTo('createRecurringPrice').map((c) => c.args)).toEqual([['prod_plus', 10, 'monthly']]);
      },
    },

    {
      name: 'stripe-webhook: missing → created with exact URL + events',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = { data: [{ id: 'we_other', url: 'https://elsewhere.test/hook', status: 'enabled', enabled_events: ['charge.succeeded'] }] };
        responses.createWebhookEndpoint = { id: 'we_new' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('createWebhookEndpoint').map((c) => c.args)).toEqual([
          [STRIPE_WEBHOOK_URL, STRIPE_EVENTS],
        ]);
      },
    },

    {
      name: 'stripe-webhook: a brand on a default Pages host points the webhook at its Cloud Functions address',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.getAccount = { id: 'acct_1', business_profile: { name: BRAND_NAME, url: PAGES_URL, support_email: CONTACT_EMAIL, support_url: PAGES_URL } };
        responses.updateProduct = (id) => ({ id });
        responses.listWebhookEndpoints = { data: [] };
        responses.createWebhookEndpoint = { id: 'we_new' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ url: PAGES_URL, products: makeProducts({ ids: CONVERGED_IDS }), firebase: { config: { projectId: 'dreamr-app' } } });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('createWebhookEndpoint').map((c) => c.args[0])).toEqual([
          `https://us-central1-dreamr-app.cloudfunctions.net/omega_api/omega/payments/webhook?provider=stripe&key=${WEBHOOK_KEY}`,
        ]);
      },
    },

    {
      name: 'stripe-account: a Pages brand with no contact email skips the profile, never inventing support@<pages host>',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.getAccount = { id: 'acct_1', business_profile: { name: BRAND_NAME, url: PAGES_URL, support_email: null, support_url: PAGES_URL } };
        responses.updateAccount = { id: 'acct_1' };
        responses.updateProduct = (id) => ({ id });
        responses.listWebhookEndpoints = { data: [] };
        responses.createWebhookEndpoint = { id: 'we_new' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ url: PAGES_URL, products: makeProducts({ ids: CONVERGED_IDS }), firebase: { config: { projectId: 'dreamr-app' } } });
        delete config.brand.contact;

        const result = await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('updateAccount')).toEqual([]);
        ctx.expect(result.output.stripeAccount.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
      },
    },

    {
      name: 'stripe-webhook: event drift → single enabled_events update',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = {
          data: [{ id: 'we_1', url: STRIPE_WEBHOOK_URL, status: 'enabled', enabled_events: STRIPE_EVENTS.slice(0, 5).concat(['obsolete.event']) }],
        };
        responses.updateWebhookEndpoint = { id: 'we_1' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('updateWebhookEndpoint').map((c) => c.args)).toEqual([
          ['we_1', { enabled_events: STRIPE_EVENTS }],
        ]);
      },
    },

    {
      name: 'stripe-webhook: disabled endpoint → re-enabled (events already converged)',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = {
          data: [{ id: 'we_1', url: STRIPE_WEBHOOK_URL, status: 'disabled', enabled_events: [...STRIPE_EVENTS] }],
        };
        responses.updateWebhookEndpoint = { id: 'we_1' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.callsTo('updateWebhookEndpoint').map((c) => c.args)).toEqual([
          ['we_1', { disabled: false }],
        ]);
      },
    },

    {
      name: 'stripe-webhook: legacy twin on the brand host → deleted; the desired URL and other hosts untouched',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = {
          data: [
            { id: 'we_1', url: STRIPE_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] },
            { id: 'we_legacy', url: STRIPE_LEGACY_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] },
            { id: 'we_foreign', url: FOREIGN_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] },
          ],
        };
        responses.deleteWebhookEndpoint = { id: 'we_legacy', deleted: true };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const log = captureLog();
        try {
          await runService(config, { stripe, confirmed: true });
        } finally {
          log.restore();
        }

        ctx.expect(stripe.callsTo('deleteWebhookEndpoint').map((c) => c.args)).toEqual([['we_legacy']]);
        ctx.expect(stripe.callsTo('updateWebhookEndpoint')).toEqual([]);
        ctx.expect(stripe.callsTo('createWebhookEndpoint')).toEqual([]);

        // One loud line naming the URL — with the key redacted, never the secret
        const loud = log.lines.filter((line) => line.includes('Deleted stale webhook'));
        ctx.expect(loud.length).toBe(1);
        ctx.expect(loud[0].includes(`https://api.${DOMAIN}/omega/payments/webhook?processor=stripe&key=***`)).toBeTruthy();
        ctx.expect(!log.lines.some((line) => line.includes(WEBHOOK_KEY))).toBeTruthy();
      },
    },

    {
      name: 'stripe-webhook: converged host → a second run still makes no webhook calls',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, confirmed: true });
        await runService(config, { stripe, confirmed: true });

        ctx.expect(stripe.mutations()).toEqual([]);
      },
    },

    {
      name: 'stripe-webhook: dry run on a legacy twin reads only',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = {
          data: [
            { id: 'we_1', url: STRIPE_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] },
            { id: 'we_legacy', url: STRIPE_LEGACY_WEBHOOK_URL, status: 'enabled', enabled_events: [...STRIPE_EVENTS] },
          ],
        };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { stripe, options: { dryRun: true }, confirmed: true });

        ctx.expect(stripe.mutations()).toEqual([]);
      },
    },

    {
      name: 'payment: a missing OMEGA_WEBHOOK_KEY is MINTED in place — the webhook is managed, never skipped (#635)',
      run: async (ctx) => {
        const responses = stripeConverged();
        responses.listWebhookEndpoints = { data: [] };
        responses.createWebhookEndpoint = { id: 'we_new' };
        const stripe = fakeStripe(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, {
          stripe, webhookKey: false,
          confirmed: true,
        });

        // OMEGA mints its own key, so the run never steps aside for it
        const minted = process.env.OMEGA_WEBHOOK_KEY;
        ctx.expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // ...and the freshly minted key is what the webhook URL is built from
        ctx.expect(stripe.callsTo('createWebhookEndpoint').map((c) => c.args)).toEqual([
          [`https://api.${DOMAIN}/omega/payments/webhook?provider=stripe&key=${minted}`, STRIPE_EVENTS],
        ]);
      },
    },

    {
      name: 'payment: firebase.shared brand → webhook operations skip without touching the API',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }), firebase: { shared: true } });

        const result = await runService(config, {
          stripe, confirmed: true,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(stripe.callsTo('listWebhookEndpoints').length).toBe(0);
        ctx.expect(stripe.mutations()).toEqual([]);
      },
    },

    // ─── PayPal ──────────────────────────────────────────────────────────────────

    {
      name: 'paypal-account: reports environment + app ID',
      run: async (ctx) => {
        const paypal = fakePaypal(paypalConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.paypalAccount).toEqual({ authenticated: true, environment: 'live', appId: 'APP-1' });
      },
    },

    {
      name: 'paypal-account: auth failure → warned, then the webhook operation fails the service',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.getAccessToken = () => {
          throw new Error('PayPal auth failed on both live and sandbox — check paypal.clientId and PAYPAL_CLIENT_SECRET');
        };
        delete responses.listWebhooks; // auth is down — any webhook call explodes too
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const result = await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.output.paypalAccount.authenticated).toBe(false);
        ctx.expect(paypal.mutations()).toEqual([]);
      },
    },

    {
      name: 'paypal-products: missing everywhere → exact product + plan create payloads + config writeback',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = paypalConverged();
        responses.listProducts = []; // nothing to self-heal against
        responses.createProduct = { id: 'PROD-NEW' };
        responses.listPlansForProduct = [];
        responses.createPlan = ({ interval }) => ({ id: `P-NEW-${interval}` });
        const paypal = fakePaypal(responses);

        const config = brandConfig({ products });
        const brandRoot = makeBrandRoot(writebackSource(config));
        const result = await runService(config, { paypal, options: { provider: 'paypal' }, brandRoot });

        ctx.expect(paypal.callsTo('createProduct').map((c) => c.args)).toEqual([[{
          name: `${BRAND_NAME} - Plus`,
          description: BRAND_DESC,
          type: 'SERVICE',
          imageUrl: BRANDMARK,
          homeUrl: BRAND_URL,
        }]]);
        ctx.expect(paypal.callsTo('createPlan').map((c) => c.args)).toEqual([
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Monthly)`, interval: 'monthly', amount: 10, trialDays: 14 }],
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Monthly, no trial)`, interval: 'monthly', amount: 10, trialDays: 0 }],
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Annually)`, interval: 'annually', amount: 100, trialDays: 14 }],
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Annually, no trial)`, interval: 'annually', amount: 100, trialDays: 0 }],
        ]);
        ctx.expect(readConfigSource(brandRoot).includes(`{ id: 'plus', paypal: { productId: "PROD-NEW" } }, // Plus`)).toBeTruthy();
      },
    },

    {
      name: 'paypal-products: an unconfigured id self-heals by exact name match — no create',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = paypalConverged();
        responses.listProducts = [{ id: 'PROD-PLUS', name: `${BRAND_NAME} - Plus` }]; // summarized list entry
        const paypal = fakePaypal(responses);

        const config = brandConfig({ products });
        const brandRoot = makeBrandRoot(writebackSource(config));
        const result = await runService(config, { paypal, options: { provider: 'paypal' }, brandRoot });

        ctx.expect(paypal.callsTo('createProduct').length).toBe(0);
        ctx.expect(paypal.callsTo('getProduct').length).toBe(1); // list is summarized — full fetch before diffing
        ctx.expect(readConfigSource(brandRoot).includes(`{ id: 'plus', paypal: { productId: "PROD-PLUS" } }, // Plus`)).toBeTruthy();
      },
    },

    {
      name: 'paypal-products: plan drift → stale + duplicate deactivated, correct plan created',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.listPlansForProduct = (id) => (id === 'PROD-PLUS'
          ? [
            paypalPlan('P-M-STALE', 'MONTH', '9.00', 14),   // wrong amount → deactivate + recreate
            paypalPlan('P-M-NT', 'MONTH', '10.00', 0),      // converged skip-trial twin
            paypalPlan('P-Y', 'YEAR', '100.00', 14),        // converged trial twin
            paypalPlan('P-Y-DUP', 'YEAR', '100.00', 14),    // duplicate match → deactivate
            paypalPlan('P-Y-NT', 'YEAR', '100.00', 0),      // converged skip-trial twin
          ]
          : []);
        responses.deactivatePlan = null;
        responses.createPlan = { id: 'P-M-NEW' };
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('deactivatePlan').map((c) => c.args).sort()).toEqual([['P-M-STALE'], ['P-Y-DUP']]);
        ctx.expect(paypal.callsTo('createPlan').map((c) => c.args)).toEqual([
          [{ productId: 'PROD-PLUS', name: `${BRAND_NAME} - Plus (Monthly)`, interval: 'monthly', amount: 10, trialDays: 14 }],
        ]);
      },
    },

    {
      name: 'paypal-products: a trial product mints BOTH twins per interval — trial and skip-trial (#761)',
      run: async (ctx) => {
        // A buyer who is not owed a trial has to land on a plan with no TRIAL cycle
        // to skip, so a trial product carries two active plans per paid interval
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10 } },
        ];
        const responses = paypalConverged();
        responses.listProducts = [];
        responses.createProduct = { id: 'PROD-NEW' };
        responses.listPlansForProduct = [];
        responses.createPlan = ({ trialDays }) => ({ id: trialDays > 0 ? 'P-NEW-TRIAL' : 'P-NEW-NT' });
        const paypal = fakePaypal(responses);

        const config = brandConfig({ products });
        await runService(config, { paypal, options: { provider: 'paypal' }, brandRoot: makeBrandRoot(writebackSource(config)) });

        ctx.expect(paypal.callsTo('createPlan').map((c) => c.args)).toEqual([
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Monthly)`, interval: 'monthly', amount: 10, trialDays: 14 }],
          [{ productId: 'PROD-NEW', name: `${BRAND_NAME} - Plus (Monthly, no trial)`, interval: 'monthly', amount: 10, trialDays: 0 }],
        ]);
        ctx.expect(paypal.callsTo('deactivatePlan')).toEqual([]);
      },
    },

    {
      name: 'paypal-products: converged twins rerun — nothing created, nothing deactivated (#761)',
      run: async (ctx) => {
        // Neither twin is a duplicate or a stale copy of the other, so a second walk
        // over an already-twinned product is read-only
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 }, paypal: { productId: 'PROD-PLUS' } },
        ];
        const paypal = fakePaypal(paypalConverged());
        const config = brandConfig({ products });

        const result = await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(paypal.mutations()).toEqual([]);
      },
    },

    {
      name: 'paypal-products: a stale plan on a trial product is deactivated and BOTH twins created (#761)',
      run: async (ctx) => {
        // The pre-twin world's single plan, at a price config has since moved off:
        // it matches neither twin, so it goes and the pair is minted
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10 }, paypal: { productId: 'PROD-PLUS' } },
        ];
        const responses = paypalConverged();
        responses.listPlansForProduct = (id) => (id === 'PROD-PLUS' ? [paypalPlan('P-M-OLD', 'MONTH', '9.00', 14)] : []);
        responses.deactivatePlan = null;
        responses.createPlan = ({ trialDays }) => ({ id: trialDays > 0 ? 'P-NEW-TRIAL' : 'P-NEW-NT' });
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('deactivatePlan').map((c) => c.args)).toEqual([['P-M-OLD']]);
        ctx.expect(paypal.callsTo('createPlan').map((c) => c.args)).toEqual([
          [{ productId: 'PROD-PLUS', name: `${BRAND_NAME} - Plus (Monthly)`, interval: 'monthly', amount: 10, trialDays: 14 }],
          [{ productId: 'PROD-PLUS', name: `${BRAND_NAME} - Plus (Monthly, no trial)`, interval: 'monthly', amount: 10, trialDays: 0 }],
        ]);
      },
    },

    {
      name: 'paypal-products: legacy product plans are deactivated',
      run: async (ctx) => {
        const ids = structuredClone(CONVERGED_IDS);
        ids.plus.paypal.legacyProductIds = ['PROD-OLD'];
        const responses = paypalConverged();
        const basePlans = responses.listPlansForProduct;
        responses.listPlansForProduct = (id) => (id === 'PROD-OLD'
          ? [paypalPlan('P-LEGACY', 'MONTH', '5.00', 0)]
          : basePlans(id));
        responses.deactivatePlan = null;
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids }) });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('deactivatePlan').map((c) => c.args)).toEqual([['P-LEGACY']]);
      },
    },

    // #348 — `hidden: true` is a PRESENTATION flag the web pricing composer
    // honors; the walk must keep reconciling the product, or the QA tier the
    // payments drives buy by id would have no provider objects to buy.
    {
      name: 'payment: a hidden product is presentation-only — the walk still ensures its provider objects (#348)',
      run: async (ctx) => {
        const products = [
          { id: 'proof-press', name: 'Proof Press', type: 'subscription', hidden: true, prices: { monthly: 5 } },
        ];

        const paypalResponses = paypalConverged();
        paypalResponses.listProducts = [];
        paypalResponses.createProduct = { id: 'PROD-QA' };
        paypalResponses.listPlansForProduct = [];
        paypalResponses.createPlan = { id: 'P-QA' };
        const paypal = fakePaypal(paypalResponses);
        const paypalConfig = brandConfig({ products });
        const paypalRoot = makeBrandRoot(writebackSource(paypalConfig));
        await runService(paypalConfig, { paypal, options: { provider: 'paypal' }, brandRoot: paypalRoot });

        ctx.expect(paypal.callsTo('createProduct').map((c) => c.args)).toEqual([[{
          name: `${BRAND_NAME} - Proof Press`,
          description: BRAND_DESC,
          type: 'SERVICE',
          imageUrl: BRANDMARK,
          homeUrl: BRAND_URL,
        }]]);
        ctx.expect(paypal.callsTo('createPlan').map((c) => c.args)).toEqual([
          [{ productId: 'PROD-QA', name: `${BRAND_NAME} - Proof Press (Monthly)`, interval: 'monthly', amount: 5, trialDays: 0 }],
        ]);
        ctx.expect(readConfigSource(paypalRoot).includes(`{ id: 'proof-press', paypal: { productId: "PROD-QA" } }, // Proof Press`)).toBeTruthy();

        const stripeResponses = stripeConverged();
        stripeResponses.listAllProducts = [];
        stripeResponses.createProduct = { id: 'prod_qa' };
        stripeResponses.listPricesForProduct = [];
        stripeResponses.createRecurringPrice = { id: 'price_qa' };
        const stripe = fakeStripe(stripeResponses);
        const stripeConfig = brandConfig({ products });
        const stripeRoot = makeBrandRoot(writebackSource(stripeConfig));
        await runService(stripeConfig, {
          stripe, options: { provider: 'stripe' }, confirmed: true, brandRoot: stripeRoot,
        });

        ctx.expect(stripe.callsTo('createProduct').map((c) => c.args)).toEqual([[{
          name: `${BRAND_NAME} - Proof Press`,
          brandId: BRAND_ID,
          productId: 'proof-press',
          description: BRAND_DESC,
          images: [BRANDMARK],
          url: BRAND_URL,
        }]]);
        ctx.expect(stripe.callsTo('createRecurringPrice').map((c) => c.args)).toEqual([['prod_qa', 5, 'monthly']]);
        ctx.expect(readConfigSource(stripeRoot).includes(`{ id: 'proof-press', stripe: { productId: "prod_qa" } }, // Proof Press`)).toBeTruthy();
      },
    },

    {
      name: 'paypal-products: sandbox mode closes with the sandbox-buyer reminder (#348)',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.getAccountInfo = { appId: 'APP-1', environment: 'sandbox', clientId: 'client-id-fixture' };
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const log = captureLog();
        let result;
        try {
          result = await runService(config, { paypal, options: { provider: 'paypal' } });
        } finally {
          log.restore();
        }

        ctx.expect(result.status).toBe('success');
        const reminder = log.lines.find((line) => line.includes(BUYER_REMINDER));
        ctx.expect(reminder, 'sandbox run printed no buyer reminder').toBeTruthy();
        ctx.expect(reminder.includes('proof-press'), 'the reminder names the QA fixture product').toBeTruthy();
        const pointer = log.lines.find((line) => line.includes('https://developer.paypal.com/dashboard/accounts'));
        ctx.expect(pointer, 'the reminder points at the Developer Dashboard sandbox accounts page').toBeTruthy();
        ctx.expect(pointer.includes('@omega.js/manager/docs/backend/paypal-sandbox-qa.md'), 'the reminder points at the runbook').toBeTruthy();
        ctx.expect(paypal.mutations()).toEqual([]); // a reminder, never a mutation
      },
    },

    {
      name: 'paypal-products: live mode prints no buyer reminder (#348)',
      run: async (ctx) => {
        const paypal = fakePaypal(paypalConverged()); // environment: 'live'
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        const log = captureLog();
        try {
          await runService(config, { paypal, options: { provider: 'paypal' } });
        } finally {
          log.restore();
        }

        ctx.expect(!log.lines.some((line) => line.includes(BUYER_REMINDER))).toBeTruthy();
      },
    },

    {
      name: 'paypal-products: unconfigured PayPal prints no buyer reminder (#348)',
      run: async (ctx) => {
        const stripe = fakeStripe(stripeConverged());
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) }); // no paypal client injected

        const log = captureLog();
        try {
          await runService(config, { stripe, confirmed: true });
        } finally {
          log.restore();
        }

        ctx.expect(log.lines.some((line) => line.includes('PayPal not configured'))).toBeTruthy();
        ctx.expect(!log.lines.some((line) => line.includes(BUYER_REMINDER))).toBeTruthy();
      },
    },

    {
      name: 'paypal-webhook: missing → created with exact URL + events',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.listWebhooks = { webhooks: [] };
        responses.createWebhook = { id: 'WH-NEW' };
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('createWebhook').map((c) => c.args)).toEqual([
          [PAYPAL_WEBHOOK_URL, PAYPAL_EVENTS],
        ]);
      },
    },

    {
      name: 'paypal-webhook: event drift → single JSON Patch replacing event_types',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.listWebhooks = {
          webhooks: [{ id: 'WH-1', url: PAYPAL_WEBHOOK_URL, event_types: [{ name: 'BILLING.SUBSCRIPTION.CREATED' }] }],
        };
        responses.updateWebhook = { id: 'WH-1' };
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('updateWebhook').map((c) => c.args)).toEqual([
          ['WH-1', [{ op: 'replace', path: '/event_types', value: PAYPAL_EVENTS.map((name) => ({ name })) }]],
        ]);
      },
    },

    {
      name: 'paypal-webhook: legacy twin on the brand host → deleted; the desired URL and other hosts untouched',
      run: async (ctx) => {
        const responses = paypalConverged();
        responses.listWebhooks = {
          webhooks: [
            { id: 'WH-1', url: PAYPAL_WEBHOOK_URL, event_types: PAYPAL_EVENTS.map((name) => ({ name })) },
            { id: 'WH-LEGACY', url: PAYPAL_LEGACY_WEBHOOK_URL, event_types: PAYPAL_EVENTS.map((name) => ({ name })) },
            { id: 'WH-FOREIGN', url: FOREIGN_WEBHOOK_URL, event_types: PAYPAL_EVENTS.map((name) => ({ name })) },
          ],
        };
        responses.deleteWebhook = null;
        const paypal = fakePaypal(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { paypal, options: { provider: 'paypal' } });

        ctx.expect(paypal.callsTo('deleteWebhook').map((c) => c.args)).toEqual([['WH-LEGACY']]);
        ctx.expect(paypal.callsTo('updateWebhook')).toEqual([]);
        ctx.expect(paypal.callsTo('createWebhook')).toEqual([]);
      },
    },

    // ─── Chargebee ───────────────────────────────────────────────────────────────

    {
      name: 'chargebee-products: empty site → exact family + item + price create chain',
      run: async (ctx) => {
        const products = [
          { id: 'plus', name: 'Plus', type: 'subscription', trial: { days: 14 }, prices: { monthly: 10, annually: 100 } },
        ];
        const responses = chargebeeConverged();
        responses.getItemFamily = () => {
          throw new Error('Chargebee API error (404 GET /item_families/fixture-brand): resource_not_found');
        };
        responses.getItem = () => {
          throw new Error('Chargebee API error (404 GET /items/fixture-brand-plus): resource_not_found');
        };
        responses.createItemFamily = { id: BRAND_ID };
        responses.createItem = { id: `${BRAND_ID}-plus` };
        responses.listItemPricesForItem = [];
        responses.createItemPrice = ({ id }) => ({ id });
        const chargebee = fakeChargebee(responses);

        await runService(brandConfig({ products }), { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('createItemFamily').map((c) => c.args)).toEqual([[{
          id: BRAND_ID,
          name: BRAND_NAME,
          description: BRAND_DESC,
        }]]);
        ctx.expect(chargebee.callsTo('createItem').map((c) => c.args)).toEqual([[{
          id: `${BRAND_ID}-plus`,
          name: `${BRAND_NAME} - Plus`,
          externalName: 'Plus',
          type: 'plan',
          itemFamilyId: BRAND_ID,
          description: BRAND_DESC,
          redirectUrl: BRAND_URL,
          metadata: { brandId: BRAND_ID, productId: 'plus' },
        }]]);
        ctx.expect(chargebee.callsTo('createItemPrice').map((c) => c.args)).toEqual([
          [{
            id: `${BRAND_ID}-plus-monthly`, itemId: `${BRAND_ID}-plus`,
            name: `${BRAND_NAME} - Plus (Monthly)`, externalName: `${BRAND_NAME} - Plus (Monthly)`,
            pricingModel: 'flat_fee', price: 1000, currencyCode: 'USD',
            periodUnit: 'month', period: 1, trialPeriod: 14, trialPeriodUnit: 'day',
          }],
          [{
            id: `${BRAND_ID}-plus-annually`, itemId: `${BRAND_ID}-plus`,
            name: `${BRAND_NAME} - Plus (Annually)`, externalName: `${BRAND_NAME} - Plus (Annually)`,
            pricingModel: 'flat_fee', price: 10000, currencyCode: 'USD',
            periodUnit: 'year', period: 1, trialPeriod: 14, trialPeriodUnit: 'day',
          }],
        ]);
      },
    },

    {
      name: 'chargebee-products: price amount drift → updated in place (deterministic ID)',
      run: async (ctx) => {
        const responses = chargebeeConverged();
        responses.listItemPricesForItem = (id) => (id === `${BRAND_ID}-plus`
          ? [
            { id: `${BRAND_ID}-plus-monthly`, price: 900, status: 'active', trial_period: 14, external_name: `${BRAND_NAME} - Plus (Monthly)` },
            { id: `${BRAND_ID}-plus-annually`, price: 10000, status: 'active', trial_period: 14, external_name: `${BRAND_NAME} - Plus (Annually)` },
          ]
          : []);
        responses.updateItemPrice = (id) => ({ id });
        const chargebee = fakeChargebee(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('updateItemPrice').map((c) => c.args)).toEqual([
          [`${BRAND_ID}-plus-monthly`, { price: 1000 }],
        ]);
      },
    },

    {
      name: 'chargebee-products: legacy plans reported read-only',
      run: async (ctx) => {
        const ids = structuredClone(CONVERGED_IDS);
        ids.plus.chargebee = { legacyPlanIds: ['old-plan'] };
        const responses = chargebeeConverged();
        responses.getPlan = { id: 'old-plan', status: 'active', price: 500, period_unit: 'month', period: 1, name: 'Old Plan' };
        const chargebee = fakeChargebee(responses);
        const config = brandConfig({ products: makeProducts({ ids }) });

        await runService(config, { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('getPlan').map((c) => c.args)).toEqual([['old-plan']]);
        ctx.expect(chargebee.mutations()).toEqual([]);
      },
    },

    {
      name: 'chargebee-webhook: missing → created with &brand= URL, name, and 15 events',
      run: async (ctx) => {
        const responses = chargebeeConverged();
        responses.listWebhooks = [];
        responses.createWebhook = { id: 'cbwh_new' };
        const chargebee = fakeChargebee(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('createWebhook').map((c) => c.args)).toEqual([[{
          url: CHARGEBEE_WEBHOOK_URL,
          name: `${BRAND_NAME} Backend`,
          eventTypes: CHARGEBEE_EVENTS,
        }]]);
      },
    },

    {
      name: 'chargebee-webhook: disabled endpoint → re-activated',
      run: async (ctx) => {
        const responses = chargebeeConverged();
        responses.listWebhooks = [{ id: 'cbwh_1', url: CHARGEBEE_WEBHOOK_URL, disabled: true }];
        responses.updateWebhook = { id: 'cbwh_1' };
        const chargebee = fakeChargebee(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('updateWebhook').map((c) => c.args)).toEqual([
          ['cbwh_1', { status: 'active' }],
        ]);
      },
    },

    {
      name: 'chargebee-webhook: legacy twin on the brand host → deleted; the desired URL and other hosts untouched',
      run: async (ctx) => {
        const responses = chargebeeConverged();
        responses.listWebhooks = [
          { id: 'cbwh_1', url: CHARGEBEE_WEBHOOK_URL, disabled: false },
          { id: 'cbwh_legacy', url: CHARGEBEE_LEGACY_WEBHOOK_URL, disabled: false },
          { id: 'cbwh_foreign', url: FOREIGN_WEBHOOK_URL, disabled: false },
        ];
        responses.deleteWebhook = { id: 'cbwh_legacy' };
        const chargebee = fakeChargebee(responses);
        const config = brandConfig({ products: makeProducts({ ids: CONVERGED_IDS }) });

        await runService(config, { chargebee, options: { provider: 'chargebee' } });

        ctx.expect(chargebee.callsTo('deleteWebhook').map((c) => c.args)).toEqual([['cbwh_legacy']]);
        ctx.expect(chargebee.callsTo('updateWebhook')).toEqual([]);
        ctx.expect(chargebee.callsTo('createWebhook')).toEqual([]);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'payment: dry-run on a fully drifted account — zero mutations on all three providers',
      run: async (ctx) => {
        // Everything is missing or wrong everywhere: account drifted, no products,
        // no webhooks, no item family. A dry run may only read.
        const stripe = fakeStripe({
          getAccount: { id: 'acct_1', business_profile: { name: 'Wrong', url: 'https://wrong.test', support_email: 'x@wrong.test', support_url: 'https://wrong.test' } },
          listAllProducts: [],
          listWebhookEndpoints: { data: [] },
        });
        const paypal = fakePaypal({
          getAccessToken: 'token',
          getAccountInfo: { appId: 'APP-1', environment: 'live', clientId: 'client-id-fixture' },
          listProducts: [],
          listWebhooks: { webhooks: [] },
        });
        const chargebee = fakeChargebee({
          makeRequest: { list: [] },
          getItemFamily: () => {
            throw new Error('Chargebee API error (404 GET /item_families/fixture-brand): resource_not_found');
          },
          getItem: (id) => {
            throw new Error(`Chargebee API error (404 GET /items/${id}): resource_not_found`);
          },
          listWebhooks: [],
        });
        // No per-provider product IDs configured — full-create territory
        const config = brandConfig();
        const brandRoot = makeBrandRoot(writebackSource(config));

        const result = await runService(config, { stripe, paypal, chargebee, options: { dryRun: true }, brandRoot });

        ctx.expect(result.status).toBe('warned'); // radar + disputes guidance still warns
        ctx.expect(stripe.mutations()).toEqual([]);
        ctx.expect(paypal.mutations()).toEqual([]);
        ctx.expect(chargebee.mutations()).toEqual([]);
        // Dry-run lands no product ID in omega.json5 either
        ctx.expect(!readConfigSource(brandRoot).includes('productId')).toBeTruthy();
      },
    },

    {
      name: 'provider-setup: stripe flow lands the publishable key in config and the secret in .env + process.env',
      run: async (ctx) => {
        const saved = process.env.STRIPE_SECRET_KEY;
        delete process.env.STRIPE_SECRET_KEY;
        // The Enter-gated open runs through devkit/prompt's own launcher seam
        const promptModule = require('@omega.js/devkit/prompt');
        const realOpen = promptModule.openInBrowser;
        const opened = [];
        promptModule.openInBrowser = (url) => { opened.push(url); return true; };
        const brandRoot = makeBrandRoot(PROVIDER_FLOW_CONFIG);
        const context = providerFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = providerSetupFlow(context, 'stripe');
          await tty.answer('Set up now?', '\r'); // Yes
          await tty.answer('Stripe publishable key', 'pk_test_fixture123\r');
          // The secret half rides the shared setup contract (#608) — the gate above
          // already ran, so it goes straight to the Enter-gated open + guided paste
          await tty.answer('Press Enter to open the Stripe secret key page', '\r');
          await tty.answer('Paste STRIPE_SECRET_KEY:', 'sk_test_fixture456\r');
          const landed = await run;

          ctx.expect(landed).toBe(true);
          // ONE open, and only after Enter — never auto-opened
          ctx.expect(opened).toEqual(['https://dashboard.stripe.com/apikeys']);
          // Public half → omega.json5 (comment preserved), in-memory patched
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes('publishableKey: "pk_test_fixture123"')).toBeTruthy();
          ctx.expect(written.includes('// publishableKey lands here')).toBeTruthy();
          ctx.expect(context.brandConfig.payment.providers.stripe.publishableKey).toBe('pk_test_fixture123');
          // Secret half → brand .env + the current process
          ctx.expect(readFileSync(joinPath(brandRoot, '.env'), 'utf8').includes('STRIPE_SECRET_KEY="sk_test_fixture456"')).toBeTruthy();
          ctx.expect(process.env.STRIPE_SECRET_KEY).toBe('sk_test_fixture456');
        } finally {
          tty.close();
          promptModule.openInBrowser = realOpen;
          if (saved === undefined) {
            delete process.env.STRIPE_SECRET_KEY;
          } else {
            process.env.STRIPE_SECRET_KEY = saved;
          }
        }
      },
    },

    {
      name: 'provider-setup: Disable writes payment.providers.stripe: false and lands nothing',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(PROVIDER_FLOW_CONFIG);
        const context = providerFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = providerSetupFlow(context, 'stripe');
          await tty.answer('Set up now?', '\x1B[B\x1B[B\r'); // Disable (stop prompting)
          const landed = await run;

          ctx.expect(landed).toBe(false);
          ctx.expect(context.brandConfig.payment.providers.stripe).toBe(false);
          ctx.expect(readConfigSource(brandRoot).includes('stripe: false, // publishableKey lands here')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'provider-setup: the coinbase flow asks for the API key ALONE — there is no public half',
      run: async (ctx) => {
        // Every sibling lands a public value in omega.json5 beside its secret
        // (publishableKey, clientId, site). Coinbase Commerce has none: the API key is
        // the entire credential, which is exactly why its config switch is `enabled`.
        const saved = process.env.COINBASE_COMMERCE_API_KEY;
        delete process.env.COINBASE_COMMERCE_API_KEY;
        const promptModule = require('@omega.js/devkit/prompt');
        const realOpen = promptModule.openInBrowser;
        const opened = [];
        promptModule.openInBrowser = (url) => { opened.push(url); return true; };
        const brandRoot = makeBrandRoot(COINBASE_FLOW_CONFIG);
        const context = coinbaseFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = providerSetupFlow(context, 'coinbase');
          await tty.answer('Set up now?', '\r'); // Yes
          // No public-field prompt at all — straight to the shared secret ask (#608)
          await tty.answer('Press Enter to open the Coinbase Commerce', '\r');
          await tty.answer('Paste COINBASE_COMMERCE_API_KEY:', 'cb_fixture_key_789\r');
          const landed = await run;

          ctx.expect(landed).toBe(true);
          ctx.expect(opened.length, 'ONE Enter-gated open, the page that mints the key').toBe(1);
          ctx.expect(opened[0]).toMatch(/commerce\.coinbase\.com/);
          // The secret lands in the brand .env and this run's process
          ctx.expect(readFileSync(joinPath(brandRoot, '.env'), 'utf8').includes('COINBASE_COMMERCE_API_KEY="cb_fixture_key_789"')).toBeTruthy();
          ctx.expect(process.env.COINBASE_COMMERCE_API_KEY).toBe('cb_fixture_key_789');
          // And NOTHING was written to omega.json5 — there is no public half to land
          ctx.expect(readConfigSource(brandRoot)).toBe(COINBASE_FLOW_CONFIG);
        } finally {
          tty.close();
          promptModule.openInBrowser = realOpen;
          if (saved === undefined) {
            delete process.env.COINBASE_COMMERCE_API_KEY;
          } else {
            process.env.COINBASE_COMMERCE_API_KEY = saved;
          }
        }
      },
    },

    {
      name: 'provider-setup: coinbase Disable writes payment.providers.coinbase.enabled: false',
      run: async (ctx) => {
        // The sibling providers disable at `payment.providers.<name>` because their
        // switch IS the block. Coinbase's switch is `enabled`, so Disable has to land
        // THERE — the one shape the schema declares and the checkout reads (#642).
        const saved = process.env.COINBASE_COMMERCE_API_KEY;
        delete process.env.COINBASE_COMMERCE_API_KEY;
        const brandRoot = makeBrandRoot(COINBASE_FLOW_CONFIG);
        const context = coinbaseFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = providerSetupFlow(context, 'coinbase');
          await tty.answer('Set up now?', '\x1B[B\x1B[B\r'); // Disable (stop prompting)
          const landed = await run;

          ctx.expect(landed).toBe(false);
          ctx.expect(context.brandConfig.payment.providers.coinbase.enabled).toBe(false);
          ctx.expect(readConfigSource(brandRoot).includes('enabled: false'), 'the switch is off in omega.json5').toBeTruthy();
          // Disable steps aside BEFORE the secret ask, so no brand .env is even created
          ctx.expect(existsSync(joinPath(brandRoot, '.env')), 'and no key was asked for').toBe(false);
        } finally {
          tty.close();
          if (saved === undefined) {
            delete process.env.COINBASE_COMMERCE_API_KEY;
          } else {
            process.env.COINBASE_COMMERCE_API_KEY = saved;
          }
        }
      },
    },

    {
      name: 'payment: a brand with crypto OFF is never asked for a Coinbase key',
      run: async (ctx) => {
        // `enabled` is the whole switch, so an absent or false one means the brand has
        // no use for the key — asking would be a prompt for a credential nothing reads.
        const { serviceInputs } = require('../src/config.js');
        const { missingEnvKeys } = require('@omega.js/config');
        const input = serviceInputs('payment').find((entry) => entry.name === 'COINBASE_COMMERCE_API_KEY');

        ctx.expect(input, 'the key is one of the payment service\'s inputs, or the setup contract cannot ask for it').toBeTruthy();
        ctx.expect(input.gates, 'an optional input: a missing crypto key never gates the payment service').toBe(false);
        ctx.expect(input.disablePath, 'Disable lands on the switch the schema declares').toBe('payment.providers.coinbase.enabled');

        const asked = (providers) => missingEnvKeys({ payment: { providers }, targets: { backend: { type: 'backend' } } }, {}, { verb: 'manage' })
          .some((row) => row.key === 'COINBASE_COMMERCE_API_KEY' && row.service === 'payment');
        for (const providers of [{}, { coinbase: {} }, { coinbase: { enabled: false } }, { coinbase: false }]) ctx.expect(asked(providers), `not asked when crypto is off: ${JSON.stringify(providers)}`).toBe(false);

        ctx.expect(asked({ coinbase: { enabled: true } }), 'asked when it is on').toBe(true);
      },
    },

    {
      name: 'provider-setup: non-interactive returns false without touching anything',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(PROVIDER_FLOW_CONFIG);
        const context = providerFlowContext(brandRoot);

        const landed = await providerSetupFlow(context, 'stripe');

        ctx.expect(landed).toBe(false);
        ctx.expect(readConfigSource(brandRoot)).toBe(PROVIDER_FLOW_CONFIG);
      },
    },

    {
      name: 'absoluteBrandImage: relative brand.images join brand.url; full URLs pass through; unresolvable → null',
      run: (ctx) => {
        const { absoluteBrandImage } = require('../src/lib/brand.js');

        const relative = { brand: { url: 'https://playground.omegajs.dev/', images: { brandmark: '/assets/images/brand/brandmark.png' } } };
        ctx.expect(absoluteBrandImage(relative, 'brandmark'), 'relative path joins brand.url (trailing slash collapsed)').toBe('https://playground.omegajs.dev/assets/images/brand/brandmark.png');

        const absolute = { brand: { url: 'https://x.dev', images: { brandmark: 'https://cdn.example.com/mark.png' } } };
        ctx.expect(absoluteBrandImage(absolute, 'brandmark'), 'full URL passes through').toBe('https://cdn.example.com/mark.png');

        ctx.expect(absoluteBrandImage({ brand: { url: 'https://x.dev', images: {} } }, 'brandmark'), 'missing image → null').toBe(null);
        ctx.expect(absoluteBrandImage({ brand: { images: { brandmark: '/mark.png' } } }, 'brandmark'), 'relative path without brand.url is unresolvable → null').toBe(null);
      },
    },
  ],
});
