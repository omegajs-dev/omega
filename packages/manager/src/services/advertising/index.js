/**
 * Advertising service — verifies the brand's domain is added to the
 * configured AdSense account and reports its approval state.
 *
 * The Management API v2 is read-only (sites can't be added or configured
 * programmatically), so this service proves presence + state and deep-links
 * the console for the manual half; interactive runs open the add-site page
 * and poll until the site appears. Never mutates AdSense — dry-run is
 * identical to a normal run.
 *
 * Config home: `advertising.providers.adsense` (the provider-neutral
 * advertising section — never a brand-named top-level key). `client`
 * (ca-pub-…) is required config; the API accountId is the same id without
 * the `ca-` prefix. omega-manager defaulted the account to the company's
 * shared one (company-level config supplies that now). Interactive runs
 * offer the account selection flow when it's missing (create-new opens the
 * AdSense signup) and land it in omega.json5.
 * Auth: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in the brand .env
 * (adsense.readonly scope, own token cache).
 */
const { defaultAddressReason } = require('@omega.js/config');
const { serviceInputSpec } = require('../../config.js');
const { googleTokenStorePath } = require('../../lib/google-auth.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { GoogleAdsenseAPI } = require('./lib/adsense-api.js');
const { resolveConfigValue } = require('../../lib/config-flow.js');

const CREATE_ACCOUNT_URL = 'https://adsense.google.com/start/';

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    // No provider entry = deliberate absence — never resolve or write back an
    // account the brand didn't opt into (wave-5 F10; authoring
    // `advertising: { providers: { adsense: {} } }` opts in).
    const provider = context.brandConfig.advertising?.providers?.adsense;
    if (!provider) {
      return { skip: true, reason: 'no advertising.providers.adsense section in omega.json5 (author it — even empty — to opt in)' };
    }

    const domain = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(domain);
    if (pagesReason) return { skip: true, reason: pagesReason };

    // The shared setup contract (#608): ask for the Google OAuth client right
    // here — provide, skip this run, or disable AdSense for good.
    let gate = null;
    if (!context.adsenseApi) {
      gate = await requestServiceInput(context, serviceInputSpec('advertising'));
    }
    const haveCreds = Boolean(
      context.adsenseApi
      || (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    );

    // Tests inject a fake client via context.adsenseApi
    const makeApi = () => context.adsenseApi || new GoogleAdsenseAPI({
      tokenStorePath: googleTokenStorePath(context.brandRoot),
    });

    // Missing client id → offer the interactive selection flow (lands in
    // omega.json5); needs credentials. The Management API wants the bare
    // pub-… account id — `client` carries the embed-ready ca-pub-… form.
    let client = provider.client;
    if (!client && haveCreds) {
      const flowApi = makeApi();
      client = await resolveConfigValue(context, {
        path: 'advertising.providers.adsense.client',
        // Disable must NOT land `client: false` — client is schema-typed as a
        // string and the config would hard-fail validation forever. It opts
        // the PROVIDER out instead (the chatsy/slapform shape): a falsy
        // provider entry is the deliberate-absence skip above, and there is no
        // second `enabled` switch to land it on since #527.
        disablePath: 'advertising.providers.adsense',
        label: 'AdSense account',
        choices: () => flowApi.listAccounts(),
        getName: (account) => {
          const id = account.name.replace('accounts/', '');
          return `${account.displayName || id} (${id})`;
        },
        getValue: (account) => `ca-${account.name.replace('accounts/', '')}`,
        createNew: { label: 'account', url: CREATE_ACCOUNT_URL, refreshChoices: true },
      });
    }
    if (!client) {
      return { skip: true, reason: 'no advertising.providers.adsense.client configured (ca-pub-… from https://adsense.google.com → Settings → Account information — or rerun interactively)' };
    }
    const accountId = client.replace(/^ca-/, '');

    if (!haveCreds) {
      return gate || { skip: true, reason: 'no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET configured (set them in the brand .env)' };
    }

    return {
      adsenseApi: makeApi(),
      accountId,
      domain,
    };
  },
});
