/**
 * `omega deploy` — the uniform explicit publish verb (D13). Desktop's real
 * flow lives in `omega release` (workflow_dispatch + live CI log streaming +
 * GitHub-release artifacts); this verb exists so every target deploys the
 * same way. --dry-run prints the exact dispatch release would send, without
 * sending it; anything else delegates to release.
 *
 * Every run starts with the local scaffold the retired `omega setup` used to
 * own (ensureTarget, #675). A DISPATCH then runs setup's NETWORK half as a
 * precheck: framework freshness, cert validation, repo provisioning, secret
 * publication. `--no-secrets` skips that precheck, and `--direct` never
 * reaches it at all.
 *
 * `--direct` is the direct lane, asked for by a human
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)): `omega publish
 * --local` for THIS machine's platform. It used to select itself whenever the
 * tree was linked, which took the CI lane away from the brands that need it
 * most; a linked brand now packs its frameworks into the snapshot instead.
 */
const path = require('node:path');
const build = require('../build.js');
const logger = build.logger('deploy');
const attachLogFile = require('../utils/attach-log-file.js');
const { assertBrandVersion } = require('@omega.js/devkit/brand-version');
const { targetNameFromDir } = require('@omega.js/config');
const { ensureTarget } = require('./lib/ensure-target.js');
const { deployPrecheck } = require('./lib/deploy-precheck.js');
const { desktopPlatform } = require('../utils/platform.js');
const { runConsumerHook } = require('@omega.js/devkit/run-consumer-hook');

module.exports = async function (options) {
  options = options || {};
  const dryRun = options.dryRun || options['dry-run'];
  const projectDir = process.cwd();

  // The whole verb goes to the target's own deploy log, from its first line
  // ([#873](https://github.com/Omega-JS-Stack/omega/issues/873)): the scaffold,
  // the precheck's refusals and the followed run all land in one file instead
  // of scrollback. `omega release` attaches the same path, which is a no-op
  // when this verb already did, and tees STACK, so a brand fan-out's log gets
  // the same lines.
  attachLogFile(path.join(projectDir, 'logs', 'deploy.log'));

  // The local half of the retired `omega setup` (#675). Idempotent and quiet on
  // a converged target. Nothing COPIES signing material any more: the tree is
  // read in place and the env load derived the paths to it
  // ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)).
  await ensureTarget({ projectDir, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  // The brand's ONE version ([#869](https://github.com/Omega-JS-Stack/omega/issues/869)):
  // a target whose version drifted from the brand root's is refused here, before
  // the precheck, because a drifted target must not push its secrets and
  // dispatch a build of the wrong number. A read, so every lane reaches it
  // (`--direct` and `--dry-run` included).
  assertBrandVersion({ dir: projectDir });

  // The consumer's pre-deploy hook, on BOTH lanes and before anything is
  // published or published to ([#899](https://github.com/Omega-JS-Stack/omega/issues/899)):
  // the playground's prunes its release family down to the newest one.
  // A dry run skips it, because a hook may act on the world and a dry run
  // promises to send nothing.
  if (dryRun) {
    logger.log('DRY RUN, skipping hook "deploy/pre"');
  } else {
    // The one ctx shape every OMEGA hook takes, `{ build, projectRoot, mode }`,
    // and a deploy's mode is PRODUCTION: what it is about to publish is a release.
    await runConsumerHook('deploy/pre', { build, projectRoot: projectDir, mode: 'production' });
  }

  // The direct lane: build + sign + publish from THIS machine, for this
  // machine's platform. A cross-platform build needs the runners CI has, so a
  // `--platforms` naming anything else is refused rather than silently built
  // for the host (#872).
  //
  // BEFORE the precheck, which belongs to the CI lane (web and backend already
  // order it this way): a local deploy publishes nothing to the repo and needs
  // no `gh` session, so pushing this target's signing certs into Actions
  // secrets on the way past is exactly what it must not do (#872).
  if (options.direct) {
    const platform = directPlatform(options.platforms || options.platform);

    if (dryRun) {
      logger.log(`DRY RUN, would run: omega publish --local (${platform}, this machine)`);
      return;
    }

    logger.log(`Building + publishing LOCALLY for ${platform} (signing credentials must be available on this machine)...`);
    await require('./publish.js')({ ...options, local: true });
    require('@omega.js/devkit/deploy-record').recordDeploy({ dir: process.cwd(), target: targetNameFromDir(process.cwd()) || 'desktop', detail: { method: 'direct' } });
    return logger.log(`Deployed from the LOCAL publish (${platform}).`);
  }

  // The NETWORK half, as a precheck: the CI lane needs the remote side right
  // (its secrets, its repos). A DRY RUN runs it too
  // ([#895](https://github.com/Omega-JS-Stack/omega/issues/895)): every step is
  // a read or a plan under `dryRun`, so the preview is the real one, refusals
  // included.
  await deployPrecheck({ projectDir, options, logger, dryRun });

  // The dispatch lane, dry or not, is `omega release`: ONE call site on this
  // target, so the previewed plan is the very one a real run sends, with the
  // ref and the snapshot sha threaded exactly the same way. The preview used to
  // build a second `deployViaDispatch` call here, which named neither.
  return require('./release.js')(options);
};

// What a `--platforms` value may say for each host, in OMEGA's own vocabulary
// (#867): the platform NAME comes from the one translation point, and these are
// the spellings the flag accepts for it. The workflow's `platforms` input speaks
// the same three words.
const HOST_PLATFORMS = {
  mac: { accepts: ['mac'] },
  windows: { accepts: ['windows'] },
  linux: { accepts: ['linux'] },
};

/**
 * The platform a `--direct` deploy builds: this machine's, and only this
 * machine's. Electron cross-building (a signed Windows installer from a mac, a
 * DMG from linux) is what the CI matrix exists for, so a `--platforms` naming
 * anything but the host is an ERROR: building the host's platform instead
 * would publish an artifact nobody asked for.
 *
 * @param {string} [platforms] - The `--platforms`/`--platform` value ('all', 'mac,linux', …).
 * @param {string} [platform] - The host platform (defaults to process.platform).
 * @returns {string} The host platform's workflow name ('mac' | 'windows' | 'linux').
 * @throws {Error} When `platforms` names anything the host cannot build.
 */
function directPlatform(platforms, platform) {
  const name = desktopPlatform(platform || process.platform);
  const host = name && HOST_PLATFORMS[name];

  if (!host) {
    throw new Error(`Unsupported host platform for \`omega deploy --direct\`: ${platform || process.platform}. Dispatch the CI build instead (\`omega deploy\`).`);
  }

  const asked = String(platforms || name).toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
  const foreign = asked.filter((value) => !host.accepts.includes(value));

  if (foreign.length > 0) {
    throw new Error(`\`omega deploy --direct\` builds on THIS machine, so it can only build ${name}: ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} CI-only. Run \`omega deploy\` (no --direct) to build every platform on the runners.`);
  }

  return name;
}

module.exports.directPlatform = directPlatform;
