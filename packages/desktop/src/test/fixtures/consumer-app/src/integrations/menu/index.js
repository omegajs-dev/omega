// The fixture's application menu, an ES module: its default export adds one
// top-level menu named for this folder, which suites/boot/integration-esm.test.js looks for.
import path from 'node:path';

export default ({ menu }) => {
  const id = `${path.basename(import.meta.dirname)}-esm`;

  menu.useDefaults();
  menu.menu('Fixture', [{ id: `${id}/probe`, label: 'ES module menu' }]);
};
