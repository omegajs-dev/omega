// The scaffold's hook and integration files load: each one under defaults/hooks
// and defaults/src/integrations loads through require() and devkit's
// defaultExport answers a function, the read the hook runner and the
// integration loader make. A new scaffold file is walked in with no edit here.

const path = require('path');
const jetpack = require('fs-jetpack');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { defaultExport } = require('@omega.js/devkit/run-consumer-hook');

const DEFAULTS = path.join(__dirname, '..', '..', '..', 'defaults');
const SCAFFOLD_FOLDERS = ['hooks', path.join('src', 'integrations')];

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'scaffold load: every desktop scaffold hook and integration is an ES module with a function default export',
  tests: [
    {
      name: 'each scaffold hook and integration loads through require() and answers a function default export',
      run: async (ctx) => {
        for (const folder of SCAFFOLD_FOLDERS) {
          const files = jetpack.find(path.join(DEFAULTS, folder), { matching: '**/*.js' }).map((file) => path.resolve(file));
          ctx.expect(files.length, `${folder} holds scaffold files`).toBeGreaterThan(0);

          for (const file of files) {
            let verdict;
            try {
              verdict = typeof defaultExport(file, require(file));
            } catch (error) {
              verdict = error.message;
            }
            ctx.expect(verdict, path.relative(DEFAULTS, file)).toBe('function');
          }
        }
      },
    },
  ],
});
