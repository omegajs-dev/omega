/**
 * The target type table: one frozen row per target type, the one home every
 * per-type rule derives from. The frameworks are pinned against the package
 * folders on disk, and the walk order against the verb table's TARGET_ORDER.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');

const { TARGET_TYPE_ROWS, targetType } = require('../src/target-types.js');
const { validateConfig, TARGET_TYPES } = require('../src/index.js');

const PACKAGES_DIR = path.join(__dirname, '..', '..');

// Every package folder that holds a manifest, as { dir, manifest }
function packageManifests() {
  return fs.readdirSync(PACKAGES_DIR)
    .filter((dir) => fs.existsSync(path.join(PACKAGES_DIR, dir, 'package.json')))
    .map((dir) => ({ dir, manifest: JSON.parse(fs.readFileSync(path.join(PACKAGES_DIR, dir, 'package.json'), 'utf8')) }));
}

module.exports = defineCases({
  type: 'group',
  description: 'target-types',
  tests: [
    {
      name: 'the rows are frozen, one per type in the schema order, and an unknown id answers null',
      run: (ctx) => {
        ctx.expect(TARGET_TYPE_ROWS.map((row) => row.id)).toEqual(['web', 'backend', 'desktop', 'extension', 'mobile']);
        ctx.expect(Object.isFrozen(TARGET_TYPE_ROWS), 'the table itself is frozen').toBe(true);
        for (const row of TARGET_TYPE_ROWS) ctx.expect(Object.isFrozen(row), `${row.id} row is frozen`).toBe(true);

        ctx.expect(Object.fromEntries(TARGET_TYPE_ROWS.map((row) => [row.id, row.translates])), 'every row says translates outright')
          .toEqual({ web: true, backend: false, desktop: false, extension: true, mobile: false });

        ctx.expect(targetType('desktop')).toBe(TARGET_TYPE_ROWS[2]);
        ctx.expect(targetType('website')).toBe(null);
        ctx.expect(targetType('custom'), 'custom is no type with rules').toBe(null);
      },
    },

    {
      name: 'sorted by walkRank the rows walk backend, web, extension, desktop, mobile, and TARGET_ORDER is that walk',
      run: (ctx) => {
        const walk = [...TARGET_TYPE_ROWS].sort((a, b) => a.walkRank - b.walkRank).map((row) => row.id);
        const { TARGET_ORDER } = require('@omega.js/devkit/verbs');

        ctx.expect(walk).toEqual(['backend', 'web', 'extension', 'desktop', 'mobile']);
        ctx.expect(TARGET_ORDER).toEqual(walk);
      },
    },

    {
      name: 'every row framework is the package on disk at packages/<id>, and every framework package has a row',
      run: (ctx) => {
        const framed = TARGET_TYPE_ROWS.filter((row) => row.framework);
        for (const row of framed) {
          const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGES_DIR, row.id, 'package.json'), 'utf8'));
          ctx.expect(manifest.name, `packages/${row.id}`).toBe(row.framework);
        }

        // A framework package ships the `omega` bin and scaffolds a target
        const frameworks = packageManifests()
          .filter(({ manifest }) => manifest.bin && manifest.bin.omega && manifest.exports && manifest.exports['./ensure-target']);
        ctx.expect(frameworks.length > 0, 'the walk found the framework packages').toBe(true);
        for (const { dir, manifest } of frameworks) {
          ctx.expect(framed.some((row) => row.framework === manifest.name), `packages/${dir} (${manifest.name}) has a row`).toBe(true);
        }

        const bare = TARGET_TYPE_ROWS.filter((row) => !row.framework);
        ctx.expect(bare.map((row) => row.id), 'only mobile has no framework').toEqual(['mobile']);
        ctx.expect(bare.every((row) => row.reserved === true), 'a row with no framework is reserved').toBe(true);
      },
    },

    {
      name: 'the schema takes exactly the row ids plus custom as a target type',
      run: (ctx) => {
        const types = [...TARGET_TYPE_ROWS.map((row) => row.id), 'custom'];
        ctx.expect(TARGET_TYPES).toEqual(types);

        const brand = { brand: { id: 'sandbox-brand', name: 'Sandbox Brand' } };
        const targets = Object.fromEntries(types.map((type) => [type, { type }]));
        ctx.expect(validateConfig({ ...brand, targets }).errors).toEqual([]);

        const { errors } = validateConfig({ ...brand, targets: { app: { type: 'ios' } } });
        ctx.expect(errors.some((error) => error.includes('config.targets.app must declare `type`')), errors.join(' | ')).toBe(true);
      },
    },

    {
      name: 'with no pick, onboarding defaults to web alone and `omega dev` to web and backend',
      run: (ctx) => {
        ctx.expect(TARGET_TYPE_ROWS.filter((row) => row.onboardDefault).map((row) => row.id)).toEqual(['web']);
        ctx.expect(TARGET_TYPE_ROWS.filter((row) => row.devDefault).map((row) => row.id)).toEqual(['web', 'backend']);
      },
    },
  ],
});
