/**
 * TikTok adapter — the TikTok Pixel and the Events API.
 *
 * TikTok's commerce vocabulary is a `contents` array of product objects
 * (content_id + content_name + price + quantity) beside the order's
 * content_type/value/currency, so those entries carry a `map()` in the catalog;
 * everything else passes through as properties. Its consent category is its
 * provider row's.
 */

const { createAdapter, pick, attachPage } = require('./resolve.js');

// TikTok's click id and cookie live in the Events API's context.user block —
// never in the event properties.
const ATTRIBUTION_KEYS = ['ttclid', 'ttp'];

const adapter = createAdapter({
  provider: 'tiktok',
  attach: (descriptor, attribution) => {
    Object.assign(descriptor.userData, pick(attribution, ATTRIBUTION_KEYS));
    // The Events API 2.0 data item's `page` member (#497) — the transport's to place.
    attachPage(descriptor, attribution);
  },
});

module.exports = adapter;
module.exports.ATTRIBUTION_KEYS = ATTRIBUTION_KEYS;
