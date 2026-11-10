/**
 * Onboard wizard tests: non-interactive flag/derivation paths, the real
 * interactive wizard over fake TTY streams, fill-missing (never-overwrite)
 * semantics, dry-run, the company field (#677), resume inside an existing
 * brand, the manage handoff, and the manage pins: workspace green on a fresh
 * scaffold, testing honestly nudging toward the update service.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSON5 = require('json5');

// Before the source loads: no real npm install, dev stack or GitHub call
const { driveWizard } = require('./lib/onboard-seams.js');
const { recordBrand } = require('@omega.js/config');

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677). Tests that need their own
// home still override it per test.
require('@omega.js/devkit/test/temp-home');

const { runOnboard, deriveId, deriveName, deriveUrl, deriveEmail } = require('../src/onboard.js');
const { runManage } = require('../src/manage.js');
const { buildScaffoldPlan } = require('../src/lib/scaffold.js');
const { openTtyPrompt } = require('./lib/interactive.js');
const { createMachine } = require('./lib/fake-claude.js');
const { toolProbe } = require('./lib/tool-probe.js');

// Every scaffolded @omega.js/* spec is this exact number (#794)
const MANAGER_VERSION = require('../package.json').version;

// Onboarding and manage reach for `claude`. File-wide that is a fake machine
// that already has the plugin, so no wizard below meets the install offer and
// nothing here touches the real ~/.claude; the offer's own tests swap in theirs.
createMachine({
  marketplaces: { omega: { source: 'github', repo: 'Omega-JS-Stack/omega' } },
  installed: { 'omega@omega': MANAGER_VERSION },
  published: MANAGER_VERSION,
}).activate();

// Fixture brands must never reach a real external account via shell-exported
// credentials — every service must skip in the manage pins and the handoff
// child process (which inherits this env)
delete process.env.GH_TOKEN;
delete process.env.CLOUDFLARE_TOKEN;
delete process.env.NAMECHEAP_USERNAME;
delete process.env.NAMECHEAP_API_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.RECAPTCHA_SITE_KEY;
delete process.env.RECAPTCHA_SECRET_KEY;
delete process.env.META_ACCESS_TOKEN;
delete process.env.TIKTOK_ACCESS_TOKEN;
delete process.env.SENDGRID_API_KEY;
delete process.env.OMEGA_WEBHOOK_KEY;
delete process.env.BEEHIIV_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYPAL_CLIENT_SECRET;
delete process.env.CHARGEBEE_API_KEY;
delete process.env.SLAPFORM_SERVICE_ACCOUNT;
delete process.env.CHATSY_SERVICE_ACCOUNT;
delete process.env.REPLYIFY_SERVICE_ACCOUNT;
delete process.env.SERVER_SERVICE_ACCOUNT;
delete process.env.APPLE_API_ISSUER;
delete process.env.APPLE_API_KEY_ID;
delete process.env.APPLE_TEAM_ID;
delete process.env.CSC_KEY_PASSWORD;
delete process.env.APPLE_KEYCHAIN_PASSWORD;
delete process.env.ACCOUNT_PASSWORD_SEED;

const FAKE_FETCH_200 = { fetch: async () => ({ status: 200, json: async () => ({}) }), retryDelayMs: 0 };

function tempDir(prefix = 'omega-onboard-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readConfig(root) {
  return JSON5.parse(fs.readFileSync(path.join(root, 'config', 'omega.json5'), 'utf8'));
}

// Scaffolded target package.jsons pin their framework at the family version
// (#794); stub the packages at the brand root so the update service's
// resolution climb passes without the registry (pre-publish, and tests must
// never install). The stub carries the family version too — a real install
// does, and the lockstep gate refuses a walk on anything else.
function stubFrameworks(root, names) {
  for (const name of names) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: MANAGER_VERSION }));
  }
  // A real install links every framework's `omega` bin, which the derived target
  // scripts (`build: omega build`) call; the stub's answers every verb with success
  const bin = path.join(root, 'node_modules', '.bin', 'omega');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

// ─── The Claude plugin offer ─────────────────────────────────────────────────

// `Claude` in an answer list is the install offer
const OFFER_FLAGS = { name: 'Offer Brand', url: 'https://offerbrand.com', targets: 'web', manage: false };
const WIZARD_ANSWERS = {
  'Company brand id': '\r',
  'Brand description': '\r',
  'Brand tagline': '\r',
  'Keep this account list?': '\r',
};

module.exports = defineCases({
  type: 'group',
  description: 'onboard',
  tests: [
    // ─── Derivation units ────────────────────────────────────────────────────────

    {
      name: 'deriveId/deriveName/deriveUrl: dir names → wizard defaults',
      run: (ctx) => {
        ctx.expect(deriveId('My Brand 2')).toBe('my-brand-2');
        ctx.expect(deriveId('acme-demo')).toBe('acme-demo');
        ctx.expect(deriveId('123-acme')).toBe('acme'); // ids start with a letter
        ctx.expect(deriveId('!!!')).toBe(null);

        ctx.expect(deriveName('acme-demo')).toBe('Acme Demo');
        ctx.expect(deriveUrl('acme-demo')).toBe('https://acmedemo.com'); // dashes drop out (omega-manager parity)
      },
    },

    {
      name: 'deriveEmail: a default Pages url derives no address, so the ask offers no support@<pages host>',
      run: (ctx) => {
        ctx.expect(deriveEmail('https://ian.github.io')).toBe('');
      },
    },

    {
      name: 'scaffold: a brand with no derived email writes no brand.contact block at all',
      run: (ctx) => {
        const plan = buildScaffoldPlan({
          id: 'pages-brand',
          name: 'Pages Brand',
          url: 'https://ian.github.io',
          email: deriveEmail('https://ian.github.io'),
          accountAdmins: [],
          targets: [{ name: 'web', type: 'web' }],
        });
        const config = JSON5.parse(plan.find((file) => file.path === 'config/omega.json5').contents);
        ctx.expect(config.brand.url).toBe('https://ian.github.io');
        ctx.expect('contact' in config.brand, 'no contact key, not an empty one').toBe(false);
      },
    },

    // ─── Non-interactive (flags + derivation) ────────────────────────────────────

    {
      name: 'fresh onboard initializes git with a first commit that honors .gitignore (cp196)',
      run: async (ctx) => {
        const root = tempDir();

        const report = await runOnboard(root, { id: 'gitful', manage: false });

        ctx.expect(report.git.initialized).toBe(true);
        ctx.expect(report.git.committed).toBe(true);
        ctx.expect(fs.existsSync(path.join(root, '.git')), '.git exists').toBeTruthy();

        const { spawnSync } = require('node:child_process');
        const count = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
        ctx.expect(count.stdout.trim(), 'exactly one commit').toBe('1');

        const tracked = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).stdout;
        ctx.expect(tracked.includes('config/omega.json5'), 'config committed').toBeTruthy();
        ctx.expect(tracked.includes('package.json'), 'manifest committed').toBeTruthy();
        ctx.expect(!tracked.includes('.env'), '.env never committed (scaffolded .gitignore is live before the commit)').toBeTruthy();
      },
    },

    {
      name: 'onboard inside an existing work tree skips git init (cp196)',
      run: async (ctx) => {
        const root = tempDir();
        const { spawnSync } = require('node:child_process');
        spawnSync('git', ['-C', root, 'init'], { stdio: 'ignore' });

        const report = await runOnboard(root, { id: 'nested', manage: false });

        ctx.expect(report.git.initialized).toBe(false);
        ctx.expect(report.git.reason).toBe('existing repository');
        const count = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
        ctx.expect(count.stdout.trim(), 'no commit was made on the existing repo').not.toBe('1');
      },
    },

    {
      name: 'non-interactive: full flags scaffold the complete brand monorepo',
      run: async (ctx) => {
        const root = tempDir();

        const report = await runOnboard(root, {
          id: 'acme',
          name: 'Acme Inc',
          url: 'https://acme.io',
          description: 'Rockets and anvils',
          tagline: 'Beep beep',
          targets: 'web,backend,desktop',
          manage: false,
          execFn: toolProbe(),
        });

        ctx.expect(report.mode).toBe('fresh');
        ctx.expect(report.brandRoot).toBe(root);
        ctx.expect(report.valid).toBe(true);
        ctx.expect(report.created.sort()).toEqual([
          '.env',
          '.env.development',
          '.env.production',
          '.env.testing',
          '.gitignore',
          'README.md',
          'config/omega.json5',
          'package.json',
          'targets/backend/package.json',
          'targets/desktop/package.json',
          'targets/web/package.json',
        ]);
        ctx.expect(report.kept).toEqual([]);

        const config = readConfig(root);
        ctx.expect(config.brand).toEqual({
          id: 'acme',
          name: 'Acme Inc',
          description: 'Rockets and anvils',
          tagline: 'Beep beep',
          url: 'https://acme.io',
          contact: { email: 'support@acme.io' },
        });
        ctx.expect(config.theme).toEqual({ id: 'classy', appearance: 'system' });
        // Socials seed EMPTY (#462): every surface that reads the block (the footer
        // row, sameAs, the /<platform> shortlinks) shows what the brand DECLARED —
        // a seeded platform key would print a link to a profile nobody owns
        ctx.expect(config.socials).toEqual({});
        ctx.expect(Object.keys(config.targets)).toEqual(['web', 'backend', 'desktop']);
        // Every entry declares its TYPE (#886): the key is the name and the folder,
        // the type says which framework runs there
        ctx.expect(config.targets).toEqual({ web: { type: 'web' }, backend: { type: 'backend' }, desktop: { type: 'desktop' } });
        // Desktop target → the reverse-DNS bundle prefix seeds (derived from the url)
        ctx.expect(config.certificates).toEqual({ providers: { apple: { bundleIdPrefix: 'io.acme' } } });
        // `targets` is the LAST top-level key in the seeded config (canonical order)
        ctx.expect(Object.keys(config).at(-1)).toBe('targets');

        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        ctx.expect(pkg.name).toBe('acme');
        ctx.expect(pkg.private).toBe(true);
        // npm's own word for closed-source commercial code (#884). Every scaffolded
        // manifest states it, because a target's license field is what the Firefox
        // lane sends AMO when it creates the brand's listing (all-rights-reserved)
        ctx.expect(pkg.license).toBe('UNLICENSED');
        ctx.expect(pkg.workspaces).toEqual(['targets/*']);
        // Brand-root verbs resolve the manager FROM the brand root (omega-bin) —
        // the scaffold must declare it or nothing installs it outside the monorepo
        // (cp195 journey catch)
        // Exact pin, the manager's own version — the family ships lockstep (#794)
        ctx.expect(pkg.devDependencies).toEqual({ '@omega.js/manager': MANAGER_VERSION });
        // Scripts say `omega` — the ONE user-facing verb (the retired omega-manager
        // name never scaffolds; npm scripts put node_modules/.bin on PATH, cp251).
        // `npm start` boots the dev stack; the manage cycle is the NAMED verb (#229)
        ctx.expect(pkg.scripts).toEqual({
          start: 'omega dev', dev: 'omega dev', manage: 'omega manage', deploy: 'omega deploy',
        });

        // README speaks `npx omega` too — no user-facing surface names the old bin
        const readmeText = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        ctx.expect(readmeText.includes('npx omega')).toBeTruthy();
        ctx.expect(!readmeText.includes('omega-manager'), 'README never mentions the retired bin name').toBeTruthy();

        const targetPkg = JSON.parse(fs.readFileSync(path.join(root, 'targets', 'web', 'package.json'), 'utf8'));
        ctx.expect(targetPkg.name).toBe('acme-web');

        // Every target, not just the root: the license travels with the manifest a
        // store reads it from (#884)
        for (const target of ['web', 'backend', 'desktop']) {
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'targets', target, 'package.json'), 'utf8'));
          ctx.expect(manifest.license, `targets/${target} states its license`).toBe('UNLICENSED');
        }

        // cp95a seeds: framework dep per target — the backend's is a RUNTIME
        // dependency on its ONE target manifest (src/dist pillar: the stage derives
        // dist/package.json from it), every other target's is a devDependency —
        // plus a bootable demo-* cloud project and the starter catalog as a comment
        ctx.expect(targetPkg.devDependencies).toEqual({ '@omega.js/web': MANAGER_VERSION });
        const backendPkg = JSON.parse(fs.readFileSync(path.join(root, 'targets', 'backend', 'package.json'), 'utf8'));
        ctx.expect(backendPkg.dependencies).toEqual({ '@omega.js/backend': MANAGER_VERSION });
        ctx.expect(backendPkg.devDependencies, 'backend framework is a runtime dep, not dev').toBe(undefined);
        ctx.expect(config.cloud).toEqual({ provider: 'firebase', config: { projectId: 'demo-acme' } });
        const rawConfig = fs.readFileSync(path.join(root, 'config', 'omega.json5'), 'utf8');
        ctx.expect(rawConfig, 'starter catalog ships commented').toMatch(/\/\/ payment: \{/);
        ctx.expect(config.payment, 'catalog is a comment, not config').toBe(undefined);

        // The .env stub documents the credential entry points: external keys
        // commented out, omega-owned keys provisioned with generated secrets
        const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
        ctx.expect(env.includes('# CLOUDFLARE_TOKEN=""')).toBeTruthy();
        ctx.expect(env.includes('# STRIPE_SECRET_KEY=""')).toBeTruthy();
        ctx.expect(env).toMatch(/^OMEGA_ADMIN_KEY="[A-Za-z0-9_-]{43}"$/m);
        ctx.expect(env).toMatch(/^OMEGA_WEBHOOK_KEY="[A-Za-z0-9_-]{43}"$/m);
        ctx.expect(env).toMatch(/^OMEGA_NAMESPACE="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/m);
        // The email signing key is minted here too since #569 — a brand that never
        // gets one crashes on its first order email
        ctx.expect(env).toMatch(/^UNSUBSCRIBE_HMAC_KEY="[0-9a-f]{64}"$/m);
        ctx.expect(env.match(/^OMEGA_ADMIN_KEY=(.+)$/m)[1]).not.toBe(env.match(/^OMEGA_WEBHOOK_KEY=(.+)$/m)[1]);
        const uncommented = env.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
        const generated = Object.keys(require('@omega.js/config').generatedEnvKeys());
        ctx.expect(uncommented.every((line) => generated.some((key) => line.startsWith(`${key}=`))), 'only omega-generated keys are provisioned').toBeTruthy();

        const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
        // logs/ joins the list with #197 — every verb writes one there now.
        for (const entry of ['node_modules/', '.omega/', '.env', 'dist/', 'logs/']) {
          ctx.expect(gitignore.includes(entry), `gitignore missing ${entry}`).toBeTruthy();
        }
        ctx.expect(gitignore.startsWith('# ========== Default Values ==========\n'), 'the scaffold writes the marked file the workspace service heals').toBeTruthy();
        ctx.expect(gitignore.endsWith('\n# ========== Custom Values ==========\n'), 'its Custom section is only its marker line').toBeTruthy();
      },
    },

    {
      name: 'non-interactive: everything derives from the directory name',
      run: async (ctx) => {
        const parent = tempDir();
        const root = path.join(parent, 'sweet-saucy');
        fs.mkdirSync(root);

        const report = await runOnboard(root, { manage: false });

        ctx.expect(report.valid).toBe(true);
        const config = readConfig(root);
        ctx.expect(config.brand.id).toBe('sweet-saucy');
        ctx.expect(config.brand.name).toBe('Sweet Saucy');
        ctx.expect(config.brand.url).toBe('https://sweetsaucy.com');
        ctx.expect(config.brand.contact.email).toBe('support@sweetsaucy.com');
        // Optional fields stay OUT of the config instead of landing as empty strings
        ctx.expect(!('description' in config.brand)).toBeTruthy();
        ctx.expect(!('tagline' in config.brand)).toBeTruthy();
        // Target default: the website alone
        ctx.expect(Object.keys(config.targets)).toEqual(['web']);
      },
    },

    {
      name: 'non-interactive: --contactName is no longer a flag: no person is written',
      run: async (ctx) => {
        const root = tempDir();

        const report = await runOnboard(root, { id: 'flagged', url: 'https://flagged.test', contactName: 'Wile E. Coyote, CEO', manage: false });

        ctx.expect(report.valid).toBe(true);
        ctx.expect(readConfig(root).brand.contact).toEqual({ email: 'support@flagged.test' });
      },
    },

    {
      name: 'non-interactive: underivable id is a clear error, bad flag values throw',
      run: async (ctx) => {
        const parent = tempDir();
        const root = path.join(parent, '№∆');
        fs.mkdirSync(root);

        await ctx.expect((() => runOnboard(root, { manage: false }))()).rejects.toThrow(/--id=<id>/);
        await ctx.expect((() => runOnboard(root, { id: 'Bad_Id', manage: false }))()).rejects.toThrow(/Invalid brand id/);
        await ctx.expect((() => runOnboard(root, { id: 'ok', url: 'ftp://x', manage: false }))()).rejects.toThrow(/Invalid brand url/);
        await ctx.expect((() => runOnboard(root, { id: 'ok', targets: 'web,gopher', manage: false }))()).rejects.toThrow(/Unknown target\(s\): gopher/);

        // Nothing was written by any failed attempt
        ctx.expect(fs.readdirSync(root)).toEqual([]);
      },
    },

    // ─── Interactive wizard (real prompts over fake TTY streams) ─────────────────

    {
      name: 'interactive: the full wizard — typed id, accepted defaults, checkbox targets, manage declined',
      run: async (ctx) => {
        const root = tempDir();
        const tty = openTtyPrompt();

        try {
          const run = runOnboard(root, {});

          await tty.answer('Brand ID:', 'wizard-brand\r');
          await tty.answer('Brand name:', '\r');                    // accept derived: Wizard Brand
          await tty.answer('Brand URL:', '\r');                     // accept derived: https://wizardbrand.com
          await tty.answer('Company brand id', '\r');               // blank → standalone, no company key
          await tty.answer('Brand description', 'A wizard-made brand\r');
          await tty.answer('Brand tagline', '\r');                  // empty → omitted
          await tty.answer('Targets (', '\r');                      // accept the checked default: web
          await tty.answer('Keep this account list?', '\r');        // inherit → nothing written
          await tty.answer('Run manage now?', 'n\r');

          const report = await run;

          ctx.expect(report.mode).toBe('fresh');
          ctx.expect(report.valid).toBe(true);
          ctx.expect(report.manageExitCode).toBe(null);

          const config = readConfig(root);
          ctx.expect(config.brand.id).toBe('wizard-brand');
          ctx.expect(config.brand.name).toBe('Wizard Brand');
          ctx.expect(config.brand.url).toBe('https://wizardbrand.com');
          ctx.expect(config.brand.description).toBe('A wizard-made brand');
          ctx.expect(!('tagline' in config.brand)).toBeTruthy();
          // No contact person is asked for, and none is written
          await ctx.expect(tty.waitFor('Contact person', 0)).rejects.toThrow(/Timed out/);
          ctx.expect(config.brand.contact).toEqual({ email: 'support@wizardbrand.com' });
          ctx.expect(Object.keys(config.targets)).toEqual(['web']);
          // Inherited account list stays unwritten — the source layer keeps owning it
          ctx.expect(!('account' in config)).toBeTruthy();
          // A blank company answer is the standalone brand: no key at all (#677)
          ctx.expect(!('company' in config)).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'interactive: customizing the account list writes account.admins into the brand config',
      run: async (ctx) => {
        const root = tempDir();
        const tty = openTtyPrompt();

        try {
          const run = runOnboard(root, { id: 'accounts-brand', name: 'Accounts Brand', url: 'https://accountsbrand.com', targets: 'web,backend', execFn: toolProbe() });

          await tty.answer('Company brand id', '\r');
          await tty.answer('Brand description', '\r');
          await tty.answer('Brand tagline', '\r');
          await tty.answer('Keep this account list?', 'n\r');
          await tty.answer('Account email', 'boss@{domain}\r');
          await tty.answer('Manage the Firebase Auth account', '\r');   // yes (default)
          await tty.answer('Sync the contact to marketing providers?', 'n\r');
          await tty.answer('Add another account?', '\r');               // no (default)
          await tty.answer('Run manage now?', 'n\r');

          const report = await run;
          ctx.expect(report.valid).toBe(true);

          const config = readConfig(root);
          ctx.expect(config.account).toEqual({
            admins: [{ email: 'boss@{domain}', account: true, marketing: false }],
          });
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'interactive: dry-run never prompts, even with a TTY, and writes nothing',
      run: async (ctx) => {
        const parent = tempDir();
        const root = path.join(parent, 'dry-brand');
        fs.mkdirSync(root);
        const tty = openTtyPrompt();

        try {
          // No tty.answer() calls — a prompt would hang this until the timeout
          const report = await runOnboard(root, { dryRun: true });

          ctx.expect(report.created.length).toBe(0);
          ctx.expect(report.planned.includes('config/omega.json5')).toBeTruthy();
          ctx.expect(fs.readdirSync(root)).toEqual([]);
        } finally {
          tty.close();
        }
      },
    },

    // ─── Fill-missing semantics ──────────────────────────────────────────────────

    {
      name: 'rerun converges: second onboard keeps every file, existing files are never overwritten',
      run: async (ctx) => {
        const root = tempDir();
        const custom = '{\n  "name": "hand-tuned",\n  "private": true,\n  "workspaces": ["targets/*"]\n}\n';
        fs.writeFileSync(path.join(root, 'package.json'), custom);

        const first = await runOnboard(root, { id: 'keeper', manage: false });
        ctx.expect(first.kept).toEqual(['package.json']);
        ctx.expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(custom);

        const second = await runOnboard(root, { manage: false });
        ctx.expect(second.mode).toBe('resume');
        ctx.expect(second.created.length).toBe(0);
        ctx.expect(second.kept.length).toBe(first.created.length + 1);
      },
    },

    {
      name: 'resume from inside an existing brand: answers come from its config, only gaps fill in',
      run: async (ctx) => {
        const root = tempDir();
        fs.mkdirSync(path.join(root, 'config'));
        fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{
    brand: { id: 'existing', name: 'Existing Brand', url: 'https://existing.test' },
    targets: { web: { type: 'web' } },
  }`);
        fs.mkdirSync(path.join(root, 'targets', 'web'), { recursive: true });
        fs.writeFileSync(path.join(root, 'targets', 'web', 'package.json'), '{ "name": "existing-web" }\n');

        // From INSIDE the target dir — the brand root resolves by walk-up
        const report = await runOnboard(path.join(root, 'targets', 'web'), { manage: false });

        ctx.expect(report.mode).toBe('resume');
        ctx.expect(report.brandRoot).toBe(root);
        ctx.expect(report.created.sort()).toEqual(['.env', '.env.development', '.env.production', '.env.testing', '.gitignore', 'README.md', 'package.json']);

        // Scaffolded files carry the EXISTING brand's identity, not derived guesses
        const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        ctx.expect(readme.startsWith('# Existing Brand')).toBeTruthy();
      },
    },

    {
      name: 'resume: a target NAMED admin scaffolds targets/admin around its declared type (#886)',
      run: async (ctx) => {
        const root = tempDir();
        fs.mkdirSync(path.join(root, 'config'));
        fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{
    brand: { id: 'named', name: 'Named Brand', url: 'https://named.test' },
    targets: { web: { type: 'web' }, admin: { type: 'web' } },
  }`);

        const report = await runOnboard(root, { manage: false });

        ctx.expect(report.mode).toBe('resume');
        ctx.expect(report.created.includes('targets/admin/package.json'), 'the NAME is the folder').toBeTruthy();

        // The TYPE picks the framework, so the admin target is a web target
        const adminPkg = JSON.parse(fs.readFileSync(path.join(root, 'targets', 'admin', 'package.json'), 'utf8'));
        ctx.expect(adminPkg.name).toBe('named-admin');
        ctx.expect(adminPkg.devDependencies).toEqual({ '@omega.js/web': MANAGER_VERSION });

        // README lists it by name, and the brand's own config is never rewritten
        const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        ctx.expect(readme).toMatch(/`targets\/admin\/`/);
        ctx.expect(Object.keys(readConfig(root).targets)).toEqual(['web', 'admin']);
      },
    },

    // ─── Legacy port ─────────────────────────────────────────────────────────────

    {
      name: 'port: a carried legacy oauth.json converts ONCE into the canonical google-oauth.json (#501)',
      run: async (ctx) => {
        const root = tempDir();
        const secrets = path.join(root, '.omega', 'secrets');
        fs.mkdirSync(secrets, { recursive: true });
        fs.writeFileSync(path.join(secrets, 'oauth.json'), `${JSON.stringify({
          googleClientId: '1234-abc.apps.googleusercontent.com',
          googleClientSecret: 'legacy-secret',
        }, null, 2)}\n`);

        // The write gate holds: a dry run plans and converts nothing
        const dry = await runOnboard(root, { id: 'ported', manage: false, dryRun: true });
        ctx.expect(dry.legacyOAuth).toBe(undefined);
        ctx.expect(fs.existsSync(path.join(secrets, 'google-oauth.json'))).toBe(false);

        const report = await runOnboard(root, { id: 'ported', manage: false });

        ctx.expect(report.legacyOAuth.converted).toBe(true);
        ctx.expect(JSON.parse(fs.readFileSync(path.join(secrets, 'google-oauth.json'), 'utf8'))).toEqual({ clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'legacy-secret' });
        // One-time: the inert legacy file is gone, so nothing dual-reads it later
        ctx.expect(fs.existsSync(path.join(secrets, 'oauth.json'))).toBe(false);

        const rerun = await runOnboard(root, { manage: false });
        ctx.expect(rerun.legacyOAuth.converted).toBe(false);
      },
    },

    // ─── The company field (#677) ────────────────────────────────────────────────

    {
      name: 'company: the wizard asks ONE field, and the answer lands as the top-level key',
      run: async (ctx) => {
        const dir = tempDir('omega-onboard-co-');
        const root = path.join(dir, 'acme');
        fs.mkdirSync(root);
        const tty = openTtyPrompt();

        // The parent on this machine: its own run's registry line is what makes a
        // child's `company: { id }` resolvable
        const parent = path.join(dir, 'fixture-co');
        fs.mkdirSync(path.join(parent, 'config'), { recursive: true });
        fs.writeFileSync(path.join(parent, 'config', 'omega.json5'), `{
    brand: { id: 'fixture-co', name: 'Fixture Co', url: 'https://fixture-co.com' },
    company: { id: 'self' },
  }`);

        const previousHome = process.env.OMEGA_HOME;
        process.env.OMEGA_HOME = path.join(dir, 'home');
        ctx.after(() => {
          tty.close();
          if (previousHome === undefined) delete process.env.OMEGA_HOME;
          else process.env.OMEGA_HOME = previousHome;
        });
        recordBrand({ id: 'fixture-co', root: parent, name: 'Fixture Co', url: 'https://fixture-co.com' });

        const run = runOnboard(root, { id: 'acme', name: 'Acme', url: 'https://acme.com', targets: 'web', manage: false });

        await tty.answer('Company brand id', 'fixture-co\r');
        await tty.answer('Brand description', '\r');
        await tty.answer('Brand tagline', '\r');
        await tty.answer('Keep this account list?', '\r');

        const report = await run;

        ctx.expect(report.mode).toBe('fresh');
        ctx.expect(report.valid).toBe(true);

        // The one key, outside `brand`, and nothing else about the relationship
        const config = readConfig(root);
        ctx.expect(config.company).toEqual({ id: 'fixture-co' });
        ctx.expect(fs.existsSync(path.join(root, '.omega', 'company.json')), 'the stamp is retired (#677)').toBe(false);

        // The signing prefix comes from the COMPANY's domain, not the brand's
        ctx.expect(config.certificates?.providers?.apple?.bundleIdPrefix, 'no signing target, no prefix written').toBe(undefined);

        // Onboarding the same brand again converges and keeps the answer; Enter keeps the current targets
        const rerun = runOnboard(root, { manage: false });
        await tty.answer('Targets (', '\r');
        const again = await rerun;
        ctx.expect(again.mode).toBe('resume');
        ctx.expect(again.created.length).toBe(0);
        ctx.expect(readConfig(root).company).toEqual({ id: 'fixture-co' });
      },
    },

    // ─── Manage pins ─────────────────────────────────────────────────────────────

    {
      name: 'fresh scaffold runs the workspace service green',
      run: async (ctx) => {
        const root = tempDir();
        await runOnboard(root, { id: 'green', targets: 'web,backend', manage: false, execFn: toolProbe() });

        const report = await runManage(root, { service: 'workspace', execFn: toolProbe() });

        ctx.expect(report.hasErrors).toBe(false);
        ctx.expect(report.results.workspace.status).toBe('success');
      },
    },

    {
      name: 'full manage on a fresh brand: services skip cleanly, testing honestly nudges toward the frameworks',
      run: async (ctx) => {
        const root = tempDir();
        await runOnboard(root, { id: 'nudge', targets: 'web,backend', manage: false, execFn: toolProbe() });
        // Both declared frameworks stubbed (the backend's is a runtime dep on its
        // target manifest since the src/dist pillar) — mirrors a post-`mgr i local` brand
        stubFrameworks(root, ['@omega.js/web', '@omega.js/backend']);

        const report = await runManage(root, { ...FAKE_FETCH_200, execFn: toolProbe() });

        // The scaffold itself is sound…
        ctx.expect(report.results.workspace.status).toBe('success');
        ctx.expect(report.results.update.status).toBe('success');

        // …every external service skips (no credentials, no config)…
        for (const [service, result] of Object.entries(report.results)) {
          if (service !== 'testing') {
            ctx.expect(result.status, `${service} should not error on a fresh brand`).not.toBe('error');
          }
        }

        // …and testing names exactly what's missing: the targets' framework internals
        ctx.expect(report.hasErrors).toBe(true);
        ctx.expect(report.results.testing.status).toBe('error');
        ctx.expect(report.results.testing.error).toMatch(/build output/);
        ctx.expect(report.results.testing.error).toMatch(/firebase\.json/);
      },
    },

    {
      name: 'manage handoff: --manage spawns the real CLI in the new brand',
      run: async (ctx) => {
        const parent = tempDir();
        const root = path.join(parent, 'handoff-brand');
        fs.mkdirSync(root);
        stubFrameworks(root, ['@omega.js/web']);

        // localhost URL → the testing service's live checks fail fast (connection
        // refused, no DNS wait); the child's honest exit 1 comes back through
        const report = await runOnboard(root, {
          id: 'handoff-brand',
          url: 'https://localhost:9',
          targets: 'web',
          manage: true,
        });

        ctx.expect(report.manageExitCode).not.toBe(null);
        ctx.expect(report.manageExitCode).toBe(1); // testing: build output missing — the designed nudge

        // The child actually ran manage: run output landed in .omega/runs/
        const runs = fs.readdirSync(path.join(root, '.omega', 'runs'));
        ctx.expect(runs.length).toBe(1);
        const run = JSON.parse(fs.readFileSync(path.join(root, '.omega', 'runs', runs[0]), 'utf8'));
        ctx.expect(run.brandId).toBe('handoff-brand');
      },
    },

    {
      name: 'case 16: in a terminal with claude and no plugin, onboarding offers the install, and yes installs it for the user',
      run: async (ctx) => {
        const machine = createMachine({ published: MANAGER_VERSION });
        ctx.after(machine.activate());
        const tty = openTtyPrompt();
        ctx.after(() => tty.close());

        const { report, asked } = await driveWizard(tty, runOnboard(tempDir(), { id: 'offer-yes', ...OFFER_FLAGS }), { ...WIZARD_ANSWERS, Claude: 'y\r' });

        ctx.expect(report.valid).toBe(true);
        ctx.expect(asked.includes('Claude'), 'the install was offered').toBeTruthy();
        const { records, installed, settings } = machine.state();
        ctx.expect([records.omega.source.source, records.omega.source.repo]).toEqual(['github', 'Omega-JS-Stack/omega']);
        ctx.expect(installed['omega@omega'][0].scope).toBe('user');
        ctx.expect(settings.enabledPlugins['omega@omega']).toBe(true);
      },
    },

    {
      name: 'case 16: no to the offer changes nothing on the machine',
      run: async (ctx) => {
        const machine = createMachine({ published: MANAGER_VERSION });
        ctx.after(machine.activate());
        const tty = openTtyPrompt();
        ctx.after(() => tty.close());

        const { report, asked } = await driveWizard(tty, runOnboard(tempDir(), { id: 'offer-no', ...OFFER_FLAGS }), { ...WIZARD_ANSWERS, Claude: 'n\r' });

        ctx.expect(report.valid).toBe(true);
        ctx.expect(asked.includes('Claude'), 'the install was offered').toBeTruthy();
        ctx.expect(machine.mutations()).toEqual([]);
        ctx.expect(machine.state()).toEqual({ records: {}, settings: {}, installed: {} });
      },
    },

    {
      name: 'case 16: with no terminal, onboarding does not ask and installs nothing',
      run: async (ctx) => {
        const machine = createMachine({ published: MANAGER_VERSION });
        ctx.after(machine.activate());

        const report = await runOnboard(tempDir(), { id: 'offer-headless', ...OFFER_FLAGS });

        ctx.expect(report.valid).toBe(true);
        ctx.expect(machine.mutations()).toEqual([]);
        ctx.expect(machine.state().installed).toEqual({});
      },
    },
  ],
});
