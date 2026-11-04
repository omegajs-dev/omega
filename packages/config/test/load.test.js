/**
 * Loader tests for @omega.js/config — file discovery (standalone + standalone
 * backend + brand monorepo), the five-layer resolution chain, targets
 * semantics, and the raw-file hard fails (secrets, legacy targets array).
 *
 * Fixtures are built under packages/config/.temp/ (gitignored), matching the
 * devkit test convention.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The machine registry is per-machine state: this file's fixtures record into a temp home.
require('@omega.js/devkit/test/temp-home');

const { loadConfig, composeTargetConfig, hasOmegaConfig, resolveConfigPath, getEnabledTargets, resolveBrandRoot, recordBrand, overlayPath } = require('../src/index.js');

const TEMP_ROOT = path.join(__dirname, '..', '.temp');

// Build a fixture tree ({ 'relative/path': contents }) and return its root.
function makeFixture(name, files) {
  const root = path.join(TEMP_ROOT, `${name}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(files)) {
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

function cleanup(t, root) {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
}

// ─── Brand-monorepo hierarchy ───

// One probe key set at every layer proves the full chain order; sibling keys
// prove each layer actually contributes (nothing is dropped, only overridden).
const BRAND_MONOREPO = {
  'config/omega.json5': `{
    brand: { id: 'acme', name: 'Acme' },
    monitoring: { providers: { sentry: { dsn: 'https://brand-shared.example.com' } } },
    probe: { value: 'brand-shared', fromBrandShared: true },
    targets: {
      backend: { type: 'backend', probe: { value: 'brand-target', fromBrandTarget: true }, repo: { owner: 'acme-org' } },
      web: { type: 'web' },
    },
  }`,
  'targets/backend/config/omega.json5': `{
    probe: { value: 'local-shared', fromLocalShared: true },
    targets: {
      backend: { type: 'backend',
        probe: { value: 'local-target', fromLocalTarget: true },
        monitoring: { providers: { sentry: { dsn: 'https://backend-override.example.com' } } },
      },
    },
  }`,
};

// ─── composeTargetConfig (#31 — the deploy upload boundary) ───

// Brand + local fixture exercising every interleave position, INCLUDING the
// corner a naive whole-file merge gets wrong: `corner` is set by brand
// TARGET and LOCAL SHARED — the local-shared value wins (it merges later), and a
// raw merged targets map would re-apply the brand-target value above it.
const COMPOSE_TREE = {
  'config/omega.json5': `{
    brand: { id: 'acme', name: 'Acme Corp', url: 'https://acme.test' },
    shade: 'brand-shared',
    corner: 'from-brand-shared',
    targets: {
      backend: { type: 'backend', flavor: 'from-brand-target', corner: 'from-brand-target' },
      web: { type: 'web' },
    },
  }`,
  'targets/backend/config/omega.json5': `{
    corner: 'from-local-shared',
    targets: { backend: { type: 'backend', flavor: 'from-local-target' } },
  }`,
};

const COMPOSE_DEFAULTS = {
  brand: { id: 'my-app', name: 'My Brand' },
  corner: 'from-defaults',
  defaultOnly: true,
};

// ─── The Pages brand: no domain of its own ───

// A brand whose web target is served from GitHub Pages under its owner. The
// address is the literal GitHub serves, never recomputed from owner and id.
const PAGES_ADDRESS = 'https://dreamr-design.github.io/dreamr-web';

function pagesBrand(targets) {
  return `{
    brand: { id: 'dreamr', name: 'Dreamr' },
    repo: { owner: 'dreamr-design' },
    targets: ${targets},
  }`;
}

// ─── The company layer (#54, reshaped by #677) ───

// A PARENT brand carrying a company/ tree, and a brand that names it with one
// typed key: the company file is the layer between framework defaults and the
// brand file, and where the parent lives on this machine is the registry's
// answer, never a stamp.
function makeCompanyFixture(t, name, extra) {
  const workspace = makeFixture(name, Object.assign({
    'parent/config/omega.json5': `{
      brand: { id: 'acme-co', name: 'Acme Inc', url: 'https://acme-co.test' },
      company: { id: 'self' },
    }`,
    'parent/company/config/omega.json5': `{
      monitoring: { providers: { sentry: { org: 'acme-co', dsn: 'https://company.example.com' } } },
      probe: { value: 'company-shared', fromCompanyShared: true },
      targets: { backend: { type: 'backend', probe: { value: 'company-target', fromCompanyTarget: true } } },
    }`,
    'brands/acme/config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      company: { id: 'acme-co' },
      probe: { value: 'brand-shared', fromBrandShared: true },
      targets: { backend: { type: 'backend' }, web: { type: 'web' } },
    }`,
    'brands/acme/targets/backend/package.json': `{ "name": "acme-backend" }`,
  }, extra));

  const parentRoot = path.join(workspace, 'parent');
  const companyRoot = path.join(parentRoot, 'company');
  const brandRoot = path.join(workspace, 'brands', 'acme');

  const previous = process.env.OMEGA_HOME;
  process.env.OMEGA_HOME = path.join(workspace, 'home');
  t.after(() => {
    if (previous === undefined) delete process.env.OMEGA_HOME;
    else process.env.OMEGA_HOME = previous;
  });
  recordBrand({ id: 'acme-co', root: parentRoot, name: 'Acme Inc', url: 'https://acme-co.test' });

  return { workspace, parentRoot, companyRoot, brandRoot };
}

// Every layer is TWO files: its omega.json5 and the omega.<environment>.json5
// beside it, the config mirror of the .env / .env.<environment> pair (#586).
// The overlay holds only the overrides, wins over its OWN base, and still
// loses to the layer above.

// Switch the RUNNING environment the way a run states it: through the vars
// envEnvironment() reads. Returns a setter; the originals come back after.
function useEnvironment(t) {
  const keys = ['OMEGA_ENVIRONMENT', 'ENVIRONMENT', 'FUNCTIONS_EMULATOR', 'TERM_PROGRAM'];
  const saved = keys.map((key) => [key, process.env[key]]);

  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  return (environment) => {
    for (const key of keys) delete process.env[key];
    process.env.ENVIRONMENT = environment;
  };
}

// ─── The seo sidecar: config/seo.json5 is its layer's `seo` section ───

const UNDECLARED = 'is not a key the schema declares. Remove it, or if it is a legacy key run `npx omega migrate` at the brand root (report) and `--execute` to convert (docs/shared/config.md → Validation)';

const SIDECAR_BASE = `{ brand: { id: 'acme', name: 'Acme' }, targets: { web: { type: 'web' } } }`;

module.exports = defineCases({
  type: 'group',
  description: 'load',
  tests: [
    // ─── Discovery ───

    {
      name: 'standalone project: config/omega.json5, JSON5 syntax (comments, trailing commas, unquoted keys)',
      run: (ctx) => {
        const root = makeFixture('standalone', {
          'config/omega.json5': `{
      // JSON5 — strict JSON.parse would fail here
      brand: { id: 'acme', name: 'Acme' },
      targets: { desktop: { type: 'desktop', startup: { mode: 'hidden' } }, },
    }`,
        });
        cleanup(ctx, root);

        ctx.expect(hasOmegaConfig(root)).toBe(true);

        const { config, errors, enabled, files } = loadConfig(root, 'desktop');
        ctx.expect(errors).toEqual([]);
        ctx.expect(enabled).toBe(true);
        ctx.expect(config.brand.name).toBe('Acme');
        ctx.expect(config.startup.mode).toBe('hidden');
        ctx.expect(files.local).toBe(path.join(root, 'config', 'omega.json5'));
        ctx.expect(files.brand).toBe(null);
      },
    },

    {
      name: 'backend target dir: a STAGED functions/config is never the local layer; the functions dir itself still resolves it (runtime view)',
      run: (ctx) => {
        // src/dist pillar: functions/config/omega.json5 is compose OUTPUT. From the
        // TARGET ROOT it must not resolve (a stale stage would shadow brand edits);
        // from the FUNCTIONS dir (the deployed runtime's cwd/projectDir) it is that
        // dir's own config/omega.json5 and resolves exactly like production.
        const root = makeFixture('backend-standalone', {
          'functions/config/omega.json5': `{ brand: { id: 'acme', name: 'Acme Backend' }, targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, root);

        ctx.expect(resolveConfigPath(root)).toBe(null);
        ctx.expect(hasOmegaConfig(root)).toBe(false);
        ctx.expect(resolveConfigPath(path.join(root, 'functions'))).toBe(path.join(root, 'functions', 'config', 'omega.json5'));
        ctx.expect(loadConfig(path.join(root, 'functions'), 'backend').enabled).toBe(true);

        // The authored standalone home is the target root — it wins the target-root view
        fs.mkdirSync(path.join(root, 'config'), { recursive: true });
        fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{ brand: { id: 'acme', name: 'Root Wins' }, targets: { backend: { type: 'backend' } } }`);
        ctx.expect(resolveConfigPath(root)).toBe(path.join(root, 'config', 'omega.json5'));
      },
    },

    {
      name: 'missing config: hasOmegaConfig false (dual-read probe), loadConfig throws',
      run: (ctx) => {
        const root = makeFixture('empty', { 'package.json': '{}' });
        cleanup(ctx, root);

        ctx.expect(hasOmegaConfig(root)).toBe(false);
        ctx.expect(() => loadConfig(root, 'web')).toThrow(/No omega\.json5 found/);
      },
    },

    {
      name: 'unknown target argument throws',
      run: (ctx) => {
        const root = makeFixture('bad-target', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' } }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root, 'website')).toThrow(/Unknown target "website"/);
      },
    },

    {
      name: 'unparseable file throws with the file path in the message',
      run: (ctx) => {
        const root = makeFixture('broken', { 'config/omega.json5': `{ brand: {` });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root, 'web')).toThrow(/Failed to parse .*omega\.json5/);
      },
    },

    {
      name: 'five-layer chain: defaults < brand shared < brand target < local shared < local target',
      run: (ctx) => {
        const root = makeFixture('brand-monorepo', BRAND_MONOREPO);
        cleanup(ctx, root);

        const targetDir = path.join(root, 'targets', 'backend');
        const defaults = { probe: { value: 'defaults', fromDefaults: true }, theme: { id: 'classy' } };
        const { config, errors, enabled, files } = loadConfig(targetDir, 'backend', { defaults });

        // `probe` is a merge tracer, undeclared on purpose: the strict schema names only it
        ctx.expect(errors.filter((error) => !error.startsWith('config.probe.'))).toEqual([]);
        ctx.expect(enabled).toBe(true);
        ctx.expect(files.brand).toBe(path.join(root, 'config', 'omega.json5'));

        // Precedence: the last layer that sets probe.value wins
        ctx.expect(config.probe.value).toBe('local-target');
        // ...but every layer's unique keys survive the merge
        ctx.expect(config.probe.fromDefaults).toBe(true);
        ctx.expect(config.probe.fromBrandShared).toBe(true);
        ctx.expect(config.probe.fromBrandTarget).toBe(true);
        ctx.expect(config.probe.fromLocalShared).toBe(true);
        ctx.expect(config.theme.id).toBe('classy');

        // Brand identity flows down; target-section keys land at the top level
        ctx.expect(config.brand.id).toBe('acme');
        ctx.expect(config.repo.owner).toBe('acme-org');
      },
    },

    {
      name: 'any shared key inside a target entry overrides the shared value for that surface',
      run: (ctx) => {
        const root = makeFixture('target-override', BRAND_MONOREPO);
        cleanup(ctx, root);

        const targetDir = path.join(root, 'targets', 'backend');
        ctx.expect(loadConfig(targetDir, 'backend').config.monitoring.providers.sentry.dsn).toBe('https://backend-override.example.com');

        // A different target (or the brand root itself) still sees the shared value
        ctx.expect(loadConfig(root, 'web').config.monitoring.providers.sentry.dsn).toBe('https://brand-shared.example.com');
      },
    },

    {
      name: 'the six manager-level sections resolve shared, and a targets.backend block still overrides them (#277)',
      run: (ctx) => {
        const root = makeFixture('manager-sections-shared', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      directory: { enabled: true },
      repo: { owner: 'acme-org' },
      reviews: { enabled: true, sites: ['trustpilot.com'] },
      marketing: { campaigns: { enabled: true, providers: { sendgrid: { listId: 'lst_shared' } } } },
      blog: { enabled: false },
      dataRequest: { queries: [] },
      targets: {
        web: { type: 'web' },
        backend: { type: 'backend', directory: { enabled: false }, marketing: { campaigns: { providers: { sendgrid: { listId: 'lst_backend' } } } } },
      },
    }`,
        });
        cleanup(ctx, root);

        // The manager reads the brand config UNFOLDED (no target), so the shared level is its home
        const brandView = loadConfig(root);
        ctx.expect(brandView.errors).toEqual([]);
        ctx.expect(brandView.config.directory.enabled).toBe(true);
        ctx.expect(brandView.config.marketing.campaigns.providers.sendgrid.listId).toBe('lst_shared');
        ctx.expect(brandView.config.reviews.sites[0]).toBe('trustpilot.com');

        // A website-only surface sees the shared values, and they validate there
        const webView = loadConfig(root, 'web');
        ctx.expect(webView.errors).toEqual([]);
        ctx.expect(webView.config.directory.enabled).toBe(true);
        ctx.expect(webView.config.blog.enabled).toBe(false);

        // targets.backend stays a valid OVERRIDE via the existing merge chain, with no schema of its own
        const backendView = loadConfig(root, 'backend');
        ctx.expect(backendView.errors).toEqual([]);
        ctx.expect(backendView.config.directory.enabled).toBe(false);
        ctx.expect(backendView.config.marketing.campaigns.providers.sendgrid.listId).toBe('lst_backend');
        // ...and the shared keys the override did not touch survive it
        ctx.expect(backendView.config.marketing.campaigns.enabled).toBe(true);
        ctx.expect(backendView.config.repo.owner).toBe('acme-org');
      },
    },

    {
      name: 'resolved config keeps the merged targets map — enablement survives resolution',
      run: (ctx) => {
        const root = makeFixture('targets-map', BRAND_MONOREPO);
        cleanup(ctx, root);

        const { config, enabled } = loadConfig(path.join(root, 'targets', 'backend'), 'backend');
        ctx.expect(getEnabledTargets(config).sort()).toEqual(['backend', 'web']);
        ctx.expect(enabled).toBe(true);

        // A target the brand never listed resolves with enabled: false
        ctx.expect(loadConfig(path.join(root, 'targets', 'desktop'), 'desktop').enabled).toBe(false);
      },
    },

    {
      name: '#886: a STANDALONE project is named by its file, not by the type word',
      run: (ctx) => {
        // The deployed shape: a brand staged its `api` backend, so the upload carries
        // `api: { type: 'backend' }` and no brand root above it. The name has to come
        // back out of the file, or the entry stops being the target layer.
        const root = makeFixture('standalone-named-target', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
      targets: {
        api: { type: 'backend', flavor: 'api-target' },
        web: { type: 'web' },
      },
    }`,
        });
        cleanup(ctx, root);

        const api = loadConfig(root, 'backend');
        // `flavor` is a merge tracer, undeclared on purpose: the strict schema names only it
        ctx.expect(api.errors.filter((error) => !error.startsWith('config.flavor '))).toEqual([]);
        ctx.expect(api.name).toBe('api');
        ctx.expect(api.enabled).toBe(true);
        ctx.expect(api.config.flavor, 'the named entry is still the target layer').toBe('api-target');
        ctx.expect(api.config.url, 'and its url derives exactly as it does inside the brand').toBe('https://api.acme.test');

        // A type with no declared target at all keeps the type word
        ctx.expect(loadConfig(root, 'desktop').name).toBe('desktop');
        ctx.expect(loadConfig(root, 'desktop').enabled).toBe(false);

        // Two targets of one type have no single answer, so the type word stands
        const twins = makeFixture('standalone-two-of-a-type', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      targets: { web: { type: 'web' }, community: { type: 'web' } },
    }`,
        });
        cleanup(ctx, twins);
        ctx.expect(loadConfig(twins, 'web').name).toBe('web');
      },
    },

    {
      name: '#886: a target dir whose entry runs a different framework is a loud error',
      run: (ctx) => {
        const root = makeFixture('targets-type-mismatch', BRAND_MONOREPO);
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(path.join(root, 'targets', 'backend'), 'desktop')).toThrow(/targets\.backend is type backend; this project runs the desktop framework/);
      },
    },

    {
      name: '#886: the target dir NAMES the entry, so a second web target merges its own layer',
      run: (ctx) => {
        const root = makeFixture('targets-by-name', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
      monitoring: { providers: { sentry: { dsn: 'https://brand-shared.example.com' } } },
      targets: {
        web: { type: 'web', flavor: 'primary' },
        admin: {
          type: 'web',
          flavor: 'console',
          brand: { name: 'Acme Admin' },
          monitoring: { providers: { sentry: { dsn: 'https://admin-override.example.com' } } },
        },
        backend: { type: 'backend' },
      },
    }`,
          'targets/web/package.json': '{}',
          'targets/admin/package.json': '{}',
        });
        cleanup(ctx, root);

        const main = loadConfig(path.join(root, 'targets', 'web'), 'web');
        // `flavor` is a merge tracer, undeclared on purpose: the strict schema names only it
        ctx.expect(main.errors.filter((error) => !error.startsWith('config.flavor '))).toEqual([]);
        ctx.expect(main.name).toBe('web');
        ctx.expect(main.enabled).toBe(true);
        ctx.expect(main.config.flavor).toBe('primary');
        ctx.expect(main.config.brand.name).toBe('Acme');
        ctx.expect(main.config.url, 'a target named for its type derives nothing: brand.url IS its url').toBe(undefined);

        const admin = loadConfig(path.join(root, 'targets', 'admin'), 'web');
        ctx.expect(admin.name).toBe('admin');
        ctx.expect(admin.enabled).toBe(true);
        ctx.expect(admin.config.flavor, 'the NAMED entry is the target layer').toBe('console');
        ctx.expect(admin.config.brand.name, 'a shared key inside the entry overrides brand shared for that target').toBe('Acme Admin');
        ctx.expect(admin.config.brand.url, 'sibling shared keys survive the merge').toBe('https://acme.test');
        ctx.expect(admin.config.monitoring.providers.sentry.dsn).toBe('https://admin-override.example.com');
        ctx.expect(admin.config.url, 'the name IS the subdomain').toBe('https://admin.acme.test');

        // The TARGET_SUBDIR views of the same target resolve the same name
        for (const subdir of ['functions', 'dist']) {
          const staged = loadConfig(path.join(root, 'targets', 'admin', subdir), 'web');
          ctx.expect(staged.name, `${subdir}/ resolves its target dir's name`).toBe('admin');
          ctx.expect(staged.config.flavor).toBe('console');
        }

        // A standalone project is named by the framework it runs
        const solo = makeFixture('targets-by-name-solo', {
          'config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { web: { type: 'web', flavor: 'only' } } }`,
        });
        cleanup(ctx, solo);
        ctx.expect(loadConfig(solo, 'web').name).toBe('web');
        ctx.expect(loadConfig(solo, 'web').config.flavor).toBe('only');
      },
    },

    {
      name: 'an unset brand.url on a Pages-hosted web target resolves to its Pages address, from the target and brand-wide',
      run: (ctx) => {
        const root = makeFixture('pages-brand', {
          'config/omega.json5': pagesBrand(`{ web: { type: 'web' } }`),
          'targets/web/package.json': '{}',
        });
        cleanup(ctx, root);

        const web = loadConfig(path.join(root, 'targets', 'web'), 'web');
        ctx.expect(web.errors).toEqual([]);
        ctx.expect(web.config.brand.url).toBe(PAGES_ADDRESS);
        ctx.expect(web.config.url, 'the target named for its type still takes brand.url as its own').toBe(undefined);
        ctx.expect(loadConfig(root).config.brand.url, 'a brand-wide load resolves the same address').toBe(PAGES_ADDRESS);
      },
    },

    {
      name: 'a local layer nulling brand.url switches the declared domain off, and the Pages address fills it',
      run: (ctx) => {
        const root = makeFixture('pages-null-local', {
          'config/omega.json5': `{
      brand: { id: 'dreamr', name: 'Dreamr', url: 'https://acme.test' },
      repo: { owner: 'dreamr-design' },
      targets: { web: { type: 'web' } },
    }`,
          'targets/web/config/omega.json5': `{ brand: { url: null } }`,
        });
        cleanup(ctx, root);

        ctx.expect(loadConfig(path.join(root, 'targets', 'web'), 'web').config.brand.url).toBe(PAGES_ADDRESS);
      },
    },

    {
      name: 'a brand with no web target derives no brand.url',
      run: (ctx) => {
        const root = makeFixture('pages-no-web', {
          'config/omega.json5': pagesBrand(`{ backend: { type: 'backend' } }`),
          'targets/backend/package.json': '{}',
        });
        cleanup(ctx, root);

        ctx.expect(loadConfig(path.join(root, 'targets', 'backend'), 'backend').config.brand.url).toBe(undefined);
        ctx.expect(loadConfig(root).config.brand.url).toBe(undefined);
      },
    },

    {
      name: 'a web target with no repo.owner leaves brand.url unset, and the load does not throw',
      run: (ctx) => {
        const root = makeFixture('pages-no-owner', {
          'config/omega.json5': `{ brand: { id: 'dreamr', name: 'Dreamr' }, targets: { web: { type: 'web' } } }`,
          'targets/web/package.json': '{}',
        });
        cleanup(ctx, root);

        ctx.expect(loadConfig(path.join(root, 'targets', 'web'), 'web').config.brand.url).toBe(undefined);
        ctx.expect(loadConfig(root).config.brand.url).toBe(undefined);
      },
    },

    {
      name: 'a second web target on the Pages brand derives its own Pages address, never a github.io subdomain',
      run: (ctx) => {
        const root = makeFixture('pages-second-web', {
          'config/omega.json5': pagesBrand(`{ web: { type: 'web' }, admin: { type: 'web' } }`),
          'targets/web/package.json': '{}',
          'targets/admin/package.json': '{}',
        });
        cleanup(ctx, root);

        const admin = loadConfig(path.join(root, 'targets', 'admin'), 'web');
        ctx.expect(admin.config.url).toBe('https://dreamr-design.github.io/dreamr-admin');
        ctx.expect(admin.config.brand.url, 'the filled value is the brand layer, so it is the main site').toBe(PAGES_ADDRESS);
      },
    },

    {
      name: 'a brand on its own domain resolves every url as before, a repo owner notwithstanding',
      run: (ctx) => {
        const root = makeFixture('pages-own-domain', {
          'config/omega.json5': `{
      brand: { id: 'dreamr', name: 'Dreamr', url: 'https://acme.test' },
      repo: { owner: 'dreamr-design' },
      targets: { web: { type: 'web' }, admin: { type: 'web' } },
    }`,
          'targets/web/package.json': '{}',
          'targets/admin/package.json': '{}',
        });
        cleanup(ctx, root);

        const web = loadConfig(path.join(root, 'targets', 'web'), 'web');
        ctx.expect(web.config.brand.url).toBe('https://acme.test');
        ctx.expect(web.config.url).toBe(undefined);

        const admin = loadConfig(path.join(root, 'targets', 'admin'), 'web');
        ctx.expect(admin.config.brand.url).toBe('https://acme.test');
        ctx.expect(admin.config.url).toBe('https://admin.acme.test');
        ctx.expect(loadConfig(root).config.brand.url).toBe('https://acme.test');
      },
    },

    {
      name: 'no target: whole files merge (targets map included) — the disperse shape; enabled is null',
      run: (ctx) => {
        const root = makeFixture('no-target', BRAND_MONOREPO);
        cleanup(ctx, root);

        const { config, enabled } = loadConfig(path.join(root, 'targets', 'backend'));
        ctx.expect(enabled).toBe(null);
        ctx.expect(config.probe.value).toBe('local-shared');
        ctx.expect(config.targets.backend.probe.value).toBe('local-target');
        ctx.expect(config.targets.backend.repo.owner).toBe('acme-org');
        ctx.expect(config.targets.web).toEqual({ type: 'web' });
      },
    },

    {
      name: 'backend runtime cwd (the functions/ dir) still walks up to the brand config',
      run: (ctx) => {
        // @omega.js/backend's Manager boots with cwd = {brand}/targets/backend/functions — the target
        // root is one up, and the brand layer must still resolve from there. Under
        // the src/dist pillar the target's AUTHORED file lives at the target root; the
        // functions dir carries the STAGED compose (written by omega build).
        const root = makeFixture('functions-cwd', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      cloud: { provider: 'firebase', config: { projectId: 'acme-prod' } },
      targets: { backend: { type: 'backend' } },
    }`,
          'targets/backend/config/omega.json5': `{
      targets: { backend: { type: 'backend', repo: { owner: 'acme-org' } } },
    }`,
        });
        cleanup(ctx, root);

        const targetRoot = path.join(root, 'targets', 'backend');
        const functionsDir = path.join(targetRoot, 'functions');

        // Local emulator view BEFORE any stage: the walk-up alone serves everything
        const fromFunctions = loadConfig(functionsDir, 'backend');
        ctx.expect(fromFunctions.files.brand).toBe(path.join(root, 'config', 'omega.json5'));
        ctx.expect(fromFunctions.config.cloud.config.projectId).toBe('acme-prod');
        ctx.expect(fromFunctions.config.repo.owner).toBe('acme-org');
        ctx.expect(fromFunctions.enabled).toBe(true);

        // Same resolution from the target root — both entry points agree
        const fromTargetRoot = loadConfig(targetRoot, 'backend');
        ctx.expect(fromTargetRoot.config).toEqual(fromFunctions.config);

        // AFTER a stage (composed file in functions/config), the functions view
        // resolves the staged file as its own local layer and STILL agrees
        const { config: composed } = composeTargetConfig(targetRoot, 'backend');
        fs.mkdirSync(path.join(functionsDir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(functionsDir, 'config', 'omega.json5'), JSON.stringify(composed, null, 2));
        const staged = loadConfig(functionsDir, 'backend');
        ctx.expect(staged.config.repo.owner).toBe('acme-org');
        ctx.expect(staged.config.cloud.config.projectId).toBe('acme-prod');
        // ...while the target-root view IGNORES the staged file (never a local layer)
        ctx.expect(loadConfig(targetRoot, 'backend').files.local).toBe(path.join(targetRoot, 'config', 'omega.json5'));
      },
    },

    {
      name: 'a targets/ dir without a brand-level config is standalone — no walk-up',
      run: (ctx) => {
        const root = makeFixture('no-brand-config', {
          'targets/backend/config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, root);

        const { files } = loadConfig(path.join(root, 'targets', 'backend'), 'backend');
        ctx.expect(files.brand).toBe(null);
      },
    },

    // ─── Raw-file hard fails ───

    {
      name: 'secrets throw even in a NON-requested target section',
      run: (ctx) => {
        const root = makeFixture('secret-other-target', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      targets: { backend: { type: 'backend' }, desktop: { type: 'desktop', updater: { signingSecret: 'x' } } },
    }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root, 'backend')).toThrow(/Secret-shaped keys in .*omega\.json5 .* targets\.desktop\.updater\.signingSecret/);
      },
    },

    {
      name: 'secrets in the brand file throw when loading a target',
      run: (ctx) => {
        const root = makeFixture('secret-brand', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, stripeSecret: 'x' }`,
          'targets/web/config/omega.json5': `{ targets: { web: { type: 'web' } } }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(path.join(root, 'targets', 'web'), 'web')).toThrow(/stripeSecret/);
      },
    },

    {
      name: 'legacy targets ARRAY throws loudly instead of mangling into {0: ...}',
      run: (ctx) => {
        const root = makeFixture('legacy-targets', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: ['web', 'backend'] }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root, 'web')).toThrow(/legacy array form is not valid omega\.json5/);
      },
    },

    // ─── Validation pass-through ───

    {
      name: 'schema findings come back as errors, never thrown — callers pick their strictness',
      run: (ctx) => {
        const root = makeFixture('soft-errors', {
          'config/omega.json5': `{ brand: { id: 'Not A Slug' }, theme: { appearance: 'neon' } }`,
        });
        cleanup(ctx, root);

        const { errors } = loadConfig(root, 'web');
        ctx.expect(errors.some((e) => e.includes('config.brand.name is required'))).toBeTruthy();
        ctx.expect(errors.some((e) => e.includes('config.brand.id') && e.includes('does not match'))).toBeTruthy();
        ctx.expect(errors.some((e) => e.includes('config.theme.appearance'))).toBeTruthy();
      },
    },

    // ─── resolveBrandRoot (the upward SEARCH — moved here from the manager, cp73c) ───

    {
      name: 'resolveBrandRoot: finds the brand root from anywhere in the tree',
      run: (ctx) => {
        const root = makeFixture('walk-brand', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' } }`,
          'targets/web/config/omega.json5': `{ targets: { web: { type: 'web' } } }`,
          'targets/web/src/lib/deep.js': `// depth fixture`,
          'targets/api/functions/config/omega.json5': `{ targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, root);

        // From the brand root itself
        ctx.expect(resolveBrandRoot(root)).toBe(root);
        // From a target dir (a target of this brand is never itself the root)
        ctx.expect(resolveBrandRoot(path.join(root, 'targets', 'web'))).toBe(root);
        // From deep inside a target
        ctx.expect(resolveBrandRoot(path.join(root, 'targets', 'web', 'src', 'lib'))).toBe(root);
        // From a backend target's functions/ dir (carries config, never a root)
        ctx.expect(resolveBrandRoot(path.join(root, 'targets', 'api', 'functions'))).toBe(root);
      },
    },

    {
      name: 'resolveBrandRoot: a pre-#443 apps/ brand still resolves to its TRUE root from a config-carrying target',
      run: (ctx) => {
        // Detection, not compatibility: the walk must climb past a legacy target so
        // discovery fails loud at the real root with the targets-rename pointer.
        // Stopping at the target loaded IT as the brand, and the rename migration
        // run from that cwd reported "already on targets/" without touching apps/.
        const root = makeFixture('walk-legacy-apps', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' } }`,
          'apps/website/config/omega.json5': `{ targets: { web: { type: 'web' } } }`,
        });
        cleanup(ctx, root);

        ctx.expect(resolveBrandRoot(path.join(root, 'apps', 'website'))).toBe(root);
      },
    },

    {
      name: 'resolveBrandRoot: a standalone config-carrying project resolves to itself',
      run: (ctx) => {
        const root = makeFixture('walk-standalone', {
          'config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { web: { type: 'web' } } }`,
          'src/pages/index.js': `// depth fixture`,
        });
        cleanup(ctx, root);

        ctx.expect(resolveBrandRoot(root)).toBe(root);
        ctx.expect(resolveBrandRoot(path.join(root, 'src', 'pages'))).toBe(root);
      },
    },

    {
      name: 'resolveBrandRoot: a STAGED dist/ is never a root — its target dir (and the brand above it) is',
      run: (ctx) => {
        // dist/config/omega.json5 is compose OUTPUT, the same shape functions/ has
        // carried since the src/dist pillar. The walk skipped only `functions`, so
        // a resolution from a staged dist/ stopped there and named the build output
        // as the project root ([#299](https://github.com/Omega-JS-Stack/omega/issues/299)).
        const root = makeFixture('walk-staged-dist', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' } }`,
          'targets/backend/config/omega.json5': `{ targets: { backend: { type: 'backend' } } }`,
          'targets/backend/dist/config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, root);

        ctx.expect(resolveBrandRoot(path.join(root, 'targets', 'backend', 'dist'))).toBe(root);

        // Standalone: the project root, never its own staged output
        const standalone = makeFixture('walk-staged-dist-standalone', {
          'config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { backend: { type: 'backend' } } }`,
          'dist/config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, standalone);

        ctx.expect(resolveBrandRoot(path.join(standalone, 'dist'))).toBe(standalone);
      },
    },

    {
      name: 'resolveBrandRoot: a brand nested inside a larger workspace targets/ dir still resolves as a brand root (sandbox shape)',
      run: (ctx) => {
        const workspace = makeFixture('walk-nested', {
          // No workspace-level config — targets/ here is NOT a brand's targets dir
          'targets/sandbox-brand/config/omega.json5': `{ brand: { id: 'sandbox', name: 'Sandbox' } }`,
          'targets/sandbox-brand/targets/web/config/omega.json5': `{ targets: { web: { type: 'web' } } }`,
        });
        cleanup(ctx, workspace);

        const brandRoot = path.join(workspace, 'targets', 'sandbox-brand');
        ctx.expect(resolveBrandRoot(brandRoot)).toBe(brandRoot);
        ctx.expect(resolveBrandRoot(path.join(brandRoot, 'targets', 'web'))).toBe(brandRoot);
      },
    },

    {
      name: 'resolveBrandRoot: null when no omega.json5 exists up the tree',
      run: (ctx) => {
        const root = makeFixture('walk-nothing', {
          'src/anything.js': `// no config anywhere`,
        });
        cleanup(ctx, root);

        ctx.expect(resolveBrandRoot(path.join(root, 'src'))).toBe(null);
      },
    },

    {
      name: 'resolveBrandRoot: the walk stops at the nearest .git — an unconfigured repo never adopts a config above it (#73)',
      run: (ctx) => {
        // The outer dir carries a brand config; the inner repo carries none. An
        // unbounded walk would climb out of the repo and claim the outer brand.
        const outer = makeFixture('walk-git-bound', {
          'config/omega.json5': `{ brand: { id: 'outer', name: 'Outer' } }`,
          'repo/.git/HEAD': `ref: refs/heads/main`,
          'repo/src/lib/deep.js': `// depth fixture`,
        });
        cleanup(ctx, outer);

        ctx.expect(resolveBrandRoot(path.join(outer, 'repo', 'src', 'lib'))).toBe(null);
        ctx.expect(resolveBrandRoot(path.join(outer, 'repo'))).toBe(null);

        // The git root itself is still CHECKED before the walk stops — a brand
        // root is normally its own repo.
        fs.mkdirSync(path.join(outer, 'repo', 'config'), { recursive: true });
        fs.writeFileSync(path.join(outer, 'repo', 'config', 'omega.json5'), `{ brand: { id: 'inner', name: 'Inner' } }`);
        ctx.expect(resolveBrandRoot(path.join(outer, 'repo', 'src', 'lib'))).toBe(path.join(outer, 'repo'));
      },
    },

    {
      name: 'composeTargetConfig: freezes the full interleave into shared, targets go presence-only',
      run: (ctx) => {
        const brandRoot = makeFixture('compose-tree', COMPOSE_TREE);
        cleanup(ctx, brandRoot);
        const targetDir = path.join(brandRoot, 'targets', 'backend');

        const { config, files } = composeTargetConfig(path.join(targetDir, 'functions'), 'backend');

        ctx.expect(config.brand.name).toBe('Acme Corp'); // brand layer crossed the boundary
        ctx.expect(config.shade).toBe('brand-shared');
        ctx.expect(config.flavor).toBe('from-local-target'); // local target beats brand target
        ctx.expect(config.corner).toBe('from-local-shared'); // local SHARED beats brand TARGET (the interleave pin)
        ctx.expect(config.targets).toEqual({ backend: { type: 'backend' }, web: { type: 'web' } }); // presence + the declared type
        ctx.expect(config.defaultOnly).toBe(undefined); // defaults are NOT baked in
        ctx.expect(files.brand).toBe(path.join(brandRoot, 'config', 'omega.json5'));
      },
    },

    {
      name: 'composeTargetConfig: loading the composed file standalone resolves EXACTLY like the local walk-up (the theorem)',
      run: (ctx) => {
        const brandRoot = makeFixture('compose-theorem', COMPOSE_TREE);
        cleanup(ctx, brandRoot);
        const targetDir = path.join(brandRoot, 'targets', 'backend');

        const { config: composed } = composeTargetConfig(targetDir, 'backend');

        // Simulate the upload boundary: the composed file alone in a fresh root
        const uploadRoot = makeFixture('compose-upload', {
          'config/omega.json5': JSON.stringify(composed, null, 2),
        });
        cleanup(ctx, uploadRoot);

        const local = loadConfig(targetDir, 'backend', { defaults: COMPOSE_DEFAULTS });
        const viaUpload = loadConfig(uploadRoot, 'backend', { defaults: COMPOSE_DEFAULTS });

        // targets is enumeration-only ("settings are never read from it") — the
        // resolved settings and the enabled-target set must match exactly
        const { targets: localTargets, ...localConfig } = local.config;
        const { targets: uploadTargets, ...uploadConfig } = viaUpload.config;
        ctx.expect(uploadConfig).toEqual(localConfig);
        ctx.expect(Object.keys(uploadTargets).sort()).toEqual(Object.keys(localTargets).sort());
        ctx.expect(viaUpload.enabled).toBe(local.enabled);
        ctx.expect(viaUpload.errors).toEqual(local.errors);
      },
    },

    {
      name: 'composeTargetConfig: target dir and its functions/ dir compose identically; no brand layer → self-contained',
      run: (ctx) => {
        const brandRoot = makeFixture('compose-dirs', COMPOSE_TREE);
        cleanup(ctx, brandRoot);
        const targetDir = path.join(brandRoot, 'targets', 'backend');

        ctx.expect(composeTargetConfig(targetDir, 'backend').config).toEqual(composeTargetConfig(path.join(targetDir, 'functions'), 'backend').config);

        // ...and its staged dist/ too. Compose is a BUILD-time op over the AUTHORED
        // layers, so a dist/ that already holds a previous compose must normalize up
        // exactly as functions/ does — reading that output back as the local layer
        // would freeze brand edits behind the last stage
        // ([#299](https://github.com/Omega-JS-Stack/omega/issues/299)).
        const distDir = path.join(targetDir, 'dist');
        fs.mkdirSync(path.join(distDir, 'config'), { recursive: true });
        fs.writeFileSync(
          path.join(distDir, 'config', 'omega.json5'),
          JSON.stringify({ ...composeTargetConfig(targetDir, 'backend').config, shade: 'stale-stage' }, null, 2),
        );

        ctx.expect(composeTargetConfig(distDir, 'backend').config).toEqual(composeTargetConfig(targetDir, 'backend').config);
        ctx.expect(composeTargetConfig(distDir, 'backend').files.local).toBe(path.join(targetDir, 'config', 'omega.json5'));

        const solo = makeFixture('compose-solo', {
          'config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { backend: { type: 'backend', flavor: 'solo-target' } } }`,
        });
        cleanup(ctx, solo);

        const { config, files } = composeTargetConfig(solo, 'backend');
        ctx.expect(files.brand).toBe(null);
        ctx.expect(config.flavor).toBe('solo-target');
      },
    },

    {
      name: 'composeTargetConfig: local file OPTIONAL inside a brand monorepo — brand-only compose matches loadConfig (src/dist pillar)',
      run: (ctx) => {
        const brandRoot = makeFixture('compose-no-local', {
          'config/omega.json5': COMPOSE_TREE['config/omega.json5'],
          'targets/backend/src/index.js': `// authored tree only: no local omega.json5, no functions/ yet`,
        });
        cleanup(ctx, brandRoot);
        const targetDir = path.join(brandRoot, 'targets', 'backend');

        const { config, files } = composeTargetConfig(targetDir, 'backend');
        ctx.expect(files.local).toBe(null); // rides the brand file alone
        ctx.expect(config.brand.name).toBe('Acme Corp');
        ctx.expect(config.flavor).toBe('from-brand-target');
        ctx.expect(config.corner).toBe('from-brand-target'); // no local layers left to beat it
        ctx.expect(config.targets).toEqual({ backend: { type: 'backend' }, web: { type: 'web' } }); // presence + the declared type

        // The theorem holds without a local file: composed-alone ≡ local walk-up,
        // and the target dir + its (future staged) functions/ dir agree.
        const uploadRoot = makeFixture('compose-no-local-upload', {
          'config/omega.json5': JSON.stringify(config, null, 2),
        });
        cleanup(ctx, uploadRoot);
        const local = loadConfig(targetDir, 'backend', { defaults: COMPOSE_DEFAULTS });
        const viaUpload = loadConfig(uploadRoot, 'backend', { defaults: COMPOSE_DEFAULTS });
        const { targets: localTargets, ...localConfig } = local.config;
        const { targets: uploadTargets, ...uploadConfig } = viaUpload.config;
        ctx.expect(uploadConfig).toEqual(localConfig);
        ctx.expect(Object.keys(uploadTargets).sort()).toEqual(Object.keys(localTargets).sort());
        ctx.expect(composeTargetConfig(targetDir, 'backend').config).toEqual(composeTargetConfig(path.join(targetDir, 'functions'), 'backend').config);

        // Still a hard error when NOTHING exists (standalone with no file at all)
        const empty = makeFixture('compose-empty', { 'src/index.js': `// nothing` });
        cleanup(ctx, empty);
        ctx.expect(() => composeTargetConfig(empty, 'backend')).toThrow(/No omega\.json5 found/);
      },
    },

    {
      name: 'composeTargetConfig: secrets in either layer hard-fail before any merge',
      run: (ctx) => {
        const brandRoot = makeFixture('compose-secrets', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, apiSecret: 'leaked' }`,
          'targets/backend/config/omega.json5': `{ targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, brandRoot);

        ctx.expect(() => composeTargetConfig(path.join(brandRoot, 'targets', 'backend'), 'backend')).toThrow(/Secret-shaped keys/);
        ctx.expect(() => composeTargetConfig(brandRoot, 'nope')).toThrow(/Unknown target/);
      },
    },

    {
      name: 'composeTargetConfig: a backend target of the Pages brand uploads the resolved Pages address as brand.url',
      run: (ctx) => {
        const root = makeFixture('compose-pages', {
          'config/omega.json5': pagesBrand(`{ web: { type: 'web' }, backend: { type: 'backend' } }`),
          'targets/backend/package.json': '{}',
        });
        cleanup(ctx, root);

        const { config } = composeTargetConfig(path.join(root, 'targets', 'backend'), 'backend');
        ctx.expect(config.brand.url).toBe(PAGES_ADDRESS);
      },
    },

    {
      name: 'hasOmegaConfig is brand-aware: a target with NO local-layer file counts when the brand has one',
      run: (ctx) => {
        const brandRoot = makeFixture('probe-brand-aware', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { desktop: { type: 'desktop' } } }`,
          // the target dir exists but carries NO config/omega.json5 (cp121c: optional)
          'targets/desktop/package.json': `{ "name": "acme-desktop" }`,
        });
        cleanup(ctx, brandRoot);

        const targetDir = path.join(brandRoot, 'targets', 'desktop');
        ctx.expect(hasOmegaConfig(targetDir), 'the brand file IS the config').toBe(true);
        // and loadConfig agrees — the gate and the loader can never disagree again
        ctx.expect(loadConfig(targetDir, 'desktop').config.brand.id).toBe('acme');

        // a dir with no brand above it stays false (fail-soft in non-consumer dirs)
        ctx.expect(hasOmegaConfig(path.join(brandRoot, 'targets'))).toBe(false);
      },
    },

    // ─── wave-4 regression (F16): probe and load agree from a functions/ dir ───

    {
      name: 'hasOmegaConfig mirrors loadConfig\'s functions/ → target-root fallback',
      run: (ctx) => {
        const root = makeFixture('probe-functions-fallback', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { backend: { type: 'backend' } } }`,
          'functions/index.js': `// runtime`,
        });
        cleanup(ctx, root);

        const functionsDir = path.join(root, 'functions');
        // loadConfig succeeds from the functions dir (target-root fallback)…
        ctx.expect(loadConfig(functionsDir, 'backend').config.brand.id).toBe('acme');
        // …so the probe must say true too — a false here made framework gates
        // proceed with an empty config (cp142 class)
        ctx.expect(hasOmegaConfig(functionsDir)).toBe(true);

        // A functions dir with NO config anywhere above stays false
        const bare = makeFixture('probe-functions-bare', { 'functions/index.js': `// runtime` });
        cleanup(ctx, bare);
        ctx.expect(hasOmegaConfig(path.join(bare, 'functions'))).toBe(false);
      },
    },

    {
      name: 'standalone project: an unstaged dist/ resolves the local config exactly as functions/ does',
      run: (ctx) => {
        // `omega test` resolves a backend from its STAGED dist/, but the stage is
        // written by the run — before it exists the dir is empty. The functions/ leg
        // of that fallback was hardcoded, so the same resolution from dist/ threw
        // while functions/ succeeded, and a STANDALONE project (no brand root above
        // to recover through) could not load its own local config
        // ([#299](https://github.com/Omega-JS-Stack/omega/issues/299)).
        const root = makeFixture('probe-dist-fallback', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { backend: { type: 'backend', probe: { value: 'local-target' } } } }`,
          'dist/index.js': `// staged output, no config staged yet`,
          'functions/index.js': `// runtime`,
        });
        cleanup(ctx, root);

        const distDir = path.join(root, 'dist');
        const functionsDir = path.join(root, 'functions');

        ctx.expect(hasOmegaConfig(distDir)).toBe(true);
        ctx.expect(loadConfig(distDir, 'backend').config.brand.id).toBe('acme');
        ctx.expect(loadConfig(distDir, 'backend').config).toEqual(loadConfig(functionsDir, 'backend').config);

        // A dist dir with NO config anywhere above stays false, same as functions/
        const bare = makeFixture('probe-dist-bare', { 'dist/index.js': `// staged output` });
        cleanup(ctx, bare);
        ctx.expect(hasOmegaConfig(path.join(bare, 'dist'))).toBe(false);
      },
    },

    {
      name: 'company layer: defaults < company shared < company target < brand shared < brand target < local',
      run: (ctx) => {
        const { workspace, companyRoot, brandRoot } = makeCompanyFixture(ctx, 'company-chain');
        cleanup(ctx, workspace);

        const defaults = { probe: { value: 'defaults', fromDefaults: true } };
        const { config, files } = loadConfig(path.join(brandRoot, 'targets', 'backend'), 'backend', { defaults });

        // Every layer contributes; the brand still wins over the company
        ctx.expect(config.probe.fromDefaults).toBe(true);
        ctx.expect(config.probe.fromCompanyShared).toBe(true);
        ctx.expect(config.probe.fromCompanyTarget).toBe(true);
        ctx.expect(config.probe.value).toBe('brand-shared');

        // Company-wide values the brand never restates flow all the way down
        ctx.expect(config.monitoring.providers.sentry.org).toBe('acme-co');
        ctx.expect(config.monitoring.providers.sentry.dsn).toBe('https://company.example.com');
        ctx.expect(config.brand.id).toBe('acme');

        // The parent's own facts resolve into the company section (#677), and the
        // brand never restates them
        ctx.expect(config.company.name).toBe('Acme Inc');
        ctx.expect(config.company.url).toBe('https://acme-co.test');

        ctx.expect(files.company).toBe(path.join(companyRoot, 'config', 'omega.json5'));
      },
    },

    {
      name: 'company layer: the brand root reads its own company.id; a brand naming none has no company layer',
      run: (ctx) => {
        const { workspace, brandRoot } = makeCompanyFixture(ctx, 'company-brand-root');
        cleanup(ctx, workspace);

        ctx.expect(loadConfig(brandRoot).config.monitoring.providers.sentry.org).toBe('acme-co');

        fs.writeFileSync(
          path.join(brandRoot, 'config', 'omega.json5'),
          `{ brand: { id: 'acme', name: 'Acme' }, targets: { backend: { type: 'backend' } } }`,
        );
        // The company's own values are gone; what remains under `monitoring` is the
        // schema-default layer every config carries (#478), never an inherited fact.
        ctx.expect(loadConfig(brandRoot).config.monitoring.providers?.sentry?.org).toBe(undefined);
        ctx.expect(loadConfig(brandRoot).files.company).toBe(null);
        ctx.expect(loadConfig(brandRoot).config.company).toEqual({ id: null, name: 'Acme', url: null, images: {}, webhooks: true });
      },
    },

    {
      name: 'company layer: secrets in the company file hard-fail before any merge',
      run: (ctx) => {
        const { workspace, companyRoot, brandRoot } = makeCompanyFixture(ctx, 'company-secrets');
        cleanup(ctx, workspace);

        fs.writeFileSync(
          path.join(companyRoot, 'config', 'omega.json5'),
          `{ payment: { stripe: { secret: 'sk_live_x' } } }`,
        );

        ctx.expect(() => loadConfig(path.join(brandRoot, 'targets', 'backend'), 'backend')).toThrow(/Secret-shaped keys/);
      },
    },

    {
      name: 'company layer: a standalone project resolves its company from dist/ as well as functions/',
      run: (ctx) => {
        // `omega test` loads a backend's config from its STAGED dist/, and a
        // standalone project has no brand root to resolve through, so the walk
        // normalizing only `functions/` left dist/ asking the build output which
        // company it belongs to and the layer silently vanished
        // ([#257](https://github.com/Omega-JS-Stack/omega/issues/257)).
        const workspace = makeFixture('company-standalone-dist', {
          'parent/config/omega.json5': `{ brand: { id: 'acme-co' }, company: { id: 'self' } }`,
          'parent/company/config/omega.json5': `{ monitoring: { providers: { sentry: { org: 'acme-co' } } } }`,
          'project/config/omega.json5': `{ brand: { id: 'acme' }, company: { id: 'acme-co' }, targets: { backend: { type: 'backend' } } }`,
          'project/dist/config/omega.json5': `{ brand: { id: 'acme' }, company: { id: 'acme-co' }, targets: { backend: { type: 'backend' } } }`,
          'project/functions/config/omega.json5': `{ brand: { id: 'acme' }, company: { id: 'acme-co' }, targets: { backend: { type: 'backend' } } }`,
        });
        cleanup(ctx, workspace);

        const companyRoot = path.join(workspace, 'parent', 'company');
        const projectRoot = path.join(workspace, 'project');

        const previous = process.env.OMEGA_HOME;
        process.env.OMEGA_HOME = path.join(workspace, 'home');
        ctx.after(() => {
          if (previous === undefined) delete process.env.OMEGA_HOME;
          else process.env.OMEGA_HOME = previous;
        });
        recordBrand({ id: 'acme-co', root: path.join(workspace, 'parent') });

        const companyFile = path.join(companyRoot, 'config', 'omega.json5');

        // The project root and its functions/ dir already resolved it.
        ctx.expect(loadConfig(projectRoot, 'backend').files.company).toBe(companyFile);
        ctx.expect(loadConfig(path.join(projectRoot, 'functions'), 'backend').files.company).toBe(companyFile);

        // ...and the staged dist/ now resolves the same layer.
        const staged = loadConfig(path.join(projectRoot, 'dist'), 'backend');
        ctx.expect(staged.files.company).toBe(companyFile);
        ctx.expect(staged.config.monitoring.providers.sentry.org).toBe('acme-co');
      },
    },

    {
      name: 'company layer: composeTargetConfig freezes it into the upload (the walk-up dies at the deploy boundary)',
      run: (ctx) => {
        const { workspace, brandRoot } = makeCompanyFixture(ctx, 'company-compose');
        cleanup(ctx, workspace);

        const targetDir = path.join(brandRoot, 'targets', 'backend');
        const { config } = composeTargetConfig(targetDir, 'backend');

        ctx.expect(config.monitoring.providers.sentry.org).toBe('acme-co');
        ctx.expect(config.probe.fromCompanyTarget).toBe(true);
        ctx.expect(config.probe.value).toBe('brand-shared');
        ctx.expect(Object.keys(config.targets).sort()).toEqual(['backend', 'web']);

        // The resolved company facts are frozen in too: a deployed runtime has no
        // registry and no company tree to resolve them from (#677).
        ctx.expect(config.company.name).toBe('Acme Inc');
      },
    },

    // ─── Environment overlays (#856) ───

    {
      name: 'overlayPath: the ONE spelling of an overlay file, beside its own base, whether or not it exists',
      run: (ctx) => {
        const base = path.join(TEMP_ROOT, 'nowhere', 'config', 'omega.json5');
        ctx.expect(overlayPath(base, 'development')).toBe(path.join(TEMP_ROOT, 'nowhere', 'config', 'omega.development.json5'));
        ctx.expect(overlayPath(base, 'production')).toBe(path.join(TEMP_ROOT, 'nowhere', 'config', 'omega.production.json5'));
      },
    },

    {
      name: '#856: an overlay at EVERY layer, each winning over its own base and losing to the next layer',
      run: (ctx) => {
        const { workspace, brandRoot } = makeCompanyFixture(ctx, 'overlay-chain', {
          'parent/company/config/omega.development.json5': `{
      probe: { value: 'company-overlay-shared', fromCompanyOverlayShared: true },
      order: { companyBase: 'company-overlay', companyVsBrand: 'company-overlay' },
      targets: { backend: { type: 'backend', probe: { value: 'company-overlay-target', fromCompanyOverlayTarget: true } } },
    }`,
          'brands/acme/config/omega.development.json5': `{
      probe: { value: 'brand-overlay', fromBrandOverlay: true },
      order: { brandBase: 'brand-overlay', brandVsLocal: 'brand-overlay' },
    }`,
          'brands/acme/targets/backend/config/omega.json5': `{
      probe: { value: 'local-shared', fromLocalShared: true },
      order: { brandVsLocal: 'local-shared', localBase: 'local-base' },
    }`,
          'brands/acme/targets/backend/config/omega.development.json5': `{
      probe: { value: 'local-overlay', fromLocalOverlay: true },
      order: { localBase: 'local-overlay' },
    }`,
          'brands/acme/targets/backend/config/omega.production.json5': `{
      probe: { fromLocalProduction: true },
    }`,
        });
        cleanup(ctx, workspace);

        const setEnvironment = useEnvironment(ctx);
        setEnvironment('development');

        const { config } = loadConfig(path.join(brandRoot, 'targets', 'backend'), 'backend');

        // The strongest layer is the local overlay, and every layer below it still contributed
        ctx.expect(config.probe.value).toBe('local-overlay');
        for (const key of ['fromCompanyShared', 'fromCompanyTarget', 'fromCompanyOverlayShared', 'fromCompanyOverlayTarget', 'fromBrandShared', 'fromBrandOverlay', 'fromLocalShared', 'fromLocalOverlay']) {
          ctx.expect(config.probe[key], `${key} survived the merge`).toBe(true);
        }

        // Each overlay beats its OWN base...
        ctx.expect(config.order.companyBase).toBe('company-overlay');
        ctx.expect(config.order.brandBase).toBe('brand-overlay');
        ctx.expect(config.order.localBase).toBe('local-overlay');
        // ...and still loses to the next layer's base
        ctx.expect(config.order.companyVsBrand, 'nothing above restated it').toBe('company-overlay');
        ctx.expect(config.order.brandVsLocal, 'the local BASE beats the brand overlay above it').toBe('local-shared');

        // Another environment's overlay is never a layer
        ctx.expect(config.probe.fromLocalProduction).toBe(undefined);
      },
    },

    {
      name: '#856: an overlay is a PARTIAL - three keys merge, the sibling keys survive, and the MERGED result validates',
      run: (ctx) => {
        const root = makeFixture('overlay-partial', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
      theme: { id: 'classy' },
      payment: { currency: 'USD', providers: { stripe: { publishableKey: 'pk_live_demo' } } },
      analytics: { providers: { google: { id: 'G-LIVE' } } },
      targets: { web: { type: 'web' } },
    }`,
          'config/omega.development.json5': `{
      theme: { id: 'newsflash' },
      payment: { providers: { stripe: { publishableKey: 'pk_test_demo' } } },
      analytics: { providers: { google: { id: 'G-DEV' } } },
    }`,
        });
        cleanup(ctx, root);

        const setEnvironment = useEnvironment(ctx);
        setEnvironment('development');

        const { config, errors } = loadConfig(root, 'web');

        ctx.expect(errors, 'nothing validates an overlay alone; the merged result is what is judged').toEqual([]);
        ctx.expect(config.theme.id).toBe('newsflash');
        ctx.expect(config.payment.providers.stripe.publishableKey).toBe('pk_test_demo');
        ctx.expect(config.analytics.providers.google.id).toBe('G-DEV');

        // Everything the three-key overlay never restates comes from the base
        ctx.expect(config.brand.name).toBe('Acme');
        ctx.expect(config.brand.url).toBe('https://acme.test');
        ctx.expect(config.payment.currency).toBe('USD');
      },
    },

    {
      name: '#856: only the RUNNING environment overlays - production never sees the development value, and an unknown name is not a layer at all',
      run: (ctx) => {
        const root = makeFixture('overlay-running-only', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      theme: { id: 'base' },
      targets: { web: { type: 'web' } },
    }`,
          'config/omega.development.json5': `{ theme: { id: 'development' }, probe: { fromDevelopment: true } }`,
          'config/omega.production.json5': `{ theme: { id: 'production' } }`,
          'config/omega.staging.json5': `{ theme: { id: 'staging' }, probe: { fromStaging: true } }`,
        });
        cleanup(ctx, root);

        const setEnvironment = useEnvironment(ctx);

        setEnvironment('production');
        const production = loadConfig(root, 'web').config;
        ctx.expect(production.theme.id).toBe('production');
        ctx.expect(production.probe, 'the development overlay is not in a production build').toBe(undefined);

        setEnvironment('development');
        const development = loadConfig(root, 'web').config;
        ctx.expect(development.theme.id).toBe('development');
        ctx.expect(development.probe.fromDevelopment).toBe(true);

        // `staging` is not an environment OMEGA has, so that file is not a layer:
        // nothing reads it in either run, and there is nothing to warn about
        ctx.expect(production.probe?.fromStaging).toBe(undefined);
        ctx.expect(development.probe.fromStaging).toBe(undefined);
      },
    },

    {
      name: '#856: an overlay is judged by the same raw-file hard fails as the base beside it',
      run: (ctx) => {
        const root = makeFixture('overlay-secrets', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { web: { type: 'web' } } }`,
          'config/omega.development.json5': `{ payment: { providers: { stripe: { secretKey: 'sk_live_x' } } } }`,
        });
        cleanup(ctx, root);

        const setEnvironment = useEnvironment(ctx);
        setEnvironment('development');

        ctx.expect(() => loadConfig(root, 'web')).toThrow(/Secret-shaped keys in .*omega\.development\.json5.*payment\.providers\.stripe\.secretKey/);
      },
    },

    {
      name: '#856: a brand overlay is the BRAND layer, so a named target still derives its own url under it',
      run: (ctx) => {
        const root = makeFixture('overlay-brand-url', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
      targets: { web: { type: 'web' }, admin: { type: 'web' } },
    }`,
          'config/omega.development.json5': `{ brand: { url: 'https://acme.localhost' } }`,
          'targets/web/package.json': '{}',
          'targets/admin/package.json': '{}',
        });
        cleanup(ctx, root);

        const setEnvironment = useEnvironment(ctx);
        setEnvironment('development');

        const admin = loadConfig(path.join(root, 'targets', 'admin'), 'web');
        ctx.expect(admin.config.brand.url).toBe('https://acme.localhost');
        ctx.expect(admin.config.url, 'the overlay is the brand layer, not an override below it').toBe('https://admin.acme.localhost');
      },
    },

    {
      name: '#856: the sandbox brand ships a development overlay - the Stripe publishable key is set there and nowhere else',
      run: (ctx) => {
        const brandRoot = path.join(__dirname, '..', '..', '..', 'brands', 'sandbox-brand');
        const setEnvironment = useEnvironment(ctx);

        setEnvironment('development');
        const development = loadConfig(brandRoot);
        ctx.expect(development.config.payment.providers.stripe.publishableKey).toBe('pk_test_demo-sandbox-brand');

        setEnvironment('production');
        const production = loadConfig(brandRoot);
        ctx.expect(production.config.payment.providers.stripe.publishableKey, 'production carries the base value').toBe(null);
      },
    },

    {
      name: '#856: options.environment names the overlay, beating this machine ambient answer',
      run: (ctx) => {
        const root = makeFixture('overlay-explicit', {
          'config/omega.json5': `{
      brand: { id: 'acme', name: 'Acme' },
      theme: { id: 'base' },
      targets: { web: { type: 'web' } },
    }`,
          'config/omega.development.json5': `{ theme: { id: 'development' }, probe: { fromDevelopment: true } }`,
          'config/omega.production.json5': `{ theme: { id: 'production' } }`,
        });
        cleanup(ctx, root);

        const setEnvironment = useEnvironment(ctx);
        setEnvironment('development');

        // The LANE names the environment its artifact is for: a production build runs
        // on a machine whose ambient answer is `development`, and the artifact still
        // carries production values only.
        const production = loadConfig(root, 'web', { environment: 'production' }).config;
        ctx.expect(production.theme.id).toBe('production');
        ctx.expect(production.probe, 'no development override reaches a production artifact').toBe(undefined);

        // Unnamed, the ambient answer still decides: a dev boot changes nothing.
        ctx.expect(loadConfig(root, 'web').config.theme.id).toBe('development');
      },
    },

    {
      name: '#856: an unknown options.environment throws naming the three names',
      run: (ctx) => {
        const root = makeFixture('overlay-unknown-environment', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { web: { type: 'web' } } }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root, 'web', { environment: 'staging' })).toThrow(/Unknown environment "staging".*development, testing, production/);
        ctx.expect(() => composeTargetConfig(root, 'web', { environment: 'staging' })).toThrow(/Unknown environment "staging".*development, testing, production/);
      },
    },

    {
      name: '#856: composeTargetConfig freezes the overlay of the environment it is TOLD, and none when told nothing',
      run: (ctx) => {
        const targetDir = path.join(__dirname, '..', '..', '..', 'brands', 'sandbox-brand', 'targets', 'backend');
        const setEnvironment = useEnvironment(ctx);

        // The composing machine answers `development`, and it is never asked: an
        // upload composed for production carries the base value.
        setEnvironment('development');
        const production = composeTargetConfig(targetDir, 'backend', { environment: 'production' });
        ctx.expect(production.config.payment.providers.stripe.publishableKey, 'the development test key never rides a production upload').toBe(null);

        const development = composeTargetConfig(targetDir, 'backend', { environment: 'development' });
        ctx.expect(development.config.payment.providers.stripe.publishableKey, 'a local stage composes the development overlay the same way its .env does').toBe('pk_test_demo-sandbox-brand');

        // Told nothing, a compose is the authored layers alone: no overlay at all,
        // whatever this machine happens to answer.
        ctx.expect(composeTargetConfig(targetDir, 'backend').config.payment.providers.stripe.publishableKey).toBe(null);
      },
    },

    {
      name: 'a sidecar item carrying org fails the strict check, from a target (the brand layer) and at the brand root',
      run: (ctx) => {
        const root = makeFixture('sidecar-org', {
          'config/omega.json5': SIDECAR_BASE,
          'config/seo.json5': `{ github: { content: [{ name: 'fixture-tool', org: 'Acme-Org' }] } }`,
          'targets/web/package.json': '{}',
        });
        cleanup(ctx, root);

        const line = `config.seo.github.content[0].org ${UNDECLARED}`;
        ctx.expect(loadConfig(path.join(root, 'targets', 'web'), 'web').errors).toEqual([line]);
        ctx.expect(loadConfig(root).errors).toEqual([line]);
      },
    },

    {
      name: 'a sidecar token written as env:NAME fails the load with the secret line, naming the sidecar',
      run: (ctx) => {
        const root = makeFixture('sidecar-secret', {
          'config/omega.json5': SIDECAR_BASE,
          'config/seo.json5': `{ github: { content: [{ name: 'fixture-tool', author: { token: 'env:X' } }] } }`,
        });
        cleanup(ctx, root);

        ctx.expect(() => loadConfig(root)).toThrow(/Secret-shaped keys in .*config[/\\]seo\.json5.*seo\.github\.content\[0\]\.author\.token/);
      },
    },

    {
      name: 'a sidecar content list and the base file\'s seo.enabled both land in the loaded seo section',
      run: (ctx) => {
        const root = makeFixture('sidecar-merge', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, seo: { enabled: false }, targets: { web: { type: 'web' } } }`,
          'config/seo.json5': `{ github: { content: [{ name: 'fixture-tool', owner: 'Acme-Org' }] } }`,
        });
        cleanup(ctx, root);

        const { config, errors } = loadConfig(root);
        ctx.expect(errors).toEqual([]);
        ctx.expect(config.seo.enabled).toBe(false);
        ctx.expect(config.seo.github.content).toEqual([{ name: 'fixture-tool', owner: 'Acme-Org' }]);
      },
    },

    {
      name: 'a target\'s own config/seo.json5 is not a layer: from the target only the brand root\'s sidecar lands',
      run: (ctx) => {
        const root = makeFixture('sidecar-target', {
          'config/omega.json5': SIDECAR_BASE,
          'config/seo.json5': `{ github: { content: [{ name: 'fixture-tool', owner: 'Acme-Org' }] } }`,
          'targets/web/config/omega.json5': '{}',
          'targets/web/config/seo.json5': `{ github: { content: [{ name: 'target-tool', org: 'Acme-Org' }] } }`,
        });
        cleanup(ctx, root);

        const { config, errors } = loadConfig(path.join(root, 'targets', 'web'), 'web');
        ctx.expect(errors).toEqual([]);
        ctx.expect(config.seo.github.content).toEqual([{ name: 'fixture-tool', owner: 'Acme-Org' }]);
      },
    },

    {
      name: 'composeTargetConfig freezes the brand root\'s sidecar into the upload',
      run: (ctx) => {
        const root = makeFixture('sidecar-compose', {
          'config/omega.json5': SIDECAR_BASE,
          'config/seo.json5': `{ github: { content: [{ name: 'fixture-tool', owner: 'Acme-Org' }] } }`,
          'targets/web/package.json': '{}',
        });
        cleanup(ctx, root);

        const composed = composeTargetConfig(path.join(root, 'targets', 'web'), 'web');
        ctx.expect(composed.config.seo.github.content).toEqual([{ name: 'fixture-tool', owner: 'Acme-Org' }]);
      },
    },

    {
      name: 'the playground and newsflash brands load clean at their roots, the sidecar read',
      run: (ctx) => {
        // A temp home of its own: the playground's company resolves from no real registry line.
        const previous = process.env.OMEGA_HOME;
        process.env.OMEGA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-config-home-'));
        ctx.after(() => {
          fs.rmSync(process.env.OMEGA_HOME, { recursive: true, force: true });
          if (previous === undefined) delete process.env.OMEGA_HOME;
          else process.env.OMEGA_HOME = previous;
        });

        const brands = path.join(__dirname, '..', '..', '..', 'brands');

        const playground = loadConfig(path.join(brands, 'playground-omega'));
        ctx.expect(playground.errors).toEqual([]);
        ctx.expect(playground.config.seo.github.content[0].name).toBe('omega-playground-seo-demo');

        ctx.expect(loadConfig(path.join(brands, 'newsflash-brand')).errors).toEqual([]);
      },
    },
  ],
});
