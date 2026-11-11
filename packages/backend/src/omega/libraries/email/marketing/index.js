/**
 * Marketing email library — contact syncing + campaign management
 *
 * Pipeline: prepare (shared) → content → audience → render → deliver
 *
 * Usage:
 *   const email = ctx.email;
 *
 *   // Add a new contact (newsletter subscribe, lightweight)
 *   await email.add({ email, firstName, lastName, source });
 *
 *   // Sync a user's full data to every role's provider (all custom fields)
 *   await email.sync(userDoc);
 *
 *   // Remove a contact from all providers
 *   await email.remove('user@example.com');
 *
 *   // Send a marketing campaign (Single Send)
 *   await email.send({ type: 'marketing', name, subject, segments, ... });
 *
 * Used by:
 * - routes/marketing/contact (add)
 * - routes/user/signup (sync on signup — call site also gates on consent to skip the paid mailbox check)
 * - Payment transition handlers (sync on subscription change)
 * - Auth on-delete handler (remove contact)
 * - Campaign cron jobs (send campaigns)
 *
 * Consent gate: add() and sync() skip users whose consent.marketing.status is the
 * literal string 'revoked' and return { blocked: 'consent', email }. Missing consent,
 * null, or any other value proceeds — legacy users have no consent field and must
 * keep syncing. remove() is always safe and stays ungated.
 */
const _ = require('lodash');

const { tagLinks } = require('../utm.js');
const { validate } = require('../validation.js');
const prepare = require('../prepare.js');
const { errorWithCode } = require('../constants.js');
const { providerModule } = require('../providers/index.js');
const { EMAIL_PROVIDERS, emailProviderForRole } = require('@omega.js/config/email-providers');
const env = require('../../env.js');

// The role words (campaigns, newsletter), one per provider row
const ROLES = Object.values(EMAIL_PROVIDERS).map((row) => row.role);

function Marketing(ctx) {
  const self = this;

  self.ctx = ctx;
  self.omega = ctx.omega;
  self.admin = self.omega.firebase.admin;

  self.providers = Object.fromEntries(ROLES.map((role) => [role, roleOn(self.omega.config, role)]));

  return self;
}

/**
 * A role is on unless its config switch is off, and only when the env key on
 * its provider's row is set.
 *
 * @param {object} config - omega.config
 * @param {string} role - The role word (`campaigns`, `newsletter`)
 * @returns {boolean}
 */
function roleOn(config, role) {
  return config?.marketing?.[role]?.enabled !== false && env.has(emailProviderForRole(role).envKey);
}

/**
 * The provider module serving a role, from the registry (providers/index.js)
 * by its row id. Callers read its functions at call time, so the module stays
 * one object.
 *
 * @param {string} role - The role word (`campaigns`, `newsletter`)
 * @returns {object} The provider module
 */
function roleProvider(role) {
  return providerModule(emailProviderForRole(role).id);
}

// ============================================================
// Contact management (add / sync / remove)
// ============================================================

/**
 * Consent gate — true ONLY when consent.marketing.status is the literal string 'revoked'.
 * Missing consent, null, or any other value proceeds — legacy users have no consent field
 * and must keep syncing.
 *
 * @param {object|null|undefined} userDoc - User doc data (or null/undefined when no user exists)
 * @returns {boolean}
 */
function isMarketingRevoked(userDoc) {
  return userDoc?.consent?.marketing?.status === 'revoked';
}

/**
 * Look up a user doc by email (same query the marketing webhook providers use).
 * Returns the doc data, or null when no user matches OR the lookup fails (fail open —
 * a rare duplicate add is recoverable; silently dropping contacts is not).
 *
 * @param {object} admin - firebase-admin instance
 * @param {object} ctx - Assistant (for logging)
 * @param {string} email - Email address
 * @returns {Promise<object|null>}
 */
async function findUserByEmail(admin, ctx, email) {
  const snapshot = await admin.firestore().collection('users')
    .where('auth.email', '==', email.trim().toLowerCase())
    .limit(1)
    .get()
    .catch((e) => {
      ctx.error('Marketing: User lookup by email failed (proceeding without consent gate):', e);
      return null;
    });

  if (!snapshot || snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].data();
}

// Exposed as statics for plain-node unit tests (consent-gate.test.js,
// campaign-config-fault.test.js)
Marketing.isMarketingRevoked = isMarketingRevoked;
Marketing.findUserByEmail = findUserByEmail;
Marketing.providerFailure = providerFailure;
Marketing.roleOn = roleOn;
Marketing.roleProvider = roleProvider;

Marketing.prototype.add = async function (options) {
  const self = this;
  const ctx = self.ctx;
  const { email, firstName, lastName, company, source, customFields } = options;

  if (!email) {
    ctx.warn('Marketing.add(): No email provided, skipping');
    return {};
  }

  // Consent gate — if this email maps to a user who revoked marketing consent, never
  // re-add them. No user doc → proceed (pure newsletter contact). Lookup failure →
  // proceed (fail open, logged in findUserByEmail).
  const userDoc = await findUserByEmail(self.admin, ctx, email);

  if (isMarketingRevoked(userDoc)) {
    ctx.warn(`Marketing.add(): Consent revoked, skipping: ${email}`);
    return { blocked: 'consent', email };
  }

  const validation = await validate(email);
  if (!validation.valid) {
    ctx.warn(`Marketing.add(): Validation failed, skipping: ${email}`, validation.checks);
    return { blocked: 'validation', email, checks: validation.checks };
  }

  if (ctx.isTesting() && !process.env.TEST_EXTENDED_MODE) {
    ctx.log('Marketing.add(): Skipping providers (testing mode)');
    return {};
  }

  // Same trim remove() got: the address is this line's PAYLOAD, not its subject,
  // and it sits in Cloud Logging for the whole retention window
  // ([#710](https://github.com/Omega-JS-Stack/omega/issues/710)). The line names
  // which providers are about to be asked; the address is at debug.
  ctx.log(`Marketing.add(): ${enabledProviders(self).join(', ') || 'no providers enabled'}`);
  ctx.debug('Marketing.add():', { email });

  const results = {};
  const promises = [];

  if (self.providers.campaigns) {
    promises.push(
      roleProvider('campaigns').addContact({ email, firstName, lastName, company, customFields })
        .then((r) => { results.campaigns = r; })
        .catch((e) => {
          ctx.error('Marketing.add(): campaigns failed:', e);
          results.campaigns = { success: false, error: e.message };
        })
    );
  }

  if (self.providers.newsletter) {
    promises.push(
      roleProvider('newsletter').addContact({ email, firstName, lastName, company, source })
        .then((r) => { results.newsletter = r; })
        .catch((e) => {
          ctx.error('Marketing.add(): newsletter failed:', e);
          results.newsletter = { success: false, error: e.message };
        })
    );
  }

  await Promise.all(promises);

  // Each provider answers with its own payload (a contact record, a
  // subscriber), and every one carries the address back. The verdict per
  // provider is what the line is for; the payloads are at debug.
  ctx.log('Marketing.add() result:', summarizeResults(results));
  ctx.debug('Marketing.add() result:', results);

  return results;
};

Marketing.prototype.sync = async function (userDocOrUid) {
  const self = this;
  const ctx = self.ctx;

  let userDoc;

  if (typeof userDocOrUid === 'string') {
    const snap = await self.admin.firestore().doc(`users/${userDocOrUid}`).get()
      .catch((e) => {
        ctx.error('Marketing.sync(): Failed to fetch user doc:', e);
        return null;
      });

    if (!snap || !snap.exists) {
      ctx.warn(`Marketing.sync(): User ${userDocOrUid} not found, skipping`);
      return {};
    }

    userDoc = snap.data();
  } else {
    userDoc = userDocOrUid;
  }

  const email = _.get(userDoc, 'auth.email');

  if (!email) {
    ctx.warn('Marketing.sync(): No email found in user doc, skipping');
    return {};
  }

  // Consent gate — never re-add a user who revoked marketing consent (payment-event
  // syncs, admin re-syncs, and batch syncs all funnel through here).
  if (isMarketingRevoked(userDoc)) {
    ctx.warn(`Marketing.sync(): Consent revoked, skipping: ${email}`);
    return { blocked: 'consent', email };
  }

  const validation = await validate(email);
  if (!validation.valid) {
    ctx.warn(`Marketing.sync(): Validation failed, skipping: ${email}`, validation.checks);
    return { blocked: 'validation', email, checks: validation.checks };
  }

  if (ctx.isTesting() && !process.env.TEST_EXTENDED_MODE) {
    ctx.log('Marketing.sync(): Skipping providers (testing mode)');
    return {};
  }

  // The address is the payload here too (#710) — the line names the providers.
  ctx.log(`Marketing.sync(): ${enabledProviders(self).join(', ') || 'no providers enabled'}`);
  ctx.debug('Marketing.sync():', { email });

  const firstName = _.get(userDoc, 'personal.name.first');
  const lastName = _.get(userDoc, 'personal.name.last');
  const source = _.get(userDoc, 'attribution.last.tags.utm_source');
  const results = {};
  const promises = [];

  if (self.providers.campaigns) {
    promises.push(
      roleProvider('campaigns').buildFields(userDoc).then((customFields) =>
        roleProvider('campaigns').addContact({ email, firstName, lastName, customFields })
      ).then((r) => { results.campaigns = r; })
        .catch((e) => {
          ctx.error('Marketing.sync(): campaigns failed:', e);
          results.campaigns = { success: false, error: e.message };
        })
    );
  }

  if (self.providers.newsletter) {
    promises.push(
      roleProvider('newsletter').addContact({
        email, firstName, lastName, source,
        customFields: roleProvider('newsletter').buildFields(userDoc),
      }).then((r) => { results.newsletter = r; })
        .catch((e) => {
          ctx.error('Marketing.sync(): newsletter failed:', e);
          results.newsletter = { success: false, error: e.message };
        })
    );
  }

  await Promise.all(promises);

  // The provider payloads carry the address back — verdict at log, payloads at
  // debug (#710). A sync's payloads also echo the custom fields built from the
  // user doc (name, plan, attribution), which is more of the same class.
  ctx.log('Marketing.sync() result:', summarizeResults(results));
  ctx.debug('Marketing.sync() result:', results);

  return results;
};

Marketing.prototype.remove = async function (email) {
  const self = this;
  const ctx = self.ctx;

  if (!email) {
    ctx.warn('Marketing.remove(): No email provided, skipping');
    return {};
  }

  if (ctx.isTesting() && !process.env.TEST_EXTENDED_MODE) {
    ctx.log('Marketing.remove(): Skipping providers (testing mode)');
    return {};
  }

  // The address is this line's PAYLOAD, not its subject: a removal is one step
  // of the caller's own invocation, which already names whose account it is, and
  // an address in Cloud Logging sits there for the whole retention window — the
  // same PII the #657 sweep took off the auth trigger headlines
  // ([#710](https://github.com/Omega-JS-Stack/omega/issues/710)). What the line
  // needs is which providers are about to be asked; the address is at debug.
  ctx.log(`Marketing.remove(): ${enabledProviders(self).join(', ') || 'no providers enabled'}`);
  ctx.debug('Marketing.remove():', { email });

  const results = {};
  const promises = [];

  if (self.providers.campaigns) {
    promises.push(
      roleProvider('campaigns').removeContact(email)
        .then((r) => { results.campaigns = r; })
        .catch((e) => {
          ctx.error('Marketing.remove(): campaigns failed:', e);
          results.campaigns = { success: false, error: e.message };
        })
    );
  }

  if (self.providers.newsletter) {
    promises.push(
      roleProvider('newsletter').removeContact(email)
        .then((r) => { results.newsletter = r; })
        .catch((e) => {
          ctx.error('Marketing.remove(): newsletter failed:', e);
          results.newsletter = { success: false, error: e.message };
        })
    );
  }

  await Promise.all(promises);

  // Each provider answers with its own payload (a contact record, a
  // subscriber), and every one of them carries the address back. The
  // verdict per provider is what the line is for; the payloads are at debug.
  ctx.log('Marketing.remove() result:', summarizeResults(results));
  ctx.debug('Marketing.remove() result:', results);

  return results;
};

/**
 * The providers a contact call will be asked of, by name.
 *
 * @param {object} self - The Marketing instance.
 * @returns {Array<string>} The enabled provider keys.
 */
function enabledProviders(self) {
  return Object.keys(self.providers).filter((provider) => self.providers[provider]);
}

/**
 * A results object as one line: which provider answered, and how.
 *
 * @param {object} results - Provider key → that provider's own result payload.
 * @returns {string} e.g. `campaigns=ok newsletter=failed`.
 */
function summarizeResults(results) {
  const entries = Object.entries(results);

  if (!entries.length) {
    return 'no providers enabled';
  }

  return entries.map(([provider, result]) => `${provider}=${result?.success ? 'ok' : 'failed'}`).join(' ');
}

// ============================================================
// Campaign management
// ============================================================

/**
 * Create and optionally schedule a marketing campaign across the roles that are on:
 * resolve template variables, render the content (markdown in data.content.message,
 * or the internal `contentHtml`), resolve the segment keys on each role's provider
 * and then the campaigns audience, and dispatch. A key or an audience that resolves
 * to nothing fails the campaign with a coded 400 naming it, and nothing is sent.
 *
 * @param {object} settings - name, subject, preheader, template, data, sender,
 *   segments/excludeSegments (keys), lists, all, sendAt ('now', a date, or none
 *   for a draft), group, categories, test, and providers (the roles to send through)
 * @returns {{ campaigns?: object, newsletter?: object }}
 */
Marketing.prototype.sendCampaign = async function (settings) {
  const self = this;
  const omega = self.omega;
  const ctx = self.ctx;

  const roles = (settings.providers || ROLES).filter((role) => self.providers[role]);
  const notRoles = (settings.providers || []).filter((word) => !ROLES.includes(word));

  // A word that is no role would quietly narrow the send, so nothing is sent
  if (notRoles.length) {
    const fault = providerFailure(errorWithCode(`Campaign "${settings.name}": ${notRoles.join(', ')} is not a role (${ROLES.join(', ')})`, 400));
    ctx.log('Marketing.sendCampaign() results:', fault.error);
    return Object.fromEntries(notRoles.map((word) => [word, fault]));
  }

  // --- 1. Resolve template variables ---
  const brand = omega.config?.brand;
  const templateContext = buildTemplateContext(brand, settings);
  let resolved = resolveTemplateVars(settings, templateContext);

  if (settings.test) {
    ctx.log('Marketing.sendCampaign(): TEST MODE — targeting test_admin segment only');
    resolved = {
      ...resolved,
      name: `[TEST] ${resolved.name}`,
      segments: ['test_admin'],
      excludeSegments: [],
      lists: [],
      all: false,
    };
  }

  // --- 2. Render content ---
  // Newsletter generator pre-renders HTML and passes it as top-level contentHtml.
  // Human-authored campaigns pass markdown in data.content.message.
  const callerContent = resolved.data?.content || {};
  const contentHtml = resolved.contentHtml
    || callerContent.html
    || prepare.renderContent(
      { content: callerContent.message },
      {
        brandUrl: brand?.url,
        brandId: brand?.id,
        campaign: resolved.name,
        type: 'marketing',
        utm: resolved.utm,
      },
    );

  ctx.log('Marketing.sendCampaign():', {
    name: resolved.name,
    providers: roles,
    sendAt: settings.sendAt || 'draft',
  });

  // --- 3. Resolve each role's audience before anything is sent ---
  const audiences = {};
  const results = {};

  for (const role of roles) {
    await ROLE_LEGS[role].audience(resolved, brand?.id)
      .then((audience) => { audiences[role] = audience; })
      .catch((e) => { results[role] = providerFailure(e); });
  }

  // --- 4. Dispatch: a coded 400 (a bad key, an audience of nobody) holds every
  // role, while a code-less failure fails its own role and the others send ---
  const held = Object.values(results).some((result) => result.code === 400);

  try {
    if (!held) {
      await Promise.all(Object.keys(audiences).map((role) => ROLE_LEGS[role].send(ctx, resolved, contentHtml, audiences[role])
        .then((r) => { results[role] = r; })
        .catch((e) => { results[role] = providerFailure(e); })));
    }
  } finally {
    for (const audience of Object.values(audiences)) {
      if (audience.cleanup) {
        await audience.cleanup();
      }
    }
  }

  // A provider's result carries its send id and, on a failure, whatever the
  // provider said: verdict at log, the payloads at debug.
  ctx.log('Marketing.sendCampaign() results:', summarizeResults(results));
  ctx.debug('Marketing.sendCampaign() results:', results);

  return results;
};

Marketing.prototype.cancelCampaign = async function (campaignId) {
  this.ctx.log('Marketing.cancelCampaign():', campaignId);
  return roleProvider('campaigns').cancelSingleSend(campaignId);
};

Marketing.prototype.getCampaign = async function (campaignId) {
  return roleProvider('campaigns').getSingleSend(campaignId);
};

Marketing.prototype.listCampaigns = async function (options) {
  return roleProvider('campaigns').listSingleSends(options);
};

// ============================================================
// Campaign delivery per role (private)
// ============================================================

/**
 * Convert a provider throw into the result shape callers read.
 *
 * A CODED error keeps its code: prepare.js's config-hole throws are
 * errorWithCode(..., 400), and swallowing that into a plain { success: false }
 * makes a permanent brand-config hole indistinguishable from a transient
 * provider failure — the campaigns cron needs the difference to finalize the
 * campaign instead of retrying it every occurrence forever. The key is OMITTED
 * when the error has no code: results are persisted on the campaign doc, and
 * Firestore rejects undefined field values.
 *
 * @param {Error} error
 * @returns {{ success: false, error: string, code?: number }}
 */
function providerFailure(error) {
  return error.code
    ? { success: false, error: error.message, code: error.code }
    : { success: false, error: error.message };
}

/**
 * The campaigns role: prepare → render → create Single Send → schedule.
 *
 * @param {object} ctx - The Marketing instance's ctx (its `omega` resolves the brand)
 * @param {object} settings - Resolved campaign settings
 * @param {string} contentHtml - Pre-rendered HTML body
 * @param {object} audience - campaignsAudience()'s `{ sendTo, excludeSegments }`
 * @returns {{ success: boolean, id?: string, scheduled?: boolean, error?: string }}
 */
async function sendCampaignsEmail(ctx, settings, contentHtml, audience) {
  // --- Prepare ---
  const { brand, brandDomain, company } = prepare.resolveBrand(ctx.omega);
  const { from, groupId } = prepare.resolveSender(
    { sender: settings.sender || 'marketing', from: settings.from, group: settings.group },
    brand,
    brandDomain,
    ctx.omega,
  );
  const categories = prepare.buildCategories('marketing', brand.id, settings.categories);
  const signoff = prepare.resolveSignoff(settings.signoff);

  // --- Render ---
  // Marketing Single Sends can't use per-recipient HMAC links (one HTML for all recipients).
  // Use the provider's ASM tag instead: replaced with a real per-recipient URL at delivery time.
  const unsubscribeUrl = '<%asm_group_unsubscribe_raw_url%>';

  const templateData = prepare.buildTemplateData({
    brand,
    company,
    subject: settings.subject,
    preview: settings.preheader,
    contentHtml,
    signoff,
    unsubscribeUrl,
    categories,
    callerData: settings.data,
  });

  const rendered = await prepare.render({
    brand,
    template: settings.template || 'card',
    data: templateData,
    utm: { campaign: settings.name || settings.template || 'campaign', type: 'marketing' },
  });

  // --- Create Single Send ---
  const provider = roleProvider('campaigns');
  const createResult = await provider.createSingleSend({
    name: settings.name,
    subject: settings.subject,
    from,
    sendTo: audience.sendTo,
    excludeSegments: audience.excludeSegments,
    asmGroupId: groupId,
    categories,
    htmlContent: rendered.html,
  });

  if (!createResult.success) {
    return createResult;
  }

  // --- Schedule ---
  if (!settings.sendAt) {
    return { success: true, id: createResult.id, scheduled: false };
  }

  const sendAt = settings.sendAt === 'now' ? 'now' : new Date(settings.sendAt).toISOString();
  const scheduleResult = await provider.scheduleSingleSend(createResult.id, sendAt);

  if (!scheduleResult.success) {
    return { success: false, id: createResult.id, error: scheduleResult.error };
  }

  return { success: true, id: createResult.id, scheduled: true };
}

/**
 * The newsletter role: one post, sent or scheduled, and only ever a draft on a
 * testing run. Its title is the subject (else the name), and the settings'
 * `contentTags` ride along as the post's tags.
 *
 * @param {object} ctx - The Marketing instance's ctx (`isTesting()`)
 * @param {object} settings - Resolved campaign settings
 * @param {string} contentHtml - Pre-rendered HTML body
 * @param {object} audience - newsletterAudience()'s `{ segments, excludeSegments }` ids
 * @returns {{ success: boolean, id?: string, scheduled?: boolean, error?: string }}
 */
async function sendNewsletterPost(ctx, settings, contentHtml, audience) {
  return roleProvider('newsletter').createPost({
    title: settings.subject || settings.name,
    subject: settings.subject,
    preheader: settings.preheader,
    content: contentHtml,
    contentTags: settings.contentTags,
    status: ctx.isTesting() ? 'draft' : 'confirmed',
    sendAt: settings.sendAt,
    segments: audience.segments,
    excludeSegments: audience.excludeSegments,
  });
}

/**
 * A role's segment keys as its provider's ids. A key the provider does not know
 * throws a coded 400 naming it; a campaign with no keys never lists segments.
 *
 * @param {string} role - The role word
 * @param {object} settings - Resolved campaign settings (segment keys)
 * @returns {Promise<{ segments: string[], excludeSegments: string[] }>}
 */
async function segmentIds(role, settings) {
  const keys = { segments: settings.segments || [], excludeSegments: settings.excludeSegments || [] };
  const all = [...keys.segments, ...keys.excludeSegments];

  if (!all.length) {
    return keys;
  }

  const idMap = await roleProvider(role).resolveSegmentIds();
  const unknown = all.filter((key) => !idMap[key]);

  if (unknown.length) {
    throw errorWithCode(`Campaign "${settings.name}": segment ${unknown.join(', ')} resolves to nothing on the ${role} provider`, 400);
  }

  return { segments: keys.segments.map((key) => idMap[key]), excludeSegments: keys.excludeSegments.map((key) => idMap[key]) };
}

/**
 * The newsletter role's audience: its segment ids, nothing to clean up.
 *
 * @param {object} settings - Resolved campaign settings (segment keys)
 * @returns {Promise<{ segments: string[], excludeSegments: string[] }>}
 */
function newsletterAudience(settings) {
  return segmentIds('newsletter', settings);
}

/**
 * The campaigns role's audience: its segments scoped to the brand (temp
 * segments, removed by `cleanup`), else the lists, else the brand list. An
 * audience that resolves to nobody throws a coded 400 naming its keys.
 *
 * @param {object} settings - Resolved campaign settings (segment keys)
 * @param {string} brandId
 * @returns {Promise<{ sendTo: object, excludeSegments: string[], cleanup: Function }>}
 */
async function campaignsAudience(settings, brandId) {
  const provider = roleProvider('campaigns');
  const keys = { segments: settings.segments || [], excludeSegments: settings.excludeSegments || [] };
  const ids = await segmentIds('campaigns', settings);
  const cleanups = [];
  const cleanup = async () => {
    for (const fn of cleanups) {
      await fn();
    }
  };
  // One temp segment ANDing the given ones with the brand; none means nobody
  const scoped = async (providerIds, segmentKeys, skipBrandFilter) => {
    const temp = await provider.createBrandScopedSegment(providerIds, brandId, { skipBrandFilter });

    if (!temp) {
      throw errorWithCode(`Campaign "${settings.name}": segment ${segmentKeys.join(', ')} resolves to no audience`, 400);
    }

    cleanups.push(temp.cleanup);
    return temp.segmentId;
  };

  try {
    const sendTo = {};

    if (settings.all) {
      sendTo.all = true;
    } else if (ids.segments.length) {
      sendTo.segment_ids = [await scoped(ids.segments, keys.segments, settings.test)];
    } else if (settings.lists?.length) {
      sendTo.list_ids = settings.lists;
    } else if (provider.getListId()) {
      sendTo.list_ids = [provider.getListId()];
    } else {
      throw errorWithCode(`Campaign "${settings.name}" resolves to no audience: no segments, no lists, and no brand list`, 400);
    }

    const excludeSegments = ids.excludeSegments.length && !settings.test
      ? [await scoped(ids.excludeSegments, keys.excludeSegments, true)]
      : [];

    return { sendTo, excludeSegments, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// Each role's legs: `audience(settings, brandId)` builds what its sender reads
// before anything is sent, then `send(ctx, settings, contentHtml, audience)`
const ROLE_LEGS = {
  campaigns: { audience: campaignsAudience, send: sendCampaignsEmail },
  newsletter: { audience: newsletterAudience, send: sendNewsletterPost },
};

// ============================================================
// Campaign template variable resolution
// ============================================================

const SEASONS = {
  0: 'Winter', 1: 'Winter', 2: 'Spring', 3: 'Spring', 4: 'Spring', 5: 'Summer',
  6: 'Summer', 7: 'Summer', 8: 'Fall', 9: 'Fall', 10: 'Fall', 11: 'Winter',
};

const HOLIDAYS = {
  0: 'New Year', 1: 'Valentine\'s Day', 2: 'Spring', 3: 'Spring',
  4: 'Memorial Day', 5: 'Summer', 6: 'Independence Day', 7: 'Back to School',
  8: 'Labor Day', 9: 'Halloween', 10: 'Black Friday', 11: 'Christmas',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildTemplateContext(brand, settings) {
  const now = new Date();
  const month = now.getMonth();

  const discountCodes = require('../../payment/discount-codes.js');
  const discountCode = settings?.data?.content?.discountCode || settings?.discountCode;
  const discount = discountCode
    ? discountCodes.validate(discountCode)
    : { code: '', percent: '' };

  return {
    brand: brand || {},
    season: { name: SEASONS[month] },
    holiday: { name: HOLIDAYS[month] },
    date: {
      month: MONTH_NAMES[month],
      year: String(now.getFullYear()),
      full: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    },
    discount: {
      code: discount.code || '',
      percent: discount.percent || '',
    },
  };
}

function resolveTemplateVars(obj, context) {
  const template = require('node-powertools').template;

  if (typeof obj === 'string') {
    if (!obj.includes('{')) {
      return obj;
    }

    const resolved = template(obj, context);
    return resolved.replace(/\bnull\b|\bundefined\b/g, '').replace(/[^\S\n]{2,}/g, ' ').trim();
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveTemplateVars(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result = {};

    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveTemplateVars(value, context);
    }

    return result;
  }

  return obj;
}

module.exports = Marketing;
