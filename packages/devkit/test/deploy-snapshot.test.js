// Unit tests for src/deploy-snapshot.js: the snapshot half of the ONE deploy
// lane ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)).
//
// REAL git against a REAL bare repo in a temp dir, because what is being pinned
// is git's own behavior: a commit whose root is the BRAND FOLDER (never the
// enclosing repo's root), the .gitignore rules that decide what rides, an
// untracked tarball folder that must ride, and a chain of snapshots that only
// ever fast-forwards the mirror. Only the network is injected (the git data
// API the re-root calls, answered from the bare repo itself, and the remote URL,
// rewritten to the bare repo by the injected exec).

const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const jetpack = require('fs-jetpack');
const JSON5 = require('json5');
const { pushSnapshot } = require('../src/deploy-snapshot.js');
const { gitAuthEnv, gitAuthValue, scrubToken } = require('../src/git-auth.js');

const TOKEN = 'ghp_fixture_token';

/** Run a real command, failing loudly with its own output. */
function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8' });
}

/**
 * A monorepo-shaped fixture: an enclosing repo, a brand folder nested inside
 * it, ignored files at both levels, an untracked staging folder, and the bare
 * repo the snapshot is pushed to.
 * @returns {{ base: string, repo: string, brandRoot: string, bare: string }} The fixture.
 */
function buildFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-snapshot-')));
  const repo = path.join(base, 'repo');
  const brandRoot = path.join(repo, 'brands', 'playground');

  jetpack.write(path.join(repo, '.gitignore'), 'node_modules/\n*.log\n');
  jetpack.write(path.join(repo, 'packages', 'framework.js'), '// the enclosing repo, which never rides\n');
  jetpack.write(path.join(brandRoot, 'package.json'), '{ "name": "playground" }\n');
  jetpack.write(path.join(brandRoot, '.gitignore'), 'dist/\n.omega/\n');
  jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// brand source\n');

  run('git', ['init', '-q', '-b', 'main'], repo);
  run('git', ['config', 'user.email', 'snapshot@example.com'], repo);
  run('git', ['config', 'user.name', 'Snapshot Test'], repo);
  run('git', ['add', '-A'], repo);
  run('git', ['commit', '-qm', 'fixture'], repo);

  // After the commit: the files a deploy produces and git has never seen. The
  // staged tarballs and the regenerated lockfile are untracked-not-ignored, so
  // they ride; the ignored ones never do.
  jetpack.write(path.join(brandRoot, 'omega_modules', 'omega.js-liba-1.0.0.tgz'), 'tarball\n');
  jetpack.write(path.join(brandRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
  jetpack.write(path.join(brandRoot, 'debug.log'), 'ignored by the repo root\n');
  jetpack.write(path.join(brandRoot, 'dist', 'out.js'), '// ignored by the brand\n');

  const bare = path.join(base, 'mirror.git');
  run('git', ['init', '-q', '--bare', bare], base);
  // The identity the git data double commits a re-rooted copy under
  run('git', ['config', 'user.email', 'mirror@example.com'], bare);
  run('git', ['config', 'user.name', 'Mirror API'], bare);

  return { base, repo, brandRoot, bare };
}

/**
 * An exec that runs REAL git, with the GitHub remote swapped for the bare repo
 * beside it: the only thing a test cannot have is the network.
 * @param {string} bare - The bare repo standing in for the mirror.
 * @param {Array} calls - Collects every call, for the token assertion.
 * @returns {Function} The exec to inject.
 */
function localRemote(bare, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const rewritten = args.map((arg) => (String(arg).startsWith('https://github.com/') ? bare : arg));
    return execFileSync(file, rewritten, { encoding: 'utf8', ...options });
  };
}

/**
 * GitHub's git data routes for the deploy ref, answered from the bare mirror:
 * the fake IS the server, so a re-root it accepts moves the real ref the real
 * fetch and push then see. `refuse` names the write (`create` or `patch`) that
 * answers a 403 whose body echoes the token; `empty` answers a missing ref with
 * GitHub's 409 for a repo with no commits, in place of the 404; `lag` is how
 * many ref reads after a PATCH still answer the old tip while the real ref has
 * already moved, the way GitHub's replicas trail a write.
 * @param {string} bare - The bare repo standing in for the mirror.
 * @param {{ refuse?: string, empty?: boolean, lag?: number }} [options] - The write to refuse, the empty-repo answer, the stale reads.
 * @returns {{ fetchFn: Function, calls: object[], created: string[] }} The double.
 */
function mirrorApi(bare, { refuse = null, empty = false, lag = 0 } = {}) {
  const calls = [];
  const created = [];
  let stale = null;
  let staleReads = 0;
  const answer = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const refused = () => answer(403, { message: `Resource not accessible by integration (${TOKEN})` });
  const git = (args) => run('git', args, bare).trim();

  const fetchFn = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, route, body });

    const refRead = route.match(/^\/git\/ref\/heads\/(.+)$/);
    if (method === 'GET' && refRead) {
      let sha = null;
      try {
        sha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${refRead[1]}`]);
      } catch {
        return empty ? answer(409, { message: 'Git Repository is empty.' }) : answer(404, { message: 'Not Found' });
      }
      if (staleReads > 0) {
        staleReads -= 1;
        sha = stale;
      }
      return answer(200, { ref: `refs/heads/${refRead[1]}`, object: { type: 'commit', sha } });
    }
    const commitRead = route.match(/^\/git\/commits\/([0-9a-f]{40})$/);
    if (method === 'GET' && commitRead) {
      const [tree, parents = ''] = git(['log', '-1', '--format=%T%n%P', commitRead[1]]).split('\n');
      return answer(200, { sha: commitRead[1], tree: { sha: tree }, parents: parents.split(' ').filter(Boolean).map((sha) => ({ sha })) });
    }
    if (method === 'POST' && route === '/git/commits') {
      if (refuse === 'create') return refused();
      const sha = git(['commit-tree', body.tree, ...body.parents.flatMap((parent) => ['-p', parent]), '-m', body.message]);
      created.push(sha);
      return answer(201, { sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })) });
    }
    const refPatch = route.match(/^\/git\/refs\/heads\/(.+)$/);
    if (method === 'PATCH' && refPatch) {
      if (refuse === 'patch') return refused();
      stale = git(['rev-parse', `refs/heads/${refPatch[1]}`]);
      staleReads = lag;
      git(['update-ref', `refs/heads/${refPatch[1]}`, body.sha]);
      return answer(200, { ref: `refs/heads/${refPatch[1]}`, object: { type: 'commit', sha: body.sha } });
    }

    throw new Error(`the mirror API was asked for ${method} ${route}`);
  };

  return { fetchFn, calls, created };
}

/** A rev resolved in the bare repo: a ref, or `<ref>^` for its parent. */
function revOf(bare, rev) {
  return run('git', ['rev-parse', rev], bare).trim();
}

/** How many commits a ref's history holds. */
function countOf(bare, ref) {
  return run('git', ['rev-list', '--count', ref], bare).trim();
}

/** Whether any recorded push spelled a force, as a flag or a `+` refspec. */
function forcedPush(calls) {
  return calls
    .filter((call) => call.args[0] === 'push')
    .some((call) => call.args.some((arg) => /^(--force|-f$)/.test(String(arg)) || String(arg).startsWith('+')));
}

/** Expect the recorded `verb` call to carry the credential and never the temporary index. */
function expectAuthed(ctx, calls, verb) {
  const call = calls.find((each) => each.args[0] === verb);
  ctx.expect(call.options.env.GIT_CONFIG_VALUE_0, `the ${verb} carries the credential`).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  ctx.expect('GIT_INDEX_FILE' in call.options.env, `the ${verb} carries the temporary index`).toBe(false);
}

/**
 * Push the fixture brand to the bare mirror's `ref`, recording every exec call;
 * `api` is the git data double the re-root talks to.
 */
function pushTo(brandRoot, bare, ref, calls = [], api = mirrorApi(bare)) {
  return pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref, token: TOKEN, execFn: localRemote(bare, calls), fetchFn: api.fetchFn });
}

/** The `METHOD /route` of every call the git data double answered. */
function routesOf(api) {
  return api.calls.map((call) => `${call.method} ${call.route}`);
}

/** The paths a ref's tree carries, sorted. */
function treeOf(bare, ref) {
  return run('git', ['ls-tree', '-r', '--name-only', ref], bare).trim().split('\n').sort();
}

// ─── The staged set rides by force ───

/** Push the fixture brand with the staged set a linked deploy requires. */
function pushStaged(brandRoot, bare, required = ['omega_modules', 'package-lock.json']) {
  return pushSnapshot({
    brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'main', token: TOKEN, require: required, execFn: localRemote(bare, []), fetchFn: mirrorApi(bare).fetchFn,
  });
}

// ─── The resolved company layer (#677) ───

/**
 * Give the fixture brand a company layer and push it under that machine's home.
 * @param {{ base: string, brandRoot: string, bare: string }} fixture - From buildFixture().
 */
async function pushWithCompany({ base, brandRoot, bare }) {
  // A parent brand carrying a company/ tree, plus the machine registry line its
  // own runs write: exactly what the dispatching machine has and a runner lacks.
  const parentRoot = path.join(base, 'parent');
  jetpack.write(path.join(parentRoot, 'config', 'omega.json5'), `{ brand: { id: 'acme-co', name: 'Acme Co', url: 'https://acme.test', images: { wordmark: '/wordmark.png' } }, company: { id: 'self' } }`);
  jetpack.write(path.join(parentRoot, 'company', 'config', 'omega.json5'), `{ monitoring: { providers: { sentry: { org: 'acme-co' } } } }`);
  jetpack.write(path.join(brandRoot, 'config', 'omega.json5'), `{ brand: { id: 'playground', name: 'Playground' }, company: { id: 'acme-co' } }`);

  const home = path.join(base, 'home');
  const previousHome = process.env.OMEGA_HOME;
  process.env.OMEGA_HOME = home;
  jetpack.write(path.join(home, 'brands.json'), JSON.stringify({ 'acme-co': { root: parentRoot, name: 'Acme Co', url: 'https://acme.test' } }));

  try {
    await pushSnapshot({
      brandRoot,
      owner: 'Omega-JS-Stack',
      repo: 'playground-omega',
      ref: 'main',
      token: TOKEN,
      execFn: localRemote(bare, []),
      fetchFn: mirrorApi(bare).fetchFn,
    });
  } finally {
    if (previousHome === undefined) delete process.env.OMEGA_HOME;
    else process.env.OMEGA_HOME = previousHome;
  }
}

// ─── The composed workflows on the default branch (#915) ───
//
// The ONE write a deploy makes outside the deploy branch: GitHub registers a
// workflow from the default branch, so the composed files have to be there, and
// nothing ELSE of the developer's tree ever is. Byte-compared first, written
// through the git DATA api (blobs, tree, commit, ref), so no working tree,
// index or local branch is touched on either side.

/**
 * A brand folder carrying composed workflows and nothing else.
 * @param {object} files - `{ 'web-build.yml': 'contents' }`.
 * @returns {string} The brand root.
 */
function brandWithWorkflows(files) {
  const brandRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-workflows-')));
  for (const [name, content] of Object.entries(files)) {
    jetpack.write(path.join(brandRoot, '.github', 'workflows', name), content);
  }
  return brandRoot;
}

/**
 * GitHub's contents + git-data routes, in memory: what the branch holds, what
 * its head is, and every call made against it.
 *
 * @param {object} options - `held` is the branch's files (`null` per name = a
 *   404), and `head` is its head sha (`null` = an empty repo, which answers the
 *   ref read with GitHub's own 409 `Git Repository is empty.`).
 * @returns {{ fetchFn: Function, calls: object[], written: object }} The double.
 */
function githubDouble({ held = {}, head = 'head0000000000' } = {}) {
  const calls = [];
  const written = { blobs: [], tree: null, commit: null, ref: null };
  const answer = (status, body) => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body || ''),
    statusText: String(status),
  });

  const fetchFn = async (url, init = {}) => {
    const route = url.replace('https://api.github.com/repos/acme/acme-omega', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, route, body });

    // The workflows DIRECTORY lists every file the branch holds there; an empty
    // repo answers the listing with a 404 like any other contents read.
    if (route.split('?')[0] === '/contents/.github/workflows') {
      const listed = Object.keys(held).filter((name) => held[name] !== null && held[name] !== undefined);
      return head
        ? answer(200, listed.map((name) => ({ name, path: `.github/workflows/${name}`, type: 'file' })))
        : answer(404, { message: 'This repository is empty.' });
    }
    if (route.startsWith('/contents/')) {
      const name = route.split('/').pop().split('?')[0];
      return held[name] === undefined || held[name] === null
        ? answer(404, { message: 'Not Found' })
        : answer(200, { content: Buffer.from(held[name]).toString('base64'), sha: `blob-${name}` });
    }
    if (route.startsWith('/git/ref/heads/')) {
      return head ? answer(200, { object: { sha: head } }) : answer(409, { message: 'Git Repository is empty.' });
    }
    if (route.startsWith('/git/commits/')) {
      return answer(200, { tree: { sha: 'tree-of-head' } });
    }
    if (route === '/git/blobs') {
      written.blobs.push(Buffer.from(body.content, 'base64').toString('utf8'));
      return answer(201, { sha: `blob-${written.blobs.length}` });
    }
    if (route === '/git/trees') {
      written.tree = body;
      return answer(201, { sha: 'tree-new' });
    }
    if (route === '/git/commits') {
      written.commit = body;
      return answer(201, { sha: 'commit-new-0000' });
    }
    if (route.startsWith('/git/refs')) {
      written.ref = { method, route, body };
      return answer(method === 'POST' ? 201 : 200, {});
    }

    throw new Error(`the double was asked for ${method} ${route}`);
  };

  return { fetchFn, calls, written };
}

module.exports = defineCases({
  type: 'group',
  description: 'deploy-snapshot',
  tests: [
    {
      name: 'the pushed commit\'s root IS the brand folder, ignored files absent, staged files present',
      run: async (ctx) => {
        const { repo, brandRoot, bare } = buildFixture();
        const calls = [];
        const status = () => run('git', ['status', '--porcelain'], repo);
        const before = status();

        const sha = await pushSnapshot({
          brandRoot,
          owner: 'Omega-JS-Stack',
          repo: 'playground-omega',
          ref: 'main',
          token: TOKEN,
          message: 'chore(deploy): snapshot',
          // What a LINKED brand's deploy staged, and therefore what this push exists
          // to carry (#872)
          require: ['omega_modules', 'package-lock.json'],
          execFn: localRemote(bare, calls),
          fetchFn: mirrorApi(bare).fetchFn,
        });

        ctx.expect(sha, 'the pushed sha comes back').toMatch(/^[0-9a-f]{40}$/);
        ctx.expect(run('git', ['rev-parse', 'main'], bare).trim(), 'the mirror ref points at it').toBe(sha);

        // The brand folder is the ROOT of the pushed tree: no brands/playground prefix
        ctx.expect(treeOf(bare, 'main')).toEqual([
          '.gitignore',
          'omega_modules/omega.js-liba-1.0.0.tgz',
          'package-lock.json',
          'package.json',
          'src/app.js',
        ]);

        // A mirror carries no history of the repo it was cut from
        ctx.expect(run('git', ['rev-list', '--count', 'main'], bare).trim()).toBe('1');

        // Nothing local moved: no branch, no index change, no working-tree change
        ctx.expect(status(), 'the working tree is exactly as it was').toBe(before);
        ctx.expect(run('git', ['branch', '--list'], repo).trim(), 'no snapshot branch was created').toBe('* main');

        // The token travels in the env, never in argv
        for (const call of calls) {
          ctx.expect(call.args.some((arg) => String(arg).includes(TOKEN)), `a ${call.file} argument carried the token`).toBe(false);
        }
        const push = calls.find((call) => call.args[0] === 'push');
        ctx.expect(push.options.env.GIT_CONFIG_VALUE_0, 'the basic form git over https accepts').toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
        expectAuthed(ctx, calls, 'ls-remote');
      },
    },

    // #883: this lane and the web deploy's gh-pages push both push to a repo their
    // checkout is not authenticated for, and each used to spell the delivery and
    // the redaction itself. One helper, so a credential cannot leak out of the lane
    // that forgot a rule the other one kept.
    {
      name: 'git-auth: the credential travels as config env, and a scrub covers both its forms',
      run: (ctx) => {
        ctx.expect(gitAuthEnv(TOKEN)).toEqual({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
        });

        // No token, no half-set config: git asks for credentials itself.
        ctx.expect(gitAuthEnv(null)).toEqual({});
        ctx.expect(gitAuthEnv('')).toEqual({});

        const said = scrubToken(`fatal: https://x-access-token:${TOKEN}@github.com (${gitAuthValue(TOKEN)})`, TOKEN);
        ctx.expect(said.includes(TOKEN), 'the raw token is scrubbed').toBe(false);
        ctx.expect(said.includes(gitAuthValue(TOKEN)), 'and so is the base64 the header carries').toBe(false);
        ctx.expect(scrubToken('fatal: nothing secret here', null), 'no token, nothing to scrub').toBe('fatal: nothing secret here');
      },
    },

    {
      name: 'a failed snapshot push is rethrown with the token scrubbed out of git\'s message',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        const real = localRemote(bare, []);

        const failing = (file, args, options) => {
          if (args[0] === 'push') {
            throw new Error(`Command failed: git push (AUTHORIZATION: basic ${gitAuthValue(TOKEN)}) token=${TOKEN}`);
          }
          return real(file, args, options);
        };

        let thrown = null;
        try {
          await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'main', token: TOKEN, execFn: failing, fetchFn: mirrorApi(bare).fetchFn });
        } catch (error) {
          thrown = error;
        }

        ctx.expect(thrown.message, 'the failure names the mirror it was pushing to').toMatch(/Pushing the snapshot to acme\/acme-omega failed/);
        ctx.expect(thrown.message.includes(TOKEN), 'the raw token never reaches the message').toBe(false);
        ctx.expect(thrown.message.includes(gitAuthValue(TOKEN)), 'and neither does its base64').toBe(false);
      },
    },

    {
      name: 'a second snapshot parents on the first and fast-forwards the mirror, with no force push',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        const calls = [];

        const first = await pushTo(brandRoot, bare, 'main', calls);
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// edited after the first snapshot\n');
        const second = await pushTo(brandRoot, bare, 'main', calls);

        ctx.expect(second, 'a new tree is a new commit').not.toBe(first);
        ctx.expect(revOf(bare, 'main'), 'the mirror moved to it').toBe(second);
        ctx.expect(revOf(bare, 'main^'), 'its parent is the first snapshot').toBe(first);
        ctx.expect(countOf(bare, 'main')).toBe('2');
        ctx.expect(forcedPush(calls), 'a push argv carried a force').toBe(false);
        // Only a chained snapshot fetches: the first found no tip to fetch
        expectAuthed(ctx, calls, 'fetch');
      },
    },

    {
      name: 'a fresh clone holding none of the earlier snapshots still chains on the re-rooted remote tip',
      run: async (ctx) => {
        const { base, repo, brandRoot, bare } = buildFixture();
        await pushTo(brandRoot, bare, 'omega-deploy');
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// edited after the first snapshot\n');
        const tip = await pushTo(brandRoot, bare, 'omega-deploy');

        // --no-local clones over the transport, so only reachable objects arrive
        const clone = path.join(base, 'clone');
        run('git', ['clone', '-q', '--no-local', repo, clone], base);
        run('git', ['config', 'user.email', 'snapshot@example.com'], clone);
        run('git', ['config', 'user.name', 'Snapshot Test'], clone);
        const cloneBrand = path.join(clone, 'brands', 'playground');
        let held = true;
        try {
          execFileSync('git', ['cat-file', '-e', tip], { cwd: clone, stdio: 'ignore' });
        } catch {
          held = false;
        }
        ctx.expect(held, 'the clone already held the remote tip').toBe(false);

        const api = mirrorApi(bare);
        const third = await pushTo(cloneBrand, bare, 'omega-deploy', [], api);

        ctx.expect(revOf(bare, 'omega-deploy'), 'the mirror moved to it').toBe(third);
        ctx.expect(revOf(bare, 'omega-deploy^'), 'its parent is the root the re-root created').toBe(api.created[0]);
        ctx.expect(revOf(bare, 'omega-deploy^^{tree}'), 'a root carrying the remote tip\'s tree').toBe(revOf(bare, `${tip}^{tree}`));
        ctx.expect(countOf(bare, 'omega-deploy')).toBe('2');
        ctx.expect(treeOf(bare, 'omega-deploy'), 'the clone\'s brand folder is the root').toEqual(['.gitignore', 'package.json', 'src/app.js']);
      },
    },

    {
      name: 'a tip left by an older parentless snapshot becomes the next snapshot\'s parent',
      run: async (ctx) => {
        const { base, brandRoot, bare } = buildFixture();

        // The old lane's commit, built inside the mirror by hand, so the
        // developer's repo has never held it.
        const env = { ...process.env, GIT_INDEX_FILE: path.join(base, 'old-snapshot.index') };
        const inBare = (args) => execFileSync('git', ['--git-dir', bare, '--work-tree', brandRoot, ...args], { cwd: brandRoot, encoding: 'utf8', env }).trim();
        run('git', ['config', 'user.email', 'snapshot@example.com'], bare);
        run('git', ['config', 'user.name', 'Snapshot Test'], bare);
        inBare(['add', '-A']);
        const old = inBare(['commit-tree', inBare(['write-tree']), '-m', 'chore(deploy): snapshot']);
        inBare(['update-ref', 'refs/heads/omega-deploy', old]);

        const calls = [];
        const api = mirrorApi(bare);
        const next = await pushTo(brandRoot, bare, 'omega-deploy', calls, api);

        // A parentless tip is already a root: read, never rewritten
        ctx.expect(routesOf(api)).toEqual(['GET /git/ref/heads/omega-deploy', `GET /git/commits/${old}`]);
        ctx.expect(revOf(bare, 'omega-deploy'), 'the mirror moved to it').toBe(next);
        ctx.expect(revOf(bare, 'omega-deploy^'), 'its parent is the old parentless tip').toBe(old);
        ctx.expect(countOf(bare, 'omega-deploy')).toBe('2');
        ctx.expect(forcedPush(calls), 'a push argv carried a force').toBe(false);
      },
    },

    {
      name: 'a remote tip with a parent is re-rooted on its own tree server-side, and the snapshot chains on that root, unforced (#1147)',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        const first = await pushTo(brandRoot, bare, 'omega-deploy');
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the second snapshot\n');
        const tip = await pushTo(brandRoot, bare, 'omega-deploy');
        ctx.expect(revOf(bare, 'omega-deploy^'), 'the fixture tip has a parent').toBe(first);
        const tipTree = revOf(bare, `${tip}^{tree}`);

        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the third snapshot\n');
        const calls = [];
        const api = mirrorApi(bare);
        const next = await pushTo(brandRoot, bare, 'omega-deploy', calls, api);

        ctx.expect(routesOf(api)).toEqual([
          'GET /git/ref/heads/omega-deploy',
          `GET /git/commits/${tip}`,
          'POST /git/commits',
          'PATCH /git/refs/heads/omega-deploy',
          // A ref that already answers the root takes one confirming read
          'GET /git/ref/heads/omega-deploy',
        ]);
        const create = api.calls[2].body;
        ctx.expect(create.parents, 'the root has no parent').toEqual([]);
        ctx.expect(create.tree, 'and the tip\'s own tree: no bytes move').toBe(tipTree);
        ctx.expect(api.calls[3].body, 'the ref is forced onto the root').toEqual({ sha: api.created[0], force: true });

        ctx.expect(revOf(bare, 'omega-deploy'), 'the mirror moved to the new snapshot').toBe(next);
        ctx.expect(revOf(bare, 'omega-deploy^'), 'its parent is the created root').toBe(api.created[0]);
        ctx.expect(countOf(bare, 'omega-deploy'), 'the ref holds the root and the new snapshot').toBe('2');
        ctx.expect(forcedPush(calls), 'a push argv carried a force').toBe(false);
      },
    },

    {
      name: 'no deploy ref on the mirror (a 404, or an empty repo\'s 409): the re-root writes nothing, and the first snapshot is parentless (#1147)',
      run: async (ctx) => {
        for (const [answered, empty] of [['404', false], ['409', true]]) {
          const { brandRoot, bare } = buildFixture();
          const api = mirrorApi(bare, { empty });

          const sha = await pushTo(brandRoot, bare, 'omega-deploy', [], api);

          ctx.expect(routesOf(api), `one ref read, answered ${answered}, and no write`).toEqual(['GET /git/ref/heads/omega-deploy']);
          ctx.expect(revOf(bare, 'omega-deploy'), `the push after the ${answered} landed`).toBe(sha);
          ctx.expect(countOf(bare, 'omega-deploy'), `with no parent after the ${answered}`).toBe('1');
        }
      },
    },

    {
      name: 'a re-root write GitHub refuses rejects naming the step, token scrubbed, and pushes nothing (#1147)',
      run: async (ctx) => {
        const said = {};
        for (const [step, named] of [['create', /commit/i], ['patch', /ref/i]]) {
          const { brandRoot, bare } = buildFixture();
          await pushTo(brandRoot, bare, 'omega-deploy');
          jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the second snapshot\n');
          const tip = await pushTo(brandRoot, bare, 'omega-deploy');

          const calls = [];
          await ctx.expect(pushTo(brandRoot, bare, 'omega-deploy', calls, mirrorApi(bare, { refuse: step }))).rejects.toThrow((error) => {
            said[step] = error.message;
            ctx.expect(error.message, `the refused ${step} is named`).toMatch(named);
            ctx.expect(error.message.includes(TOKEN), `the raw token never reaches the ${step} message`).toBe(false);
            return true;
          });

          ctx.expect(calls.some((call) => call.args[0] === 'push'), `a push ran after the refused ${step}`).toBe(false);
          ctx.expect(revOf(bare, 'omega-deploy'), `the ref still holds the tip after the refused ${step}`).toBe(tip);
        }
        ctx.expect(said.create, 'each refusal names its own step').not.toBe(said.patch);
      },
    },

    {
      name: 'a ref read that trails the re-root is polled until it answers the root, and only then fetched (#1147)',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        await pushTo(brandRoot, bare, 'omega-deploy');
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the second snapshot\n');
        await pushTo(brandRoot, bare, 'omega-deploy');

        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the third snapshot\n');
        const api = mirrorApi(bare, { lag: 2 });
        const real = localRemote(bare, []);
        // The git calls join the API log, so the order of the two is one list
        const execFn = (file, args, options) => {
          api.calls.push({ method: 'git', route: args[0] });
          return real(file, args, options);
        };
        const next = await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'omega-deploy', token: TOKEN, execFn, fetchFn: api.fetchFn, refWait: { delayMs: 0 } });

        const routes = routesOf(api);
        const between = routes.slice(routes.indexOf('PATCH /git/refs/heads/omega-deploy'), routes.indexOf('git fetch'));
        ctx.expect(routes.includes('git fetch'), 'the root was fetched').toBe(true);
        ctx.expect(between.filter((route) => route === 'GET /git/ref/heads/omega-deploy').length >= 3, `two stale reads and the one that answers the root, before the fetch (got ${JSON.stringify(routes)})`).toBe(true);
        ctx.expect(revOf(bare, 'omega-deploy'), 'the mirror moved to the new snapshot').toBe(next);
        ctx.expect(revOf(bare, 'omega-deploy^'), 'its parent is the created root').toBe(api.created[0]);
        ctx.expect(countOf(bare, 'omega-deploy')).toBe('2');
      },
    },

    {
      name: 'a ref that never answers the re-rooted root rejects naming the ref and the root it waited for, and pushes nothing (#1147)',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        await pushTo(brandRoot, bare, 'omega-deploy');
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// the second snapshot\n');
        await pushTo(brandRoot, bare, 'omega-deploy');
        const api = mirrorApi(bare, { lag: Infinity });
        const calls = [];

        await ctx.expect(pushSnapshot({
          brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'omega-deploy', token: TOKEN,
          execFn: localRemote(bare, calls), fetchFn: api.fetchFn, refWait: { attempts: 3, delayMs: 0 },
        })).rejects.toThrow((error) => {
          ctx.expect(error.message, 'the ref it waited on').toMatch(/acme\/acme-omega#omega-deploy/);
          ctx.expect(error.message.includes(api.created[0].slice(0, 7)), `the root it waited for (got ${error.message})`).toBe(true);
          ctx.expect(error.message.includes(TOKEN), 'the raw token never reaches the message').toBe(false);
          return true;
        });

        ctx.expect(calls.some((call) => call.args[0] === 'push'), 'a push ran after the wait ran out').toBe(false);
      },
    },

    {
      name: 'an unchanged brand still lands a new snapshot and returns its sha',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();

        const first = await pushTo(brandRoot, bare, 'main');
        const second = await pushTo(brandRoot, bare, 'main');

        ctx.expect(second, 'the same tree is still a new commit').not.toBe(first);
        ctx.expect(revOf(bare, 'main'), 'the returned sha is the one that landed').toBe(second);
        ctx.expect(revOf(bare, 'main^'), 'chained on the first').toBe(first);
      },
    },

    {
      name: 'a ref moved between the tip read and the push fails naming the mirror, and the foreign commit stands',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        const first = await pushTo(brandRoot, bare, 'main');
        jetpack.write(path.join(brandRoot, 'src', 'app.js'), '// edited after the first snapshot\n');

        // A concurrent deploy lands its own commit on the ref right before this push
        run('git', ['config', 'user.email', 'other@example.com'], bare);
        run('git', ['config', 'user.name', 'Other Deploy'], bare);
        const real = localRemote(bare, []);
        let foreign = null;
        const racing = (file, args, options) => {
          if (args[0] === 'push') {
            foreign = run('git', ['commit-tree', `${first}^{tree}`, '-p', first, '-m', 'foreign'], bare).trim();
            run('git', ['update-ref', 'refs/heads/main', foreign], bare);
          }
          return real(file, args, options);
        };

        let thrown = null;
        try {
          await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'main', token: TOKEN, execFn: racing, fetchFn: mirrorApi(bare).fetchFn });
        } catch (error) {
          thrown = error;
        }

        ctx.expect(thrown && thrown.message, 'the push failed naming the mirror').toMatch(/Pushing the snapshot to acme\/acme-omega failed/);
        ctx.expect(thrown.message.includes(TOKEN), 'the raw token never reaches the message').toBe(false);
        ctx.expect(thrown.message.includes(gitAuthValue(TOKEN)), 'and neither does its base64').toBe(false);
        ctx.expect(revOf(bare, 'main'), 'the concurrent deploy\'s commit was not overwritten').toBe(foreign);
      },
    },

    {
      name: 'chained pushes leave the developer\'s tree, index, branches and refs exactly as they were',
      run: async (ctx) => {
        const { repo, brandRoot, bare } = buildFixture();
        const state = () => ({
          status: run('git', ['status', '--porcelain'], repo),
          index: run('git', ['ls-files', '--stage'], repo),
          branches: run('git', ['branch', '--list'], repo),
          refs: run('git', ['for-each-ref'], repo),
        });
        const before = state();

        await pushTo(brandRoot, bare, 'omega-deploy');
        await pushTo(brandRoot, bare, 'omega-deploy');

        ctx.expect(state()).toEqual(before);
      },
    },

    {
      name: 'a tip read that fails for any reason but a missing ref is rethrown naming the mirror, token scrubbed',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        const real = localRemote(bare, []);

        const failing = (file, args, options) => {
          if (args[0] === 'ls-remote') {
            throw new Error(`Command failed: git ls-remote (AUTHORIZATION: basic ${gitAuthValue(TOKEN)}) token=${TOKEN}`);
          }
          return real(file, args, options);
        };

        let thrown = null;
        try {
          await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'main', token: TOKEN, execFn: failing, fetchFn: mirrorApi(bare).fetchFn });
        } catch (error) {
          thrown = error;
        }

        ctx.expect(thrown && thrown.message, 'the failure names the mirror and ref it was reading').toMatch(/Reading acme\/acme-omega#main failed/);
        ctx.expect(thrown.message.includes(TOKEN), 'the raw token never reaches the message').toBe(false);
        ctx.expect(thrown.message.includes(gitAuthValue(TOKEN)), 'and neither does its base64').toBe(false);
      },
    },

    {
      name: 'a brand that IS its own repo snapshots its whole tree',
      run: async (ctx) => {
        const { repo, bare } = buildFixture();

        const sha = await pushSnapshot({
          brandRoot: repo, owner: 'acme', repo: 'acme-omega', ref: 'omega-deploy', token: TOKEN, execFn: localRemote(bare, []), fetchFn: mirrorApi(bare).fetchFn,
        });

        ctx.expect(run('git', ['rev-parse', 'omega-deploy'], bare).trim(), 'the snapshot branch carries it').toBe(sha);
        ctx.expect(treeOf(bare, 'omega-deploy')).toEqual([
          '.gitignore',
          'brands/playground/.gitignore',
          'brands/playground/omega_modules/omega.js-liba-1.0.0.tgz',
          'brands/playground/package-lock.json',
          'brands/playground/package.json',
          'brands/playground/src/app.js',
          'packages/framework.js',
        ]);
      },
    },

    {
      name: 'the pushed tree holds the tracked brandmark and no path under .omega/, a full manager mint on disk included',
      run: async (ctx) => {
        const { repo, brandRoot, bare } = buildFixture();
        jetpack.write(path.join(brandRoot, 'assets', 'logo', 'brandmark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
        run('git', ['add', '-A'], repo);
        run('git', ['commit', '-qm', 'brandmark'], repo);

        // What the manager's assets service leaves in the ignored folder; none of it is a build input
        for (const relative of [
          'assets/favicon/favicon.ico',
          'assets/favicon/site.webmanifest',
          'assets/logo/brandmark/color-x.svg',
          'assets/logo/brandmark/color-512.png',
          'assets/social/brandmark/color-1024.png',
          'state.json',
        ]) {
          jetpack.write(path.join(brandRoot, '.omega', relative), 'minted\n');
        }

        await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'omega-deploy', token: TOKEN, execFn: localRemote(bare, []), fetchFn: mirrorApi(bare).fetchFn });

        const tree = treeOf(bare, 'omega-deploy');
        ctx.expect(tree.includes('assets/logo/brandmark.svg'), 'the brandmark rides as a tracked file').toBeTruthy();
        ctx.expect(tree.filter((file) => file.startsWith('.omega/'))).toEqual([]);
      },
    },

    {
      name: 'a brand whose own ignore rules hide the staged tarballs and lockfile still pushes them',
      run: async (ctx) => {
        const { repo, brandRoot, bare } = buildFixture();
        jetpack.write(path.join(brandRoot, '.gitignore'), 'dist/\nomega_modules/\npackage-lock.json\n');
        const status = () => run('git', ['status', '--porcelain'], repo);
        const before = status();

        const sha = await pushStaged(brandRoot, bare);

        ctx.expect(run('git', ['rev-parse', 'main'], bare).trim(), 'the push landed').toBe(sha);
        const tree = treeOf(bare, 'main');
        ctx.expect(tree.includes('omega_modules/omega.js-liba-1.0.0.tgz'), 'the staged tarball rode').toBeTruthy();
        ctx.expect(tree.includes('package-lock.json'), 'and the regenerated lockfile').toBeTruthy();
        ctx.expect(status(), 'the forced adds stayed in the temporary index').toBe(before);
      },
    },

    {
      name: 'a nested brand whose enclosing repo ignores *.tgz still pushes its staged tarballs',
      run: async (ctx) => {
        const { repo, brandRoot, bare } = buildFixture();
        // A file pattern the brand inherits from the repo around it, never its own
        jetpack.append(path.join(repo, '.gitignore'), '*.tgz\n');

        await pushStaged(brandRoot, bare);

        ctx.expect(treeOf(bare, 'main').includes('omega_modules/omega.js-liba-1.0.0.tgz'), 'the staged tarball rode').toBeTruthy();
      },
    },

    {
      name: 'a required path that does not exist is skipped, and the push still lands',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        jetpack.write(path.join(brandRoot, '.gitignore'), 'dist/\nomega_modules/\npackage-lock.json\n');
        jetpack.remove(path.join(brandRoot, 'package-lock.json'));

        const sha = await pushStaged(brandRoot, bare);

        ctx.expect(run('git', ['rev-parse', 'main'], bare).trim(), 'the push landed').toBe(sha);
        const tree = treeOf(bare, 'main');
        ctx.expect(tree.includes('package-lock.json'), 'the tree simply lacks the missing path').toBe(false);
        ctx.expect(tree.includes('omega_modules/omega.js-liba-1.0.0.tgz'), 'and the present one still rode').toBeTruthy();
      },
    },

    {
      name: 'an ignored file nobody required stays home',
      run: async (ctx) => {
        const { brandRoot, bare } = buildFixture();
        jetpack.write(path.join(brandRoot, '.gitignore'), 'dist/\nomega_modules/\nsecret.txt\n');
        jetpack.write(path.join(brandRoot, 'secret.txt'), 'never rides\n');

        await pushStaged(brandRoot, bare);

        const tree = treeOf(bare, 'main');
        ctx.expect(tree.includes('secret.txt'), 'the brand\'s own ignore rule still decides').toBe(false);
        ctx.expect(tree.includes('dist/out.js'), 'and so does every other one').toBe(false);
        ctx.expect(tree.includes('omega_modules/omega.js-liba-1.0.0.tgz'), 'beside the forced staged set').toBeTruthy();
      },
    },

    {
      name: 'the resolved company layer is generated for the push and gone after it',
      run: async (ctx) => {
        const fixture = buildFixture();
        const { repo, brandRoot, bare } = fixture;

        await pushWithCompany(fixture);

        // It rode the mirror...
        ctx.expect(treeOf(bare, 'main').includes('config/company-resolved.json5'), 'the runner receives what this machine resolved').toBeTruthy();

        const carried = JSON5.parse(run('git', ['show', 'main:config/company-resolved.json5'], bare));
        // `webhooks` rides too (#677): the runner's readers need the brand's opt-out
        // statement as much as its public facts.
        ctx.expect(carried.company).toEqual({ id: 'acme-co', name: 'Acme Co', url: 'https://acme.test', images: { wordmark: '/wordmark.png' }, webhooks: true });
        ctx.expect(carried.config.monitoring.providers.sentry.org, 'the company CONFIG layer rides too').toBe('acme-co');

        // ...and the developer's tree is clean again.
        ctx.expect(jetpack.exists(path.join(brandRoot, 'config', 'company-resolved.json5'))).toBe(false);
        ctx.expect(run('git', ['status', '--porcelain'], repo).includes('company-resolved')).toBe(false);
      },
    },

    {
      name: 'the resolved company layer rides even when an ignore rule hides it',
      run: async (ctx) => {
        const fixture = buildFixture();
        jetpack.append(path.join(fixture.brandRoot, '.gitignore'), 'config/company-resolved.json5\n');

        await pushWithCompany(fixture);

        ctx.expect(treeOf(fixture.bare, 'main').includes('config/company-resolved.json5'), 'the runner still receives what this machine resolved').toBeTruthy();
      },
    },

    {
      name: 'a brand with no company generates nothing',
      run: async (ctx) => {
        const { base, brandRoot, bare } = buildFixture();
        jetpack.write(path.join(brandRoot, 'config', 'omega.json5'), `{ brand: { id: 'playground', name: 'Playground' } }`);

        const previousHome = process.env.OMEGA_HOME;
        process.env.OMEGA_HOME = path.join(base, 'home');

        try {
          await pushSnapshot({ brandRoot, owner: 'acme', repo: 'acme-omega', ref: 'main', token: TOKEN, execFn: localRemote(bare, []), fetchFn: mirrorApi(bare).fetchFn });
        } finally {
          if (previousHome === undefined) delete process.env.OMEGA_HOME;
          else process.env.OMEGA_HOME = previousHome;
        }

        ctx.expect(treeOf(bare, 'main').includes('config/company-resolved.json5')).toBe(false);
      },
    },

    {
      name: 'pushWorkflowFiles: every file already matches, so the default branch is NOT touched (#915)',
      run: async (ctx) => {
        const { pushWorkflowFiles } = require('../src/deploy-snapshot.js');
        const brandRoot = brandWithWorkflows({ 'web-build.yml': 'name: web\n', 'backend-deploy.yml': 'name: backend\n' });
        const lines = [];
        const github = githubDouble({ held: { 'web-build.yml': 'name: web\n', 'backend-deploy.yml': 'name: backend\n' } });

        const result = await pushWorkflowFiles({
          brandRoot,
          owner: 'acme',
          repo: 'acme-omega',
          branch: 'main',
          token: TOKEN,
          fetchFn: github.fetchFn,
          logger: { log: (line) => lines.push(line) },
        });

        ctx.expect(result.pushed, 'nothing was written').toEqual([]);
        ctx.expect(github.calls.every((call) => call.method === 'GET'), 'the branch was READ and nothing more').toBe(true);
        ctx.expect(lines.length, 'one line says so').toBe(1);
        ctx.expect(lines[0]).toMatch(/already carries/);

        fs.rmSync(brandRoot, { recursive: true, force: true });
      },
    },

    {
      name: 'pushWorkflowFiles: one missing and one changed ride ONE conventional commit (#915)',
      run: async (ctx) => {
        const { pushWorkflowFiles } = require('../src/deploy-snapshot.js');
        const brandRoot = brandWithWorkflows({
          'backend-deploy.yml': 'name: backend\n',
          'desktop-build.yml': 'name: desktop v2\n',
          'web-build.yml': 'name: web\n',
        });
        // backend matches, desktop differs, web is not there at all.
        const github = githubDouble({
          held: { 'backend-deploy.yml': 'name: backend\n', 'desktop-build.yml': 'name: desktop\n', 'web-build.yml': null },
        });

        const result = await pushWorkflowFiles({
          brandRoot, owner: 'acme', repo: 'acme-omega', branch: 'main', token: TOKEN, fetchFn: github.fetchFn,
        });

        ctx.expect(result.pushed, 'exactly the two that differ').toEqual(['desktop-build.yml', 'web-build.yml']);
        ctx.expect(github.written.blobs, 'and only their bytes became blobs').toEqual(['name: desktop v2\n', 'name: web\n']);
        ctx.expect(github.written.tree.tree.map((entry) => entry.path)).toEqual([
          '.github/workflows/desktop-build.yml',
          '.github/workflows/web-build.yml',
        ]);
        ctx.expect(github.written.tree.base_tree, 'on top of the branch\'s own tree: nothing else changes').toBe('tree-of-head');
        ctx.expect(github.written.commit.message).toBe('chore(ci): compose desktop-build.yml, web-build.yml');
        ctx.expect(github.written.commit.parents, 'a commit on the branch\'s head, never a rewrite of it').toEqual(['head0000000000']);
        ctx.expect(github.written.ref).toEqual({
          method: 'PATCH',
          route: '/git/refs/heads/main',
          body: { sha: 'commit-new-0000' },
        });
      },
    },

    {
      name: 'pushWorkflowFiles: an EMPTY repo gets a parentless commit and a created ref (#915)',
      run: async (ctx) => {
        const { pushWorkflowFiles } = require('../src/deploy-snapshot.js');
        const brandRoot = brandWithWorkflows({ 'web-build.yml': 'name: web\n' });
        const github = githubDouble({ held: {}, head: null });

        const result = await pushWorkflowFiles({
          brandRoot, owner: 'acme', repo: 'acme-omega', branch: 'main', token: TOKEN, fetchFn: github.fetchFn,
        });

        ctx.expect(result.pushed).toEqual(['web-build.yml']);
        ctx.expect(github.written.tree.base_tree, 'there is no tree to build on').toBe(undefined);
        ctx.expect(github.written.commit.parents, 'and no head to parent it to').toEqual([]);
        ctx.expect(github.written.ref).toEqual({
          method: 'POST',
          route: '/git/refs',
          body: { ref: 'refs/heads/main', sha: 'commit-new-0000' },
        });

        fs.rmSync(brandRoot, { recursive: true, force: true });
      },
    },

    {
      name: 'pushWorkflowFiles: a RETIRED composed file leaves in the same commit, a hand-written one stays (#932)',
      run: async (ctx) => {
        const { pushWorkflowFiles } = require('../src/deploy-snapshot.js');
        const webHeader = '# GENERATED by the targets/web framework scaffold \u2014 do not edit.\n';
        const websiteHeader = '# GENERATED by the targets/website framework scaffold \u2014 do not edit.\n';
        const brandRoot = brandWithWorkflows({ 'web-build.yml': `${webHeader}name: web v2\n` });
        // The rename left website-build.yml behind; release.yml is the brand's own.
        const github = githubDouble({
          held: {
            'release.yml': 'name: release\n',
            'web-build.yml': `${webHeader}name: web\n`,
            'website-build.yml': `${websiteHeader}name: website\n`,
          },
        });

        const result = await pushWorkflowFiles({
          brandRoot, owner: 'acme', repo: 'acme-omega', branch: 'main', token: TOKEN, fetchFn: github.fetchFn,
        });

        ctx.expect(result.pushed).toEqual(['web-build.yml']);
        ctx.expect(result.removed, 'the retired composed file, and only it').toEqual(['website-build.yml']);
        ctx.expect(github.written.tree.tree, 'a null sha deletes the file; release.yml is never in the tree').toEqual([
          { path: '.github/workflows/web-build.yml', mode: '100644', type: 'blob', sha: 'blob-1' },
          { path: '.github/workflows/website-build.yml', mode: '100644', type: 'blob', sha: null },
        ]);
        ctx.expect(github.written.tree.base_tree).toBe('tree-of-head');
        ctx.expect(github.written.commit.message).toBe('chore(ci): compose web-build.yml, retire website-build.yml');
        ctx.expect(github.written.ref).toEqual({
          method: 'PATCH',
          route: '/git/refs/heads/main',
          body: { sha: 'commit-new-0000' },
        });

        fs.rmSync(brandRoot, { recursive: true, force: true });
      },
    },
  ],
});
