/**
 * The consent seam.
 *
 * The gate answers ONE question — is this category granted right now — and the
 * facade asks it once per provider before resolving. No UI, no storage, no
 * region logic: stage B ([#383](https://github.com/Omega-JS-Stack/omega/issues/383))
 * owns the banner and the timezone heuristic, and injects its state through
 * `createConsentGate`.
 *
 * The provider function is read LIVE on every event, so a visitor who accepts
 * mid-session is counted from that moment without anything re-configuring.
 */

const { ANALYTICS_PROVIDERS } = require('@omega.js/config/analytics-providers');

// The categories the providers belong to, read off their rows.
const CATEGORIES = [...new Set(Object.values(ANALYTICS_PROVIDERS).map((row) => row.consentCategory))];

/**
 * Build a consent gate from a state provider.
 * @param {Function} providerFn - () => ({ analytics: boolean, marketing: boolean }).
 * @returns {{ granted: Function, state: Function }}
 */
function createConsentGate(providerFn) {
  function state() {
    const value = providerFn() || {};
    const resolved = {};
    for (const category of CATEGORIES) {
      resolved[category] = value[category] === true;
    }
    return resolved;
  }

  return {
    state,
    /**
     * Is this category granted?
     * @param {string} category - 'analytics' | 'marketing'.
     * @returns {boolean}
     */
    granted(category) {
      return state()[category] === true;
    },
  };
}

// The default when no host injects one: everything granted. Stage B supplies
// the real gate on web; desktop/extension/backend have no banner to gate on.
const GRANT_ALL = createConsentGate(() => ({ analytics: true, marketing: true }));

module.exports = { CATEGORIES, createConsentGate, GRANT_ALL };
