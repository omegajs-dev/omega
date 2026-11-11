/**
 * A campaign saved from the admin calendar names its providers by the role
 * words the backend send matches (`campaigns`, `newsletter`), so a box ticked
 * on the page takes effect.
 *
 * The REAL page pieces through esbuild (the harness calendar-icons.test.js
 * set): the editor form's fields come from the calendar layout, the client's
 * FormManager collects them, and the events module builds the saved payload.
 * Node has no DOM, so each field is a plain object carrying what both read.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const cheerio = require('cheerio');

const CALENDAR_DIR = path.join(__dirname, '..', 'core', 'js', 'pages', 'admin', 'calendar');
const LAYOUT = path.join(__dirname, '..', 'core', '_layouts', 'blueprint', 'admin', 'calendar', 'index.html');
const FORM_MANAGER = require.resolve('@omega.js/client/modules/form-manager.js');

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-calendar-roles-'));
const ENTRY = path.join(BUNDLE_DIR, 'entry.js');
const BUNDLE = path.join(BUNDLE_DIR, 'calendar.cjs');

const FILLED = {
  'campaign.type': 'email',
  'campaign.name': 'Calendar campaign',
  'campaign.subject': 'Calendar subject',
  'campaign.date': '2026-12-01',
  'campaign.time': '10:00',
};

let building = null;

function bundleOnce() {
  fs.writeFileSync(ENTRY, [
    `export { default as CalendarEvents } from ${JSON.stringify(path.join(CALENDAR_DIR, 'calendar-events.js'))};`,
    `export { FormManager } from ${JSON.stringify(FORM_MANAGER)};`,
    '',
  ].join('\n'));

  building ||= esbuild.build({
    entryPoints: [ENTRY],
    outfile: BUNDLE,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    logLevel: 'error',
    plugins: [{
      name: 'harness-aliases',
      setup(build) {
        build.onResolve({ filter: /^@omega\.js\/web\/runtime$/ }, () => ({ path: 'client', namespace: 'omega-client-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'omega-client-stub' }, () => ({ contents: 'export default globalThis.__omegaClient;' }));
      },
    }],
  });

  return building;
}

async function loadPage() {
  await bundleOnce();

  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.__omegaClient = { utilities: { escapeHTML: (value) => `${value}` } };

  delete require.cache[require.resolve(BUNDLE)];
  return require(BUNDLE);
}

/** The editor form's fields as the layout renders them, filled like a person would. */
function editorFields() {
  const $ = cheerio.load(fs.readFileSync(LAYOUT, 'utf8'));
  const form = $('#campaign-editor-form');

  return form.find('input, select, textarea').toArray().map((node) => {
    const $node = $(node);
    const name = $node.attr('name') || '';
    const type = node.tagName === 'input' ? ($node.attr('type') || 'text') : node.tagName;
    const value = $node.attr('value') ?? '';

    return {
      name,
      type,
      value: type === 'radio' || type === 'checkbox' ? value : (FILLED[name] ?? value),
      checked: type === 'radio' ? value === FILLED[name] : $node.attr('checked') !== undefined,
      dataset: {},
      matches: () => false,
    };
  });
}

const providerBox = (field) => field.type === 'checkbox' && field.name.startsWith('campaign.providers');

/** What the page saves with exactly `ticked` among the provider boxes checked. */
function savedProviders(page, fields, ticked) {
  fields.filter(providerBox).forEach((field) => { field.checked = field === ticked; });

  const form = {
    $form: { querySelectorAll: (selector) => (selector.includes('checkbox') ? fields.filter((field) => field.type === 'checkbox' && selector.includes(`"${field.name}"`)) : fields) },
    _isFieldInGroup: () => true,
  };
  const data = page.FormManager.prototype.getData.call(Object.assign(Object.create(page.FormManager.prototype), form));

  return Object.create(page.CalendarEvents.prototype)._buildPayload(data).providers;
}

module.exports = defineCases({
  type: 'group',
  description: 'calendar-provider-roles',
  tests: [
    {
      name: 'each provider box saves one role word, and the two boxes are the two roles',
      run: async (ctx) => {
        const page = await loadPage();
        const fields = editorFields();
        const boxes = fields.filter(providerBox);

        ctx.expect(boxes.length, 'the editor offers one box per role').toBe(2);

        const saved = boxes.map((box) => savedProviders(page, fields, box));

        saved.forEach((providers) => ctx.expect(providers?.length, `one ticked box saves one word, got ${JSON.stringify(providers)}`).toBe(1));
        ctx.expect(saved.map((providers) => providers[0]).sort(), 'the saved words are the roles the send matches').toEqual(['campaigns', 'newsletter']);
      },
    },
  ],
});
