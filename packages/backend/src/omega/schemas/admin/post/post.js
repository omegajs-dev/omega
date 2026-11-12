/**
 * Schema for POST /admin/post (create)
 */
export default() => ({
  title: { type: 'string', required: true },
  url: { type: 'string', required: true },
  description: { type: 'string', required: true },
  headerImageURL: { type: 'string', required: true },
  body: { type: 'string', required: true },
  author: { type: 'string' },
  affiliate: { type: 'string', default: '' },
  tags: { type: 'array', default: [] },
  categories: { type: 'array', default: [] },
  layout: { type: 'string', default: 'blueprint/blog/post' },
  date: { type: 'string' },
  id: { type: 'number' },
  postPath: { type: 'string', default: 'guest' },
  // Which web target the post belongs to (#887): optional for a brand with one
  // web target, required when it runs several
  target: { type: 'string' },
  source: { type: 'string', default: null },
  // D13: content-publish implies deploy — false opts out of the build dispatch
  deploy: { type: 'boolean', default: true },
});
