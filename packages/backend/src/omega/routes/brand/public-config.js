/**
 * The public-safe brand config: what GET /brand answers, and what the desktop
 * client setup and the newsletter generator read.
 */

/**
 * Build a public-safe config object from omega.config
 * Excludes sensitive fields: monitoring, analytics, blog, etc.
 */
function buildPublicConfig(config) {
  const { repoBlock } = require('@omega.js/config');

  return {
    brand: config.brand || {},
    // The repo block as the config DERIVATION reads it: provider + owner,
    // the only two facts there are, defaulted the one way every other reader
    // defaults them. Null when the brand declares no repo at all.
    repo: repoBlock(config),
    connections: config.connections || {},
    payment: config.payment || {},
    cloud: config.cloud || {},
    reviews: config.reviews || {},
  };
}

module.exports = { buildPublicConfig };
