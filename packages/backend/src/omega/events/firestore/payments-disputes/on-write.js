import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import powertools from 'node-powertools';
import { sendDisputeEmail } from './send-dispute-email.js';

/**
 * Firestore trigger: payments-disputes/{alertId} onWrite
 *
 * Processes pending dispute alerts:
 * 1. Loads the provider module for the alert's payment provider
 * 2. Searches for the matching charge via provider.searchAndMatch()
 * 3. Issues refund + cancels subscription via provider.processDispute()
 * 4. Sends email alert to brand contact
 * 5. Updates dispute document with results
 */
export default async ({ ctx, context, change }) => {
  const omega = ctx.omega;
  const admin = omega.firebase.admin;

  const dataAfter = change.after.data();

  // Short-circuit: deleted doc or non-pending status
  if (!dataAfter || dataAfter.status !== 'pending') {
    return;
  }

  const alertId = context.params.alertId;
  const disputeRef = admin.firestore().doc(`payments-disputes/${alertId}`);

  // Set status to processing
  await disputeRef.set({ status: 'processing' }, { merge: true });

  try {
    const alert = dataAfter.alert;
    const provider = alert.provider || 'stripe';

    ctx.log(`Processing dispute ${alertId}: provider=${provider}, amount=${alert.amount}, card=****${alert.card.last4}, date=${alert.transactionDate}, chargeId=${alert.chargeId || 'none'}, paymentIntentId=${alert.paymentIntentId || 'none'}`);

    // Load the provider module
    let providerModule;
    try {
      providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
    } catch (e) {
      throw new Error(`Unsupported dispute provider: ${provider}`);
    }

    // Search for the matching charge
    const match = await providerModule.searchAndMatch(alert, ctx);

    // Build timestamps
    const now = powertools.timestamp(new Date(), { output: 'string' });
    const nowUNIX = powertools.timestamp(now, { output: 'unix' });

    if (!match) {
      // No matching charge found
      await disputeRef.set({
        status: 'no-match',
        match: null,
        actions: {
          refund: 'skipped',
          cancel: 'skipped',
          email: 'pending',
        },
        metadata: {
          completed: {
            timestamp: now,
            timestampUNIX: nowUNIX,
          },
        },
      }, { merge: true });

      ctx.log(`Dispute ${alertId}: no matching charge found`);

      // Still send email to alert brand about unmatched dispute. No testing-mode
      // gate — the mailer's own seam captures a testing send instead of delivering
      // it ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)).
      const emailStatus = await sendDisputeEmail({ alert, match: null, result: null, alertId, ctx });
      await disputeRef.set({ actions: { email: emailStatus } }, { merge: true });

      return;
    }

    // Process refund and cancel
    const result = await providerModule.processDispute(match, alert, ctx);

    // Update dispute document with results
    await disputeRef.set({
      status: 'resolved',
      match: {
        invoiceId: match.invoiceId || null,
        subscriptionId: match.subscriptionId || null,
        customerId: match.customerId,
        uid: match.uid || null,
        email: match.email || null,
        chargeId: match.chargeId,
        refundId: result.refundId || null,
        amountRefunded: result.amountRefunded || null,
        currency: result.currency || null,
      },
      actions: {
        refund: result.refundStatus,
        cancel: result.cancelStatus,
        email: 'pending',
      },
      errors: result.errors,
      metadata: {
        completed: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
    }, { merge: true });

    // Send email alert — awaited, because the dispute doc records its outcome. No
    // testing-mode gate — the mailer's own seam captures a testing send instead of
    // delivering it ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)).
    const emailStatus = await sendDisputeEmail({ alert, match, result, alertId, ctx });
    await disputeRef.set({ actions: { email: emailStatus } }, { merge: true });

    ctx.log(`Dispute ${alertId} resolved: refund=${result.refundStatus}, cancel=${result.cancelStatus}`);
  } catch (e) {
    ctx.error(`Dispute ${alertId} failed: ${e.message}`, e);

    await disputeRef.set({
      status: 'failed',
      error: e.message || String(e),
    }, { merge: true });
  }
};
