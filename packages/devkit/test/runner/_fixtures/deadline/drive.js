/**
 * Runs one process-isolated createRunner config over a fixture and writes
 * `{ result, error, reads }` to the out file, `reads` counting the runner's
 * process table reads. Usage: node drive.js <config json> <outFile>
 * The config is `{ fixture, ...createRunner keys }`, the fixture relative to `_fixtures/`.
 */
const fs = require('node:fs');
const path = require('node:path');
const processTree = require('../../../../src/process-tree.js');

// Count each read and still read the real table, installed before the runner loads.
let reads = 0;
const readProcessTable = processTree.readProcessTable;
processTree.readProcessTable = (...args) => {
  reads += 1;
  return readProcessTable(...args);
};

const { createRunner } = require('../../../../src/test/runner.js');

const [configJson, outFile] = process.argv.slice(2);
const { fixture, ...knobs } = JSON.parse(configJson);
const projectRoot = path.join(__dirname, '..', fixture);

async function main() {
  let result = null;
  let error = null;
  try {
    const runner = createRunner({
      framework: 'node',
      title: `Fixture ${fixture}`,
      projectRoot,
      roots: [{ source: 'project', dir: path.join(projectRoot, 'test') }],
      drivers: {},
      log: `${outFile}.log`,
      defaultTimeout: 10000,
      packageName: `fixture-${path.basename(fixture)}`,
      frameworkAliases: [],
      isolation: 'process',
      ...knobs,
    });
    result = await runner.run({ targets: [], reporter: 'json' });
  } catch (e) {
    error = { message: e.message };
  }
  fs.writeFileSync(outFile, JSON.stringify({ result, error, reads }));
  process.exit(0);
}

main();
