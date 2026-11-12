import { summarize } from './summarize.js';

/**
 * GET /user/orders - The caller's own purchase history
 *
 * `payments-orders` is admin-only to clients (firestore.rules), and a one-time
 * purchase writes NOTHING to users/{uid} — so a browser could not see a one-time
 * purchase at all, while the confirmation copy and the receipt email both told
 * the customer to find it in their account
 * ([#672](https://github.com/Omega-JS-Stack/omega/issues/672)).
 *
 * This is the read path, server-side through the admin SDK: the rules stay as
 * they are (no collection is opened to clients), and the ownership filter below
 * is the whole authorization. A caller only ever reads their own orders unless
 * they are an admin asking about somebody else, the same shape
 * `GET /user/subscription` and `GET /user/sessions` use.
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to view other users' orders
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // ONE equality filter, then the sort and the cut in JS: ordering in the query
  // would need an owner+created composite index, and a purchase history is a
  // handful of documents per account — this query has no business asking a brand
  // to deploy an index for it (the same call the abandoned-checkout journey's
  // webhook lookup makes).
  const snapshot = await admin.firestore()
    .collection('payments-orders')
    .where('owner', '==', uid)
    .get();

  const orders = snapshot.docs
    .map((doc) => summarize(doc.id, doc.data()))
    .sort((a, b) => b.date.timestampUNIX - a.date.timestampUNIX)
    .slice(0, data.limit);

  ctx.log(`Orders for uid=${uid}: ${orders.length} of ${snapshot.size}`);

  return ctx.respond({ orders });
};
