/**
 * POST /test/schema - Test schema validation
 * Returns the resolved settings for testing purposes
 */
export default async ({ ctx, user, data }) => {
  ctx.log('test/schema: User subscription info', {
    subscriptionId: user.subscription?.product?.id,
    subscriptionStatus: user.subscription?.status,
    fullSubscription: user.subscription,
  });

  return ctx.respond({
    settings: data,
    user: {
      authenticated: user.authenticated,
      uid: user.auth?.uid || null,
      subscription: user.subscription?.product?.id || 'basic',
    },
  });
};
