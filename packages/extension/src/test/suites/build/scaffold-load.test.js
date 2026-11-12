// The scaffold's hook files load: each one under defaults/hooks loads through
// require() and devkit's defaultExport answers a function, the read the hook
// runner makes. A new scaffold hook is walked in with no edit here.

const path = require('path');
const jetpack = require('fs-jetpack');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { defaultExport } = require('@omega.js/devkit/run-consumer-hook');

const DEFAULTS = path.join(__dirname, '..', '..', '..', 'defaults');
const SCAFFOLD_FOLDERS = ['hooks'];

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'scaffold load: every extension scaffold hook is an ES module with a function default export',
  tests: [
    {
      name: 'each scaffold hook loads through require() and answers a function default export',
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
