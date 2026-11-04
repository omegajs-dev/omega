/**
 * Captcha service (`captcha.providers.recaptcha`) — validates the brand's
 * OWN classic reCAPTCHA keys (de-ITW: every brand mints its own key in its
 * own GCP project — never a company-shared key; interactive runs ASK for the
 * keys via the cp114 paste flow, pointing at the GCP reCAPTCHA console).
 *
 * Classic reCAPTCHA has no key-management API, so the key's domain list
 * can't be reconciled; this service proves what it can (the secret key
 * in .env is valid, via the documented siteverify endpoint) and prints the
 * console link + domains for the manual half. Interactive runs open the
 * console and confirm the domain list once, stamping config (#434).
 *
 * It also owns the ORPHAN-SECRET warning (#507): the secret in .env without
 * `captcha.providers.recaptcha.siteKey` in config — see the guard below. The
 * reverse direction is the env schema's shared `requiredWhen` rule (#626).
 *
 * Auth: the SITE key is config (`captcha.providers.recaptcha.siteKey`), because
 * every page that carries a form renders it: it is public by definition, so it
 * is asked for through the config flow and landed in omega.json5
 * ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)). The SECRET key
 * is RECAPTCHA_SECRET_KEY in the brand .env, asked for through the env flow.
 * Missing either → interactive runs ask; non-interactive runs skip with guidance.
 */
const chalk = require('chalk').default;
const { defaultAddressReason } = require('@omega.js/config');

const { serviceInputSpec } = require('../../config.js');
const { createServiceRunner } = require('../../lib/service-runner.js');
const { requestServiceInput } = require('../../lib/service-input.js');
const { resolveConfigValue } = require('../../lib/config-flow.js');
const { RecaptchaAPI } = require('./lib/recaptcha-api.js');
const { recaptchaConsoleUrl } = require('./lib/console-url.js');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const recaptchaConfig = context.brandConfig.captcha?.providers?.recaptcha || {};

    if (recaptchaConfig.enabled === false) {
      return { skip: true, reason: 'captcha.providers.recaptcha.enabled = false' };
    }

    // Read before the site-key ask: a brand with no domain has no key to register
    const url = (context.brandConfig.brand?.url || '').replace(/^https?:\/\//, '');
    if (!url) {
      return { skip: true, reason: 'no brand.url configured' };
    }

    const pagesReason = defaultAddressReason(url);
    if (pagesReason) return { skip: true, reason: pagesReason };

    // The site key's ONE home is config (#893), so a missing one is ASKED for
    // right here through the config flow, which lands it in omega.json5 and
    // patches the in-memory config so the rest of this run sees it. A run that
    // cannot prompt gets null back and falls through to the warning below.
    const configuredSiteKey = await resolveConfigValue(context, {
      path: 'captcha.providers.recaptcha.siteKey',
      label: 'reCAPTCHA site key',
      disablePath: 'captcha.providers.recaptcha.enabled',
      instructions: [
        "Create a CLASSIC reCAPTCHA key in the brand's OWN GCP project (never a shared company key),",
        'then paste the SITE key here. The secret half stays in the brand .env.',
      ],
      entry: {
        url: recaptchaConsoleUrl(context.brandConfig, null),
        message: 'reCAPTCHA site key (the public half):',
      },
    });

    // The ORPHAN SECRET half (#507): RECAPTCHA_SECRET_KEY set with no
    // captcha.providers.recaptcha.siteKey in config is a silent 403 on every
    // protected POST, because the backend enforces verification the moment the
    // secret exists and the client has no key to mint a token with (the
    // playground's live checkout, 2026-08-22). This service is the ONE place
    // that sees both halves, so it still says this direction out loud whenever
    // nobody could be asked for the key above.
    //
    // The REVERSE direction (a site key requiring its secret) is the env
    // schema's `requiredWhen` rule now
    // ([#626](https://github.com/Omega-JS-Stack/omega/issues/626)): warned
    // brand-wide by the workspace env-rules op, and refused by a production
    // backend boot. Neither half = the sanctioned unkeyed brand (#17), which
    // stays green and skips below.
    const configuredSecret = process.env.RECAPTCHA_SECRET_KEY || null;
    if (configuredSecret && !configuredSiteKey) {
      console.log(`      ${chalk.yellow('⚠')} RECAPTCHA_SECRET_KEY is set but captcha.providers.recaptcha.siteKey is missing from config — the client sends an empty token and every protected POST 403s. Paste the site key into config/omega.json5: ${recaptchaConsoleUrl(context.brandConfig, configuredSiteKey)}`);
    }

    // De-ITW: the ask points at the GCP reCAPTCHA console (the brand's OWN
    // project) via the registry entries — the paste flow is the ONLY path to
    // a key; no default value exists anywhere. The registry carries the SECRET
    // half only: the public site key is config, asked for above (#893).
    const gate = await requestServiceInput(context, serviceInputSpec('captcha'));
    if (gate) return gate;
    const siteKey = configuredSiteKey;
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;

    // Tests inject a fake client via context.recaptchaApi
    return {
      recaptchaApi: context.recaptchaApi || new RecaptchaAPI({ secretKey }),
      siteKey,
      domain: url,
    };
  },
});
