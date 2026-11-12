/**
 * Meta adapter — the Facebook Pixel and the Conversions API.
 *
 * Meta's commerce vocabulary (content_ids, num_items) differs from GA4's
 * items[], so those entries carry a `map()` in the catalog; everything else
 * passes through as custom data. Its consent category is its provider row's.
 */

const { createAdapter, pick, attachPage } = require('./resolve.js');

// Meta's click/browser ids live in the user_data (match) block, never in the
// event's custom data.
const ATTRIBUTION_KEYS = ['fbc', 'fbp'];

const adapter = createAdapter({
  provider: 'meta',
  attach: (descriptor, attribution) => {
    Object.assign(descriptor.userData, pick(attribution, ATTRIBUTION_KEYS));
    // The Conversions API's `event_source_url` (#497) — the transport's to place.
    attachPage(descriptor, attribution);
  },
});

module.exports = adapter;
module.exports.ATTRIBUTION_KEYS = ATTRIBUTION_KEYS;
