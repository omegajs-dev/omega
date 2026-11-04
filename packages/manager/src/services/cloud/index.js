/**
 * Cloud service (Firebase provider) — reconciles the brand's Firebase/GCP project to
 * `cloud: {}` in omega.json5: Blaze billing, required Google Cloud APIs,
 * project identity, OAuth consent screen, Admin SDK service account + key,
 * Hosting api.{domain} custom domains (DNS via Cloudflare), Firestore (+PITR),
 * Realtime Database, Authentication (Identity Platform + sign-in methods),
 * Storage, Cloud Functions readiness, Cloud Messaging, and the web SDK config.
 *
 * Auth: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in the brand .env (OAuth2;
 * tokens cache to .omega/auth/google-tokens.json — the first run prints an
 * auth URL). Missing credentials go through the shared setup contract (#608):
 * an interactive run asks for them right here, a headless one steps aside
 * loudly. No cloud.config.projectId → interactive runs offer the project
 * selection/creation flow (lib/project-flow.js, lands the id in omega.json5);
 * otherwise skip with guidance.
 *
 * `cloud.shared: true` (project shared by multiple brands) filters to the
 * per-brand operations only (service-account, sdk-config) so one brand never
 * rewrites a shared project's settings.
 */
const { googleTokenStorePath } = require('../../lib/google-auth.js');
const { ensureProjectAccess } = require('./lib/access-heal.js');
const { isDemoProject, defaultAddressReason } = require('@omega.js/config');
const chalk = require('chalk').default;
const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { resolveConfigValue, isAuthored } = require('../../lib/config-flow.js');
const { CloudflareAPI } = require('../edge/lib/cloudflare-api.js');
const { getApexDomain } = require('../../lib/domain-utils.js');
const { FirebaseAPI } = require('./lib/firebase-api.js');
const { resolveFirebaseProject } = require('./lib/project-flow.js');

// Operations that stay on for shared projects (per-brand, not project-level)
const SHARED_OPERATIONS = new Set(['service-account', 'sdk-config']);

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const cloud = context.brandConfig.cloud || {};

    if (cloud.enabled === false) {
      return { skip: true, reason: 'cloud.enabled = false' };
    }

    // Hostname-only (cp268): this value feeds authDomain + api.{domain}: a
    // brand.url carrying a path or port must never leak them into either.
    // Read before the credential ask: a brand with no domain has no use for one.
    const brandUrl = context.brandConfig.brand?.url;
    const domain = brandUrl ? new URL(brandUrl).hostname : '';
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(brandUrl);
    if (pagesReason) return { skip: true, reason: pagesReason };

    // The shared setup contract (#608): an interactive run asks for the
    // Google OAuth client right here — provide, skip this run, or disable the
    // service for good — before anything decides there is nothing to do.
    let gate = null;
    if (!context.firebaseApi) {
      gate = await requestServiceInput(context, serviceInputSpec('cloud'));
    }
    const haveCreds = Boolean(
      context.firebaseApi
      || (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    );

    // Tests inject fake clients via context.firebaseApi / context.cloudflareApi.
    // Cloudflare is only needed by the hosting operation (custom-domain DNS);
    // without a token the operation reports the required records instead.
    const makeApi = () => context.firebaseApi || new FirebaseAPI({
      tokenStorePath: googleTokenStorePath(context.brandRoot),
    });

    // ONE home (#23): cloud.config.projectId, where the framework flow
    // (setup/dev) already names the project. Missing → offer the interactive
    // selection/creation flow (lands it in omega.json5); needs credentials
    let projectId = cloud.config?.projectId;
    if (!projectId && haveCreds) {
      projectId = await resolveFirebaseProject(context, makeApi());
    }
    if (!projectId) {
      return { skip: true, reason: 'no cloud.config.projectId configured (rerun interactively to select/create the project)' };
    }

    // demo-* = emulator-only by Firebase's own convention: no real GCP
    // project exists to reconcile (found live 2026-07-19 — the omega brand's
    // offline demo-omega id sent the ensure at real Google APIs → 403,
    // killing the whole manage boot).
    if (isDemoProject(projectId)) {
      return { skip: true, reason: `${projectId} is a demo-* (emulator-only) project — no real cloud to reconcile` };
    }

    if (!haveCreds) {
      return gate || { skip: true, reason: 'no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET configured (set them in the brand .env)' };
    }

    const firebaseApi = makeApi();

    // The identity seam self-heals HERE, before any op runs (Ian
    // 2026-07-19: wrapped in `npm start`, never a hand-run command): a
    // manage identity with no role on the project gets granted owner via a
    // local gcloud account that can, and the run proceeds normally.
    // Idempotent — an accessible project is one probe and done.
    const access = await ensureProjectAccess({
      firebaseApi,
      projectId,
      ...(context.gcloudExec ? { exec: context.gcloudExec, delayMs: 0 } : {}),
    });
    if (access.healed) {
      console.log(`    ${chalk.green('✓')} Access healed — ${chalk.cyan(access.grantor)} granted ${chalk.cyan(access.manageEmail)} ${chalk.cyan(access.roles.join(' + '))} on ${chalk.cyan(projectId)}`);
    }

    // The schema's `false` default is no answer, so a brand that never wrote
    // the key is asked once and the answer lands either way
    await resolveConfigValue(context, {
      path: 'cloud.shared',
      label: 'Shared Firebase project',
      gate: false,
      message: `Is ${projectId} shared with another brand?`,
      present: (shared) => shared === true || isAuthored(context, 'cloud.shared'),
      choices: () => [false, true],
      getName: (shared) => (shared ? 'Yes, only per-brand operations run' : 'No, this brand owns it'),
      defaultValue: false,
    });

    const shared = cloud.shared === true;
    console.log(`    Project: ${chalk.cyan(projectId)}${shared ? chalk.dim(' (shared)') : ''}`);
    const cloudflareApi = context.cloudflareApi
      || (process.env.CLOUDFLARE_TOKEN ? new CloudflareAPI() : null);

    const apexDomain = getApexDomain(domain);

    return {
      firebaseApi,
      cloudflareApi,
      projectId,
      domain,
      apexDomain,
      isSubdomainProject: domain !== apexDomain,
      operations: shared
        ? context.operations.filter((op) => SHARED_OPERATIONS.has(op.name))
        : context.operations,
    };
  },
});
