/**
 * Campaigns service (SendGrid provider) — the brand's email-marketing infrastructure: domain
 * authentication (DKIM/SPF CNAMEs written via Cloudflare), link branding for
 * the emailurl host (validated, then the CNAME flips proxied), a verified sender
 * for Single Sends, the brand's marketing list, the unsubscribe groups
 * @omega.js/backend sends through, @omega.js/backend's custom fields and
 * segments (from @omega.js/backend's SSOT), and the account-global Event
 * Webhook pointed at the parent @omega.js/backend's forwarder.
 *
 * Runs after cloudflare (the zone must exist for the DKIM records). The
 * whole service reconciles one SendGrid account per brand-or-company — the
 * groups/fields/segments/webhook operations converge to the same result when
 * sibling brands share the account.
 *
 * Auth: SENDGRID_API_KEY in the brand .env; the event-webhook operation
 * additionally needs OMEGA_WEBHOOK_KEY, which the setup MINTS through the
 * shared contract (it is OMEGA's own key, #635). No API key → clean skip.
 */
const { chosenProvider, defaultAddressReason } = require('@omega.js/config');

const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { CloudflareAPI } = require('../edge/lib/cloudflare-api.js');
const { getApexDomain } = require('../../lib/domain-utils.js');
const { SendGridAPI } = require('./lib/sendgrid-api.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const campaigns = context.brandConfig.marketing?.campaigns || {};

    if (campaigns.enabled === false) {
      return { skip: true, reason: 'marketing.campaigns.enabled = false' };
    }

    // The vendor is a KEY under marketing.campaigns.providers (#425) — no
    // entry means none chosen and this service skips.
    const provider = chosenProvider(campaigns.providers);
    if (!provider) {
      return { skip: true, reason: 'no marketing.campaigns.providers entry' };
    }
    if (provider !== 'sendgrid') {
      return { skip: true, reason: `marketing.campaigns.providers.${provider} is not a known email-marketing provider` };
    }

    const domain = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(domain);
    if (pagesReason) return { skip: true, reason: pagesReason };

    if (!context.sendgridApi) {
      const gate = await requestServiceInput(context, serviceInputSpec('campaigns', { names: ['SENDGRID_API_KEY'] }));
      if (gate) return gate;
    }

    // The webhook key is OMEGA's OWN (#635): the shared helper mints it in
    // place when this service runs before the workspace one did, so the
    // webhook operation can read it unconditionally.
    const webhookKeyGate = await requestServiceInput(context, serviceInputSpec('campaigns', { names: ['OMEGA_WEBHOOK_KEY'] }));
    if (webhookKeyGate) return webhookKeyGate;

    // Tests inject fake clients via context.sendgridApi / context.cloudflareApi.
    // Cloudflare is only needed while the domain still has to be DNS-verified
    // (and for the link-branding proxy flip); without a token the domain-auth
    // operation prints the records to add manually and link-branding prints the
    // manual flip.
    return {
      sendgridApi: context.sendgridApi || new SendGridAPI(),
      cloudflareApi: context.cloudflareApi
        || (process.env.CLOUDFLARE_TOKEN ? new CloudflareAPI() : null),
      domain,
      apexDomain: getApexDomain(domain),
      // A subdomain project's apex records belong to the PARENT brand's walk
      // (the same line the edge service draws) — link-branding skips on it.
      isSubdomainProject: domain !== getApexDomain(domain),
    };
  },
});
