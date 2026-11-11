/**
 * Account service — required accounts exist in the brand's Firebase Auth
 * with the expected (derived) passwords, carry the admin role + highest
 * plan on their Firestore user doc, and no one else holds the admin role.
 * Runs after update (deploy) because signup/marketing calls hit the live
 * brand backend.
 *
 * De-ITW'd from omega-manager: the account list was the hardcoded company
 * ADMIN_EMAILS in config.js (personal Gmail addresses) — the port reads
 * account.admins from config, defaulting to support@{domain} only (a
 * company's own list lives in its company omega.json5 and replaces the
 * default whole). The password formula was a company-specific scheme in
 * code — passwords now resolve per account through the owner channels
 * (OMEGA_ACCOUNT_PASSWORD__* env var → config/hooks/account/password.js →
 * lazy ACCOUNT_PASSWORD_SEED derivation; see lib/resolve-password.js).
 * firebase-admin is replaced by the Identity Toolkit REST API +
 * FirestoreREST over the brand's own service account.
 */
const { join } = require('node:path');
const jetpack = require('fs-jetpack');
const { hasTargetOfType, defaultAddressReason, apiAddress } = require('@omega.js/config');
const { SERVICE_ACCOUNT_REL } = require('@omega.js/devkit/service-account');

const { createServiceRunner } = require('../../lib/service-runner.js');
const { FirestoreREST, loadServiceAccount } = require('../../lib/firestore-rest.js');
const { createAuthAdmin } = require('../../lib/auth-admin.js');
const { createBackendClient } = require('./lib/backend-client.js');
const { createPasswordResolver } = require('./lib/resolve-password.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: (context) => {
    const config = context.brandConfig.account;

    if (config === false || config?.enabled === false) {
      return { skip: true, reason: 'account.enabled = false' };
    }

    if (!hasTargetOfType(context.brandConfig, 'backend')) {
      return { skip: true, reason: 'no backend target' };
    }

    // Shared Firebase project — the owning brand manages accounts
    if (context.brandConfig.cloud?.shared === true) {
      return { skip: true, reason: 'shared Firebase project' };
    }

    const domain = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(domain);
    if (pagesReason) return { skip: true, reason: pagesReason };

    // Resolve {domain} templates in the configured admin list
    const admins = (config?.admins || []).map((entry) => ({
      ...entry,
      email: entry.email.replace(/\{\s*domain\s*\}/g, domain),
    }));
    if (admins.length === 0) {
      return { skip: true, reason: 'no account.admins configured' };
    }

    // Firebase web API key from config (the cloud service lands it there) —
    // without it, password verification and backend calls degrade (handled
    // per-operation)
    const apiKey = context.brandConfig.cloud?.config?.apiKey || null;
    const apiBaseUrl = apiAddress(context.brandConfig.brand.url, context.brandConfig.cloud?.config?.projectId);

    // Tests inject fakes via context
    let authAdmin = context.authAdmin;
    let firestore = context.firestore;
    let accountBackend = context.accountBackend;
    if (!authAdmin) {
      if (!jetpack.exists(join(context.brandRoot, SERVICE_ACCOUNT_REL))) {
        return { skip: true, reason: `no service account at ${SERVICE_ACCOUNT_REL} (run the cloud service first)` };
      }

      const serviceAccount = loadServiceAccount(SERVICE_ACCOUNT_REL, context.brandRoot);
      authAdmin = createAuthAdmin(serviceAccount);
      firestore = new FirestoreREST(serviceAccount);
      accountBackend = createBackendClient({ authAdmin, apiKey, apiBaseUrl });
    }

    // Lazy channels: nothing (hook load, seed generation) happens until an
    // account actually needs a password — a skipped or fully env/hook-covered
    // brand never grows a seed in its .env
    const dryRun = context.options?.dryRun || false;
    const resolvePassword = createPasswordResolver({
      brandRoot: context.brandRoot,
      domain,
      brand: context.brandConfig.brand,
      dryRun,
    });

    return { authAdmin, firestore, accountBackend, admins, domain, apiKey, resolvePassword };
  },
});
