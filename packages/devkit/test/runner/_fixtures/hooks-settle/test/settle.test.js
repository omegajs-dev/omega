const fs = require('node:fs');
const defineCases = require('../../../../../src/test/define-cases.js');

const record = (line) => fs.appendFileSync(process.env.FIXTURE_OUT, `${line}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = defineCases({
  type: 'suite',
  description: 'steps settle inside their limit',
  timeout: 2000,
  async setup() {
    await delay(30);
    record('setup');
  },
  async cleanup() {
    await delay(30);
    record('cleanup');
  },
  tests: [
    {
      name: 'first',
      run(ctx) {
        ctx.after(async () => {
          await delay(30);
          record('after');
        });
        record('first');
      },
    },
    { name: 'second', run: () => record('second') },
  ],
});
