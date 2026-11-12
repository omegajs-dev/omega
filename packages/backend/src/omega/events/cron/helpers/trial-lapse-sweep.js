/**
 * The trial lapse sweep's helpers (events/cron/daily/trial-lapse-sweep.js): the
 * staleness guard and the outcome's conversion. They live outside the schedule's
 * folder, whose every file the cron runner runs as a job.
 */
// The payment webhook's analytics module owns what "still inside the trial" means;
// this sweep reports the outcomes that webhook never sees, so both read one predicate
const { isInsideTrial } = require('../../firestore/payments-webhooks/analytics.js');

/**
 * Has a subscription write landed since this sweep read its candidates?
 *
 * `>=`, not `>`: both are whole seconds, so a webhook that wrote inside the second
 * the sweep took its snapshot carries an EQUAL stamp, and equal reads as newer (one
 * candidate re-examined next run beats reverting a state the provider moved past).
 *
 * @param {number} freshStampUNIX - `subscription.payment.updatedBy.date.timestampUNIX`, 0 when never stamped
 * @param {number} sweepReadUNIX - The second this run read its candidate snapshot
 * @returns {boolean} True when the sweep's answer is stale and must not be written
 */
function isNewerThanSweep(freshStampUNIX, sweepReadUNIX) {
  return (freshStampUNIX || 0) >= sweepReadUNIX;
}

/**
 * The conversion to report for an outcome this sweep just decided, or null when a
 * webhook already reported it. The guard is the term: a candidate still inside its
 * trial is one no webhook resolved. The event id is the subscription's, the ONE
 * documented exception to "`transaction_id` is a charge's id" (docs/shared/analytics.md).
 * `sub` is read BEFORE the lapse write: the paid product that lapsed, not `basic`.
 *
 * @param {object} sub - The subscription as it stood before this sweep wrote
 * @param {string} outcome - 'converted' | 'lapsed'
 * @param {string} currency - The brand's payment currency
 * @returns {{ event: string, eventId: string, params: object }|null}
 */
function resolveTrialOutcomeConversion(sub, outcome, currency) {
  if (!isInsideTrial(sub)) {
    return null;
  }

  const event = outcome === 'converted' ? 'trial_convert' : 'trial_lapse';
  // The full price: a conversion the provider made without telling us leaves no
  // invoice here to read a discount off
  const price = parseFloat(sub.payment?.price || 0);

  return {
    event: event,
    eventId: `${event}.${sub.payment?.resourceId}`,
    params: {
      transaction_id: sub.payment?.resourceId,
      value: price,
      currency: currency,
      items: [{
        item_id: sub.product?.id,
        item_name: sub.product?.name,
        item_category: 'subscription',
        price: price,
        quantity: 1,
      }],
      payment_provider: sub.payment?.provider,
      payment_frequency: sub.payment?.frequency || null,
      is_trial: true,
      is_recurring: false,
    },
  };
}

module.exports = { isNewerThanSweep, resolveTrialOutcomeConversion };
