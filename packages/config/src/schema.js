/**
 * Canonical schema for config/omega.json5 — pure data, no logic.
 *
 * Entry format:
 *
 *   {
 *     path:        'brand.id',            // dot-path into the RESOLVED config
 *     type:        'string' | 'boolean' | 'number' | 'integer' | 'array' | 'object',
 *     required:    true | false | (config) => bool,
 *     min:         Number,                // only checked when value present + number
 *     max:         Number,                // only checked when value present + number
 *     match:       RegExp,                // only checked when value present + string
 *     enum:        [...],                 // only checked when value present
 *     itemEnum:    [...],                 // an ARRAY value's allowed members
 *     default:     <value>,               // the framework answer — see below
 *     description: 'What the field drives.',
 *   }
 *
 * configSections() below derives the per-target list of top-level sections
 * this schema declares ([#607](https://github.com/Omega-JS-Stack/omega/issues/607)):
 * a page's frontmatter overrides config keys under a `config:` parent, and
 * that list is BOTH halves of the rule — a section restated bare is a build
 * error, and a key under `config:` that is not a section is one too. Page
 * machinery (`meta`, `schema`, `layout`, `permalink`) is not config and has
 * no home here: `meta` in particular lives in page frontmatter alone, its
 * site-wide default being brand.name / brand.description (the head's
 * fallback), so the config section it briefly had is registered RETIRED.
 *
 * `default:` is the ONE home of every config default
 * ([#478](https://github.com/Omega-JS-Stack/omega/issues/478)): defaults.js
 * builds the merge chain's LOWEST layer from these entries, and the manage
 * walk materializes any missing block into the brand's omega.json5 with this
 * description as its guiding comment. A key with no sane framework answer —
 * owner decisions, tri-states that mean "ask", ids the services provision,
 * anything secret-shaped — carries NO `default:` and is never materialized.
 *
 * `materialize: false` is the one exception to that second sentence
 * ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)): the rule's
 * `default:` still resolves (every reader sees it) but is never WRITTEN into a
 * brand file. It is for framework facts a brand may override and rarely does —
 * presentation the framework owns, like the packaged connection cards — where a
 * copy in every brand config would drift from the framework it came from.
 *
 * The other standing exclusion is the PRESENCE GATE (#425), which means the
 * sections a service reads presence from: `monitoring.providers.sentry` is the
 * brand's pick of Sentry, so those SDK knobs carry NO default and keep their
 * home in @omega.js/monitoring, and `advertising` is the brand's pick of ads
 * (#527 — the adsense `client` id is the ONE switch, and a materialized
 * advertising block would switch the web build's automatic vert placements on
 * for a brand that configured none). Blocks whose services gate on `enabled`
 * instead (cloudflare, searchConsole, slapform, chatsy, replyify)
 * DO carry the default that states the polarity (`enabled: true`, read
 * `!== false`), because presence there picks nothing. Role-level switches
 * beside any providers block (`monitoring.enabled`,
 * `marketing.campaigns.enabled`) always may. The gating doctrine those three
 * cases come from lives in docs/shared/config.md.
 *
 * Rules run against the RESOLVED config for a target — target-section keys
 * are overlaid at the top level by loadConfig() (targets.desktop.platforms
 * validates as `platforms`), which is also how any shared key inside a
 * target entry overrides the shared value.
 *
 * SHARED_SCHEMA always applies; TARGET_SCHEMAS[target] adds that target's
 * refinements, seeded from real brand configs, never from guesses.
 */

// Rule sets kept in their own files, one concern each.
const { MANAGER_RULES } = require('./schema-manager.js');
const { CLIENT_RULES } = require('./schema-client.js');
const { CLOUD_CONFIG_RULES } = require('./schema-cloud.js');
const { DOMAIN_RULES } = require('./schema-domain.js');
const { EDGE_RULES } = require('./schema-edge.js');
const { OVERRIDE_RULES } = require('./schema-overrides.js');
const { WINDOWS_SIGNING_STRATEGIES, WINDOWS_CLOUD_PROVIDERS } = require('./windows-signing.js');
const { TARGET_TYPE_ROWS } = require('./target-types.js');

// The durations a winback coupon can be built for on every provider that
// supports the offer (#268). Stripe's third option ('repeating') needs a
// duration_in_months beside it, which is provider surface nothing here asks
// for. It lives HERE, with the rule that enumerates it, so winback.js can
// derive its offer defaults from this schema without a require cycle;
// winback.js re-exports it, so every existing import keeps working.
const WINBACK_DURATIONS = ['once', 'forever'];

// Where a brand hosts its SOURCE, and where a web target is SERVED from
// ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)). One value each
// today: a second provider is a new entry here plus that provider's own helper,
// never a reshape of the config. They live HERE, with the rules that enumerate
// them, so repo.js can derive without a require cycle (the WINBACK_DURATIONS
// pattern above); repo.js re-exports both, and every reader takes them there.
const REPO_PROVIDERS = ['github'];
const HOSTING_PROVIDERS = ['github'];

// The category slugs addons.mozilla.org accepts on a listing (its live set on
// 2026-09-11). AMO has no utilities or productivity slug, so the framework
// default is `alerts-updates`, the most generic one that is not `other`
// ([#884](https://github.com/Omega-JS-Stack/omega/issues/884)). It lives HERE,
// with the rule that enumerates it (the WINBACK_DURATIONS pattern above), and
// @omega.js/extension's Firefox lane takes the SAME list from this package when
// it writes a first publish's `--amo-metadata` file: a slug AMO does not know
// fails in the build instead of at the store.
const AMO_CATEGORIES = ['alerts-updates', 'appearance', 'bookmarks', 'download-management', 'feeds-news-blogging', 'games-entertainment', 'language-support', 'photos-music-videos', 'privacy-security', 'search-tools', 'shopping', 'social-communication', 'tabs', 'web-development', 'other'];

// Canonical target TYPES: the frameworks a `targets.<name>.type` may name
// (#886), one per target-types.js row. Key presence in a config's `targets`
// object = "this brand enables a target by that name".
const TARGETS = TARGET_TYPE_ROWS.map((row) => row.id);

// A brand also runs targets no framework owns — a Render API, a worker, a
// script (#603). Those declare `type: 'custom'` like any other target
// (`targets.api: { type: 'custom' }`), and their verbs come entirely from the
// target's own package.json scripts; the manager is the one that runs them
// (docs/manager/index.md).
const CUSTOM_TARGET_TYPE = 'custom';

/**
 * Whether a `targets.<name>` entry declares itself custom.
 *
 * @param {object|null|undefined} entry - The raw targets.<name> value.
 * @returns {boolean} True when the entry is a custom target.
 */
function isCustomTargetEntry(entry) {
  return entry?.type === CUSTOM_TARGET_TYPE;
}

// What SHAPE the backend target deploys as (#584). Not to be confused with the
// custom TARGET above: that is a target no framework owns; this is the
// @omega.js/backend target itself, running its Express app on `PORT` for a
// container host (Render & co) instead of exporting Cloud Functions. Same
// framework, same auth middleware, same helpers — a different artifact, and
// with it no Functions deploy and no emulator lane.
const BACKEND_PROJECT_TYPES = ['firebase', 'custom'];

/**
 * The backend target's project type. Reads a `targets.backend` entry or a
 * RESOLVED backend config alike — a target entry's keys land at the top level
 * of the resolved view, so `projectType` is in the same place either way.
 *
 * Anything that isn't the literal 'custom' reads as 'firebase': the validator
 * is what makes a nonsense value loud, and a READER must never take a brand
 * off Cloud Functions on a typo.
 *
 * @param {object|null|undefined} entry - targets.backend, or a resolved backend config.
 * @returns {'firebase'|'custom'}
 */
function backendProjectType(entry) {
  return entry?.projectType === 'custom' ? 'custom' : 'firebase';
}

// The page routes a brand translates when it says nothing
// ([#858](https://github.com/Omega-JS-Stack/omega/issues/858), Ian 2026-09-13):
// the whole site except the blog. Named here, beside the rule that defaults to
// it, because the web build's matcher reads the same constant rather than
// keeping a second copy of the framework's answer.
const TRANSLATION_INCLUDE_DEFAULT = ['**', '!blog/**'];

// The machine-owned top-level sections identical in every omega.json5 —
// omega-manager's disperse enumerates THIS list instead of hardcoding
// per-target mapping blocks. (`targets` itself is the scoping key, not a
// shared section; `theme` is project-owned but shared-shaped.)
const SHARED_SECTIONS = ['brand', 'cloud', 'repo', 'edge', 'captcha', 'search', 'forms', 'inbound', 'analytics', 'advertising', 'features', 'payment', 'monitoring', 'connections', 'theme', 'translation'];

// Which config sections a BROWSER may see, and how much of each: the ONE
// declaration behind clientConfig() ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)).
// Every browser surface bakes its artifact through that function (web's page
// chrome, desktop's renderer bundle, every extension bundle), so a value goes
// public by gaining a row HERE, never by a per-framework list. The flag is
// per SECTION, at the granularity the section's public half needs:
//
//   `client: true`        the whole section rides (its keys are public by design:
//                         secrets never live in omega.json5, and the validator
//                         hard-fails a secret-shaped key anywhere in the file)
//   `client: [paths]`     only these sub-paths ride, for a section whose other
//                         keys are provisioning-only (nothing secret, nothing a
//                         runtime reads)
//   no row                the browser never sees it: cloud/GCP provisioning,
//                         the account admins, the repo and edge plumbing, every
//                         build-only section (platforms, purgecss, collections…)
//
// A new section defaults to INVISIBLE, which fails as a missing feature rather
// than a leak. The build FACTS a surface composes beside these sections
// (runtime, version, dev, …) are client-config.js's own list.
const CLIENT_SECTIONS = {
  advertising: true,
  analytics: true,
  app:         true,
  brand:       true,
  captcha:     true,
  client:      true,
  // The Firebase WEB config is public by design (the api key included) and is
  // what boots @omega.js/client on all three surfaces; the GCP account facts
  // beside it (billingAccount, organizationId, apiSubdomain) are provisioning.
  cloud:       ['config', 'messaging.vapidKey'],
  company:     true,
  connections: true,
  features:    true,
  // The contact page's endpoint, and nothing else the slapform service keeps
  // beside it (template ids, plan, update flags).
  forms:       ['providers.slapform.formId'],
  // The chat widget's agent and its presentation, same rule.
  inbound:     ['chat.providers.chatsy.enabled', 'chat.providers.chatsy.agentId', 'chat.providers.chatsy.settings'],
  listings:    true,
  monitoring:  true,
  payment:     true,
  theme:       true,
};

// brand.id's slug rule — the ONE home for the pattern. Anything that gates a
// caller-supplied brand id (the backend verts routes' normalizeBrandId) imports
// this instead of copying the regex.
const BRAND_ID_PATTERN = /^[a-z][a-z0-9+\-.]*$/;

const SHARED_SCHEMA = [
  ...MANAGER_RULES,
  // ── the target's own url ─────────────────────────────────────────────────
  {
    path:        'url',
    type:        'string',
    required:    false,
    match:       /^https?:\/\//,
    description: "This TARGET's own public URL, and the one key a target entry may set at the top level. A target whose name is not its type derives it from the name (`admin: { type: 'web' }` → https://admin.<host of brand.url>; docs/shared/config.md → Targets); an entry's own `url` overrides it for a custom host. `brand.url` stays the BRAND's url, which is what brand-level facts (authDomain, the persona domain) read.",
  },

  // ── the target's own type (#886) ─────────────────────────────────────────
  // Declared ONCE, here: every target entry carries it, whatever its
  // framework, and a copy per TARGET_SCHEMAS would be four copies of one
  // contract ([#911](https://github.com/Omega-JS-Stack/omega/issues/911)). It
  // is target-entry machinery like `url`, so it names no config SECTION.
  {
    path:        'type',
    type:        'string',
    required:    false,
    enum:        [...TARGETS, CUSTOM_TARGET_TYPE],
    description: "The FRAMEWORK that runs this target, or `custom` for a target no framework owns. Key presence in `targets` enables a target by NAME, and this is what says which code runs there, so a target named `admin` with `type: 'web'` is a web build. A resolved target config carries it at the top level like every other key in the entry.",
  },

  // ── brand ────────────────────────────────────────────────────────────────
  {
    path:        'brand.id',
    type:        'string',
    required:    true,
    match:       BRAND_ID_PATTERN,
    description: 'URL-scheme-safe slug. Drives deep-link schemes, default appIds, repo names. Lowercase, starts with a letter, alnum/+/-/.',
  },
  {
    path:        'brand.name',
    type:        'string',
    required:    true,
    description: 'Human-readable brand name. Default productName/site title everywhere.',
  },
  {
    path:        'brand.url',
    type:        'string',
    required:    false,
    match:       /^https?:\/\//,
    description: 'Marketing site URL. Derives remote-config URLs, "Open Website" menu items, hosting boilerplate links. Unset (or null) resolves to the GitHub Pages address of a GitHub-hosted `web` target, https://<owner>.github.io/<brand.id>-web.',
  },
  {
    path:        'brand.description',
    type:        'string',
    required:    false,
    description: 'One-sentence brand description. Meta descriptions, store listings.',
  },
  {
    path:        'brand.tagline',
    type:        'string',
    required:    false,
    description: 'Short marketing tagline.',
  },
  {
    path:        'brand.type',
    type:        'string',
    required:    false,
    description: "The brand's schema.org type ('Organization', 'Corporation', 'LocalBusiness'). @omega.js/web stamps it on the JSON-LD brand node and every @id that cross-references it; unset renders the framework default 'Organization'.",
  },
  {
    path:        'brand.font',
    type:        'string',
    required:    false,
    description: "Display font NAME (no extension, 'CromaSans-ExtraBold') the assets service renders the wordmark + combomark from, resolved against the brand's assets/fonts/ then the system font dirs. Unset = those two logo variants are skipped, not generated with a substitute face.",
  },
  {
    path:        'brand.contact.email',
    type:        'string',
    required:    false,
    match:       /@/,
    description: 'Support email surfaced in About / Help / legal pages.',
  },
  {
    path:        'brand.contact.phone',
    type:        'string',
    required:    false,
    description: "Support phone number as it should read. @omega.js/web publishes it as the JSON-LD brand node's `telephone`; unset renders empty.",
  },
  {
    path:        'brand.contact.carbonCopy',
    type:        'array',
    required:    false,
    description: 'Audit BCC recipients ([{ email, name }]) added to transactional sends with copy: true. Unset = no audit copies; never a framework default.',
  },
  {
    path:        'brand.address',
    type:        'object',
    required:    false,
    description: 'Postal address (line1, line2, city, region, postalCode, country). Legal pages + email footers.',
  },
  {
    path:        'brand.color',
    type:        'string',
    required:    false,
    match:       /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
    description: "Brand accent color as a hex string, #RGB or #RRGGBB. @omega.js/web composes the --omega-accent ramps (light + dark) from it; unset leaves the theme's neutral placeholder standing.",
  },
  {
    path:        'brand.images',
    type:        'object',
    required:    false,
    description: 'Brand image URLs/paths (wordmark, brandmark, combomark, icon).',
  },

  // ── socials ──────────────────────────────────────────────────────────────
  {
    path:        'socials',
    type:        'object',
    required:    false,
    description: "Platform → handle ({ twitter: 'somiibo' }). The handle derives the profile URL every surface reads (JSON-LD sameAs, the footer row, omega_social), and @omega.js/web emits a redirect shortlink page at /<platform> for each entry. An entry that redirects somewhere OTHER than its profile URL takes the object form { handle, redirect }: the redirect target wins for the shortlink, the handle still names the profile.",
  },

  // ── cloud (role: app/cloud platform; D12 provider-discriminated) ─────────
  {
    path:        'cloud.provider',
    type:        'string',
    required:    false,
    enum:        ['firebase'],
    description: "App/cloud platform provider. Only 'firebase' today; the discriminator exists so a second provider slots in without a key rename.",
  },
  {
    path:        'cloud.enabled',
    type:        'boolean',
    required:    false,
    description: "The cloud service's switch: `false` is the permanent opt-out the manage gate's Disable lands, and nothing asks for the Google OAuth client on the cloud service's behalf again. Absence means on, and no default is materialized.",
  },
  ...CLOUD_CONFIG_RULES,
  {
    path:        'cloud.messaging.vapidKey',
    type:        'string',
    required:    false,
    description: 'Web-push VAPID public key (Firebase console → Cloud Messaging → Web Push certificates). Public by design: it ships to every browser, and the private half stays in the console.',
  },
  {
    path:        'cloud.shared',
    type:        'boolean',
    required:    false,
    default:     false,
    description: 'true = the cloud project is shared with other brands; only per-brand operations run (service-account, sdk-config).',
  },
  {
    path:        'cloud.supportEmail',
    type:        'string',
    required:    false,
    match:       /@/,
    description: "OAuth consent screen support email. Defaults to the AUTHORIZING user's email, because the provider rejects any address the caller doesn't own; set only for an owned Google Group.",
  },
  {
    path:        'cloud.oauthRedirectsConfigured',
    type:        'boolean',
    required:    false,
    description: "true = the Google OAuth client's authorized origins + redirect URIs are configured by hand. The ONE reconcile flag config keeps: that surface has no API to re-check, so the cloud service asks once, writes the answer back here, and every later run trusts it. Never set it without doing the work: the confirm is the only proof there is.",
  },
  {
    path:        'cloud.consentAudience',
    type:        'boolean',
    required:    false,
    description: "false = stop asking about the OAuth consent screen's audience. A tri-state opt-out: Google gives NO API write for the audience, so an Internal screen (Error 403: org_internal for every non-org account) is a manage-time stopper that opens the console page and polls; `false` records the deliberate choice to live with an org-only sign-in, and only the cloud service's audience step goes quiet.",
  },
  {
    path:        'cloud.apiSubdomain',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = skip the api.{domain} hosting custom domain.',
  },
  {
    path:        'cloud.organizationId',
    type:        'string|boolean',
    required:    false,
    description: 'Cloud organization ID the project is created inside, a tri-state: unset = ask at project create, false = no org (standalone), value = create inside it.',
  },
  {
    path:        'cloud.billingAccount',
    type:        'string|boolean',
    required:    false,
    description: "Billing account ('billingAccounts/XXXXXX-XXXXXX-XXXXXX'), a tri-state: unset = ask, false = stay on the free tier, value = auto-upgrade.",
  },

  // ── analytics ────────────────────────────────────────────────────────────
  {
    path:        'analytics.enabled',
    type:        'boolean',
    required:    false,
    description: "The analytics service's switch: `false` is the permanent opt-out the manage gate's Disable lands, and the GA4 and pixel keys are never asked for again. Absence means on, and no default is materialized. Dropping one pixel platform is `analytics.providers.<meta|tiktok>: false`, never this switch.",
  },
  {
    path:        'analytics.providers.google.id',
    type:        'string',
    required:    false,
    match:       /^G-[A-Z0-9]+$/,
    description: 'GA4 Measurement ID. Presence-driven: set G-XXXXXXXXXX to enable. Secret lives in process.env.GOOGLE_ANALYTICS_SECRET.',
  },
  {
    path:        'analytics.providers.google.propertyId',
    type:        'string',
    required:    false,
    description: "GA4 property id (digits, as the Admin API returns it). The manager's analytics service reconciles the brand's data streams and the Firebase link against it, and it gates the whole google half: no propertyId, no google operations. Interactive setup selects/creates the property and writes it back here.",
  },
  {
    path:        'analytics.providers.google.accountId',
    type:        'string',
    required:    false,
    description: "GA account id the property lives under (digits), read by the analytics property picker and the console bookmarks. A company-managed brand inherits the COMPANY layer's value through the merge chain; a brand-level value always wins.",
  },
  {
    path:        'analytics.providers.meta.id',
    type:        'string',
    required:    false,
    description: 'Meta (Facebook) Pixel ID. Presence-driven.',
  },
  {
    path:        'analytics.providers.meta.accountId',
    type:        'string',
    required:    false,
    description: "Meta AD ACCOUNT id ('act_…' or the bare digits) the pixel is created on and found by name against. A non-secret platform id, so it lives here beside google.accountId; the token that reaches the account stays in .env (META_ACCESS_TOKEN).",
  },
  {
    path:        'analytics.providers.tiktok.id',
    type:        'string',
    required:    false,
    description: 'TikTok Pixel ID. Presence-driven.',
  },
  {
    path:        'analytics.providers.tiktok.accountId',
    type:        'string',
    required:    false,
    description: 'TikTok ADVERTISER id the pixel is created on. Same rule as meta.accountId: the id lives here, TIKTOK_ACCESS_TOKEN stays in .env.',
  },
  {
    path:        'analytics.providers.tiktok.appId',
    type:        'string',
    required:    false,
    description: 'TikTok DEVELOPER APP id the access-token mint authorizes through. Public config, so the manager can walk the portal without asking twice; setup writes it back here. The app secret is pasted once and never saved, and the token lands in .env (TIKTOK_ACCESS_TOKEN).',
  },

  // ── advertising ──────────────────────────────────────────────────────────
  {
    path:        'advertising.providers.adsense.client',
    type:        'string',
    required:    false,
    description: 'AdSense publisher client id (ca-pub-…). The ONE adsense switch, presence-driven: set it and the manager service manages the account, the site renders units from it and ads.txt carries the record; leave it out and none of that happens. No second gate exists, so a managed-but-ad-free brand is deliberately inexpressible.',
  },
  {
    path:        'advertising.providers.adsense.displaySlot',
    type:        'string',
    required:    false,
    description: 'Default AdSense slot id for display units (per-include override wins).',
  },
  {
    path:        'advertising.providers.adsense.inArticleSlot',
    type:        'string',
    required:    false,
    description: 'Default AdSense slot id for in-article units.',
  },
  {
    path:        'advertising.providers.adsense.inFeedSlot',
    type:        'string',
    required:    false,
    description: 'Default AdSense slot id for in-feed units.',
  },
  {
    path:        'advertising.providers.adsense.multiplexSlot',
    type:        'string',
    required:    false,
    description: 'Default AdSense slot id for multiplex units.',
  },
  {
    path:        'advertising.providers.inhouse.source',
    type:        'string',
    required:    false,
    description: "In-house ads source: 'self' (this brand's backend serves its own `ads` inventory), 'company' (the parent company's api, derived from the RESOLVED company.url), or a full base URL used verbatim. Presence-driven, and unset disables house units.",
  },
  {
    path:        'advertising.fallback',
    type:        'string|boolean',
    required:    false,
    description: "The role a provider miss falls through to: 'inhouse' renders the house unit, false (or absent) ends the ladder at the built-in promo. Role-level, beside `providers` (docs/web/ads-system.md).",
  },
  {
    path:        'advertising.tags',
    type:        'array',
    required:    false,
    description: "This brand's contextual tags (['music', 'audio-tools']), the targeting match input a house unit sends with its serve request unless the include passes its own. No user tracking.",
  },

  // ── company (ONE typed key, the rest RESOLVED) ───────────────────────────
  // The brand's relationship to its company lives OUTSIDE `brand` (Ian
  // 2026-09-12: "brand key is for things about this brand, and the
  // parent/company/organization key is OUTSIDE of that"), and the loader fills
  // the SAME key with the company's public facts (#677): `company.name`,
  // `company.url` and `company.images.wordmark` are RESOLVED, never typed, and
  // the loader refuses each of them in an authored file. A brand with no
  // company resolves to its own name and url under a null id, so no reader
  // carries a fallback.
  {
    path:        'company.id',
    type:        'string',
    required:    false,
    description: "The company this brand belongs to, named by the parent's `brand.id` ('itw-creative-works'), or the literal 'self' on the company brand itself. The ONE key that joins a brand to a company: the parent's public facts, its config layer, its `.env`, its hooks and its signing tree all resolve from it (docs/manager/company.md).",
  },
  {
    path:        'company.webhooks',
    type:        'boolean',
    required:    false,
    default:     true,
    // Resolution only: an opt-OUT written into every brand file as `true`
    // would be noise, and the fact belongs to the brands that actually share
    // somebody else's provider account.
    materialize: false,
    description: "Whether the manage walk may repoint this company's provider ACCOUNT webhooks. `false` says the SendGrid Event Webhook and the Beehiiv webhook belong to someone else (a shared account whose one account-level webhook points at their production), so the campaigns and newsletter services leave them alone.",
  },

  // ── features (the catalog every product prices) ──────────────────────────
  {
    path:        'features',
    type:        'object',
    required:    false,
    description: "The feature catalog: every feature DEFINED once, keyed by id, in the order every surface renders it. An entry carries name, icon (the full Font Awesome class string) and definition, plus, when the feature is METERED, a `usage` block ({ pace: 'daily' | false, mirror: ['<doc kind>'] }); an entry without one is a perk. Products name only the VALUE (payment.products[].features). Key order is row order on the pricing page and the account's usage cards.",
  },

  // ── payment (role: billing; provider-discriminated) ──────────────────────
  {
    path:        'payment.currency',
    type:        'string',
    required:    false,
    default:     'USD',
    description: "The ISO 4217 code every price in payment.products is quoted in. One currency per brand, named wherever a price is shown or recorded: the pricing page's JSON-LD, the checkout, and the backend's order history (GET /user/orders). Defaults to 'USD'.",
  },
  {
    path:        'payment.providers.stripe.publishableKey',
    type:        'string',
    required:    false,
    match:       /^pk_(test|live)_/,
    description: 'Stripe publishable key. Lives in config (not secret); the secret key stays in env.',
  },
  {
    path:        'payment.providers.paypal.clientId',
    type:        'string',
    required:    false,
    description: 'PayPal client ID. Lives in config; secret stays in env.',
  },
  {
    path:        'payment.providers.chargebee.site',
    type:        'string',
    required:    false,
    description: 'Chargebee site slug.',
  },
  {
    path:        'payment.providers.coinbase.enabled',
    type:        'boolean',
    required:    false,
    default:     false,
    description: 'Coinbase Commerce (crypto) checkout, one-time purchases only. Its ONLY credential is a secret (COINBASE_COMMERCE_API_KEY), so there is no public datum to gate on: this is the switch, default OFF, because an accidental ON shows a Crypto button no key can complete.',
  },
  {
    path:        'payment.products',
    type:        'array',
    required:    false,
    description: 'Product catalog (@omega.js/backend-shaped: id, name, type, prices, per-provider IDs), referenceable from every target and the ONLY pricing-page source. Optional presentation fields: tagline, popular, enterprise (the talk-to-us tier: its own full-width row, never a card), hidden (still created on every provider and purchasable by id, as QA tiers and grandfathered plans are, but never rendered on the pricing page), url, and features { <catalog id>: value }, a number on a counted feature (the MONTHLY limit, -1 unlimited) or true/false/a string on a perk.',
  },
  {
    path:        'payment.winback.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'The cancel-flow save offer, shown before the cancellation questionnaire. Defaults ON; false is the whole off switch, and the cancel flow goes straight to the questionnaire.',
  },
  {
    path:        'payment.winback.percent',
    type:        'integer',
    required:    false,
    min:         1,
    max:         100,
    default:     50,
    description: 'Whole percentage off the next cycle the save offer pitches. Defaults to 50. Mutually exclusive with payment.winback.amount.',
  },
  {
    path:        'payment.winback.amount',
    type:        'number',
    required:    false,
    min:         0.01,
    description: "Flat amount off the next cycle (payment.currency's major unit, e.g. 10 = $10), instead of a percentage. Mutually exclusive with payment.winback.percent.",
  },
  {
    path:        'payment.winback.duration',
    type:        'string',
    required:    false,
    enum:        WINBACK_DURATIONS,
    default:     'once',
    description: "How long the accepted offer lasts: 'once' (the next cycle only, the default) or 'forever' (a permanent price cut).",
  },

  // ── monitoring (role: error monitoring; provider-keyed, #425) ────────────
  {
    path:        'monitoring.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'Role-level switch (default true). false skips the monitoring service outright, whatever the providers block says.',
  },
  {
    path:        'monitoring.providers.sentry.org',
    type:        'string',
    required:    false,
    description: 'Sentry organization slug (public). Auto-detected when the auth token sees exactly one org; the monitoring service writes it back here.',
  },
  {
    path:        'monitoring.providers.sentry.dsn',
    type:        'string',
    required:    false,
    match:       /^https?:\/\//,
    description: 'Sentry DSN (public by design). Per-surface DSNs go in targets.<name>.monitoring.providers.sentry.dsn overrides.',
  },
  {
    path:        'monitoring.providers.sentry.environment',
    type:        'string',
    required:    false,
    description: "Environment tag every event carries. Unset (or null) lets the host's own gate name it: 'production' on a production run, 'development' otherwise.",
  },
  {
    path:        'monitoring.providers.sentry.sampleRate',
    type:        'number',
    required:    false,
    min:         0,
    max:         1,
    description: 'Fraction of ERROR events kept, 0..1. Defaults to 1 (keep everything).',
  },
  {
    path:        'monitoring.providers.sentry.tracesSampleRate',
    type:        'number',
    required:    false,
    min:         0,
    max:         1,
    description: 'Fraction of performance traces kept, 0..1. Defaults to 0.1.',
  },
  {
    path:        'monitoring.providers.sentry.replaysSessionSampleRate',
    type:        'number',
    required:    false,
    min:         0,
    max:         1,
    description: 'Browser only: fraction of SESSIONS recorded as a replay, 0..1. Defaults to 0, because replay costs bandwidth and captures the DOM, so it is strictly opt-in; any value above 0 loads the replay integration.',
  },
  {
    path:        'monitoring.providers.sentry.replaysOnErrorSampleRate',
    type:        'number',
    required:    false,
    min:         0,
    max:         1,
    description: 'Browser only: fraction of ERRORING sessions recorded as a replay, 0..1. Defaults to 0 (same opt-in gate as replaysSessionSampleRate).',
  },
  {
    path:        'monitoring.providers.sentry.scrubEmail',
    type:        'boolean',
    required:    false,
    description: 'PII guard on the user attached to an event: the uid always rides, the email only when this is explicitly false. Defaults to true (scrubbed).',
  },
  {
    path:        'monitoring.providers.sentry.attachScreenshot',
    type:        'boolean',
    required:    false,
    description: '@omega.js/desktop only: attach a screenshot of the window to a captured event. Defaults to false.',
  },
  {
    path:        'monitoring.providers.sentry.bundlePatterns',
    type:        'array',
    required:    false,
    description: "Browser only: the URL fragments that identify OUR bundles; a browser event reports only when a stack frame matches one. Defaults to ['/assets/js/'], where both @omega.js/web and @omega.js/extension serve every framework bundle.",
  },

  // ── connections ──────────────────────────────────────────────────────────
  {
    path:        'connections',
    type:        'object',
    required:    false,
    // RESOLUTION-ONLY ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)):
    // this default is framework PRESENTATION, never an owner decision, so it
    // resolves into every read and is never written into a brand's omega.json5 —
    // five copied provider blocks in every brand config would drift from the
    // framework they came from. A brand overrides any key it wants; the rest
    // keeps tracking the framework.
    materialize: false,
    // The five providers @omega.js/backend ships a module for, each with what
    // the account page's card DRAWS ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)):
    // the framework owns the presentation so a brand's entry is one line, and
    // the ordinary merge chain lets a brand overwrite any of it. `enabled` is
    // false here because a packaged provider still needs its
    // CONNECTIONS_<PROVIDER>_CLIENT_ID pair before a card could connect
    // anything — turning one on is the brand's act.
    default: {
      google: {
        enabled: false,
        max: 1,
        name: 'Google',
        logo: 'google',
        description: 'Enable single sign-on with your Google account',
      },
      discord: {
        enabled: false,
        max: 1,
        name: 'Discord',
        logo: 'discord',
        description: 'Connect to access Discord community features',
      },
      spotify: {
        enabled: false,
        max: 1,
        name: 'Spotify',
        logo: 'spotify',
        description: 'Connect your Spotify listening account',
      },
      twitch: {
        enabled: false,
        max: 1,
        name: 'Twitch',
        logo: 'twitch',
        description: 'Connect your Twitch channel',
      },
      kick: {
        enabled: false,
        max: 1,
        name: 'Kick',
        logo: 'kick',
        description: 'Connect your Kick channel',
      },
    },
    description: "Per-provider user-connection settings, keyed by provider name (`connections: { twitch: {…} }`), public values only, never client secrets (those are the CONNECTIONS_<PROVIDER>_CLIENT_ID/_SECRET env pair). The set of providers is OPEN (a brand ships its own as `src/connections/<name>.js`), so the section stays free-form; the keys every entry may carry are `enabled` (the packaged providers default to false, so set it true to offer one; a brand's own provider is on unless this is false), `max` (a positive whole number, default 1: the most accounts of this provider one user may link, the default a brand's own provider reads too), `scope` (an array that wins over the provider module's default), `name` and `logo` (what the account page's card draws; the CONFIG is the only card list, and `logo` is the name of a mark @omega.js/web ships in core/logos/brandmarks/original, rendered inline, or a full URL rendered as an img), and `description` (the line under the card's title). The five packaged providers carry all three by default, so enabling one is one line. docs/backend/connections.md",
  },

  // ── repo (where the brand hosts its source; #883) ───────────────────────
  // Two keys, and block PRESENCE is the switch, exactly as a target's key
  // presence enables that target. Every repo NAME derives from
  // `<brand.id>-<role>` (#809), and visibility is the brand root package.json's
  // `private` field, so neither is configurable here.
  {
    path:        'repo',
    type:        'object',
    required:    false,
    description: 'Where the brand hosts its source. Presence enables the repo service; the block is provider + owner and nothing else, since every repo name derives from `<brand.id>-<role>`.',
  },
  {
    path:        'repo.provider',
    // NO `default:`, by the presence-gate exclusion (docs/shared/config.md,
    // Defaults & self-healing): the BLOCK's presence is what enables the repo
    // service, so a resolved `repo: { provider: 'github' }` would say a brand
    // hosts its source somewhere when it declared nothing. The value a missing
    // provider reads is repo.js's DEFAULT_REPO_PROVIDER, beside the derivation
    // that reads it.
    type:        'string',
    required:    false,
    enum:        REPO_PROVIDERS,
    description: 'Which host serves the brand source (default `github`, the only one built). A second provider is a new row here plus its own helper, never a reshape of this block.',
  },
  {
    path:        'repo.owner',
    type:        'string',
    required:    false,
    description: "GitHub owner (org or user) every repo the brand owns lives under: `<brand.id>-omega` (source), `<brand.id>-releases` (public artifacts), `<brand.id>-<name>` (one per GitHub-hosted web target). No owner → the repo service skips and the site's desktop release URLs stay underived.",
  },

  // ── domain (two roles: registrar + mailbox; provider-keyed) ────────────────
  {
    path:        'domain.enabled',
    type:        'boolean',
    required:    false,
    description: "The domain service's switch: `false` is the permanent opt-out the manage gate's Disable lands, and the registrar credentials are never asked for again. Absence means on, and no default is materialized.",
  },
  ...DOMAIN_RULES,

  // ── edge (role: CDN/DNS edge; provider-discriminated) ────────────────────
  ...EDGE_RULES,

  // ── captcha (role: bot defense; provider-discriminated) ──────────────────
  {
    path:        'captcha.providers.recaptcha.enabled',
    type:        'boolean',
    required:    false,
    description: "The reCAPTCHA provider's switch: `false` is the permanent opt-out the manage gate's Disable lands, and RECAPTCHA_SECRET_KEY is never asked for again. Absence means on, and no default is materialized.",
  },
  {
    path:        'captcha.providers.recaptcha.project',
    type:        'string',
    required:    false,
    description: "The brand's OWN GCP project hosting the classic reCAPTCHA key, used only for the console deep-link in guidance. Site/secret keys stay in .env.",
  },
  {
    path:        'captcha.providers.recaptcha.siteKey',
    type:        'string',
    required:    false,
    description: 'Classic reCAPTCHA site key rendered client-side. Public by design; the secret half stays in .env (RECAPTCHA_SECRET_KEY).',
  },
  {
    path:        'captcha.providers.recaptcha.domainsConfirmed',
    type:        'array',
    required:    false,
    description: "Domains the owner has confirmed on the classic reCAPTCHA key (the API cannot read the key's domain list, so the confirmation is the record). Machine-written: the captcha service stamps a domain here once, and finding it is what keeps later runs from asking again.",
  },

  // ── forms (role: form handling; provider-discriminated) ──────────────────
  {
    path:        'forms.providers.slapform.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the slapform service skips and the contact page has no form endpoint.',
  },
  {
    path:        'forms.providers.slapform.formId',
    type:        'string',
    required:    false,
    description: 'Slapform form id; the contact page posts to https://api.slapform.com/{formId}. Interactive manager runs land it here.',
  },
  {
    path:        'forms.providers.slapform.templateFormId',
    type:        'string',
    required:    false,
    description: 'Existing form the new form is cloned from when the service creates one.',
  },
  {
    path:        'forms.providers.slapform.updateFormInfo',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the form is shared and managed by another brand; its name/settings are left alone.',
  },
  {
    path:        'forms.providers.slapform.plan',
    type:        'object',
    required:    false,
    default:     { id: 'grandmaster', name: 'Grandmaster' },
    description: 'Tier granted to the form-owner account ({ id, name }), for Slapform operators only.',
  },

  // ── inbound (role: inbound conversations; per-channel providers) ─────────
  {
    path:        'inbound.chat.providers.chatsy.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = no chat widget boots and the chatsy service skips.',
  },
  {
    path:        'inbound.chat.providers.chatsy.agentId',
    type:        'string',
    required:    false,
    description: 'Chatsy agent id. The manager writes it back here; @omega.js/client boots the widget from it.',
  },
  {
    path:        'inbound.chat.providers.chatsy.accountId',
    type:        'string',
    required:    false,
    description: "Chatsy owner-account uid the agent belongs to, the account whose subscription the chat service reconciles to `plan`. The service resolves it from the agent itself; set it only when the agent's owner is provisioned elsewhere.",
  },
  {
    path:        'inbound.chat.providers.chatsy.templateAgentId',
    type:        'string',
    required:    false,
    description: 'Existing agent the new agent is cloned from when the service creates one.',
  },
  {
    path:        'inbound.chat.providers.chatsy.updateAgentInfo',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the agent is shared and managed by another brand; its settings/knowledge are left alone.',
  },
  {
    path:        'inbound.chat.providers.chatsy.plan',
    type:        'object',
    required:    false,
    default:     { id: 'max', name: 'Max' },
    description: 'Tier granted to the agent-owner account ({ id, name }), for Chatsy operators only.',
  },
  {
    path:        'inbound.chat.providers.chatsy.sponsorshipsUrl',
    type:        'string',
    required:    false,
    description: "Sponsorship page the baseline knowledge points at. Unset → {website}/contact.",
  },
  {
    path:        'inbound.chat.providers.chatsy.settings',
    type:        'object',
    required:    false,
    description: 'Widget presentation settings passed verbatim to the Chatsy SDK by @omega.js/client.',
  },
  {
    path:        'inbound.email.providers.replyify.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the replyify service skips.',
  },
  {
    path:        'inbound.email.providers.replyify.agentId',
    type:        'string',
    required:    false,
    description: 'Replyify agent id. Interactive manager runs land it here.',
  },
  {
    path:        'inbound.email.providers.replyify.templateAgentId',
    type:        'string',
    required:    false,
    description: 'Existing agent the new agent is cloned from when the service creates one.',
  },
  {
    path:        'inbound.email.providers.replyify.updateAgentInfo',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the agent is shared and managed by another brand; its filter/knowledge are left alone.',
  },
  {
    path:        'inbound.email.providers.replyify.plan',
    type:        'object',
    required:    false,
    default:     { id: 'max', name: 'Max' },
    description: 'Tier granted to the agent-owner account ({ id, name }), for Replyify operators only.',
  },
  {
    path:        'inbound.email.providers.replyify.discount',
    type:        'object',
    required:    false,
    description: 'Discount the baseline knowledge offers ({ code, label }). Unset = no discount section.',
  },

  // ── search (role: search-engine surfaces; provider-discriminated) ────────
  {
    path:        'search.providers.searchConsole.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = the search service skips entirely: the property is never verified and no sitemap is submitted (submitSitemap only turns the sitemap half off).',
  },
  {
    path:        'search.providers.searchConsole.submitSitemap',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'false = skip sitemap submission to Google Search Console.',
  },
  {
    path:        'search.providers.searchConsole.sitemapPaths',
    type:        'array',
    required:    false,
    default:     ['/sitemap.xml'],
    description: "Sitemap paths submitted as https://{domain}{path} (default ['/sitemap.xml']).",
  },
  {
    path:        'search.providers.searchConsole.gaLinked',
    type:        'boolean',
    required:    false,
    description: 'true = the owner has associated this Search Console property with the brand\'s GA property (no API exists for the link, so the confirmation is the record). Machine-written: the search service stamps it after the interactive association, and finding it is what keeps later runs from asking again.',
  },

  // ── certificates (role: code signing; provider-discriminated) ────────────
  {
    path:        'certificates.providers.apple.bundleIdPrefix',
    type:        'string',
    required:    false,
    description: "Reverse-DNS prefix the brand's bundle id is composed from ('com.mycompany' + brand.id → com.mycompany.my.brand). The brand's own answer: the onboard wizard seeds it and setup asks for it; unset, the Apple operations have no id to reconcile.",
  },
  {
    path:        'certificates.providers.apple.capabilities',
    type:        'array',
    required:    false,
    description: "App Store Connect capabilities enabled on the bundle id (['APPLE_ID_AUTH']). Unset uses the framework set.",
  },
  {
    path:        'certificates.providers.apple.profiles',
    type:        'array',
    required:    false,
    description: 'Certificate types that get a provisioning profile per applicable platform (IOS_DISTRIBUTION, MAC_APP_DISTRIBUTION, DEVELOPER_ID_APPLICATION_G2). Unset uses the framework set.',
  },
  {
    path:        'certificates.providers.apple.certificates',
    type:        'array',
    required:    false,
    description: "Certificate types managed for the Apple Developer account ([{ type, manual }]); `manual: true` marks the ones Apple's API cannot create, which the Account Holder downloads from the portal. Unset uses the framework set.",
  },

  // ── publishing (role: ship credentials; no provider) ─────────────────
  {
    path:        'publishing.enabled',
    type:        'boolean',
    required:    false,
    description: "The manage walk's ship-credential gate: the `publishing` service asks for every developer key and listing id the brand's declared formats need (`targets.<name>.platforms.<platform>.formats`). `false` is the permanent opt-out the gate's Disable lands; absence means ask, and no default is materialized. Dropping ONE store is the declaration's job (`platforms.<store>.formats.store: false`), never this switch.",
  },

  // ── devlog (role: commit-digest publishing; provider-discriminated) ──────
  {
    path:        'devlog',
    type:        'object',
    required:    false,
    description: 'Commit-digest devlog pipeline (@omega.js/manager devlog): enabled + providers.ghostii (orgs, lookbackDays, publish settings).',
  },
  {
    path:        'devlog.enabled',
    type:        'boolean',
    required:    false,
    description: "true PUBLISHES AI-written commit-digest posts to the brand's live website. Case 3 (docs/shared/config.md): the literal true is the only ON, absence is off, and no default is materialized, so publishing is never implicit.",
  },

  // ── seo ──────────────────────────────────────────────────────────────────
  {
    path:        'seo',
    type:        'object',
    required:    false,
    description: "Parasite-SEO content: seo.github.content is the @omega.js/manager seo service's repos, and big content blocks may live in the config/seo.json5 sidecar, which the config loader reads as the `seo` section. The indexing switch is NOT here: it is `targets.web.meta.index`, the same name a page writes.",
  },

  // ── account ──────────────────────────────────────────────────────────────
  {
    path:        'account',
    type:        'object',
    required:    false,
    description: "Managed Firebase Auth accounts (@omega.js/manager account service): enabled + admins ([{ email, account, marketing }]; '{domain}' templates to the brand domain). Owner-defined, typically set once in the COMPANY omega.json5 (arrays replace, so the company list wins whole). Passwords NEVER live here: per-account OMEGA_ACCOUNT_PASSWORD__* env vars, the config/hooks/account/password.js hook, or the ACCOUNT_PASSWORD_SEED derivation.",
  },

  // ── reviews ──────────────────────────────────────────────────────────────
  // reviews … dataRequest are brand-level sections the manager reads UNFOLDED
  // (#277): a website-only brand has no targets.backend to hold them, and
  // adding one purely as a config home would falsely enable the target. A
  // targets.backend block still overrides any of them: that comes free from
  // the merge chain.
  {
    path:        'reviews',
    type:        'object',
    required:    false,
    description: 'Review-collection settings (enabled, sites).',
  },

  // ── marketing (two roles: campaigns + newsletter, provider-keyed, #425) ──
  // Enumerated field by field (#425): the section used to validate as one
  // opaque object, so a typo in a list id or a publication id read as nothing
  // and the sync silently landed contacts in the wrong place. The section entry
  // stays too — it is one of the shared keys #277 types at brand level.
  {
    path:        'marketing',
    type:        'object',
    required:    false,
    description: 'Marketing automation: the campaigns + newsletter roles (each provider-keyed) and the prune switch.',
  },
  {
    path:        'marketing.campaigns.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'Role-level switch for email marketing (default true). false skips the campaigns service and the backend contact sync.',
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.listId',
    type:        'string',
    required:    false,
    description: "SendGrid Marketing list UUID the brand's contacts land in. Written back by the campaigns service; unset means contacts reach All Contacts only.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.orders',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for order and billing email (receipts, renewals, refunds, plan changes). Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.hello',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for onboarding email (welcome, checkup, feedback request). Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.account',
    type:        'integer',
    required:    false,
    description: 'SendGrid unsubscribe (ASM) group id for account-action email (deletion, data requests), and the fallback for any send naming no group. Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.',
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.marketing',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for promotional email (offers, win-back, abandoned cart) and every marketing Single Send. Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.security',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for security email (password reset, 2FA, sign-in alerts). Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.newsletter',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for newsletter email (announcements, industry news). Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.campaigns.providers.sendgrid.groups.internal',
    type:        'integer',
    required:    false,
    description: "SendGrid unsubscribe (ASM) group id for internal alert email (dispute alerts, system notifications to the brand contact). Written back by the campaigns service, which provisions the group by name; ASM ids are per SendGrid ACCOUNT, so this is config and never code. Unset makes @omega.js/backend fail the send loudly.",
  },
  {
    path:        'marketing.newsletter.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'Role-level switch for the newsletter (default true). false skips the newsletter service and the backend subscriber sync.',
  },
  {
    path:        'marketing.newsletter.providers.beehiiv.publicationId',
    type:        'string',
    required:    false,
    description: "Beehiiv publication id (e.g. 'pub_xxxxx') the brand's subscribers land in, and the id every inbound Beehiiv webhook event is matched against. Written back by the newsletter service.",
  },
  {
    path:        'marketing.newsletter.content',
    type:        'object|array',
    required:    false,
    description: "Newsletter-PIPELINE config (sources, categories, tone, template, theme, sponsorships), a single object or an array whose first entry the generator uses. Role-level on purpose: it configures @omega.js/backend's generator, not Beehiiv.",
  },
  {
    path:        'marketing.prune.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'Monthly cold-contact prune across both providers. ON by default and materialized into every brand config; false is the per-brand off switch.',
  },

  // ── blog ─────────────────────────────────────────────────────────────────
  {
    path:        'blog',
    type:        'object',
    required:    false,
    description: 'AI blog-content settings (Ghostii pipeline).',
  },

  // ── dataRequest ──────────────────────────────────────────────────────────
  {
    path:        'dataRequest',
    type:        'object',
    required:    false,
    description: 'GDPR/CCPA data-request query definitions.',
  },

  // ── directory ────────────────────────────────────────────────────────────
  // The same brand-level family (#277): the manager's directory service reads
  // these unfolded. PUBLIC FACTS ONLY — the entry is pushed into the parent
  // project's world-readable `brands` collection, so the validator's
  // secret-shape guard is the hard floor here (#246).
  {
    path:        'directory',
    type:        'object',
    required:    false,
    description: "Directory participation (@omega.js/manager directory service): { enabled } opts in to pushing this brand's entry into the parent project's `brands` collection. Absent or false never pushes. Needs `company.id` to name a parent and DIRECTORY_SERVICE_ACCOUNT in the brand .env.",
  },
  {
    path:        'directory.enabled',
    type:        'boolean',
    required:    false,
    default:     false,
    description: 'true opts the brand into the directory push. Default false, so participation is never implicit.',
  },

  // ── sponsorships ─────────────────────────────────────────────────────────
  {
    path:        'sponsorships',
    type:        'object',
    required:    false,
    description: "The brand's sponsorship terms, the first directory BLOCK and the section the server service also publishes. Public terms only: { acceptable, unacceptable, prices }.",
  },
  {
    path:        'sponsorships.acceptable',
    type:        'array',
    required:    false,
    description: 'Topics the brand accepts sponsored content about (strings).',
  },
  {
    path:        'sponsorships.unacceptable',
    type:        'array',
    required:    false,
    description: 'Topics the brand refuses sponsored content about (strings).',
  },
  {
    path:        'sponsorships.prices',
    type:        'object',
    required:    false,
    description: "Price in USD per placement type, placement key to number ({ 'guest-post': 70, 'link-insertion': 50 }). A placement with no price is not for sale.",
  },

  // ── ports (dev-only) ─────────────────────────────────────────────────────
  {
    path:        'ports',
    type:        'object',
    required:    false,
    description: 'Explicit dev-port pins. Unset ports auto-allocate (classic defaults, bump-if-taken); a pinned port never bumps, and a busy pin is a hard error. Keys: auth, functions, firestore, database, hosting, storage, pubsub, ui, website, livereload, cdp. Dev/emulator only; production never reads this.',
  },

  // ── theme ────────────────────────────────────────────────────────────────
  {
    path:        'theme.id',
    type:        'string',
    required:    false,
    description: "Theme id (seeded 'classy' at onboarding). Project-owned: the manager never overwrites it.",
  },
  {
    path:        'theme.appearance',
    type:        'string',
    required:    false,
    enum:        ['system', 'light', 'dark'],
    description: "Default appearance. 'system' follows the OS; a user's runtime choice persists in storage and wins.",
  },

  // ── ai ───────────────────────────────────────────────────────────────────
  {
    path:        'ai.enabled',
    type:        'boolean',
    required:    false,
    description: "The manager's AI-provider setup gate: the `ai` service asks once for OPENAI_API_KEY / ANTHROPIC_API_KEY. `false` is the permanent opt-out the gate's Disable lands; absence means ask. No default is materialized, so a brand that never answers is never re-shaped.",
  },

  // ── translation ──────────────────────────────────────────────────────────
  {
    path:        'translation.enabled',
    type:        'boolean',
    required:    false,
    default:     true,
    description: 'Master switch (default true). Translation only runs when languages is non-empty.',
  },
  {
    path:        'translation.default',
    type:        'string',
    required:    false,
    default:     'en',
    description: "Source language code (default 'en'). Drives <html lang>, og:locale, and the default hreflang.",
  },
  {
    path:        'translation.languages',
    type:        'array',
    required:    false,
    description: "Target language codes (e.g. ['es', 'fr']). Empty/absent = translation off. Validated against @omega.js/devkit/translate's language SSOT.",
  },
  {
    path:        'translation.providers',
    type:        'object',
    required:    false,
    description: "AI translation provider, keyed by name; presence picks the engine ({ claude: {} } or { chatgpt: {} }). 'claude' (the default when the block is absent) rides the local Claude Code install with no API key; 'chatgpt' uses the OpenAI API via OPENAI_API_KEY in env.",
  },
  {
    path:        'translation.model',
    type:        'string',
    required:    false,
    description: "Model override for the chosen provider (defaults: claude → 'sonnet' alias, chatgpt → 'gpt-5.4-nano').",
  },
  {
    path:        'translation.include',
    type:        'array',
    required:    false,
    default:     TRANSLATION_INCLUDE_DEFAULT,
    // Resolution only: the list is the FRAMEWORK's answer to "what is worth
    // paying a provider for", and a copy in every brand config is a copy that
    // drifts from it (#793). A brand that wants a different answer writes one.
    materialize: false,
    description: "Web only: the page routes to translate, as globs with `!` negation, read in order like a .gitignore: the LAST pattern that matches a route decides it, and a route no pattern matches is not translated. A folder pattern covers the folder itself (`!blog/**` excludes `/blog` and everything under it). The default ['**', '!blog/**'] translates the whole site except the blog, which is where the words (and the cost) pile up. A brand list REPLACES the default outright. A page overrides it for itself with `translation.include: true`/`false` in its own frontmatter, the same key name one level down (docs/web/frontmatter.md). The framework's own default pages carry their own exclusion and are never in this list's hands.",
  },

  // ── client (the @omega.js/client runtime blob): its own file ────────────
  ...CLIENT_RULES,

  // ── targets ──────────────────────────────────────────────────────────────
  {
    path:        'targets',
    type:        'object',
    required:    false,
    description: 'Every key is a target NAME, which is the folder `targets/<name>`, the `--target=<name>` word and the derived-repo suffix. Key presence = target enabled; the value is an object of target-scoped config (any shared key inside overrides it) and MUST declare `type`: web/backend/desktop/extension/mobile, or `custom` for a target the manager drives entirely through its own package.json scripts. Anything else is an error.',
  },
];

// Per-target refinements — validated against the RESOLVED config (the target
// section's keys land at the top level).
const TARGET_SCHEMAS = {
  // Grows with @omega.js/web's design: distribute, purgecss safelist,
  // workflows land as their features do.
  web: [
    {
      path:        'hosting',
      type:        'object',
      required:    false,
      description: 'Where this web target is SERVED from. Web targets only: a non-web target carrying it is a validation error.',
    },
    {
      path:        'hosting.provider',
      // No `default:` either, for the same reason as `repo.provider`: the value
      // is read off the TARGET's own entry (repo.js `hostingProvider`), where a
      // resolved top-level default never reaches.
      type:        'string',
      required:    false,
      enum:        HOSTING_PROVIDERS,
      description: "Who serves the built site. `github` publishes it to the target's own `<brand.id>-<name>` repo and serves it from GitHub Pages at the target's url; a second provider is a new row here plus its own deploy helper.",
    },
    {
      path:        'meta',
      type:        'object',
      required:    false,
      description: "Site-wide defaults for page-meta values: the SAME names a page's `meta:` frontmatter carries, and the page (or its layout) wins (docs/web/frontmatter.md). `index` is the only key defined today, because everything else already falls back to the brand block.",
    },
    {
      path:        'meta.index',
      type:        'boolean',
      required:    false,
      default:     true,
      description: "false takes the WHOLE site out of search: every page emits noindex, sitemap.xml and pages.json list nothing, and llms.txt keeps its brand summary but links nothing. It is the site-wide DEFAULT of the one flag every signal reads, so a page's own `meta.index: true` still exempts it. Case 2 (docs/shared/config.md): default ON, and the literal false is the only OFF.",
    },
    {
      path:        'imagemin',
      type:        'object',
      required:    false,
      description: 'Responsive image matrix (build-time 320/640/1024 + webp, quality 80). `enabled: false` ships images verbatim.',
    },
    {
      path:        'dev.limitCollections',
      type:        'object',
      required:    false,
      description: "Dev-only collection sampling: collection name → max documents ({ posts: 50 }), plus `randomize: true` for a random sample instead of the first N. Collection names are @omega.js/web's (posts, alternatives, team, updates) plus the brand's own `collections`, and the engine hard-fails an unknown one. Development builds only; production never samples.",
    },
    {
      path:        'collections',
      type:        'object',
      required:    false,
      description: "The brand's own content collections: collection name → { field, size, title, description, permalink }. Documents live in `_<name>/`, and @omega.js/web generates the paginated listing page plus one page per category of `field` (the dotted frontmatter path the categories group on, e.g. 'doc.category'). A built-in collection name (posts, alternatives, team, updates) is an error.",
    },
    {
      path:        'purgecss',
      type:        'object',
      required:    false,
      description: 'PurgeCSS post-pass settings for the production css bundle.',
    },
    {
      path:        'purgecss.safelist',
      type:        'object|array',
      required:    false,
      description: "Selectors the content scan cannot see, merged OVER the framework's own safelist. The object form takes PurgeCSS's lanes (standard, deep, greedy, keyframes); a bare array is PurgeCSS's shorthand for `standard`.",
    },
    {
      path:        'purgecss.safelist.standard',
      type:        'array',
      required:    false,
      description: 'Exact class names to keep (strings; PurgeCSS also accepts a regex here).',
    },
    {
      path:        'purgecss.safelist.deep',
      type:        'array',
      required:    false,
      description: 'Patterns (strings, compiled to RegExp) whose matching selectors keep their descendants too.',
    },
    {
      path:        'purgecss.safelist.greedy',
      type:        'array',
      required:    false,
      description: 'Patterns (strings, compiled to RegExp) keeping every selector that contains a match, the lane for a runtime-stamped namespace.',
    },
    {
      path:        'purgecss.safelist.keyframes',
      type:        'array',
      required:    false,
      description: 'Patterns (strings, compiled to RegExp) naming @keyframes to keep.',
    },
  ],

  // Seeded from the sandbox brand's real @omega.js/backend config.
  backend: [
    ...OVERRIDE_RULES.backend,
    // reviews, marketing, blog, dataRequest moved to SHARED_SCHEMA (#277); a
    // targets.backend block still overrides them through the merge chain.
    {
      path:        'projectType',
      type:        'string',
      required:    false,
      enum:        BACKEND_PROJECT_TYPES,
      description: "How this backend RUNS and deploys. 'firebase' (default) exports Cloud Functions; 'custom' runs the same app as an Express server on `PORT` for a container host (Render & co), with no Functions deploy, no emulator lane, and the target's own `deploy` script as the publish lane. Everything else (the auth middleware, the routes, the schemas, every helper) is identical in both modes.",
    },
    {
      path:        'auth.signup.maxPerIpPerDay',
      type:        'integer',
      required:    false,
      min:         1,
      default:     2,
      // Resolution only: the guard reads the resolved value, and a copy in
      // every brand file would pin the framework's cap where nobody chose it.
      materialize: false,
      description: 'Signups allowed per client IP per day (beforeUserCreated blocks the rest). Default 2. Raise it when the audience shares egress (NAT/CGNAT/VPN, offices, campuses).',
    },
  ],

  // The per-OS key is `platforms` (avoids targets.desktop.targets).
  desktop: [
    ...OVERRIDE_RULES.desktop,
    {
      path:        'app.category',
      type:        'string',
      required:    false,
      enum:        ['productivity', 'developer-tools', 'utilities', 'media', 'social', 'network'],
      description: 'Generic high-level category. Maps to per-platform UTI + freedesktop strings.',
    },
    // ── the rest of app.* (#911) ─────────────────────────────────────────
    // The three DERIVED fields carry no schema `default:`: their answer comes
    // from the brand (the bundle-id policy, brand.name, the year), so a
    // materialized null would be a brand file restating "derive it".
    {
      path:        'app.appId',
      type:        'string',
      required:    false,
      description: 'The bundle identifier the app is signed and registered under. Unset, it derives as `certificates.providers.apple.bundleIdPrefix` plus `brand.id` with the dashes as dots, the very id the certificates service registers; a brand with no prefix falls back to the reverse-domain of `brand.url`, then `app.<brand.id>`. Set it only to stay on an id already-shipped builds carry.',
    },
    {
      path:        'app.productName',
      type:        'string',
      required:    false,
      description: 'The product name the installer, the app menu and the artifact names carry. Unset, it is `brand.name`.',
    },
    {
      path:        'app.copyright',
      type:        'string',
      required:    false,
      description: 'The copyright string baked into the mac plist and the Windows version resource. A `{YEAR}` token expands at build time. Unset, it is `© {YEAR}, <brand.name>`.',
    },
    {
      path:        'app.languages',
      type:        'array',
      required:    false,
      description: "The languages the mac build ships (electron-builder's `mac.electronLanguages`). Unset reads as ['en'].",
    },
    {
      path:        'app.darkModeSupport',
      type:        'boolean',
      required:    false,
      description: 'Whether the mac build declares dark-mode support (NSRequiresAquaSystemAppearance). Unset reads as true; windows and linux ignore it.',
    },
    {
      path:        'omega.authPersistence',
      type:        'string',
      required:    false,
      description: "Where @omega.js/client's auth session is kept in the main process: `safeStorage` (the default, the OS keychain through Electron safeStorage), `none` (in-memory, the explicit opt-out), or the name of a strategy the consumer registered before `initialize()`. A test run is always `none`, whatever this says.",
    },
    // ── the shipping declaration (#867) ──────────────────────────────────
    // The SAME shape the extension target declares below: presence is the
    // switch, every platform and every format defaults ON, and the only thing
    // that drops one is a literal `false` (the `certificates: false` idiom).
    // Per-format settings live INSIDE the format. The vocabulary is the
    // client's (mac, windows, linux), and @omega.js/config's platforms.js is
    // the format table every reader derives from.
    {
      path:        'platforms',
      type:        'object',
      required:    false,
      description: "What this desktop target SHIPS, plus each platform's install knobs: `platforms.<mac|windows|linux>.formats.<dmg|nsis|deb|appimage|snap>`. Presence = enabled; drop a default with `false`. The install knobs beside `formats` (arch, the NSIS flags, mac entitlements) map onto the same electron-builder concepts, which @omega.js/desktop owns the target list of.",
    },
    {
      path:        'platforms.mac',
      type:        'object|boolean',
      required:    false,
      description: 'The mac leg: `false` ships no mac build at all (no dmg, no auto-update zip).',
    },
    {
      path:        'platforms.mac.formats',
      type:        'object',
      required:    false,
      description: 'Which mac formats ship. `dmg` is the only one a brand declares; the auto-update zip is not a format (electron-updater fetches it from the feed and nobody links it).',
    },
    {
      path:        'platforms.mac.formats.dmg',
      type:        'object|boolean',
      required:    false,
      description: 'The macOS disk image, and the download `/download/mac/dmg` hands over. `false` drops it.',
    },
    {
      path:        'platforms.windows',
      type:        'object|boolean',
      required:    false,
      description: 'The windows leg: `false` ships no windows build and skips the signing jobs with it.',
    },
    {
      path:        'platforms.windows.formats',
      type:        'object',
      required:    false,
      description: 'Which windows formats ship. `nsis` is the one installer, and it merges every declared arch into one file.',
    },
    {
      path:        'platforms.windows.formats.nsis',
      type:        'object|boolean',
      required:    false,
      description: 'The NSIS installer, and the download `/download/windows/nsis` hands over. `false` drops it. Its installer UX knobs (oneClick, shortcuts, perMachine) sit on `platforms.windows` itself.',
    },
    {
      path:        'platforms.windows.signing.strategy',
      type:        'string',
      required:    false,
      enum:        WINDOWS_SIGNING_STRATEGIES,
      description: 'Windows code-signing path. self-hosted = EV USB token on a runner; cloud = provider CLI; local = developer signs manually. The env schema gates each signing credential on this value, so the walk only ever asks for the set this strategy uses.',
    },
    {
      path:        'platforms.windows.signing.cloud.provider',
      type:        'string',
      required:    false,
      enum:        WINDOWS_CLOUD_PROVIDERS,
      description: 'Whose service signs under the cloud strategy. The env schema gates each provider\'s credentials on this value, so the walk asks for that provider\'s set and no other\'s.',
    },
    {
      path:        'platforms.windows.signing.cloud.options',
      type:        'object',
      required:    false,
      description: 'Provider-specific options for the cloud signing provider named beside it. Credentials never go here: they are .env keys the env schema gates on the provider.',
    },
    {
      path:        'platforms.linux',
      type:        'object|boolean',
      required:    false,
      description: 'The linux leg: `false` ships no linux build at all.',
    },
    {
      path:        'platforms.linux.formats',
      type:        'object',
      required:    false,
      description: 'Which linux formats ship: `deb` and `appimage` are release assets, `snap` publishes to the Snap Store instead.',
    },
    {
      path:        'platforms.linux.formats.deb',
      type:        'object|boolean',
      required:    false,
      description: 'The Debian package, and the download `/download/linux/deb` hands over. It needs `brand.url` and `brand.contact.email` (electron-builder refuses a deb with no homepage or maintainer).',
    },
    {
      path:        'platforms.linux.formats.appimage',
      type:        'object|boolean',
      required:    false,
      description: 'The AppImage, and the download `/download/linux/appimage` hands over. `false` drops it.',
    },
    {
      path:        'platforms.linux.formats.snap',
      type:        'object|boolean',
      required:    false,
      description: "The Snap Store publish (never a release asset: the store holds the file, and `/download/linux/snap` is the listing). On by default like every format, so a desktop target owes SNAPCRAFT_STORE_CREDENTIALS (the walk asks, a publish refuses) until this is `false`.",
    },
    {
      path:        'platforms.linux.formats.snap.channels',
      type:        'array',
      required:    false,
      description: "Snap Store channels the publish pushes to. Unset, the publish uses ['stable']; ['edge'] is the pre-release lane. No schema `default:` on any of these four: materializing one would write a snap block into every brand that never mentioned it.",
    },
    {
      path:        'platforms.linux.formats.snap.confinement',
      type:        'string',
      required:    false,
      enum:        ['strict', 'classic', 'devmode'],
      description: 'Snap confinement. Unset reads as strict, which is what the store reviews fastest; classic needs manual store approval.',
    },
    {
      path:        'platforms.linux.formats.snap.grade',
      type:        'string',
      required:    false,
      enum:        ['stable', 'devel'],
      description: 'Snap grade. Unset reads as stable; a devel snap cannot be released to a stable channel.',
    },
    {
      path:        'platforms.linux.formats.snap.autoStart',
      type:        'boolean',
      required:    false,
      description: 'Whether the snap registers the app to start on login. Unset reads as true.',
    },
    {
      path:        'startup.mode',
      type:        'string',
      required:    false,
      enum:        ['normal', 'hidden'],
      description: 'normal = main window appears at launch; hidden = bakes LSUIElement=true on macOS (no dock, no Cmd+Tab).',
    },
    // ── the OTHER startup knob (#911): what an OS LOGIN launch does ──────
    {
      path:        'startup.openAtLogin.enabled',
      type:        'boolean',
      required:    false,
      description: 'Whether the app registers with the OS to auto-launch at login. Unset reads as true.',
    },
    {
      path:        'startup.openAtLogin.mode',
      type:        'string',
      required:    false,
      enum:        ['normal', 'hidden'],
      description: 'How an AT-LOGIN launch behaves, independently of `startup.mode` (which owns user-direct launches). Unset reads as hidden, so a normal app still starts quietly at login and surfaces when the user opens it.',
    },
    {
      path:        'protocol.singleInstance',
      type:        'boolean',
      required:    false,
      description: 'Whether the app takes the single-instance lock, so a later launch hands its argv (and any deep link) to the running copy and quits. Unset reads as true; `false` suits a CLI-shaped app whose every launch is its own short process, and gives up second-instance forwarding; with it off, boots append to runtime.log and every line carries `[pid <n>]`.',
    },
    // ── the auto-updater block (#911) ────────────────────────────────────
    // Its runtime answers live in the lib's own DEFAULTS, which every
    // unset key falls through to; the cadences are two separate timers on
    // purpose (a feed poll is network, an idle evaluation is arithmetic).
    {
      path:        'autoUpdate.enabled',
      type:        'boolean',
      required:    false,
      description: 'One switch for the auto-updater. Unset reads as true; `false` leaves the whole lane inert (no feed poll, no idle evaluator, no install).',
    },
    {
      path:        'autoUpdate.autoDownload',
      type:        'boolean',
      required:    false,
      description: 'Whether a found update downloads on its own. Unset reads as true; false leaves the download to `omega.autoUpdater` being asked for it.',
    },
    {
      path:        'autoUpdate.startupDelayMs',
      type:        'integer',
      required:    false,
      min:         0,
      description: 'How long after the app is ready the FIRST update check fires. Unset reads as 10000 (10s), which keeps the check off the boot path.',
    },
    {
      path:        'autoUpdate.feedCheckIntervalMs',
      type:        'integer',
      required:    false,
      min:         0,
      description: 'How often the update feed is polled. Network-bound, so keep it slow: unset reads as 3600000 (1h), the cadence Discord, Slack and VS Code use.',
    },
    {
      path:        'autoUpdate.idleEvalIntervalMs',
      type:        'integer',
      required:    false,
      min:         0,
      description: 'How often a DOWNLOADED update re-asks "is the user idle enough to install". In-process arithmetic, so it is cheap: unset reads as 60000 (1m).',
    },
    {
      path:        'autoUpdate.maxAgeMs',
      type:        'integer',
      required:    false,
      min:         0,
      description: 'How long a downloaded update may sit pending before the install stops waiting for an idle moment. Unset reads as 2592000000 (30d).',
    },
    {
      path:        'cdp.readySignal',
      type:        'string',
      required:    false,
      description: 'Boot-complete signal for `mgr cdp relaunch`: a URL substring matched against CDP page targets.',
    },
    {
      path:        'releases.enabled',
      type:        'boolean',
      required:    false,
      description: 'One switch for the release surface: false suppresses the site\'s derived download links AND desktop publishing (electron-builder publish). Site derivation defaults true only when the releases block exists; desktop publishing defaults true regardless.',
    },
    {
      path:        'releases',
      type:        'object',
      required:    false,
      description: "Presence opts the brand into the release surface (the site's download links, desktop publishing). WHICH repo is not configurable: it is the brand's one public `<brand.id>-releases`.",
    },
    {
      path:        'restartManager.enabled',
      type:        'boolean',
      required:    false,
      description: 'External guardian app that relaunches this app on crash. Default true; false disables entirely.',
    },
    {
      path:        'restartManager.feed.owner',
      type:        'string',
      required:    false,
      match:       /^[A-Za-z0-9-]+$/,
      description: 'GitHub owner of the RM release feed. Override for forks/mirrors.',
    },
    {
      path:        'restartManager.feed.repo',
      type:        'string',
      required:    false,
      match:       /^[\w.-]+$/,
      description: 'GitHub repo of the RM release feed.',
    },
    // ── hot config (#911): the JSON the app re-reads without a release ───
    {
      path:        'remoteConfig.enabled',
      type:        'boolean',
      required:    false,
      description: 'The remote-config document, polled at the auto-updater feed cadence so app behavior (a force-update gate, a kill switch) flips without shipping a build. Unset reads as true.',
    },
    {
      path:        'remoteConfig.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Where that document is fetched from. Unset, it derives as `${brand.url}/data/resources/main.json`.',
    },
    {
      path:        'remoteScripts.enabled',
      type:        'boolean',
      required:    false,
      description: 'Emergency remote code execution in the main process, OPT-IN: only `true` arms the lane, anything else leaves it inert.',
    },
    {
      path:        'remoteScripts.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Remote-script source override (default `${brand.url}/data/scripts/main.js`). https-only at runtime: a cleartext URL is refused (localhost excepted for dev).',
    },
    {
      path:        'restartManager.feed.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Full base-URL override for the RM feed + artifacts (air-gapped mirrors). Wins over feed.owner/repo.',
    },
  ],

  // Store listings ARE the extension page's declaration and the curated
  // site.targets.extension view (#85, #610 — no second copy in web config).
  extension: [
    // ── the shipping declaration (#867) ──────────────────────────────────
    // The SAME shape the desktop target declares above, in the browser half of
    // the client's vocabulary (chrome, firefox, edge). `edge` ships the CHROME
    // build: two stores, one chromium artifact.
    {
      path:        'platforms',
      type:        'object',
      required:    false,
      description: "What this extension target SHIPS: `platforms.<chrome|firefox|edge>.formats.<zip|store>`. Presence = enabled; drop a default with `false`. The zip is attached to the release, the store is published to, and @omega.js/config's platforms.js says which credentials each store cannot ship without.",
    },
    {
      path:        'platforms.chrome',
      type:        'object|boolean',
      required:    false,
      description: 'The Chrome leg (the chromium build every Chromium browser installs): `false` ships nothing for it.',
    },
    {
      path:        'platforms.chrome.formats',
      type:        'object',
      required:    false,
      description: 'Which chrome formats ship: `zip` (attached to the release) and `store` (published to the Chrome Web Store).',
    },
    {
      path:        'platforms.chrome.formats.zip',
      type:        'object|boolean',
      required:    false,
      description: 'The packaged zip, attached to the brand releases repo so anyone can install it unpacked.',
    },
    {
      path:        'platforms.chrome.formats.store',
      type:        'object|boolean',
      required:    false,
      description: 'The Chrome Web Store publish. Needs the CHROME_* API credentials plus `listings.chrome.id` (the walk asks for both).',
    },
    {
      path:        'platforms.firefox',
      type:        'object|boolean',
      required:    false,
      description: 'The Firefox leg (its own build: scripts instead of a service worker, sidebar_action instead of side_panel).',
    },
    {
      path:        'platforms.firefox.formats',
      type:        'object',
      required:    false,
      description: 'Which firefox formats ship: `zip` (attached to the release) and `store` (published to addons.mozilla.org).',
    },
    {
      path:        'platforms.firefox.formats.zip',
      type:        'object|boolean',
      required:    false,
      description: 'The packaged zip, attached to the brand releases repo.',
    },
    {
      path:        'platforms.firefox.formats.store',
      type:        'object|boolean',
      required:    false,
      description: 'The addons.mozilla.org publish. Needs FIREFOX_API_KEY + FIREFOX_API_SECRET; the add-on id is the manifest gecko id (`listings.firefox.id`), which the local scaffold pins into config when the brand declares none.',
    },
    {
      path:        'platforms.firefox.formats.store.channel',
      type:        'string',
      required:    false,
      enum:        ['listed', 'unlisted'],
      description: 'Which AMO channel the publish signs into. Unset reads as listed; `unlisted` self-distributes (signed, never listed on the store). No schema `default:`, for the same reason as the snap options: a materialized default would declare the format on a brand that never asked for it.',
    },
    {
      path:        'platforms.edge',
      type:        'object|boolean',
      required:    false,
      description: 'The Edge leg. It ships the CHROME build, so dropping chrome while keeping edge still packages the chromium artifact.',
    },
    {
      path:        'platforms.edge.formats',
      type:        'object',
      required:    false,
      description: 'Which edge formats ship: `zip` (attached to the release) and `store` (published to Edge Add-ons).',
    },
    {
      path:        'platforms.edge.formats.zip',
      type:        'object|boolean',
      required:    false,
      description: 'The packaged zip, attached to the brand releases repo.',
    },
    {
      path:        'platforms.edge.formats.store',
      type:        'object|boolean',
      required:    false,
      description: 'The Edge Add-ons publish. Needs EDGE_CLIENT_ID + EDGE_API_KEY plus `listings.edge.id` (the Partner Center product id).',
    },
    {
      path:        'categories',
      type:        'array',
      required:    false,
      itemEnum:    AMO_CATEGORIES,
      default:     ['alerts-updates'],
      description: "The AMO categories a FIRST Firefox publish lists the add-on under: addons.mozilla.org requires them on a new listing, and the Firefox lane writes them into the `--amo-metadata` file it hands `web-ext sign`. Slugs come from AMO's own set; the default is `alerts-updates`, the most generic one that is not `other`. Chrome and Edge pick their category in their own dashboards.",
    },
    {
      path:        'listings.chrome.id',
      type:        'string',
      required:    false,
      description: 'The Chrome Web Store ITEM ID the publish uploads to, the 32-letter id in the listing URL. Public by design, so it lives here and not in .env; the manage walk asks for it.',
    },
    {
      path:        'listings.chrome.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: "Chrome Web Store listing URL. Feeds site.targets.extension.listings.chrome, the /extension page's button and its /extension/chrome shortlink.",
    },
    {
      path:        'listings.chrome.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
    {
      path:        'listings.firefox.id',
      type:        'string',
      required:    false,
      description: "The addons.mozilla.org ADD-ON ID, which IS the manifest's browser_specific_settings.gecko.id (AMO uses it as the add-on guid). Declared here it is authoritative: the firefox package writes it into the manifest. A brand that declares none gets the derived id pinned here by the extension's local scaffold, never by a publish.",
    },
    {
      path:        'listings.firefox.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Firefox Add-ons (AMO) listing URL. Feeds site.targets.extension.listings.firefox.',
    },
    {
      path:        'listings.firefox.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
    {
      path:        'listings.edge.id',
      type:        'string',
      required:    false,
      description: 'The Microsoft Edge Partner Center PRODUCT ID (a GUID) the publish uploads to. Public by design, so it lives here and not in .env; the manage walk asks for it.',
    },
    {
      path:        'listings.edge.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Microsoft Edge Add-ons listing URL. Feeds site.targets.extension.listings.edge.',
    },
    {
      path:        'listings.edge.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
    {
      path:        'listings.opera.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Opera Add-ons listing URL. Feeds site.targets.extension.listings.opera.',
    },
    {
      path:        'listings.opera.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
    {
      path:        'listings.safari.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'App Store (Safari extension) listing URL. Feeds site.targets.extension.listings.safari.',
    },
    {
      path:        'listings.safari.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
    {
      path:        'listings.brave.url',
      type:        'string',
      required:    false,
      match:       /^https?:\/\//,
      description: 'Brave listing URL (Chrome Web Store serves Brave). Feeds site.targets.extension.listings.brave.',
    },
    {
      path:        'listings.brave.state',
      type:        'string',
      required:    false,
      description: 'Listing state note (e.g. live, pending review). Display-safe, informational only.',
    },
  ],

  // RESERVED — MAM is parked for a separate overhaul; schema slot only.
  mobile: [],
};

// Declared top-level keys that are NOT config sections: `targets` is scoping
// machinery, `url` the target's RESOLVED public url (the `site.url` build fact),
// `type` an entry's framework, and `enabled` the brand's on/off switch.
const NON_SECTION_KEYS = ['targets', 'url', 'type', 'enabled'];

/** The top-level sections a rule array declares (machinery keys excluded). */
const sectionsOf = (rules) => [...new Set(rules.map((rule) => rule.path.split('.')[0]))].filter((section) => !NON_SECTION_KEYS.includes(section));

/**
 * The config sections a target's RESOLVED config can hold (#607) — the
 * namespace a page's `config:` block overrides, in BOTH directions: a section
 * restated bare in frontmatter is a build error, and a key under `config:`
 * that is not one of these is a build error too. Per-target, because a
 * target's refinements land at the top level: `app` is a desktop section, and
 * a web layout's own `app:` block (the deep-link interstitial) is page data,
 * not config.
 * @param {string} [target] - target name; omitted = the shared sections only
 * @returns {string[]} section names, sorted
 */
function configSections(target) {
  return [...new Set([...sectionsOf(SHARED_SCHEMA), ...sectionsOf(TARGET_SCHEMAS[target] || [])])].sort();
}

module.exports = { TRANSLATION_INCLUDE_DEFAULT, TARGETS, CUSTOM_TARGET_TYPE, isCustomTargetEntry, BACKEND_PROJECT_TYPES, backendProjectType, SHARED_SECTIONS, CLIENT_SECTIONS, SHARED_SCHEMA, TARGET_SCHEMAS, BRAND_ID_PATTERN, WINBACK_DURATIONS, REPO_PROVIDERS, HOSTING_PROVIDERS, AMO_CATEGORIES, configSections };
