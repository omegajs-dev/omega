/**
 * Deploy executor (D13/D9) — the ONE workflow_dispatch path shared by CLI
 * deploys and server-side content-publish. Pins: remote-url parsing, token
 * layering, the dispatch plan shape (dry-run = the plan, nothing sent),
 * success/failure against an injected fetch, and the no-token error.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

// The machine registry is per-machine state: this file's fixtures record into a temp home.
require('../src/test/temp-home.js');

const {
  parseRemoteUrl,
  dispatchRepo,
  resolveRepo,
  resolveToken,
  buildDispatch,
  dispatchWorkflow,
  deployViaDispatch,
} = require('../src/deploy.js');

// ---- resolveDeployLane + the snapshot lane (#872)

/** A brand tree: a root with `targets/site`, linked or registry-clean. */
function stageBrandTree({ linked }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-deploy-lane-')));
  const targetDir = path.join(scratch, 'brand', 'targets', 'site');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(scratch, 'brand', 'config'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'brand', 'config', 'omega.json5'), '{ brand: { id: \'acme\' } }');
  fs.writeFileSync(path.join(scratch, 'brand', 'package.json'), JSON.stringify({ name: 'brand', private: true, workspaces: ['targets/*'] }));
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
    name: 'site',
    dependencies: { '@omega.js/web': linked ? 'file:../../../packages/web' : '^0.1.0' },
  }));

  return { scratch, brandRoot: path.join(scratch, 'brand'), targetDir };
}

/**
 * The steps every delivery now starts with (#915, #922, #934, #938), recorded
 * rather than run: the origin gate every lane passes, the registry lane's
 * lockfile gate, the default-branch read,
 * the gh-pages heal of the name that read returned, and the composed
 * workflows' compare and push to that branch. The behind check is git's, so it
 * is recorded here too and a case that wants a refusal overrides it.
 *
 * @param {string[]} order - The run's step log.
 * @returns {object} The steps to inject.
 */
function laneSteps(order) {
  return {
    origin: (options) => order.push(`origin:${options.root}`),
    lockfile: (options) => order.push(`lockfile:${options.root}`),
    defaultBranch: async () => { order.push('defaultBranch'); return 'main'; },
    heal: async (options) => { order.push('heal'); return options.current; },
    behind: (options) => order.push(`behind:${options.branch}`),
    workflows: async (options) => { order.push(`workflows:${options.branch}`); return { pushed: [], sha: null }; },
  };
}

module.exports = defineCases({
  type: 'group',
  description: 'deploy',
  tests: [
    {
      name: 'parseRemoteUrl: ssh, https, and .git-less forms',
      run: (ctx) => {
        ctx.expect(parseRemoteUrl('git@github.com:Omega-JS-Stack/omega.git')).toEqual({ owner: 'Omega-JS-Stack', repo: 'omega' });
        ctx.expect(parseRemoteUrl('https://github.com/acme/site.git')).toEqual({ owner: 'acme', repo: 'site' });
        ctx.expect(parseRemoteUrl('https://github.com/acme/site')).toEqual({ owner: 'acme', repo: 'site' });
        ctx.expect(parseRemoteUrl('https://gitlab.com/acme/site.git'), 'non-GitHub remotes are not silently accepted').toBe(null);
        ctx.expect(parseRemoteUrl('')).toBe(null);
      },
    },

    {
      name: 'resolveRepo: reads the origin remote via the injected exec',
      run: (ctx) => {
        const calls = [];
        const repo = resolveRepo({
          cwd: '/tmp/x',
          execFn: (cmd, opts) => {
            calls.push({ cmd, cwd: opts.cwd });
            return 'git@github.com:acme/site.git\n';
          },
        });
        ctx.expect(repo).toEqual({ owner: 'acme', repo: 'site' });
        ctx.expect(calls[0].cmd).toBe('git config --get remote.origin.url');
        ctx.expect(calls[0].cwd).toBe('/tmp/x');

        ctx.expect(() => resolveRepo({ execFn: () => 'https://example.com/not-github.git' })).toThrow(/Cannot parse a GitHub repo/);
      },
    },

    {
      name: 'dispatchRepo: the CONFIG names the SOURCE repo a dispatch addresses, never a remote (#799/#883)',
      run: (ctx) => {
        ctx.expect(dispatchRepo({ brand: { id: 'acme' }, repo: { owner: 'Acme-Org' } })).toEqual({ owner: 'Acme-Org', repo: 'acme-omega' });

        // The workflows live on the SOURCE repo whatever a target publishes to, so a
        // web target's own website repo never becomes the dispatch address (#883).
        ctx.expect(dispatchRepo({ brand: { id: 'acme' }, repo: { owner: 'Acme-Org' }, targets: { web: { type: 'web' } } })).toEqual({ owner: 'Acme-Org', repo: 'acme-omega' });

        // Half an address addresses nothing: throw instead of POSTing to `undefined/acme`.
        ctx.expect(() => dispatchRepo({ brand: { id: 'acme' } })).toThrow(/brand repo to dispatch on/);
        ctx.expect(() => dispatchRepo({})).toThrow(/brand repo to dispatch on/);

        // The lead says what failed; the shared line says how to fix it.
        ctx.expect(() => dispatchRepo({ brand: { id: 'acme' } })).toThrow((error) => error.message.includes('Set repo.owner and brand.id in config/omega.json5: the source repo is <brand.id>-omega under that owner.'));
      },
    },

    {
      name: 'dispatchTarget: the repo from config, and the COMPOSED workflow name inside a brand (#847)',
      run: (ctx) => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { dispatchTarget } = require('../src/deploy.js');

        const config = { brand: { id: 'acme' }, repo: { owner: 'Acme-Org' } };
        const brandRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-dispatch-target-')));
        const targetDir = path.join(brandRoot, 'targets', 'extension');

        try {
          fs.mkdirSync(path.join(brandRoot, 'config'), { recursive: true });
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(brandRoot, 'config', 'omega.json5'), '{ brand: { id: \'acme\' }, targets: { extension: { type: \'extension\' } } }');

          // A target inside a brand: its CI lives at the BRAND ROOT under the
          // per-target name the scaffold composed (#265).
          ctx.expect(dispatchTarget({ projectRoot: targetDir, config, workflow: 'publish.yml' })).toEqual({ owner: 'Acme-Org', repo: 'acme-omega', workflow: 'extension-publish.yml' });

          // Standalone: the framework's own file name, unchanged.
          const standalone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-dispatch-standalone-')));
          try {
            ctx.expect(dispatchTarget({ projectRoot: standalone, config, workflow: 'build.yml' })).toEqual({ owner: 'Acme-Org', repo: 'acme-omega', workflow: 'build.yml' });

            // Half an address addresses nothing: the repo rule is dispatchRepo's.
            ctx.expect(() => dispatchTarget({ projectRoot: standalone, config: { brand: { id: 'acme' } }, workflow: 'build.yml' })).toThrow(/brand repo to dispatch on/);
          } finally {
            fs.rmSync(standalone, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'resolveToken: GH_TOKEN → GITHUB_TOKEN → gh auth token → null',
      run: (ctx) => {
        ctx.expect(resolveToken({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, execFn: () => { throw new Error('no'); } })).toBe('a');
        ctx.expect(resolveToken({ env: { GITHUB_TOKEN: 'b' }, execFn: () => { throw new Error('no'); } })).toBe('b');
        ctx.expect(resolveToken({ env: {}, execFn: () => 'gh-tok\n' })).toBe('gh-tok');
        ctx.expect(resolveToken({ env: {}, execFn: () => { throw new Error('gh not installed'); } })).toBe(null);
      },
    },

    {
      name: 'buildDispatch: plan shape + inputs only when present',
      run: (ctx) => {
        const plan = buildDispatch({ owner: 'acme', repo: 'site', workflow: 'build.yml' });
        ctx.expect(plan.method).toBe('POST');
        ctx.expect(plan.url).toBe('https://api.github.com/repos/acme/site/actions/workflows/build.yml/dispatches');
        ctx.expect(plan.body, 'no inputs key when none given').toEqual({ ref: 'main' });
        ctx.expect(plan.runsUrl).toBe('https://github.com/acme/site/actions/workflows/build.yml');

        const withInputs = buildDispatch({ owner: 'a', repo: 'r', workflow: 'w.yml', ref: 'develop', inputs: { platforms: 'all' } });
        ctx.expect(withInputs.body).toEqual({ ref: 'develop', inputs: { platforms: 'all' } });

        ctx.expect(() => buildDispatch({ owner: 'a', repo: 'r' })).toThrow(/missing workflow/);
      },
    },

    {
      name: 'dispatchWorkflow: 204 succeeds, non-204 throws with body, no token throws guidance',
      run: async (ctx) => {
        const plan = buildDispatch({ owner: 'a', repo: 'r', workflow: 'w.yml' });

        const sent = [];
        const ok = await dispatchWorkflow(plan, {
          token: 'tok',
          fetchFn: async (url, init) => {
            sent.push({ url, init });
            return { status: 204 };
          },
        });
        ctx.expect(ok).toBe(plan);
        ctx.expect(sent[0].url).toBe(plan.url);
        ctx.expect(sent[0].init.headers.Authorization).toBe('Bearer tok');
        ctx.expect(JSON.parse(sent[0].init.body)).toEqual({ ref: 'main' });

        await ctx.expect(dispatchWorkflow(plan, { token: 'tok', fetchFn: async () => ({ status: 404, text: async () => 'Not Found' }) })).rejects.toThrow(/workflow_dispatch failed \(404\): Not Found/);

        await ctx.expect(dispatchWorkflow(plan, { token: null })).rejects.toThrow(/No GitHub token/);
      },
    },

    {
      name: 'deployViaDispatch: dry-run builds the plan and sends NOTHING',
      run: async (ctx) => {
        let fetched = 0;
        const result = await deployViaDispatch({
          workflow: 'build.yml',
          dryRun: true,
          execFn: () => 'git@github.com:acme/site.git',
          fetchFn: async () => { fetched++; return { status: 204 }; },
        });
        ctx.expect(result.dispatched).toBe(false);
        ctx.expect(fetched, 'dry-run must not touch the network').toBe(0);
        ctx.expect(result.plan.url).toBe('https://api.github.com/repos/acme/site/actions/workflows/build.yml/dispatches');
      },
    },

    {
      name: 'deployViaDispatch: explicit owner/repo skips git; live path dispatches',
      run: async (ctx) => {
        const sent = [];
        const result = await deployViaDispatch({
          workflow: 'publish.yml',
          owner: 'acme',
          repo: 'site',
          env: { GH_TOKEN: 'tok' },
          fetchFn: async (url) => { sent.push(url); return { status: 204 }; },
          execFn: () => { throw new Error('git must not be called when owner/repo are explicit'); },
        });
        ctx.expect(result.dispatched).toBe(true);
        ctx.expect(sent.length).toBe(1);
      },
    },

    // ---- findLocalSpecs (what makes a tree LINKED, and so a snapshot lane, #872)

    {
      name: 'findLocalSpecs lists tree-wide file: @omega.js specs',
      run: (ctx) => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { findLocalSpecs } = require('../src/deploy.js');

        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-deploy-guard-'));
        try {
          const targetDir = path.join(scratch, 'targets', 'site');
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'brand', private: true, workspaces: ['targets/*'] }));
          fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
            name: 'site',
            dependencies: { '@omega.js/web': 'file:../../monorepo/packages/web', '@omega.js/client': '^0.1.0' },
          }));

          const offenders = findLocalSpecs({ dir: targetDir });
          ctx.expect(offenders.length, 'exactly the file: spec is an offender').toBe(1);
          ctx.expect(offenders[0]).toMatch(/@omega\.js\/web: file:/);

          // Registry-clean tree: an empty list, which is the push lane
          fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
            name: 'site',
            dependencies: { '@omega.js/web': '^0.1.0', '@omega.js/client': '^0.1.0' },
          }));
          ctx.expect(findLocalSpecs({ dir: targetDir })).toEqual([]);
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'resolveDeployLane: ONE lane for every brand with a repo, on omega-deploy (#915)',
      run: (ctx) => {
        const fs = require('node:fs');
        const path = require('node:path');
        const { resolveDeployLane } = require('../src/deploy.js');

        // Nested: the brand root is not the toplevel of the repo it sits in. Its
        // mirror repo takes the snapshot on the deploy branch like any other brand,
        // and that repo's own default branch holds the composed workflows.
        const nested = stageBrandTree({ linked: false });
        try {
          const lane = resolveDeployLane({ dir: nested.targetDir, execFn: () => `${nested.scratch}\n` });
          ctx.expect({ mode: lane.mode, ref: lane.ref, nested: lane.nested, linked: lane.linked, brandRoot: lane.brandRoot }).toEqual({ mode: 'snapshot', ref: 'omega-deploy', nested: true, linked: false, brandRoot: nested.brandRoot });
        } finally {
          fs.rmSync(nested.scratch, { recursive: true, force: true });
        }

        // Linked, its own repo: the packed tarballs never enter the real history
        const linked = stageBrandTree({ linked: true });
        try {
          const lane = resolveDeployLane({ dir: linked.targetDir, execFn: (cmd) => (cmd.includes('--show-toplevel') ? `${linked.brandRoot}\n` : 'feature\n') });
          ctx.expect({ mode: lane.mode, ref: lane.ref, nested: lane.nested, linked: lane.linked }).toEqual({ mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: true });
        } finally {
          fs.rmSync(linked.scratch, { recursive: true, force: true });
        }

        // Registry-clean and its own repo: the SAME lane (#915). The push lane, which
        // committed the developer's branch and dispatched it, is gone: CI only ever
        // builds omega-deploy, whoever started the deploy.
        const plain = stageBrandTree({ linked: false });
        try {
          const lane = resolveDeployLane({
            dir: plain.brandRoot,
            execFn: (cmd) => (cmd.includes('--show-toplevel') ? `${plain.brandRoot}\n` : 'release/2\n'),
          });
          ctx.expect({ mode: lane.mode, ref: lane.ref, nested: lane.nested, linked: lane.linked }).toEqual({ mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: false });
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
        }

        // A brand outside git at all cannot snapshot: the dispatch alone, on whatever
        // the deploy branch already holds
        const loose = stageBrandTree({ linked: false });
        try {
          const lane = resolveDeployLane({
            dir: loose.brandRoot,
            execFn: () => { throw new Error('not a git repository'); },
          });
          ctx.expect({ mode: lane.mode, ref: lane.ref, nested: lane.nested, repo: lane.repo }).toEqual({ mode: 'dispatch', ref: 'omega-deploy', nested: false, repo: false });
        } finally {
          fs.rmSync(loose.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: the snapshot lane checks, composes, packs, pushes, restores, waits, THEN dispatches (#872, #915)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const order = [];
        const nested = stageBrandTree({ linked: true });
        let waitedFor = null;

        try {
          const result = await deployViaDispatch({
            workflow: 'desktop-build.yml',
            owner: 'Omega-JS-Stack',
            repo: 'playground-omega',
            dir: nested.targetDir,
            token: 'tok',
            execFn: () => `${nested.scratch}\n`,
            fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
            steps: {
              ...laneSteps(order),
              stage: async ({ dir }) => {
                order.push(`stage:${dir}`);
                return { staged: ['@omega.js/web'], restore: async () => order.push('restore') };
              },
              push: (options) => {
                // The push is told what the stage produced, so it can refuse a tree
                // whose ignore rules would drop it (#872).
                ctx.expect(options.require).toEqual(['omega_modules', 'package-lock.json']);
                order.push(`push:${options.ref}`);
                return 'abc123';
              },
              // The ref has to RESOLVE to what the push just wrote before anything
              // dispatches against it (#902).
              waitRef: async (options) => {
                waitedFor = options;
                order.push(`waitRef:${options.ref}`);
              },
              wait: async (options) => { order.push(`wait:${options.workflow}`); },
            },
          });

          ctx.expect(order).toEqual([
            // The origin gate runs on every lane (#934); a nested brand has no origin
            // of its own, which the real gate answers as nothing to compare.
            `origin:${nested.brandRoot}`,
            'defaultBranch',
            'heal',
            // A nested brand's git toplevel is the enclosing repo's, so there is no
            // checkout of the brand's own repo to be behind (#915).
            'workflows:main',
            `stage:${nested.brandRoot}`,
            'push:omega-deploy',
            'restore',
            'waitRef:omega-deploy',
            'wait:desktop-build.yml',
            'dispatch',
          ]);
          ctx.expect(waitedFor.sha, 'it waits for the sha the push returned').toBe('abc123');
          ctx.expect(result.dispatched).toBe(true);
          ctx.expect(result.lane.mode).toBe('snapshot');
          ctx.expect(result.sha, 'the verb prints and follows the sha this deploy pushed (#902)').toBe('abc123');
          ctx.expect(result.plan.body.ref, 'the dispatch runs the ref the snapshot landed on').toBe('omega-deploy');
        } finally {
          fs.rmSync(nested.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: a failed snapshot restores the tree and never dispatches (#872)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const order = [];
        const nested = stageBrandTree({ linked: true });

        try {
          await ctx.expect(deployViaDispatch({
              workflow: 'desktop-build.yml',
              owner: 'acme',
              repo: 'acme-omega',
              dir: nested.targetDir,
              token: 'tok',
              execFn: () => `${nested.scratch}\n`,
              fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
              steps: {
                ...laneSteps(order),
                stage: async () => ({ staged: [], restore: async () => order.push('restore') }),
                push: () => { throw new Error('remote rejected the snapshot'); },
                wait: async () => order.push('wait'),
              },
            })).rejects.toThrow(/remote rejected the snapshot/);

          ctx.expect(order, 'the tree goes back, and nothing else runs').toEqual([`origin:${nested.brandRoot}`, 'defaultBranch', 'heal', 'workflows:main', 'restore']);
        } finally {
          fs.rmSync(nested.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: a PLAIN brand takes the same one lane, and a brand outside git only dispatches (#915)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const plain = stageBrandTree({ linked: false });
        const order = [];
        const steps = {
          ...laneSteps(order),
          // Registry-clean: nothing to pack, so the stage never runs on this tree.
          stage: async () => { order.push('stage'); return { staged: [], restore: async () => order.push('restore') }; },
          push: (options) => { order.push(`push:${options.ref}`); return 'abc1234567890'; },
          waitRef: () => order.push('waitRef'),
          wait: () => order.push('wait'),
        };
        const base = {
          workflow: 'website-build.yml',
          owner: 'acme',
          repo: 'acme-omega',
          dir: plain.brandRoot,
          token: 'tok',
          execFn: (cmd) => (cmd.includes('--show-toplevel') ? `${plain.brandRoot}\n` : 'main\n'),
          fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
          steps,
        };

        try {
          // The push lane is gone (#915): a registry-clean brand that owns its repo
          // snapshots to omega-deploy like every other brand, and its own branch is
          // never committed for it.
          const result = await deployViaDispatch({ ...base });
          ctx.expect(order).toEqual([
            // The origin gate, on every lane (#934)
            `origin:${plain.brandRoot}`,
            // Registry-clean: the brand's own lock ships, so the gate runs next (#938)
            `lockfile:${plain.brandRoot}`,
            'defaultBranch',
            'heal',
            'behind:main',
            'workflows:main',
            'push:omega-deploy',
            'waitRef',
            'wait',
            'dispatch',
          ]);
          ctx.expect(result.sha, 'every lane pushes a snapshot the follower can hold the run to (#902)').toBe('abc1234567890');
          ctx.expect(result.lane.mode).toBe('snapshot');

          // A brand outside git altogether: nothing to snapshot FROM, so the dispatch
          // is the whole lane, never a raw `fatal: not a git repository`.
          order.length = 0;
          const loose = await deployViaDispatch({ ...base, execFn: () => { throw new Error('not a git repository'); } });
          ctx.expect(order, 'no repo: no delivery at all, and no git error; the origin gate still runs, because the dispatch still acts on the derived repo (#934)').toEqual([`origin:${plain.brandRoot}`, 'wait', 'dispatch']);
          ctx.expect(loose.lane.mode).toBe('dispatch');
          ctx.expect(loose.plan.body.ref, 'and it dispatches the one branch CI builds').toBe('omega-deploy');
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deliverLane: a checkout BEHIND the default branch refuses, naming the fix (#915)',
      run: async (ctx) => {
        const { deliverLane, assertNotBehind } = require('../src/deploy.js');
        const lane = { mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: false, repo: true, brandRoot: '/brand' };
        const order = [];

        await ctx.expect((() => deliverLane({
            lane,
            owner: 'acme',
            repo: 'acme-omega',
            token: 'tok',
            steps: {
              lockfile: () => {},
              defaultBranch: async () => 'main',
              behind: (options) => assertNotBehind({
                ...options,
                // Real git's answer, injected: `merge-base --is-ancestor` exits
                // nonzero exactly when the remote branch is not in this history.
                execFn: (args) => {
                  if (args[0] === 'merge-base') throw Object.assign(new Error('exit 1'), { status: 1 });
                  return '';
                },
              }),
              workflows: async () => order.push('workflows'),
              push: () => order.push('push'),
            },
          }))()).rejects.toThrow((error) => {
            ctx.expect(error.message).toMatch(/behind origin\/main/);
            ctx.expect(error.message, 'it says what would be lost').toMatch(/pushes it as its snapshot over omega-deploy/);
            ctx.expect(error.message, 'and the fix').toMatch(/git pull/);
            return true;
          });

        ctx.expect(order, 'the refusal is before the workflow push and before the snapshot').toEqual([]);
      },
    },

    {
      name: 'assertNotBehind: a fetch that fails for any reason but a missing remote or ref REFUSES (#915)',
      run: (ctx) => {
        const { assertNotBehind } = require('../src/deploy.js');
        const fetchFailing = (said) => (args) => {
          if (args[0] === 'fetch') throw Object.assign(new Error('Command failed'), { status: 128, stderr: said });
          return '';
        };

        // A token that cannot read the repo would otherwise deploy as "nothing to be
        // behind", pushing a stale checkout as the snapshot over everything the branch carries.
        ctx.expect(() => assertNotBehind({ cwd: '/brand', branch: 'main', execFn: fetchFailing('fatal: Authentication failed for \'https://github.com/acme/acme-omega.git/\'\n') })).toThrow((error) => {
            ctx.expect(error.message, 'git\'s own words ride the refusal').toMatch(/Authentication failed/);
            ctx.expect(error.message).toMatch(/origin\/main/);
            return true;
          });

        // The two answers that really are nothing to be behind.
        const lines = [];
        assertNotBehind({
          cwd: '/brand',
          branch: 'main',
          logger: { log: (line) => lines.push(line) },
          execFn: fetchFailing('fatal: couldn\'t find remote ref main\n'),
        });
        assertNotBehind({
          cwd: '/brand',
          branch: 'main',
          logger: { log: (line) => lines.push(line) },
          execFn: fetchFailing('fatal: \'origin\' does not appear to be a git repository\n'),
        });

        ctx.expect(lines.length, 'both proceed, each saying so once').toBe(2);
        ctx.expect(lines[0]).toMatch(/nothing to be behind/);
      },
    },

    {
      name: 'deliverLane: a NESTED brand skips the behind check: its git toplevel is someone else\'s repo (#915)',
      run: async (ctx) => {
        const { deliverLane } = require('../src/deploy.js');
        const order = [];
        const lane = { mode: 'snapshot', ref: 'omega-deploy', nested: true, linked: false, repo: true, brandRoot: '/brand' };

        await deliverLane({
          lane,
          owner: 'Omega-JS-Stack',
          repo: 'playground-omega',
          token: 'tok',
          steps: {
            ...laneSteps(order),
            behind: () => order.push('behind'),
            push: () => 'abc1234567890',
            waitRef: async () => order.push('waitRef'),
          },
        });

        ctx.expect(order, 'no behind check ran').toEqual(['origin:/brand', 'lockfile:/brand', 'defaultBranch', 'heal', 'workflows:main', 'waitRef']);
      },
    },

    {
      name: 'deliverLane: a gh-pages default is HEALED before anything is written to it (#922)',
      run: async (ctx) => {
        const { deliverLane } = require('../src/deploy.js');
        const order = [];
        const composed = [];
        const lane = { mode: 'snapshot', ref: 'omega-deploy', nested: true, linked: false, repo: true, brandRoot: '/brand' };

        await deliverLane({
          lane,
          owner: 'acme',
          repo: 'acme-omega',
          token: 'tok',
          steps: {
            lockfile: () => {},
            defaultBranch: async () => { order.push('defaultBranch'); return 'gh-pages'; },
            // The heal takes the name the read returned and answers with the branch
            // the rest of the lane uses: published output is never composed onto.
            heal: async (options) => { order.push(`heal:${options.current}`); return 'main'; },
            workflows: async (options) => {
              composed.push(options.branch);
              order.push(`workflows:${options.branch}`);
              return { pushed: [], sha: null };
            },
            push: () => 'abc1234567890',
            waitRef: async () => order.push('waitRef'),
          },
        });

        ctx.expect(order).toEqual(['defaultBranch', 'heal:gh-pages', 'workflows:main', 'waitRef']);
        ctx.expect(composed, 'the compose commit goes to the healed branch, never to gh-pages').toEqual(['main']);
      },
    },

    {
      name: 'deployViaDispatch: a dry run reports the lane and touches neither git nor the network (#872)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const nested = stageBrandTree({ linked: true });
        const order = [];
        const lines = [];

        try {
          const result = await deployViaDispatch({
            workflow: 'desktop-build.yml',
            owner: 'acme',
            repo: 'acme-omega',
            dir: nested.targetDir,
            dryRun: true,
            execFn: () => `${nested.scratch}\n`,
            fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
            logger: { log: (line) => lines.push(line) },
            steps: {
              ...laneSteps(order),
              stage: async () => { order.push('stage'); return { staged: [], restore: async () => {} }; },
              push: () => order.push('snapshot'),
            },
          });

          ctx.expect(order, 'a dry run runs the read-only origin gate (#934) and no other step, the gh-pages heal included (#922)').toEqual([`origin:${nested.brandRoot}`]);
          ctx.expect(result.dispatched).toBe(false);
          ctx.expect(result.lane.mode).toBe('snapshot');
          ctx.expect(result.plan.body.ref).toBe('omega-deploy');

          // The workflow half of the plan, read off DISK so the preview costs no
          // network call (#915): this fixture composed none, so it says so.
          ctx.expect(lines.some((line) => line.includes('.github/workflows') && line.includes('omega-deploy')), `the dry run names the workflow plan and the branch the folder would go to (got ${JSON.stringify(lines)})`).toBeTruthy();
        } finally {
          fs.rmSync(nested.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'resolveDeployLane: a LINKED brand outside any git repo refuses BY NAME (#872)',
      run: (ctx) => {
        const fs = require('node:fs');
        const { resolveDeployLane } = require('../src/deploy.js');

        // The shape: `omega i local` in a folder nobody ran `git init` in. The lane
        // it would otherwise pick is the snapshot one, which is built out of a git
        // index, so the push would die a step later on a raw
        // `fatal: not a git repository`.
        const loose = stageBrandTree({ linked: true });

        try {
          ctx.expect(() => resolveDeployLane({ dir: loose.targetDir, execFn: () => { throw new Error('fatal: not a git repository'); } })).toThrow((error) => {
              ctx.expect(error.message).toMatch(/a linked brand needs a git repo to snapshot from/);
              ctx.expect(error.message, 'and the two ways out').toMatch(/git init/);
              ctx.expect(error.message).toMatch(/omega i live/);
              return true;
            });
        } finally {
          fs.rmSync(loose.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: a LINKED brand that owns its repo checks it is current, composes, then snapshots (#872, #915)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const linked = stageBrandTree({ linked: true });
        const order = [];
        const steps = {
          ...laneSteps(order),
          stage: async () => { order.push('stage'); return { staged: ['@omega.js/web'], restore: async () => order.push('restore') }; },
          push: (options) => { order.push(`push:${options.ref}`); return 'abc1234567890'; },
          waitRef: async (options) => order.push(`waitRef:${options.ref}@${options.sha}`),
          wait: async () => order.push('wait'),
        };

        try {
          // GitHub registers a workflow from the repo's DEFAULT branch, and the
          // snapshot branch is not it: the composed workflow files reach that branch
          // through the deploy's own data-api commit, and NOTHING else does (#915).
          await deployViaDispatch({
            workflow: 'website-build.yml',
            owner: 'acme',
            repo: 'acme-omega',
            dir: linked.targetDir,
            token: 'tok',
            execFn: (cmd) => (cmd.includes('--show-toplevel') ? `${linked.brandRoot}\n` : 'main\n'),
            fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
            steps,
          });

          ctx.expect(order).toEqual([
            `origin:${linked.brandRoot}`,
            'defaultBranch',
            'heal',
            'behind:main',
            'workflows:main',
            'stage',
            'push:omega-deploy',
            'restore',
            'waitRef:omega-deploy@abc1234567890',
            'wait',
            'dispatch',
          ]);
        } finally {
          fs.rmSync(linked.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: a snapshot the BRAND ROOT already pushed is dispatched against, never pushed again (#901)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const { laneLabel } = require('../src/deploy.js');
        const nested = stageBrandTree({ linked: true });
        const order = [];
        const lines = [];

        try {
          const result = await deployViaDispatch({
            workflow: 'desktop-build.yml',
            owner: 'Omega-JS-Stack',
            repo: 'playground-omega',
            dir: nested.targetDir,
            token: 'tok',
            // The sha the brand-root fan-out put on this lane's ref before it
            // spawned a single target (#901).
            snapshot: 'abc1234567890',
            logger: { log: (line) => lines.push(line) },
            execFn: () => `${nested.scratch}\n`,
            fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
            steps: {
              ...laneSteps(order),
              stage: async () => { order.push('stage'); return { staged: [], restore: async () => order.push('restore') }; },
              push: (options) => order.push(`push:${options.ref}`),
              waitRef: async () => order.push('waitRef'),
              wait: async (options) => order.push(`wait:${options.ref}`),
            },
          });

          ctx.expect(order, 'no compare, no stage, no second push: the wait and the dispatch stay').toEqual(['wait:omega-deploy', 'dispatch']);
          ctx.expect(result.dispatched).toBe(true);
          ctx.expect(result.sha, 'the run\'s snapshot is what this verb prints and follows (#902)').toBe('abc1234567890');
          ctx.expect(result.plan.body.ref, 'the dispatch runs the ref the root snapshot landed on').toBe('omega-deploy');
          ctx.expect(lines.some((line) => line.includes('abc1234')), 'the run says which snapshot it is dispatching against').toBeTruthy();

          // The dispatch line every verb prints carries the same sha, so a fan-out
          // log shows every target running the ONE snapshot.
          ctx.expect(laneLabel(result.lane, 'abc1234567890')).toBe('snapshot lane, ref omega-deploy @ abc1234');
          ctx.expect(laneLabel(result.lane), 'a verb that pushed its own snapshot prints what it always did').toBe('snapshot lane, ref omega-deploy');
        } finally {
          fs.rmSync(nested.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deployViaDispatch: a snapshot sha on a repo-less brand is an ERROR: there is nothing to skip (#901)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const plain = stageBrandTree({ linked: false });
        const order = [];

        try {
          await ctx.expect(deployViaDispatch({
              workflow: 'website-build.yml',
              owner: 'acme',
              repo: 'acme-omega',
              dir: plain.brandRoot,
              token: 'tok',
              snapshot: 'abc1234567890',
              execFn: () => { throw new Error('not a git repository'); },
              fetchFn: async () => { order.push('dispatch'); return { status: 204 }; },
              steps: {
                ...laneSteps(order),
                push: () => order.push('snapshot'),
                wait: () => order.push('wait'),
              },
            })).rejects.toThrow((error) => {
              ctx.expect(error.message).toMatch(/--snapshot/);
              ctx.expect(error.message, 'the refusal names the lane this deploy is actually on').toMatch(/dispatch lane/);
              return true;
            });

          ctx.expect(order, 'the refusal is before any step').toEqual([]);
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deliverLane: the one lane checks, composes, packs, pushes, restores, and returns the sha (#901, #915)',
      run: async (ctx) => {
        const { deliverLane } = require('../src/deploy.js');
        const order = [];
        const lines = [];
        const waited = [];
        const composed = [];
        const lane = { mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: true, repo: true, brandRoot: '/brand' };
        const steps = {
          // A linked lane regenerates its lock in the pack step: no gate (#938)
          lockfile: () => order.push('lockfile'),
          defaultBranch: async (options) => { order.push(`defaultBranch:${options.owner}/${options.repo}`); return 'main'; },
          heal: async (options) => { order.push(`heal:${options.current}`); return options.current; },
          behind: (options) => order.push(`behind:${options.cwd}@${options.branch}`),
          workflows: async (options) => {
            composed.push(options);
            order.push(`workflows:${options.owner}/${options.repo}#${options.branch}`);
            return { pushed: ['web-build.yml'], sha: 'def4567890123' };
          },
          stage: async ({ dir }) => { order.push(`stage:${dir}`); return { staged: ['@omega.js/web'], restore: async () => order.push('restore') }; },
          push: (options) => {
            ctx.expect(options.require, 'the push force-adds the staged tarballs and the lockfile').toEqual(['omega_modules', 'package-lock.json']);
            order.push(`push:${options.owner}/${options.repo}#${options.ref}`);
            return 'abc1234567890';
          },
          // The push is not delivered until GitHub's own ref resolves to it (#902):
          // a dispatch sent in the same second still reads the PREVIOUS commit.
          waitRef: async (options) => {
            waited.push(options);
            order.push(`waitRef:${options.owner}/${options.repo}#${options.ref}`);
          },
          wait: () => order.push('wait'),
        };

        const result = await deliverLane({
          lane,
          owner: 'acme',
          repo: 'acme-omega',
          token: 'tok',
          logger: { log: (line) => lines.push(line) },
          steps,
        });

        ctx.expect(order).toEqual([
          'defaultBranch:acme/acme-omega',
          'heal:main',
          'behind:/brand@main',
          'workflows:acme/acme-omega#main',
          'stage:/brand',
          'push:acme/acme-omega#omega-deploy',
          'restore',
          'waitRef:acme/acme-omega#omega-deploy',
        ]);
        ctx.expect(composed[0].brandRoot, 'the composed workflows are read from the brand folder').toBe('/brand');
        ctx.expect(waited[0].sha, 'it waits for the very sha the push returned').toBe('abc1234567890');
        ctx.expect(result.sha, 'the sha every target of the run dispatches against').toBe('abc1234567890');
        ctx.expect(lines.some((line) => line.includes('Snapshotting /brand')), 'the delivery says what it is sending where').toBeTruthy();
      },
    },

    {
      name: 'deliverLane: a brand outside git delivers NOTHING (#915)',
      run: async (ctx) => {
        const order = [];
        const { deliverLane } = require('../src/deploy.js');
        const lane = { mode: 'dispatch', ref: 'omega-deploy', nested: false, linked: false, repo: false, brandRoot: '/brand' };
        const steps = {
          origin: () => order.push('origin'),
          lockfile: () => order.push('lockfile'),
          defaultBranch: async () => { order.push('defaultBranch'); return 'main'; },
          heal: async () => { order.push('heal'); return 'main'; },
          behind: () => order.push('behind'),
          workflows: async () => order.push('workflows'),
          stage: async () => { order.push('stage'); return { staged: [], restore: async () => {} }; },
          push: () => order.push('snapshot'),
          waitRef: async () => order.push('waitRef'),
          wait: () => order.push('wait'),
        };

        const result = await deliverLane({ lane, logger: { log: () => {} }, steps });
        ctx.expect(order, 'no index to snapshot from: the origin gate alone (the dispatch still acts on the derived repo, #934), and no git error').toEqual(['origin']);
        ctx.expect(result.sha, 'and no snapshot for anyone to dispatch against').toBe(null);
      },
    },

    // ---- #938: the registry lane's lockfile gate

    {
      name: 'deliverLane: the REGISTRY lane gates the brand lockfile first, and a refusal stops before any network step (#938)',
      run: async (ctx) => {
        const { deliverLane } = require('../src/deploy.js');
        const order = [];
        const lane = { mode: 'snapshot', ref: 'omega-deploy', nested: true, linked: false, repo: true, brandRoot: '/brand' };

        await ctx.expect((() => deliverLane({
            lane,
            owner: 'acme',
            repo: 'acme-omega',
            token: 'tok',
            steps: {
              ...laneSteps(order),
              lockfile: (options) => {
                order.push(`lockfile:${options.root}`);
                throw new Error('/brand/package-lock.json disagrees with the manifests; run `omega i live`');
              },
              push: () => order.push('push'),
            },
          }))()).rejects.toThrow(/omega i live/);

        ctx.expect(order, 'no default-branch read, no heal, no workflow push, no snapshot').toEqual(['origin:/brand', 'lockfile:/brand']);
      },
    },

    {
      name: 'deployViaDispatch: a DRY RUN on the registry lane runs the real lockfile gate, and a linked one does not (#938)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const path = require('node:path');
        const plain = stageBrandTree({ linked: false });
        const linked = stageBrandTree({ linked: true });
        const base = {
          workflow: 'web-build.yml',
          owner: 'acme',
          repo: 'acme-omega',
          dryRun: true,
          fetchFn: async () => { throw new Error('a dry run never fetches'); },
        };

        try {
          // No lock at all: the runner's `npm ci` would die, so the plan refuses now.
          await ctx.expect(deployViaDispatch({ ...base, dir: plain.targetDir, execFn: () => `${plain.scratch}\n` })).rejects.toThrow((error) => {
              ctx.expect(error.refusal).toBe(true);
              ctx.expect(error.message).toMatch(/has no package-lock\.json/);
              ctx.expect(error.message).toMatch(/omega i live/);
              return true;
            });

          // The local era's link in the lock: refused by name.
          const lockPath = path.join(plain.brandRoot, 'package-lock.json');
          const lock = (web) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@omega.js/web': web } });
          fs.writeFileSync(lockPath, lock({ resolved: '../../packages/web', link: true }));
          await ctx.expect(deployViaDispatch({ ...base, dir: plain.targetDir, execFn: () => `${plain.scratch}\n` })).rejects.toThrow(/targets\/site: @omega\.js\/web \^0\.1\.0 is locked as a link to \.\.\/\.\.\/packages\/web/);

          // A registry entry satisfying `^0.1.0`: the plan goes through.
          fs.writeFileSync(lockPath, lock({ version: '0.1.4', resolved: 'https://registry.npmjs.org/@omega.js/web/-/web-0.1.4.tgz' }));
          const result = await deployViaDispatch({ ...base, dir: plain.targetDir, execFn: () => `${plain.scratch}\n` });
          ctx.expect(result.dispatched).toBe(false);
          ctx.expect(result.lane.linked).toBe(false);

          // Linked, no lock at all: the pack step writes that lane's lock, so no gate.
          const linkedResult = await deployViaDispatch({ ...base, dir: linked.targetDir, execFn: () => `${linked.scratch}\n` });
          ctx.expect(linkedResult.lane.linked).toBe(true);
          ctx.expect(linkedResult.dispatched).toBe(false);
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
          fs.rmSync(linked.scratch, { recursive: true, force: true });
        }
      },
    },

    // ---- #934: the origin gate

    {
      name: 'deliverLane: an origin that is not the derived source repo REFUSES first, before the lockfile, a read or a push (#934)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const { deliverLane } = require('../src/deploy.js');
        const { assertOriginMatches } = require('../src/git-remote.js');
        const plain = stageBrandTree({ linked: false });
        const order = [];

        // A real checkout whose origin a transfer left behind: the config derives
        // Acme-Org/acme-omega, and the snapshot would be pushed there.
        fs.writeFileSync(path.join(plain.brandRoot, 'config', 'omega.json5'), '{ brand: { id: \'acme\' }, repo: { owner: \'Acme-Org\' } }');
        execFileSync('git', ['-C', plain.brandRoot, 'init', '-q']);
        execFileSync('git', ['-C', plain.brandRoot, 'remote', 'add', 'origin', 'https://github.com/Other-Org/acme-omega.git']);

        try {
          await ctx.expect((() => deliverLane({
              lane: { mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: false, repo: true, brandRoot: plain.brandRoot },
              owner: 'Acme-Org',
              repo: 'acme-omega',
              token: 'tok',
              steps: {
                ...laneSteps(order),
                // The REAL gate, recorded: the steps seam carries the order, git and
                // the config load are real.
                origin: (options) => {
                  order.push('origin');
                  assertOriginMatches({ dir: options.root });
                },
                push: () => order.push('push'),
                waitRef: async () => order.push('waitRef'),
              },
            }))()).rejects.toThrow((error) => {
              ctx.expect(error.message).toBe('origin is Other-Org/acme-omega but config derives Acme-Org/acme-omega: fix repo.owner in config/omega.json5 or move the repo');
              return true;
            });

          ctx.expect(order, 'no lockfile gate, no default-branch read, no workflow push, no snapshot').toEqual(['origin']);
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'deliverLane: the DEFAULT origin step is the real gate: a drifted checkout refuses with no step injected (#934)',
      run: async (ctx) => {
        const fs = require('node:fs');
        const path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const { deliverLane } = require('../src/deploy.js');
        const plain = stageBrandTree({ linked: false });

        fs.writeFileSync(path.join(plain.brandRoot, 'config', 'omega.json5'), '{ brand: { id: \'acme\' }, repo: { owner: \'Acme-Org\' } }');
        execFileSync('git', ['-C', plain.brandRoot, 'init', '-q']);
        execFileSync('git', ['-C', plain.brandRoot, 'remote', 'add', 'origin', 'git@github.com:Acme-Org/acme-site.git']);

        try {
          // No `steps` at all: LANE_STEPS as shipped. Were the origin step not wired
          // to the gate, the real lockfile gate would refuse next (this fixture has
          // no lock), with another message, and nothing here reaches the network.
          await ctx.expect((() => deliverLane({
              lane: { mode: 'snapshot', ref: 'omega-deploy', nested: false, linked: false, repo: true, brandRoot: plain.brandRoot },
              owner: 'Acme-Org',
              repo: 'acme-omega',
              token: 'tok',
            }))()).rejects.toThrow((error) => {
              ctx.expect(error.message).toBe('origin is Acme-Org/acme-site but config derives Acme-Org/acme-omega: fix repo.owner in config/omega.json5 or move the repo');
              return true;
            });
        } finally {
          fs.rmSync(plain.scratch, { recursive: true, force: true });
        }
      },
    },
  ],
});
