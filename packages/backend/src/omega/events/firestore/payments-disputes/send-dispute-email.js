/**
 * The dispute alert email the payments-disputes trigger (on-write.js) sends to
 * the brand contact.
 */
const { escapeHtml, safeUrl } = require('../../../libraries/email/constants.js');

/**
 * Send dispute alert email to brand contact. Resolves the outcome the dispute doc
 * records rather than throwing: the caller must never claim a send that did not happen.
 * @param {object} options
 * @param {object} options.alert - Normalized alert data
 * @param {object|null} options.match - Match details (null if no match)
 * @param {object} [options.result] - Processing result (refund/cancel statuses)
 * @param {string} options.alertId - Dispute alert ID
 * @param {object} options.ctx - Assistant instance
 * @returns {Promise<'success'|'failed'|'skipped'>}
 */
function sendDisputeEmail({ alert, match, result, alertId, ctx }) {
  const omega = ctx.omega;
  const email = ctx.email;
  const brandEmail = omega.config.brand?.contact?.email;

  if (!brandEmail) {
    ctx.error(`sendDisputeEmail(): No brand.contact.email configured, skipping`);
    return Promise.resolve('skipped');
  }

  const matched = match ? 'Matched' : 'Unmatched';
  const subject = `Dispute Alert: ${matched}, $${alert.amount} on ****${alert.card.last4} [${alertId}]`;

  // The alert body is hand-built markup (trustedContent below), so every value that
  // came off the dispute webhook or the provider match gets escaped on the way in.
  const messageLines = [];

  // Status banner
  if (match && result) {
    const hasErrors = result.errors?.length > 0;
    const banner = hasErrors ? 'Partially processed (see errors below)' : 'Automatically processed';
    messageLines.push(`<strong>${banner}</strong>`);
  } else {
    messageLines.push('<strong>Could not be matched to a charge: manual review required.</strong>');
  }

  messageLines.push('');

  // Alert details
  messageLines.push('<strong>Alert Details:</strong>');
  messageLines.push('<ul>');
  messageLines.push(`<li><strong>Alert ID:</strong> ${escapeHtml(alertId)}</li>`);
  messageLines.push(`<li><strong>Type:</strong> ${escapeHtml(alert.alertType || 'N/A')}</li>`);
  messageLines.push(`<li><strong>Card:</strong> ****${escapeHtml(alert.card.last4)} (${escapeHtml(alert.card.brand || 'unknown')})</li>`);
  messageLines.push(`<li><strong>Amount:</strong> $${escapeHtml(alert.amount)}</li>`);
  messageLines.push(`<li><strong>Transaction Date:</strong> ${escapeHtml(alert.transactionDate)}</li>`);
  messageLines.push(`<li><strong>Provider:</strong> ${escapeHtml(alert.provider)}</li>`);
  messageLines.push(`<li><strong>Reason:</strong> ${escapeHtml(alert.reasonCode || 'N/A')}</li>`);
  messageLines.push(`<li><strong>Network:</strong> ${escapeHtml(alert.subprovider || 'N/A')}</li>`);
  messageLines.push(`<li><strong>Customer Email:</strong> ${escapeHtml(alert.customerEmail || 'N/A')}</li>`);
  messageLines.push(`<li><strong>Already Refunded:</strong> ${alert.isRefunded ? 'Yes' : 'No'}</li>`);
  messageLines.push('</ul>');

  // Match & action details
  if (match) {
    messageLines.push('<strong>Match Details:</strong>');
    messageLines.push('<ul>');
    messageLines.push(`<li><strong>Method:</strong> ${escapeHtml(match.method)}</li>`);
    messageLines.push(`<li><strong>Charge:</strong> ${escapeHtml(match.chargeId || 'N/A')}</li>`);
    messageLines.push(`<li><strong>Invoice:</strong> ${escapeHtml(match.invoiceId || 'N/A')}</li>`);
    messageLines.push(`<li><strong>Subscription:</strong> ${escapeHtml(match.subscriptionId || 'N/A')}</li>`);
    messageLines.push(`<li><strong>Customer:</strong> ${escapeHtml(match.customerId || 'N/A')}</li>`);
    messageLines.push(`<li><strong>Customer Email:</strong> ${escapeHtml(match.email || 'N/A')}</li>`);
    messageLines.push(`<li><strong>UID:</strong> ${escapeHtml(match.uid || 'unknown')}</li>`);
    messageLines.push('</ul>');

    if (result) {
      messageLines.push('<strong>Actions Taken:</strong>');
      messageLines.push('<ul>');
      messageLines.push(`<li><strong>Refund:</strong> ${escapeHtml(result.refundStatus)}${result.refundId ? ` (${escapeHtml(result.refundId)})` : ''}${result.amountRefunded ? `, $${(result.amountRefunded / 100).toFixed(2)} ${escapeHtml(result.currency || '')}` : ''}</li>`);
      messageLines.push(`<li><strong>Cancel Subscription:</strong> ${escapeHtml(result.cancelStatus)}</li>`);
      messageLines.push('</ul>');
    }
  }

  // Stripe link
  if (alert.stripeUrl) {
    messageLines.push(`<br><a href="${safeUrl(alert.stripeUrl)}">View in Stripe Dashboard</a>`);
  }

  // Errors
  if (result?.errors?.length) {
    messageLines.push('');
    messageLines.push('<strong>Errors:</strong>');
    messageLines.push('<ul>');
    result.errors.forEach((err) => {
      messageLines.push(`<li>${escapeHtml(err)}</li>`);
    });
    messageLines.push('</ul>');
  }

  return email.send({
    sender: 'internal',
    to: brandEmail,
    subject: subject,
    template: 'card',
    categories: ['order/dispute-alert'],
    copy: true,
    // Body is first-party markup built above; its third-party values are escaped.
    trustedContent: true,
    data: {
      email: {
        preview: `Dispute Alert: ${matched}, $${alert.amount} on ****${alert.card.last4}`,
      },
      content: {
        title: `Dispute Alert: ${matched}`,
        message: messageLines.join('\n'),
      },
    },
  })
    .then((r) => {
      ctx.log(`sendDisputeEmail(): Success alertId=${alertId}`);
      return 'success';
    })
    .catch((e) => {
      ctx.error(`sendDisputeEmail(): Failed alertId=${alertId}: ${e.message}`);
      return 'failed';
    });
}

module.exports = { sendDisputeEmail };
