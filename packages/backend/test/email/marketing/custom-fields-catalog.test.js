/**
 * What a provider PROVISIONS and what its contact sync WRITES are one list:
 * `fieldsForProvider()`, the catalog (FIELDS) less the fields the provider's
 * row stores natively. SendGrid keeps first/last name in its reserved contact
 * columns, so a native field is never provisioned AND never written.
 *
 * Plain-node: the real catalog and `resolveFieldValues()` over a user doc that
 * fills EVERY field, and the real `buildFields()` of both providers, with
 * SendGrid's field_definitions call stubbed in the require cache (the idiom of
 * helpers/webhook-forward.test.js).
 */
const expect = require('../../../dist/vendor/devkit/test/expect.js');
const {
  FIELDS,
  fieldsForProvider,
  resolveFieldValues,
} = require('../../../dist/omega/libraries/email/constants.js');
const omega = require('../../../dist/omega/index.js');
const beehiivProvider = require('../../../dist/omega/libraries/email/providers/beehiiv.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const CONFIG = { brand: { id: 'acme' } };

// SendGrid holds these two in its reserved contact columns (addContact writes
// them natively), so they are native to SendGrid alone.
const SENDGRID_RESERVED = ['user_personal_name_first', 'user_personal_name_last'];

// A user doc that fills every 'user' and 'resolved' path in FIELDS — anything
// left null drops out of resolveFieldValues() and would hide a real gap.
const USER_DOC = {
  auth: { uid: 'uid_1', email: 'buyer@gmail.com' },
  personal: {
    name: { first: 'Ada', last: 'Lovelace' },
    company: { name: 'Analytical Engines' },
    location: { country: 'US' },
  },
  metadata: {
    created: { timestamp: '2026-01-02T03:04:05.000Z' },
    updated: { timestamp: '2026-08-30T03:04:05.000Z' },
  },
  subscription: {
    status: 'active',
    plan: { id: 'pro' },
    trial: { claimed: true },
    payment: {
      provider: 'stripe',
      frequency: 'monthly',
      price: 19,
      updatedBy: { date: { timestamp: '2026-08-01T00:00:00.000Z' } },
    },
  },
  attribution: { last: { tags: { utm_source: 'newsletter' } } },
};

const FIELD_DEFINITIONS_URL = 'https://api.sendgrid.com/v3/marketing/field_definitions';
const FETCH_PATH = require.resolve('wonderful-fetch');
const SENDGRID_PATH = require.resolve('../../../dist/omega/libraries/email/providers/sendgrid.js');

/**
 * A SendGrid field_definitions response for the catalog's SendGrid view — every
 * field OMEGA provisions has an ID, so anything buildFields() reports unmapped
 * can only be a native field.
 */
function fieldDefinitions() {
  return {
    custom_fields: fieldsForProvider('sendgrid').map((name, index) => ({ id: `e${index + 1}_T`, name })),
  };
}

/**
 * Run against a FRESH sendgrid.js whose network call is stubbed in the require
 * cache (the provider captures `wonderful-fetch` at module load, so the module
 * has to be re-required behind the stub). Both cache entries and the captured
 * `console.warn` are restored afterwards — the runner shares one process, so a
 * leaked stub would poison every later file.
 */
async function withSendgrid(run) {
  const originalFetchEntry = require.cache[FETCH_PATH];
  const originalSendgridEntry = require.cache[SENDGRID_PATH];
  const originalConfig = omega.config;
  const originalWarn = console.warn;
  const warns = [];

  require.cache[FETCH_PATH] = {
    id: FETCH_PATH,
    filename: FETCH_PATH,
    loaded: true,
    exports: async (url) => {
      expect(url, `buildFields only reads field definitions, got ${url}`).toBe(FIELD_DEFINITIONS_URL);

      return fieldDefinitions();
    },
  };

  delete require.cache[SENDGRID_PATH];
  omega.config = CONFIG;
  console.warn = (...args) => warns.push(args.join(' '));

  try {
    return await run(require(SENDGRID_PATH), warns);
  } finally {
    console.warn = originalWarn;
    omega.config = originalConfig;

    if (originalSendgridEntry) {
      require.cache[SENDGRID_PATH] = originalSendgridEntry;
    } else {
      delete require.cache[SENDGRID_PATH];
    }

    if (originalFetchEntry) {
      require.cache[FETCH_PATH] = originalFetchEntry;
    } else {
      delete require.cache[FETCH_PATH];
    }
  }
}

/** Run with omega.config pinned — buildFields resolves 'config' fields off it. */
function withConfig(run) {
  const originalConfig = omega.config;

  omega.config = CONFIG;

  try {
    return run();
  } finally {
    omega.config = originalConfig;
  }
}

module.exports = defineCases({
  description: 'Marketing custom-field catalog ↔ provider sync agreement (#695)',
  type: 'group',
  tests: [
    {
      name: 'the SendGrid catalog covers every synced field except the two SendGrid holds natively',

      run() {
        const provisioned = fieldsForProvider('sendgrid');
        const synced = Object.keys(resolveFieldValues(USER_DOC, CONFIG));

        const unprovisioned = synced.filter((name) => !provisioned.includes(name));

        expect(unprovisioned, `Only SendGrid's reserved name columns may sit outside the custom-field catalog, got ${unprovisioned.join(', ')}`).toEqual(SENDGRID_RESERVED);
        expect(synced.length, `The doc populates the whole catalog, got ${synced.length} of ${Object.keys(FIELDS).length}`).toBe(Object.keys(FIELDS).length);
      },
    },

    {
      name: 'the name fields stay out of SendGrid\'s custom-field lane and still resolve for the providers that need them',

      run() {
        const provisioned = fieldsForProvider('sendgrid');
        const values = resolveFieldValues(USER_DOC, CONFIG);

        for (const name of SENDGRID_RESERVED) {
          expect(!provisioned.includes(name), `${name} is not provisioned as a SendGrid custom field`).toBeTruthy();
          expect(name in values, `${name} still resolves — Beehiiv provisions it, and addContact reads it`).toBeTruthy();
        }

        expect(values.user_personal_name_first).toBe('Ada');
        expect(values.user_personal_name_last).toBe('Lovelace');
      },
    },

    {
      name: 'Beehiiv keeps its own view of the same catalog, less the fields it tracks natively',

      run() {
        const beehiiv = fieldsForProvider('beehiiv');

        expect(!beehiiv.includes('user_personal_country'), 'Beehiiv tracks country natively').toBeTruthy();
        expect(!beehiiv.includes('user_attribution_utm_source'), 'Beehiiv tracks utm_source natively').toBeTruthy();
        expect(beehiiv.includes('user_personal_name_first'), 'Beehiiv still needs the name fields').toBeTruthy();
      },
    },

    {
      name: 'SendGrid buildFields writes only the catalog\'s SendGrid view: a native field is never written and never warns',

      async run() {
        await withSendgrid(async (sendgrid, warns) => {
          const definitions = fieldDefinitions().custom_fields;
          const idByName = Object.fromEntries(definitions.map((field) => [field.name, field.id]));
          const fields = await sendgrid.buildFields(USER_DOC);

          for (const name of SENDGRID_RESERVED) {
            expect(!(name in idByName), `${name} has no SendGrid custom field to write to`).toBeTruthy();
          }

          const writtenNames = Object.keys(fields).map((id) => definitions.find((field) => field.id === id).name);

          expect(writtenNames.filter((name) => SENDGRID_RESERVED.includes(name)), `A native field must never be written, got ${writtenNames.join(', ')}`).toEqual([]);
          expect(writtenNames.sort(), 'Every field the catalog provisions for SendGrid is written').toEqual(Object.keys(resolveFieldValues(USER_DOC, CONFIG)).filter((name) => name in idByName).sort());
          expect(warns, `No unmapped-field warn may fire, got: ${warns.join(' | ')}`).toEqual([]);
        });
      },
    },

    {
      name: 'Beehiiv buildFields writes only the catalog\'s Beehiiv view — country and utm_source are never sent',

      run() {
        withConfig(() => {
          const fields = beehiivProvider.buildFields(USER_DOC);
          const displays = fields.map((field) => field.name);

          for (const name of ['user_personal_country', 'user_attribution_utm_source']) {
            expect(!displays.includes(FIELDS[name].display), `${name} is native to Beehiiv and must never be written, got ${displays.join(', ')}`).toBeTruthy();
          }

          expect(displays.sort(), 'Every field the catalog provisions for Beehiiv is written').toEqual(fieldsForProvider('beehiiv')
              .filter((name) => name in resolveFieldValues(USER_DOC, CONFIG))
              .map((name) => FIELDS[name].display)
              .sort());
        });
      },
    },
  ],
});
