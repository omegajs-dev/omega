/**
 * Canonical schema for the .env cascade — pure data, no logic
 * ([#581](https://github.com/Omega-JS-Stack/omega/issues/581)).
 *
 * The omega.json5 sibling of schema.js: ONE place that says which env keys
 * OMEGA needs, who owns each, which targets read it, whether OMEGA mints it
 * or a human pastes it from a third party, whether it is required, and what
 * it does. Everything that used to hand-keep its own list derives from here —
 * the manager's mint lane (the keys with a `generated` function), its
 * canonical .env grouping, the per-verb target delivery (composeTargetEnv in
 * env.js), and the backend's env reader (libraries/env.js), which refuses to
 * boot without a required key.
 *
 * Entry format mirrors schema.js's rule objects:
 *
 *   {
 *     name:        'OMEGA_ADMIN_KEY',      // the env var (SCREAMING_SNAKE)
 *     match:       /^CONNECTIONS_.+$/,     // …or a pattern, for dynamic families
 *     owner:       'workspace',            // the manager service that owns it
 *                                          // ('backend' = the framework itself)
 *     targets:     ['backend'],            // the targets whose runtime READS it
 *     group:       'omega',                // its ENV_GROUPS bucket (file order)
 *     generated:   () => randomBytes(32)…, // the function that MINTS a value
 *     default:     'value',                // …or a static default, where one applies
 *     secret:      true,                   // never printed, never in omega.json5
 *     required:    true,                   // absent = the backend refuses to boot
 *     deliverAs:   'GOOGLE_ANALYTICS_SECRET', // the name it lands under in the
 *                                          // target's composed .env (see below)
 *     delivery:    { backend: 'env' },      // HOW it reaches each target
 *     publicAtRest: true,                  // …and, for a bake, that anyone who
 *                                          // unpacks the app may read it
 *     requiredWhen: holds('analytics.providers.google.id'), // when the
 *                                          // config depends on it (env-when.js)
 *     askedWhen:   asks({ captcha: onUnlessOff('…enabled') }), // per service, when
 *                                          // `omega manage` asks for it
 *     machineLocal: true,                  // a developer-machine value (a local
 *                                          // path): never published to CI
 *     label:       'Snap Store credentials', // the human name an ask opens with
 *     url:         'https://snapcraft.io/account', // the page that MINTS it
 *     hint:        'Run `snapcraft export-login -`', // how to get it there
 *     description: 'What the key drives.',
 *   }
 *
 * `label`, `url` and `hint` are the HUMAN half, and this schema is their one
 * home ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)): the
 * manager's REQUIRES registry used to carry a second copy per service, so a key
 * no service had wired up (every desktop signing key, every extension store
 * key) had no mint page anywhere and nobody could be asked for it. `label` is
 * what the setup gate opens with, `url` is the page a human pastes the value
 * FROM (the manage walk's Enter-to-open target, and what publish prints when a
 * key is missing), and `hint` is the one line that says what to do on that
 * page. `url: null` is a deliberate statement that no page mints this value,
 * and such an entry owes a `hint` saying where it does come from (a token a
 * portal authorization returns, a path on the developer's own box). The
 * manager's registry keeps only its own fields (which service asks, whether the
 * ask is interactive, what Disable writes).
 *
 * `generated:` is the mint switch: the manager writes those keys into a brand
 * .env (at onboard and on every manage that finds one missing) because no
 * dashboard exists to paste them from. Everything else is a third-party
 * credential a human provides. A key is minted OR defaulted, never both, and
 * only a key OMEGA can produce may be `required` — refusing every boot over a
 * secret nobody can mint would be a hostage note, not a guard.
 *
 * `targets:` is the composition domain: composeTargetEnv (env.js) composes a
 * target's own .env from the company/brand layers' keys whose targets include
 * it — the backend's is the ONLY one that ships with a deploy artifact and so
 * cannot walk up to the brand layer at runtime. Every other target reads brand
 * values through the runtime cascade, so their `targets` entries are mostly
 * documentation.
 *
 * `group:` picks the .env section the key renders into. A group with
 * `file: false` never reaches a brand .env at all — the backend resolves those
 * keys some other way (from config at boot, from the target's own .env, from
 * the developer's own shell) — so they are neither rendered as placeholders
 * nor composed from the brand layer.
 *
 * `deliverAs:` is the RENAME on delivery: the key is written into a brand .env
 * under its own name (the per-target GA4 secrets are `GOOGLE_ANALYTICS_SECRET_
 * <TARGET>` there, because one brand holds one per stream) and reaches its
 * target under `deliverAs` (`GOOGLE_ANALYTICS_SECRET` — a target only ever has
 * one stream). applyDeliverAs (env.js) is the one place it happens, on every
 * verb: composed into dist/.env for the backend, loaded into process.env at
 * CLI boot for the others. Absent = delivered under its own name.
 *
 * A key that must differ between a local run and a deployed one is NOT a second
 * entry here ([#586](https://github.com/Omega-JS-Stack/omega/issues/586)): one
 * key, and the brand's `.env.<environment>` overlay carries the other value.
 * The schema declares WHAT a brand supplies, never which environment supplies
 * it — env.js's cascade owns that.
 *
 * `delivery:` is HOW the key reaches each target it names — the declaration
 * that replaced three unrelated hand-kept lists
 * ([#627](https://github.com/Omega-JS-Stack/omega/issues/627)):
 *
 *   - `'env'`  : read from the composed .env the target runs with. On the
 *                backend that file ships with the deploy artifact; on every
 *                other target it is the composed .env on the DEVELOPER'S
 *                machine, so an `env` delivery there declares the local
 *                channel and renders no workflow line at all
 *                ([#819](https://github.com/Omega-JS-Stack/omega/issues/819)).
 *   - `'ci'`   — the generated workflow injects it into the runner env for the
 *                build step.
 *   - `'bake'` — the build writes the value INTO the shipped artifact, because
 *                a packaged app (desktop, extension) runs with no .env. A bake
 *                implies its `'ci'` half: the workflow injects, then the build
 *                bakes. Anyone who unpacks the app can read a baked value, so
 *                a baking entry must declare `publicAtRest: true` — the
 *                renderer REFUSES to bake a `secret: true` entry without it.
 *
 * A target absent from `delivery` gets nothing: no workflow line, no bake, no
 * repo secret. env-delivery.js is the ONE reader — every workflow secrets
 * block, bake list and push-secrets set derives from these declarations, so a
 * new key is one entry here and nothing else.
 *
 * `requiredWhen:` and `askedWhen:` are the two "when" facts, each written with
 * the named rules of env-when.js. `requiredWhen` is one rule: the brand's
 * config now depends on the key, so a deploy, a bake or a production start
 * refuses without it. `askedWhen` (`asks`) maps each manager service that asks
 * for the key to the rule that turns the ask on; the person may skip it. They differ
 * on purpose: the Sentry token is asked before a Sentry project exists,
 * because the manager creates the project with it. The keys a ship format
 * needs are neither: the format table in platforms.js is their one home.
 * missingEnvKeys (env-needs.js) is the ONE reader of all three.
 */
const { randomBytes, randomUUID } = require('node:crypto');
const { holds, onUnlessOff, chosen, hasTarget, ships, signsWith, realProject, all, asks } = require('./env-when.js');
const { ENV_GROUPS, envFileGroups } = require('./env-groups.js');

// The three ways a key reaches a target (#627) — see the header.
const DELIVERY_MODES = ['env', 'ci', 'bake'];

// The asks several keys share, each stated once. A key only the backend reads
// is asked only of a brand that has one; a registrar must be chosen before
// the domain service asks anything.
const BACKEND = hasTarget('backend');
const DOMAIN_ON = all(onUnlessOff('domain.enabled'), chosen('domain.providers'));
// A demo project is local only, so the cloud service never asks there; the
// other Google services ask on their own switches
const GOOGLE_ASKS = asks({
  cloud: all(onUnlessOff('cloud.enabled'), realProject()),
  analytics: all(onUnlessOff('analytics.enabled'), holds('analytics.providers.google.propertyId')),
  search: onUnlessOff('search.providers.searchConsole.enabled'),
  advertising: holds('advertising.providers.adsense.client'),
});
const CAMPAIGNS_ON = all(onUnlessOff('marketing.campaigns.enabled'), chosen('marketing.campaigns.providers', require('./email-providers.js').emailProviderForRole('campaigns').id));
const NEWSLETTER_ON = all(onUnlessOff('marketing.newsletter.enabled'), chosen('marketing.newsletter.providers', require('./email-providers.js').emailProviderForRole('newsletter').id));
const APPLE_ASK = asks({ certificates: all(onUnlessOff('certificates.enabled'), hasTarget('desktop', 'mobile')) });
const APPLE_SIGNING = holds('certificates.providers.apple');
const GA4_STREAM = holds('analytics.providers.google.id');

const ENV_SCHEMA = [
  // ── omega — the keys OMEGA mints for itself ──────────────────────────────
  {
    name:        'OMEGA_ADMIN_KEY',
    owner:       'workspace',
    targets:     ['backend'],
    group:       'omega',
    generated:   () => randomBytes(32).toString('base64url'),
    secret:      true,
    required:    true,
    delivery:    { backend: 'env' },
    label:       'Omega admin key',
    url:         null,
    description: 'Grants admin on the brand backend: the header every privileged call carries, and the seed the connection state cipher derives from.',
  },
  {
    name:        'OMEGA_WEBHOOK_KEY',
    owner:       'workspace',
    targets:     ['backend'],
    group:       'omega',
    generated:   () => randomBytes(32).toString('base64url'),
    secret:      true,
    required:    true,
    delivery:    { backend: 'env' },
    label:       'Omega webhook key',
    url:         null,
    description: 'Authenticates third-party webhook deliveries (payments, marketing) — the `key` query parameter every webhook route compares.',
  },
  {
    name:        'OMEGA_NAMESPACE',
    owner:       'workspace',
    targets:     ['backend'],
    group:       'omega',
    generated:   () => randomUUID(),
    secret:      true,
    required:    true,
    delivery:    { backend: 'env' },
    description: "The brand's UUID namespace — every deterministic id the backend mints (uuid route, analytics client ids) derives from it.",
  },
  {
    name:        'UNSUBSCRIBE_HMAC_KEY',
    owner:       'workspace',
    targets:     ['backend'],
    group:       'omega',
    generated:   () => randomBytes(32).toString('hex'),
    secret:      true,
    required:    true,
    delivery:    { backend: 'env' },
    description: 'Signs the unsubscribe link in every email the backend sends, and verifies the signature when a recipient follows one.',
  },

  // ── the OMEGA license — issued by omegajs.dev, pasted by a human ─────────
  {
    name:        'OMEGA_LICENSE_KEY',
    owner:       'workspace',
    targets:     ['web', 'backend', 'desktop', 'extension'],
    group:       'license',
    secret:      true,
    required:    false,
    delivery:    { web: 'ci', backend: 'ci', desktop: 'ci', extension: 'ci' },
    description: 'The omegajs.dev account API key that licenses this brand: a deploy checks it with the omega backend and bakes the verdict into the artifact, payments live and no omega attribution, or payments gated and attribution shown. It travels CLI → server at deploy time ONLY: every delivery is `ci`, on all four targets, because every deploy now runs on a runner (the backend since [#872](https://github.com/Omega-JS-Stack/omega/issues/872), whose `omega deploy --direct` step reads the key out of the workflow env and would otherwise stamp every CI deploy `keyless`). It never bakes, and `ci` is what keeps it out of every backend `.env`: the workflow writes only `env` deliveries, and the stage strips the runner-only keys out of the composed values, so it can never land in the .env the functions artifact ships with.',
  },

  // ── third-party credentials, by owning service ───────────────────────────
  {
    name:        'GH_TOKEN',
    owner:       'repo',
    targets:     ['web', 'backend', 'desktop', 'extension'],
    group:       'github',
    secret:      true,
    required:    false,
    delivery:    { web: 'ci', backend: 'env', desktop: 'ci', extension: 'ci' },
    description: 'GitHub token for repo + seo work and the backend\'s content/admin routes (blog commits, workflow dispatch); the web target publishes CI secrets with it and the desktop target cuts releases and mirrors downloads with it. `gh auth login` serves the manager instead; the deployed backend needs the token. The extension target carries it too: its publish uploads the built zips to the `<brand.id>-releases` repo, a repo that run does not own, so the run-scoped `secrets.GITHUB_TOKEN` cannot reach it ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)).',
  },
  {
    name:        'CLOUDFLARE_TOKEN',
    owner:       'edge',
    targets:     ['web', 'backend'],
    group:       'cloudflare',
    secret:      true,
    required:    false,
    askedWhen:   asks({ edge: onUnlessOff('edge.providers.cloudflare.enabled'), domain: DOMAIN_ON }),
    delivery:    { web: 'ci', backend: 'env' },
    label:       'Cloudflare API token',
    url:         'https://dash.cloudflare.com/profile/api-tokens',
    hint:        'Create a token with Zone edit on the brand zone, plus Account Settings Write for Web Analytics; the DNS-writing flows and the zone nameserver read both use it',
    description: 'Cloudflare API token with Zone edit, plus Account Settings Write for the edge service\'s Web Analytics site: the edge service and every DNS-writing flow use it, plus the backend\'s cache-purge calls. The web build workflow\'s post-publish purge step reads it from the runner env, so the publish lane pushes it as a repo secret.',
  },
  {
    name:        'NAMECHEAP_USERNAME',
    owner:       'domain',
    targets:     [],
    group:       'namecheap',
    secret:      false,
    required:    false,
    askedWhen:   asks({ domain: all(DOMAIN_ON, chosen('domain.providers', 'namecheap')) }),
    label:       'Namecheap account username',
    url:         'https://ap.www.namecheap.com/settings/tools/apiaccess/',
    hint:        'The account the domain is registered under (the same page enables API access)',
    description: 'Namecheap account the domain service registers and configures domains through.',
  },
  {
    name:        'NAMECHEAP_API_KEY',
    owner:       'domain',
    targets:     [],
    group:       'namecheap',
    secret:      true,
    required:    false,
    askedWhen:   asks({ domain: all(DOMAIN_ON, chosen('domain.providers', 'namecheap')) }),
    label:       'Namecheap API key',
    url:         'https://ap.www.namecheap.com/settings/tools/apiaccess/',
    hint:        'Toggle API Access on, then whitelist this machine\'s IP on the same page',
    description: 'Namecheap API key paired with NAMECHEAP_USERNAME (the API also allowlists the calling IP).',
  },
  {
    name:        'GOOGLE_CLIENT_ID',
    owner:       'cloud',
    targets:     [],
    group:       'google-oauth',
    secret:      false,
    required:    false,
    askedWhen:   GOOGLE_ASKS,
    label:       'Google OAuth client ID',
    url:         'https://console.cloud.google.com/apis/credentials',
    hint:        'A Desktop-app OAuth client: the one Google identity every service shares',
    description: 'OAuth client the manager authenticates Google APIs with (cloud, analytics, search, advertising services).',
  },
  {
    name:        'GOOGLE_CLIENT_SECRET',
    owner:       'cloud',
    targets:     [],
    group:       'google-oauth',
    secret:      true,
    required:    false,
    askedWhen:   GOOGLE_ASKS,
    label:       'Google OAuth client secret',
    url:         'https://console.cloud.google.com/apis/credentials',
    description: 'Secret half of GOOGLE_CLIENT_ID.',
  },
  {
    name:        'RECAPTCHA_SECRET_KEY',
    owner:       'captcha',
    targets:     ['backend'],
    group:       'captcha',
    secret:      true,
    required:    false,
    requiredWhen: holds('captcha.providers.recaptcha.siteKey'),
    askedWhen:   asks({ captcha: all(BACKEND, onUnlessOff('captcha.providers.recaptcha.enabled')) }),
    delivery:    { backend: 'env' },
    label:       'reCAPTCHA secret key',
    url:         'https://console.cloud.google.com/security/recaptcha',
    hint:        'Create a classic key in the brand\'s OWN GCP project (never a shared company key); its SITE half lands in config',
    description: 'Secret half of the reCAPTCHA pair — the backend verifies submitted tokens with it.',
  },
  {
    name:        'HCAPTCHA_SECRET',
    owner:       'captcha',
    targets:     ['backend'],
    group:       'captcha',
    secret:      true,
    required:    false,
    delivery:    { backend: 'env' },
    description: 'hCaptcha secret for brands on hCaptcha instead of reCAPTCHA — the backend verifies form submissions with it.',
  },
  {
    name:        'META_ACCESS_TOKEN',
    owner:       'analytics',
    targets:     ['backend'],
    group:       'pixels',
    secret:      true,
    required:    false,
    askedWhen:   asks({ analytics: all(BACKEND, onUnlessOff('analytics.enabled'), onUnlessOff('analytics.providers.meta')) }),
    delivery:    { backend: 'env' },
    label:       'Meta Pixel access token',
    url:         'https://business.facebook.com/settings/system-users',
    hint:        'A Business Manager SYSTEM USER token with ads_management: it creates the pixel and signs the conversions',
    description: 'Business Manager system-user token with ads_management: creates the Meta pixel and signs the conversions the backend sends.',
  },
  {
    name:        'TIKTOK_ACCESS_TOKEN',
    owner:       'analytics',
    targets:     ['backend'],
    group:       'pixels',
    secret:      true,
    required:    false,
    askedWhen:   asks({ analytics: all(BACKEND, onUnlessOff('analytics.enabled'), onUnlessOff('analytics.providers.tiktok')) }),
    delivery:    { backend: 'env' },
    label:       'TikTok Events API access token',
    url:         null,
    hint:        'Minted by the portal authorization the analytics setup walks (#448): the app secret is only needed at mint time, so there is no page to paste this from',
    description: 'TikTok Business token: creates the pixel on the advertiser account and signs the events the backend sends.',
  },
  {
    name:        'SENTRY_AUTH_TOKEN',
    owner:       'monitoring',
    targets:     [],
    group:       'monitoring',
    secret:      true,
    required:    false,
    requiredWhen: holds('monitoring.providers.sentry.dsn'),
    askedWhen:   asks({ monitoring: all(onUnlessOff('monitoring.enabled'), chosen('monitoring.providers', 'sentry')) }),
    label:       'Sentry personal auth token',
    url:         'https://sentry.io/settings/account/api/auth-tokens/',
    hint:        'Create a personal token with scopes: org:read, project:read, project:write, team:read, team:write (organization tokens cannot create projects)',
    description: 'Personal Sentry auth token with project+team write scopes: the monitoring service provisions projects with it. Source maps upload nowhere; they ship public beside the bundles.',
  },
  {
    name:        'SENDGRID_API_KEY',
    owner:       'campaigns',
    targets:     ['backend'],
    group:       'email-marketing',
    secret:      true,
    required:    false,
    askedWhen:   asks({ campaigns: all(BACKEND, CAMPAIGNS_ON) }),
    delivery:    { backend: 'env' },
    label:       'SendGrid API key',
    url:         'https://app.sendgrid.com/settings/api_keys',
    description: 'SendGrid API key — every transactional and campaign email the backend sends, and the contact lists the campaigns service reconciles.',
  },
  {
    name:        'BEEHIIV_API_KEY',
    owner:       'newsletter',
    targets:     ['backend'],
    group:       'email-marketing',
    secret:      true,
    required:    false,
    askedWhen:   asks({ newsletter: all(BACKEND, NEWSLETTER_ON) }),
    delivery:    { backend: 'env' },
    label:       'Beehiiv API key',
    url:         'https://app.beehiiv.com/settings/workspace/api',
    description: 'Beehiiv API key — newsletter subscriptions and the publication the newsletter service reconciles.',
  },
  {
    name:        'STRIPE_SECRET_KEY',
    owner:       'payment',
    targets:     ['backend'],
    group:       'payment',
    secret:      true,
    required:    false,
    askedWhen:   asks({ payment: all(BACKEND, onUnlessOff('payment.enabled'), onUnlessOff('payment.providers.stripe')) }),
    delivery:    { backend: 'env' },
    label:       'Stripe secret key',
    url:         'https://dashboard.stripe.com/apikeys',
    hint:        'Developers, then API keys, on the BRAND\'s Stripe account (sk_live_... or sk_test_...)',
    description: 'Stripe secret key — the backend creates checkout sessions, subscriptions, and refunds with it.',
  },
  {
    name:        'PAYPAL_CLIENT_SECRET',
    owner:       'payment',
    targets:     ['backend'],
    group:       'payment',
    secret:      true,
    required:    false,
    askedWhen:   asks({ payment: all(BACKEND, onUnlessOff('payment.enabled'), onUnlessOff('payment.providers.paypal')) }),
    delivery:    { backend: 'env' },
    label:       'PayPal client secret',
    url:         'https://developer.paypal.com/dashboard/applications',
    hint:        'The secret half of the brand\'s REST API app (its client id is public and lives in omega.json5)',
    description: 'Secret half of the PayPal app credentials (the client id is public and lives in omega.json5).',
  },
  {
    name:        'CHARGEBEE_API_KEY',
    owner:       'payment',
    targets:     ['backend'],
    group:       'payment',
    secret:      true,
    required:    false,
    askedWhen:   asks({ payment: all(BACKEND, onUnlessOff('payment.enabled'), onUnlessOff('payment.providers.chargebee')) }),
    delivery:    { backend: 'env' },
    label:       'Chargebee API key',
    url:         'https://app.chargebee.com/',
    hint:        'Settings, then API keys, on the brand\'s Chargebee site (the site name is public and lives in omega.json5)',
    description: 'Chargebee API key for the brand site (the site name is public and lives in omega.json5).',
  },
  {
    name:        'COINBASE_COMMERCE_API_KEY',
    owner:       'payment',
    targets:     ['backend'],
    group:       'payment',
    secret:      true,
    required:    false,
    // The key is the whole credential, so only an explicit ON asks; its own
    // switch is named too, because that is what Disable turns off
    askedWhen:   asks({ payment: all(BACKEND, onUnlessOff('payment.enabled'), onUnlessOff('payment.providers.coinbase.enabled'), holds('payment.providers.coinbase.enabled')) }),
    delivery:    { backend: 'env' },
    label:       'Coinbase Commerce API key',
    url:         'https://commerce.coinbase.com/settings/security',
    hint:        'Settings, then Security, then API keys, on the brand\'s Coinbase Commerce account (this key is the whole credential: there is no public half)',
    description: 'Coinbase Commerce API key — the backend creates hosted crypto charges with it. The provider has no public half at all, so payment.providers.coinbase carries only its `enabled` switch.',
  },
  {
    name:        'SLAPFORM_SERVICE_ACCOUNT',
    owner:       'forms',
    targets:     [],
    group:       'service-accounts',
    secret:      true,
    required:    false,
    askedWhen:   asks({ forms: onUnlessOff('forms.providers.slapform.enabled') }),
    label:       'Slapform\'s service-account JSON path',
    url:         null,
    hint:        'Operator-only: the Slapform project\'s own service-account JSON, from its Firebase console. Absolute, or relative to the brand root',
    description: 'Path to the Slapform service-account JSON the forms service authenticates with.',
  },
  {
    name:        'CHATSY_SERVICE_ACCOUNT',
    owner:       'chat',
    targets:     [],
    group:       'service-accounts',
    secret:      true,
    required:    false,
    askedWhen:   asks({ chat: onUnlessOff('inbound.chat.providers.chatsy.enabled') }),
    label:       'Chatsy\'s service-account JSON path',
    url:         null,
    hint:        'Operator-only: the Chatsy project\'s own service-account JSON, from its Firebase console. Absolute, or relative to the brand root',
    description: 'Path to the Chatsy service-account JSON the chat service authenticates with.',
  },
  {
    name:        'REPLYIFY_SERVICE_ACCOUNT',
    owner:       'email',
    targets:     [],
    group:       'service-accounts',
    secret:      true,
    required:    false,
    askedWhen:   asks({ email: onUnlessOff('inbound.email.providers.replyify.enabled') }),
    label:       'Replyify\'s service-account JSON path',
    url:         null,
    hint:        'Operator-only: the Replyify project\'s own service-account JSON, from its Firebase console. Absolute, or relative to the brand root',
    description: 'Path to the Replyify service-account JSON the email service authenticates with.',
  },
  {
    name:        'SERVER_SERVICE_ACCOUNT',
    owner:       'server',
    targets:     [],
    group:       'service-accounts',
    secret:      true,
    required:    false,
    askedWhen:   asks({ server: onUnlessOff('server.enabled') }),
    label:       'the company server\'s service-account JSON path',
    url:         null,
    hint:        'Operator-only: the company server project\'s own service-account JSON, from its Firebase console. Absolute, or relative to the brand root',
    description: 'Path to the server service-account JSON the server service authenticates with.',
  },
  {
    name:        'MRLOGO_SERVICE_ACCOUNT',
    owner:       'assets',
    targets:     [],
    group:       'service-accounts',
    secret:      true,
    required:    false,
    label:       'Mr. Logo\'s service-account JSON path',
    url:         null,
    hint:        'Operator-only: the Mr. Logo project\'s own service-account JSON. Absolute, or relative to the brand root',
    description: 'Path to the Mr. Logo service-account JSON the assets service generates brand artwork through.',
  },
  {
    name:        'APPLE_API_ISSUER',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'apple',
    secret:      false,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    askedWhen:   APPLE_ASK,
    delivery:    { desktop: 'ci' },
    label:       'App Store Connect issuer ID',
    url:         'https://appstoreconnect.apple.com/access/api',
    hint:        'Users and Access, then Integrations: the issuer ID sits above the key list',
    description: 'App Store Connect API issuer id: notarization of the desktop build. Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.',
  },
  {
    name:        'APPLE_API_KEY_ID',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'apple',
    secret:      false,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    askedWhen:   APPLE_ASK,
    delivery:    { desktop: 'ci' },
    label:       'App Store Connect API key ID',
    url:         'https://appstoreconnect.apple.com/access/api',
    hint:        'The key you download as AuthKey_<id>.p8; the id is the filename',
    description: 'App Store Connect API key id: also names the .p8 file the certificates service places (AuthKey_<id>.p8). Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.',
  },
  {
    name:        'APPLE_TEAM_ID',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'apple',
    secret:      false,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    askedWhen:   APPLE_ASK,
    delivery:    { desktop: 'ci' },
    label:       'Apple Developer team ID',
    url:         'https://developer.apple.com/account',
    hint:        'Membership details shows the 10-character Team ID',
    description: 'Apple Developer team id the desktop build signs under. Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.',
  },
  {
    name:        'CSC_LINK',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'apple',
    secret:      false,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    delivery:    { desktop: 'ci' },
    description: 'Path to the macOS Developer ID signing certificate (.p12) electron-builder signs with; unset, the build derives it from the signing tree (<brand root>/.omega/certificates/apple/certificates/DEVELOPER_ID_APPLICATION_G2.p12, a company tree answering first), then falls back to the Keychain. Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.',
  },
  {
    name:        'APPLE_API_KEY',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'apple',
    secret:      false,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    delivery:    { desktop: 'ci' },
    description: 'Path to the App Store Connect API key (.p8) notarization uses; unset, the build derives it from the signing tree (<brand root>/.omega/certificates/apple/AuthKey_<APPLE_API_KEY_ID>.p8, a company tree answering first). Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.',
  },

  // ── desktop-publishing — the Windows + Linux halves of a desktop release ──
  {
    name:        'WIN_EV_TOKEN_PATH',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      false,
    required:    false,
    requiredWhen: signsWith('self-hosted'),
    delivery:    { desktop: 'ci' },
    label:       'Windows EV certificate thumbprint',
    url:         null,
    hint:        'Read off the EV token on the self-hosted Windows runner: `certutil -user -store My` prints the thumbprint of the installed certificate',
    description: 'Thumbprint/path of the EV code-signing certificate on the self-hosted Windows runner (platforms.windows.signing.strategy = self-hosted). Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it self-hosted, the default platforms.windows.signing.strategy.',
  },
  {
    name:        'WIN_CSC_KEY_PASSWORD',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('self-hosted'),
    delivery:    { desktop: 'ci' },
    label:       'Windows EV token PIN',
    url:         null,
    hint:        'The SafeNet token PIN set when the EV certificate was issued; the token vendor never shows it again',
    description: 'SafeNet token PIN the Windows signing job unlocks the EV token with. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it self-hosted, the default platforms.windows.signing.strategy.',
  },
  {
    name:        'SIGNTOOL_PATH',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      false,
    required:    false,
    delivery:    { desktop: 'ci' },
    label:       'signtool.exe path',
    url:         null,
    hint:        'Where the Windows SDK installed signtool.exe on the runner, e.g. C:\\\\Program Files (x86)\\\\Windows Kits\\\\10\\\\bin\\\\10.0.22621.0\\\\x64\\\\signtool.exe',
    description: 'Path to signtool.exe on the Windows runner.',
  },
  // The cloud signing providers (platforms.windows.signing.strategy = cloud): the
  // windows-sign job injects all three sets and the configured provider is the
  // one that consumes its own ([#627](https://github.com/Omega-JS-Stack/omega/issues/627)).
  {
    name:        'AZURE_TENANT_ID',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'azure'),
    delivery:    { desktop: 'ci' },
    label:       'Azure Trusted Signing tenant ID',
    url:         'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Overview',
    hint:        'The directory (tenant) the Trusted Signing account lives in',
    description: 'Azure Trusted Signing: the directory (tenant) the signing account lives in. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider azure.',
  },
  {
    name:        'AZURE_CLIENT_ID',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'azure'),
    delivery:    { desktop: 'ci' },
    label:       'Azure app registration client ID',
    url:         'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    hint:        'The app registration the signing job authenticates as',
    description: 'Azure Trusted Signing: the app registration the signing job authenticates as. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider azure.',
  },
  {
    name:        'AZURE_CLIENT_SECRET',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'azure'),
    delivery:    { desktop: 'ci' },
    label:       'Azure app registration client secret',
    url:         'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    hint:        'Certificates and secrets on the app registration above; the value is shown once',
    description: 'Azure Trusted Signing: the client secret of AZURE_CLIENT_ID. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider azure.',
  },
  {
    name:        'AZURE_TRUSTED_SIGNING_ENDPOINT',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'azure'),
    delivery:    { desktop: 'ci' },
    label:       'Azure Trusted Signing endpoint',
    url:         'https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.CodeSigning%2FcodeSigningAccounts',
    hint:        'The regional endpoint of the Trusted Signing account, e.g. https://eus.codesigning.azure.net',
    description: 'Azure Trusted Signing: the regional endpoint the signing account was created in. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider azure.',
  },
  {
    name:        'SSLCOM_USERNAME',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'sslcom'),
    delivery:    { desktop: 'ci' },
    label:       'SSL.com eSigner account',
    url:         'https://www.ssl.com/login/',
    hint:        'The eSigner account the cloud signing job authenticates with',
    description: 'SSL.com eSigner account the cloud signing job authenticates with. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider sslcom.',
  },
  {
    name:        'SSLCOM_PASSWORD',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'sslcom'),
    delivery:    { desktop: 'ci' },
    label:       'SSL.com eSigner password',
    url:         'https://www.ssl.com/login/',
    hint:        'The password of the eSigner account above',
    description: 'Password of the SSL.com eSigner account. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider sslcom.',
  },
  {
    name:        'SSLCOM_CREDENTIAL_ID',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'sslcom'),
    delivery:    { desktop: 'ci' },
    label:       'SSL.com eSigner credential ID',
    url:         'https://www.ssl.com/login/',
    hint:        'Under the certificate order: it names WHICH certificate in the account signs',
    description: 'SSL.com eSigner credential id naming which certificate in the account signs. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider sslcom.',
  },
  {
    name:        'DIGICERT_API_KEY',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'digicert'),
    delivery:    { desktop: 'ci' },
    label:       'DigiCert KeyLocker API key',
    url:         'https://one.digicert.com/signingmanager/keypairs',
    hint:        'Account, then API tokens, in DigiCert ONE Software Trust Manager',
    description: 'DigiCert KeyLocker API key the cloud signing job authenticates with. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider digicert.',
  },
  {
    name:        'DIGICERT_KEYPAIR_ALIAS',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: signsWith('cloud', 'digicert'),
    delivery:    { desktop: 'ci' },
    label:       'DigiCert KeyLocker keypair alias',
    url:         'https://one.digicert.com/signingmanager/keypairs',
    hint:        'The alias of the keypair that signs, from the Keypairs list',
    description: 'DigiCert KeyLocker keypair alias naming which certificate in the account signs. Required when a desktop target ships the Windows installer (platforms.windows.formats.nsis, on by default) and signs it with platforms.windows.signing.strategy cloud and platforms.windows.signing.cloud.provider digicert.',
  },
  {
    name:        'SNAPCRAFT_STORE_CREDENTIALS',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'desktop-publishing',
    secret:      true,
    required:    false,
    requiredWhen: ships('linux', 'snap'),
    delivery:    { desktop: 'ci' },
    label:       'Snap Store credentials',
    url:         'https://snapcraft.io/account',
    hint:        'Log in, then run `snapcraft export-login -` locally and paste the whole blob it prints',
    description: 'Snap Store credentials blob (`snapcraft export-login -`): the snap login a Linux package or release refuses without, and the one the publishing walk registers the snap name (brand.id) with. Required when a desktop target ships the snap format, which is on by default: `false` at platforms.linux.formats.snap turns it off.',
  },

  // ── extension-stores — one credential set per browser store ──────────────
  {
    name:        'CHROME_CLIENT_ID',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      false,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Chrome Web Store OAuth client ID',
    url:         'https://console.cloud.google.com/apis/credentials',
    hint:        'Enable the Chrome Web Store API in the project, then create a Desktop-app OAuth client; the refresh token is minted from this client',
    description: 'OAuth client id of the Chrome Web Store API credential.',
  },
  {
    name:        'CHROME_CLIENT_SECRET',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      true,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Chrome Web Store OAuth client secret',
    url:         'https://console.cloud.google.com/apis/credentials',
    hint:        'The secret half of the OAuth client above',
    description: 'OAuth client secret of the Chrome Web Store API credential.',
  },
  {
    name:        'CHROME_REFRESH_TOKEN',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      true,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Chrome Web Store refresh token',
    url:         null,
    hint:        'Minted once by granting the OAuth client above the chromewebstore scope (the Chrome Web Store API guide walks the consent exchange); no dashboard shows it',
    description: 'Refresh token the Chrome Web Store API credential mints its access tokens from.',
  },
  {
    name:        'FIREFOX_API_KEY',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      false,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Firefox Add-ons API key',
    url:         'https://addons.mozilla.org/developers/addon/api/key/',
    hint:        'The JWT issuer half of the AMO credential',
    description: 'Firefox Add-ons API key (JWT issuer) from addons.mozilla.org.',
  },
  {
    name:        'FIREFOX_API_SECRET',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      true,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Firefox Add-ons API secret',
    url:         'https://addons.mozilla.org/developers/addon/api/key/',
    hint:        'Shown once when the credential is generated, beside the issuer above',
    description: 'Firefox Add-ons API secret the JWT is signed with.',
  },
  {
    name:        'EDGE_CLIENT_ID',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      false,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Edge Add-ons API client ID',
    url:         'https://partner.microsoft.com/dashboard/microsoftedge/publishapi',
    hint:        'Publish API on the Edge program dashboard: it issues the client id and the key together',
    description: 'Edge Add-ons API client id.',
  },
  {
    name:        'EDGE_API_KEY',
    owner:       'certificates',
    targets:     ['extension'],
    group:       'extension-stores',
    secret:      true,
    required:    false,
    delivery:    { extension: 'ci' },
    label:       'Edge Add-ons API key',
    url:         'https://partner.microsoft.com/dashboard/microsoftedge/publishapi',
    hint:        'Issued beside the client id above; it authenticates every publish request',
    description: 'Edge Add-ons API key the publish request authenticates with.',
  },

  // No test-lane credentials live here: web, desktop and extension each sign
  // in as a persona the backend emulator seeds, so a suite never asks a brand
  // for a key. The retired pair's rows are @omega.js/manager's migrate table.

  {
    name:        'OMEGA_FONTAWESOME_ROOT',
    owner:       'assets',
    targets:     ['web', 'desktop', 'extension'],
    group:       'fontawesome',
    secret:      false,
    required:    false,
    delivery:    { web: 'ci', desktop: 'ci', extension: 'ci' },
    machineLocal: true,
    description: "Filesystem path to the developer's local Font Awesome Pro package — machine-local, so it never travels to CI (the free set is the fallthrough).",
  },

  // ── backend service keys ─────────────────────────────────────────────────
  // ONE key per AI provider ([#639](https://github.com/Omega-JS-Stack/omega/issues/639)):
  // the OMEGA_-prefixed twins are gone. A company-wide key is the COMPANY
  // layer of the .env cascade under the SAME name — never a second key name.
  {
    name:        'OPENAI_API_KEY',
    owner:       'backend',
    targets:     ['web', 'backend', 'extension'],
    group:       'backend-services',
    secret:      true,
    required:    false,
    askedWhen:   asks({ ai: onUnlessOff('ai.enabled') }),
    delivery:    { web: 'env', backend: 'env', extension: 'env' },
    label:       'OpenAI API key',
    url:         'https://platform.openai.com/api-keys',
    hint:        'A secret key on the account that should be billed for the brand\'s OpenAI calls',
    description: 'The OpenAI key wherever the backend calls OpenAI, and what the shared translation engine needs when translation.providers names chatgpt (the default "claude" provider needs none): the brand .env wins, a company .env serves every brand that sets none. Every delivery is `env`, the composed .env on the developer\'s own machine, because translation runs locally by default and CI reads the committed cache ([#905](https://github.com/Omega-JS-Stack/omega/issues/905)): no workflow line delivers this key to a runner.',
  },
  {
    name:        'ANTHROPIC_API_KEY',
    owner:       'backend',
    targets:     ['backend'],
    group:       'backend-services',
    secret:      true,
    required:    false,
    askedWhen:   asks({ ai: all(BACKEND, onUnlessOff('ai.enabled')) }),
    delivery:    { backend: 'env' },
    label:       'Anthropic API key',
    url:         'https://console.anthropic.com/settings/keys',
    hint:        'A workspace API key (the Claude Code subscription login is a separate thing and needs no key)',
    description: 'The Anthropic key wherever the backend calls Anthropic — the brand .env wins, a company .env serves every brand that sets none.',
  },
  {
    name:        'NEVERBOUNCE_API_KEY',
    owner:       'backend',
    targets:     ['backend'],
    group:       'backend-services',
    secret:      true,
    required:    false,
    delivery:    { backend: 'env' },
    description: 'NeverBounce API key — the first-choice email-validation provider on signup and marketing sync.',
  },
  {
    name:        'ZEROBOUNCE_API_KEY',
    owner:       'backend',
    targets:     ['backend'],
    group:       'backend-services',
    secret:      true,
    required:    false,
    delivery:    { backend: 'env' },
    description: 'ZeroBounce API key — the email-validation provider used when NeverBounce is unset.',
  },
  {
    match:       /^CONNECTIONS_[A-Z0-9_]+_CLIENT_(ID|SECRET)$/,
    owner:       'backend',
    targets:     ['backend'],
    group:       'backend-services',
    secret:      true,
    required:    false,
    delivery:    { backend: 'env' },
    description: "Per-provider OAuth client credentials for the backend's user-connection routes (CONNECTIONS_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET) — pasted into the brand .env from each provider's console; the provider set is open, so the family is a pattern.",
  },

  // ── machine-owned: written by a service on its first real run ────────────
  {
    name:        'ACCOUNT_PASSWORD_SEED',
    owner:       'account',
    targets:     [],
    group:       'machine',
    secret:      true,
    required:    false,
    description: 'Seed the account service derives every brand-owned account password from — generated on the first run that needs one.',
  },
  {
    name:        'CSC_KEY_PASSWORD',
    owner:       'certificates',
    targets:     ['desktop'],
    group:       'machine',
    secret:      true,
    required:    false,
    requiredWhen: APPLE_SIGNING,
    delivery:    { desktop: 'ci' },
    description: "Password of the desktop signing certificate the certificates service created; electron-builder reads it at package time. Required once the brand declares Apple signing (certificates.providers.apple): an `omega deploy` that cannot push it ships an unsigned mac build.",
  },
  {
    name:        'VAPID_PRIVATE_KEY',
    owner:       'cloud',
    targets:     [],
    group:       'machine',
    secret:      true,
    required:    false,
    description: 'Private half of the Web Push key pair — the Firebase console shows it once, so the cloud service persists it here (the public half lives in omega.json5).',
  },
  {
    name:        'GOOGLE_ANALYTICS_SECRET_WEB',
    owner:       'analytics',
    targets:     ['web'],
    group:       'machine',
    secret:      true,
    required:    false,
    requiredWhen: GA4_STREAM,
    delivery:    { web: 'ci' },
    deliverAs:   'GOOGLE_ANALYTICS_SECRET',
    description: "Measurement Protocol secret of the web target's GA4 stream — delivered as GOOGLE_ANALYTICS_SECRET on every verb (composed into dist/.env for backend, loaded into process.env for the others).",
  },
  {
    name:        'GOOGLE_ANALYTICS_SECRET_BACKEND',
    owner:       'analytics',
    targets:     ['backend'],
    group:       'machine',
    secret:      true,
    required:    false,
    requiredWhen: GA4_STREAM,
    delivery:    { backend: 'env' },
    deliverAs:   'GOOGLE_ANALYTICS_SECRET',
    description: "Measurement Protocol secret of the backend target's GA4 stream — delivered as GOOGLE_ANALYTICS_SECRET on every verb (composed into dist/.env for backend, loaded into process.env for the others).",
  },
  {
    name:        'GOOGLE_ANALYTICS_SECRET_DESKTOP',
    owner:       'analytics',
    targets:     ['desktop'],
    group:       'machine',
    secret:      true,
    publicAtRest: true,
    required:    false,
    requiredWhen: GA4_STREAM,
    delivery:    { desktop: 'bake' },
    deliverAs:   'GOOGLE_ANALYTICS_SECRET',
    description: "Measurement Protocol secret of the desktop target's GA4 stream — delivered as GOOGLE_ANALYTICS_SECRET on every verb (composed into dist/.env for backend, loaded into process.env for the others).",
  },
  {
    name:        'GOOGLE_ANALYTICS_SECRET_EXTENSION',
    owner:       'analytics',
    targets:     ['extension'],
    group:       'machine',
    secret:      true,
    publicAtRest: true,
    required:    false,
    requiredWhen: GA4_STREAM,
    delivery:    { extension: 'bake' },
    deliverAs:   'GOOGLE_ANALYTICS_SECRET',
    description: "Measurement Protocol secret of the extension target's GA4 stream — delivered as GOOGLE_ANALYTICS_SECRET on every verb (composed into dist/.env for backend, loaded into process.env for the others).",
  },
  {
    name:        'GOOGLE_ANALYTICS_SECRET_MOBILE',
    owner:       'analytics',
    targets:     ['mobile'],
    group:       'machine',
    secret:      true,
    required:    false,
    // No requiredWhen: MAM is parked (hard rule 4) — nothing mints, delivers or reads this key, so a rule here could only warn forever.
    deliverAs:   'GOOGLE_ANALYTICS_SECRET',
    description: "Measurement Protocol secret of the mobile target's GA4 stream — delivered as GOOGLE_ANALYTICS_SECRET on every verb (composed into dist/.env for backend, loaded into process.env for the others).",
  },

  // ── runtime-resolved: never hand-written into a brand .env ───────────────
  {
    name:        'GOOGLE_ANALYTICS_SECRET',
    owner:       'analytics',
    targets:     ['web', 'backend', 'desktop', 'extension'],
    group:       'runtime',
    secret:      true,
    required:    false,
    description: "A target's own Measurement Protocol secret — the delivery renames the brand-level GOOGLE_ANALYTICS_SECRET_<TARGET> to this name (deliverAs), so it is never composed from a brand key of the same name.",
  },
  {
    name:        'OMEGA_LICENSE_STATUS',
    owner:       'workspace',
    targets:     ['backend'],
    group:       'runtime',
    secret:      false,
    required:    false,
    description: "The deploy-time license verdict (#320), written into dist/.env by the backend deploy itself — `licensed` or `keyless`. It is COMPUTED, never supplied: the runtime group renders no brand .env line, so nothing composes one down from the brand layer. The payment provider libraries refuse live processing on `keyless`; absent (every local lane, the emulator, a test) is today's behavior exactly.",
  },
  {
    name:        'OMEGA_SERVICE_ACCOUNT_JSON',
    owner:       'cloud',
    targets:     ['backend'],
    group:       'runtime',
    secret:      true,
    required:    false,
    delivery:    { backend: 'ci' },
    description: "The deploy credential, as the service-account JSON's own CONTENTS ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)): the backend deploy runs on a runner now, and a runner has no `.omega/secrets/` to read the key file from, so the deploy precheck publishes the file's bytes as this repo secret and the composed workflow writes them back to the path `firebase deploy` authenticates with. It is a FILE everywhere else, so it renders no brand .env line (the runtime group) and never composes into the artifact's own .env.",
  },
  {
    name:        'CLAUDE_CODE_OAUTH_TOKEN',
    owner:       'backend',
    targets:     ['backend'],
    group:       'runtime',
    secret:      true,
    required:    false,
    description: "Developer tooling credential (`claude setup-token`) the claude-code AI provider falls back to — deliberately never composed into a brand's target .env.",
  },
];

/**
 * The entry that governs a name — an exact match first, then the dynamic
 * families' patterns. Undefined for a name the schema does not know.
 *
 * A name no entry governs is the CONSUMER's own key
 * ([#835](https://github.com/Omega-JS-Stack/omega/issues/835)), and the
 * optional `schema` is the same escape every delivery function takes: a caller
 * (the tests) exercises the rules against a fixture, and nobody re-implements
 * the exact-then-pattern lookup.
 *
 * @param {string} name - The env var name.
 * @param {object[]} [schema] - Env schema entries (default: the real schema).
 * @returns {object|undefined} The schema entry.
 */
function envSchemaEntry(name, schema = ENV_SCHEMA) {
  return schema.find((entry) => entry.name === name)
    || schema.find((entry) => entry.match instanceof RegExp && entry.match.test(name));
}

/**
 * Whether a key is a developer-machine value (`machineLocal: true`) that no
 * CI-secrets publisher may send ([#454](https://github.com/Omega-JS-Stack/omega/issues/454)).
 *
 * @param {string} name - The env var name.
 * @returns {boolean}
 */
function isMachineLocal(name) {
  const entry = envSchemaEntry(name);
  return Boolean(entry && entry.machineLocal);
}

/**
 * The NAMED keys a target reads, in schema order — the rendering lane's list
 * (which placeholders a brand .env carries, in which section). Pattern
 * families are excluded because they have no fixed name to render.
 *
 * NOT the delivery filter: composeTargetEnv (env.js) is, and it honors the
 * pattern families and `deliverAs` this list cannot express
 * ([#678](https://github.com/Omega-JS-Stack/omega/issues/678)).
 *
 * @param {string} target - Target name ('backend', 'web', …).
 * @returns {string[]} Env var names.
 */
function envKeysForTarget(target) {
  const fileGroups = new Set(envFileGroups().map((group) => group.id));

  return ENV_SCHEMA
    .filter((entry) => entry.name && fileGroups.has(entry.group) && entry.targets.includes(target))
    .map((entry) => entry.name);
}

/**
 * The keys OMEGA mints for itself: name → the function that produces a value.
 * The manager's onboard stub and its manage-time mint both render from this.
 *
 * @returns {Object<string, function(): string>} Name → generator.
 */
function generatedEnvKeys() {
  return Object.fromEntries(ENV_SCHEMA
    .filter((entry) => typeof entry.generated === 'function')
    .map((entry) => [entry.name, entry.generated]));
}

/**
 * Group id → its keys in schema order, every declared group present.
 *
 * @returns {Object<string, string[]>} Group id → env var names.
 */
function envKeysByGroup() {
  const byGroup = Object.fromEntries(ENV_GROUPS.map((group) => [group.id, []]));

  for (const entry of ENV_SCHEMA) {
    if (entry.name) byGroup[entry.group].push(entry.name);
  }

  return byGroup;
}

module.exports = {
  ENV_SCHEMA,
  ENV_GROUPS,
  DELIVERY_MODES,
  envFileGroups,
  envSchemaEntry,
  isMachineLocal,
  envKeysForTarget,
  generatedEnvKeys,
  envKeysByGroup,
};
