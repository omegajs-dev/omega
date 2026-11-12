/**
 * Schema for POST /admin/repo/content
 */
export default() => ({
  path: { type: 'string', required: true },
  content: { type: 'string', required: true },
  type: { type: 'string', default: 'text' },
  // Which web target the file belongs to (#887): optional for a brand with one
  // web target, required when it runs several
  target: { type: 'string' },
});
