/**
 * Shared helpers for the payment operations — the paid-product filter, the
 * provider-facing product identity (display name + image), the backend
 * webhook URL, and the event-set diff. omega-manager duplicated these across
 * the stripe/paypal/chargebee handlers (and hardcoded the company CDN for
 * product images — the image is brand.images.brandmark config now).
 */
const { apiAddress } = require('@omega.js/config');
const { absoluteBrandImage } = require('../../../lib/brand.js');

/**
 * Products the providers manage: priced and not archived. Free tiers have
 * no prices; archived products keep their provider objects but stop being
 * reconciled.
 *
 * @param {Object} brandConfig - Merged brand config
 * @returns {Array} Paid, non-archived products
 */
function paidProducts(brandConfig) {
  return (brandConfig.payment?.products || []).filter((p) => p.prices && !p.archived);
}

/**
 * The provider-facing product name: "{Brand} - {Product}".
 *
 * @param {Object} brandConfig - Merged brand config
 * @param {Object} product - Product entry from payment.products
 * @returns {string} Display name
 */
function productDisplayName(brandConfig, product) {
  return `${brandConfig.brand.name} - ${product.name}`;
}

/**
 * The product image URL — brand.images.brandmark when configured, else null
 * (providers keep whatever image they have; the diff skips images entirely).
 *
 * @param {Object} brandConfig - Merged brand config
 * @returns {string|null} Image URL or null
 */
function productImage(brandConfig) {
  return absoluteBrandImage(brandConfig, 'brandmark');
}

/**
 * The brand backend's payment webhook URL for a provider.
 * Requires OMEGA_WEBHOOK_KEY in the brand .env.
 *
 * @param {Object} brandConfig - Merged brand config
 * @param {string} provider - 'stripe' | 'paypal' | 'chargebee'
 * @param {string} [brandId] - Included as &brand= (chargebee only)
 * @returns {string} Webhook URL, on the brand's `apiAddress`
 * @throws {Error} When the brand url derives no API address
 */
function buildWebhookUrl(brandConfig, provider, brandId) {
  const api = apiAddress(brandConfig.brand.url, brandConfig.cloud?.config?.projectId);
  if (!api) {
    throw new Error(`brand.url ${brandConfig.brand.url} derives no API address for the ${provider} webhook: a default Pages host needs cloud.config.projectId`);
  }
  const key = process.env.OMEGA_WEBHOOK_KEY;
  const brandParam = brandId ? `&brand=${brandId}` : '';

  return `${api}/omega/payments/webhook?provider=${provider}${brandParam}&key=${key}`;
}

/**
 * Webhook URL with the key query param redacted — the ONLY form safe to print
 * (campaigns/newsletter build the same URL and never print it at all).
 *
 * @param {string} url - A buildWebhookUrl() result
 * @returns {string} URL with key=***
 */
function redactWebhookUrl(url) {
  return url.replace(/([?&]key=)[^&]*/, '$1***');
}

/**
 * The endpoints on the brand's OWN webhook host that are NOT the desired URL —
 * legacy twins (omega-manager's `?processor=` form, an old key) that keep
 * receiving every event and answering 400. Exactly one endpoint per host
 * survives a manage run; endpoints on other hosts belong to whatever else the
 * account runs and are never touched (#570).
 *
 * @param {Array} endpoints - Provider webhook objects carrying a `url`
 * @param {string} desiredUrl - A buildWebhookUrl() result
 * @returns {Array} The stale endpoints, in list order
 */
function staleWebhookEndpoints(endpoints, desiredUrl) {
  const desired = new URL(desiredUrl);

  return endpoints.filter((endpoint) => {
    if (!endpoint.url || endpoint.url === desiredUrl) {
      return false;
    }

    const url = URL.parse(endpoint.url);

    return !!url && url.host === desired.host && url.pathname === desired.pathname;
  });
}

/**
 * Diff current webhook events against desired.
 *
 * @param {string[]} currentEvents - Events on the endpoint now
 * @param {string[]} desiredEvents - Events the backend handles
 * @returns {{ missing: string[], extra: string[] }|null} Diff, or null when converged
 */
function diffEventSets(currentEvents, desiredEvents) {
  const currentSet = new Set(currentEvents);
  const desiredSet = new Set(desiredEvents);

  const missing = desiredEvents.filter((e) => !currentSet.has(e));
  const extra = [...currentSet].filter((e) => !desiredSet.has(e));

  return (missing.length > 0 || extra.length > 0)
    ? { missing, extra }
    : null;
}

module.exports = { paidProducts, productDisplayName, productImage, buildWebhookUrl, redactWebhookUrl, staleWebhookEndpoints, diffEventSets };
