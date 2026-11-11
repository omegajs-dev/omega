/**
 * The manager's per-service OPERATIONS: what each service runs, in order.
 * The runner (lib/service-runner.js) loads each operation's handler from the
 * service's ensure/, read/, transform/ and write/ directories by its name.
 */

const OPERATIONS = {
  workspace: [
    { name: 'structure', ensure: true },  // Root workspaces + a dir per enabled target
    { name: 'config', ensure: true },     // omega.json5 loads + validates (brand and per-target)
    { name: 'defaults', ensure: true },   // Schema-defaulted blocks the brand file lacks are materialized (#478)
    { name: 'company', ensure: true },    // The ONE key joining this brand to its company, asked when the file carries none (#677)
    { name: 'gitignore', ensure: true },  // brand + company .gitignore marker sections (state and secrets never committed)
    { name: 'scripts', ensure: true },    // Root scripts say `omega` + deploy exists; target scripts fill from framework projectScripts (#675)
    { name: 'agents', ensure: true },     // AGENTS.md manager import; the retired scope link removed
    { name: 'claude-settings', ensure: true }, // The two .claude settings files name the published or local omega plugin; the machine install is checked
    { name: 'workflows', ensure: true },  // Composed .github/workflows/<target>-*.yml for targets the config no longer enables are removed (#636)
    { name: 'env-keys', ensure: true },   // Brand-generated keys (the OMEGA_* trio + UNSUBSCRIBE_HMAC_KEY) minted into the brand .env when the cascade has none (#569)
    { name: 'env-order', ensure: true },  // Brand/company .env converged onto its Default/Custom marker sections
    { name: 'env-rules', ensure: true },  // Keys the brand's own config makes mandatory (the schema's requiredWhen) — WARNS, never fails (#626)
    { name: 'translation-sdk', ensure: true }, // Translating web targets declare + install @anthropic-ai/claude-agent-sdk (#168)
  ],

  repo: [
    { name: 'repo', ensure: true },       // The SOURCE repo `<brand.id>-omega` exists at the brand's visibility (#883)
    { name: 'website', ensure: true },    // One `<brand.id>-<name>` repo + Pages per GitHub-hosted web target (#883)
    { name: 'runners', ensure: true },    // Org runner group serves the public repo (#872: desktop + self-hosted Windows signer)
    { name: 'secrets', write: true },     // Each target's composed .env set published as the source repo's Actions secrets (#891), LAST: the repos it writes to mustexist
  ],

  edge: [
    { name: 'zone', ensure: true },                     // Zone exists (created when missing; nameservers reported when pending)
    { name: 'dns-records', ensure: true },              // Required + custom records diff-synced
    { name: 'email-routing', ensure: true },            // Cloudflare Email Routing (only when domain.email.providers names cloudflare)
    { name: 'zone-settings', ensure: true },            // Generic — diffs all /zones/{id}/settings values + addons
    { name: 'cache-rules', ensure: true },
    { name: 'rules-managed-transforms', ensure: true },
    { name: 'rules-redirect', ensure: true },
    { name: 'rules-configuration', ensure: true },
    { name: 'rules-response-headers', ensure: true },
    { name: 'rules-security', ensure: true },
    { name: 'speed-scheduled-tests', ensure: true },    // Custom Speed API endpoint
    { name: 'web-analytics', ensure: true },            // The account's RUM site for the zone (the edge-injected beacon), on or off per config
    { name: 'workers', ensure: true },                  // Worker scripts + routes (only when edge.providers.cloudflare.workers configured)
  ],

  domain: [
    { name: 'nameservers', ensure: true }, // Registrar nameservers → Cloudflare (namecheap via API, manual registrars get instructions)
  ],

  cloud: [
    { name: 'billing', ensure: true },          // Blaze plan (links cloud.billingAccount when configured)
    { name: 'services', ensure: true },         // Required Google Cloud APIs + compute deploy roles
    { name: 'project-settings', ensure: true }, // GCP display name + the 'Web App' web app
    { name: 'oauth-consent', ensure: true },    // OAuth consent screen (support email)
    { name: 'service-account', ensure: true },  // Admin SDK service account + key → .omega/secrets (the ONE home; omega build stages it)
    { name: 'hosting', ensure: true },          // Hosting site + api.{domain} custom domains (DNS via Cloudflare)
    { name: 'firestore', ensure: true },        // Firestore database + PITR
    { name: 'database', ensure: true },         // Realtime Database
    { name: 'authentication', ensure: true },   // Identity Platform + sign-in methods + authorized domains
    { name: 'storage', ensure: true },          // Default storage bucket
    { name: 'functions', ensure: true },        // Cloud Functions readiness check (read-only)
    { name: 'cloud-messaging', ensure: true },  // FCM API + VAPID key pair (from state)
    { name: 'sdk-config', ensure: true },       // Web SDK config → state + omega.json5 drift check
  ],

  captcha: [
    { name: 'site-key', ensure: true }, // Secret key proven valid via siteverify; domain list is manual guidance (no classic API)
  ],

  analytics: [
    { name: 'google-streams', ensure: true },       // One GA4 web stream per target (+ enhanced measurement + MP secret + the per-target measurement id in config)
    { name: 'google-firebase-link', ensure: true }, // GA property ↔ Firebase project link (+ auto-stream normalization)
    { name: 'meta-pixel', ensure: true },           // Pixel created on meta.accountId when missing + META_ACCESS_TOKEN presence
    { name: 'tiktok-pixel', ensure: true },         // Pixel created on tiktok.accountId when missing + TIKTOK_ACCESS_TOKEN presence
  ],

  search: [
    { name: 'property', ensure: true }, // sc-domain property exists (DNS TXT verification via Cloudflare, one-pass)
    { name: 'ga-link', ensure: true },  // GA association — no API exists; warned + URL until confirmed
    { name: 'sitemaps', ensure: true }, // Missing sitemaps submitted (existing ones are converged, not resubmitted)
  ],

  advertising: [
    { name: 'sites', ensure: true }, // Domain present in AdSense + approval state (read-only API — adding is manual)
  ],

  monitoring: [
    { name: 'projects', ensure: true }, // Org/team resolution + one Sentry project per enabled target (monitoring.providers.sentry.org written back)
    { name: 'dsn', ensure: true },      // Client-key DSNs → targets.<name>.monitoring.providers.sentry.dsn (comment-preserving writeback)
  ],

  campaigns: [
    { name: 'domain-auth', ensure: true },     // Domain authentication (DKIM CNAMEs via Cloudflare, one-pass validate)
    { name: 'link-branding', ensure: true },   // Link branding for emailurl.<domain> (create + validate, then the CNAME flips proxied)
    { name: 'sender-identity', ensure: true }, // Verified sender for Single Sends (offers@{contact domain})
    { name: 'list', ensure: true },            // The brand's marketing list (id written back to omega.json5)
    { name: 'unsubscribe-groups', ensure: true }, // The account's ASM groups, matched by name (ids written back to omega.json5)
    { name: 'custom-fields', ensure: true },   // @omega.js/backend custom fields (@omega.js/backend's marketing SSOT)
    { name: 'segments', ensure: true },        // @omega.js/backend segments (query_dsl diffed; __temp_ orphans swept)
    { name: 'event-webhook', ensure: true },   // Account-global Event Webhook → parent @omega.js/backend forwarder (min-diff PATCH)
  ],

  newsletter: [
    { name: 'publication', ensure: true },   // Publication access (config/state id, auto-match by name; creation is manual)
    { name: 'custom-fields', ensure: true }, // @omega.js/backend custom fields (@omega.js/backend's marketing SSOT, diffed by display)
    { name: 'segments', ensure: true },      // @omega.js/backend segments verified (no create API — instructions when missing)
    { name: 'webhook', ensure: true },       // Publication webhook → parent @omega.js/backend forwarder (min-diff PATCH)
  ],

  payment: [
    { name: 'paypal-account', ensure: true },     // Auth probe (live/sandbox detection) + app info
    { name: 'paypal-webhook', ensure: true },     // Webhook endpoint → brand backend (event_types diffed)
    { name: 'paypal-products', ensure: true },    // Catalog products + billing plans (config → state → name match → create)
    { name: 'stripe-account', ensure: true },     // Business profile diffed to brand config
    { name: 'stripe-radar', ensure: true },       // Radar rules guidance (no API — warned until confirmed)
    { name: 'stripe-disputes', ensure: true },    // Enhanced Dispute Protection guidance (no API — warned until confirmed)
    { name: 'stripe-webhook', ensure: true },     // Webhook endpoint → brand backend (re-enable + enabled_events diffed)
    { name: 'stripe-products', ensure: true },    // Products + prices (config → state → metadata match → create; stale prices archived)
    { name: 'chargebee-account', ensure: true },  // API access probe + site info
    { name: 'chargebee-webhook', ensure: true },  // Webhook endpoint → brand backend (&brand= URL; events set on create only)
    { name: 'chargebee-products', ensure: true }, // Item family → items → item prices (deterministic IDs; legacy plans reported)
  ],

  forms: [
    { name: 'form', ensure: true }, // Form name + enabled diffed against Slapform Firestore
    { name: 'user', ensure: true }, // Form-owner account set to forms.providers.slapform.plan (internal comp)
  ],

  chat: [
    { name: 'chat', ensure: true }, // Agent settings + knowledge diffed against Chatsy Firestore
    { name: 'user', ensure: true }, // Agent-owner account set to inbound.chat.providers.chatsy.plan (internal comp)
  ],

  email: [
    { name: 'agent', ensure: true }, // Agent filter + knowledge diffed against Replyify Firestore
    { name: 'user', ensure: true },  // Agent-owner account set to inbound.email.providers.replyify.plan (internal comp)
  ],

  server: [
    { name: 'brands', ensure: true }, // Registry entry replace-synced against the company server's Firestore
  ],

  directory: [
    { name: 'entry', ensure: true }, // Directory entry (identity + declared blocks) merge-synced into the parent project's brands collection
  ],

  assets: [
    { name: 'logo-gen', ensure: true },     // Wordmark + combomark from brandmark + brand.font (missing-only)
    { name: 'process', write: true },       // Color/black SVG variants + PNG size ladders per logo source
    { name: 'templates', write: true },     // Brand PSDs seeded from the company + logo/text layers refreshed + PNG exports
    { name: 'icons', write: true },         // macOS .icns + Windows .ico app icons (composited icon.png when the templates op made one)
    { name: 'social-icons', write: true },  // Brandmark-on-white social profile icons
    { name: 'favicons', write: true },      // Web favicon set + site.webmanifest
    { name: 'reconcile', write: true },     // Derived files the brand's current sources no longer name are deleted (#636)
  ],

  certificates: [
    { name: 'api-key', ensure: true },      // App Store Connect creds resolved + client ready
    { name: 'certificates', ensure: true }, // Signing certs — download or create via CSR, export .p12, keychain import
    { name: 'bundle-ids', ensure: true },   // Brand bundle ID exists with the required capabilities
    { name: 'profiles', ensure: true },     // Provisioning profiles per platform × cert type
  ],

  publishing: [
    { name: 'keys', ensure: true },     // Every developer key the declared formats need, asked through the shared setup contract (#867)
    { name: 'listings', ensure: true }, // The per-listing store ids a human creates (config, #893), asked with a "not yet" skip
    { name: 'snap-name', ensure: true }, // The Snap Store name brand.id, registered once when the brand ships the snap
  ],

  ai: [
    { name: 'keys', ensure: true },  // The provider API keys, asked once through the shared setup contract (#639)
  ],

  // Registered with NOTHING to do ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)):
  // the `certs` copy is gone (signing material is read IN PLACE from the
  // signing tree), and Ian kept the service itself, for the next thing that
  // genuinely cannot ride the config hierarchy.
  disperse: [],

  seo: [
    { name: 'github-repos', ensure: true }, // Parasite SEO repos exist + match their template
  ],

  update: [
    { name: 'targets', write: true },     // Installs deps, builds every target
  ],

  account: [
    { name: 'users', ensure: true },      // Auth accounts exist + passwords/admin roles converged + admin audit
  ],

  migrations: [
    { name: 'targets-rename', ensure: true, local: true }, // #443: the brand's apps/ → targets/, workspaces glob following (runs ALONE — see manage.js)
    { name: 'platform-names', ensure: true, local: true }, // #867: the brand's own `platforms.win` → `platforms.windows`, `linux.snap` → `linux.formats.snap`, config/icons/macos/ → mac/
    { name: 'notifications', ensure: true }, // uid→owner + metadata/context/attribution + validate schema
    { name: 'users', ensure: true },         // plan→subscription + @omega.js/backend-schema backfill + orphan cleanup + validate
    { name: 'orders', ensure: true },        // payments-orders: legacy attribution.utm blob → first/last touches
    { name: 'payments-intents', ensure: true }, // payments-intents: legacy attribution.utm blob → first/last touches
    { name: 'payment-provider', ensure: true }, // #428 word rename: the stored `processor` field → `provider`, across all five payment collections
    { name: 'state-retirement', ensure: true, local: true }, // #434: the retired .omega/state.json content → config/omega.json5 + .env; the file's machine records stay (#479)
  ],

  bookmark: [
    { name: 'sync', ensure: true },       // Push brand console/dashboard bookmarks to the OMEGA Companion extension
  ],

  testing: [
    { name: 'target-checks', ensure: true }, // Per-target local checks (build output, backend files, framework version) + live checks (homepage, API health, GitHub Actions)
  ],
};

module.exports = { OPERATIONS };
