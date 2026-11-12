/**
 * POST /handler/post - Create post handler (with invoice and notification)
 * Admin-only endpoint that creates invoices and sends notifications for guest posts
 */
import env from '../../../libraries/env.js';

export default async ({ ctx, omega, user, data, analytics }) => {
  const fetch = omega.require('wonderful-fetch');

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  const response = {
    invoice: {
      success: false,
      data: {},
    },
    notification: {
      success: false,
      data: {},
    }
  };

  const postSlug = `/blog/${data.url}`;
  const invoiceNote = `GP to ${omega.config.brand.name} \nSlug: ${postSlug} \n\n${data.invoiceNote}`;

  // Create and send invoice if email and price are provided
  if (data.invoiceEmail && data.invoicePrice) {
    // Create invoice
    // ITW wrapper wire contract: the wrapper Cloud Function runs an older
    // backend whose auth reads exactly this payload field. Flips to the
    // omega-admin-key header only when ITW's wrapper migrates to the new
    // stack — never "fix" unilaterally.
    const createdInvoice = await fetch('https://us-central1-itw-creative-works.cloudfunctions.net/wrapper', {
      method: 'POST',
      response: 'json',
      body: {
        backendManagerKey: env.get('OMEGA_ADMIN_KEY'),
        method: 'post',
        service: 'paypal',
        command: 'v2/invoicing/invoices',
        body: {
          detail: {
            currency_code: 'USD',
            note: invoiceNote,
            memo: invoiceNote,
          },
          primary_recipients: [
            {
              billing_info: {
                email_address: data.invoiceEmail,
              },
            }
          ],
          items: [
            {
              name: 'GP',
              description: `Slug: ${postSlug}`,
              quantity: '1',
              unit_amount: {
                currency_code: 'USD',
                value: `${data.invoicePrice}`
              },
              unit_of_measure: 'QUANTITY',
            },
          ],
        }
      },
    }).catch(e => e);

    if (createdInvoice instanceof Error) {
      return ctx.respond(createdInvoice.message, { code: 500 });
    }

    // Send invoice
    const createdInvoiceId = (createdInvoice?.href ?? '').split('/').pop();
    // Send invoice — same ITW-wrapper wire pin as the create call above
    const sentInvoice = await fetch('https://us-central1-itw-creative-works.cloudfunctions.net/wrapper', {
      method: 'POST',
      response: 'json',
      body: {
        backendManagerKey: env.get('OMEGA_ADMIN_KEY'),
        service: 'paypal',
        command: `v2/invoicing/invoices/${createdInvoiceId}/send`,
        method: 'post',
        body: {}
      },
    }).catch(e => e);

    if (sentInvoice instanceof Error) {
      return ctx.respond(sentInvoice.message, { code: 500 });
    }

    response.invoice = {
      success: true,
      data: sentInvoice,
    };
  }

  // Send notification (unless explicitly disabled)
  if (data.sendNotification !== false) {
    // Use NEW API format
    await fetch(`${omega.getApiUrl()}/omega/admin/notification`, {
      method: 'POST',
      response: 'json',
      headers: {
        'Authorization': `Bearer ${env.get('OMEGA_ADMIN_KEY')}`,
      },
      body: {
        notification: {
          title: data.title,
          body: `"${data.title}" was just published on our blog. It's a great read and we think you'll enjoy the content!`,
          click_action: `${omega.project.websiteUrl}/blog`,
          // brand.images stores site-relative paths — the push icon must be a
          // fetchable URL, resolved against THIS environment's website origin
          icon: omega.config.brand.images.brandmark
            ? new URL(omega.config.brand.images.brandmark, omega.project.websiteUrl).href
            : undefined,
        }
      },
    }).catch(e => {
      ctx.error('Failed to send notification:', e);
    });

    response.notification = {
      success: true,
      data: {},
    };
  }

  // Track analytics
  analytics.event('handler/post', { action: 'create' });

  return ctx.respond(response);
};
