/**
 * `omega onboard`: the brand-creation wizard. Flags win, prompts fill the
 * gaps in a TTY, derivation covers the rest, and the scaffold proves the
 * config loads. Where it runs decides the mode:
 *   - inside a brand: resume. Answers come from its config, missing files
 *     fill in, and a target pick adds the targets the brand lacks.
 *   - in a brand-template folder: first run. The template's marked files give
 *     way, then install and the dev stack (`--no-dev` stops first).
 *   - anywhere else: the cwd becomes the brand root.
 * Scaffolding never overwrites a file a person wrote, so a rerun converges.
 */

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');

const { input, checkbox, confirm } = require('@omega.js/devkit/prompt');
const { readOrigin } = require('@omega.js/devkit/git-remote');
const { missingMachineTools, machineToolLine } = require('@omega.js/devkit/machine-tools');
const { TARGETS, targetEntries, resolveCompany, deriveBundleIdPrefix, sourceRepo, repoDrift, getAtPath, defaultAddressReason } = require('@omega.js/config');

const { TARGET_FRAMEWORKS, DEFAULTS } = require('./config.js');
const { resolveBrandRoot, loadBrand } = require('./lib/brand.js');
const { askCompanyId, validateCompanyId } = require('./lib/company-question.js');
const { buildScaffoldPlan, applyScaffoldPlan, printPlanResults, targetSeeds } = require('./lib/scaffold.js');
const { isTemplateCopy } = require('./lib/template-marker.js');
const { askOwner } = require('./lib/github-owners.js');
const { writeBrandConfig } = require('./lib/config-write.js');
const { npmInstall } = require('./lib/npm-install.js');
const { DEFAULT_TARGETS, NO_TARGETS, NO_TARGETS_LINE } = require('./lib/default-targets.js');
const { canPrompt } = require('./lib/run-gates.js');
const { convertLegacyOAuthSecret } = require('./lib/legacy-oauth.js');
const { machinePluginState, ensureMachinePlugin } = require('./lib/claude-machine.js');
const { PLUGIN_ID } = require('./lib/claude-settings.js');

// New-brand ids are a conservative subset of the schema's brand.id pattern —
// always dir-, repo-, and URL-scheme-safe.
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ID_HINT = 'lowercase letters, numbers, dashes; starts with a letter';

// The one rule an account email meets, asked or passed as --admins
const isAdminEmail = (value) => value.trim().includes('@');

/**
 * The bundle-id prefix a brand derives: reverse-DNS of its COMPANY's domain
 * when it names one, else its own. The fresh wizard and a rerun both read it,
 * and the config gets it only for targets that sign apps.
 *
 * @param {{ url?: string }} company - The resolved company
 * @param {string} url - The brand's own url
 * @returns {string} The prefix
 */
const bundleIdPrefixFor = (company, url) => deriveBundleIdPrefix(company.url || url);

const removalLine = (name) => `Removing a target is by hand: delete targets/${name} and its entry in config/omega.json5.`;

const mismatchLine = (repo, expected) => `Your repo is named ${repo}. OMEGA expects ${expected}. Rename it: gh repo rename ${expected}`;

/**
 * The wizard picks TYPES; the scaffold writes NAMES (#886). A fresh brand
 * names each target for its own type, so `web` runs the web framework in
 * targets/web, and a rename afterwards is a one-line config edit.
 * @param {string[]} types - Chosen target types.
 * @returns {Array<{ name: string, type: string }>} The target entries.
 */
function targetEntriesFromTypes(types) {
  return types.map((type) => ({ name: type, type }));
}

/**
 * Derive a valid brand id from a directory name ('My Brand 2' → 'my-brand-2');
 * null when nothing valid survives.
 */
function deriveId(dirName) {
  const id = String(dirName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '');

  return ID_PATTERN.test(id) ? id : null;
}

/**
 * The brand id a repo name implies: the manage step expects the source repo
 * to be `<brand id>-omega`, so the suffix comes off ('acme-omega' → 'acme').
 *
 * @param {string} name - A repo or folder name
 * @returns {string|null} A valid brand id, or null when nothing valid survives
 */
function idFromRepoName(name) {
  return deriveId(String(name).replace(/-omega$/i, ''));
}

/** 'acme-demo' → 'Acme Demo' */
function deriveName(id) {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** omega-manager's onboarding default: dashes drop out of the domain. */
function deriveUrl(id) {
  return `https://${id.replace(/-/g, '')}.com`;
}

/** The support address on the brand's own host; '' on a default Pages host, which is no mail domain. */
function deriveEmail(url) {
  if (defaultAddressReason(url)) return '';

  const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `support@${host}`;
}

/**
 * Normalize a --targets flag value ('web,backend', `none`, or an array) and
 * validate every entry against the canonical target list.
 */
function parseTargetsFlag(value) {
  const targets = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = targets.map((t) => t.trim()).filter(Boolean);

  if (cleaned.length === 1 && cleaned[0] === NO_TARGETS) {
    return [];
  }

  const unknown = cleaned.filter((t) => !TARGETS.includes(t));
  if (unknown.length > 0) {
    throw new Error(`Unknown target(s): ${unknown.join(', ')}. Valid targets: ${TARGETS.join(', ')}, or ${NO_TARGETS}`);
  }
  if (cleaned.length === 0) {
    throw new Error(`--targets needs a list of: ${TARGETS.join(', ')}, or ${NO_TARGETS}`);
  }

  return cleaned;
}

/**
 * The target checkbox: every target type, the given ones checked. An empty
 * pick is a brand with no targets.
 *
 * @param {string[]} checked - The types checked to start with
 * @returns {Promise<string[]>} The picked types
 */
function pickTargets(checked) {
  return checkbox({
    message: 'Targets (key presence in omega.json5 = enabled):',
    choices: TARGETS.map((target) => ({
      name: `${target}: targets/${target}${TARGET_FRAMEWORKS[target] ? ` (${TARGET_FRAMEWORKS[target]})` : ' (reserved: MAM overhaul pending)'}`,
      value: target,
      checked: checked.includes(target),
    })),
  });
}

/**
 * Name each machine tool the picked targets miss, one line each. The pick
 * stands: a target is added whatever this machine has.
 *
 * @param {Array<{ name: string, type: string, projectType?: string }>} targets - The picked targets
 * @param {Function} [execFn] - The probe runner (execFileSync by default)
 */
function warnMissingTools(targets, execFn) {
  for (const miss of missingMachineTools(targets, { execFn })) {
    console.log(`${chalk.yellow('⚠')} ${machineToolLine(miss)}`);
  }
}

/**
 * The admin-account list a fresh brand would inherit without writing
 * anything: the company layer's account.admins when the brand names a company
 * whose tree resolves here (#677), else the manager's built-in default.
 *
 * @param {object} company - The resolveCompany() answer for this brand.
 * @returns {{ list: Array, source: string }}
 */
function inheritedAdmins(company) {
  const companyAdmins = company.config?.account?.admins;

  return Array.isArray(companyAdmins) && companyAdmins.length > 0
    ? { list: companyAdmins, source: 'company config' }
    : { list: DEFAULTS.account.admins, source: 'built-in default' };
}

/**
 * The --admins flag ('a@x.com,b@x.com', or an array) as the brand's own
 * account list, each managed as the wizard's defaults manage one.
 *
 * @param {string|string[]} value - The flag value
 * @returns {Array<{ email: string, account: boolean, marketing: boolean }>} The entries
 */
function parseAdminsFlag(value) {
  const emails = (Array.isArray(value) ? value : String(value).split(',')).map((email) => String(email).trim()).filter(Boolean);
  const invalid = emails.filter((email) => !isAdminEmail(email));
  if (emails.length === 0 || invalid.length > 0) {
    throw new Error(`Invalid --admins${invalid.length > 0 ? ` (${invalid.join(', ')})` : ''}: pass account emails, comma-separated (--admins=a@acme.com,b@acme.com)`);
  }

  return emails.map((email) => ({ email, account: true, marketing: true }));
}

/**
 * The accounts step: the --admins flag, else show the list the brand
 * inherits and let the owner keep it (nothing written: the source layer
 * keeps owning it) or define the brand's own, which lands as account.admins
 * in its omega.json5. The first ask offers `support@{domain}` only when the
 * brand url derives a support email at all (never on a default Pages host).
 *
 * @returns {Array|null} Customized entries, or null to inherit
 */
async function collectAccountAdmins(inherited, interactive, flag, url) {
  if (flag != null) {
    return parseAdminsFlag(flag);
  }
  if (!interactive) {
    return null;
  }

  console.log('');
  console.log(`  Managed accounts the brand inherits ${chalk.dim(`(${inherited.source})`)}:`);
  for (const entry of inherited.list) {
    const flags = [entry.account && 'account', entry.marketing && 'marketing'].filter(Boolean).join(' + ');
    console.log(`    ${chalk.dim('•')} ${chalk.cyan(entry.email)} ${chalk.dim(`(${flags || 'nothing managed'})`)}`);
  }

  const keep = await confirm({
    message: 'Keep this account list? (customizing writes account.admins into the brand config)',
    default: true,
  });
  if (keep) {
    return null;
  }

  const entries = [];
  do {
    const email = (await input({
      message: `Account email (${'{domain}'} = brand domain):`,
      ...(entries.length === 0 && deriveEmail(url) ? { default: 'support@{domain}' } : {}),
      validate: (value) => (isAdminEmail(value) ? true : 'Must be an email address'),
    })).trim();
    const account = await confirm({ message: 'Manage the Firebase Auth account (create + admin role + top plan)?', default: true });
    const marketing = await confirm({ message: 'Sync the contact to marketing providers?', default: true });
    entries.push({ email, account, marketing });
  } while (await confirm({ message: 'Add another account?', default: false }));

  return entries;
}

/**
 * Collect the wizard answers for a FRESH brand: flags win, prompts fill the
 * gaps interactively, derivation covers the rest. `brandRoot` is where the
 * brand will live, which is what the company answer resolves against, and
 * `origin` is its readOrigin() answer: the id and owner defaults come from it.
 */
async function collectAnswers(options, interactive, brandRoot, origin) {
  const defaultId = idFromRepoName(origin.repo || path.basename(brandRoot));

  // id — the only field with no universal derivation
  let id = options.id ?? null;
  if (id != null && !ID_PATTERN.test(String(id))) {
    throw new Error(`Invalid brand id ${JSON.stringify(String(id))} — ${ID_HINT}`);
  }
  if (!id) {
    if (interactive) {
      id = await input({
        message: 'Brand ID:',
        ...(defaultId ? { default: defaultId } : {}),
        validate: (value) => (ID_PATTERN.test(value.trim()) ? true : `Must be ${ID_HINT}`),
      });
      id = id.trim();
    } else if (defaultId) {
      id = defaultId;
    } else {
      throw new Error('Brand id required: pass --id=<id> (or run in an interactive terminal)');
    }
  }
  // The origin judged against the source repo this id derives under its owner
  const derived = origin.slug ? { brand: { id }, repo: { owner: origin.owner } } : null;
  if (derived && repoDrift(origin.slug, derived)) {
    console.log(`${chalk.yellow('⚠')} ${mismatchLine(origin.repo, sourceRepo(derived).name)}`);
  }

  // name / url — derivable from the id
  let name = options.name ?? null;
  if (!name) {
    name = interactive
      ? (await input({
        message: 'Brand name:',
        default: deriveName(id),
        validate: (value) => (value.trim().length > 0 ? true : 'Required'),
      })).trim()
      : deriveName(id);
  }

  let url = options.url ?? null;
  if (url != null && !/^https?:\/\//.test(String(url))) {
    throw new Error(`Invalid brand url ${JSON.stringify(String(url))} — must start with http(s)://`);
  }
  if (!url) {
    url = interactive
      ? (await input({
        message: 'Brand URL:',
        default: deriveUrl(id),
        validate: (value) => (/^https?:\/\//.test(value.trim()) ? true : 'Must start with http(s)://'),
      })).trim()
      : deriveUrl(id);
  }

  // company: the ONE key that joins this brandto its company (#677): the
  // parent's own brand.id, `self` when this brand IS the company, blank for a
  // standalone brand. Everything the company owns (config layer, .env, hooks,
  // signing tree) follows from it; nothing else is asked or written.
  let companyId = null;
  if (options.company != null) {
    const verdict = validateCompanyId(options.company);
    if (verdict !== true) {
      throw new Error(`Invalid --company ${JSON.stringify(String(options.company))}: ${verdict}`);
    }
    companyId = String(options.company).trim();
  } else if (interactive) {
    companyId = await askCompanyId();
  }

  // The resolved company: its own facts come from the PARENT's config through
  // the one resolver, so the wizard restates nothing the parent owns.
  const company = resolveCompany(brandRoot, {
    brand: { name, url },
    ...(companyId ? { company: { id: companyId } } : {}),
  });

  // description / tagline — optional; empty answers stay out of the config
  let description = options.description ?? null;
  if (description == null && interactive) {
    description = (await input({ message: 'Brand description (optional):' })).trim();
  }

  let tagline = options.tagline ?? null;
  if (tagline == null && interactive) {
    tagline = (await input({ message: 'Brand tagline (optional, ~3 words):' })).trim();
  }

  // targets: the flag, else the checkbox in a TTY, else the default
  let targetTypes = options.targets != null ? parseTargetsFlag(options.targets) : null;
  if (!targetTypes) {
    targetTypes = interactive ? await pickTargets(DEFAULT_TARGETS) : DEFAULT_TARGETS;
  }
  warnMissingTools(targetEntriesFromTypes(targetTypes), options.execFn);

  const owner = await resolveOwner(options, interactive, id, origin);

  // accounts — inherit by default (null writes nothing); customizing lands
  // the brand's own account.admins
  const accountAdmins = await collectAccountAdmins(inheritedAdmins(company), interactive, options.admins, url);

  return {
    id,
    name,
    url,
    company: companyId ? { id: companyId } : null,
    description: description || null,
    tagline: tagline || null,
    email: deriveEmail(url),
    targets: targetEntriesFromTypes(targetTypes),
    repo: owner ? { owner } : null,
    accountAdmins,
    bundleIdPrefix: bundleIdPrefixFor(company, url),
  };
}

/**
 * The GitHub owner of the brand's repos: the --owner flag, else the question in
 * a TTY (the origin's owner as its default), else the origin's owner.
 *
 * @returns {Promise<string|null>} The owner, or null to write no `repo` block
 */
async function resolveOwner(options, interactive, brandId, origin) {
  if (options.owner != null) {
    if (typeof options.owner !== 'string' || !options.owner.trim()) {
      throw new Error('Invalid --owner: pass the GitHub owner (--owner=acme)');
    }
    return options.owner.trim();
  }
  if (!interactive) {
    return origin.owner || null;
  }
  return askOwner({ brandId, defaultOwner: origin.owner || null, execFn: options.execFn });
}

/**
 * Answers for an EXISTING brand (resume): no wizard — the brand's own config
 * is the source, and the scaffold only fills missing files around it.
 *
 * @param {object} brand - The loadBrand() answer
 * @returns {Object} The answers the scaffold plan takes
 */
function answersFromBrand(brand) {
  if (brand.configError) {
    throw new Error(`This brand's config/omega.json5 does not load: ${brand.configError}`);
  }

  const id = brand.id;
  const url = brand.config.brand?.url || deriveUrl(id);

  return {
    id,
    name: brand.config.brand?.name || deriveName(id),
    // The brand's own answer: the loader FILLS `company` on every config, so
    // only an authored id means anything here
    company: brand.config.company?.id ? { id: brand.config.company.id } : null,
    url,
    description: brand.config.brand?.description || null,
    tagline: brand.config.brand?.tagline || null,
    email: brand.config.brand?.contact?.email || deriveEmail(url),
    // The brand's own declarations, name AND type: a target named `admin`
    // scaffolds targets/admin around whichever framework it declares (#886)
    // A brand with none keeps none: a rerun never writes default targets.
    targets: targetEntries(brand.config),
    // The loaded config's `company` is always resolved: a standalone brand's is its own name and url
    bundleIdPrefix: brand.config.certificates?.providers?.apple?.bundleIdPrefix || bundleIdPrefixFor(brand.config.company, url),
  };
}

/**
 * Ensure the born brand is a git repository: init + stage + first commit
 * when the brand root isn't already inside one (Ian 2026-07-17 — a brand
 * should be committable from minute one, and the extension package task's
 * source-zip step wants a repo). The scaffolded .gitignore is on disk
 * before this runs, so the first commit can never capture .env/.omega.
 * Inside an existing work tree ("Use this template" clones, brands in a
 * monorepo) this is a clean skip.
 *
 * @param {string} brandRoot - The brand root directory
 * @param {string} brandName - Display name for the first-commit message
 * @returns {{ initialized: boolean, committed?: boolean, reason?: string }}
 */
function ensureGitRepo(brandRoot, brandName) {
  const git = (args) => spawnSync('git', args, { cwd: brandRoot, stdio: 'ignore' });

  if (git(['rev-parse', '--is-inside-work-tree']).status === 0) {
    return { initialized: false, reason: 'existing repository' };
  }
  if (git(['init']).status !== 0) {
    return { initialized: false, reason: 'git init failed (is git installed?)' };
  }
  git(['add', '-A']);

  // Commit with the owner's identity; machines without one get a neutral
  // fallback so the first commit never blocks onboarding
  const hasIdentity = git(['config', 'user.email']).status === 0;
  const identity = hasIdentity ? [] : ['-c', 'user.name=OMEGA Onboard', '-c', 'user.email=onboard@localhost'];
  const commit = git([...identity, 'commit', '-m', `Initial commit — ${brandName} born via omega onboard`]);

  return { initialized: true, committed: commit.status === 0 };
}

/**
 * Run one manager verb in the brand exactly as a user would: a real child
 * process, waited on.
 *
 * @param {string} brandRoot - Where the verb runs
 * @param {string} verb - The verb (`manage`, `dev`)
 * @returns {Promise<number>} The child's exit code
 */
function spawnVerb(brandRoot, verb) {
  return new Promise((resolve) => {
    // cli-run.js runs as main: spawning it directly bypasses the bin's
    // dispatcher, so this child runs THIS manager and never re-dispatches on
    // the child's cwd. The verb is explicit: a bare run prints help.
    const entry = path.join(__dirname, 'cli-run.js');
    const child = spawn(process.execPath, [entry, verb], { cwd: brandRoot, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Run manage in the new brand. */
function spawnManage(brandRoot) {
  return spawnVerb(brandRoot, 'manage');
}

/**
 * Boot the new brand's dev stack (`omega dev`) and wait on it: the first
 * run's handover, so the person ends on a running site.
 *
 * @param {string} brandRoot - The brand root
 * @returns {Promise<number>} The dev stack's exit code
 */
function spawnDev(brandRoot) {
  return spawnVerb(brandRoot, 'dev');
}

/**
 * Install the brand's dependencies at its root; every target's framework
 * arrives through the workspaces.
 *
 * @param {string} brandRoot - The brand root
 * @returns {Promise<boolean>} Whether `npm install` succeeded
 */
async function installDeps(brandRoot) {
  console.log('');
  console.log(`${chalk.dim('→')} Installing dependencies ${chalk.dim('(npm install)')}`);
  const result = await npmInstall(brandRoot);
  if (!result.success) {
    console.log(`${chalk.red('✗')} npm install failed ${chalk.dim(`(${result.error}); fix it, then run npm install and npm start`)}`);
  }
  return result.success;
}

/**
 * A rerun's target pick: the --targets flag, else the checkbox in a TTY with
 * the brand's targets checked. A type the brand lacks gets its config entry
 * (nothing else in the file changes); a type left out removes nothing.
 *
 * @returns {Promise<Array<{ name: string, type: string }>>} The added entries
 */
async function addTargets(brandRoot, answers, options, interactive) {
  const current = answers.targets.map((entry) => entry.type);
  let picked = current;
  if (options.targets != null) {
    picked = parseTargetsFlag(options.targets);
  } else if (interactive) {
    picked = await pickTargets(current);
  }

  // Only the types a pick can name: a custom target is never "unchecked"
  for (const entry of answers.targets.filter((item) => TARGETS.includes(item.type) && !picked.includes(item.type))) {
    console.log(`${chalk.yellow('⚠')} ${removalLine(entry.name)}`);
  }

  const added = targetEntriesFromTypes(picked.filter((type) => !current.includes(type)));
  const taken = added.find((entry) => answers.targets.some((item) => item.name === entry.name));
  if (taken) {
    throw new Error(`targets.${taken.name} is already another type's name: add the ${taken.type} target to config/omega.json5 by hand under a free name`);
  }
  if (added.length > 0) {
    // Each new target also gets the brand-level keys a fresh scaffold would
    // write for it, where the brand (company layer included) has none yet
    const { config } = loadBrand(brandRoot);
    const has = (dotPath) => getAtPath(config, dotPath) != null;
    const seeds = Object.entries(targetSeeds({ ...answers, targets: added })).filter(([dotPath]) => !has(dotPath));
    writeBrandConfig({ brandRoot, options }, {
      ...Object.fromEntries(added.map((entry) => [`targets.${entry.name}`, { type: entry.type }])),
      ...Object.fromEntries(seeds),
    });
  }
  warnMissingTools([...answers.targets, ...added], options.execFn);

  return added;
}

/**
 * Offer the published omega Claude plugin for the whole machine when Claude
 * Code is here without it. Only in a terminal; declining changes nothing, and
 * a failing `claude` is the machine's problem, never the onboarding's.
 *
 * @param {boolean} interactive - A terminal can answer
 * @param {Function} [execFn] - The runner (execFileSync by default)
 * @returns {Promise<'installed'|'declined'|null>} - null when nothing was asked
 */
async function offerClaudePlugin(interactive, execFn) {
  if (!interactive) {
    return null;
  }

  try {
    const state = machinePluginState({ execFn });
    if (!state.claude || state.version) {
      return null;
    }
    console.log('');
    if (!await confirm({ message: `Install the omega Claude plugin for this machine (${PLUGIN_ID})?`, default: true })) {
      return 'declined';
    }
    ensureMachinePlugin({ execFn, machine: state });
    console.log(`${chalk.green('✓')} Claude plugin installed ${chalk.dim(`(${PLUGIN_ID}, every Claude Code session on this machine)`)}`);
    return 'installed';
  } catch (error) {
    console.log(`${chalk.yellow('⚠')} Claude plugin not installed ${chalk.dim(`(${error.message.split('\n')[0]})`)}`);
    return null;
  }
}

function printNextSteps(answers) {
  console.log('');
  console.log(chalk.bold('Next steps'));

  const steps = [
    `${chalk.cyan('npm install')}: every target gets its framework`,
    answers.targets.length > 0 ? `${chalk.cyan('npm start')}: boot the local stack` : NO_TARGETS_LINE,
    'Fill in .env as the brand adopts external services (the stub lists every key)',
    `${chalk.cyan('npm run manage')}: reconcile everything; rerun any time`,
  ];
  steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
}

/**
 * Main onboard runner.
 *
 * @param {string} cwd - Where the command ran
 * @param {Object} options - { id, name, url, description, tagline, targets, owner, company, admins, dryRun, manage, dev, execFn (the `gh`, `claude` and machine-tool runner, `(file, args, options) => stdout`; tests inject it) }
 * @returns {Object} - { brandRoot, mode, firstRun, created, kept, replaced, planned, valid, added, installed, manageExitCode, devExitCode }
 */
async function runOnboard(cwd, options = {}) {
  console.log(chalk.bold.cyan('OMEGA Manager — Onboarding'));
  console.log('');

  const interactive = canPrompt(options);
  const existing = resolveBrandRoot(cwd);
  const firstRun = isTemplateCopy(cwd);

  // Resolve the brand root + answers per context
  let brandRoot;
  let answers;
  let mode;
  let added = [];

  if (existing) {
    brandRoot = existing;
    console.log(`${chalk.dim('→')} Existing brand: ${chalk.cyan(brandRoot)} — filling missing files only`);
    answers = answersFromBrand(loadBrand(brandRoot));
    added = await addTargets(brandRoot, answers, options, interactive);
    answers.targets.push(...added);
    mode = 'resume';
  } else {
    brandRoot = cwd;
    answers = await collectAnswers(options, interactive, brandRoot, readOrigin({ dir: brandRoot }));
    mode = 'fresh';
  }

  if (mode === 'fresh') {
    console.log(`${chalk.dim('→')} New brand: ${chalk.cyan(answers.name)} ${chalk.dim(`(${answers.id})`)} → ${chalk.cyan(brandRoot)}`);
  }
  console.log('');

  // Scaffold (fill-missing; dry-run plans only)
  const plan = buildScaffoldPlan(answers);
  const results = applyScaffoldPlan(brandRoot, plan, { dryRun: options.dryRun });
  printPlanResults(results);

  if (options.dryRun) {
    console.log('');
    console.log(chalk.dim('⊘ Dry run — nothing written'));
    return { brandRoot, mode, firstRun, ...results, valid: true, added, devExitCode: null };
  }

  // Port-time conversion: a carried legacy oauth.json becomes the canonical
  // google-oauth.json once, here, so nothing downstream dual-reads it (#501)
  const legacyOAuth = convertLegacyOAuthSecret(brandRoot);
  if (legacyOAuth.converted) {
    console.log(`  ${chalk.green('✓')} google-oauth.json ${chalk.dim('← the carried legacy oauth.json (converted, legacy file removed)')}`);
  } else if (legacyOAuth.reason) {
    console.log(`  ${chalk.yellow('⚠')} legacy oauth.json not converted ${chalk.dim(`(${legacyOAuth.reason})`)}`);
  }

  // Prove the brand actually loads before calling it done
  const brand = loadBrand(brandRoot);
  const valid = !brand.configError && brand.configErrors.length === 0;
  console.log('');
  if (valid) {
    console.log(`${chalk.green('✓')} Config loads and validates ${chalk.dim(`(targets: ${brand.enabledTargets.join(', ') || NO_TARGETS})`)}`);
  } else {
    console.log(`${chalk.red('✗')} Config problem: ${brand.configError || brand.configErrors.join('; ')}`);
  }

  // Git — a born brand is committable from minute one
  const git = ensureGitRepo(brandRoot, answers.name);
  if (git.initialized) {
    console.log(`${chalk.green('✓')} git repository initialized ${chalk.dim(git.committed ? '(first commit made)' : '(commit skipped — set your git identity and commit)')}`);
  } else {
    console.log(`${chalk.dim('•')} git ${chalk.dim(`(${git.reason})`)}`);
  }

  // A first run hands over to the dev stack; every other run prints the way on
  const handover = firstRun && valid && options.dev !== false;
  if (!handover) {
    printNextSteps(answers);
  }

  const claudePlugin = await offerClaudePlugin(interactive, options.execFn);

  let installed = null;
  if (handover || (added.length > 0 && options.dev !== false)) {
    installed = await installDeps(brandRoot);
  }

  let devExitCode = null;
  if (handover && installed && answers.targets.length === 0) {
    console.log('');
    console.log(NO_TARGETS_LINE);
  } else if (handover && installed) {
    console.log('');
    console.log(`${chalk.dim('→')} Starting the dev stack ${chalk.dim('(npm start runs it from now on)')}`);
    console.log(chalk.dim('━'.repeat(70)));
    devExitCode = await spawnDev(brandRoot);
  }

  // Manage handoff — never in a dry run, never implicitly without a TTY
  let manageExitCode = null;
  const runNow = options.manage
    ?? (!firstRun && interactive && valid
      ? await confirm({ message: 'Run manage now?', default: true })
      : false);

  if (runNow) {
    console.log('');
    console.log(`${chalk.dim('→')} Starting management…`);
    console.log(chalk.dim('━'.repeat(70)));
    manageExitCode = await spawnManage(brandRoot);
  }

  return { brandRoot, mode, firstRun, ...results, valid, git, legacyOAuth, claudePlugin, added, installed, manageExitCode, devExitCode };
}

module.exports = {
  runOnboard,
  answersFromBrand,
  deriveId,
  deriveName,
  deriveUrl,
  deriveEmail,
  idFromRepoName,
  spawnDev,
};
