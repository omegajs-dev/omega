export default() => ({
  path: { type: 'string', required: true },
  document: { type: 'object', default: {} },
  merge: { type: 'boolean', default: true },
  metadataTag: { type: 'string', default: 'admin/firestore' },
});
