// The fixture's tray, an ES module: its default export adds one item named for
// this folder, which suites/boot/integration-esm.test.js looks for.
import path from 'node:path';

export default ({ tray }) => {
  tray.useDefaults();
  tray.item({ id: `${path.basename(import.meta.dirname)}-esm`, label: 'ES module tray' });
};
