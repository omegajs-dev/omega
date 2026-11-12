/**
 * Transition: purchase-refunded
 * Triggered when a one-time purchase is refunded (charge.refunded with no
 * subscription and no invoice).
 *
 * Webhook-driven, so it fires however the refund originated — the refund
 * endpoint, an admin dashboard, or a direct provider action.
 *
 * Provider-agnostic — refund details are extracted by the provider library's
 * getRefundDetails() and passed as a unified { amount, currency, reason } object,
 * the same ones on-write.js records on the order.
 *
 * The mail IS the subscription twin's (subscription/payment-refunded.js) — the same
 * `order` template, the same `refunded` event, the same computed refund fields —
 * so it is sent by that same handler rather than a second copy of it here (the
 * winback delegation precedent). Only the log line names the one-time lane, and
 * it says more: the amount that came back is this record's whole point. A
 * customer refunded on a one-time purchase used to hear nothing at all — the
 * handler was a log-only stub, so their only notice was the line on their
 * statement ([#673](https://github.com/Omega-JS-Stack/omega/issues/673)).
 */
import path from 'path';
import { loadHandler } from '../../../../../libraries/load-handler.js';

export default async function (context) {
  const { after, order, uid, ctx, refundDetails } = context;

  ctx.log(`Transition [one-time/purchase-refunded]: uid=${uid}, orderId=${order?.id}, product=${after?.product?.id}, amount=${refundDetails?.amount || 'unknown'} ${refundDetails?.currency || 'USD'}, reason=${refundDetails?.reason || 'none'}`);

  // Another handler comes through the one loader: an `import` of it re-parses the
  // file (the package names no "type") and prints MODULE_TYPELESS_PACKAGE_JSON
  return loadHandler(path.join(import.meta.dirname, '..', 'subscription', 'payment-refunded.js'))(context);
};
