/**
 * parse-audit tests — the tree walker must catch SyntaxError files (including
 * the motivating case: a regex literal corrupted by a rename sweep) without
 * false-positives on valid CJS, ESM, or shebang'd sources, and without
 * descending into build-output dirs.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');

const { parseAuditTree } = require('../src/parse-audit.js');

const TEMP_ROOT = path.join(__dirname, '..', '.temp');

function makeTree(name, files) {
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

module.exports = defineCases({
  type: 'group',
  description: 'parse-audit',
  tests: [
    {
      name: 'parse-audit: catches a rename-corrupted regex literal, passes valid CJS/ESM/shebang',
      run: (ctx) => {
        const root = makeTree('parse-audit-mixed', {
          // Valid CJS
          'lib/good.js': `const path = require('path');\nmodule.exports = { p: path.sep };\n`,
          // Valid ESM (would fail a CJS-wrap parse — must not be reported)
          'web/module.js': `import path from 'node:path';\nexport const p = path.sep;\n`,
          // Valid CJS with shebang
          'bin/cli.js': `#!/usr/bin/env node\nconsole.log('ok');\n`,
          // The motivating casualty: unescaped / injected into a regex literal
          'cli/broken.js': `const re = /({{\\s*?@omega.js/backend\\s*?}})/sgm;\nmodule.exports = re;\n`,
        });
        cleanup(ctx, root);

        const { checked, failures } = parseAuditTree(root);
        ctx.expect(checked).toBe(4);
        ctx.expect(failures.length).toBe(1);
        ctx.expect(failures[0].file).toBe(path.join('cli', 'broken.js'));
        ctx.expect(failures[0].error).toMatch(/Invalid regular expression flags|Unexpected/);
      },
    },

    {
      name: 'parse-audit: of three ES module files, names the broken one and passes the other two',
      run: (ctx) => {
        const root = makeTree('parse-audit-esm', {
          'routes/get.js': `import path from 'node:path';\nexport default async () => path.sep;\n`,
          'routes/post.js': `#!/usr/bin/env node\nexport default async ({ ctx }) => ctx;\n`,
          'routes/broken.js': `import path from 'node:path';\nexport default async () => { path.sep(((;\n`,
        });
        cleanup(ctx, root);

        const { checked, failures } = parseAuditTree(root);

        ctx.expect(checked).toBe(3);
        ctx.expect(failures.map((failure) => failure.file)).toEqual([path.join('routes', 'broken.js')]);
      },
    },

    {
      name: 'parse-audit: skips build-output dirs by default, honors custom skipDirs',
      run: (ctx) => {
        const root = makeTree('parse-audit-skips', {
          'src/ok.js': `module.exports = 1;\n`,
          'node_modules/dep/broken.js': `syntax error here(((\n`,
          'dist/broken.js': `also broken(((\n`,
          '_backup/broken.js': `broken too(((\n`,
        });
        cleanup(ctx, root);

        // Defaults: node_modules + dist skipped; _backup is NOT in the default list
        const withDefaults = parseAuditTree(root);
        ctx.expect(withDefaults.checked).toBe(2);
        ctx.expect(withDefaults.failures.length).toBe(1);
        ctx.expect(withDefaults.failures[0].file).toBe(path.join('_backup', 'broken.js'));

        // Custom list replaces the defaults
        const custom = parseAuditTree(root, { skipDirs: ['node_modules', 'dist', '_backup'] });
        ctx.expect(custom.checked).toBe(1);
        ctx.expect(custom.failures.length).toBe(0);
      },
    },
  ],
});
