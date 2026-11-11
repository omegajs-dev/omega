/**
 * /download — the #14 batch: prominent platform marks, side-by-side artifacts,
 * ONE mobile notify form, and an onboarding modal that speaks the current
 * design language (tokens + classy vocabulary, not Bootstrap-era alert boxes).
 *
 * Detection itself is NOT tested here: both the download and the extension page
 * call the shared client logic (omega.utilities.getPlatform/getBrowser): the
 * pin for that is in this file's last test, on the page bundles.
 */
const fs = require('node:fs');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const expect = require('@omega.js/devkit/test/expect');

const { buildWith: sharedBuildWith, miniData, PKG } = require('./lib/build.js');

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

// The Linux card, up to the next card or row that carries data-download-card
const linuxCardOf = (html) => {
  const start = html.indexOf('data-download-card data-platform="linux"');
  expect(start > -1, 'the Linux card is on the page').toBeTruthy();
  const end = html.indexOf('data-download-card', start + 1);
  return html.slice(start, end > -1 ? end : html.length);
};

// Every anchor that points at the Snap Store
const snapStoreLinks = (html) => html.match(/<a\b[^>]*href="https:\/\/snapcraft\.io\/[^"]*"[^>]*>/g) || [];

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
      name: '#14: two artifacts ride side by side — one does not',
      run: async (ctx) => {
        const pages = await buildWith(withDownloads);
        const download = pages.get('/download');

        const splits = download.match(/omega-dl-card__actions omega-dl-card__actions--split/g) || [];
        ctx.expect(splits.length, 'only Linux (.deb + AppImage) splits its action row').toBe(1);
        ctx.expect(download.includes('Debian package') && download.includes('AppImage'), 'both Linux artifacts render').toBeTruthy();
        for (const asset of ['mac-dmg.dmg', 'windows-nsis.exe', 'linux-deb.deb', 'linux-appimage.AppImage']) {
          ctx.expect(download.includes(`href="${DL(asset)}"`), `${asset} is a direct download, not the releases page`).toBeTruthy();
        }
        ctx.expect(!download.includes(`href="${RELEASES}"`), 'no button lands on GitHub').toBeTruthy();
        ctx.expect(!download.includes('btn-adaptive w-100'), 'action width is the flex row\'s job now').toBeTruthy();
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
      name: 'a brand that ships the snap gets a plain Snap Store link on the Linux card, and dropping the snap drops it',
      run: async (ctx) => {
        const shipped = (await buildWith(withDownloads)).get('/download');
        const links = snapStoreLinks(linuxCardOf(shipped));

        ctx.expect(links.length, 'one Snap Store link on the Linux card').toBe(1);
        ctx.expect(links[0]).toContain('href="https://snapcraft.io/mini"');
        // The page script opens the install modal for a card's [data-download] links, except a store kind's
        const opensModal = /\sdata-download(?=[\s=>])/.test(links[0]) && !links[0].includes('data-download-kind="store"');
        ctx.expect(opensModal, `a plain link to the store: ${links[0]}`).toBe(false);

        const dropped = (await buildWith({
          ...withDownloads,
          targets: { ...withDownloads.targets, desktop: { type: 'desktop', releases: {}, platforms: { linux: { formats: { snap: false } } } } },
        })).get('/download');
        ctx.expect(snapStoreLinks(dropped)).toEqual([]);
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
