/**
 * The email provider registry: one module per provider library in this folder,
 * keyed by its row id in @omega.js/config's EMAIL_PROVIDERS (the row holds the
 * role, env key, native fields and operations). Callers reach a module through
 * its role (marketing/index.js's roleProvider()), never by naming it.
 */
const PROVIDER_MODULES = {
  sendgrid: require('./sendgrid.js'),
  beehiiv: require('./beehiiv.js'),
};

/**
 * The provider module for a row id. An id with no module is a row added
 * without its file, a programmer error, so it throws.
 *
 * @param {string} id - The provider id (`sendgrid`, `beehiiv`)
 * @returns {object} The provider module
 */
function providerModule(id) {
  if (!Object.hasOwn(PROVIDER_MODULES, id)) {
    throw new Error(`No email provider module for "${id}" in libraries/email/providers/index.js`);
  }

  return PROVIDER_MODULES[id];
}

module.exports = { PROVIDER_MODULES, providerModule };
