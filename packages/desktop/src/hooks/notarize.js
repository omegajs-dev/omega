// Real macOS notarization implementation. Lives inside @omega.js/desktop — consumers can extend it via
// hooks/notarize/post.js (called after this completes successfully).
//
// Uses Apple's notarytool with the App Store Connect API key. Legacy Apple ID + app-specific
// password flow is deliberately NOT supported.
//
// Required env vars:
//   APPLE_API_KEY     — path to AuthKey_XXXXXXXXXX.p8 (set by @omega.js/desktop CI workflow from base64-encoded secret)
//   APPLE_API_KEY_ID  — 10-char Key ID (matches the XXXXXXXXXX in the filename)
//   APPLE_API_ISSUER  — issuer UUID from App Store Connect → Users and Access → Keys
//
// Skipped ONLY when building for a non-darwin platform. Every other state is a
// THROW ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)): a mac
// build that reaches this hook is a mac build this framework ships, and a build
// that cannot be signed and notarized must not become a release.
//   - missing APPLE_API_KEY / _ID / _ISSUER: nothing can notarize it
//   - no Developer ID signature (#872): electron-builder SKIPS signing when it
//     finds no identity and leaves an ad-hoc signature behind, which notarytool
//     rejects ("Failed to codesign your application"). That state used to warn
//     and carry on, and the release published an app Gatekeeper refuses on every
//     other Mac.
//
// After notarization the ticket is STAPLED and the result PROVED (stapler
// validate + spctl --assess): the hook returns only when the .app on disk is
// one a user's Mac will open offline. The DMG gets the same treatment in its
// own hook (notarize-artifacts.js, artifactBuildCompleted), because the ticket
// stapled to the app inside an image is not stapled to the image.

const path = require('path');
const fs   = require('fs');
const { execute } = require('node-powertools');
const Logger = require('@omega.js/devkit/logger');
const { stapleAndProve, toolRunner } = require('./lib/notarize-tools.js');

const logger = new Logger('notarize');

module.exports = async function notarize(context, { run = toolRunner() } = {}) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appleApiKey    = process.env.APPLE_API_KEY;
  const appleApiKeyId  = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;

  if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
    throw new Error('[notarize] APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are required to notarize a mac build. Run `omega deploy` (its precheck pushes them for CI) or set them in the target .env.');
  }

  const apiKeyPath = path.isAbsolute(appleApiKey)
    ? appleApiKey
    : path.resolve(process.cwd(), appleApiKey);

  if (!fs.existsSync(apiKeyPath)) {
    throw new Error(`[notarize] APPLE_API_KEY file not found at ${apiKeyPath}`);
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // Notarization verifies a Developer ID signature; an ad-hoc one (what
  // electron-builder leaves when it finds no identity) fails the submission
  // instead ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)).
  if (!isDeveloperIdSigned(await readCodesign(appPath, run))) {
    throw new Error(`[notarize] ${appName}.app is NOT Developer ID signed, so it cannot be notarized and every other Mac would refuse it. Set CSC_LINK + CSC_KEY_PASSWORD (or install a Developer ID Application identity) and build again.`);
  }

  const { notarize } = require('@electron/notarize');

  logger.log(`Notarizing ${appName} via App Store Connect API key (${appleApiKeyId})...`);
  const start = Date.now();

  await notarize({
    tool:          'notarytool',
    appPath,
    appleApiKey:   apiKeyPath,
    appleApiKeyId,
    appleApiIssuer,
  });

  const duration = Math.round((Date.now() - start) / 1000);
  logger.log(`Notarized in ${duration}s.`);

  // The ticket, stapled and PROVED: a notarized app whose ticket never landed
  // still fails on a Mac that is offline when the user opens it (#891).
  await stapleAndProve({ filePath: appPath, kind: 'app', run });
  logger.log(`Stapled and verified: stapler validate + spctl --assess both accept ${appName}.app.`);

  // After @omega.js/desktop's real notarization, optionally invoke the consumer's hooks/notarize/post.js as
  // an extension point. The consumer hook can do post-notarize work (custom stapling,
  // archiving, notifications, etc.). It is purely additive — @omega.js/desktop's real notarize always runs
  // first.
  const { runConsumerHook } = require('@omega.js/devkit/run-consumer-hook');
  await runConsumerHook('notarize/post', context);
};

// Pure: does codesign's own report describe a REAL Developer ID signature? An
// unsigned app has no report at all and an ad-hoc one ("Signature=adhoc",
// "TeamIdentifier=not set") carries no Authority line, so the one line
// notarization actually depends on is the one that is read.
function isDeveloperIdSigned(codesignOutput) {
  return /^Authority=Developer ID Application/m.test(String(codesignOutput || ''));
}

// codesign writes its report to STDERR and exits non-zero for an unsigned app,
// so the report is folded into stdout and a failure is read as the answer it is.
async function readCodesign(appPath, exec) {
  const run = exec || ((cmd) => execute(cmd, { log: false }));

  try {
    return String(await run(`codesign -dv --verbose=2 "${appPath}" 2>&1`) || '');
  } catch (e) {
    return String(e.message || '');
  }
}

// Exported for tests.
module.exports.isDeveloperIdSigned = isDeveloperIdSigned;
module.exports.readCodesign = readCodesign;
