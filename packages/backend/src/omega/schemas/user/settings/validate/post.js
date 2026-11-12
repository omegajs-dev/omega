export default({ user }) => ({
  uid: { type: 'string', default: user.uid },
  defaultsPath: { type: 'string', default: '' },
  existingSettings: { type: 'object', default: {} },
  newSettings: { type: 'object', default: {} },
});
