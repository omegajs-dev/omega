/**
 * The email provider rows meet the backend: each row has its provider file,
 * the file carries the operations the row lists, a provider's field view comes
 * from its row, and a role is reached, and gated, through its row.
 *
 * Plain-node: the real provider modules, catalog and Marketing library. The
 * role gate swaps the provider calls in place (the remove-log-privacy idiom);
 * the role send runs against the fake provider API in _campaign-harness.js.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const { EMAIL_PROVIDERS, emailProviderForRole } = require('../../dist/vendor/config/index.js');
const { FIELDS, fieldsForProvider } = require('../../dist/omega/libraries/email/constants.js');
const Marketing = require('../../dist/omega/libraries/email/marketing/index.js');
const { fakeProviderApi, withProviderApi, campaignCtx } = require('./_campaign-harness.js');

const PROVIDERS_DIR = path.join(__dirname, '..', '..', 'dist', 'omega', 'libraries', 'email', 'providers');
const ROWS = Object.values(EMAIL_PROVIDERS);
const EMAIL = 'row.reader@omegajs-test.dev';

const providerFile = (id) => require(path.join(PROVIDERS_DIR, `${id}.js`));

/** Run `fn` with one role's env key unset and every other row's key set. */
async function withRoleOff(role, fn) {
  const saved = Object.fromEntries(ROWS.map((row) => [row.envKey, process.env[row.envKey]]));

  ROWS.forEach((row) => { process.env[row.envKey] = `${row.id}-test-key`; });
  delete process.env[emailProviderForRole(role).envKey];

  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Swap every row's removeContact for a recorder; answers who was asked. */
async function removeWithRecorders(run) {
  const asked = [];
  const originals = ROWS.map((row) => [row.id, providerFile(row.id).removeContact]);

  ROWS.forEach((row) => {
    providerFile(row.id).removeContact = async () => { asked.push(row.id); return { success: true }; };
  });

  try {
    await run();
  } finally {
    originals.forEach(([id, fn]) => { providerFile(id).removeContact = fn; });
  }

  return asked;
}

function quietCtx() {
  return {
    omega: { firebase: { admin: null }, config: {} },
    isTesting: () => false,
    log: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  };
}

module.exports = defineCases({
  description: 'Email provider rows: files, operations, field views and the role gate',
  type: 'group',

  tests: [
    {
      name: 'every provider file has a row and every row has a file',

      run() {
        const files = jetpack.list(PROVIDERS_DIR).filter((name) => name.endsWith('.js') && name !== 'index.js').map((name) => name.replace(/\.js$/, '')).sort();

        expect(ROWS.map((row) => row.id).sort(), 'the rows and the provider files name the same providers').toEqual(files);
      },
    },

    {
      name: 'the provider index answers every row\'s file by its id, and holds no entry without a row',

      run() {
        const { PROVIDER_MODULES, providerModule } = require(path.join(PROVIDERS_DIR, 'index.js'));

        expect(Object.keys(PROVIDER_MODULES).sort(), 'the index and the rows name the same providers').toEqual(ROWS.map((row) => row.id).sort());

        for (const row of ROWS) {
          expect(providerModule(row.id) === providerFile(row.id), `the index answers ${row.id} with its own file`).toBe(true);
        }
      },
    },

    {
      name: 'each provider file exports every operation its row lists, as a function',

      run() {
        for (const row of ROWS) {
          const provider = providerFile(row.id);
          const missing = row.operations.filter((name) => typeof provider[name] !== 'function');

          expect(missing, `${row.id}.js is missing operations its row lists`).toEqual([]);
        }
      },
    },

    {
      name: 'a provider\'s field view is the catalog less the fields its row stores natively',

      run() {
        for (const row of ROWS) {
          const view = fieldsForProvider(row.id);
          const expected = Object.keys(FIELDS).filter((name) => !row.nativeFields.includes(name));

          expect([...view].sort(), `${row.id}'s view follows its row`).toEqual(expected.sort());
        }
      },
    },

    {
      name: 'a role whose row\'s env key is unset is off, and the other role still runs',

      async run() {
        for (const row of ROWS) {
          const asked = await withRoleOff(row.role, () => removeWithRecorders(() => new Marketing(quietCtx()).remove(EMAIL)));
          const others = ROWS.filter((other) => other.id !== row.id).map((other) => other.id);

          expect(asked.includes(row.id), `with ${row.envKey} unset the ${row.role} role must not reach ${row.id}`).toBe(false);
          expect(asked.sort(), `with ${row.envKey} unset the other roles still run`).toEqual(others.sort());
        }
      },
    },

    {
      name: 'a campaign saved for the newsletter role is sent through that role alone',

      async run() {
        const api = fakeProviderApi();

        const result = await withProviderApi(api, (load) => campaignCtx(load).email.sendCampaign({
          name: '[TEST] Calendar newsletter',
          subject: 'Calendar newsletter',
          template: 'card',
          data: { content: { title: 'Calendar', message: 'Saved from the admin calendar.' } },
          providers: ['newsletter'],
          sendAt: 'now',
        }));

        expect(result?.newsletter?.success, `the newsletter role sends, got ${JSON.stringify(result)}`).toBe(true);
        expect(api.beehiivPosts().length, 'one post goes out through the newsletter role').toBe(1);
        expect(api.singleSends().length, 'the campaigns role is not reached').toBe(0);
      },
    },
  ],
});
