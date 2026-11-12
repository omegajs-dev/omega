/**
 * Schema for GET /content/post
 */
export default() => ({
  url: { type: 'string', required: true },
  // Which web target to read the post from (#887): optional for a brand with
  // one web target, required when it runs several
  target: { type: 'string' },
});
