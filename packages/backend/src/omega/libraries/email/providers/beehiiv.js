/**
 * Beehiiv provider: API helpers for subscribers and posts. It serves the
 * newsletter role (its row in @omega.js/config's EMAIL_PROVIDERS lists the
 * operations its callers use), reached through Marketing.roleProvider() by
 * marketing/index.js and the daily prune.
 */
const fetch = require('wonderful-fetch');
// The one Omega instance, read at call time: this module first loads while
// index.js is still evaluating (a circular require), when its export is not whole yet
const instance = () => require('../../../index.js');
const { FIELDS, resolveFieldValues, fieldsForProvider } = require('../constants.js');
const env = require('../../env.js');

const BASE_URL = 'https://api.beehiiv.com/v2';

// Beehiiv API spikes past 10s during their hiccups, dropping signups silently.
// 60s is generous but harmless — caches are in place for metadata calls so a
// slow first call costs nothing in steady state.
const BEEHIIV_TIMEOUT_MS = 60000;

// Beehiiv caps a subscriptions page at 100.
const SUBSCRIPTION_PAGE_LIMIT = 100;

// A `has_more` that never turns off (or a cursor that stops advancing) would
// walk the API forever, so the page walk has a hard stop. 500 pages covers
// 50k subscribers — a publication past that needs a paged prune, not a
// silently truncated one, which is why hitting the cap fails the call.
const SUBSCRIPTION_MAX_PAGES = 500;

// --- Internal helpers ---

function headers() {
  return {
    'Authorization': `Bearer ${env.get('BEEHIIV_API_KEY')}`,
  };
}

// --- Subscriber Management ---

/**
 * Add or reactivate a subscriber to a Beehiiv publication.
 *
 * @param {object} options
 * @param {string} options.email
 * @param {string} [options.firstName]
 * @param {string} [options.lastName]
 * @param {string} [options.source] - UTM source
 * @param {string} options.publicationId
 * @param {Array<{name: string, value: string}>} [options.customFields] - Additional custom fields
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
async function addSubscriber({ email, firstName, lastName, source, publicationId, customFields }) {
  try {
    const body = {
      email,
      reactivate_existing: true,
      send_welcome_email: true,
    };

    if (source) {
      body.utm_source = source;
    }

    // Build custom fields array
    const fields = [
      ...(customFields || []),
    ];

    if (firstName) {
      fields.push({ name: 'first_name', value: firstName });
    }
    if (lastName) {
      fields.push({ name: 'last_name', value: lastName });
    }

    if (fields.length) {
      body.custom_fields = fields;
    }

    console.log(`Beehiiv addSubscriber: ${email} → pub=${publicationId}, customFields=${fields.length}`);

    const data = await fetch(`${BASE_URL}/publications/${publicationId}/subscriptions`, {
      method: 'post',
      response: 'json',
      headers: headers(),
      timeout: BEEHIIV_TIMEOUT_MS,
      body,
    });

    if (data.data?.id) {
      return { success: true, id: data.data.id };
    }

    return { success: false, error: data.message || 'Unknown error' };
  } catch (e) {
    console.error('Beehiiv addSubscriber error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Look up a Beehiiv subscriber by email. Returns the subscription object
 * (id, email, status, custom_fields, ...) or null if not found.
 *
 * Useful for tests that need to verify whether a subscriber landed in the
 * publication after a marketing sync.
 *
 * @param {string} email
 * @param {string} publicationId
 * @returns {Promise<object|null>}
 */
async function findSubscriber(email, publicationId) {
  try {
    const encodedEmail = encodeURIComponent(email);
    const searchData = await fetch(
      `${BASE_URL}/publications/${publicationId}/subscriptions/by_email/${encodedEmail}`,
      {
        response: 'json',
        headers: headers(),
        timeout: BEEHIIV_TIMEOUT_MS,
      }
    );

    return searchData.data || null;
  } catch (e) {
    if (e.status === 404) {
      return null;
    }
    console.error('Beehiiv findSubscriber error:', e);
    return null;
  }
}

/**
 * Remove a subscriber from a Beehiiv publication by email.
 *
 * @param {string} email
 * @param {string} publicationId
 * @returns {{ success: boolean, deleted?: boolean, skipped?: boolean, error?: string }}
 */
async function removeSubscriber(email, publicationId) {
  try {
    // Step 1: Look up the subscription
    const subscription = await findSubscriber(email, publicationId);

    if (!subscription?.id) {
      return { success: true, skipped: true, reason: 'Subscriber not found' };
    }

    const subscriptionId = subscription.id;

    // Step 2: Permanently delete the subscription
    await fetch(
      `${BASE_URL}/publications/${publicationId}/subscriptions/${subscriptionId}`,
      {
        method: 'delete',
        headers: headers(),
        timeout: BEEHIIV_TIMEOUT_MS,
      }
    );

    return { success: true, deleted: true, subscriptionId };
  } catch (e) {
    console.error('Beehiiv removeSubscriber error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Get this brand's Beehiiv publication ID.
 *
 * Reads `omega.config.marketing.newsletter.providers.beehiiv.publicationId`
 * (#425) — populated by OMEGA's `newsletter/ensure/publication.js` at
 * brand-onboarding time. No runtime API call, no fuzzy-match fragility.
 *
 * If the brand hasn't been onboarded yet (publicationId missing/empty), logs
 * a warning and returns null — the marketing sync will skip Beehiiv for this
 * brand. Fix: run OMEGA's beehiiv service to populate.
 *
 * @returns {string|null} Publication ID or null if not configured
 */
function getPublicationId() {
  const publicationId = instance().config?.marketing?.newsletter?.providers?.beehiiv?.publicationId;

  if (!publicationId) {
    console.warn(
      'Beehiiv: marketing.newsletter.providers.beehiiv.publicationId is not set in config. '
      + 'Subscriber will NOT be added to a publication. '
      + 'Run OMEGA to populate.',
    );
    return null;
  }

  return publicationId;
}

// LEGACY: Fuzzy-match-by-brand-name fallback. Kept commented out as a backstop
// in case the config-based approach has an edge case we haven't seen yet.
// Delete once we've verified the config-based approach works across all brands.
//
// let _publicationIdCache = null;
//
// async function getPublicationIdByFuzzyMatch() {
//   if (_publicationIdCache) {
//     return _publicationIdCache;
//   }
//
//   const brandName = omega.config?.brand?.name;
//
//   if (!brandName) {
//     console.error('Beehiiv: Brand name is required to find publication');
//     return null;
//   }
//
//   const brandNameLower = brandName.toLowerCase();
//   const allPublications = [];
//   let page = 1;
//   const limit = 100;
//
//   try {
//     while (true) {
//       const data = await fetch(`${BASE_URL}/publications?limit=${limit}&page=${page}`, {
//         response: 'json',
//         headers: headers(),
//         timeout: BEEHIIV_TIMEOUT_MS,
//       });
//
//       if (!data.data || data.data.length === 0) {
//         break;
//       }
//
//       const matchedPub = data.data.find(pub =>
//         pub.name.toLowerCase() === brandNameLower
//         || pub.name.toLowerCase().includes(brandNameLower)
//         || brandNameLower.includes(pub.name.toLowerCase())
//       );
//
//       if (matchedPub) {
//         _publicationIdCache = matchedPub.id;
//         return matchedPub.id;
//       }
//
//       allPublications.push(...data.data);
//
//       if (data.data.length < limit) {
//         break;
//       }
//
//       page++;
//     }
//
//     console.error(`Beehiiv: No publication matched brand "${brandName}". Available: ${allPublications.map(p => p.name).join(', ')}`);
//   } catch (e) {
//     console.error('Beehiiv publication lookup error:', e);
//   }
//
//   return null;
// }

/**
 * Add a contact to Beehiiv — resolves publication, adds subscriber with optional custom fields.
 *
 * @param {object} options
 * @param {string} options.email
 * @param {string} [options.firstName]
 * @param {string} [options.lastName]
 * @param {string} [options.source] - UTM source
 * @param {Array<{name: string, value: string}>} [options.customFields] - Pre-built custom fields
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
async function addContact({ email, firstName, lastName, company, source, customFields }) {
  const publicationId = getPublicationId();

  if (!publicationId) {
    return { success: false, error: 'Publication not found' };
  }

  const fields = [...(customFields || [])];
  if (company) {
    fields.push({ name: 'company', value: company });
  }

  return addSubscriber({
    email,
    firstName,
    lastName,
    source,
    publicationId,
    customFields: fields,
  });
}

/**
 * Remove a contact from Beehiiv — resolves publication from config.
 *
 * @param {string} email
 * @returns {{ success: boolean, deleted?: boolean, skipped?: boolean, error?: string }}
 */
async function removeContact(email) {
  const publicationId = getPublicationId();

  if (!publicationId) {
    return { success: false, error: 'Publication not found' };
  }

  return removeSubscriber(email, publicationId);
}

/**
 * Look up a contact in this brand's Beehiiv publication. Resolves the
 * publicationId from config and calls findSubscriber. Mirrors SendGrid's
 * findContact() surface so tests can use the same pattern across both
 * providers.
 *
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findContact(email) {
  const publicationId = getPublicationId();

  if (!publicationId) {
    return null;
  }

  return findSubscriber(email, publicationId);
}

/**
 * List this brand's Beehiiv subscriptions, following cursor pagination to the
 * end. One publication belongs to one brand, so the result is brand-scoped by
 * construction — no brand filter needed (unlike SendGrid, whose account is
 * shared across brands).
 *
 * @param {object} [options]
 * @param {string} [options.status] - Beehiiv status filter ('active', 'inactive', ...); omitted = all
 * @param {Array<string>} [options.expand] - Expandable objects ('stats', 'custom_fields', ...)
 * @param {Function} [request] - HTTP call, injectable so the pagination contract
 *                               is testable without a network (defaults to wonderful-fetch)
 * @returns {{ success: boolean, subscriptions?: Array<object>, error?: string }}
 */
async function listSubscriptions({ status, expand } = {}, request = fetch) {
  const publicationId = getPublicationId();

  if (!publicationId) {
    return { success: false, error: 'Publication not found' };
  }

  const subscriptions = [];
  let cursor = null;

  try {
    for (let page = 0; page < SUBSCRIPTION_MAX_PAGES; page++) {
      // Hand-built rather than URLSearchParams: the expandable list is
      // Beehiiv's literal `expand[]` key, which URLSearchParams would encode.
      const params = [`limit=${SUBSCRIPTION_PAGE_LIMIT}`];

      if (status) {
        params.push(`status=${encodeURIComponent(status)}`);
      }

      for (const item of (expand || [])) {
        params.push(`expand[]=${encodeURIComponent(item)}`);
      }

      if (cursor) {
        params.push(`cursor=${encodeURIComponent(cursor)}`);
      }

      const data = await request(`${BASE_URL}/publications/${publicationId}/subscriptions?${params.join('&')}`, {
        response: 'json',
        headers: headers(),
        timeout: BEEHIIV_TIMEOUT_MS,
      });

      const items = data.data || [];

      subscriptions.push(...items);

      // Beehiiv's deprecated offset shape carries no `has_more` at all, so the
      // cursor walk below would stop after page 1 and report a truncated list
      // as a complete one. There is more to come whenever the page count says
      // so or the page came back full, and a walk that cannot continue fails
      // rather than under-reporting who is left.
      if (data.has_more === undefined && (data.total_pages > 1 || items.length >= SUBSCRIPTION_PAGE_LIMIT)) {
        console.error('[@omega.js/backend:email:providers:beehiiv] listSubscriptions got an offset-paginated response — refusing to report a truncated list');

        return { success: false, error: 'Unexpected offset-paginated response' };
      }

      if (!data.has_more || !data.next_cursor) {
        return { success: true, subscriptions };
      }

      cursor = data.next_cursor;
    }

    console.error(`[@omega.js/backend:email:providers:beehiiv] listSubscriptions hit the ${SUBSCRIPTION_MAX_PAGES}-page cap — refusing to report a truncated list`);

    return { success: false, error: `Pagination exceeded ${SUBSCRIPTION_MAX_PAGES} pages` };
  } catch (e) {
    console.error('[@omega.js/backend:email:providers:beehiiv] listSubscriptions error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Build Beehiiv custom_fields array from a user doc.
 * Resolves all field values, then maps to display names for Beehiiv.
 * Beehiiv matches custom fields by their display name.
 *
 * The catalog decides which fields Beehiiv owns (fieldsForProvider): a field
 * on its row's nativeFields is never provisioned there, so writing it would
 * push a value at a custom field that does not exist on every sync.
 *
 * @param {object} userDoc - User document from Firestore
 * @returns {Array<{name: string, value: string}>} Custom fields in Beehiiv format
 */
function buildFields(userDoc) {
  const values = resolveFieldValues(userDoc, instance().config);
  const owned = new Set(fieldsForProvider('beehiiv'));
  const fields = [];

  for (const [name, value] of Object.entries(values)) {
    if (!owned.has(name)) {
      continue;
    }

    const fieldConfig = FIELDS[name];
    const displayName = fieldConfig?.display || name;
    fields.push({ name: displayName, value: String(value) });
  }

  return fields;
}

// Cached segment name → Beehiiv segment ID map
let _segmentIdCache = null;

/**
 * Fetch segment definitions from Beehiiv and build a name → id map.
 * Segments are created by OMEGA with names matching the SSOT keys in constants.js.
 * Cached in memory for the lifetime of the process.
 *
 * @returns {object} Map of segment name → Beehiiv segment ID
 */
async function resolveSegmentIds() {
  if (_segmentIdCache) {
    return _segmentIdCache;
  }

  const publicationId = getPublicationId();

  if (!publicationId) {
    return {};
  }

  try {
    const data = await fetch(`${BASE_URL}/publications/${publicationId}/segments?limit=100`, {
      response: 'json',
      headers: headers(),
      timeout: BEEHIIV_TIMEOUT_MS,
    });

    _segmentIdCache = {};

    for (const segment of (data.data || [])) {
      _segmentIdCache[segment.name] = segment.id;
    }

    console.log(`Beehiiv resolveSegmentIds: ${Object.keys(_segmentIdCache).length} segments loaded:`, _segmentIdCache);

    return _segmentIdCache;
  } catch (e) {
    // Thrown, not an empty map: an empty map reads as every key unknown, a coded
    // 400 config fault, while an outage is a code-less failure (success: false)
    console.error('Beehiiv resolveSegmentIds error:', e);
    throw e;
  }
}

// --- Campaigns (Posts) ---

/**
 * Create a Beehiiv post (their equivalent of a campaign/newsletter) on the
 * brand's publication.
 *
 * @param {object} options - title (required), subject (defaults to title),
 *   preheader, content (HTML body), contentTags (Beehiiv `content_tags`),
 *   status ('draft' or 'confirmed', the default, which sends), sendAt (an ISO
 *   datetime to schedule, 'now', or none for immediate), and segments /
 *   excludeSegments (Beehiiv segment IDs)
 * @returns {{ success: boolean, id?: string, scheduled?: boolean, error?: string }}
 */
async function createPost(options) {
  const publicationId = getPublicationId();

  if (!publicationId) {
    return { success: false, error: 'Publication not found' };
  }

  const { title, subject, preheader, content, contentTags, status, sendAt, segments, excludeSegments } = options;

  try {
    const body = {
      title,
      // A draft stays a draft whatever sendAt says: a testing run never sends
      status: status === 'draft' ? 'draft' : 'confirmed',
    };

    // Content
    if (content) {
      body.body_content = content;
    }

    // Tags (Beehiiv field is `content_tags`, array of strings)
    if (Array.isArray(contentTags) && contentTags.length) {
      body.content_tags = contentTags;
    }

    // Scheduling
    if (sendAt && sendAt !== 'now' && body.status !== 'draft') {
      body.scheduled_at = new Date(sendAt).toISOString();
    }

    // Email settings
    const emailSettings = {};

    if (subject) {
      emailSettings.subject_line = subject;
    }
    if (preheader) {
      emailSettings.preview_text = preheader;
    }

    if (Object.keys(emailSettings).length) {
      body.email_settings = emailSettings;
    }

    // Audience targeting (segments)
    if ((segments && segments.length) || (excludeSegments && excludeSegments.length)) {
      body.recipients = {};

      if (segments && segments.length) {
        body.recipients.segment_ids = segments;
      }
      if (excludeSegments && excludeSegments.length) {
        body.recipients.exclude_segment_ids = excludeSegments;
      }
    }

    console.log('Beehiiv createPost body:', JSON.stringify(body, null, 2));

    const data = await fetch(`${BASE_URL}/publications/${publicationId}/posts`, {
      method: 'post',
      response: 'json',
      headers: headers(),
      timeout: BEEHIIV_TIMEOUT_MS,
      body,
    });

    if (data.data?.id) {
      const scheduled = !!sendAt && body.status !== 'draft';
      return { success: true, id: data.data.id, scheduled };
    }

    return { success: false, error: data.message || 'Unknown error' };
  } catch (e) {
    console.error('Beehiiv createPost error:', e);
    return { success: false, error: e.message };
  }
}

module.exports = {
  // Resolution
  resolveSegmentIds,
  getPublicationId,

  // Contacts
  addContact,
  findContact,
  findSubscriber,
  listSubscriptions,
  removeContact,
  buildFields,

  // Campaigns
  createPost,
};
