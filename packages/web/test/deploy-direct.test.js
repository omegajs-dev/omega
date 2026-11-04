/**
 * `omega deploy --direct` plan tests: the pure repo/domain derivation.
 *
 * The push target is the WEBSITE repo
 * ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)):
 * `<brand.id>-<target name>` under `repo.owner`, holding the built site alone,
 * so the SOURCE monorepo (`<brand.id>-omega`, where the dispatch lane sends
 * its workflow_dispatch) can stay private. The cname comes from the target's
 * url. The build+push path is exercised live against the playground via the
 * manager's pipeline command, not here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');

const { buildDirectPlan, pushDist } = require('../src/commands/deploy.js');
// The Pages domain derivation is the config's ONE `pagesHost` (#883): the plan
// and the build both ask it, so this file pins WHAT the lanes do with it and
// packages/config/test/repo.test.js pins the derivation itself.
const { pagesHost } = require('@omega.js/config');

// The target NAME is the one thing a plan reads off the filesystem (the
// target's folder inside its brand), so every plan below runs from a real one.
// An empty env keeps the machine this runs on out of it.
const BRAND_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-plan-brand-')));
fs.mkdirSync(path.join(BRAND_ROOT, 'config'), { recursive: true });
fs.writeFileSync(path.join(BRAND_ROOT, 'config', 'omega.json5'), '{ brand: { id: "b", name: "B" }, targets: { web: { type: "web" }, admin: { type: "web" } } }');
for (const name of ['web', 'admin']) {
  fs.mkdirSync(path.join(BRAND_ROOT, 'targets', name), { recursive: true });
}

/** Plan options for a target of this brand: its dir names it, its env is empty. */
const inTarget = (name) => ({ env: {}, cwd: path.join(BRAND_ROOT, 'targets', name) });

const WEB = inTarget('web');
const TARGETS = { web: { type: 'web' }, admin: { type: 'web' } };

module.exports = defineCases({
  type: 'group',
  description: 'deploy-direct',
  cleanup: () => fs.rmSync(BRAND_ROOT, { recursive: true, force: true }),
  tests: [
    // #883, the whole point: the site is pushed to a repo of its own, so nothing
    // about the push depends on what the SOURCE repo is called or who may read it.
    {
      name: 'direct plan: the push target is the website repo `<brand.id>-<target>`, cname from the target url',
      run: (ctx) => {
        const plan = buildDirectPlan({
          repo: { provider: 'github', owner: 'Org' },
          brand: { id: 'b', url: 'https://www.example.com/landing' },
          targets: TARGETS,
        }, WEB);

        ctx.expect(plan.owner).toBe('Org');
        ctx.expect(plan.name, 'the repo name is derived, never typed').toBe('b-web');
        ctx.expect(plan.repo).toBe('Org/b-web');
        ctx.expect(plan.pushUrl).toBe('https://github.com/Org/b-web.git');
        ctx.expect(plan.branch).toBe('gh-pages');
        ctx.expect(plan.cname).toBe('www.example.com');
      },
    },

    {
      name: 'direct plan: a custom-domain plan carries the domain root prefix and its CNAME, unchanged',
      run: (ctx) => {
        const plan = buildDirectPlan({
          repo: { owner: 'Org' },
          brand: { id: 'b', url: 'https://www.example.com' },
          targets: TARGETS,
        }, WEB);

        ctx.expect(plan.cname).toBe('www.example.com');
        ctx.expect(plan.url, 'the address the deploy reports').toBe('https://www.example.com');
        ctx.expect(plan.pathPrefix, 'a CNAME cannot carry a path, so the build stays at the domain root').toBe('/');
      },
    },

    {
      name: 'direct plan: NO brand.url → a gh-pages PROJECT site (derived address, no CNAME, the #358 prefix)',
      run: (ctx) => {
        const plan = buildDirectPlan({
          repo: { owner: 'Omega-JS-Stack' },
          brand: { id: 'omega' },
          targets: TARGETS,
        }, WEB);

        ctx.expect(plan.repo).toBe('Omega-JS-Stack/omega-web');
        ctx.expect(plan.pushUrl).toBe('https://github.com/Omega-JS-Stack/omega-web.git');
        ctx.expect(plan.branch).toBe('gh-pages');
        ctx.expect(plan.cname, 'no custom domain → no CNAME step').toBe('');
        ctx.expect(plan.url, 'the default project address').toBe('https://omega-js-stack.github.io/omega-web/');
        ctx.expect(plan.pathPrefix, 'the build mounts everything under the project path').toBe('/omega-web/');
      },
    },

    // The loader fills an unset brand.url with the Pages address before any plan
    // runs, so a config that reaches the plan without it derives that same address.
    {
      name: 'direct plan: no brand.url plans the Pages project site from the repo',
      run: (ctx) => {
        const plan = buildDirectPlan({ repo: { owner: 'Dreamr-Design' }, brand: { id: 'dreamr' }, targets: TARGETS }, WEB);

        ctx.expect(plan.url).toBe('https://dreamr-design.github.io/dreamr-web/');
        ctx.expect(plan.pathPrefix).toBe('/dreamr-web/');
      },
    },

    // A hand-set Pages address is the value the loader would derive, so it must
    // plan the very same project site: no CNAME, the project path, the same address.
    {
      name: 'direct plan: a hand-set brand.url equal to the Pages address plans the same project site the loader would derive',
      run: (ctx) => {
        const plan = buildDirectPlan({
          repo: { owner: 'Omega-JS-Stack' },
          brand: { id: 'omega', url: 'https://omega-js-stack.github.io/omega-web' },
          targets: TARGETS,
        }, WEB);

        ctx.expect(plan.cname, 'still a project site: no CNAME claiming <owner>.github.io').toBe('');
        ctx.expect(plan.pathPrefix, 'still mounted under the project path: assets keep resolving').toBe('/omega-web/');
        ctx.expect(plan.url, 'the same address it published to before').toBe('https://omega-js-stack.github.io/omega-web/');
      },
    },

    {
      name: 'direct plan: a *.github.io brand.url names the mount, the repo only fills the gaps (#366)',
      run: (ctx) => {
        const plan = buildDirectPlan({
          repo: { owner: 'Omega-JS-Stack' },
          brand: { id: 'omega', url: 'https://omega-js-stack.github.io/workkit/' },
          targets: TARGETS,
        }, WEB);

        ctx.expect(plan.repo, 'the repo is still the derived one').toBe('Omega-JS-Stack/omega-web');
        ctx.expect(plan.pathPrefix, 'the path brand.url carries IS the base path').toBe('/workkit/');
        ctx.expect(plan.url, 'and the address agrees with it').toBe('https://omega-js-stack.github.io/workkit/');
      },
    },

    {
      name: 'the deploy path writes a CNAME only for the domain shape, and reports the plan address',
      run: (ctx) => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'deploy.js'), 'utf8');

        ctx.expect(source, 'the CNAME step is skipped for a project site').toMatch(/if \(plan\.cname\) \{\s*\n\s*fs\.writeFileSync\(path\.join\(dist, 'CNAME'\), plan\.cname\);/);
        ctx.expect(source, 'the deploy reports the address it published to').toMatch(/Deployed — \$\{plan\.url\} serves/);
      },
    },

    // #883: the FIRST deploy of a brand creates the gh-pages branch on a repo
    // nothing has configured yet, so the lane that made the branch is the lane that
    // points Pages at it (and at the domain). The manage walk reconciles the same
    // two facts, which is why a machine without `gh` warns instead of failing.
    {
      name: 'the deploy path configures Pages on what it just pushed (#883)',
      run: (ctx) => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'deploy.js'), 'utf8');

        ctx.expect(source, 'through the ONE github-repo helper, never a second gh call').toMatch(/require\('@omega\.js\/devkit\/github-repo'\)\.ensurePages\(\{/);
        ctx.expect(source, 'with the repo, branch and domain the push used').toMatch(/ensurePages\(\{[\s\S]{0,220}owner: plan\.owner,[\s\S]{0,220}branch: plan\.branch,[\s\S]{0,220}cname: plan\.cname/);
        ctx.expect(source.indexOf('pushDist(plan') < source.indexOf('ensurePages('), 'after the push: Pages cannot be configured before the branch exists').toBeTruthy();
      },
    },

    // B1/#883: the token used to ride the push URL, so it sat in the argv of a
    // child process (readable machine-wide), in git's own error output, and in the
    // message `execFileSync` throws (which carries the whole argv): a plaintext
    // credential in any log written outside Actions' masking. It now reaches git
    // through the config env of that one process and nothing else.
    {
      name: 'the push never carries the token in its argv, and a failure never prints it (B1)',
      run: (ctx) => {
        const plan = { pushUrl: 'https://github.com/Org/b-web.git', branch: 'gh-pages', repo: 'Org/b-web' };
        const calls = [];

        pushDist(plan, {
          cwd: '/tmp/dist',
          env: { GH_TOKEN: 'ghs_supersecret' },
          execFn: (file, args, options) => { calls.push({ file, args, options }); return ''; },
        });

        const [call] = calls;
        ctx.expect(call.args, 'the plain url, no credentials').toEqual(['push', '-q', '-f', 'https://github.com/Org/b-web.git', 'gh-pages']);
        ctx.expect(!JSON.stringify(call.args).includes('ghs_supersecret'), 'no argv element carries the token').toBeTruthy();

        // The credential travels as git config, for this child process only.
        const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_supersecret').toString('base64')}`;
        ctx.expect(call.options.env.GIT_CONFIG_COUNT).toBe('1');
        ctx.expect(call.options.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
        ctx.expect(call.options.env.GIT_CONFIG_VALUE_0).toBe(header);

        // A failing push: git's message is rethrown scrubbed, in both the raw form
        // and the base64 the header carries.
        let thrown = null;
        try {
          pushDist(plan, {
            cwd: '/tmp/dist',
            env: { GH_TOKEN: 'ghs_supersecret' },
            execFn: () => { throw new Error(`Command failed: git push https://x-access-token:ghs_supersecret@github.com/Org/b-web.git (${header})`); },
          });
        } catch (error) {
          thrown = error;
        }

        ctx.expect(thrown.message, 'the failure names the repo it was pushing to').toMatch(/Pushing to Org\/b-web failed/);
        ctx.expect(!thrown.message.includes('ghs_supersecret'), 'the raw token is scrubbed out of the failure').toBeTruthy();
        ctx.expect(!thrown.message.includes(Buffer.from('x-access-token:ghs_supersecret').toString('base64')), 'and so is its base64').toBeTruthy();
      },
    },

    // No token around (a developer with neither GH_TOKEN nor `gh auth`): the push
    // runs plainly and git asks for credentials itself.
    {
      name: 'the push adds no git config when no token resolves (B1)',
      run: (ctx) => {
        const calls = [];

        pushDist({ pushUrl: 'https://github.com/Org/b-web.git', branch: 'gh-pages', repo: 'Org/b-web' }, {
          env: {},
          token: null,
          execFn: (file, args, options) => { calls.push(options); return ''; },
        });

        ctx.expect(calls[0].env.GIT_CONFIG_COUNT, 'no half-configured credential env').toBe(undefined);
        ctx.expect(calls[0].env.GIT_CONFIG_VALUE_0).toBe(undefined);
      },
    },

    // The OTHER CNAME writer: every production build emits dist/CNAME so both
    // deploy lanes publish it. It asks the same one derivation, so a project site's
    // brand.url can never make a build claim `<owner>.github.io` (#366).
    {
      name: 'the production build writes a CNAME only for a real custom domain, never *.github.io (#366)',
      run: (ctx) => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'build.js'), 'utf8');

        ctx.expect(source, 'the build asks the ONE derivation whether a custom domain exists').toMatch(/const cname = pagesHost\(siteData, targetNameFromDir\(paths\.root\) \|\| 'web'\);\s*\n\s*if \(cname\) \{/);
        ctx.expect(pagesHost({ brand: { id: 'b', url: 'https://omega-js-stack.github.io/omega-brand' }, targets: { web: { type: 'web' } } }, 'web'), 'so a project-site url writes no CNAME at all').toBe('');
      },
    },

    // #883: the environment and the git remote both name the repo the checkout
    // SITS IN (the source repo on a runner, the enclosing monorepo in a nested
    // brand). Neither is the website repo, so neither is consulted any more: a
    // config that names no owner refuses, and says which key to set.
    {
      name: 'direct plan: a config that names no owner REFUSES, and no ambient repo can stand in',
      run: (ctx) => {
        const message = (() => {
          try {
            buildDirectPlan({ brand: { id: 'b', url: 'https://x.y' }, targets: TARGETS }, { env: { GITHUB_REPOSITORY: 'Acme/site' }, cwd: WEB.cwd });
            return '';
          } catch (error) {
            return error.message;
          }
        })();

        ctx.expect(message, 'the one key to set is named').toMatch(/repo\.owner/);
        ctx.expect(message, 'and what it addresses').toMatch(/website repo/);
        ctx.expect(message.includes('Set repo.owner and brand.id in config/omega.json5: the website repo is <brand.id>-<target name> under that owner.'), 'the shared line names the website role').toBeTruthy();
        ctx.expect(message, 'neither the CI environment nor a git remote is offered: both name the wrong repo').not.toMatch(/GITHUB_REPOSITORY|remote/);
      },
    },

    {
      name: 'direct plan: a target the config does not declare refuses, listing the ones it does',
      run: (ctx) => {
        ctx.expect(() => buildDirectPlan({ repo: { owner: 'Org' }, brand: { id: 'b' }, targets: { site: { type: 'web' } } }, WEB)).toThrow(/No target "web" is declared[\s\S]*site/);
      },
    },

    {
      name: 'direct plan: a second web target pushes to ITS OWN repo, the first untouched (#588, #883)',
      run: (ctx) => {
        const config = {
          repo: { owner: 'Org' },
          brand: { id: 'acme', url: 'https://acme.test' },
          targets: TARGETS,
        };

        // The resolved config's top-level `url` is THIS target's own public url; the
        // loader fills it (a bare `admin: { type: 'web' }` is admin.<brand host>).
        const admin = buildDirectPlan({ ...config, url: 'https://admin.acme.test' }, inTarget('admin'));
        ctx.expect(admin.repo, 'one repo per web target').toBe('Org/acme-admin');
        ctx.expect(admin.cname, 'the gh-pages CNAME names the target host').toBe('admin.acme.test');
        ctx.expect(admin.url).toBe('https://admin.acme.test');
        ctx.expect(admin.pathPrefix, 'a custom domain mounts at the root').toBe('/');

        const main = buildDirectPlan(config, WEB);
        ctx.expect(main.repo).toBe('Org/acme-web');
        ctx.expect(main.cname, 'the target named for its type is the brand host, unchanged').toBe('acme.test');
      },
    },

    // #588/#886 through the REAL loader: the resolved url and the target name are
    // what the plan reads, so the two derivations are pinned against a real file.
    {
      name: 'direct plan: the composed config of a named target resolves to its own host and repo',
      run: (ctx) => {
        const { loadConfig } = require('@omega.js/config');

        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-deploy-named-')));
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        fs.mkdirSync(path.join(root, 'config'), { recursive: true });
        fs.writeFileSync(path.join(root, 'config', 'omega.json5'), `{
  brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
  repo: { provider: 'github', owner: 'Acme-Org' },
  targets: { web: { type: 'web' }, admin: { type: 'web' } },
}`);
        for (const dir of ['web', 'admin']) {
          fs.mkdirSync(path.join(root, 'targets', dir), { recursive: true });
          fs.writeFileSync(path.join(root, 'targets', dir, 'package.json'), '{}');
        }

        const planFor = (dir) => {
          const targetDir = path.join(root, 'targets', dir);
          const { config, errors } = loadConfig(targetDir, 'web');
          ctx.expect(errors, `${dir} config is valid`).toEqual([]);
          return { plan: buildDirectPlan(config, { env: {}, cwd: targetDir }), config };
        };

        const admin = planFor('admin');
        ctx.expect(admin.plan.repo).toBe('Acme-Org/acme-admin');
        ctx.expect(admin.plan.cname).toBe('admin.acme.test');
        ctx.expect(pagesHost(admin.config, 'admin'), "so does `omega build`'s dist/CNAME").toBe('admin.acme.test');

        const main = planFor('web');
        ctx.expect(main.plan.repo).toBe('Acme-Org/acme-web');
        ctx.expect(main.plan.cname).toBe('acme.test');
        ctx.expect(main.plan.url).toBe('https://acme.test');
      },
    },

    // #426: the direct lane loaded the config and dropped its validation findings
    // on the floor (the old guard tested `!config`, which the loader never returns).
    // A fatal finding is a refusal, not a plan: it stops the lane before the build,
    // the CNAME write and the push, and it stops a DRY RUN too: a plan printed
    // from a config nothing will read is a lie about what would happen.
    {
      name: 'deploy --direct: a fatal config finding stops the lane before any deploy work (#426)',
      run: async (ctx) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-deploy-invalid-'));
        const previous = process.cwd();
        ctx.after(() => {
          process.chdir(previous);
          fs.rmSync(dir, { recursive: true, force: true });
        });

        // Everything a plan needs IS here (owner + brand.id + brand.url), so the retired
        // key is the only reason to refuse.
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config', 'omega.json5'), `{
  brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
  repo: { provider: 'github', owner: 'Org' },
  payment: { processors: { stripe: {} } },
  targets: { web: { type: 'web' } },
}`);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme-website', private: true }));

        process.chdir(dir);
        await ctx.expect(require('../src/commands/deploy.js')({ direct: true, dryRun: true }), 'the findings surface as a thrown fatal, not a silently-ignored array').rejects.toThrow(/config\/omega\.json5 is invalid:[\s\S]*payment\.processors\.stripe is not a key the schema declares/);
      },
    },

    // #856: both deploy lanes publish a PRODUCTION site, so the config they read is
    // the production one. The overlay that composes is named by the lane, never by
    // the machine, which answers `development` in a terminal.
    {
      name: 'deploy --direct: the PRODUCTION overlay is the config the lane reads (#856)',
      run: async (ctx) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-deploy-overlay-'));
        const previous = process.cwd();
        const saved = [['ENVIRONMENT', process.env.ENVIRONMENT], ['OMEGA_ENVIRONMENT', process.env.OMEGA_ENVIRONMENT]];
        ctx.after(() => {
          process.chdir(previous);
          fs.rmSync(dir, { recursive: true, force: true });
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        });

        // The base is clean and the development overlay is clean, so ONLY the
        // production overlay can produce this refusal.
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config', 'omega.json5'), `{
  brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
  repo: { provider: 'github', owner: 'Org' },
  targets: { web: { type: 'web' } },
}`);
        fs.writeFileSync(path.join(dir, 'config', 'omega.production.json5'), '{ payment: { processors: { stripe: {} } } }');
        fs.writeFileSync(path.join(dir, 'config', 'omega.development.json5'), "{ theme: { id: 'classy' } }");
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme-website', private: true }));

        delete process.env.OMEGA_ENVIRONMENT;
        process.env.ENVIRONMENT = 'development';
        process.chdir(dir);

        await ctx.expect(require('../src/commands/deploy.js')({ direct: true, dryRun: true }), 'the production overlay is a layer of the deploy config, so its retired key refuses the lane').rejects.toThrow(/config\/omega\.json5 is invalid:[\s\S]*payment\.processors\.stripe is not a key the schema declares/);
      },
    },
  ],
});
