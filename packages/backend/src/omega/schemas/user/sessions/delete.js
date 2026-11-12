export default({ user }) => ({
  uid: { type: 'string', default: user.uid },
  id: { type: 'string', default: 'app' },
});
