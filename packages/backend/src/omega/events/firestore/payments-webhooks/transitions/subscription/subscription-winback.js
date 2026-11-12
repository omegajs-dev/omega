/**
 * Transition: subscription-winback
 * Triggered when a fully cancelled subscriber resubscribes (cancelled paid → active paid)
 *
 * The customer's email is the same order confirmation a first subscription sends —
 * same template, same computed totals — so it is sent by the SAME handler rather
 * than a second copy of it here. Only the log line names the win-back.
 */
import path from 'path';
import { loadHandler } from '../../../../../libraries/load-handler.js';

export default async function (context) {
  const { before, after, uid, ctx } = context;

  ctx.log(`Transition [subscription/subscription-winback]: uid=${uid}, product=${after.product?.id}, previousProduct=${before?.product?.id}, frequency=${after.payment?.frequency}`);

  // Another handler comes through the one loader: an `import` of it re-parses the
  // file (the package names no "type") and prints MODULE_TYPELESS_PACKAGE_JSON
  return loadHandler(path.join(import.meta.dirname, 'new-subscription.js'))(context);
};
