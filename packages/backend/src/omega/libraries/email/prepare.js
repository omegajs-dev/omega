/**
 * Shared email preparation — normalizes inputs for both transactional and marketing paths.
 *
 * Both paths need the same "email envelope": brand (with sanitized images), sender (from + ASM group),
 * content (markdown→HTML or pre-rendered HTML), signoff defaults, categories, and unsubscribe URL.
 * This module builds that envelope once so the callers just do their path-specific work
 * (transactional: recipients + SendGrid Mail Send; marketing: audience targeting + Single Send).
 *
 * Used by: transactional/index.js, marketing/index.js
 */
const _ = require('lodash');
const MarkdownIt = require('markdown-it');

// Two renderers, one trust decision.
//
// UNTRUSTED is the default: campaign bodies authored by AI, user-submitted fields,
// anything arriving over a route. Raw HTML is disabled, so a `<script>` or
// `<img onerror>` smuggled into the markdown renders as inert text instead of live
// markup in someone's inbox.
//
// TRUSTED is opt-in (`trusted: true`) for first-party callers that author their own
// markup — the internal alert emails that build `<ul>`/`<strong>` blocks by hand.
// Those callers must escape any third-party value they interpolate (escapeHtml).
const mdUntrusted = new MarkdownIt({ html: false, breaks: true, linkify: true });
const mdTrusted = new MarkdownIt({ html: true, breaks: true, linkify: true });

const {
  GROUP_KEYS,
  DEFAULT_GROUP_KEY,
  SENDERS,
  senderFrom,
  sanitizeImagesForEmail,
  encode,
  errorWithCode,
} = require('./constants.js');
const { tagLinks } = require('./utm.js');
const env = require('../env.js');
const { renderEmail } = require('./generators/lib/mjml-template.js');

/**
 * Resolve brand data with email-safe images (SVG→PNG), plus the RESOLVED
 * company the footer credits ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)):
 * the loader fills `company` from the brand's `company: { id }`, and a brand
 * with no company resolves to its own name and url, so the footer needs no
 * fallback of its own.
 *
 * @param {object} omega
 * @returns {{ brand: object, brandDomain: string, company: object }}
 */
function resolveBrand(omega) {
  const raw = omega.config?.brand;

  if (!raw) {
    throw errorWithCode('Missing brand configuration in config/omega.json5', 400);
  }

  const brand = _.cloneDeep(raw);
  brand.images = sanitizeImagesForEmail(brand.images || {}, brand.url);

  if (!brand.contact?.email) {
    throw errorWithCode('Missing brand.contact.email in config/omega.json5', 400);
  }

  const brandDomain = brand.contact.email.split('@')[1];

  const company = _.cloneDeep(omega.config?.company || {});
  company.images = sanitizeImagesForEmail(company.images || {}, company.url || brand.url);

  return { brand, brandDomain, company };
}

/**
 * Resolve an unsubscribe-group KEY to this account's ASM group id.
 *
 * The ids belong to the brand's own SendGrid account, so config is their one
 * home (`marketing.campaigns.providers.sendgrid.groups.<key>`, written back by
 * the manager's campaigns service). A missing one is a PROGRAMMER error — the
 * manage walk never ran, or ran before this key existed — so it fails loudly
 * here instead of attaching another account's group to a real send
 * ([#649](https://github.com/Omega-JS-Stack/omega/issues/649)).
 *
 * @param {string} key - A GROUP_KEYS key
 * @param {object} omega
 * @returns {number} The account's ASM group id
 */
function resolveGroupId(key, omega) {
  const groupId = omega?.config?.marketing?.campaigns?.providers?.sendgrid?.groups?.[key];

  if (groupId == null) {
    throw errorWithCode(
      `Missing unsubscribe group id for "${key}" — set marketing.campaigns.providers.sendgrid.groups.${key} in config/omega.json5 by running the manage walk (the campaigns service provisions the SendGrid groups and writes their ids)`,
      400,
    );
  }

  return groupId;
}

/**
 * Resolve sender (from address + ASM group) from a sender category key.
 *
 * @param {object} options
 * @param {string} [options.sender] - Sender category key ('orders', 'hello', 'marketing', etc.)
 * @param {object} [options.from] - Explicit from override
 * @param {number|string} [options.group] - Explicit override: a GROUP_KEYS key
 *   (resolved from config) or a raw ASM group id (used as-is)
 * @param {object} brand - Resolved brand object
 * @param {string} brandDomain - Brand email domain
 * @param {object} omega - Carries the account's group ids in config
 * @returns {{ from: object, groupId: number }}
 */
function resolveSender({ sender, from, group }, brand, brandDomain, omega) {
  const senderConfig = SENDERS[sender] || null;

  const resolvedFrom = from
    || senderFrom(sender, { brandName: brand.name || '', domain: brandDomain })
    || { email: brand.contact.email, name: brand.name };

  const groupId = group != null
    ? (GROUP_KEYS.includes(group) ? resolveGroupId(group, omega) : group)
    : resolveGroupId(senderConfig ? senderConfig.group : DEFAULT_GROUP_KEY, omega);

  return { from: resolvedFrom, groupId };
}

/**
 * Render content to HTML. Accepts markdown OR pre-rendered HTML.
 * Applies UTM link tagging to the result.
 *
 * @param {object} options
 * @param {string} [options.content] - Markdown content. Rendered with raw HTML
 *   DISABLED unless `trusted` is set — this is the lane untrusted content arrives on.
 * @param {string} [options.html] - Pre-rendered HTML (skips markdown). A caller passing
 *   this is declaring it authored the markup; never point it at untrusted input.
 * @param {boolean} [options.trusted] - Allow raw HTML inside `content`. First-party
 *   callers only (internal alert emails that hand-build markup).
 * @param {object} utmOptions - UTM tagging options
 * @returns {string} Email-safe HTML
 */
function renderContent({ content, html, trusted }, utmOptions) {
  let rendered = html || '';

  if (!rendered && content) {
    rendered = (trusted ? mdTrusted : mdUntrusted).render(content);
  }

  if (rendered && utmOptions) {
    rendered = tagLinks(rendered, utmOptions);
  }

  return rendered;
}

// The send/campaign fields that hand the renderer raw HTML, or the trust to render
// it. Each one is a real first-party lane AND a complete bypass of the escaped lane,
// so no caller arriving over the API may set any of them. `html` joined the list on
// Ian's ruling for [#125](https://github.com/Omega-JS-Stack/omega/issues/125): the
// admin/MCP lane matches the API lane exactly, raw HTML stays internal.
const INTERNAL_ONLY_SEND_FIELDS = [
  { path: 'data.content.html', what: 'the raw-HTML body passthrough' },
  { path: 'html', what: 'the top-level raw-HTML override that replaces the rendered MJML body' },
  { path: 'contentHtml', what: 'the pre-rendered campaign HTML the newsletter generator hands over' },
  { path: 'trustedContent', what: 'the flag that renders raw HTML inside the body' },
];

/**
 * The internal-only-field fault for a caller-facing lane, or null when clean.
 *
 * Each field in INTERNAL_ONLY_SEND_FIELDS skips or disarms the escaped renderer:
 * whatever it carries lands in the inbox as live markup. That is by declaration for
 * INTERNAL callers (the newsletter generator hands over pre-rendered HTML; the
 * dispute alert hand-builds its own markup), but a caller arriving over the API —
 * including an admin-authenticated AI on the MCP `send_email` / `create_campaign`
 * tools — must never reach any of them, or the escaped lane is one field away from
 * being bypassed. Every external email lane checks its raw settings through here
 * BEFORE handing them to the library; internal callers don't call it and are unchanged.
 *
 * @param {object} [settings] - Caller-supplied send/campaign settings
 * @returns {?Error} A coded-400 permanent fault, or null when every field is absent
 */
function internalOnlyFieldFault(settings) {
  const found = INTERNAL_ONLY_SEND_FIELDS.find((field) => _.has(settings, field.path));

  if (!found) {
    return null;
  }

  return errorWithCode(
    `Parameter ${found.path} is internal-caller only — ${found.what} is not accepted over the API. Send markdown in data.content.message instead.`,
    400,
  );
}

/**
 * Build signoff defaults: the team signoff unless the caller passed its own,
 * which passes through untouched.
 *
 * @param {object} [signoff] - Caller-provided signoff (or empty)
 * @returns {object} Complete signoff object
 */
function resolveSignoff(signoff) {
  return { type: 'team', ...signoff };
}

/**
 * Build categories array with type prefix + brand ID.
 *
 * @param {string} type - 'transactional' or 'marketing'
 * @param {string} brandId
 * @param {string[]} [extra] - Additional categories from caller
 * @returns {string[]}
 */
function buildCategories(type, brandId, extra) {
  const powertools = require('node-powertools');

  return _.uniq([
    type,
    brandId,
    ...powertools.arrayify(extra),
  ].filter(Boolean));
}

/**
 * Build an HMAC-signed unsubscribe URL for transactional emails.
 *
 * @param {object} options
 * @param {string} options.email - Recipient email
 * @param {number} options.groupId - ASM group ID
 * @param {string} options.template - Template name
 * @param {string} options.websiteUrl - Brand website URL
 * @returns {string}
 */
function buildUnsubscribeUrl({ email, groupId, template, websiteUrl }) {
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', env.require('UNSUBSCRIBE_HMAC_KEY'))
    .update(email.toLowerCase())
    .digest('hex');

  return `${websiteUrl}/portal/email-preferences?email=${encode(email)}&asmId=${encode(groupId)}&template=${encode(template)}&sig=${sig}`;
}

/**
 * Build the full template data tree for MJML rendering.
 * Merges system defaults (brand, signoff, email metadata) with caller-provided data.
 *
 * @param {object} options
 * @param {object} options.brand - Resolved brand object
 * @param {string} options.subject
 * @param {string} [options.preview] - Preheader text
 * @param {string} [options.contentHtml] - Rendered HTML body
 * @param {object} [options.signoff] - Resolved signoff
 * @param {string} [options.unsubscribeUrl]
 * @param {string[]} [options.categories]
 * @param {boolean} [options.copy] - Whether this email is carbon-copied
 * @param {object} [options.callerData] - Additional data from the caller (order, user, etc.)
 * @returns {object} Complete template data tree
 */
function buildTemplateData({
  brand,
  company,
  subject,
  preview,
  contentHtml,
  signoff,
  unsubscribeUrl,
  categories,
  copy,
  callerData,
}) {
  const uuid = require('uuid');

  const defaults = {
    email: {
      id: uuid.v4(),
      subject,
      preview: preview || null,
      unsubscribeUrl: unsubscribeUrl || `${brand.url}/portal/email-preferences`,
      categories,
      footer: { text: null },
      carbonCopy: copy ?? true,
    },
    signoff,
    brand,
    // The RESOLVED company (#677): the footer's wordmark and credit line
    company: company || {},
  };

  // Deep-merge caller data on top of defaults.
  // Callers can override any field and add custom data (order, body, user, etc.).
  if (callerData) {
    _.merge(defaults, callerData);
  }

  // Inject rendered HTML into content.message. When contentHtml is provided, it
  // replaces whatever the caller had in content.message (the raw markdown was
  // already consumed by renderContent() to produce this HTML).
  if (contentHtml) {
    _.set(defaults, 'content.message', contentHtml);
  }

  return defaults;
}

/**
 * Render template data through MJML and return compiled HTML.
 *
 * @param {object} options
 * @param {object} options.brand - Resolved brand
 * @param {string} options.template - Template name ('card', 'plain', 'order', etc.)
 * @param {object} options.data - Complete template data tree
 * @param {object} [options.utm] - UTM overrides for link tagging ({ campaign, type })
 * @returns {Promise<{ html: string, mjml: string, errors: object[] }>}
 */
async function render({ brand, template, data, utm }) {
  return renderEmail({ brand, template: template || 'card', data, utm });
}

module.exports = {
  resolveBrand,
  resolveSender,
  renderContent,
  internalOnlyFieldFault,
  resolveSignoff,
  buildCategories,
  buildUnsubscribeUrl,
  buildTemplateData,
  render,
};
