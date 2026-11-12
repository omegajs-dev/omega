// Vendors private @omega.js workspace packages (devkit, account, ...) into a
// framework's dist/ so published tarballs are self-contained (the shared packages
// never ship to npm).
//
// Wired as the framework's prepare-package `after` hook:
//   "preparePackage": { "hooks": { "after": "node -e \"require('@omega.js/devkit/vendor')()\"" } }
//
// From the framework's cwd it:
//   1. Scans dist/ for references to @omega.js packages — CommonJS (require,
//      require.resolve) AND ESM (import ... from, export ... from, dynamic
//      import(), side-effect import) — @omega.js/client's dist is ESM. Real host
//      files only: symlinks are never followed and node_modules never entered
//      (@omega.js/backend's dist carries a self-test fixture with a circular self-link)
//   2. Copies ONLY the referenced modules (plus their transitive relative
//      requires/imports) into <dist>/vendor/<package>/ — selective, so a host
//      that uses just safe-install doesn't ship the test runner or inherit its
//      dependency requirements. The closure covers the vendored modules' OWN
//      cross-package requires too (#739): devkit's license.js requires
//      @omega.js/config and @omega.js/account, so both land beside it even
//      when the host references neither
//   3. Rewrites every @omega.js specifier under dist/ to a relative path into
//      the matching vendor dir — host files and the vendored trees alike, so a
//      vendored module reaches its siblings by path (../config/index.js) and a
//      published tarball needs none of the private packages present
//   4. Fails if the host doesn't declare a runtime dependency the vendored modules
//      require — vendored code resolves e.g. chalk from the HOST's node_modules
//
// Package convention: every vendorable package's entry is <root>/src/index.js and
// subpath exports live beside it ('@omega.js/x/foo' → src/foo.js) — the entry's
// directory is the module root, resolved via require.resolve of the bare name.
//
// Non-JS assets (C4): a host can also declare `omega.vendorAssets` in its
// package.json — [{ package, from, to }] — and each source (a file or dir,
// package-root-relative) is copied to the dist-relative `to` on every run.
// This is the cross-target channel for sass sheets/templates that JS
// reference-scanning can't see (e.g. desktop/extension vendoring the web
// package's --omega-* token sheet). Same freshness contract as module
// vendoring: re-copied from the resolved source on every prepare.
//
// Docs: the same hook also vendors KNOWLEDGE. tools/vendor-docs.js copies the
// monorepo's docs/ tree and the Claude plugin into @omega.js/manager, so a
// brand carries docs that match its version. One lane, two payloads.
//
// Notes:
//   - prepare-package `after` hooks are non-blocking AT THE RUNNER (a failure
//     warns but doesn't stop prepare — third-party prepare-package behavior).
//     This tool is therefore TRANSACTIONAL: the dep guard runs before any dist
//     file is touched, rewrites are computed fully in memory and written last,
//     and a mid-write failure restores every file already written — a failed
//     run never leaves a part-rewritten dist. The hard gate is CI's
//     pack→scratch-install smoke plus its "no @omega.js refs in shipped dist"
//     check.
//   - It never CLEARS a vendor dir the dist already imports from (#393). A
//     prepare wipes the whole output dir before this hook, so a vendor dir
//     present at scan time can only be a standalone re-run against an
//     already-vendored dist. Two shapes, both safe: a fully-rewritten dist (zero
//     seeds) is recognized and left exactly as it is, and a MIXED dist (some
//     seeds) is vendored OVER THE TOP — the existing modules stay put.
//   - Watch mode's single-file copies skip hooks, so a freshly-saved file can hold
//     a raw @omega.js specifier in dist — the mixed dist above. That's fine wherever
//     dist is consumed from the monorepo (workspace + file: installs resolve the
//     packages up the tree); a full prepare (npm install / pack / publish) always
//     re-runs the rewrite.

const fs = require('fs');
const path = require('path');
const { isBuiltin } = require('node:module');
const jetpack = require('fs-jetpack');
const vendorDocs = require('./vendor-docs');
const Logger = require('../src/logger');
const { resolvePackageDir } = require('../src/local');
const { bareSpecifiers, packageName, stripComments } = require('../src/load-forms');

const logger = new Logger('devkit-vendor');

// Specifier body shared by every reference pattern: package name + optional subpath.
const SPECIFIER = '@omega\\.js\\/([a-z0-9-]+)(?:\\/([A-Za-z0-9._/-]+))?';

// The private workspace utility packages vendoring exists FOR (never published;
// hosts wire them as devDependencies). A dist reference to any OTHER @omega.js
// package is an error unless it's a declared runtime dependency: publishable
// packages (web, client, backend, ...) are never folded into a host's dist.
const VENDORABLE_PACKAGES = ['devkit', 'config', 'account', 'template-kit', 'analytics', 'monitoring'];

// The ways dist code can reference an @omega.js package: the one home of the
// reference shape, which the rewrite and every self-containment reader derive.
const REFERENCE_PREFIXES = [
  'require(?:\\.resolve)?\\(\\s*', // require / require.resolve
  'from\\s+',                     // import|export ... from
  'import\\s*\\(\\s*',             // dynamic import()
  'import\\s+',                   // side-effect import
];

// Each pattern captures: 1 = prefix (kept verbatim on rewrite), 2 = quote,
// 3 = package name, 4 = subpath. The match ends at the closing quote, so
// trailing syntax (`)`, `;`) is untouched.
const REFERENCE_PATTERNS = REFERENCE_PREFIXES.map((prefix) => new RegExp(`(${prefix})(['"])${SPECIFIER}\\2`, 'g'));

// A raw reference to a vendorable, the self-containment gates' one shape: it
// surviving into a shipped tree is a broken install, those packages never being
// published. Match whole file contents, never lines (`from` may end a line).
const PRIVATE_REFERENCE = new RegExp(
  `(?:${REFERENCE_PREFIXES.join('|')})['"]@omega\\.js\\/(${VENDORABLE_PACKAGES.join('|')})(?:['"/])`,
);

// Matches relative requires/imports: the walk of package-internal dependencies.
// Group 2 = the relative path in every pattern.
const RELATIVE_PATTERNS = [
  /require(?:\.resolve)?\(\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
  /from\s+(['"])(\.{1,2}\/[^'"]+)\1/g,
  /import\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
  /import\s+(['"])(\.{1,2}\/[^'"]+)\1/g,
];

// Map a package subpath ('' | 'logger' | 'test/expect' | 'logger.js' |
// 'fixtures/package.json') to its module-root-relative file.
function subpathToFile(subpath, packageRoot) {
  const name = subpath || 'index';
  if (name.endsWith('.js') || name.endsWith('.json')) {
    return name;
  }

  // Directory modules: '@omega.js/devkit/translate' → 'translate/index.js'
  if (packageRoot
    && !jetpack.exists(path.join(packageRoot, `${name}.js`))
    && jetpack.exists(path.join(packageRoot, name, 'index.js'))) {
    return `${name}/index.js`;
  }

  return `${name}.js`;
}

// Collect the .js files under dir that are host code: never follows symlinks
// (@omega.js/backend's self-test fixture ships a circular self-link inside a dist
// node_modules — jetpack.find follows it until ENAMETOOLONG) and never
// descends into node_modules, the vendor output, or dist/defaults (none is
// host code to scan or rewrite — defaults are consumer templates scaffolded
// into consumer projects, where @omega.js/* specifiers must survive as package
// requires; a framework's own defaults reference the framework itself, which
// would otherwise vendor the host into itself).
function findHostJsFiles(dir, vendorRoot) {
  const files = [];
  const queue = [dir];
  const defaultsRoot = path.join(dir, 'defaults');

  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && abs !== vendorRoot && abs !== defaultsRoot) {
          queue.push(abs);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(abs);
      }
    }
  }

  return files;
}

// Locate a vendorable package's module root (the directory of its src/index.js
// entry) — resolved from the host first, falling back to devkit's own tree so
// devkit always self-resolves.
function resolvePackageRoot(name, cwd) {
  try {
    return path.dirname(require.resolve(`@omega.js/${name}`, { paths: [cwd, __dirname] }));
  } catch (error) {
    throw new Error(`[devkit vendor] Cannot resolve '@omega.js/${name}' from ${cwd} — is it a devDependency of the host?`);
  }
}

// A package's ROOT dir for asset vendoring: the plain `resolvePackageDir` walk,
// never require.resolve, which resolves `main`: on a fresh tree a dist-building
// package's `main` is not written yet (a CI checkout preparing desktop before
// web), and assets live in the package's SOURCES.
function resolveAssetPackageRoot(name, cwd) {
  for (const base of [cwd, __dirname]) {
    const dir = resolvePackageDir(name, base);
    if (dir && jetpack.read(path.join(dir, 'package.json'), 'json')?.name === name) {
      return dir;
    }
  }
  throw new Error(`[devkit vendor] Cannot resolve '${name}' from ${cwd} — is it a devDependency of the host?`);
}

// Copy the host's declared cross-package assets (package.json `omega.vendorAssets`)
// into dist. Sources are package-root-relative files or dirs; `to` is
// dist-relative and must stay inside dist.
function vendorDeclaredAssets(hostPackage, cwd, distPath) {
  const declarations = (hostPackage.omega && hostPackage.omega.vendorAssets) || [];
  const copied = [];

  for (const entry of declarations) {
    if (!entry || !entry.package || !entry.from || !entry.to) {
      throw new Error(`[devkit vendor] omega.vendorAssets entries need { package, from, to } — got ${JSON.stringify(entry)}`);
    }

    const source = path.join(resolveAssetPackageRoot(entry.package, cwd), entry.from);
    if (!jetpack.exists(source)) {
      throw new Error(`[devkit vendor] Asset source not found: ${entry.package}/${entry.from}`);
    }

    const destination = path.resolve(distPath, entry.to);
    if (!destination.startsWith(distPath + path.sep)) {
      throw new Error(`[devkit vendor] Asset 'to' must stay inside the output dir — got ${entry.to}`);
    }

    jetpack.copy(source, destination, { overwrite: true });
    copied.push(`${entry.package}/${entry.from} → ${entry.to}`);
  }

  return copied;
}

// From a seed set of module-root-relative files, follow relative requires/imports
// inside the package until closure. Returns the full set of files to vendor.
function resolveNeededFiles(name, packageRoot, seeds) {
  const needed = new Set();
  const queue = [...seeds];

  while (queue.length > 0) {
    const relative = queue.pop();
    if (needed.has(relative)) continue;

    const abs = path.join(packageRoot, relative);
    if (!jetpack.exists(abs)) {
      throw new Error(`[devkit vendor] '@omega.js/${name}' has no module '${relative}' (requested by the host or a package-internal require)`);
    }
    needed.add(relative);

    // Comments never register as dependencies (#354) — the file is COPIED
    // verbatim, only the scan reads the stripped text.
    const contents = stripComments(jetpack.read(abs) || '');
    for (const pattern of RELATIVE_PATTERNS) {
      for (const match of contents.matchAll(pattern)) {
        let dep = path.join(path.dirname(relative), match[2]).split(path.sep).join('/');
        if (!dep.endsWith('.js') && !dep.endsWith('.json')) dep = `${dep}.js`;
        queue.push(dep);
      }
    }
  }

  return needed;
}

/**
 * Vendor the @omega.js modules a host framework actually uses into its dist and
 * rewrite the references.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - Host framework root (defaults to process.cwd())
 * @returns {{ rewritten: number, vendored: Object<string, string[]>, assets: string[], docs: object, vendorRoot: string }}
 */
function vendorPackages(options) {
  options = options || {};
  const cwd = path.resolve(options.cwd || process.cwd());

  const hostPackage = jetpack.read(path.join(cwd, 'package.json'), 'json');
  if (!hostPackage) {
    throw new Error(`[devkit vendor] No package.json found in ${cwd}`);
  }

  const output = (hostPackage.preparePackage && hostPackage.preparePackage.output) || './dist';
  const distPath = path.resolve(cwd, output);
  if (!jetpack.exists(distPath)) {
    throw new Error(`[devkit vendor] Output dir does not exist: ${distPath} — run prepare first`);
  }

  const vendorRoot = path.join(distPath, 'vendor');

  // The docs tree and the Claude plugin ship inside the manager (a no-op for
  // any other package), on every prepare, independent of dist.
  const docs = vendorDocs({ cwd });

  // Declared cross-package assets copy on every run, independent of whether
  // any dist JS references @omega.js modules.
  const assets = vendorDeclaredAssets(hostPackage, cwd, distPath);
  if (assets.length > 0) {
    logger.log(`Vendored ${assets.length} declared asset(s) into ${hostPackage.name}: ${assets.join(', ')}`);
  }

  // The host's OWN name is never a vendor candidate: files that reference the
  // host by name (boot harnesses, consumer fixtures under src/test/) run in a
  // CONSUMER context where the name resolves via the consumer's node_modules —
  // vendoring would fold the host into itself, and rewriting would break that
  // runtime resolution. Those references survive verbatim.
  const hostSelfName = (hostPackage.name || '').startsWith('@omega.js/')
    ? hostPackage.name.slice('@omega.js/'.length)
    : null;

  // Published @omega.js RUNTIME deps (dependencies/peer/optional — e.g. desktop's
  // and extension's @omega.js/client) are never vendor candidates either: they
  // ship to consumers via npm and must resolve to the installed package, not a
  // pinned snapshot (client is a shared singleton — a vendored copy duplicates
  // it and freezes its version). Vendoring is ONLY for the private devDep
  // workspace packages (devkit, config, account) that never publish.
  const publishedNames = new Set(
    Object.keys({
      ...(hostPackage.dependencies || {}),
      ...(hostPackage.peerDependencies || {}),
      ...(hostPackage.optionalDependencies || {}),
    })
      .filter((name) => name.startsWith('@omega.js/'))
      .map((name) => name.slice('@omega.js/'.length))
  );
  const neverVendor = (name) => name === hostSelfName || publishedNames.has(name);

  // Package roots resolve once per name — subpath → file mapping needs them
  // to detect directory modules (translate/index.js vs translate.js).
  const packageRoots = new Map();
  const rootFor = (name) => {
    if (!packageRoots.has(name)) {
      packageRoots.set(name, resolvePackageRoot(name, cwd));
    }
    return packageRoots.get(name);
  };

  // 1. Scan dist for @omega.js references: which files need rewriting, which
  // modules of which packages are used. RAW on purpose (no stripComments):
  // step 4's rewrite and CI's self-containment grep both read raw text, so a
  // comment-only reference must still land in filesToRewrite or it would ship
  // unrewritten and fail the CI gate.
  const seedsByPackage = new Map();
  const filesToRewrite = [];
  findHostJsFiles(distPath, vendorRoot).forEach((abs) => {
    const contents = jetpack.read(abs);
    if (!contents || !contents.includes('@omega.js/')) {
      return;
    }
    let uses = false;
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of contents.matchAll(pattern)) {
        const name = match[3];
        if (neverVendor(name)) continue;
        if (!VENDORABLE_PACKAGES.includes(name)) {
          throw new Error(`[devkit vendor] ${hostPackage.name} dist references '@omega.js/${name}' (${path.relative(cwd, abs)}), which is not a vendorable private utility (${VENDORABLE_PACKAGES.join(', ')}) — declare it as a runtime dependency instead, or drop the reference`);
        }
        if (!seedsByPackage.has(name)) seedsByPackage.set(name, new Set());
        seedsByPackage.get(name).add(subpathToFile(match[4], rootFor(name)));
        uses = true;
      }
    }
    if (uses) filesToRewrite.push(abs);
  });

  // Nothing left to rewrite. Two very different states share that scan result,
  // and only one of them may touch dist/vendor (#393):
  //   - an ALREADY-rewritten dist (vendor dir present): its files import FROM
  //     dist/vendor, so removing it breaks every one of them. A prepare wipes
  //     the whole output dir before the hook runs, so a vendor dir existing
  //     HERE can only mean a standalone re-run against a prepared dist — never
  //     a stale leftover. Leave it exactly as it is.
  //   - a dist that references no @omega.js package at all: nothing to do.
  if (seedsByPackage.size === 0) {
    if (jetpack.exists(vendorRoot)) {
      logger.log(`${hostPackage.name} dist is already vendored (no unrewritten @omega.js references) — left intact`);
    } else {
      logger.log(`No @omega.js references found in ${hostPackage.name} dist — nothing to vendor`);
    }
    return { rewritten: 0, vendored: {}, assets, docs, vendorRoot };
  }

  // The copy below goes OVER THE TOP of whatever vendor tree is already there —
  // never a full reset (#393). A vendor dir present at scan time can only mean a
  // standalone re-run against an already-vendored dist (a prepare wipes the whole
  // output dir first), and this scan sees only the specifiers that are still RAW:
  // in a MIXED dist — rewritten files plus one watch-mode single-file copy that
  // skipped the hook — the seeds cover the new file alone, so wiping first and
  // re-copying only those would leave every previously-rewritten import dangling.
  // Copying over the top is safe for the fresh case too: same source, same bytes.
  const vendorExisted = jetpack.exists(vendorRoot);

  // Failure paths roll back only what THIS run could have created: with no
  // pre-existing tree the whole dir goes (zero half-state — dist JS is untouched
  // at that point, so the unreferenced vendor dir goes too); with one, it stays,
  // because removing it breaks the rewritten files it serves.
  const rollbackVendor = () => {
    if (!vendorExisted) jetpack.remove(vendorRoot);
  };

  // 2. Selective copy per package: seeds + transitive relative deps, nothing else.
  // The seed set GROWS as the modules being vendored are themselves read (#739):
  // devkit's license.js requires '@omega.js/config' and '@omega.js/account', so
  // both ship beside it even when the host names neither — the same closure rule
  // the host scan applies, run to a fixed point. Seeds come from the STRIPPED
  // source, a commented-out require being no dependency (#354); step 4's rewrite
  // still reads raw text, so a specifier inside a comment is rewritten rather
  // than shipped raw past CI's self-containment grep.
  // A failure here (e.g. a require of a module that doesn't exist) rolls back.
  const vendored = {};
  try {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, seeds] of [...seedsByPackage]) {
        const packageRoot = rootFor(name);
        const needed = resolveNeededFiles(name, packageRoot, seeds);
        vendored[name] = [...needed].sort();

        for (const relative of needed) {
          const contents = stripComments(jetpack.read(path.join(packageRoot, relative)) || '');
          if (!contents.includes('@omega.js/')) continue;
          for (const pattern of REFERENCE_PATTERNS) {
            for (const match of contents.matchAll(pattern)) {
              const dependency = match[3];
              // A published runtime dep (@omega.js/client) resolves from the
              // host's node_modules at consumer runtime — same rule as host code.
              if (neverVendor(dependency)) continue;
              if (!VENDORABLE_PACKAGES.includes(dependency)) {
                throw new Error(`[devkit vendor] vendored '@omega.js/${name}/${relative}' references '@omega.js/${dependency}', which is not a vendorable private utility (${VENDORABLE_PACKAGES.join(', ')}) — declare it as a runtime dependency of ${hostPackage.name} instead, or drop the reference`);
              }
              const file = subpathToFile(match[4], rootFor(dependency));
              if (!seedsByPackage.has(dependency)) seedsByPackage.set(dependency, new Set());
              if (!seedsByPackage.get(dependency).has(file)) {
                seedsByPackage.get(dependency).add(file);
                grew = true;
              }
            }
          }
        }
      }
    }

    for (const [name, files] of Object.entries(vendored)) {
      const packageRoot = rootFor(name);
      for (const relative of files) {
        jetpack.copy(path.join(packageRoot, relative), path.join(vendorRoot, name, relative), { overwrite: true });
      }
    }
  } catch (error) {
    rollbackVendor();
    throw error;
  }

  // 3. Guard BEFORE touching any dist file (the after-hook runner can't block,
  // so a guard failure must leave dist exactly as prepare wrote it): every bare
  // specifier in the vendored modules must resolve from the host at consumer
  // runtime — i.e. live in its dependencies/peerDependencies/optionalDependencies.
  const hostRuntimeDeps = {
    ...(hostPackage.dependencies || {}),
    ...(hostPackage.peerDependencies || {}),
    ...(hostPackage.optionalDependencies || {}),
  };
  const missing = new Set();
  jetpack.find(vendorRoot, { matching: '**/*.js' }).forEach((file) => {
    for (const { specifier } of bareSpecifiers(jetpack.read(path.resolve(file)) || '')) {
      const name = packageName(specifier);
      // Cross-references between @omega.js packages are never host deps: the
      // vendorable ones become sibling paths in step 4's rewrite, and a
      // published runtime dep (client) resolves from the host's node_modules.
      if (name.startsWith('@omega.js/')) {
        continue;
      }
      if (!isBuiltin(name) && !hostRuntimeDeps[name]) {
        missing.add(name);
      }
    }
  });
  if (missing.size > 0) {
    rollbackVendor(); // dist JS is untouched, so a vendor dir this run created goes too
    throw new Error(`[devkit vendor] ${hostPackage.name} must declare runtime dependencies used by vendored modules: ${[...missing].join(', ')}`);
  }

  // 4. Rewrite the @omega.js references to relative paths into the vendor dirs —
  // in the host's files AND inside the vendored trees themselves (#739), where a
  // surviving cross-package specifier is MODULE_NOT_FOUND on a published install,
  // the private packages never shipping. Same patterns, same target rule: the
  // sibling vendored copy, reached relative to the file doing the requiring.
  // Two-phase so a failure can never leave dist part-rewritten: every updated
  // file is computed in memory first, then the batch writes — and a mid-batch
  // write failure restores the originals already written before rethrowing.
  const vendoredFilesToRewrite = Object.entries(vendored)
    .flatMap(([name, files]) => files.map((relative) => path.join(vendorRoot, name, relative)));

  const rewrites = [];
  [...filesToRewrite, ...vendoredFilesToRewrite].forEach((abs) => {
    const contents = jetpack.read(abs);
    let updated = contents;
    for (const pattern of REFERENCE_PATTERNS) {
      updated = updated.replace(pattern, (match, prefix, quote, name, subpath) => {
        // Host files can only carry vendorable names here (the scan threw
        // otherwise); a vendored file can still carry a non-vendorable one
        // inside a COMMENT, which the seed scan strips and never validated.
        if (neverVendor(name) || !VENDORABLE_PACKAGES.includes(name)) return match;
        const target = path.join(vendorRoot, name, subpathToFile(subpath, rootFor(name)));
        let relative = path.relative(path.dirname(abs), target).split(path.sep).join('/');
        if (!relative.startsWith('.')) {
          relative = `./${relative}`;
        }
        return `${prefix}${quote}${relative}${quote}`;
      });
    }
    if (updated !== contents) {
      rewrites.push({ abs, contents, updated });
    }
  });

  const written = [];
  try {
    for (const rewrite of rewrites) {
      jetpack.write(rewrite.abs, rewrite.updated);
      written.push(rewrite);
    }
  } catch (error) {
    for (const rewrite of written) {
      jetpack.write(rewrite.abs, rewrite.contents);
    }
    throw new Error(`[devkit vendor] Rewrite failed mid-batch (${error.message}) — ${written.length} already-written file(s) restored, dist is unchanged`);
  }
  const rewritten = rewrites.length;

  const summary = Object.entries(vendored).map(([name, files]) => `${name} (${files.length})`).join(', ');
  logger.log(`Vendored ${summary} into ${path.relative(cwd, vendorRoot)}, rewrote ${rewritten} file(s) in ${hostPackage.name}`);

  return { rewritten, vendored, assets, docs, vendorRoot };
}

module.exports = vendorPackages;
// The canonical vendorable list — watch-all's vendor propagation watches
// exactly the packages this tool folds into dists.
module.exports.VENDORABLE_PACKAGES = VENDORABLE_PACKAGES;
module.exports.PRIVATE_REFERENCE = PRIVATE_REFERENCE;
module.exports.subpathToFile = subpathToFile;
