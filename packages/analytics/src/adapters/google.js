/**
 * Google adapter: Google Analytics 4.
 *
 * The canonical param vocabulary IS GA4's, so every entry without a `map()`
 * passes straight through. Its consent category is its provider row's.
 */

const { createAdapter, pick } = require('./resolve.js');

// GA4 takes campaign attribution as FLAT event params (the Measurement
// Protocol's campaign reference), so it rides the payload itself. `gclid` joins
// them as a plain param: GA4 has no match block to put a click id in, and it is
// what a Google Ads enhanced-conversions upload will key on when that platform
// file lands ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)).
const ATTRIBUTION_PARAMS = ['campaign_id', 'campaign', 'source', 'medium', 'term', 'content', 'gclid'];

const adapter = createAdapter({
  provider: 'google',
  attach: (descriptor, attribution) => {
    Object.assign(descriptor.payload, pick(attribution, ATTRIBUTION_PARAMS));
  },
});

module.exports = adapter;
module.exports.ATTRIBUTION_PARAMS = ATTRIBUTION_PARAMS;
