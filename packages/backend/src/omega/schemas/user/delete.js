export default({ user }) => ({
  uid: { type: 'string', default: user.uid },
  reason: { type: 'string', default: '', max: 500 },
});
