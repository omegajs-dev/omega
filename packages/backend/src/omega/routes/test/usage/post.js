/**
 * POST /test/usage - Test usage tracking
 * Consumes the 'requests' counted feature and returns what the call left behind
 * Signed-in callers count on their own account; anonymous callers count against
 * their IP, which is an EXPLICIT keyed counter
 * ([#647](https://github.com/Omega-JS-Stack/omega/issues/647))
 * A `uid` counts against that account instead, through usage.forUser()
 */
module.exports = async ({ ctx, user, data }) => {
  const amount = data.amount;

  // Anonymous callers are keyed EXPLICITLY — a key can never silently move a
  // signed-in user's own counters into the anonymous store
  let usage = user.authenticated
    ? ctx.usage
    : ctx.usage.forKey(ctx.request.geolocation.ip);

  if (data.uid) {
    usage = ctx.usage.forUser(data.uid);
  }

  const before = await usage.read('requests');

  // Check, count and write, in one call — a 429 is thrown, never returned
  const after = await usage.consume('requests', amount);

  // Log
  ctx.log(`test/usage: Consumed ${amount} requests`, {
    authenticated: user.authenticated,
    key: usage.key,
    uid: usage.uid,
    before: { used: before.used, left: before.left, day: before.day },
    after: after,
  });

  return ctx.respond({
    feature: 'requests',
    amount,
    authenticated: user.authenticated,
    key: usage.key,
    uid: usage.uid,
    limit: before.limit,
    dayLimit: before.day.limit,
    before: {
      used: before.used,
      left: before.left,
      day: { used: before.day.used, left: before.day.left },
    },
    after: after,
  });
};
