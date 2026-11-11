/**
 * root-lanes.js tests: the root run's lanes narrow to the packages lane on a
 * CI run, keep every lane otherwise, and each lane names a real root script.
 * Run: node packages/devkit/src/test/cli.js --root=scripts root-lanes
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const { LANES, lanesFor } = require('./root-lanes');

const ROOT_PACKAGE = path.join(__dirname, '..', 'package.json');

const EVERY_LANE = [
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

module.exports = defineCases({
  type: 'group',
  description: 'root-lanes',
  tests: [
    {
      name: 'root-lanes: CI set runs the packages lane alone, no emulator lane',
      run: (ctx) => {
        ctx.expect(lanesFor({ CI: 'true' })).toEqual(['npm run test:packages']);
      },
    },

    {
      name: 'root-lanes: GITHUB_ACTIONS set with no CI runs the packages lane alone',
      run: (ctx) => {
        ctx.expect(lanesFor({ GITHUB_ACTIONS: 'true' })).toEqual(['npm run test:packages']);
      },
    },

    {
      name: 'root-lanes: CI unset or empty runs the packages lane first, then every emulator lane',
      run: (ctx) => {
        ctx.expect(lanesFor({})).toEqual(EVERY_LANE);
        ctx.expect(lanesFor({ CI: '' })).toEqual(EVERY_LANE);
      },
    },

    {
      name: 'root-lanes: every lane runs a script the root package.json defines',
      run: (ctx) => {
        const { scripts } = JSON.parse(fs.readFileSync(ROOT_PACKAGE, 'utf8'));

        for (const lane of LANES) {
          const name = lane.match(/^npm run (\S+)$/)?.[1];
          ctx.expect(name, `"${lane}" is not an npm run command`).toBeDefined();
          ctx.expect(scripts, `"${lane}" names no root script`).toHaveProperty([name]);
        }
      },
    },
  ],
});
