const fs = require('node:fs');
const { spawn } = require('node:child_process');
const defineCases = require('../../../../../../src/test/define-cases.js');

fs.appendFileSync(process.env.FIXTURE_OUT, `pid:${process.pid}\n`);

module.exports = defineCases({
  type: 'group',
  description: 'detached child',
  tests: [
    {
      name: 'starts a detached sleep and keeps it',
      run() {
        const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
        fs.appendFileSync(process.env.FIXTURE_OUT, `sleep:${child.pid}\n`);
      },
    },
  ],
});
