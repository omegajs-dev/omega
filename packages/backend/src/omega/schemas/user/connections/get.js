export default() => ({
  // `status` honors an admin's `uid` (it checks the connection at the provider
  // on that user's behalf); `authorize` refuses it by name
  // ([#782](https://github.com/Omega-JS-Stack/omega/issues/782)). No default
  // either way: `settings.uid` set means the caller passed one — unknown keys
  // are stripped before a handler sees them, so the field has to stay declared
  // for a stale caller's value to reach the 400.
  uid: { type: 'string' },
  provider: { type: 'string', required: true },
  // `status` only: the linked account's identity id. Without it, a user holding
  // several accounts of the provider gets every one listed
  id: { type: 'string' },
  action: { type: 'string', default: 'authorize', enum: ['authorize', 'status'] },
  // Where the callback page lands after this connect
  // ([#784](https://github.com/Omega-JS-Stack/omega/issues/784)). No default:
  // absent means the page keeps its own. The VALUE rule (a path on this site)
  // lives in `_context.js` — one home, and a non-path answers 400 naming it
  // rather than being coerced into something that looks accepted.
  returnUrl: { type: 'string' },
  redirect: { type: 'boolean', default: true },
  removeInvalidTokens: { type: 'boolean', default: true },
});
