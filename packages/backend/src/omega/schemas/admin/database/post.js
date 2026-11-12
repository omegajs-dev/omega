export default() => ({
  path: { type: 'string', required: true },
  document: { type: ['object', 'string', 'number', 'boolean', 'array'], default: {} },
});
