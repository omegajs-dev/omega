/**
 * Domain service — points the registrar at Cloudflare. Runs after cloudflare
 * (the zone must exist so its assigned nameservers are known). API-capable
 * registrars (namecheap) are reconciled automatically; manual registrars get
 * printed instructions, and only while the zone is still pending — an active
 * zone proves the nameservers are already set.
 *
 * The email half of `domain` config (email.providers, email.forwarding) is
 * consumed by the cloudflare service (dns-records MX/SPF + email-routing);
 * this service owns only the registrar side.
 *
 * Auth: NAMECHEAP_USERNAME + NAMECHEAP_API_KEY in the brand .env (namecheap
 * only), plus CLOUDFLARE_TOKEN to read the zone's assigned nameservers.
 * Missing credentials → the service skips with guidance.
 */
const chalk = require('chalk').default;
const { serviceAskedKeys, envSchemaEntry, chosenProvider, defaultAddressReason } = require('@omega.js/config');
const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { resolveConfigValue } = require('../../lib/config-flow.js');
const { CloudflareAPI } = require('../edge/lib/cloudflare-api.js');
const { getApexDomain } = require('../../lib/domain-utils.js');
const { DOMAIN_PROVIDERS, presencePick, resolveRegistrar } = require('./lib/providers.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const domainConfig = context.brandConfig.domain || {};

    if (domainConfig.enabled === false) {
      return { skip: true, reason: 'domain.enabled = false' };
    }

    // Read before the registrar ask: a brand with no domain has no registrar
    const url = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '');
    if (!url) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(url);
    if (pagesReason) return { skip: true, reason: pagesReason };

    await resolveConfigValue(context, {
      path: 'domain.providers',
      label: 'Domain registrar',
      disablePath: 'domain.enabled',
      instructions: ['The registrar that holds the domain, so its nameservers can point at Cloudflare.'],
      present: (providers) => chosenProvider(providers) !== null,
      ...presencePick('registrar'),
    });

    const provider = resolveRegistrar(context.brandConfig);
    if (!provider) {
      return { skip: true, reason: 'no domain.providers.<registrar> configured' };
    }

    // What this brand's domain service owes (the env schema's askedWhen) splits
    // by owner: the edge's Cloudflare token, which the zone lookup needs even
    // for a manual registrar, and the chosen registrar's own credentials
    const owed = [...serviceAskedKeys(context.brandConfig, 'domain')];
    const registrarKeys = owed.filter((key) => envSchemaEntry(key).owner === 'domain');
    const zoneKeys = owed.filter((key) => !registrarKeys.includes(key));

    if (zoneKeys.length > 0 && !context.cloudflareApi) {
      const gate = await requestServiceInput(context, serviceInputSpec('domain', { names: zoneKeys }));
      if (gate) return gate;
    }
    if (registrarKeys.length > 0 && !context.registrarApi) {
      const gate = await requestServiceInput(context, serviceInputSpec('domain', { names: registrarKeys }));
      if (gate) return gate;
    }

    const { api: RegistrarAPI = null } = DOMAIN_PROVIDERS.registrar[provider] || {};

    console.log(`    Provider: ${chalk.cyan(provider)}${RegistrarAPI ? '' : chalk.dim(' (manual)')}`);

    // Tests inject fake clients via context.cloudflareApi / context.registrarApi
    return {
      cloudflareApi: context.cloudflareApi || new CloudflareAPI(),
      registrarApi: RegistrarAPI ? (context.registrarApi || new RegistrarAPI()) : null,
      domain: getApexDomain(url), // nameservers live on the apex's registrar entry
      provider,
    };
  },
});
