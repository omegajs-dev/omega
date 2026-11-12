/**
 * Schema for PUT /admin/post (edit)
 */
export default() => ({
  url: { type: 'string', required: true },
  body: { type: 'string', required: true },
  title: { type: 'string' },
  postPath: { type: 'string', default: 'guest' },
  // Which web target the post belongs to (#887): optional for a brand with one
  // web target, required when it runs several
  target: { type: 'string' },
  // D13: content-publish implies deploy — false opts out of the build dispatch
  deploy: { type: 'boolean', default: true },
});
