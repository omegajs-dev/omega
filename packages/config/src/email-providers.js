/**
 * email-providers.js: one row per email-marketing provider, the one home of
 * its facts. The backend and the manager's services reach a provider through
 * the role it serves, and the env schema's role rules read the row's id.
 *
 * role: `campaigns` or `newsletter`, the word results, settings and config keep.
 * envKey: the key that turns the role on.
 * nativeFields: catalog fields (the backend's FIELDS) the provider stores in
 *   its own columns, so it never takes them as custom fields.
 * operations: the functions the role's callers use, each one exported by
 *   libraries/email/providers/<id>.js in the backend.
 */

const { deepFreeze } = require('./deep-freeze.js');

// The contact surface every role's callers share
const CONTACT_OPERATIONS = ['addContact', 'buildFields', 'findContact', 'removeContact', 'resolveSegmentIds'];

const EMAIL_PROVIDERS = deepFreeze({
  sendgrid: {
    id: 'sendgrid',
    role: 'campaigns',
    envKey: 'SENDGRID_API_KEY',
    nativeFields: ['user_personal_name_first', 'user_personal_name_last'],
    operations: [
      ...CONTACT_OPERATIONS,
      'getListId',
      'createBrandScopedSegment',
      'getSegmentContacts',
      'bulkDeleteContacts',
      'createSingleSend',
      'scheduleSingleSend',
      'cancelSingleSend',
      'getSingleSend',
      'listSingleSends',
    ],
  },
  beehiiv: {
    id: 'beehiiv',
    role: 'newsletter',
    envKey: 'BEEHIIV_API_KEY',
    nativeFields: ['user_personal_country', 'user_attribution_utm_source'],
    operations: [
      ...CONTACT_OPERATIONS,
      'getPublicationId',
      'listSubscriptions',
      'createPost',
    ],
  },
});

/**
 * The row for a provider id, or null when no provider has that id. An
 * own-property read: an inherited name like `constructor` is never a provider.
 *
 * @param {string} id - The provider id (`sendgrid`, `beehiiv`).
 * @returns {object|null}
 */
function emailProvider(id) {
  return Object.hasOwn(EMAIL_PROVIDERS, id) ? EMAIL_PROVIDERS[id] : null;
}

/**
 * The row of the provider serving a role, or null when no provider serves it.
 *
 * @param {string} role - The role word (`campaigns`, `newsletter`).
 * @returns {object|null}
 */
function emailProviderForRole(role) {
  return Object.values(EMAIL_PROVIDERS).find((provider) => provider.role === role) || null;
}

module.exports = { EMAIL_PROVIDERS, emailProvider, emailProviderForRole };
