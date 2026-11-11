/**
 * The targets map keyed by NAME (#886): entry enumeration and its missing-type
 * throw, the name-IS-the-folder path derivation, the target-dir walk, the
 * public-url resolution, and the dev-port offset among same-type siblings.
 *
 * Fixtures are built under packages/config/.temp/ (gitignored), matching the
 * loader test convention.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');

const {
  targetEntries, targetsOfType, hasTargetOfType, targetPath, targetNameFromDir, targetUrl, targetPortOffset,
  TARGET_NAME_PATTERN, TARGET_TYPES,
} = require('../src/index.js');

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

// Ian's own example (#886): two web targets, a backend, a desktop, a custom one
const BRAND = {
  brand: { id: 'somiibo', name: 'Somiibo', url: 'https://somiibo.com' },
  targets: {
    web: { type: 'web', url: 'https://somiibo.com' },
    community: { type: 'web', url: 'https://community.somiibo.com' },
    backend: { type: 'backend' },
    desktop: { type: 'desktop' },
    docs: { type: 'custom' },
  },
};

module.exports = defineCases({
  type: 'group',
  description: 'targets',
  tests: [
    // ─── targetEntries ───

    {
      name: 'targetEntries: { name, type, ...entry } in config order; no targets = []',
      run: (ctx) => {
        const entries = targetEntries(BRAND);

        ctx.expect(entries.map((entry) => entry.name)).toEqual(['web', 'community', 'backend', 'desktop', 'docs']);
        ctx.expect(entries[1]).toEqual({ type: 'web', url: 'https://community.somiibo.com', name: 'community' });

        ctx.expect(targetEntries({ brand: { id: 'acme' } })).toEqual([]);
        ctx.expect(targetEntries(undefined)).toEqual([]);

        ctx.expect(targetsOfType(BRAND, 'web').map((entry) => entry.name)).toEqual(['web', 'community']);
        ctx.expect(targetsOfType(BRAND, 'custom').map((entry) => entry.name)).toEqual(['docs']);

        // The type list is the frameworks plus custom, and nothing else
        ctx.expect(TARGET_TYPES).toEqual(['web', 'backend', 'desktop', 'extension', 'mobile', 'custom']);
        ctx.expect(TARGET_NAME_PATTERN.test('community') && !TARGET_NAME_PATTERN.test('Community Site')).toBeTruthy();
      },
    },

    {
      name: 'targetEntries: an entry with no type, or an unknown one, throws naming the key',
      run: (ctx) => {
        ctx.expect(() => targetEntries({ targets: { web: { type: 'web' }, admin: {} } })).toThrow(/targets\.admin must declare a type.*got nothing/);
        ctx.expect(() => targetEntries({ targets: { admin: { type: 'website' } } })).toThrow(/targets\.admin must declare a type.*"website"/);
      },
    },

    // ─── hasTargetOfType (the ONE presence gate) ───

    {
      name: 'hasTargetOfType: by TYPE, so a backend named api still gates the backend services',
      run: (ctx) => {
        ctx.expect(hasTargetOfType(BRAND, 'backend')).toBe(true);
        ctx.expect(hasTargetOfType(BRAND, 'mobile')).toBe(false);
        ctx.expect(hasTargetOfType({ targets: { api: { type: 'backend' } } }, 'backend')).toBe(true);

        // Raw, unvalidated configs answer instead of throwing
        ctx.expect(hasTargetOfType({ targets: { admin: {} } }, 'web')).toBe(false);
        ctx.expect(hasTargetOfType({ brand: { id: 'acme' } }, 'web')).toBe(false);
        ctx.expect(hasTargetOfType(undefined, 'web')).toBe(false);
      },
    },

    // ─── targetPath (the name IS the folder) ───

    {
      name: 'targetPath: targets/<name>, and an undeclared name throws with the declared list',
      run: (ctx) => {
        ctx.expect(targetPath(BRAND, 'community')).toBe('targets/community');
        ctx.expect(targetPath(BRAND, 'web')).toBe('targets/web');

        ctx.expect(() => targetPath(BRAND, 'website')).toThrow(/No target "website" is declared/);
        ctx.expect(() => targetPath(BRAND, 'website')).toThrow(/web, community, backend, desktop, docs/);
      },
    },

    // ─── targetNameFromDir ───

    {
      name: 'targetNameFromDir: the target root names it inside a brand (functions/ and dist/ normalize up); null outside',
      run: (ctx) => {
        const root = makeFixture('targets-dir-walk', {
          'config/omega.json5': `{ brand: { id: 'acme', name: 'Acme' }, targets: { web: { type: 'web' }, admin: { type: 'web' }, backend: { type: 'backend' } } }`,
          'targets/web/package.json': '{}',
          'targets/admin/package.json': '{}',
          'targets/backend/functions/package.json': '{}',
        });
        cleanup(ctx, root);

        ctx.expect(targetNameFromDir(path.join(root, 'targets', 'web'))).toBe('web');
        ctx.expect(targetNameFromDir(path.join(root, 'targets', 'admin'))).toBe('admin');
        ctx.expect(targetNameFromDir(path.join(root, 'targets', 'backend', 'functions'))).toBe('backend');
        ctx.expect(targetNameFromDir(path.join(root, 'targets', 'admin', 'dist'))).toBe('admin');

        // A STANDALONE project's dir name is arbitrary, so it names no target
        const standalone = makeFixture('admin', {
          'config/omega.json5': `{ brand: { id: 'solo', name: 'Solo' }, targets: { web: { type: 'web' } } }`,
        });
        cleanup(ctx, standalone);
        ctx.expect(targetNameFromDir(standalone)).toBe(null);
      },
    },

    // ─── targetUrl ───

    {
      name: 'targetUrl: entry url, then an entry brand.url, then the derivation',
      run: (ctx) => {
        const config = {
          brand: { url: 'https://acme.test' },
          targets: {
            web: { type: 'web' },
            store: { type: 'web', url: 'https://shop.acme.com' },
            help: { type: 'web', brand: { url: 'https://help.zendesk.com' } },
            admin: { type: 'web' },
            backend: { type: 'backend' },
          },
        };

        ctx.expect(targetUrl(config, 'store')).toBe('https://shop.acme.com');
        ctx.expect(targetUrl(config, 'help')).toBe('https://help.zendesk.com');

        // Named for its type = the brand itself, never web.acme.test
        ctx.expect(targetUrl(config, 'web')).toBe('https://acme.test');
        ctx.expect(targetUrl(config, 'backend')).toBe('https://acme.test');

        // Any other name IS the subdomain, which is what makes a bare entry complete
        ctx.expect(targetUrl(config, 'admin')).toBe('https://admin.acme.test');
        // A name with no entry at all still derives, since the name is the whole input
        ctx.expect(targetUrl(config, 'cdn')).toBe('https://cdn.acme.test');
      },
    },

    {
      name: 'targetUrl: the host is taken exactly as brand.url states it (www kept, path dropped, port kept)',
      run: (ctx) => {
        const targets = { admin: { type: 'web' } };

        ctx.expect(targetUrl({ brand: { url: 'https://www.acme.test' }, targets }, 'admin')).toBe('https://admin.www.acme.test');
        ctx.expect(targetUrl({ brand: { url: 'https://acme.test/base/' }, targets }, 'admin')).toBe('https://admin.acme.test');
        ctx.expect(targetUrl({ brand: { url: 'acme.test:8080' }, targets }, 'admin')).toBe('https://admin.acme.test:8080');
      },
    },

    {
      name: 'targetUrl: no brand url at all is null, never a half-derived https://admin.',
      run: (ctx) => {
        const targets = { admin: { type: 'web' } };

        ctx.expect(targetUrl({ targets }, 'admin')).toBe(null);
        ctx.expect(targetUrl(undefined, 'admin')).toBe(null);
        // An unparseable brand.url derives nothing rather than guessing a host
        ctx.expect(targetUrl({ brand: { url: 'https://' }, targets }, 'admin')).toBe(null);
      },
    },

    {
      name: 'targetUrl: a second web target on a default Pages host is its own Pages address, never a github.io subdomain',
      run: (ctx) => {
        const config = {
          brand: { id: 'dreamr', name: 'Dreamr', url: 'https://dreamr-design.github.io/dreamr-web' },
          repo: { owner: 'dreamr-design' },
          targets: { web: { type: 'web' }, admin: { type: 'web' } },
        };

        ctx.expect(targetUrl(config, 'admin')).toBe('https://dreamr-design.github.io/dreamr-admin');
      },
    },

    {
      name: 'targetUrl: on a default Pages host the backend is the Cloud Functions address and a desktop has no url',
      run: (ctx) => {
        const config = {
          brand: { id: 'dreamr', name: 'Dreamr', url: 'https://dreamr-design.github.io/dreamr-web' },
          repo: { owner: 'dreamr-design' },
          cloud: { config: { projectId: 'dreamr-app' } },
          targets: { web: { type: 'web' }, admin: { type: 'web' }, backend: { type: 'backend' }, desktop: { type: 'desktop' } },
        };

        ctx.expect(targetUrl(config, 'backend')).toBe('https://us-central1-dreamr-app.cloudfunctions.net/omega_api');
        ctx.expect(targetUrl(config, 'desktop'), 'no api.<owner>.github.io-style host nobody serves').toBe(null);
        ctx.expect(targetUrl(config, 'admin'), 'a sibling web target keeps its own Pages address').toBe('https://dreamr-design.github.io/dreamr-admin');
      },
    },

    // ─── targetPortOffset ───

    {
      name: 'targetPortOffset: position among the SAME-type targets, so side-by-side dev ports',
      run: (ctx) => {
        const config = {
          targets: {
            web: { type: 'web' },
            backend: { type: 'backend' },
            community: { type: 'web' },
          },
        };

        ctx.expect(targetPortOffset(config, 'web')).toBe(0);
        ctx.expect(targetPortOffset(config, 'community'), 'the backend between them does not shift the second web target').toBe(1);
        ctx.expect(targetPortOffset(config, 'backend')).toBe(0);

        // Unknown names stay at the classic base
        ctx.expect(targetPortOffset(config, 'nope')).toBe(0);
        ctx.expect(targetPortOffset(undefined, 'web')).toBe(0);
      },
    },
  ],
});
