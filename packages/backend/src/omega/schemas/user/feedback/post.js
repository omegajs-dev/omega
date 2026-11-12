export default() => ({
  rating: { type: 'string', required: true },
  positive: { type: 'string', default: '' },
  negative: { type: 'string', default: '' },
  comments: { type: 'string', default: '' },
});
