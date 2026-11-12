/**
 * Transition: purchase-failed
 * Triggered when a one-time payment fails (invoice.payment_failed with a
 * billing_reason no subscription owns — a MANUAL invoice).
 *
 * It sends, where the subscription side's first-checkout twin (checkout-declined)
 * deliberately does not, because the two populations are opposites: a declined
 * checkout is watched by the person who just pressed the button, and a manual
 * invoice that fails is not watched by anybody. The failure only reaches the
 * customer if this handler tells them
 * ([#673](https://github.com/Omega-JS-Stack/omega/issues/673)).
 *
 * The mail IS the subscription twin's (subscription/payment-failed.js) — the same
 * `order` template, the same `payment-failed` event, the same subject and
 * category — so it is sent by that same handler rather than a second copy of it
 * here (the winback delegation precedent). Only the log line names the one-time
 * lane. The copy still reads one-time: the template branches on the ORDER's type,
 * not on which transition sent it.
 */
import path from 'path';
import { loadHandler } from '../../../../../libraries/load-handler.js';

export default async function (context) {
  const { after, order, uid, ctx } = context;

  ctx.log(`Transition [one-time/purchase-failed]: uid=${uid}, orderId=${order?.id}, product=${after?.product?.id}`);

  // Another handler comes through the one loader: an `import` of it re-parses the
  // file (the package names no "type") and prints MODULE_TYPELESS_PACKAGE_JSON
  return loadHandler(path.join(import.meta.dirname, '..', 'subscription', 'payment-failed.js'))(context);
};
