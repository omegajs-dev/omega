const fs = require('node:fs');
const defineCases = require('../../../../../src/test/define-cases.js');

const record = (line) => fs.appendFileSync(process.env.FIXTURE_OUT, `${line}\n`);

module.exports = defineCases({
  type: 'suite',
  description: 'the next suite',
  tests: [
    { name: 'the next suite runs', run: () => record('next suite') },
  ],
});
