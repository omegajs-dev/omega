/**
 * Manager registry — SERVICE_ORDER, per-service OPERATIONS (from operations.js), and the manager
 * defaults layer. This is omega-manager's config.js reborn for the brand-
 * monorepo world: the brand's config/omega.json5 is the single home of every
 * provisioned fact (no .brands/ mirror), secrets live in the brand .env, and
 * per-run transients in .omega/runs/{ts}.json.
 *
 * omega-manager's full provisioning order is ported — every service in
 *
 *   github → cloudflare → domain → firebase → recaptcha → analytics →
 *   search-console → adsense → sendgrid → beehiiv → payment → slapform →
 *   chatsy → replyify → server → assets → certificates → seo → disperse →
 *   update → account → migrations → bookmark → testing
 *
 * now runs here, plus the workspace service (brand structure/config
 * health) the monorepo world added. disperse is registered with NO operations
 * (#891): the config dispersal dissolved into the omega.json5 hierarchy, the
 * .env composition into the delivery step every verb runs (#678), and the
 * signing artifacts are read in place from the signing tree. bookmark +
 * the beehiiv segment automation talk to the OMEGA Companion extension,
 * which is the OMEGA brand's own extension target now and no longer a tree
 * inside this package (#927). Onboarding is the
 * `onboard` wizard; a company is a LAYER a brand names, never a mode (#677).
 *
 * Provider-named services renamed to their config ROLE key (cp134, Ian:
 * "rename services so they match the config key"): firebase→cloud,
 * sendgrid→campaigns, beehiiv→newsletter, sentry→monitoring; the last eight
 * followed in #418: github→repo, cloudflare→edge, recaptcha→captcha,
 * search-console→search, adsense→advertising, slapform→forms, chatsy→chat,
 * replyify→email. Provider STRINGS and provider KEYS in config
 * (cloud.provider: 'firebase', edge.providers.cloudflare,
 * inbound.chat.providers.chatsy, …) are unchanged — the service is the role,
 * the provider is a value.
 */

const { schemaDefaults, deepMerge, envSchemaEntry, ENV_SCHEMA, generatedEnvKeys, SHIP_SERVICE } = require('@omega.js/config');
const { shipCredentials } = require('./services/publishing/lib/ship-list.js');
const { OPERATIONS } = require('./operations.js');

// =============================================================================
// DEFAULT SETTINGS - The manager defaults layer under every brand config
// =============================================================================

// Only what a schema `default:` cannot carry (docs/shared/config.md): null or
// empty placeholders a service writes back or an owner fills, settings under a
// `providers.<vendor>` key whose presence picks that vendor, and the case-3
// `devlog.enabled`. The exported DEFAULTS is the schema's defaults plus this.
const MANAGER_DEFAULTS = {
  // Domain registrar and email: two roles, one providers block each, the KEY
  // under `providers` picking the vendor. No entry: a terminal walk asks, a
  // headless one skips. `false` at `email.providers` or `email.forwarding` means none.
  domain: {
    providers: {},    // { namecheap: {} } | { squarespace: {} } — one registrar
    email: {
      providers: {},  // { cloudflare: {} } | { squarespace: {} } | { privateemail: {} }
      forwarding: [], // [{ from: 'support' | '*', to: 'inbox@example.com' }] — role-level, provider-agnostic
    },
  },

  // Cloud settings — ONE home (#23): the provisioning fields the manager owns
  // sit beside `cloud.provider`/`cloud.config` (the target config @omega.js/config
  // declares), including the platform-level org + billing account the project
  // ensures consume. Auth: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in the
  // brand .env. projectId has no default and lives ONLY at cloud.config.projectId
  // — interactive runs offer the project selection/creation flow and land it
  // there; non-interactive runs skip until it's set. Company values
  // omega-manager hardcoded (googlegroup support email, the company org and
  // billing account) are config now — they land in company/brand config.
  cloud: {
    supportEmail: null,   // OAuth consent screen support email (defaults to the AUTHORIZING user's email — Google rejects any address the caller doesn't own; set only for an owned Google Group)
    organizationId: null, // GCloud org ID — tri-state (#33): null = ask at project create, false = no org (standalone), value = create inside it (proper default permissions)
    billingAccount: null, // 'billingAccounts/XXXXXX-XXXXXX-XXXXXX' — tri-state: null = ask, false = stay on Spark, value = auto-upgrade to Blaze
  },

  // Analytics providers. Google auth: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
  // in the brand .env (analytics.edit scope, tokens cached separately from
  // firebase's). propertyId is required config — interactive runs offer the
  // account + property selection/creation flow and land both ids here
  // (comment-preserving writeback). Meta/TikTok pixel IDs are public config
  // too — the service CREATES the pixel on the platform's accountId and lands
  // its id here (#417); Meta needs neither filled in, since an interactive run
  // pastes the token in and discovers the ad account from it (a provider set
  // to `false` opts out of all of it). Their access tokens live in the brand
  // .env (META_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN — the names @omega.js/backend
  // reads, and the credentials the creates authenticate with). Per-target
  // GA4 measurement ids land under targets.{target}.analytics.providers
  // .google.id — one stream per surface, so one id per surface.
  analytics: {
    providers: {
      google: {
        accountId: null,  // GA account number — console deep-links; the selection flow lands it
        propertyId: null, // GA4 property number — google operations skip until set (the selection/create flow lands it)
        timeZone: 'America/Los_Angeles', // GA4 property reporting time zone (used when the flow creates the property)
        currency: 'USD',                 // GA4 property reporting currency (used when the flow creates the property)
        enhancedMeasurement: {
          streamEnabled: true,
          scrollsEnabled: true,
          outboundClicksEnabled: true,
          siteSearchEnabled: true,
          videoEngagementEnabled: true,
          fileDownloadsEnabled: true,
          pageChangesEnabled: true,
          formInteractionsEnabled: true,
        },
      },
      meta: {
        id: null,        // Meta Pixel ID — the create lands it (public config: it ships in the frontend)
        accountId: null, // Meta AD ACCOUNT number (bare, no act_ prefix) the pixel is created on — discovered from META_ACCESS_TOKEN when unset
      },
      tiktok: {
        id: null,        // TikTok Pixel Code — the create lands it
        accountId: null, // TikTok ADVERTISER id the pixel is created on — no account, no create
      },
    },
  },

  // Devlog — auto-generated commit-digest blog posts (standalone
  // `omega-manager devlog`). Stateless: each run fetches commits from the
  // last `lookbackDays` days, has the provider (Ghostii) write the article,
  // and publishes to `destinations`. Not a service — never runs during manage.
  devlog: {
    enabled: false,               // Role-level: the whole pipeline's switch
    providers: {
      ghostii: {                  // Article writer — presence picks it (only ghostii exists)
        lookbackDays: 5,
        orgs: [],                 // GitHub orgs/users to fully scan — for NON-brand repos (frameworks, tooling); brand repos are always scanned via the brand configs
        excludeRepos: [],         // Repo names never fetched or mentioned
        excludeCommits: [],       // Regex patterns (case-insensitive) — matching commit messages never reach the digest
        excludeTopics: [],        // Topics the writer must never discuss
        includePrivate: true,     // Scan private repos too — exclude rules govern what gets WRITTEN, not what gets read
        postPath: 'devlog',       // Sub-folder under src/_posts/{year}/ in the website target
        destinations: ['website'], // website | devto | hashnode | medium (planned)
        overrides: {              // Ghostii API overrides
          length: 'long',
          research: false,        // The digest is the source — no web research
          insertImages: false,    // Local publisher doesn't mirror images into the repo (yet)
          headerImageUrl: 'disabled',
          maxLinks: 10,           // Backlinks are the point — allow more than Ghostii's default 6
        },
      },
    },
  },

  // Search Console (submitSitemap + sitemapPaths: schema defaults) needs no
  // manager-owned data. The domain property (sc-domain:) covers every
  // subdomain; DNS TXT verification writes through Cloudflare. Auth: the same
  // GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET as firebase/analytics (own token
  // cache — webmasters + siteverification scopes). omega-manager also carried
  // a `subdomains: []` key here that nothing ever read — dropped.

  // AdSense: deliberately NO defaults entry (wave-5 F10). The service gates on
  // the PRESENCE of `advertising.providers.adsense` in the merged
  // config — seeding it here would defeat that gate (defaults merge under
  // every brand), and the account-selection flow would land a shared account
  // into brands that never opted in. A brand (or the company layer) authors
  // the provider entry — even empty — to opt in; `client` (ca-pub-…) comes
  // from config or the interactive selection flow.

  // Marketing — TWO roles, one providers block each (#425). campaigns = email
  // marketing (the campaigns service); newsletter = the newsletter (the
  // newsletter service). The vendor is a KEY under `providers`; `enabled`
  // stays role-level, and so does `newsletter.content` (it configures
  // @omega.js/backend's generator, not Beehiiv). listId/publicationId are
  // resolved by the services and written back under their provider
  // (comment-preserving writeback), with a state mirror as the resolution
  // cache. Auth: SENDGRID_API_KEY / BEEHIIV_API_KEY in the brand .env
  // (+ OMEGA_WEBHOOK_KEY for the webhook operations).
  // omega-manager also carried a newsletter.content generator blob here —
  // it's @omega.js/backend newsletter-generator data, not service config; it rides the
  // config-hierarchy dispersal story.
  marketing: {
    campaigns: {
      providers: {
        sendgrid: {
          listId: null,
        },
      },
    },
    newsletter: {
      providers: {
        beehiiv: {
          publicationId: null,
        },
      },
    },
  },

  // Payment providers + products. Public halves live here (publishableKey,
  // clientId, site); secrets come from the brand .env (STRIPE_SECRET_KEY,
  // PAYPAL_CLIENT_SECRET, CHARGEBEE_API_KEY). Interactive runs offer the
  // key-collection flow when an enabled provider is missing credentials
  // (public keys land here, secrets in the .env). Set a provider to
  // `false` to disable it — the flow's Disable answer writes that.
  // Product IDs are written back here by the services (state keeps a mirror).
  // omega-manager's DEFAULTS also carried the company's Stripe organizationId
  // (dashboard deep-links use the account ID from state now) and hardcoded
  // the company CDN for product images (brand.images.brandmark now).
  payment: {
    providers: {
      stripe: {
        publishableKey: null,
        updateAccountInfo: true, // false = leave the account's business profile alone
        // Radar fraud-prevention rules — Dashboard-only (no API); the
        // stripe-radar operation prints these as guidance until confirmed.
        // Actions: 'block', 'allow', 'review', 'request_three_d_secure'.
        // Predicate syntax: https://docs.stripe.com/radar/rules/reference
        radar: [
          // --- Card type restrictions ---
          { action: 'block', predicate: ":card_funding: = 'prepaid'", description: 'Block prepaid cards' },
          { action: 'block', predicate: ":card_brand: = 'mastercard' AND :card_funding: = 'debit'", description: 'Block Mastercard debit' },

          // --- Risk-based rules ---
          { action: 'block', predicate: ":risk_level: = 'highest'", description: 'Block highest risk payments' },
          { action: 'review', predicate: ":risk_level: = 'elevated'", description: 'Review elevated risk payments' },

          // --- Address/CVC verification ---
          { action: 'block', predicate: ":cvc_check: = 'fail'", description: 'Block failed CVC checks' },
          { action: 'block', predicate: ":address_zip_check: = 'fail'", description: 'Block failed ZIP checks' },

          // --- Velocity / abuse ---
          { action: 'block', predicate: ':total_charges_per_card_number_daily: > 5', description: 'Block >5 charges per card per day' },
          { action: 'block', predicate: ':total_charges_per_ip_address_daily: > 10', description: 'Block >10 charges per IP per day' },

          // --- 3D Secure for risky but not blocked ---
          { action: 'request_three_d_secure', predicate: ":risk_level: = 'elevated'", description: 'Require 3DS for elevated risk' },
        ],
      },
      paypal: {
        clientId: null,
      },
      chargebee: {
        site: null,
      },
    },
    products: [], // [{ id, name, type: 'subscription'|'one-time', prices: { monthly, annually, once }, trial: { days }, ... }]
  },

  // Slapform contact form (slapform.com) — Slapform-operator integration:
  // needs SLAPFORM_SERVICE_ACCOUNT in the brand .env (path to the Slapform
  // Firebase project's service-account JSON). formId comes from the Slapform
  // dashboard (interactive runs offer the paste-back flow and land it
  // here); plan = the tier granted to the form-owner account (Slapform's
  // top tier by default — omega-manager resolved it from the slapform brand's
  // own config in `.brands/`, a company-mode read).
  forms: {
    providers: {
      slapform: {
        formId: null,
      },
    },
  },

  // Inbound conversations — one home per CHANNEL, provider-discriminated
  // inside it (#23).
  inbound: {
    // Chat: Chatsy support chat (chatsy.ai) — Chatsy-operator integration:
    // needs CHATSY_SERVICE_ACCOUNT in the brand .env (path to the Chatsy
    // Firebase project's service-account JSON). agentId comes from the Chatsy
    // dashboard (interactive runs offer the paste-back flow and land it here);
    // plan = the tier granted to the agent-owner account (Chatsy's top tier by
    // default — omega-manager resolved it from the chatsy brand's own config in
    // `.brands/`, a company-mode read). updateAgentInfo: false = the agent is
    // shared and managed by another brand. sponsorshipsUrl fills the baseline
    // knowledge's sponsorship line (omega-manager hardcoded the company page;
    // null → {website}/contact). The agent image comes from
    // brand.images.brandmark (omega-manager hardcoded the company CDN).
    // `settings` is the widget presentation block @omega.js/client passes to
    // the Chatsy SDK — same home as the provisioning fields, no second copy.
    chat: {
      providers: {
        chatsy: {
          agentId: null,
          sponsorshipsUrl: null,
        },
      },
    },

    // Email: Replyify customer-service email agent (replyify.app) —
    // Replyify-operator integration: needs REPLYIFY_SERVICE_ACCOUNT in the
    // brand .env (path to the Replyify Firebase project's service-account
    // JSON). agentId comes from the Replyify dashboard (interactive runs offer
    // the paste-back flow and land it here); plan = the tier granted to the
    // agent-owner account (Replyify's top tier by default — omega-manager
    // resolved it from the replyify brand's own config in `.brands/`, a
    // company-mode read). updateAgentInfo: false = the agent is shared and
    // managed by another brand. discount renders the baseline's discount
    // section only when set ({ code, label } — omega-manager hardcoded the
    // company's code for every brand); the company sponsorship block left the
    // packaged baseline entirely — that prose belongs in config/replyify.md.
    email: {
      providers: {
        replyify: {
          agentId: null,
          discount: null,
        },
      },
    },
  },

  // Company-server brand registry — publishes the brand's registry entry
  // (brand identity, github, sponsorships) to the company server's Firestore
  // at brands/{brand.id}, where the parent backend reads it (webhook fan-out,
  // cross-brand features). Needs SERVER_SERVICE_ACCOUNT in the brand .env
  // (path to the company server's Firebase service-account JSON — omega-
  // manager hardcoded the company project and read company-instance secrets).
  // Its switch (`server.enabled`, on by default) is a schema default.

  // Parent-project brand directory (#246) — pushes this brand's own entry
  // into the PARENT project's brands collection, so whatever the parent runs
  // on top of it (ITW's guest-post sponsorship marketplace is the first) reads
  // a current directory. Its opt-in switch (`directory.enabled`, off by
  // default because the entry is world-readable by design) is a schema
  // default; the service also needs `company: { id }` to name the relationship
  // (#677) and DIRECTORY_SERVICE_ACCOUNT in the brand .env.

  // Derived visual collateral, made locally and mtime-diffed from the brand's logo sources
  // (assets/logo/*.svg → .omega/assets/): wordmark/combomark from brand.font, logo variants +
  // PNG ladders, app icons, social icons; no brandmark → the AI flow when MrLogo credentials
  // are in the brand .env. Its switch (`assets.enabled`, on by default) is a schema default.

  // Apple signing certificates, bundle IDs, and provisioning profiles for
  // brands with desktop/mobile targets, reconciled via the App Store
  // Connect API. Credentials live in the brand .env (APPLE_API_ISSUER,
  // APPLE_API_KEY_ID, APPLE_TEAM_ID) plus an AuthKey_*.p8 placed in
  // .omega/certificates/apple/. bundleIdPrefix MUST be set by the brand
  // (reverse-DNS of the company/brand domain, e.g. 'com.mycompany' — the
  // onboard wizard derives + seeds it) — omega-manager hardcoded the
  // company prefix and kept one shared cert set in its company-instance
  // .output/_shared/; the port keeps everything brand-local.
  certificates: {
    providers: {
      apple: {
        // Full bundle ID = composeBundleId(prefix, brand.id) — the brand id's
        // dashes become dots (Android-safe segments), e.g.
        // com.itwcreativeworks + daily-build → com.itwcreativeworks.daily.build
        bundleIdPrefix: null,
        // Capabilities enabled on the brand's bundle ID
        capabilities: ['APPLE_ID_AUTH'],
        // Cert types that get a provisioning profile per applicable platform
        profiles: ['IOS_DISTRIBUTION', 'MAC_APP_DISTRIBUTION', 'DEVELOPER_ID_APPLICATION_G2'],
        // Certificate types to manage (one set per Apple Developer account).
        // manual: Apple's API cannot create these — the Account Holder
        // downloads the .cer from the developer portal.
        certificates: [
          { type: 'DEVELOPMENT' },
          { type: 'IOS_DISTRIBUTION' },
          { type: 'MAC_INSTALLER_DISTRIBUTION' },
          { type: 'MAC_APP_DISTRIBUTION' },
          { type: 'DEVELOPER_ID_APPLICATION_G2', manual: true },
          { type: 'DEVELOPER_ID_INSTALLER_G2', manual: true },
        ],
      },
    },
  },

  // Parasite SEO content: GitHub repos with templated READMEs, defined in
  // seo.github.content or the config/seo.json5 sidecar (no content = skip).
  // Its switch (`seo.enabled`, on by default) is a schema default.

  // Required accounts in the brand's Firebase Auth, passwords derived from
  // ACCOUNT_PASSWORD_SEED in the brand .env. The switch (`account.enabled`)
  // and the admin list (`account.admins`) are schema defaults.

  // Classic reCAPTCHA — the brand's OWN keys (de-ITW: never a company-shared
  // key): the public SITE key is `siteKey` right here (#893) and the secret is
  // RECAPTCHA_SECRET_KEY in the brand .env (missing either → the service asks
  // interactively, else skips). `project` =
  // the brand's GCP project hosting the key, used only for the console
  // deep-link in guidance (omega-manager hardcoded the company project here).
  captcha: {
    providers: {
      recaptcha: {
        project: null,
      },
    },
  },
};

// The manager's defaults layer: the schema's own answers first, this file's
// service-owned data on top (#478). Every existing read site — the walk's
// loadConfig defaults, `DEFAULTS.account.admins`, the zone-settings diff —
// sees one composed object, and no default has two homes.
const DEFAULTS = deepMerge(schemaDefaults(), MANAGER_DEFAULTS);

// =============================================================================
// SERVICE ORDER - Services run in this order due to dependencies
// =============================================================================
const SERVICE_ORDER = [
  'workspace',       // brand monorepo structure + config health — everything depends on a sane workspace
  'repo',            // the brand repo must exist before services that write to it
  'edge',            // zone must exist before DNS-dependent services
  'domain',          // registrar nameservers point at the zone the edge service just created/verified
  'cloud',           // cloud project (Firebase provider) must exist before analytics/backend-dependent services
  'captcha',         // validates the shared keys the frontend/backend consume from .env
  'analytics',       // GA4 streams need the firebase link; search links to analytics next
  'search',          // needs the edge zone (DNS verification) + the GA property (association)
  'advertising',     // domain present in the AdSense account + approval state (read-only API)
  'monitoring',      // error-monitoring project per target + DSN writeback (Sentry provider; own API, no cross-service deps)
  'campaigns',       // email marketing (SendGrid provider): domain auth (DNS via the edge zone), sender, list, unsubscribe groups, fields, segments, webhook
  'newsletter',      // newsletter publication (Beehiiv provider): access, fields, segments (verify-only), webhook
  'payment',         // Stripe/PayPal/Chargebee products + prices + webhooks reconciled to payment.products
  'forms',           // brand's Slapform contact form settings + owner-account plan (Slapform operator only)
  'chat',            // brand's Chatsy chat agent settings + knowledge + owner-account plan (Chatsy operator only)
  'email',           // brand's Replyify email agent filter + knowledge + owner-account plan (Replyify operator only)
  'server',          // brand registry entry on the company server's Firestore (company-server operators only)
  'directory',       // brand's own entry pushed into the PARENT project's brands collection (opt-in; no cross-service deps)
  'assets',          // derived logo variants, app icons, social icons (local, mtime-diffed)
  'certificates',    // Apple certs, bundle IDs, provisioning profiles (desktop/mobile targets only)
  'publishing',      // Every SHIP credential the brand's declared formats need: store keys + ids, Windows signing, the snap login (#867)
  'ai',              // AI provider keys asked into the brand .env — the ONE file every target's runtime env composes from
  'disperse',        // registered with no operations today (#891)
  'seo',             // parasite SEO GitHub repos — low priority, no downstream deps
  'update',          // installs deps + builds every target
  'account',         // required Firebase Auth accounts + admin roles (after deploy — signup calls hit the live backend)
  'migrations',      // Firestore data migrations — only with --migration (audit unless --execute), after the deployed backend is current
  'bookmark',        // brand bookmarks → the OMEGA Companion extension (interactive sessions only)
  'testing',         // health checks after everything else ran
];

// The BOOT lane (#228) — what the dev legs consume every boot: local
// redistribution only (file work, no network, no rebuilds), so `omega dev`
// starts in about a second instead of waiting on the cloud services.
// NOT in this list = manage lane by construction: a new service can never
// slow the boot by default, and promoting one is a deliberate edit here.
// It is the DELIVERY lane too (#678): brand-root `omega deploy` runs this
// same list before it fans out, so a publish never ships inputs a manage run
// happened to be current on. One constant, two triggers.
const BOOT_SERVICES = [
  'workspace',       // brand structure + config health — a broken brand must not serve
  'assets',          // derived logo/icon variants the targets read from their own dirs
  'disperse',        // registered with no operations today (#891)
];

// =============================================================================
// REQUIRES - the manager's own half of each service's setup gate
// =============================================================================

/**
 * WHICH keys a service asks for, and WHEN, is the env schema's (`askedWhen`,
 * and the format table for ship keys); missingEnvKeys answers it. A row holds
 * the manager's fields only: `why`, `label`, `disablePath` (where "Disable
 * permanently" writes `false`), `prompted` (a TTY run pastes mid-run),
 * `gates: false` (every input optional: preflight never gates) and `scopes`.
 * A key OMEGA mints, or one with a narrower switch of its own, never gates.
 */
const REQUIRES = {
  edge: {
    why: 'reconciles the zone, DNS records, rulesets, and settings via the Cloudflare API',
    label: 'Cloudflare',
    disablePath: 'edge.providers.cloudflare.enabled',
    prompted: true,
    scopes: [],
  },

  domain: {
    why: 'points the registrar nameservers at the Cloudflare zone',
    label: 'Domain registrar',
    disablePath: 'domain.enabled',
    prompted: true,
    scopes: [],
  },

  cloud: {
    why: 'reconciles the Firebase/GCP project (billing, APIs, hosting, auth, data stores) via Google APIs',
    label: 'Google Cloud',
    disablePath: 'cloud.enabled',
    scopes: [
      'https://www.googleapis.com/auth/firebase',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/cloud-billing',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  },

  captcha: {
    why: "proves the brand's own classic reCAPTCHA keys are valid (siteverify)",
    label: 'reCAPTCHA',
    disablePath: 'captcha.providers.recaptcha.enabled',
    prompted: true,
    scopes: [],
  },

  // The pixel tokens beside GA4 each carry their own switch, so they never
  // gate the GA4 half: the pixel operations ask for them in place.
  analytics: {
    why: 'reconciles GA4 streams and the Firebase link via the GA Admin API',
    label: 'Google Analytics',
    disablePath: 'analytics.enabled',
    scopes: ['https://www.googleapis.com/auth/analytics.edit'],
  },

  search: {
    why: 'creates/verifies the sc-domain property and submits sitemaps via the Search Console API',
    label: 'Search Console',
    disablePath: 'search.providers.searchConsole.enabled',
    scopes: [
      'https://www.googleapis.com/auth/webmasters',
      'https://www.googleapis.com/auth/siteverification',
    ],
  },

  advertising: {
    why: 'verifies the domain is present + approved in the AdSense account (read-only API)',
    label: 'AdSense',
    // Disable must NOT land `client: false`: client is schema-typed as a
    // string, so it opts the PROVIDER out instead.
    disablePath: 'advertising.providers.adsense',
    scopes: ['https://www.googleapis.com/auth/adsense.readonly'],
  },

  monitoring: {
    why: 'creates one Sentry project per enabled target and lands the DSNs',
    label: 'Sentry',
    disablePath: 'monitoring.enabled',
    prompted: true,
    scopes: [],
  },

  campaigns: {
    why: 'reconciles domain auth, link branding, the sender, the list, unsubscribe groups, fields, segments, and the event webhook via the SendGrid API',
    label: 'SendGrid',
    disablePath: 'marketing.campaigns.enabled',
    prompted: true,
    scopes: [],
  },

  newsletter: {
    why: 'verifies publication access, fields, segments, and the webhook via the Beehiiv API',
    label: 'Beehiiv',
    disablePath: 'marketing.newsletter.enabled',
    prompted: true,
    scopes: [],
  },

  certificates: {
    why: 'reconciles Apple signing certs, bundle IDs, and provisioning profiles via App Store Connect',
    label: 'Apple signing',
    disablePath: 'certificates.enabled',
    prompted: true,
    scopes: [],
  },

  // A brand mid-setup must never be gated out of a whole manage run by a store
  // it has not registered yet: the service refuses at the moment a shipped
  // format has no credential to ship with.
  publishing: {
    why: 'collects the store API keys, the snap login and the Windows signing set the declared formats need, plus the per-listing store ids',
    label: 'Publishing',
    disablePath: 'publishing.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  // The payment service runs on whichever provider IS configured, so a
  // missing Stripe key must never gate a PayPal brand.
  payment: {
    why: 'reconciles products, prices, and webhooks on the brand payment providers',
    label: 'Payments',
    disablePath: 'payment.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  // Operator-tier credentials: the product lives in ITS OWN Firebase project,
  // so every other brand's clean skip is the sanctioned outcome.
  forms: {
    why: "manages the brand's Slapform contact form and its owner account (Slapform operator only)",
    label: 'Slapform operator access',
    disablePath: 'forms.providers.slapform.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  chat: {
    why: "manages the brand's Chatsy agent, knowledge, and owner account (Chatsy operator only)",
    label: 'Chatsy operator access',
    disablePath: 'inbound.chat.providers.chatsy.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  email: {
    why: "manages the brand's Replyify agent, filter, and owner account (Replyify operator only)",
    label: 'Replyify operator access',
    disablePath: 'inbound.email.providers.replyify.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  // A brand that calls neither AI provider must never be gated on a key it
  // will not use; the ai service asks for them in place.
  ai: {
    why: 'lets the backend call OpenAI/Anthropic (contact inference, content + newsletter generation)',
    label: 'AI providers',
    disablePath: 'ai.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },

  server: {
    why: "keeps the brand's registry entry on the company server's Firestore (company-server operators only)",
    label: 'Company server access',
    disablePath: 'server.enabled',
    prompted: true,
    gates: false,
    scopes: [],
  },
};

/**
 * Every key a service CAN ask for, with the manager's half of each ask: the
 * schema keys whose `askedWhen` names the service, plus the format table's
 * keys for the publishing service. Which of them THIS brand owes is
 * missingEnvKeys' answer, never this list's.
 *
 * @param {string} service - Service name (a REQUIRES key).
 * @param {object} [declaration] - Its REQUIRES row (default: the registry's).
 * @returns {Array<{ name: string, prompted?: true, gates?: false, disablePath?: string }>}
 */
function serviceInputs(service, declaration = REQUIRES[service]) {
  const generated = generatedEnvKeys();
  const asks = ENV_SCHEMA
    .filter((entry) => entry.name && entry.askedWhen && entry.askedWhen.services[service])
    .map((entry) => ({ name: entry.name, rule: entry.askedWhen.services[service] }));
  const ship = service === SHIP_SERVICE ? shipCredentials().map((name) => ({ name, rule: null })) : [];

  return [...asks, ...ship].map(({ name, rule }) => {
    // The narrowest switch the ask honours: a provider's own, below the row's
    const own = rule ? rule.switches[rule.switches.length - 1] : undefined;
    const perProvider = Boolean(own) && own !== declaration.disablePath;
    const optional = declaration.gates === false || Boolean(generated[name]) || perProvider;

    return {
      name,
      ...(declaration.prompted && !generated[name] ? { prompted: true } : {}),
      ...(optional ? { gates: false } : {}),
      ...(perProvider ? { disablePath: own } : {}),
    };
  });
}

/**
 * Join each input to its env-schema entry: the ONE place the manager's
 * half of an input meets the human half, so the preflight walkthrough, the
 * interactive gate and the non-interactive skip say the same label, open the
 * same page and print the same hint. An unknown name is a programmer error;
 * preflight alone passes `strict: false` (absorb, never crash).
 * @param {string} service - Service name (for the error).
 * @param {object[]} inputs - serviceInputs entries.
 * @param {object} [options] - `{ strict }`: false keeps an unknown key as it is.
 * @returns {object[]} The same entries, each with label + optional url/hint.
 * @throws {Error} When an input names a key the env schema does not declare.
 */
function describeServiceInputs(service, inputs, { strict = true } = {}) {
  return (inputs || []).map((entry) => {
    const schema = envSchemaEntry(entry.name);
    if (!schema) {
      if (strict) {
        throw new Error(`REQUIRES.${service} asks for ${entry.name}, which the env schema does not declare: add it to @omega.js/config's env-schema.js (it owns what a key is and where it is minted)`);
      }

      return { ...entry, label: entry.label || entry.name };
    }

    return {
      ...entry,
      label: schema.label || entry.name,
      ...(schema.url ? { url: schema.url } : {}),
      ...(schema.hint ? { hint: schema.hint } : {}),
    };
  });
}

/**
 * Build the setup-contract spec for a service: what
 * lib/service-input.js asks for. No call site re-spells an env name, a mint
 * URL, or an opt-out path.
 *
 * @param {string} service - Service name (a REQUIRES key).
 * @param {object} [options] - `names` narrows to those inputs (a per-provider
 *   ask), `label` and `disablePath` override the gate's (the narrowed input's
 *   own switch wins over the service's), `instructions` are shown before the
 *   gate, and `gate: false` says the caller already ran it.
 * @returns {object} The spec requestServiceInput takes; `narrowed` says the
 *   caller named its inputs, so each is a key it is about to use.
 */
function serviceInputSpec(service, options = {}) {
  const declaration = REQUIRES[service];
  if (!declaration) {
    throw new Error(`No REQUIRES entry for service "${service}": declare its gate in src/config.js`);
  }

  // Any service may name a key OMEGA mints (the webhook key): minting it before
  // the service uses it asks nobody
  const generated = Object.keys(generatedEnvKeys())
    .filter((name) => options.names && options.names.includes(name))
    .map((name) => ({ name, gates: false }));
  const all = [...serviceInputs(service, declaration), ...generated];
  const inputs = describeServiceInputs(service, options.names
    ? all.filter((entry) => options.names.includes(entry.name))
    : all);

  // A single narrowed input carrying its own opt-out path owns the gate: the
  // ask is about THAT provider, so Disable must not switch off the service.
  const ownPath = inputs.length === 1 ? inputs[0].disablePath : null;

  return {
    service,
    label: options.label || declaration.label,
    disablePath: options.disablePath || ownPath || declaration.disablePath,
    instructions: options.instructions,
    ...(options.gate === false ? { gate: false } : {}),
    ...(options.names ? { narrowed: true } : {}),
    inputs,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Replace `{ key }` placeholders (spaces allowed) in every string of an
 * object tree — omega-manager's templateObject, minus the node-powertools
 * dependency. Unknown keys are left untouched.
 *
 * @param {*} obj - Any value; strings are templated, objects/arrays recursed
 * @param {Object} data - Placeholder values (e.g. { domain: 'somiibo.com' })
 * @returns {*} - Same shape with placeholders substituted
 */
function templateObject(obj, data) {
  if (typeof obj === 'string') {
    return obj.replace(/\{\s*([\w.]+)\s*\}/g, (match, key) => {
      return key in data ? data[key] : match;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => templateObject(item, data));
  }

  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = templateObject(value, data);
    }
    return result;
  }

  return obj;
}

module.exports = {
  MANAGER_DEFAULTS,
  DEFAULTS,
  SERVICE_ORDER,
  BOOT_SERVICES,
  OPERATIONS,
  REQUIRES,
  serviceInputs,
  describeServiceInputs,
  serviceInputSpec,
  templateObject,
};
