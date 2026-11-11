/**
 * Root lanes: `node scripts/root-lanes.js`, the root `npm test`.
 * Holds the lanes a root run goes through, in order, and runs them as ONE
 * `scripts/lane.js test` lane. On a CI run (devkit's `isCI`) it runs the
 * packages lane alone, since a runner hosts no emulator e2e lane, and says so
 * on one line first. Exits with the lane's code.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { isCI } = require('@omega.js/devkit/ci');

// The packages lane leads: on a CI run it is the whole run.
const LANES = [
  'npm run test:packages',
  'npm run test:corpus',
  'npm run test:e2e',
  'npm run test:e2e-extension',
  'npm run test:e2e-desktop',
  'npm run test:verts',
  'npm run test:auth',
  'npm run test:flows',
  'npm run test:journey',
];

/**
 * The lanes a root run goes through in this environment.
 * @param {Object<string, string|undefined>} env - the environment `isCI` reads
 * @returns {string[]} the packages lane alone on a CI run, else every lane
 */
function lanesFor(env) {
  return isCI(env) ? [LANES[0]] : LANES;
}

function main() {
  const lanes = lanesFor(process.env);

  if (lanes.length < LANES.length) {
    console.log(`This is a CI run, so the root run is the packages lane alone (${lanes.join(', ')})`);
  }

  const result = spawnSync(process.execPath, [path.join(__dirname, 'lane.js'), 'test', ...lanes], { stdio: 'inherit' });
  if (result.error) throw result.error;

  // A signalled death has no status, and counts as a failure like lane.js's own children.
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = { LANES, lanesFor };
