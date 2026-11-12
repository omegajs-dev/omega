/**
 * Transition: checkout-declined
 * Triggered when a checkout's payment is declined, from either entry state:
 *   - a FIRST checkout (basic/null → suspended) ([#212])
 *   - a declined WIN-BACK: a fully cancelled subscriber resubscribing, which keeps
 *     the paid product id through the cancellation (cancelled paid → suspended)
 *     ([#223](https://github.com/Omega-JS-Stack/omega/issues/223))
 *
 * Log-only, deliberately, for both. This user is standing at the checkout watching
 * the decline happen — the payment-failed email this case used to send is renewal
 * dunning copy ("your access has been suspended", "update your payment method to
 * restore access") addressed to someone who is not mid-subscription and has no
 * access to lose. No analytics either: no money moved, and the resolver tracks
 * payments, not attempts ([#212]).
 */
export default async function ({ ctx, before, after, order, uid }) {
  ctx.log(`Transition [subscription/checkout-declined]: uid=${uid}, attemptedProduct=${after.product?.id}, previousProduct=${before?.product?.id || 'none'}, order=${order?.id || 'none'} (no email — the user is at checkout and sees the decline)`);
};
