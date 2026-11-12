// The fixture's context menu, an ES module: its default export adds one item
// named for this folder on every right-click, which suites/boot/integration-esm.test.js looks for.
import path from 'node:path';

export default ({ menu }) => {
  menu.useDefaults();
  menu.item({ id: `${path.basename(import.meta.dirname)}-esm`, label: 'ES module context menu' });
};
