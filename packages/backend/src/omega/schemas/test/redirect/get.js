export default() => ({
  // Relative paths only — the handler refuses anything else, so the default is
  // one too (it used to be an absolute URL).
  url: { type: 'string', default: '/' },
});
