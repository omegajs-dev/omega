/**
 * Newsletter service (Beehiiv provider) — the brand's newsletter publication: access verified (or
 * auto-matched by name), @omega.js/backend's custom fields provisioned, @omega.js/backend's segments
 * ensured (Beehiiv has no segment-create API — missing ones get readable
 * instructions, and interactive runs offer to create them by driving the
 * dashboard UI through the OMEGA Companion extension), and the
 * publication webhook pointed at the parent @omega.js/backend's forwarder.
 *
 * Publications are created manually in the dashboard (no API) — the service
 * prints the exact values to copy when none matches.
 *
 * Auth: BEEHIIV_API_KEY in the brand .env; the webhook operation
 * additionally needs OMEGA_WEBHOOK_KEY, which the setup MINTS through the
 * shared contract (it is OMEGA's own key, #635). No API key → clean skip.
 */
const { chosenProvider, emailProviderForRole } = require('@omega.js/config');

const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { BeehiivAPI } = require('./lib/beehiiv-api.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const newsletter = context.brandConfig.marketing?.newsletter || {};

    if (newsletter.enabled === false) {
      return { skip: true, reason: 'marketing.newsletter.enabled = false' };
    }

    // The vendor is a KEY under marketing.newsletter.providers (#425) — no
    // entry means none chosen and this service skips.
    const provider = chosenProvider(newsletter.providers);
    if (!provider) {
      return { skip: true, reason: 'no marketing.newsletter.providers entry' };
    }
    if (provider !== emailProviderForRole('newsletter').id) {
      return { skip: true, reason: `marketing.newsletter.providers.${provider} is not a known newsletter provider` };
    }

    const domain = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    if (!context.beehiivApi) {
      const gate = await requestServiceInput(context, serviceInputSpec('newsletter', { names: [emailProviderForRole('newsletter').envKey] }));
      if (gate) return gate;
    }

    // The webhook key is OMEGA's OWN (#635): the shared helper mints it in
    // place when this service runs before the workspace one did, so the
    // webhook operation can read it unconditionally.
    const webhookKeyGate = await requestServiceInput(context, serviceInputSpec('newsletter', { names: ['OMEGA_WEBHOOK_KEY'] }));
    if (webhookKeyGate) return webhookKeyGate;

    // Tests inject a fake client via context.beehiivApi
    return {
      beehiivApi: context.beehiivApi || new BeehiivAPI(),
      domain,
    };
  },
});
