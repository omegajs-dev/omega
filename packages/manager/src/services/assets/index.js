/**
 * Assets service: the brand's derived visual collateral generated from its
 * logo sources: wordmark/combomark SVGs, color/black variants + PNG size
 * ladders, PSD template exports, macOS/Windows app icons and social profile
 * icons. A target's build derives its own brand image (devkit's brand-image).
 *
 * Sources are committed at `assets/logo/*.svg` and `assets/templates/*.psd`;
 * derived files land in the gitignored `.omega/assets/`. Every operation is
 * mtime-diffed, and `--reset-assets` clears the cache first (lib/reset.js).
 * A missing brandmark is generated through MrLogo when a credential resolves
 * (lib/brandmark-api.js), else the service skips with guidance.
 */
const { join } = require('node:path');
const chalk = require('chalk').default;
const { createServiceRunner } = require('../../lib/service-runner.js');
const { input } = require('@omega.js/devkit/prompt');
const { withSpinner } = require('@omega.js/devkit/flows');
const { resolveLogoAuth, generateBrandmark, MRLOGO_URL } = require('./lib/brandmark-api.js');
const { resolveResetKinds, resetAssetsCache } = require('./lib/reset.js');
const { canPrompt } = require('../../lib/run-gates.js');
const { MINT_ROOT, LOGO_SOURCES_DIR, BRANDMARK_SOURCE, hasLogoSources } = require('@omega.js/config');

module.exports.run = createServiceRunner({
  serviceDir: __dirname,
  setup: async (context) => {
    const config = context.brandConfig.assets;

    if (config === false || config?.enabled === false) {
      return { skip: true, reason: 'assets.enabled = false' };
    }

    const logoDir = join(context.brandRoot, LOGO_SOURCES_DIR);
    const brandmarkPath = join(context.brandRoot, BRANDMARK_SOURCE);

    // The brandmark is the root of every derived asset — when the brand has
    // none and MrLogo credentials resolve (the product-service ladder:
    // operator SA → api key → pasted ID token; setting a credential IS the
    // consent to spend the API call), generate it. Interactive runs ask for
    // optional art direction. Dry runs never mint.
    if (!hasLogoSources(context.brandRoot)) {
      if (!context.options?.dryRun) {
        try {
          const auth = await resolveLogoAuth({
            brandConfig: context.brandConfig,
            brandRoot: context.brandRoot,
            db: context.mrlogoDb,
            authAdmin: context.mrlogoAuthAdmin,
            log: (line) => console.log(`    ${line}`),
          });

          if (auth) {
            const direction = canPrompt(context.options)
              ? (await input({ message: 'Logo prompt (press Enter to skip):', default: '' })).trim()
              : '';
            await withSpinner('Generating brandmark via MrLogo', () =>
              generateBrandmark({ brandConfig: context.brandConfig, brandmarkPath, direction, token: auth.token }));
          }
        } catch (error) {
          console.log(`    ${chalk.yellow('⚠')} Brandmark generation failed${chalk.dim(`: ${error.message}`)}`);
        }
      }

      if (!hasLogoSources(context.brandRoot)) {
        return { skip: true, reason: `no ${BRANDMARK_SOURCE} in the brand repo (add the brand's logo source, set MRLOGO_SERVICE_ACCOUNT / MRLOGO_API_KEY / LOGO_API_ID_TOKEN in the brand .env for AI generation, or make one at ${MRLOGO_URL})` };
      }
    }

    const outDir = join(context.brandRoot, MINT_ROOT);

    // The force refresh (#214): clear the asked kinds before the operations
    // run, so the mtime gate below sees them missing and rebuilds them. Loud
    // by design, because this is the one thing the service destroys and an
    // operator who typed the flag by accident has to see what went.
    const resetKinds = resolveResetKinds(context.options?.resetAssets);
    if (resetKinds.length > 0) {
      const dryRun = context.options?.dryRun || false;
      const { removed } = resetAssetsCache({ outDir, kinds: resetKinds, dryRun });
      const what = `${chalk.bold(resetKinds.join(' + '))} ${chalk.dim(`(${removed.length} path${removed.length === 1 ? '' : 's'} under ${MINT_ROOT}/)`)}`;

      console.log(dryRun
        ? `    ${chalk.yellow('[DRY RUN]')} Would reset ${what}`
        : `    ${chalk.yellow('↺')} Reset ${what}; regenerating below`);
    }

    return {
      logoDir,
      brandmarkPath,
      outDir,
    };
  },
});
