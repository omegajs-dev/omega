export default({ user }) => ({
  uid: { type: 'string', default: user.uid },
  limit: { type: 'number', default: 25, min: 1, max: 100 },
});
