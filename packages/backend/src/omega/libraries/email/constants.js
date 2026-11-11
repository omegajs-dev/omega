/**
 * Shared constants for email libraries (transactional + marketing)
 *
 * SSOT for templates, ASM groups, and semantic senders.
 * Used by: transactional/index.js, marketing/index.js, providers/*
 */
const { emailProvider } = require('@omega.js/config/email-providers');

// Template shortcut map — callers use readable paths instead of SendGrid IDs
// Paths mirror the email website structure: {category}/{subcategory}/{name}
// Unsubscribe-group (ASM) KEYS — the SSOT for which groups exist. The ids are
// per SendGrid ACCOUNT, so they are NOT code: the manager's campaigns service
// provisions the groups by name and writes each id into config at
// marketing.campaigns.providers.sendgrid.groups.<key>, which prepare.js reads
// at send time. A hardcoded id here belonged to whoever's account created it
// ([#649](https://github.com/Omega-JS-Stack/omega/issues/649)).
const GROUP_KEYS = ['orders', 'hello', 'account', 'marketing', 'security', 'newsletter', 'internal'];

// The group every send falls back to when its sender category names none
const DEFAULT_GROUP_KEY = 'account';

// Semantic sender categories — pass `sender: 'orders'` to auto-resolve from address,
// display name, and unsubscribe group (`group` names a GROUP_KEYS key; prepare.js
// resolves it to the account's id from config)
const SENDERS = {
  // Payment receipts, failed/recovered, cancellation, plan changes, refunds, trial ending
  orders: {
    localPart: 'orders',
    displayName: '{brand} Orders',
    group: 'orders',
  },
  // Warm onboarding: welcome, 7-day checkup, feedback request
  hello: {
    localPart: 'hello',
    displayName: '{brand}',
    group: 'hello',
  },
  // Transactional account actions: deletion, data requests
  account: {
    localPart: 'account',
    displayName: '{brand} Account',
    group: 'account',
  },
  // Promotions, discounts, win-back, abandoned cart, app download link
  marketing: {
    localPart: 'offers',
    displayName: '{brand}',
    group: 'marketing',
  },
  // Forgot password, 2FA, password reset
  security: {
    localPart: 'security',
    displayName: '{brand} Security',
    group: 'security',
  },
  // Monthly newsletters, feature announcements, industry news
  newsletter: {
    localPart: 'newsletter',
    displayName: '{brand}',
    group: 'newsletter',
  },
  // Dispute alerts, system notifications sent to brand contact
  internal: {
    localPart: 'alerts',
    displayName: '{brand} Alerts',
    group: 'internal',
  },
};


// SendGrid limit for scheduled emails (72 hours, but use 71 for buffer)
const SEND_AT_LIMIT = 71;

// --- Campaign scheduling helpers (SSOT — used by seed-campaigns + both cron jobs) ---
const moment = require('moment');

/**
 * Get the next occurrence of a specific weekday.
 * @param {number} dayOfWeek - 0=Sunday, 1=Monday, ..., 6=Saturday
 * @param {number} hour - Hour (UTC, 0-23)
 * @param {number} [minute=0] - Minute (0-59)
 * @returns {number} Unix timestamp
 */
function nextWeekday(dayOfWeek, hour, minute = 0) {
  const next = moment.utc().startOf('day').hour(hour).minute(minute);

  while (next.day() !== dayOfWeek || next.isBefore(moment.utc())) {
    next.add(1, 'day');
  }

  return next.unix();
}

/**
 * Get the next occurrence of the Nth weekday in a month (e.g., 2nd Wednesday).
 * @param {number} nth - Which occurrence (1=first, 2=second, 3=third, 4=fourth)
 * @param {number} dayOfWeek - 0=Sunday, 1=Monday, ..., 6=Saturday
 * @param {number} hour - Hour (UTC, 0-23)
 * @param {number} [minute=0] - Minute (0-59)
 * @returns {number} Unix timestamp
 */
function nextNthWeekday(nth, dayOfWeek, hour, minute = 0) {
  function findNthWeekdayInMonth(m) {
    const first = m.clone().startOf('month');
    const day = first.clone();

    // Advance to the first matching weekday
    while (day.day() !== dayOfWeek) {
      day.add(1, 'day');
    }

    // Advance to the Nth occurrence
    day.add(nth - 1, 'weeks');

    return day.hour(hour).minute(minute).second(0).millisecond(0);
  }

  const thisMonth = findNthWeekdayInMonth(moment.utc());

  if (thisMonth.isAfter(moment.utc())) {
    return thisMonth.unix();
  }

  return findNthWeekdayInMonth(moment.utc().add(1, 'month')).unix();
}

/**
 * Get the next occurrence of a specific day of month.
 * @param {number} dayOfMonth - Day (1-31)
 * @param {number} hour - Hour (UTC, 0-23)
 * @param {number} [minute=0] - Minute (0-59)
 * @returns {number} Unix timestamp
 */
function nextMonthDay(dayOfMonth, hour, minute = 0) {
  const next = moment.utc().startOf('month').date(dayOfMonth).hour(hour).minute(minute);

  if (next.isBefore(moment.utc())) {
    next.add(1, 'month');
  }

  return next.unix();
}

/**
 * Calculate the next occurrence unix timestamp from the current sendAt.
 *
 * Supports:
 *   - daily, weekly, monthly, quarterly, yearly — simple interval addition
 *   - monthly-weekday — Nth weekday of the month (e.g., 2nd Wednesday)
 *     Requires recurrence: { pattern: 'monthly-weekday', nth, day, hour, minute? }
 *
 * @param {number} currentSendAt - Current fire time (unix)
 * @param {object} recurrence - { pattern, hour, day, nth?, minute? }
 * @returns {number} Next fire time (unix)
 */
function getNextOccurrence(currentSendAt, recurrence) {
  const current = moment.unix(currentSendAt).utc();
  const { pattern } = recurrence;

  switch (pattern) {
    case 'daily':
      return current.add(1, 'day').unix();

    case 'weekly':
      return current.add(1, 'week').unix();

    case 'monthly':
      return current.add(1, 'month').unix();

    case 'monthly-weekday': {
      const target = current.clone().add(1, 'month').startOf('month');

      while (target.day() !== recurrence.day) {
        target.add(1, 'day');
      }

      target.add((recurrence.nth || 1) - 1, 'weeks');

      return target
        .hour(recurrence.hour)
        .minute(recurrence.minute || 0)
        .second(0)
        .millisecond(0)
        .unix();
    }

    case 'quarterly':
      return current.add(3, 'months').unix();

    case 'yearly':
      return current.add(1, 'year').unix();

    default:
      return current.add(1, 'month').unix();
  }
}

/**
 * Like getNextOccurrence, but guarantees the returned time is in the FUTURE.
 *
 * A recurring campaign that stalled for several periods (cron outage, sources
 * dried up, repeated failures) advances past ALL missed occurrences instead of
 * firing a catch-up burst — one send per cron tick until sendAt catches up.
 *
 * @param {number} currentSendAt - Current fire time (unix)
 * @param {object} recurrence - { pattern, hour, day, nth?, minute? }
 * @param {number} [now] - Unix time to advance past (defaults to Date.now())
 * @returns {number} Next fire time strictly after `now`
 */
function getNextFutureOccurrence(currentSendAt, recurrence, now) {
  now = now || Math.round(Date.now() / 1000);

  let next = getNextOccurrence(currentSendAt, recurrence);

  while (next <= now) {
    const after = getNextOccurrence(next, recurrence);

    // Safety: a recurrence must strictly advance, otherwise bail out
    if (after <= next) {
      break;
    }

    next = after;
  }

  return next;
}

/**
 * Make brand images email-safe: SVG URLs become PNG equivalents (email
 * clients don't render SVGs; CDN naming convention `-x.svg` -> `-1024.png`)
 * and site-relative paths (the config's stored shape — the website
 * absolutizes per environment) become absolute against brand.url, since an
 * email client can only fetch a public URL.
 */
function sanitizeImagesForEmail(images, brandUrl) {
  const base = String(brandUrl || '').replace(/\/$/, '');
  const result = {};

  for (const [key, value] of Object.entries(images)) {
    let sanitized = value;

    if (typeof sanitized === 'string' && sanitized.endsWith('.svg')) {
      sanitized = sanitized.replace(/-x\.svg$/, '-1024.png');
    }
    if (typeof sanitized === 'string' && sanitized.startsWith('/') && base) {
      sanitized = `${base}${sanitized}`;
    }

    result[key] = sanitized;
  }

  return result;
}

/**
 * URL-encode a value as base64
 */
function encode(s) {
  return encodeURIComponent(Buffer.from(String(s)).toString('base64'));
}

/**
 * Escape a value for safe interpolation into email HTML.
 *
 * Every value that did NOT come from us — third-party webhook payloads (Stripe,
 * Ethoca), AI-authored strings, user-submitted fields — must go through this before
 * it lands inside a first-party markup string, or the markup lane becomes an
 * injection lane.
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The only URL schemes allowed to reach an email href. Everything outside this list
// (javascript:, data:, vbscript:, file:) is a script vector in whichever client
// doesn't happen to block it.
const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * Escape a URL for safe interpolation into an email href.
 *
 * escapeHtml() alone cannot make an href safe — `javascript:alert(1)` survives
 * escaping intact — and a third-party or AI-authored URL (a dispute alert's
 * stripeUrl, a newsletter source's url, an AI-written CTA) is exactly where one
 * arrives. A scheme outside the allowlist is DROPPED: the link goes dead and the
 * drop is logged, rather than throwing, because one bad URL inside a webhook or AI
 * payload must not take down the whole alert email.
 *
 * A relative value (no scheme at all) passes through — it cannot carry script.
 */
function safeUrl(value) {
  const raw = String(value ?? '').trim();

  if (!raw) {
    return '';
  }

  // Clients ignore whitespace, control characters AND zero-width/format characters
  // inside the scheme, so a tab or a zero-width space inside `java...script:` still
  // leaves a live javascript: URL — strip all three classes before matching. \p{Cf}
  // is the class covering the invisible ones (ZWSP/ZWNJ/ZWJ, word joiner, bidi
  // marks, soft hyphen, BOM).
  const match = raw.replace(/[\s\p{Cc}\p{Cf}]/gu, '').match(/^[a-z][a-z0-9+.-]*:/i);
  const scheme = match ? match[0].toLowerCase() : '';

  if (scheme && !ALLOWED_URL_SCHEMES.includes(scheme)) {
    console.error(`[@omega.js/backend:email:constants] safeUrl dropped href with disallowed scheme "${scheme}"`);

    return '';
  }

  return escapeHtml(raw);
}

/**
 * Create an Error with a code property for distinguishing build (400) vs send (500) failures.
 */
function errorWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The SSOT of every marketing custom field (adding one: docs/backend/marketing-fields.md).
// `source` reads `path` from the user doc ('user'), the User's subscription
// getters ('resolved', computed in resolveFieldValues()) or omega.config ('config').
// A field a provider stores natively is on its row's `nativeFields`, never here.
const FIELDS = {
  // Brand
  brand_id:                              { display: 'Brand ID', source: 'config', path: 'brand.id', type: 'text' },

  // User identity
  user_auth_uid:                         { display: 'User UID', source: 'user', path: 'auth.uid', type: 'text' },
  user_personal_name_first:              { display: 'First Name', source: 'user', path: 'personal.name.first', type: 'text' },
  user_personal_name_last:               { display: 'Last Name', source: 'user', path: 'personal.name.last', type: 'text' },
  user_personal_company:                 { display: 'Company', source: 'user', path: 'personal.company.name', type: 'text' },
  user_personal_country:                 { display: 'Country', source: 'user', path: 'personal.location.country', type: 'text' },
  user_metadata_signup_date:             { display: 'Signup Date', source: 'user', path: 'metadata.created.timestamp', type: 'date' },
  user_metadata_last_activity:           { display: 'Last Activity', source: 'user', path: 'metadata.updated.timestamp', type: 'date' },

  // Subscription
  user_subscription_plan:                { display: 'Plan', source: 'resolved', path: 'plan', type: 'text' },
  user_subscription_status:              { display: 'Status', source: 'resolved', path: 'status', type: 'text' },
  user_subscription_trialing:            { display: 'Trialing', source: 'resolved', path: 'trialing', type: 'text' },
  user_subscription_trial_claimed:       { display: 'Trial Claimed', source: 'user', path: 'subscription.trial.claimed', type: 'text' },
  user_subscription_cancelling:          { display: 'Cancelling', source: 'resolved', path: 'cancelling', type: 'text' },
  user_subscription_ever_paid:           { display: 'Ever Paid', source: 'resolved', path: 'everPaid', type: 'text' },
  user_subscription_payment_provider:     { display: 'Payment Provider', source: 'user', path: 'subscription.payment.provider', type: 'text' },
  user_subscription_payment_frequency:   { display: 'Payment Frequency', source: 'user', path: 'subscription.payment.frequency', type: 'text' },
  user_subscription_payment_price:       { display: 'Payment Price', source: 'user', path: 'subscription.payment.price', type: 'number' },
  user_subscription_payment_last_date:   { display: 'Last Payment Date', source: 'user', path: 'subscription.payment.updatedBy.date.timestamp', type: 'date' },

  // Attribution
  user_attribution_utm_source:           { display: 'UTM Source', source: 'user', path: 'attribution.last.tags.utm_source', type: 'text' },
};

// The SSOT of every marketing segment: OMEGA creates each one in every provider
// not on its optional `skip` list (the manager's ensure/segments.js), and the backend
// resolves a key to the provider's id at runtime. A condition is a 'field' (from
// FIELDS above) or 'engagement' (the provider's own open and click tracking).
const SEGMENTS = {
  // Subscription
  subscription_free:          { display: 'Free Users', conditions: [{ field: 'user_subscription_plan', op: '==', value: 'basic' }] },
  subscription_paid:          { display: 'Paid Users', conditions: [{ field: 'user_subscription_plan', op: '!=', value: 'basic' }, { field: 'user_subscription_status', op: '==', value: 'active' }] },
  subscription_trialing:      { display: 'Trialing', conditions: [{ field: 'user_subscription_trialing', op: '==', value: 'true' }] },
  subscription_cancelling:    { display: 'Cancelling', conditions: [{ field: 'user_subscription_cancelling', op: '==', value: 'true' }] },
  subscription_suspended:     { display: 'Suspended', conditions: [{ field: 'user_subscription_status', op: '==', value: 'suspended' }] },
  subscription_cancelled:     { display: 'Cancelled', conditions: [{ field: 'user_subscription_status', op: '==', value: 'cancelled' }] },
  subscription_churned_paid:  { display: 'Churned Paid (Paid → Cancelled)', conditions: [{ field: 'user_subscription_ever_paid', op: '==', value: 'true' }, { field: 'user_subscription_status', op: '==', value: 'cancelled' }] },
  subscription_churned_trial: { display: 'Churned Trial (Trial → Never Paid)', conditions: [{ field: 'user_subscription_trial_claimed', op: '==', value: 'true' }, { field: 'user_subscription_ever_paid', op: '!=', value: 'true' }] },
  subscription_ever_paid:     { display: 'Ever Paid', conditions: [{ field: 'user_subscription_ever_paid', op: '==', value: 'true' }] },
  subscription_never_paid:    { display: 'Never Paid', conditions: [{ field: 'user_subscription_ever_paid', op: '!=', value: 'true' }] },

  // Lifecycle (time since signup)
  lifecycle_7d:               { display: 'Signed Up Last 7 Days', conditions: [{ field: 'user_metadata_signup_date', op: 'within', value: '7d' }] },
  lifecycle_30d:              { display: 'Signed Up Last 30 Days', conditions: [{ field: 'user_metadata_signup_date', op: 'within', value: '30d' }] },
  lifecycle_90d:              { display: 'Signed Up Last 90 Days', conditions: [{ field: 'user_metadata_signup_date', op: 'within', value: '90d' }] },
  lifecycle_6m:               { display: 'Signed Up Last 6 Months', conditions: [{ field: 'user_metadata_signup_date', op: 'within', value: '180d' }] },
  lifecycle_1y:               { display: 'Signed Up Last 1 Year', conditions: [{ field: 'user_metadata_signup_date', op: 'within', value: '365d' }] },

  // Engagement (provider built-in open/click tracking)
  engagement_active_30d:      { display: 'Engaged Last 30 Days', conditions: [{ type: 'engagement', op: 'opened_or_clicked', value: '30d' }] },
  engagement_active_90d:      { display: 'Engaged Last 90 Days', conditions: [{ type: 'engagement', op: 'opened_or_clicked', value: '90d' }] },
  engagement_inactive_90d:    { display: 'Inactive 90+ Days', conditions: [{ type: 'engagement', op: 'not_opened', value: '90d' }] },
  engagement_inactive_5m:     { display: 'Inactive 5+ Months', conditions: [{ type: 'engagement', op: 'not_opened_or_clicked', value: '150d' }, { type: 'engagement', op: 'received_gte', value: '5' }, { field: 'user_metadata_signup_date', op: 'not_within', value: '150d' }] },
  engagement_inactive_6m:     { display: 'Inactive 6+ Months', conditions: [{ type: 'engagement', op: 'not_opened_or_clicked', value: '180d' }, { type: 'engagement', op: 'received_gte', value: '5' }, { field: 'user_metadata_signup_date', op: 'not_within', value: '180d' }] },

  // Test
  test_admin:                 { display: 'Test Admin', conditions: [{ type: 'contact', op: 'email_is', value: 'hello@itwcreativeworks.com' }] },
};

/**
 * The catalog's view of ONE provider: the field names it provisions, and so
 * the exact set its contact sync may write ([#695](https://github.com/Omega-JS-Stack/omega/issues/695)).
 *
 * Derived from the provider's row: every catalog field but its `nativeFields`.
 * OMEGA's custom-fields ensure provisions this list (through the manager's
 * lib/backend-marketing.js) and the provider's buildFields() writes it, so a
 * field the catalog omits can never become a runtime "no field ID" surprise.
 *
 * @param {string} provider - Provider id (a row of @omega.js/config's EMAIL_PROVIDERS)
 * @returns {string[]} The field names that provider owns
 */
function fieldsForProvider(provider) {
  const row = emailProvider(provider);

  if (!row) {
    throw new Error(`fieldsForProvider: "${provider}" is not an email provider (@omega.js/config's EMAIL_PROVIDERS)`);
  }

  return Object.keys(FIELDS).filter((name) => !row.nativeFields.includes(name));
}

/**
 * Resolve all field values from a user doc + config.
 * Returns a map of semantic field names → resolved values (type-coerced).
 * Providers use this internally to build their native field format.
 *
 * @param {object} userDoc - User document from Firestore
 * @param {object} config - omega.config
 * @returns {object} Map of semantic name → value (e.g., { plan: 'basic', status: 'active', ... })
 */
const _ = require('lodash');
const { User } = require('../../helpers/account.js');

function resolveFieldValues(userDoc, config) {
  const resolved = new User(userDoc);
  const subscription = userDoc.subscription || {};

  // Computed values from the User's subscription getters + raw status
  const resolvedValues = {
    plan: resolved.plan,
    status: subscription.status || 'active',
    everPaid: String(resolved.everPaid),
    trialing: String(resolved.trialing),
    cancelling: String(resolved.cancelling),
  };

  const result = {};

  for (const [name, fieldConfig] of Object.entries(FIELDS)) {
    let value;

    if (fieldConfig.source === 'config') {
      value = _.get(config, fieldConfig.path);
    } else if (fieldConfig.source === 'resolved') {
      value = resolvedValues[fieldConfig.path];
    } else {
      value = _.get(userDoc, fieldConfig.path);
    }

    if (value == null) {
      continue;
    }

    // Coerce booleans to strings for text fields
    if (fieldConfig.type === 'text' && typeof value === 'boolean') {
      value = String(value);
    }

    // Coerce to number for number fields
    if (fieldConfig.type === 'number' && typeof value !== 'number') {
      value = Number(value) || 0;
    }

    // Skip epoch default dates (1970-01-01)
    if (fieldConfig.type === 'date' && (!value || value === '1970-01-01T00:00:00.000Z')) {
      continue;
    }

    result[name] = value;
  }

  return result;
}

module.exports = {
  GROUP_KEYS,
  DEFAULT_GROUP_KEY,
  SENDERS,
  FIELDS,
  SEGMENTS,
  SEND_AT_LIMIT,
  sanitizeImagesForEmail,
  encode,
  escapeHtml,
  safeUrl,
  errorWithCode,
  fieldsForProvider,
  resolveFieldValues,
  nextWeekday,
  nextNthWeekday,
  nextMonthDay,
  getNextOccurrence,
  getNextFutureOccurrence,
};
