/**
 * Brand-monorepo scaffolding: the file plan the onboard wizard writes.
 * buildScaffoldPlan() turns the answers into config/omega.json5, the root
 * package.json (targets/* workspaces), .gitignore, the .env stubs, README.md
 * and a package.json per target; applyScaffoldPlan() writes it fill-missing,
 * so a rerun only fills gaps. A target's package.json carries its framework
 * (a dependency for the backend, a devDependency elsewhere), and each
 * framework's setup owns the interior. Every `@omega.js/*` spec is an exact
 * pin at the manager's own version: the family ships lockstep, so only
 * `omega update` moves it, every target together. An existing `file:` spec
 * is never rewritten, since an existing file is never touched.
 */

const path = require('node:path');
const jetpack = require('fs-jetpack');
const chalk = require('chalk').default;

const { TARGET_FRAMEWORKS } = require('../config.js');
// The environment vocabulary is @omega.js/config's — the same three names the
// overlay files are suffixed with and every runtime's environment() answers
const { ENV_ENVIRONMENTS, envLayerFiles } = require('@omega.js/config');
// The stub is the marker template every .env writer converges onto, with
// the generated keys minted: a scaffolded .env is already converged.
const { renderEnvTemplate } = require('./env-order.js');
const { generatedEnvKeys } = require('@omega.js/config');
// The heal's value is the SSOT for the manage script — a scaffolded brand
// must never be born needing the migration the heal just learned (#229)
const { MANAGE_SCRIPT } = require('./package-scripts.js');
// The marked .gitignore the workspace service heals every manage
const { renderBrandGitignore } = require('./gitignore.js');
const { TEMPLATE_URL, carriesTemplateMarker } = require('./template-marker.js');
const { formatJson } = require('@omega.js/devkit/write-json');
const { ENV_FILE } = require('@omega.js/devkit/env-file');

// The backend framework is a Cloud Functions RUNTIME dependency — the stage
// step derives dist/package.json from the target manifest's `dependencies`
// (src/dist pillar). Every other target's framework is build-time only.
const RUNTIME_DEP_TARGETS = ['backend'];

// The pin every scaffolded @omega.js/* spec carries — the manager's OWN
// version, read at run time (#794). The family releases lockstep, so the
// manager's number IS the family's number; nothing here keeps a copy of it.
const FAMILY_VERSION = require('../../package.json').version;

// The brand-level keys a target type needs beyond its own entry. A fresh
// scaffold writes them into the config; a rerun that adds the type writes the
// ones the brand lacks.
const TARGET_SEEDS = {
  // demo-* ids are EMULATOR-ONLY: the emulator boots before any real project exists
  backend: (answers) => ({ 'cloud.provider': 'firebase', 'cloud.config.projectId': `demo-${answers.id}` }),
  // The reverse-DNS prefix every Bundle ID mints under
  desktop: (answers) => (answers.bundleIdPrefix ? { 'certificates.providers.apple.bundleIdPrefix': answers.bundleIdPrefix } : {}),
};

/**
 * The brand-level keys the answers' targets need, as config dot-paths.
 *
 * @param {Object} answers - { id, bundleIdPrefix, targets: [{ name, type }] }
 * @returns {Object<string, *>} Dot-path to value
 */
function targetSeeds(answers) {
  return Object.assign({}, ...answers.targets.map((entry) => TARGET_SEEDS[entry.type]?.(answers) ?? {}));
}

/**
 * Render the brand-level config/omega.json5 (fresh brands only — an existing
 * config is never regenerated). String values go through JSON.stringify, so
 * user input can't break the file.
 */
function renderOmegaConfig(answers) {
  const lines = [
    `// ${answers.name}: brand-level omega.json5, the shared config layer every target`,
    '// under targets/ inherits. Local files override any key per-surface; key presence',
    '// under `targets` = this brand supports that target. Secrets NEVER live here:',
    '// they go in the gitignored .env (the loader hard-fails on secret-shaped keys).',
    '{',
    '  brand: {',
    `    id: ${JSON.stringify(answers.id)},`,
    `    name: ${JSON.stringify(answers.name)},`,
  ];

  if (answers.description) {
    lines.push(`    description: ${JSON.stringify(answers.description)},`);
  }
  if (answers.tagline) {
    lines.push(`    tagline: ${JSON.stringify(answers.tagline)},`);
  }

  lines.push(`    url: ${JSON.stringify(answers.url)},`);
  // A default Pages host derives no address, and an empty one is written nowhere
  if (answers.email) {
    lines.push(
      '    contact: {',
      `      email: ${JSON.stringify(answers.email)},`,
      '    },',
    );
  }
  lines.push('  },', '');

  // The ONE key that joins this brand to its company (#677): the parent's own
  // brand.id, or "self" when this brand IS the company. Unanswered writes
  // nothing: a standalone brand carries no `company` key at all.
  if (answers.company) {
    lines.push(
      '  // The company this brand belongs to: the parent\'s brand.id ("self" when this',
      '  // brand IS the company). Its config layer, .env, hooks and signing tree resolve',
      '  // from the company/ folder in that brand\'s repo.',
      `  company: { id: ${JSON.stringify(answers.company.id)} },`,
      '',
    );
  }

  // The GitHub owner the wizard settled on. Unanswered writes nothing: the
  // repo service skips until `repo.owner` is set by hand.
  if (answers.repo) {
    lines.push(
      '  // Where the brand\'s repos live: <brand.id>-omega and the rest, under this',
      '  // GitHub owner (an org or a user).',
      `  repo: { owner: ${JSON.stringify(answers.repo.owner)} },`,
      '',
    );
  }

  lines.push(
    '  // Social handles (platform: "handle"): each entry lights its footer icon, its JSON-LD sameAs entry, and a /<platform> shortlink.',
    '  socials: {},',
    '',
    '  // Project-owned theme, seeded at onboarding, yours to change.',
    '  theme: {',
    '    id: "classy",',
    '    appearance: "system", // "system" | "light" | "dark"',
    '  },',
    '',
    '  // AI translation (web /{lang}/ pages, extension _locales). Provider',
    '  // "claude" (default) rides the local Claude Code install, no API key;',
    '  // "chatgpt" needs OPENAI_API_KEY in .env. Uncomment to enable:',
    '  // translation: {',
    '  //   languages: ["es", "fr", "de"],',
    '  // },',
    '',
  );

  // Only a CUSTOMIZED admin list lands here — an inherited one (company
  // config or the built-in support@{domain} default) stays unwritten so the
  // source layer keeps owning it.
  if (answers.accountAdmins) {
    lines.push(
      '  // Managed Firebase Auth accounts (account service). Passwords never live',
      '  // here: OMEGA_ACCOUNT_PASSWORD__* env vars, config/hooks/account/password.js,',
      '  // or the generated ACCOUNT_PASSWORD_SEED.',
      '  account: {',
      '    admins: [',
    );
    for (const entry of answers.accountAdmins) {
      lines.push(`      { email: ${JSON.stringify(entry.email)}, account: ${!!entry.account}, marketing: ${!!entry.marketing} },`);
    }
    lines.push('    ],', '  },', '');
  }

  // Backend brands get a bootable cloud project out of the box: demo-* ids
  // are the emulator-only convention (never touch live Firebase), so the
  // emulator boots before any real project exists (dogfood friction #3).
  const seeds = targetSeeds(answers);
  if (seeds['cloud.config.projectId']) {
    lines.push(
      '  // Cloud project (backend target). demo-* ids are EMULATOR-ONLY: the',
      '  // emulators boot against this immediately; swap in a real Firebase project',
      '  // id at launch (the cloud service can create one).',
      '  cloud: {',
      `    provider: ${JSON.stringify(seeds['cloud.provider'])},`,
      '    config: {',
      `      projectId: ${JSON.stringify(seeds['cloud.config.projectId'])},`,
      '    },',
      '  },',
      '',
    );
  }

  lines.push(
    '  // Payment catalog: pricing pages render THESE products (no products =',
    '  // honest empty state). Uncomment + edit to start selling; ids are',
    '  // permanent once live. Provider id fields (stripe/paypal/chargebee) are',
    '  // filled by the payment service, so leave them null. Presentation fields',
    '  // (tagline, popular, features) are optional card garnish.',
    '  // payment: {',
    '  //   products: [',
    '  //     {',
    '  //       id: "premium",',
    '  //       name: "Premium",',
    '  //       type: "subscription",',
    '  //       tagline: "best for teams",',
    '  //       popular: true,',
    '  //       prices: { monthly: 9.99, annually: 99.99 },',
    '  //       trial: { days: 14 },',
    '  //       limits: { requests: 10000 },',
    '  //       features: [{ id: "requests", name: "Requests", icon: "sparkles" }],',
    '  //     },',
    '  //     { id: "launch-kit", name: "Launch Kit", type: "one-time", prices: { once: 49.99 } },',
    '  //   ],',
    '  // },',
    '',
  );

  // App-signing brands get their reverse-DNS bundle prefix derived at
  // onboarding (parent company's domain when one exists, else the brand's)
  if (seeds['certificates.providers.apple.bundleIdPrefix']) {
    lines.push(
      '  // Apple signing (certificates service): reverse-DNS prefix derived from',
      '  // the company/brand domain at onboarding. Bundle IDs mint as',
      '  // <prefix>.<brand id with dashes as dots>.',
      '  certificates: {',
      '    providers: {',
      '      apple: {',
      `        bundleIdPrefix: ${JSON.stringify(seeds['certificates.providers.apple.bundleIdPrefix'])},`,
      '      },',
      '    },',
      '  },',
      '',
    );
  }

  lines.push(
    '  // Key = the target NAME, which is its folder under targets/; `type` says',
    '  // which framework runs there. Any shared key inside overrides it there.',
    '  targets: {',
  );

  // The key is the target NAME and the folder (#886); its `type` says which
  // framework runs there, so `admin: { type: 'web' }` is targets/admin.
  for (const entry of answers.targets) {
    lines.push(`    ${entry.name}: { type: '${entry.type}' },`);
  }

  lines.push('  },', '}');

  return `${lines.join('\n')}\n`;
}

// The license every scaffolded manifest starts with (#884): npm's own value
// for closed-source commercial code, and the one the extension's Firefox lane
// maps to AMO's `all-rights-reserved`. One name, root and targets alike.
const BRAND_LICENSE = 'UNLICENSED';

/**
 * Render the brand root's package.json. Its `private` field is also the ONE
 * statement of the brand's visibility (#883): the manage walk reconciles the
 * source repo to it, and a fresh brand starts private.
 *
 * @param {object} answers - The onboard answers.
 * @returns {string} The file contents.
 */
function renderRootPackageJson(answers) {
  return formatJson({
    name: answers.id,
    private: true,
    // npm's own word for closed-source commercial code, which a brand is until
    // it says otherwise ([#884](https://github.com/Omega-JS-Stack/omega/issues/884)).
    // It is a REAL field, not decoration: the extension's Firefox lane sends a
    // target's license to AMO when it creates the listing, and an unstated one
    // used to make that submission a Bad Request. A brand that open-sources
    // itself edits this to its SPDX id.
    license: BRAND_LICENSE,
    ...(answers.description ? { description: answers.description } : {}),
    workspaces: ['targets/*'],
    // npm scripts put node_modules/.bin on PATH, so plain `omega` (the
    // context-aware dispatcher) resolves — never the retired omega-manager name
    // `npm start` boots the dev stack (`dev` stays as its alias); the bare
    // manage cycle is `npm run manage`
    scripts: {
      start: 'omega dev',
      dev: 'omega dev',
      manage: MANAGE_SCRIPT,
      deploy: 'omega deploy',
    },
    // Brand-level verbs (`omega dev`, manage, the `start` script above) resolve
    // @omega.js/manager FROM THE BRAND ROOT (omega-bin dispatch) — without this
    // declaration nothing installs it outside the monorepo and every brand-root
    // command dies (cp195 journey catch). Pinned exactly: the root and every
    // target ride ONE family version (#794).
    devDependencies: {
      '@omega.js/manager': FAMILY_VERSION,
    },
  });
}

function renderEnvStub() {
  return renderEnvTemplate(Object.fromEntries(Object.entries(generatedEnvKeys()).map(([key, generate]) => [key, generate()])));
}

/**
 * An environment overlay stub — a header comment and NOTHING else
 * ([#586](https://github.com/Omega-JS-Stack/omega/issues/586)). The base `.env`
 * stays the one file that documents every key (it carries the canonical
 * placeholder list); an overlay only ever holds the handful a brand wants
 * different for one environment, so pre-listing anything here would be a second
 * inventory to drift.
 *
 * @param {string} environment - `development` | `testing` | `production`.
 * @returns {string} The file contents.
 */
function renderEnvOverlayStub(environment) {
  return [
    `# .env.${environment} — overlays .env when this brand runs in ${environment} (gitignored).`,
    '# Only the keys that differ — anything not set here falls through to .env.',
    '',
  ].join('\n');
}

function renderReadme(answers) {
  const targetList = answers.targets
    .map((entry) => {
      const framework = TARGET_FRAMEWORKS[entry.type];
      return `- \`targets/${entry.name}/\`: the ${entry.name} target${framework ? ` (framework: \`${framework}\`)` : ''}`;
    })
    .join('\n') || '- `targets/`: none yet (`npx omega onboard --targets=web` adds one)';

  return `# ${answers.name}

${answers.description || 'An OMEGA brand monorepo.'}

One repo, every surface of the brand. \`config/omega.json5\` is the single
source of user choices; \`omega\` reconciles every external service
to it, idempotently.

## Structure

- \`config/omega.json5\`: brand-level shared config (targets inherit + override)
${targetList}
- \`.env\`: credentials (gitignored; see the stub for every service's keys)
- \`.env.<environment>\`: the per-environment overlay (\`development\`, \`testing\`, \`production\`): only the keys that differ there
- \`.omega/\`: manager state + run output (gitignored, machine-owned)

## Next steps

1. \`npm install\`: every target gets its framework through the workspaces.
2. \`npm start\` (\`npx omega dev\`): boot the local stack. A project made from
   the [brand template](${TEMPLATE_URL}) runs both on its first \`npm start\`.
3. Fill in \`.env\` as the brand adopts external services.
4. \`npm run manage\`: reconcile everything; rerun any time.
5. Add a target later: \`npx omega onboard --targets=web,backend\` adds the ones
   this brand lacks and changes nothing else.
`;
}

function renderTargetPackageJson(answers, entry) {
  const framework = TARGET_FRAMEWORKS[entry.type];
  // The exact family pin (#794): satisfied by a workspace link in-monorepo,
  // `mgr i local` pre-publish (which flips the spec to `file:`), and the npm
  // registry once @omega.js/* publish — where the pin is what keeps every
  // target on ONE framework version.
  const depKey = RUNTIME_DEP_TARGETS.includes(entry.type) ? 'dependencies' : 'devDependencies';

  // version + author: electron-builder hard-requires version and warns on
  // author (the cp142 rehearsal catch) — every target gets both, they're healthy
  return formatJson({
    name: `${answers.id}-${entry.name}`,
    version: '0.0.1',
    author: answers.name,
    private: true,
    license: BRAND_LICENSE,
    description: `${answers.name} ${entry.name} target`,
    ...(framework ? { [depKey]: { [framework]: FAMILY_VERSION } } : {}),
  });
}

/**
 * Build the scaffold plan for a brand.
 *
 * @param {Object} answers - { id, name, description, tagline, url, email, targets: [{ name, type }] }
 * @returns {Array<{ path: string, contents: string }>} - Brand-root-relative file plan
 */
function buildScaffoldPlan(answers) {
  const plan = [
    { path: 'config/omega.json5', contents: renderOmegaConfig(answers) },
    { path: 'package.json', contents: renderRootPackageJson(answers) },
    { path: '.gitignore', contents: renderBrandGitignore() },
    { path: ENV_FILE, contents: renderEnvStub() },
    // The overlay is the last, strongest, file envLayerFiles names
    ...ENV_ENVIRONMENTS.map((environment) => ({ path: envLayerFiles(ENV_FILE, environment).at(-1), contents: renderEnvOverlayStub(environment) })),
    { path: 'README.md', contents: renderReadme(answers) },
  ];

  // The target NAME is its folder (#886); its `type` names the framework
  for (const entry of answers.targets) {
    plan.push({ path: `targets/${entry.name}/package.json`, contents: renderTargetPackageJson(answers, entry) });
  }

  return plan;
}

/**
 * Write a scaffold plan with fill-missing semantics: files that already
 * exist are never touched (rerunning onboard converges instead of clobbering).
 * The one exception is a file carrying the template marker, which the
 * generated file replaces.
 *
 * @param {string} brandRoot - Absolute brand root to scaffold into
 * @param {Array<{ path, contents }>} plan - From buildScaffoldPlan()
 * @param {Object} [options] - { dryRun }: plan only, zero writes
 * @returns {{ created: string[], kept: string[], replaced: string[], planned: string[] }}
 */
function applyScaffoldPlan(brandRoot, plan, { dryRun = false } = {}) {
  const created = [];
  const kept = [];
  const replaced = [];
  const planned = [];

  for (const file of plan) {
    const destination = path.join(brandRoot, file.path);
    const exists = jetpack.exists(destination);
    const takeover = exists && carriesTemplateMarker(destination);

    if (exists && !takeover) {
      kept.push(file.path);
      continue;
    }

    if (dryRun) {
      planned.push(file.path);
      continue;
    }

    jetpack.write(destination, file.contents);
    (takeover ? replaced : created).push(file.path);
  }

  return { created, kept, replaced, planned };
}

/**
 * Print what a plan did: the one rendering of created/kept/replaced/planned,
 * shared by every scaffolding verb (onboard's brand plan, company init's).
 */
function printPlanResults({ created, kept, replaced, planned }) {
  for (const file of planned) {
    console.log(`  ${chalk.dim('⊘')} would create ${chalk.cyan(file)}`);
  }
  for (const file of created) {
    console.log(`  ${chalk.green('✓')} created ${chalk.cyan(file)}`);
  }
  for (const file of replaced) {
    console.log(`  ${chalk.green('✓')} replaced ${chalk.cyan(file)} ${chalk.dim('(the template\'s copy)')}`);
  }
  for (const file of kept) {
    console.log(`  ${chalk.dim('•')} kept ${chalk.dim(file)} ${chalk.dim('(exists)')}`);
  }
}

module.exports = { buildScaffoldPlan, applyScaffoldPlan, printPlanResults, targetSeeds };
