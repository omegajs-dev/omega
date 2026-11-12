export default() => ({
  // `refresh` honors `uid` (an admin refreshing at the provider on a user's
  // behalf); `tokenize` refuses it by name ([#782](https://github.com/Omega-JS-Stack/omega/issues/782)).
  // No default either way: `settings.uid` set means the caller passed one.
  uid: { type: 'string' },
  provider: { type: 'string' },  // Not required for tokenize (provider comes from encrypted state)
  id: { type: 'string' },  // `refresh` only: the linked account's identity id, required once the user holds several
  action: { type: 'string', default: 'tokenize', enum: ['tokenize', 'refresh'] },
  code: { type: 'string' },  // Required for tokenize
  encryptedState: { type: 'string' },  // Required for tokenize
});
