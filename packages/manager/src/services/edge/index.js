/**
 * Edge service: reconciles the brand's zone to `edge.providers.cloudflare`
 * in omega.json5: zone, DNS records, email routing, zone settings, rulesets
 * (cache/redirect/configuration/response-headers/security/managed-transforms),
 * speed tests, Web Analytics, and workers. Every handler follows read → diff →
 * write (Cloudflare requires current state before patching) and caches its
 * read step to .omega/cache/cloudflare/{op}.json.
 *
 * Auth: CLOUDFLARE_TOKEN in the brand .env. No token → the service skips.
 * Subdomain projects (brand.url not an apex) use the parent zone and run only
 * zone + dns-records; zone-level settings belong to the parent brand.
 */
const chalk = require('chalk').default;
const { defaultAddressReason } = require('@omega.js/config');
const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { CloudflareAPI } = require('./lib/cloudflare-api.js');
const { getApexDomain } = require('../../lib/domain-utils.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { askEmailProvider } = require('./lib/email-asks.js');

// Operations allowed for subdomain projects (zone-level settings are skipped)
const SUBDOMAIN_OPERATIONS = new Set(['zone', 'dns-records']);

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const cloudflare = context.brandConfig.edge?.providers?.cloudflare || {};

    if (cloudflare.enabled === false) {
      return { skip: true, reason: 'edge.providers.cloudflare.enabled = false' };
    }

    // Read before the token ask: a brand with no domain has no use for one
    const domain = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '');
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(domain);
    if (pagesReason) return { skip: true, reason: pagesReason };

    if (!context.cloudflareApi) {
      const gate = await requestServiceInput(context, serviceInputSpec('edge'));
      if (gate) return gate;
    }

    // Tests inject a fake client via context.cloudflareApi
    const api = context.cloudflareApi || new CloudflareAPI();

    const apexDomain = getApexDomain(domain);
    const isSubdomainProject = domain !== apexDomain;
    const zoneDomain = apexDomain;

    // Asked before any op, so dns-records reads the pick on this walk
    if (!isSubdomainProject) {
      await askEmailProvider(context);
    }

    const zone = await api.getZoneByName(zoneDomain);

    if (isSubdomainProject) {
      console.log(`    Subdomain project detected: ${chalk.cyan(domain)}`);
      console.log(`    Using parent zone: ${chalk.cyan(zoneDomain)}`);
    }

    const filteredOperations = isSubdomainProject
      ? context.operations.filter((op) => SUBDOMAIN_OPERATIONS.has(op.name))
      : context.operations;

    return {
      cloudflareApi: api,
      domain,           // Full domain (e.g. app.mybrand.com)
      zoneDomain,       // Apex/zone domain (e.g. mybrand.com)
      isSubdomainProject,
      zoneId: zone?.id || null,
      zone,
      operations: filteredOperations,
    };
  },
});
