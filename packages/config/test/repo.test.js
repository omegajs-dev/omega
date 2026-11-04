/**
 * The repo derivations ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)):
 * ONE `repo: { provider, owner }` block, every repo name derived from
 * `<brand.id>-<role>` (#809), and visibility read off the brand root's
 * package.json rather than any config key.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  REPO_PROVIDERS,
  HOSTING_PROVIDERS,
  repoBlock,
  sourceRepo,
  releasesRepo,
  repoDrift,
  repoMissing,
  websiteRepo,
  hostingProvider,
  pagesHost,
  pagesAddress,
  brandVisibility,
} = require('../src/index.js');

const BRAND = {
  brand: { id: 'acme', url: 'https://acme.com' },
  repo: { owner: 'Acme-Org' },
  targets: {
    web: { type: 'web' },
    community: { type: 'web' },
    backend: { type: 'backend' },
    desktop: { type: 'desktop' },
  },
};

module.exports = defineCases({
  type: 'group',
  description: 'repo',
  tests: [
    {
      name: 'the provider tables name what OMEGA builds for',
      run: (ctx) => {
        ctx.expect(REPO_PROVIDERS).toEqual(['github']);
        ctx.expect(HOSTING_PROVIDERS).toEqual(['github']);
      },
    },

    {
      name: 'repoBlock: the provider defaults to github, and the owner comes back trimmed',
      run: (ctx) => {
        ctx.expect(repoBlock({ repo: { owner: 'Acme-Org' } })).toEqual({ provider: 'github', owner: 'Acme-Org' });
        ctx.expect(repoBlock({ repo: { provider: 'github', owner: '  Acme-Org  ' } })).toEqual({ provider: 'github', owner: 'Acme-Org' });
      },
    },

    {
      name: 'repo.owner: the whole block reads back as { provider, owner }, and the source repo lives under that owner',
      run: (ctx) => {
        const config = { brand: { id: 'acme' }, repo: { provider: 'github', owner: 'Acme' } };
        ctx.expect(repoBlock(config)).toEqual({ provider: 'github', owner: 'Acme' });
        ctx.expect(sourceRepo(config)).toEqual({ owner: 'Acme', name: 'acme-omega', slug: 'Acme/acme-omega' });
      },
    },

    {
      name: 'repoBlock: no block, and a block naming no owner, address nothing',
      run: (ctx) => {
        ctx.expect(repoBlock({})).toBe(null);
        ctx.expect(repoBlock({ repo: { provider: 'github' } }), 'the validator fails an owner-less block; nothing derives from it').toBe(null);
        ctx.expect(repoBlock({ repo: { provider: 'github', org: 'Acme-Org' } }), 'the retired org key is no alias for owner').toBe(null);
        ctx.expect(repoBlock({ repo: 'Acme-Org' })).toBe(null);
        ctx.expect(repoBlock(undefined)).toBe(null);
      },
    },

    {
      name: 'sourceRepo: the SOURCE monorepo is `<brand.id>-omega` under the owner',
      run: (ctx) => {
        // Hard-coded on purpose: the rule is a NAME, not a recipe to recompute here.
        ctx.expect(sourceRepo(BRAND)).toEqual({ owner: 'Acme-Org', name: 'acme-omega', slug: 'Acme-Org/acme-omega' });
        ctx.expect(sourceRepo({ brand: { id: '  spaced  ' }, repo: { owner: 'Org' } }), 'the id is trimmed before the role joins it').toEqual({ owner: 'Org', name: 'spaced-omega', slug: 'Org/spaced-omega' });
      },
    },

    {
      name: 'releasesRepo: the public release channel is `<brand.id>-releases`, with no override left anywhere',
      run: (ctx) => {
        ctx.expect(releasesRepo(BRAND)).toEqual({ owner: 'Acme-Org', name: 'acme-releases', slug: 'Acme-Org/acme-releases' });

        // The retired owner/repo keys are inert: a config still carrying them (the
        // validator fails it) never moves the address.
        ctx.expect(releasesRepo({ ...BRAND, targets: { desktop: { type: 'desktop', releases: { owner: 'Elsewhere', repo: 'bins' } } } })).toEqual({ owner: 'Acme-Org', name: 'acme-releases', slug: 'Acme-Org/acme-releases' });
      },
    },

    {
      name: 'sourceRepo/releasesRepo: half an address addresses nothing',
      run: (ctx) => {
        ctx.expect(sourceRepo({ brand: { id: 'acme' } })).toBe(null);
        ctx.expect(sourceRepo({ repo: { owner: 'Acme-Org' } })).toBe(null);
        ctx.expect(sourceRepo({})).toBe(null);
        ctx.expect(releasesRepo({ brand: { id: 'acme' } })).toBe(null);
        ctx.expect(releasesRepo({ repo: { owner: 'Acme-Org' } })).toBe(null);
      },
    },

    {
      name: 'repoDrift: an origin that IS the derived source repo is no drift, compared case-insensitively (#934)',
      run: (ctx) => {
        ctx.expect(repoDrift('Acme-Org/acme-omega', BRAND)).toBe(null);
        ctx.expect(repoDrift('acme-org/ACME-Omega', BRAND), 'GitHub\'s own comparison ignores case, and so does this one').toBe(null);
      },
    },

    {
      name: 'repoDrift: another owner OR another name is the one drift line, naming both slugs (#934)',
      run: (ctx) => {
        // A transfer: the name agrees, the owner does not.
        ctx.expect(repoDrift('Other-Org/acme-omega', BRAND)).toBe('origin is Other-Org/acme-omega but config derives Acme-Org/acme-omega: fix repo.owner in config/omega.json5 or move the repo');
        // A rename: the owner agrees, the name does not. The owner-only compare this
        // replaced let this one through silently.
        ctx.expect(repoDrift('Acme-Org/acme-site', BRAND)).toBe('origin is Acme-Org/acme-site but config derives Acme-Org/acme-omega: fix repo.owner in config/omega.json5 or move the repo');
      },
    },

    {
      name: 'repoDrift: a config that derives no source repo has nothing to disagree with (#934)',
      run: (ctx) => {
        ctx.expect(repoDrift('Acme-Org/acme-omega', { brand: { id: 'acme' } }), 'no owner').toBe(null);
        ctx.expect(repoDrift('Acme-Org/acme-omega', { repo: { owner: 'Acme-Org' } }), 'no brand id').toBe(null);
      },
    },

    // The one guidance line every unaddressable-repo refusal quotes after its own
    // lead. It names the repo by ROLE, so the placeholders stay literal.
    {
      name: 'repoMissing: the source role names `<brand.id>-omega`',
      run: (ctx) => {
        ctx.expect(repoMissing('source')).toBe('Set repo.owner and brand.id in config/omega.json5: the source repo is <brand.id>-omega under that owner.');
      },
    },

    {
      name: 'repoMissing: the releases role names `<brand.id>-releases`',
      run: (ctx) => {
        ctx.expect(repoMissing('releases')).toBe('Set repo.owner and brand.id in config/omega.json5: the releases repo is <brand.id>-releases under that owner.');
      },
    },

    {
      name: 'repoMissing: the website role names `<brand.id>-<target name>`',
      run: (ctx) => {
        ctx.expect(repoMissing('website')).toBe('Set repo.owner and brand.id in config/omega.json5: the website repo is <brand.id>-<target name> under that owner.');
      },
    },

    {
      name: 'repoMissing: an unknown role throws, never a line naming nothing',
      run: (ctx) => {
        ctx.expect(typeof repoMissing, 'the throw below is the role check, not a missing export').toBe('function');
        ctx.expect(() => repoMissing('content')).toThrow();
        ctx.expect(() => repoMissing(undefined)).toThrow();
      },
    },

    {
      name: 'websiteRepo: a web target publishes to `<brand.id>-<its name>`',
      run: (ctx) => {
        ctx.expect(websiteRepo(BRAND, 'web')).toEqual({ owner: 'Acme-Org', name: 'acme-web', slug: 'Acme-Org/acme-web' });
        ctx.expect(websiteRepo(BRAND, 'community'), 'the NAME is the whole difference between two web targets').toEqual({ owner: 'Acme-Org', name: 'acme-community', slug: 'Acme-Org/acme-community' });
      },
    },

    {
      name: 'websiteRepo: null when the config addresses no repo at all',
      run: (ctx) => {
        const noOwner = { brand: { id: 'acme' }, targets: { web: { type: 'web' } } };
        ctx.expect(websiteRepo(noOwner, 'web')).toBe(null);
      },
    },

    {
      name: 'websiteRepo: only a WEB target is served from its own repo',
      run: (ctx) => {
        ctx.expect(() => websiteRepo(BRAND, 'backend')).toThrow(/targets\.backend is a backend target/);
        ctx.expect(() => websiteRepo(BRAND, 'desktop')).toThrow(/targets\.desktop is a desktop target/);
      },
    },

    {
      name: 'websiteRepo/hostingProvider: an undeclared name is a mistake, never a guess',
      run: (ctx) => {
        ctx.expect(() => websiteRepo(BRAND, 'blog')).toThrow(/No target "blog" is declared/);
        ctx.expect(() => hostingProvider(BRAND, 'blog')).toThrow(/No target "blog" is declared/);
      },
    },

    {
      name: 'hostingProvider: the entry\'s value, else the github default',
      run: (ctx) => {
        ctx.expect(hostingProvider(BRAND, 'web')).toBe('github');
        ctx.expect(hostingProvider({ ...BRAND, targets: { web: { type: 'web', hosting: { provider: 'vercel' } } } }, 'web')).toBe('vercel');
      },
    },

    {
      name: 'websiteRepo: another provider means no GitHub repo to address',
      run: (ctx) => {
        const vercel = { ...BRAND, targets: { web: { type: 'web', hosting: { provider: 'vercel' } } } };
        ctx.expect(websiteRepo(vercel, 'web')).toBe(null);
      },
    },

    // C5/#883: the manage walk sets the Pages domain on the repo and the web
    // deploy writes the CNAME file the push publishes. Two derivations of one
    // domain drift, and a drifted CNAME takes the site off its address.
    {
      name: 'pagesHost: the target url\'s bare host, per target',
      run: (ctx) => {
        ctx.expect(pagesHost(BRAND, 'web'), 'the target named for its type IS the brand host').toBe('acme.com');
        ctx.expect(pagesHost(BRAND, 'community'), 'a named target is its own subdomain (#588)').toBe('community.acme.com');
        ctx.expect(pagesHost({ ...BRAND, targets: { ...BRAND.targets, web: { type: 'web', url: 'https://www.acme.com/landing' } } }, 'web'), 'a declared url wins, and its path is not part of the host').toBe('www.acme.com');
        ctx.expect(pagesHost({ brand: {}, targets: { web: { type: 'web' } } }, 'web'), 'no url, no domain').toBe('');
      },
    },

    // #366: a project site's url names its PAGES ADDRESS, so reading it as a custom
    // domain would have the deploy claim `<owner>.github.io` in a CNAME and mount
    // the build at `/`, where every asset 404s.
    {
      name: 'pagesHost: a *.github.io address is NEVER a custom domain (#366)',
      run: (ctx) => {
        const pages = (url) => pagesHost({ brand: { id: 'acme', url }, targets: { web: { type: 'web' } } }, 'web');

        ctx.expect(pages('https://omega-js-stack.github.io/omega-brand/')).toBe('');
        ctx.expect(pages('https://omega-js-stack.github.io'), 'a bare Pages host is not one either').toBe('');
        ctx.expect(pages('http://OWNER.GitHub.io/Site'), 'host matching is case-insensitive').toBe('');
        ctx.expect(pages('https://github.io.example.com'), 'a real domain that merely CONTAINS github.io still is one').toBe('github.io.example.com');
      },
    },

    {
      name: 'pagesAddress: a web target hosted anywhere but GitHub has no Pages address',
      run: (ctx) => {
        ctx.expect(pagesAddress(BRAND, 'web'), 'the github default: the project site under the lowercased owner').toBe('https://acme-org.github.io/acme-web');

        const vercel = { ...BRAND, targets: { ...BRAND.targets, web: { type: 'web', hosting: { provider: 'vercel' } } } };
        ctx.expect(pagesAddress(vercel, 'web')).toBe(null);
      },
    },

    {
      name: 'brandVisibility: the brand root package.json `private` field, absent meaning private',
      run: (ctx) => {
        const root = path.join(__dirname, '..', '.temp', `repo-visibility-${process.pid}`);
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme' }));
        ctx.expect(brandVisibility(root), 'absent = private: every brand monorepo is private by default').toBe('private');

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme', private: true }));
        ctx.expect(brandVisibility(root)).toBe('private');

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme', private: false }));
        ctx.expect(brandVisibility(root), 'only a literal false is a public brand').toBe('public');

        fs.rmSync(path.join(root, 'package.json'));
        ctx.expect(brandVisibility(root), 'no manifest at all never reads public').toBe('private');
      },
    },

    // C6: a MISSING manifest is the one expected absence. Anything else (a
    // manifest that does not parse, a permission error) is this machine being
    // broken, and 'private' is a plausible-looking answer that hides the break.
    {
      name: 'brandVisibility: a manifest that does not parse fails LOUDLY, never as private',
      run: (ctx) => {
        const root = path.join(__dirname, '..', '.temp', `repo-visibility-broken-${process.pid}`);
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "acme", ');
        ctx.expect(() => brandVisibility(root)).toThrow(SyntaxError);
      },
    },

    // The rename leaves no reader behind: only the migrate table (which converts
    // the old key) and the breaking-changes register may still say it.
    {
      name: 'repo.owner: no source, doc, brand config or plugin file names repo.org or --org',
      run: (ctx) => {
        const root = path.join(__dirname, '..', '..', '..');
        const scopes = ['packages/*/src/**', 'docs/**', 'brands/*/config/**', 'agent-plugins/**'].map((glob) => `:(glob)${glob}`);
        const allowed = (file) => file.startsWith('packages/manager/src/migrate/') || file === 'docs/shared/breaking-changes.md';
        const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes], { cwd: root, encoding: 'utf8' })
          .split('\0')
          .filter((file) => file && !allowed(file) && fs.existsSync(path.join(root, file)));
        const hits = files.flatMap((file) => fs.readFileSync(path.join(root, file), 'utf8')
          .split('\n')
          .flatMap((line, index) => (/\brepo\.org\b|--org\b/.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])));
        ctx.expect(hits).toEqual([]);
      },
    },
  ],
});
