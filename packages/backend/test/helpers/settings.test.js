/**
 * Test: helpers/schema.js (the ONE schema adapter) and services/settings.js
 * (the request service that loads a route's schema and runs it)
 *
 * Run: npx omega test backend:helpers/settings
 *
 * - The reference schema (schemas/test/schema/post.js) resolved against
 *   hard-coded output: a full input, a defaults-only input, an empty input.
 * - The vocabulary: coerce-never-reject, bounds, `of`, nested `fields`,
 *   `enum`/`pattern` on sent values, the `min` length refusal, forced
 *   `value`, `path` ids, and the malformed-declaration throws (the
 *   `required` + `default` footgun by name).
 * - The service: method file first, index.js fallback, the masking guard,
 *   the raw-parts context, and one case per split kind (plan, query, path,
 *   method, header).
 *
 * Schema files are written to a real temp dir and loaded through the real require.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Settings = require('../../dist/omega/services/settings.js');
const { validate, pathParams } = require('../../dist/omega/helpers/schema.js');
const { User } = require('../../dist/omega/helpers/account.js');
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const referenceSchema = loadHandler(require.resolve('../../dist/omega/schemas/test/schema/post.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const basicUser = new User({ auth: { uid: 'basic-uid' } });
const premiumUser = new User({ auth: { uid: 'premium-uid' }, subscription: { product: { id: 'pro' }, status: 'active' } });

// The ctx surface Settings.resolve touches
function makeCtx(request, user) {
  return {
    omega: { cwd: '/nonexistent-cwd' },
    user: user || basicUser,
    log: () => {},
    report: (message, options) => Object.assign(new Error(message), options),
    request: { method: 'POST', body: {}, query: {}, path: '', headers: {}, geolocation: {}, data: {}, ...request },
  };
}

// Write a schema tree ({ 'relative/path': source }) into a fresh temp dir
function schemaDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-settings-'));
  for (const [relative, source] of Object.entries(files)) {
    const abs = path.join(dir, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  }
  return dir;
}

// The thrown error of fn, or undefined
function thrownBy(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
}

// Validate a one-field declaration and return the field's value (or the refusal)
function one(field, input) {
  const { data, error } = validate({ v: field }, typeof input === 'undefined' ? {} : { v: input });

  return error ? `refused: ${error}` : data.v;
}

const NAME_SCHEMA = 'export default () => ({ name: { type: \'string\', default: \'%LABEL%\' } });';

const FULL_INPUT = {
  requiredField: 'provided', stringField: 'custom', numberField: '77', booleanField: 'false',
  arrayField: 'x,y', objectField: { custom: 1 }, minNumber: -5, maxNumber: 500,
  clampedNumber: 200, maxLengthString: 'way-too-long-for-limit', maxLengthArray: [1, 2, 3, 4, 5],
  tags: 'alpha,beta-long,c,d', planBasedLimit: 500, multiType: 123, anyType: { deep: [1] },
  mode: 'full', zip: '12345', cleanedString: 'a@b!1', cleanedFunction: '  UP  ',
  nested: { level1: 'set', evil: 1 }, forcedValue: 'try-to-override', premiumOnlyField: 'sneak', evil: 'strip',
};

const DEFAULTS = {
  stringField: 'default-string', numberField: 42, booleanField: false, arrayField: ['a', 'b', 'c'],
  objectField: { key: 'value' }, requiredField: 'x', conditionalRequired: '', userBasedDefault: 'basic-uid',
  forcedValue: 'always-this-value', minNumber: 5, maxNumber: 50, clampedNumber: 50, maxLengthString: '',
  maxLengthArray: [], tags: [], planBasedLimit: 10, multiType: 'default', anyType: null, mode: 'quick', zip: '',
  cleanedString: '', cleanedFunction: '', nested: { level1: 'nested-default' },
};

module.exports = defineCases({
  description: 'The schema adapter and the Settings service',
  type: 'group',

  tests: [
    // ─── The reference case ───

    {
      name: 'reference-schema-full-input',
      async run({ expect }) {
        const { data } = validate(referenceSchema({ user: basicUser }), FULL_INPUT);

        expect(data.functionDefault).toMatch(/^generated-\d+$/);
        delete data.functionDefault;

        expect(data).toEqual({
          stringField: 'custom', numberField: 77, booleanField: false, arrayField: ['x', 'y'],
          objectField: { custom: 1 }, requiredField: 'provided', conditionalRequired: '', userBasedDefault: 'basic-uid',
          forcedValue: 'always-this-value', minNumber: 1, maxNumber: 100, clampedNumber: 100, maxLengthString: 'way-too-lo',
          maxLengthArray: [1, 2, 3], tags: ['alpha', 'beta-', 'c'], planBasedLimit: 100, multiType: 123, anyType: { deep: [1] },
          mode: 'full', zip: '12345', cleanedString: 'ab1', cleanedFunction: 'up', nested: { level1: 'set' },
        });
      },
    },

    {
      name: 'reference-schema-empty-and-defaults-only-input',
      async run({ expect }) {
        const empty = validate(referenceSchema({ user: basicUser }), {});
        expect(empty).toEqual({ error: 'Required key {requiredField} is missing in settings' });

        const { data } = validate(referenceSchema({ user: basicUser }), { requiredField: 'x' });
        delete data.functionDefault;
        expect(data).toEqual(DEFAULTS);

        // Object defaults are clones: a request never mutates the declaration's
        const declaration = referenceSchema({ user: basicUser });
        validate(declaration, { requiredField: 'x' }).data.objectField.mutated = true;
        expect(validate(declaration, { requiredField: 'x' }).data.objectField).toEqual({ key: 'value' });
      },
    },

    // ─── The vocabulary ───

    {
      name: 'defaults-coerce-and-never-reject',
      async run({ expect }) {
        expect(one({ type: 'number', default: 5 }, '42')).toBe(42);
        expect(one({ type: 'number', default: 5 }, 'abc'), 'an unparseable number coerces, never refuses').toBe(1);
        expect(one({ type: 'number' })).toBe(0);
        expect(one({ type: 'string', default: null }), 'a single type coerces its default too').toBe('');
        expect(one({ type: 'string', default: 'd' }, true)).toBe('true');
        expect(one({ type: 'boolean', default: true }, 'false')).toBe(false);
        expect(one({ type: 'array', default: [] }, 'a, b,,c')).toEqual(['a', 'b', 'c']);
        expect(one({ type: 'object', default: {} }, 'x'), 'a non-object is dropped').toBe(undefined);
        expect(one({ type: 'object', default: {} }, [1, 2]), 'an array is an object (typeof)').toEqual([1, 2]);
        expect(one({ type: 'object', default: null })).toBe(null);
        expect(one({ type: 'any', default: null }, { complex: [1] })).toEqual({ complex: [1] });
        expect(one({ type: 'number', default: 7 }, NaN), 'a non-finite number takes the default').toBe(7);
        expect(one({ type: 'number', default: 7 }, 'Infinity')).toBe(7);
        expect(one({ type: 'string', default: () => 'computed' }), 'a function default runs').toBe('computed');
      },
    },

    {
      name: 'a-type-list-keeps-a-match-and-otherwise-takes-the-default',
      async run({ expect }) {
        const field = { type: ['string', 'number'], default: 'fallback' };

        expect(one(field, 'kept')).toBe('kept');
        expect(one(field, 7)).toBe(7);
        expect(one(field, true), 'no coercion across a list').toBe('fallback');
        expect(one(field, NaN)).toBe('fallback');
        expect(one({ type: ['string', 'number'] })).toBe(undefined);
      },
    },

    {
      name: 'bounds-clamp-numbers-and-truncate-strings-and-arrays',
      async run({ expect }) {
        expect(one({ type: 'number', default: 50, min: 10, max: 100 }, 5)).toBe(10);
        expect(one({ type: 'number', default: 50, min: 10, max: 100 }, 200)).toBe(100);
        expect(one({ type: 'number', default: 5 }, -10), 'no declared min, no floor').toBe(-10);
        expect(one({ type: 'number', default: 5, max: 0 }, 3), 'a declared 0 is a real bound').toBe(0);
        expect(one({ type: 'string', default: '', max: 3 }, 'abcdef')).toBe('abc');
        expect(one({ type: 'array', default: [], max: 2 }, [1, 2, 3])).toEqual([1, 2]);
      },
    },

    {
      name: 'min-refuses-short-strings-and-arrays-sent-or-defaulted',
      async run({ expect }) {
        expect(one({ type: 'string', default: '', min: 1 })).toBe('refused: Invalid settings {v}: must be at least 1 character');
        expect(one({ type: 'string', default: '', min: 2 }, 'a')).toBe('refused: Invalid settings {v}: must be at least 2 characters');
        expect(one({ type: 'array', default: [], min: 2 }, ['solo'])).toBe('refused: Invalid settings {v}: must have at least 2 items');
        expect(one({ type: 'string', default: '', min: 1 }, 'ok')).toBe('ok');
      },
    },

    {
      name: 'enum-and-pattern-judge-only-sent-values',
      async run({ expect }) {
        const mode = { type: 'string', enum: ['quick', 'full'], default: 'quick' };

        expect(one(mode, 'full')).toBe('full');
        expect(one(mode)).toBe('quick');
        expect(one(mode, 'banana')).toBe('refused: Invalid settings {v}: must be one of [quick, full]');
        expect(one({ type: 'string', enum: ['a'], default: null }), 'an absent field is never judged').toBe('');

        const zip = { type: 'string', pattern: /^\d{5}$/g };
        expect(one(zip, '12345')).toBe('12345');
        expect(one(zip, '12345'), 'a global flag keeps no state between requests').toBe('12345');
        expect(one(zip, 'abc')).toBe('refused: Invalid settings {v}: must match /^\\d{5}$/g');
      },
    },

    {
      name: 'required-reads-the-raw-input-and-never-pairs-with-default',
      async run({ expect }) {
        const field = { type: 'string', required: true };

        expect(one(field)).toBe('refused: Required key {v} is missing in settings');
        expect(one(field, ''), "'' counts as missing").toBe('refused: Required key {v} is missing in settings');
        expect(one(field, null), 'null passes, then coerces').toBe('');
        expect(one({ type: 'boolean', required: true }, false)).toBe(false);

        // The footgun: a required field's default could never apply, so it throws by name
        const footgun = thrownBy(() => validate({ action: { type: 'string', required: true, default: 'x' } }, {}));
        expect(footgun.message).toMatch(/Invalid schema at "action": `required` never pairs with `default`/);

        const computed = thrownBy(() => validate({ a: { type: 'string', required: () => true } }, {}));
        expect(computed.message).toMatch(/`required` is a boolean/);
      },
    },

    {
      name: 'a-forced-value-wins-over-input-and-default',
      async run({ expect }) {
        expect(one({ type: 'number', value: 0 }, 99)).toBe(0);
        expect(one({ type: 'string', default: 'd', value: 'forced' })).toBe('forced');
        expect(one({ type: 'number', max: 10, value: 42 }, 999), 'value applies after bounds').toBe(42);
      },
    },

    {
      name: 'nested-fields-and-array-items-carry-their-own-limits',
      async run({ expect }) {
        const declaration = {
          address: { type: 'object', default: {}, fields: {
            city: { type: 'string', default: '', max: 3 },
            zip: { type: 'string', required: true },
          } },
          tags: { type: 'array', of: { type: 'string', max: 2 }, default: [], max: 2 },
          rows: { type: 'array', default: [], of: { type: 'object', fields: { n: { type: 'number', min: 1 } } } },
        };

        expect(validate(declaration, {
          address: { city: 'Springfield', zip: 90210, evil: 1 },
          tags: ['abc', 7, 'z'],
          rows: [{ n: -3, evil: 1 }, 'garbage'],
        }).data).toEqual({
          address: { city: 'Spr', zip: '90210' },
          tags: ['ab', '7'],
          rows: [{ n: 1 }, { n: 1 }],
        });

        expect(validate(declaration, {}).error).toBe('Required key {address.zip} is missing in settings');
        expect(validate(declaration, { address: 'garbage' }).error).toBe('Required key {address.zip} is missing in settings');
        expect(validate({ tags: { type: 'array', of: { type: 'string', min: 2 } } }, { tags: ['ok', 'x'] }).error).toBe('Invalid settings {tags.1}: must be at least 2 characters');
      },
    },

    {
      name: 'path-ids-come-from-the-request-path-alone',
      async run({ expect }) {
        expect(pathParams('/items/abc', 'items')).toEqual(['abc']);
        expect(pathParams('/omega/items/abc/7', 'items')).toEqual(['abc', '7']);
        expect(pathParams('/abc', 'items'), 'a function called at its own root: every segment is an id').toEqual(['abc']);
        expect(pathParams('/omega/test/schema', 'test/schema')).toEqual([]);

        const declaration = { id: { type: 'string', path: true, required: true }, page: { type: 'string', path: true } };

        expect(validate(declaration, { id: 'sent-in-body' }, { pathParams: ['abc', '2'] }).data).toEqual({ id: 'abc', page: '2' });
        expect(validate(declaration, { id: 'sent-in-body' }).error, 'the caller cannot set a path id').toBe('Required key {id} is missing in settings');

        const nested = thrownBy(() => validate({ o: { type: 'object', fields: { id: { type: 'string', path: true } } } }, {}));
        expect(nested.message).toMatch(/Invalid schema at "o\.id": `path` is `true` on a top-level field/);
      },
    },

    {
      name: 'a-malformed-declaration-throws-naming-the-field',
      async run({ expect }) {
        expect(thrownBy(() => validate({ a: { type: 'string', defualt: 'x' } }, {})).message).toMatch(/"a": unknown key\(s\) defualt/);
        expect(thrownBy(() => validate({ a: { type: 'text' } }, {})).message).toMatch(/"a": `type` must be one of/);
        expect(thrownBy(() => validate({ a: { default: 1 } }, {})).message).toMatch(/"a": `type` must be one of/);
        expect(thrownBy(() => validate({ a: { type: 'string', of: { type: 'string' } } }, {})).message).toMatch(/`of` belongs to `type: 'array'`/);
        expect(thrownBy(() => validate({ a: { type: 'array', fields: {} } }, {})).message).toMatch(/`fields` belongs to `type: 'object'`/);
        expect(thrownBy(() => validate({ a: 'string' }, {})).message).toMatch(/"a": a field is a plain object/);
      },
    },

    // ─── The service: schema file resolution ───

    {
      name: 'the-method-file-wins-over-index-and-index-is-the-fallback',
      async run({ expect }) {
        const dir = schemaDir({
          'thing/post.js': NAME_SCHEMA.replace('%LABEL%', 'from-post'),
          'thing/index.js': NAME_SCHEMA.replace('%LABEL%', 'from-index'),
        });

        expect(new Settings(makeCtx({ method: 'POST' })).resolve({ dir, schema: 'thing' }).name).toBe('from-post');
        expect(new Settings(makeCtx({ method: 'DELETE' })).resolve({ dir, schema: 'thing' }).name).toBe('from-index');
        expect(new Settings(makeCtx({ method: 'GET' })).resolve({ dir, schema: 'thing.js' }).name, 'a .js suffix is tolerated').toBe('from-index');
      },
    },

    {
      name: 'neither-file-present-is-an-honest-500-naming-both-paths',
      async run({ expect }) {
        const dir = schemaDir({ 'other/index.js': NAME_SCHEMA.replace('%LABEL%', 'x') });
        const thrown = thrownBy(() => new Settings(makeCtx({ method: 'PATCH' })).resolve({ dir, schema: 'thing' }));

        expect(thrown.code).toBe(500);
        expect(thrown.message).toMatch(/No schema for PATCH request: expected thing\/patch\.js or thing\/index\.js/);
      },
    },

    {
      // The masking guard: a schema file that EXISTS but throws, or whose own
      // import fails (ERR_MODULE_NOT_FOUND too, its message naming the schema
      // file), surfaces its own error, never the index fallback
      name: 'a-broken-schema-file-surfaces-its-own-error',
      async run({ expect }) {
        const index = NAME_SCHEMA.replace('%LABEL%', 'from-index');
        const throwing = schemaDir({ 'thing/post.js': 'throw new Error("the schema itself is broken");\nexport default () => ({});', 'thing/index.js': index });
        const innerRequire = schemaDir({ 'thing/post.js': 'import "a-package-that-does-not-exist";\nexport default () => ({});', 'thing/index.js': index });
        const brokenIndex = schemaDir({ 'thing/index.js': 'import "another-package-that-does-not-exist";\nexport default () => ({});' });

        expect(thrownBy(() => new Settings(makeCtx()).resolve({ dir: throwing, schema: 'thing' })).message).toBe('the schema itself is broken');

        const inner = thrownBy(() => new Settings(makeCtx()).resolve({ dir: innerRequire, schema: 'thing' }));
        expect(inner.code).toBe('ERR_MODULE_NOT_FOUND');
        expect(inner.message).toMatch(/a-package-that-does-not-exist/);

        const broken = thrownBy(() => new Settings(makeCtx()).resolve({ dir: brokenIndex, schema: 'thing' }));
        expect(broken.message).toMatch(/another-package-that-does-not-exist/);
      },
    },

    {
      name: 'a-schema-that-returns-no-declaration-is-a-500-and-a-refusal-a-400',
      async run({ expect }) {
        const dir = schemaDir({
          'none/post.js': 'export default () => null;',
          'strict/post.js': 'export default () => ({ email: { type: \'string\', required: true } });',
        });

        const none = thrownBy(() => new Settings(makeCtx()).resolve({ dir, schema: 'none' }));
        expect(none.code).toBe(500);
        expect(none.message).toBe('Invalid schema none: the schema function must return a plain field declaration');

        const refused = thrownBy(() => new Settings(makeCtx()).resolve({ dir, schema: 'strict' }));
        expect(refused.code).toBe(400);
        expect(refused.message).toBe('Required key {email} is missing in settings');
      },
    },

    // ─── The service: the context and the splits ───

    {
      name: 'the-schema-receives-the-raw-parts-by-name-and-the-declaration-is-kept',
      async run({ expect }) {
        const dir = schemaDir({
          'echo/post.js': `export default (context) => {
            global.__omegaSchemaContext = context;
            return { html: { type: 'string', default: '', sanitize: false }, title: { type: 'string', default: '' } };
          };`,
        });
        const request = { body: { a: 1 }, query: { q: '2' }, path: '/echo', headers: { h: 'x' }, geolocation: { country: 'US' } };
        const settings = new Settings(makeCtx(request, premiumUser));

        settings.resolve({ dir, schema: 'echo' });
        const context = global.__omegaSchemaContext;
        delete global.__omegaSchemaContext;

        expect(Object.keys(context).sort()).toEqual(['body', 'geolocation', 'headers', 'method', 'path', 'query', 'user']);
        expect(context.user, 'the User instance itself').toBe(premiumUser);
        expect(context.user.plan, 'getters, never raw').toBe('pro');
        expect([context.body, context.query, context.path, context.method, context.headers, context.geolocation]).toEqual([request.body, request.query, '/echo', 'POST', request.headers, request.geolocation]);
        expect(settings.declaration.html.sanitize, 'the sanitize pass reads the declaration').toBe(false);
      },
    },

    {
      name: 'split-on-plan',
      async run({ expect }) {
        const input = { requiredField: 'x', planBasedLimit: 500, premiumOnlyField: 'mine' };

        const basic = validate(referenceSchema({ user: basicUser }), input).data;
        expect(basic.planBasedLimit).toBe(100);
        expect('premiumOnlyField' in basic).toBe(false);

        const premium = validate(referenceSchema({ user: premiumUser }), { ...input, conditionalRequired: 'yes' }).data;
        expect(premium.planBasedLimit, 'premium max 1000').toBe(500);
        expect(premium.premiumOnlyField).toBe('mine');
        expect(validate(referenceSchema({ user: premiumUser }), input).error).toBe('Required key {conditionalRequired} is missing in settings');
      },
    },

    {
      name: 'split-on-query-path-method-and-header',
      async run({ expect }) {
        const dir = schemaDir({
          'items/index.js': `export default ({ query, path, method, headers }) => {
            const fields = {
              id: { type: 'string', path: true },
              tags: { type: 'array', default: [], max: 2 },
              total: { type: 'number', value: 0 },
              note: { type: 'string', default: '' },
              mode: { type: 'string', default: 'quick' },
            };
            if (query.bulk === 'true') fields.tags.max = 50;
            if (path.endsWith('/admin')) fields.total = { type: 'number', default: 0 };
            if (method === 'PUT') fields.note = { type: 'string', required: true };
            if (headers['x-mode'] === 'full') fields.mode.enum = ['full'];
            return fields;
          };`,
        });
        const run = (request) => {
          const ctx = makeCtx({ path: '/items/abc', ...request, data: { ...request.body, ...request.query } });
          try {
            return new Settings(ctx).resolve({ dir, schema: 'items' });
          } catch (e) {
            return e.message;
          }
        };
        const tags = ['a', 'b', 'c'];

        expect(run({ body: { tags, total: 9 } })).toEqual({ id: 'abc', tags: ['a', 'b'], total: 0, note: '', mode: 'quick' });
        expect(run({ body: { tags }, query: { bulk: 'true' } }).tags, 'query split').toEqual(tags);
        expect(run({ path: '/items/admin', body: { total: 9 } }).total, 'path split').toBe(9);
        expect(run({ method: 'PUT', body: {} }), 'method split').toBe('Required key {note} is missing in settings');
        expect(run({ headers: { 'x-mode': 'full' }, body: { mode: 'quick' } }), 'header split').toBe('Invalid settings {mode}: must be one of [full]');
      },
    },
  ],
});
