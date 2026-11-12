// Build-layer test for src/utils/load-consumer-file.js, the loader behind the tray,
// menu and context-menu integrations: an integration written the old way, with
// `module.exports`, is refused by name instead of loaded. The ES module side runs
// in the real app, in suites/boot/integration-esm.test.js.

const path = require('path');
const fs = require('fs');
const os = require('os');
const defineCases = require('@omega.js/devkit/test/define-cases');

const loadConsumerFile = require(path.join(__dirname, '..', '..', '..', 'utils', 'load-consumer-file.js'));

const REFUSAL = 'must be an ES module with one default export (export default async (...) => {})';

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'load-consumer-file: a module.exports integration is refused',
  tests: [
    {
      name: 'a module.exports tray integration is refused, naming the file and the form it must take',
      run: async (ctx) => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-integration-')));
        const file = path.join(tmp, 'src', 'integrations', 'tray', 'index.js');
        ctx.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

        fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"desktop-integration-consumer"}');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'module.exports = ({ tray }) => { tray.useDefaults(); };\n');

        let error = null;
        try {
          await loadConsumerFile(file);
        } catch (e) {
          error = e;
        }

        ctx.expect(error, 'the old form never loads').not.toBeNull();
        ctx.expect(error.message).toContain(`${path.join('integrations', 'tray', 'index.js')} ${REFUSAL}`);
      },
    },
  ],
});
