/**
 * Publishing service: every credential and id a brand needs before it can
 * SHIP, collected at setup time instead of discovered at release time, derived
 * from the declaration (`targets.<name>.platforms.<platform>.formats`) through
 * @omega.js/config's format table. It asks for the developer KEYS a shipped
 * format needs (brand `.env`, lib/service-input.js) and the per-listing store
 * IDS (config, never `.env`, with a "not yet" skip), and it provisions the one
 * thing a store lets us create, the Snap Store name (ensure/snap-name.js).
 * `certificates` keeps the APPLE material. A run that cannot ask never prompts
 * and never quietly steps aside: a missing key FAILS naming it and this walk,
 * and a missing listing id is warned with the manual step the publish prints.
 */
const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { canPrompt } = require('../../lib/run-gates.js');
const { shipTargets } = require('./lib/ship-list.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const config = context.brandConfig.publishing;

    if (config === false || config?.enabled === false) {
      return { skip: true, reason: 'publishing.enabled = false' };
    }

    // Nothing else ships an artifact a human installs: web and backend deploy.
    const shipping = shipTargets(context.brandConfig);
    if (shipping.length === 0) {
      return { skip: true, reason: 'no desktop or extension target' };
    }

    // The gate runs only where it can COLLECT. A headless run falls through to
    // the operations below on purpose: they are what turn a missing ship
    // credential into the loud refusal, and stepping aside here would hide it.
    if (canPrompt(context.options)) {
      const gate = await requestServiceInput(context, serviceInputSpec('publishing'));
      if (gate) {
        return gate;
      }
    }

    return { shipping };
  },
});
