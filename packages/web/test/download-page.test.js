/**
 * /download, the #14 batch: prominent platform marks, ONE mobile notify form,
 * and an onboarding modal that speaks the current design language (tokens +
 * classy vocabulary, not Bootstrap-era alert boxes). A platform with several
 * formats shows one split button: the first format, then a menu of the rest.
 *
 * Detection itself is NOT tested here: both the download and the extension page
 * call the shared client logic (omega.utilities.getPlatform/getBrowser): the
 * pin for that is in this file's last test, on the page bundles.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const esbuild = require('esbuild');
const { clientConfig } = require('@omega.js/config');
const defineCases = require('@omega.js/devkit/test/define-cases');
const expect = require('@omega.js/devkit/test/expect');

const { buildWith: sharedBuildWith, miniData, PKG } = require('./lib/build.js');

const CORE_DIR = path.join(PKG, 'core');
const PAGE_MODULE = path.join(CORE_DIR, 'js', 'pages', 'download', 'index.js');

const buildWith = (siteData, overrides) => sharedBuildWith(siteData, overrides, 'download-test');

// A brand that opted into desktop releases (#124). Since #610 that is the ONLY
// download declaration there is: the curated view answers every desktop
// artifact — one for mac, TWO for linux (.deb + AppImage) — and mobile derives
// nothing while MAM is parked. Since #620 each button hands over the FILE
// (a versionless asset on the latest release), never the releases page.
const RELEASES = 'https://github.com/mini-org/mini-releases/releases/latest';
const DL = (asset) => `${RELEASES}/download/MiniCo-${asset}`;
const withDownloads = {
  ...miniData,
  repo: { provider: 'github', owner: 'mini-org' },
  targets: { web: { type: 'web' }, desktop: { type: 'desktop', releases: {} } },
};

// The visible hero masthead stays; the SECOND lead-in (the section head that
// sat right above the platform/browser cards) is the one that went (Ian QA).
const sectionOf = (html, id) => {
  const start = html.indexOf(`id="${id}"`);
  expect(start > -1, `#${id} section is on the page`).toBeTruthy();
  const end = html.indexOf('<section', start);
  return html.slice(start, end > -1 ? end : html.length);
};

// One platform's card on the built page
const cardOf = ($, platform) => {
  const card = $(`[data-download-card][data-platform="${platform}"]`);
  expect(card.length, `the ${platform} card is on the page`).toBe(1);
  return card;
};

// The arrow half: the framework's dropdown toggle, inside the card's split button
const arrowsOf = (card) => card.find('.omega-dl-card__split [data-bs-toggle="dropdown"]');

// The page module bundled the way the page bundle takes it, with the runtime
// the boot would hand it supplied by the case instead
let bundling = null;
function pageModuleSource() {
  bundling ||= esbuild.build({
    entryPoints: [PAGE_MODULE],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    logLevel: 'silent',
    plugins: [{
      name: 'harness-aliases',
      setup(build) {
        build.onResolve({ filter: /^__main_assets__\// }, (args) => {
          return { path: path.join(CORE_DIR, args.path.slice('__main_assets__/'.length)) };
        });
        build.onResolve({ filter: /^@omega\.js\/web\/runtime$/ }, () => {
          return { path: 'runtime', namespace: 'omega-runtime-stub' };
        });
        build.onLoad({ filter: /.*/, namespace: 'omega-runtime-stub' }, () => {
          return { contents: 'export default globalThis.omega;' };
        });
      },
    }],
  }).then((result) => result.outputFiles[0].text);

  return bundling;
}

/** An element of the built page, as much of the DOM as the page module touches */
class PageElement {
  constructor(node, wrap, $) {
    this.node = node;
    this.wrap = wrap;
    this.$node = $(node);
    this.listeners = {};
    this.style = {};
  }

  get tagName() { return this.node.name.toUpperCase(); }
  get id() { return this.getAttribute('id') || ''; }
  get href() { return this.getAttribute('href') || ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(on) { if (on) { this.setAttribute('hidden', ''); } else { this.removeAttribute('hidden'); } }
  get textContent() { return this.$node.text(); }
  set textContent(text) { this.$node.text(String(text)); }
  get innerHTML() { return this.$node.html(); }
  set innerHTML(markup) { this.$node.html(String(markup)); }

  get parentElement() {
    const parent = this.node.parent;
    return parent && parent.type === 'tag' ? this.wrap(parent) : null;
  }

  get dataset() {
    const attr = (key) => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_, key) => (typeof key === 'string' ? this.$node.attr(attr(key)) : undefined),
      set: (_, key, value) => { this.$node.attr(attr(key), String(value)); return true; },
      has: (_, key) => this.$node.attr(attr(key)) !== undefined,
    });
  }

  get classList() {
    const $node = this.$node;
    return {
      add: (...names) => { $node.addClass(names.join(' ')); },
      remove: (...names) => { $node.removeClass(names.join(' ')); },
      contains: (name) => $node.hasClass(name),
      toggle: (name, force) => {
        const on = force === undefined ? !$node.hasClass(name) : Boolean(force);
        $node.toggleClass(name, on);
        return on;
      },
    };
  }

  getAttribute(name) { return this.$node.attr(name) ?? null; }
  setAttribute(name, value) { this.$node.attr(name, String(value)); }
  removeAttribute(name) { this.$node.removeAttr(name); }
  hasAttribute(name) { return this.$node.attr(name) !== undefined; }
  matches(selector) { return this.$node.is(selector); }
  closest(selector) { return this.wrap(this.$node.closest(selector)[0]); }
  querySelector(selector) { return this.wrap(this.$node.find(selector)[0]); }
  querySelectorAll(selector) { return this.$node.find(selector).toArray().map(this.wrap); }
  appendChild(child) { this.$node.append(child.node); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() { this.$node.remove(); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter((each) => each !== handler); }
}

// The tracking-consent record the banner writes, granting every category
const CONSENTED = { analytics: true, marketing: true, region: 'opt-out', version: 1 };

// A runtime member the cases do not read (the notify form's request, say)
// answers as an inert callable, so the page's other wiring stands up quietly
const inert = () => new Proxy(function inertMember() {}, {
  get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : inert()),
  apply: () => inert(),
});
const withInert = (members) => new Proxy(members, {
  get: (target, key) => (key in target || typeof key === 'symbol' || key === 'then' ? target[key] : inert()),
});

/**
 * Run the REAL page module over the BUILT page in a vm sandbox standing in for
 * the browser (node has no DOM and web pulls in no jsdom): the GA4 pixel records
 * the click reports the real analytics module hands it, and Bootstrap's Modal
 * records the walkthroughs opened.
 *
 * @param {string} html - the built /download page
 * @param {string} platform - what the shared detector answers
 * @returns {Promise<{ $: Function, click: Function, reports: Array, opened: Array, stop: Function }>}
 */
async function standPage(html, platform) {
  const $ = cheerio.load(html);
  const wrapped = new Map();
  const wrap = (node) => {
    if (!node) {
      return null;
    }
    if (!wrapped.has(node)) {
      wrapped.set(node, new PageElement(node, wrap, $));
    }
    return wrapped.get(node);
  };

  const reports = [];
  const opened = [];
  const timers = [];
  const listen = (target) => {
    target.listeners = {};
    target.addEventListener = PageElement.prototype.addEventListener;
    target.removeEventListener = PageElement.prototype.removeEventListener;
    return target;
  };

  class Modal {
    constructor(el) { this.el = el; }
    static getOrCreateInstance(el) { return new Modal(el); }
    static getInstance(el) { return new Modal(el); }
    show() { opened.push(this.el); }
    hide() {}
  }

  const document = listen({
    readyState: 'complete',
    get body() { return wrap($('body')[0]); },
    get documentElement() { return wrap($('html')[0]); },
    getElementById: (id) => wrap($(`[id="${id}"]`)[0]),
    createElement: (tag) => wrap($(`<${tag}></${tag}>`)[0]),
    querySelector: (selector) => wrap($(selector)[0]),
    querySelectorAll: (selector) => $(selector).toArray().map(wrap),
  });
  const window = listen({
    document,
    console,
    URL,
    URLSearchParams,
    location: { href: 'http://localhost/download', origin: 'http://localhost', pathname: '/download', search: '', hash: '' },
    bootstrap: { Modal },
    // The GA4 pixel the real analytics transport hands each report to
    gtag: (command, name, params) => { if (command === 'event') { reports.push({ name, params }); } },
    omega: withInert({
      config: clientConfig({ analytics: { providers: { google: { id: 'G-TEST' } } } }),
      storage: { get: (key, fallback) => (key === 'trackingConsent' ? CONSENTED : fallback), set: () => {} },
      dom: { ready: () => Promise.resolve() },
      utilities: { getPlatform: () => platform },
    }),
    setTimeout: (fn, ms, ...args) => { const id = setTimeout(fn, ms, ...args); timers.push(id); return id; },
    clearTimeout,
    setInterval: (fn, ms, ...args) => { const id = setInterval(fn, ms, ...args); timers.push(id); return id; },
    clearInterval,
    queueMicrotask,
    module: { exports: {} },
  });
  window.window = window;

  vm.createContext(window);
  vm.runInContext(await pageModuleSource(), window, { filename: PAGE_MODULE });
  const page = window.module.exports.default || window.module.exports;
  await page({ omega: window.omega, options: {} });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const fire = (target, event) => {
    event.currentTarget = target;
    for (const handler of [...(target.listeners[event.type] || [])]) {
      handler.call(target, event);
    }
  };
  const click = async (node) => {
    const target = wrap(node);
    const event = {
      type: 'click',
      target,
      button: 0,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    const chain = [];
    for (let at = target; at; at = at.parentElement) {
      chain.push(at);
    }
    for (const at of [...chain, document, window]) {
      fire(at, event);
      if (event.stopped) {
        break;
      }
    }
    await settle();
  };

  await settle();
  return { $, click, reports, opened, stop: () => timers.forEach((id) => { clearTimeout(id); clearInterval(id); }) };
}

module.exports = defineCases({
  type: 'group',
  description: 'download-page',
  tests: [
    {
      name: '#14: platform identity is the MARK — the small neutral chip is gone',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');
        ctx.expect(download, 'download page built').toBeTruthy();

        const marks = download.match(/omega-dl-card__mark/g) || [];
        ctx.expect(marks.length, 'every desktop card leads with the platform mark').toBe(3);
        ctx.expect(!download.includes('omega-dl-card__chip'), 'the old chip variant is gone').toBeTruthy();
      },
    },

    {
      name: 'a platform with one format: its card holds one download link and no arrow half',
      run: async (ctx) => {
        const $ = cheerio.load((await buildWith(withDownloads)).get('/download'));

        for (const [platform, asset] of [['mac', 'mac-dmg.dmg'], ['windows', 'windows-nsis.exe']]) {
          const card = cardOf($, platform);
          const links = card.find('a[data-download]').toArray().map((link) => $(link).attr('href'));
          ctx.expect(links, `${platform} hands over its one file directly`).toEqual([DL(asset)]);
          ctx.expect(card.find('[data-bs-toggle="dropdown"]').length, `${platform} has no arrow half`).toBe(0);
        }
      },
    },

    {
      name: 'Linux with three formats: one main link for the first, one arrow half, one menu item per other format in offer order',
      run: async (ctx) => {
        const $ = cheerio.load((await buildWith(withDownloads)).get('/download'));
        const linux = cardOf($, 'linux');

        const main = linux.find('a[data-download]').not('.dropdown-menu a');
        ctx.expect(main.toArray().map((link) => $(link).attr('href')), 'one main link, the .deb').toEqual([DL('linux-deb.deb')]);
        ctx.expect(main.closest('.omega-dl-card__split').length, 'the main link is the split button\'s main half').toBe(1);
        ctx.expect(arrowsOf(linux).length, 'one arrow half').toBe(1);

        const items = linux.find('.omega-dl-card__split .dropdown-menu a[data-download]');
        ctx.expect(items.toArray().map((link) => $(link).attr('href')), 'the other formats, in offer order')
          .toEqual([DL('linux-appimage.AppImage'), 'https://snapcraft.io/mini']);
        ctx.expect(!$.html().includes(`href="${RELEASES}"`), 'no link lands on the GitHub releases page').toBeTruthy();
      },
    },

    {
      name: 'every card: the first a[data-download] is the first format\'s link, and the arrow half carries no data-download',
      run: async (ctx) => {
        const $ = cheerio.load((await buildWith(withDownloads)).get('/download'));

        for (const [platform, asset] of [['mac', 'mac-dmg.dmg'], ['windows', 'windows-nsis.exe'], ['linux', 'linux-deb.deb']]) {
          const first = cardOf($, platform).find('a[data-download]').first();
          ctx.expect(first.attr('href'), `${platform}'s first download link`).toBe(DL(asset));
        }

        const arrows = $('[data-download-card] [data-bs-toggle="dropdown"]');
        ctx.expect(arrows.length, 'Linux, the one card with several formats, has the one arrow half').toBe(1);
        ctx.expect(arrows[0].name, 'the arrow half is a button').toBe('button');
        ctx.expect((arrows.attr('aria-label') || '').trim().length > 0, 'the arrow half has a spoken name').toBe(true);
        for (const attr of ['data-download', 'data-download-name', 'data-download-kind']) {
          ctx.expect(arrows.attr(attr), `the arrow half carries no ${attr}`).toBe(undefined);
        }
      },
    },

    {
      name: 'given a click on the Linux main half, the click report names the first format',
      run: async (ctx) => {
        const page = await standPage((await buildWith(withDownloads)).get('/download'), 'linux');
        ctx.after(page.stop);

        const main = cardOf(page.$, 'linux').find('.omega-dl-card__split a[data-download]').not('.dropdown-menu a');
        ctx.expect(main.length, 'the Linux card has a split button main half').toBe(1);
        await page.click(main[0]);

        const downloads = page.reports.filter((report) => report.name === 'file_download');
        ctx.expect(downloads.length, 'one file_download report').toBe(1);
        ctx.expect(downloads[0].params.download_name).toBe('Debian package');
      },
    },

    {
      name: 'given a click on a store item no walkthrough opens; on an asset item the platform\'s walkthrough opens',
      run: async (ctx) => {
        const html = (await buildWith(withDownloads)).get('/download');
        const itemOf = (page, href) => {
          const item = cardOf(page.$, 'linux').find(`.dropdown-menu a[href="${href}"]`);
          ctx.expect(item.length, `the Linux menu holds ${href}`).toBe(1);
          return item[0];
        };

        const store = await standPage(html, 'linux');
        ctx.after(store.stop);
        await store.click(itemOf(store, 'https://snapcraft.io/mini'));
        ctx.expect(store.opened.length, 'the Snap Store item opens no walkthrough').toBe(0);

        const asset = await standPage(html, 'linux');
        ctx.after(asset.stop);
        await asset.click(itemOf(asset, DL('linux-appimage.AppImage')));
        ctx.expect(asset.opened.length, 'the AppImage item opens a walkthrough').toBe(1);
        const linuxSteps = asset.opened[0].querySelector('.platform-instructions[data-platform="linux"]');
        ctx.expect(linuxSteps && !linuxSteps.hidden, 'the walkthrough shows the Linux steps').toBe(true);
      },
    },

    {
      name: 'the hero\'s words are the detected platform card\'s main link words, translated with it',
      run: async (ctx) => {
        // A translated page carries the frontmatter's words in its own language
        const built = (await buildWith(withDownloads)).get('/download');
        ctx.expect(built.split('Download for Linux').length - 1, 'the Linux main link carries the frontmatter words once').toBe(1);
        const page = await standPage(built.replace('Download for Linux', 'Télécharger pour Linux'), 'linux');
        ctx.after(page.stop);

        ctx.expect(page.$('#download-hero [data-hero-label]').text(), 'the hero reads the Linux main link\'s words')
          .toBe('Télécharger pour Linux');
      },
    },

    {
      name: '#14: ONE mobile notify form covers every unshipped store',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');

        const forms = download.match(/class="mobile-email-form"/g) || [];
        ctx.expect(forms.length, 'exactly one notify-me form').toBe(1);
        ctx.expect(download.includes('id="mobile-email-form"'), 'the form carries the platform-free id').toBeTruthy();
        ctx.expect(!download.includes('mobile-email-form-ios'), 'the per-platform form ids are gone').toBeTruthy();
        ctx.expect(download.includes('<strong>iOS</strong>'), 'the unshipped store is named on the block').toBeTruthy();
        // #610: mobile derives nothing while MAM is parked, so a shipped desktop
        // release never puts a store badge on the mobile band.
        ctx.expect(!download.includes('omega-dl-store__badge'), 'no mobile store badge without a mobile fact').toBeTruthy();
      },
    },

    {
      name: '#14: every mobile store unshipped → still exactly one form',
      run: async (ctx) => {
        const pages = await buildWith(miniData);
        const download = pages.get('/download');

        const forms = download.match(/class="mobile-email-form"/g) || [];
        ctx.expect(forms.length, 'one form for iOS + Android together').toBe(1);
        ctx.expect(download.includes('<strong>iOS</strong>') && download.includes('<strong>Android</strong>'), 'both pending stores are named').toBeTruthy();
      },
    },

    {
      name: 'QA: /download keeps its hero masthead and drops the second lead-in',
      run: async (ctx) => {
        const pages = await buildWith(miniData);
        const download = pages.get('/download');

        const h1s = download.match(/<h1[^>]*>/g) || [];
        ctx.expect(h1s.length, 'exactly one h1 (SEO checklist)').toBe(1);
        ctx.expect(!h1s[0].includes('visually-hidden'), 'the h1 is visible, not screen-reader only').toBeTruthy();
        // No reveal attribute since #467: the download hero is the page's first
        // viewport, so its masthead rides `first_paint: true`
        // (test/first-paint-bands.test.js owns that promise); /extension below rides
        // the same switch since the #467 follow-up.
        ctx.expect(download.includes('<span class="omega-micro d-block mb-3">Download</span>'), 'the masthead eyebrow renders').toBeTruthy();
        ctx.expect(download.includes('Take MiniCo with you'), 'the hero headline renders').toBeTruthy();
        ctx.expect(download.includes('omega-hero__sub'), 'the hero sub line renders').toBeTruthy();

        const platforms = sectionOf(download, 'platforms');
        ctx.expect(!platforms.includes('omega-section-head'), 'no section head above the platform cards').toBeTruthy();
        ctx.expect(!download.includes('Every platform,'), 'the second lead-in copy is gone').toBeTruthy();
        ctx.expect(!download.includes('Pick your machine'), 'the older second lead-in stays gone').toBeTruthy();
        ctx.expect(download.includes('omega-dl-card__mark'), 'the platform cards still render').toBeTruthy();
      },
    },

    {
      name: 'QA: /extension echoes it — hero masthead kept, second lead-in gone',
      run: async (ctx) => {
        const pages = await buildWith(miniData);
        const extension = pages.get('/extension');

        const h1s = extension.match(/<h1[^>]*>/g) || [];
        ctx.expect(h1s.length, 'exactly one h1 (SEO checklist)').toBe(1);
        ctx.expect(!h1s[0].includes('visually-hidden'), 'the h1 is visible, not screen-reader only').toBeTruthy();
        // #467: /extension's masthead is its opening band, so the eyebrow paints with
        // the document — the reveal attribute is gone by design, not by accident.
        ctx.expect(extension.includes('<span class="omega-micro d-block mb-3">Extension</span>'), 'the masthead eyebrow renders').toBeTruthy();
        ctx.expect(extension.includes('One tab away, in <em>every</em> browser'), 'the hero headline renders').toBeTruthy();
        ctx.expect(extension.includes('omega-hero__sub'), 'the hero sub line renders').toBeTruthy();

        const browsers = sectionOf(extension, 'browsers');
        ctx.expect(!browsers.includes('omega-section-head'), 'no section head above the browser cards').toBeTruthy();
        ctx.expect(!extension.includes('Your browser is'), 'the second lead-in copy is gone').toBeTruthy();
        ctx.expect(extension.includes('omega-dl-card__mark'), 'the browser cards still render').toBeTruthy();
      },
    },

    {
      name: '#14: the onboarding modal wears the current design language',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');

        ctx.expect(download.includes('modal-content omega-dl-modal'), 'the modal is a classy surface').toBeTruthy();
        ctx.expect(download.includes('omega-dl-modal__pane'), 'the command panes are designed surfaces').toBeTruthy();
        ctx.expect(download.includes('omega-dl-modal__cmd'), 'the command inputs are token-painted').toBeTruthy();
        ctx.expect(download.includes('omega-dl-modal__help'), 'the help note replaced alert-info').toBeTruthy();

        for (const legacy of ['alert alert-success', 'alert alert-info', 'bg-body-tertiary', 'bg-white border border-primary', 'bg-dark text-light']) {
          ctx.expect(!download.includes(legacy), `Bootstrap-era chrome gone: ${legacy}`).toBeTruthy();
        }
      },
    },

    {
      name: 'QA: the modal is instructions only — no started card, no dismiss button',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');

        ctx.expect(!download.includes('omega-dl-modal__started'), 'the download-started card is gone').toBeTruthy();
        ctx.expect(!download.includes('Your download should begin automatically'), 'its copy went with it').toBeTruthy();
        ctx.expect(!download.includes('modal-footer'), 'the footer holding "Got it!" is gone').toBeTruthy();
        ctx.expect(!download.includes('Got it!'), 'the redundant dismiss button is gone').toBeTruthy();
        ctx.expect(download.includes('data-bs-dismiss="modal"'), 'the header close button still dismisses').toBeTruthy();

        const scss = fs.readFileSync(
          path.join(PKG, 'themes', 'classy', 'css', 'marketing', '_downloads.scss'), 'utf8',
        );
        ctx.expect(!scss.includes('.omega-dl-modal__started'), 'the dead rule went with the markup').toBeTruthy();
        const help = scss.match(/\.omega-dl-modal__help \{[^}]*\}/)[0];
        ctx.expect(!help.includes('display: flex'), 'the help note sets as prose, not as gapped flex items').toBeTruthy();
      },
    },

    {
      name: 'QA: the Linux modal names the REAL deb file and instructs nothing the pipeline never builds',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');

        // The install command is the basename of the SAME derived URL the Debian
        // button links (#620), so the file the user downloaded is the file the
        // command installs — a rename lands in both or in neither.
        ctx.expect(download.includes('value="sudo dpkg -i MiniCo-linux-deb.deb"'), 'the dpkg step names the derived asset').toBeTruthy();
        ctx.expect(!download.includes('_amd64.deb'), 'the hand-spelled legacy filename is gone').toBeTruthy();

        // deb + AppImage are the only linux artifacts there have ever been.
        ctx.expect(!download.includes('sudo rpm -i'), 'no rpm instruction — no rpm artifact exists').toBeTruthy();
        ctx.expect(!download.includes('Fedora/RHEL'), 'its label went with it').toBeTruthy();
      },
    },

    {
      name: 'the snap item is a store link with data-download-kind="store", inside the Linux card',
      run: async (ctx) => {
        const $ = cheerio.load((await buildWith(withDownloads)).get('/download'));

        const snaps = $('a[href^="https://snapcraft.io/"]');
        ctx.expect(snaps.toArray().map((link) => $(link).attr('href')), 'one Snap Store link on the page').toEqual(['https://snapcraft.io/mini']);
        ctx.expect(snaps.closest('[data-download-card]').attr('data-platform'), 'it sits on the Linux card').toBe('linux');
        ctx.expect(snaps.attr('data-download-kind')).toBe('store');
      },
    },

    {
      name: '#14: OS/browser detection on BOTH pages comes from the shared client logic',
      run: (ctx) => {
        const download = fs.readFileSync(path.join(PKG, 'core', 'js', 'pages', 'download', 'index.js'), 'utf8');
        const extension = fs.readFileSync(path.join(PKG, 'core', 'js', 'pages', 'extension', 'index.js'), 'utf8');

        ctx.expect(download.includes('omega.utilities.getPlatform()'), 'download reads the shared platform detector').toBeTruthy();
        ctx.expect(extension.includes('omega.utilities.getBrowser()'), 'extension reads the shared browser detector').toBeTruthy();
        for (const source of [download, extension]) {
          ctx.expect(!/navigator\.(userAgent|platform)/.test(source), 'no page-local ua sniffing').toBeTruthy();
        }
      },
    },
  ],
});
