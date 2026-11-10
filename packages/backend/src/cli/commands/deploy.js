/**
 * `omega deploy`: the explicit publish verb, on the ONE lane every target
 * takes ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)).
 *
 * The DEFAULT is a dispatch of the brand's composed backend workflow: the
 * executor delivers the brand to its repo (packed + snapshot-pushed when the
 * brand is nested or linked, committed + pushed when it is neither), waits for
 * the workflow, and dispatches it. The runner then runs THIS verb with
 * `--direct`, which is the whole local behavior: license verdict, stage,
 * local-package staging, `firebase deploy`, public-invoker IAM.
 *
 * The precheck is the sibling frameworks' (#675): the target's composed .env
 * keys are published as repo Actions secrets, because the runner has no .env
 * of its own to read. `--no-secrets` opts out.
 */
const BaseCommand = require('./base-command');
const chalk = require('chalk').default;
const powertools = require('node-powertools');
const attachLogFile = require('../utils/attach-log-file');
const { stageLocalPackages } = require('@omega.js/devkit/pack-local');
const { isCI } = require('@omega.js/devkit/ci');
const path = require('path');
const jetpack = require('fs-jetpack');
const { refuseWhenCustom, refuseWhenToolsMissing } = require('../utils/project-type');
const { loadConfig, loadEnv, targetNameFromDir, FUNCTIONS_REGION } = require('@omega.js/config');
const { resolveLicenseStamp } = require('@omega.js/devkit/license');
const { deployViaDispatch, dispatchTarget, laneLabel, resolveToken } = require('@omega.js/devkit/deploy');
const { assertBrandVersion } = require('@omega.js/devkit/brand-version');
const { deployPrecheck } = require('../utils/deploy-precheck');

class DeployCommand extends BaseCommand {
  async execute() {
    const self = this.main;

    // The whole verb goes to the target's own deploy log, from its first line
    // ([#873](https://github.com/Omega-JS-Stack/omega/issues/873)): the
    // scaffold, the precheck's refusals and the followed run all land in one
    // file instead of scrollback, the same `logs/<verb>.log` lane dev, build
    // and test take and the same name the other three targets deploy to. The
    // direct lane's `dist/deploy.log` (the firebase transcript) is unchanged.
    this.attachVerbLog('deploy');

    // Custom-server mode has no Cloud Functions to publish (#584) — refuse
    // before staging, so nothing is written for a deploy that cannot happen.
    if (refuseWhenCustom(self.firebaseProjectPath, 'deploy')) return;

    // The lane's ONE production config read ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)):
    // a deploy IS a production run, so the gate below, the dispatch address and
    // the license verdict all read the same layers, once, instead of each
    // asking again.
    const { config } = loadConfig(self.firebaseProjectPath, 'backend', { environment: 'production' });

    // A SHARED cloud project is several brands' project
    // ([#882](https://github.com/Omega-JS-Stack/omega/issues/882)): the manage
    // cycle already limits itself to the per-brand operations there
    // (docs/manager/cloud.md), and a deploy would publish THIS brand's
    // functions and rules over the project all of them run on. So the verb
    // steps aside, in the shape every intentional skip in this lane takes: one
    // line, exit 0, nothing run. It sits ahead of the scaffold, the precheck
    // and the version assert, so nothing is written, pushed or dispatched for a
    // deploy that will not happen: on the laptop, in the brand-root fan-out
    // (which reads the exit 0 and moves on) and inside the composed workflow's
    // `deploy --direct` step alike, which makes a dispatch of it a green no-op.
    if (config.cloud?.shared === true) {
      this.log(chalk.gray('  Skipping the backend deploy: cloud.shared is true (config/omega.json5 → cloud), and a shared project is never deployed from a brand'));
      return;
    }

    // The local half of the retired `omega setup` (#675), on EVERY lane, the
    // way web, desktop and extension run it: idempotent, quiet on a converged
    // target, and the step that COMPOSES the workflow a dispatch names, so a
    // `--direct` run scaffolds exactly as the dispatch does rather than
    // skipping the half of the verb its own header promises.
    await this.runEnsureTarget();

    // The brand's ONE version ([#869](https://github.com/Omega-JS-Stack/omega/issues/869)):
    // a target whose version drifted from the brand root's is refused here, before
    // the precheck, because a drifted target must not push its secrets and
    // dispatch a build of the wrong number. A read, so every lane reaches it
    // (`--direct` and `--dry-run` included), which is why it sits ahead of the
    // lane split rather than inside the dispatch half.
    assertBrandVersion({ dir: self.firebaseProjectPath });

    return self.argv?.direct ? this.deployDirect(config) : this.dispatchDeploy(config);
  }

  /**
   * The CI lane (the default): deliver the brand to its repo and dispatch the
   * composed backend workflow, which runs `omega deploy --direct` on a runner.
   *
   * @param {object} config - The lane's production config, read once in `execute()`.
   */
  async dispatchDeploy(config) {
    const self = this.main;
    const dryRun = self.argv?.dryRun || self.argv?.['dry-run'];

    // The NETWORK half, as a precheck: the runner has no `.env` and no service
    // account, so the workflow rebuilds both from repo secrets. A DRY RUN runs
    // it too ([#895](https://github.com/Omega-JS-Stack/omega/issues/895)):
    // every step is a read or a plan under `dryRun`, so the preview is real.
    await deployPrecheck({
      projectDir: self.firebaseProjectPath,
      options: self.argv || {},
      logger: { log: (line) => this.log(chalk.gray(`  ${line}`)), warn: (line) => this.logWarning(`  ${line}`), error: (line) => this.logError(`  ${line}`) },
      dryRun,
    });

    // The ONE dispatch address helper ([#847](https://github.com/Omega-JS-Stack/omega/issues/847)):
    // the repo the brand's CONFIG names, and the workflow the target's scaffold
    // actually composed at the brand root under a per-target name (#265).
    const { owner, repo, workflow } = dispatchTarget({
      projectRoot: self.firebaseProjectPath,
      // A deploy is a PRODUCTION run, so every config read in the lane is the
      // production one (#856): the address it dispatches to and the artifact
      // the runner stages read the same layers.
      config,
      workflow: 'deploy.yml',
    });
    const logger = { log: (line) => this.log(chalk.gray(`  ${line}`)), warn: (line) => this.logWarning(`  ${line}`) };
    // Read BEFORE the dispatch: it is what tells the follower which run is this
    // one rather than the run before it (#873).
    const since = new Date();
    const { plan, dispatched, lane, sha } = await deployViaDispatch({
      workflow,
      owner,
      repo,
      dir: self.firebaseProjectPath,
      dryRun,
      // The brand root's one snapshot for the whole fan-out, when a brand-root
      // deploy spawned this verb (#901): the push is done, so this run
      // dispatches against that sha instead of pushing over it. Nobody types it.
      snapshot: self.argv?.snapshot,
      logger,
    });

    if (!dispatched) {
      this.log(chalk.gray(`  DRY RUN (${laneLabel(lane)}), would send:`));
      this.log(chalk.gray(`    ${plan.method} ${plan.url}`));
      this.log(chalk.gray(`    body: ${JSON.stringify(plan.body)}`));
      return this.log(chalk.gray(`    then watch: ${plan.runsUrl}`));
    }

    require('@omega.js/devkit/deploy-record').recordDeploy({ dir: self.firebaseProjectPath, target: targetNameFromDir(self.firebaseProjectPath) || 'backend', detail: { method: 'dispatch' } });
    this.log(chalk.gray(`  Dispatched ${workflow} (${laneLabel(lane, sha)}): CI deploys this backend.`));
    this.log(chalk.gray(`  Watch: ${plan.runsUrl}`));

    // Follow the run to its verdict (#873): the jobs' logs stream in here, and
    // a red run throws, so the verb's exit code is the run's conclusion rather
    // than "the dispatch was accepted". The run also has to be building the
    // tree this deploy pushed (#902): a brand with no repo snapshots nothing,
    // so there is no sha and that check is off.
    await require('@omega.js/devkit/deploy-follow').followRun({
      owner,
      repo,
      workflow,
      since,
      headSha: sha,
      token: resolveToken(),
      logger,
    });
  }

  /**
   * The direct lane (`--direct`): the deploy itself, from this machine or from
   * the runner the workflow started. Everything below is unchanged behavior.
   *
   * @param {object} config - The lane's production config, read once in `execute()`.
   */
  async deployDirect(config) {
    const self = this.main;
    const only = self.argv?.only ? ` --only ${self.argv.only}` : '';

    // The plan and nothing else, the same line the other three print (#872).
    if (self.argv?.dryRun || self.argv?.['dry-run']) {
      return this.log(`DRY RUN, would run: firebase deploy${only} (this machine)`);
    }

    if (refuseWhenToolsMissing(self.firebaseProjectPath, 'deploy', ['firebase'])) return;

    const logPath = this.getLogsPath('deploy.log');
    const detachLog = attachLogFile(logPath);
    let staging = null;

    // Opened at the attach, so a refusal anywhere below still takes this layer off.
    try {
      this.log(chalk.gray(`  Logs saving to: ${logPath}\n`));

      // The .env cascade, loaded HERE because nothing else in the CLI boot does:
      // the license key below is read from this process's environment, and a
      // licensed brand keeps OMEGA_LICENSE_KEY in the brand root's .env. Named
      // `production`: the same environment the stage below composes dist/.env
      // for (#586), so the verdict and the artifact read one overlay.
      loadEnv(path.join(self.firebaseProjectPath, 'dist'), { environment: 'production' });

      // The license check ([#320](https://github.com/Omega-JS-Stack/omega/issues/320)),
      // once per deploy and BEFORE the stage: a backend deploy runs straight
      // from the CLI, so the key comes out of the .env cascade in this process
      // and never near the artifact. The verdict itself rides the composed
      // dist/.env as OMEGA_LICENSE_STATUS: a keyless deploy gates the payment
      // provider libraries at runtime. A key that cannot be answered for throws
      // here, which stops the deploy rather than shipping the wrong verdict.
      const licenseStatus = (await resolveLicenseStamp({
        // The verdict rides the artifact (dist/.env), so it is asked for against
        // the PRODUCTION config, the same environment the stage below composes
        // both halves of the upload for (#856).
        config,
        production: true,
      })).status;
      this.log(chalk.gray(`  License: ${licenseStatus}\n`));

      // dist/ is staged output (src/dist pillar): a fresh stage carries the
      // composed config + public/ hosting boilerplate across the upload boundary.
      // The upload is composed for PRODUCTION: base .env + `.env.production`,
      // and no other environment's overlay ever rides along (#586).
      await this.ensureStaged({ environment: 'production', licenseStatus });

      // --only above passes through (e.g. `omega deploy --only hosting` deploys
      // hosting on Spark plans where functions would demand Blaze).

      // Local file: dependencies (local-first @omega.js packages) can't be
      // followed by Cloud Build, so stage them into the upload as packed tarballs
      const firebaseJSON = jetpack.read(path.join(self.firebaseProjectPath, 'firebase.json'), 'json') || {};
      const functionsBlock = Array.isArray(firebaseJSON.functions) ? firebaseJSON.functions[0] : firebaseJSON.functions;
      const functionsPath = path.join(self.firebaseProjectPath, functionsBlock?.source || 'dist');
      const deployingFunctions = !self.argv?.only || String(self.argv.only).split(',').some((t) => t.trim().startsWith('functions'));

      // Without an Artifact Registry cleanup policy, firebase deploy EXITS 1
      // after a successful functions deploy, and the post-steps below (public
      // invoker) never run. Ensure it up front.
      if (deployingFunctions) {
        await this.ensureArtifactCleanupPolicy();
      }

      staging = deployingFunctions
        ? await stageLocalPackages({ dir: functionsPath, log: (message) => this.log(message) })
        : null;

      await powertools.execute(`firebase deploy${only}`, {
        log: false,
        config: {
          cwd: self.firebaseProjectPath,
          stdio: ['inherit', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '1' },
        },
      }, (child) => {
        child.stdout.on('data', (data) => process.stdout.write(data));
        child.stderr.on('data', (data) => process.stderr.write(data));
      });

      require('@omega.js/devkit/deploy-record').recordDeploy({ dir: self.firebaseProjectPath, target: targetNameFromDir(self.firebaseProjectPath) || 'backend', detail: { method: 'firebase' } });

      // After successful deploy, ensure HTTP functions are publicly invocable
      await this.ensurePublicInvoker();
    } finally {
      if (staging) {
        await staging.restore();
      }
      detachLog();
    }
  }

  /**
   * Ensure the Artifact Registry cleanup policy exists (old container images
   * auto-delete). Best-effort: Spark plans, a disabled API, or a first-ever
   * deploy (no gcf-artifacts repo yet) just skip — deploy proceeds either way.
   */
  async ensureArtifactCleanupPolicy() {
    try {
      await powertools.execute('firebase functions:artifacts:setpolicy --force', {
        log: false,
        config: { cwd: this.main.firebaseProjectPath },
      });
      this.log(chalk.gray('  Artifact cleanup policy ensured\n'));
    } catch (e) {
      // Non-fatal — the deploy itself doesn't need the policy
    }
  }

  /**
   * Ensure all HTTP-triggered functions have allUsers as cloudfunctions.invoker.
   *
   * Firebase CLI used to set this automatically but stopped around the Node 10
   * runtime transition. Without it, HTTP requests get a 403 at the IAM level
   * before @omega.js/backend's application-level auth (the omega-admin-key header) can run.
   *
   * Dynamically discovers all deployed functions via gcloud and fixes any
   * HTTP-triggered function missing the allUsers invoker binding.
   */
  async ensurePublicInvoker() {
    const projectId = this.getProjectId();

    if (!projectId) {
      return;
    }

    // Discover all deployed HTTP-triggered functions
    let httpFunctions;

    try {
      const output = await powertools.execute(
        `gcloud functions list --project ${projectId} --regions ${FUNCTIONS_REGION} --format="json(name,httpsTrigger)"`,
        { log: false },
      );

      httpFunctions = JSON.parse(output)
        .filter((fn) => fn.httpsTrigger)
        .map((fn) => fn.name.split('/').pop());
    } catch (e) {
      // On a laptop this is the ordinary "no gcloud here" and the deploy speaks
      // for itself. On a RUNNER the workflow installed and authenticated gcloud
      // itself, so a listing that fails is a broken deploy: every HTTP function
      // answers 403 at the IAM level until someone guesses why. The run goes
      // red and says so ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)).
      if (isCI(process.env)) {
        throw new Error(`Could not list HTTP functions to make them publicly invocable (gcloud: ${e.message}). The functions deployed, but every HTTP function answers 403 until an allUsers invoker binding exists.`);
      }
      return;
    }

    if (!httpFunctions.length) {
      return;
    }

    this.log(chalk.gray('\n  Ensuring HTTP functions are publicly invocable...\n'));

    let fixed = 0;
    let ok = 0;

    for (const fnName of httpFunctions) {
      try {
        const policyOutput = await powertools.execute(
          `gcloud functions get-iam-policy ${fnName} --project ${projectId} --region ${FUNCTIONS_REGION} --format=json`,
          { log: false },
        );

        const policy = JSON.parse(policyOutput);
        const hasAllUsers = (policy.bindings || []).some(
          (b) => b.role === 'roles/cloudfunctions.invoker'
            && (b.members || []).includes('allUsers'),
        );

        if (hasAllUsers) {
          ok++;
          continue;
        }

        await powertools.execute(
          `gcloud functions add-iam-policy-binding ${fnName} --project ${projectId} --region ${FUNCTIONS_REGION} --member="allUsers" --role="roles/cloudfunctions.invoker"`,
          { log: false },
        );

        this.log(`  ${chalk.green('✓')} Set public invoker on ${chalk.cyan(fnName)}`);
        fixed++;
      } catch {
        // Skip silently — function may be in a transient state
      }
    }

    if (fixed > 0) {
      this.log(`  ${chalk.green('✓')} Public invoker: ${ok + fixed} functions accessible (${fixed} just fixed)\n`);
    } else if (ok > 0) {
      this.log(`  ${chalk.green('✓')} Public invoker: ${ok} functions accessible\n`);
    }
  }

  getProjectId() {
    try {
      const firebaserc = jetpack.read(path.join(this.main.firebaseProjectPath, '.firebaserc'), 'json');
      return firebaserc?.projects?.default;
    } catch {
      return null;
    }
  }
}

module.exports = DeployCommand;
