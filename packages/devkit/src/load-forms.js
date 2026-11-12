/**
 * The ONE scanner of the forms that load a package by name: `require('<pkg>')`,
 * `import ... from` and `export ... from '<pkg>'`, `import('<pkg>')` and a bare
 * `import '<pkg>'`, read after comments are blanked. Stdlib-only, like every vendorable module.
 */

// Group 2 is the specifier: a bare name, never a path, and never with whitespace.
const BARE_LOAD_PATTERNS = [
  /\brequire\(\s*(['"])([^'"\s./][^'"\s]*)\1/g,
  /\bfrom\s+(['"])([^'"\s./][^'"\s]*)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\s./][^'"\s]*)\1/g,
  /\bimport\s+(['"])([^'"\s./][^'"\s]*)\1/g,
];

/**
 * The source with every comment blanked to spaces, newlines kept, so an index
 * into the result is the same index into the source. String and template
 * literals are tracked, regex literals and nested templates are not.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let result = '';
  let index = 0;

  const blank = (end) => {
    result += source.slice(index, end).replace(/[^\n]/g, ' ');
    index = end;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(end === -1 ? source.length : end);
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      blank(end === -1 ? source.length : end + 2);
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        // A stray apostrophe ends at the newline rather than swallowing the file.
        if (char !== '`' && source[index] === '\n') break;
        index += 1;
      }
      result += source.slice(start, index);
      continue;
    }

    if (char === '\\') {
      result += source.slice(index, index + 2);
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

/**
 * Every bare specifier the source loads, outside comments, in source order.
 *
 * @param {string} source
 * @returns {Array<{ specifier: string, index: number }>} index is the offset into source.
 */
function bareSpecifiers(source) {
  const stripped = stripComments(source);
  const found = [];

  for (const pattern of BARE_LOAD_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) found.push({ specifier: match[2], index: match.index });
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * The PACKAGE a specifier resolves to: `@scope/name` keeps two segments,
 * everything else keeps one, and the subpath is not the dependency.
 *
 * @param {string} specifier
 * @returns {string}
 */
function packageName(specifier) {
  const segments = specifier.split('/');

  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

module.exports = { bareSpecifiers, packageName, stripComments };
