import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import powertools from 'node-powertools';
import OrderId from '../../../libraries/payment/order-id.js';
import recaptcha from '../../../libraries/recaptcha.js';
import discountCodes from '../../../libraries/payment/discount-codes.js';
import registry from '../../../libraries/payment/providers/index.js';
import { hasAuthUser } from '../../../libraries/auth-user.js';
import cartConfig from '../../../libraries/abandoned-cart-config.js';
import { buildConfirmationUrl } from './confirmation-url.js';

const CART_COLLECTION = cartConfig.COLLECTION;

/**
 * POST /payments/intent
 * Creates a payment intent (e.g., Stripe Checkout Session) for subscription or one-time purchase
 * Requires authentication
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // A purchaser has to BE a user of this project: an auth user AND the user doc a
  // signup creates behind it. The pair only ever comes apart for a uid that lives
  // in ANOTHER project (a local QA checkout run against the emulator) or an
  // account deleted mid-session — and a checkout begun without it ends as a
  // webhook with nowhere to write, which the pipeline then refuses on its own
  // ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)). Refusing HERE
  // means no provider session, no intent doc, and no half-written account.
  //
  // The DOC half is defense in depth on the token lane — authenticate() only calls
  // a JWT caller authenticated once it has read their user doc — and the live gate
  // on the omega-admin-key lane, which authenticates carrying no user at all.
  const missing = await findMissingPurchaser(admin, user.auth.uid);

  if (missing) {
    ctx.warn(`Checkout refused: uid=${user.auth.uid} has ${missing} in this project — a purchase requires both an auth user and a user doc`);
    return ctx.respond('Your account could not be verified. Please sign out, sign back in, and try again.', { code: 403 });
  }

  // Verify reCAPTCHA (skip during automated tests). verify() owns the whole
  // decision: no RECAPTCHA_SECRET_KEY configured → pass (unkeyed brands are a
  // sanctioned population; cp257: keys are optional and per-brand); secret +
  // missing/bad token → fail. No pre-check here: an empty-token 403 before
  // verify() would permanently reject every checkout from a brand that never
  // configured reCAPTCHA. Same shape as routes/marketing/contact/post.js.
  if (!ctx.isTesting()) {
    const recaptchaToken = data.verification?.['g-recaptcha-response'];
    const recaptchaValid = await recaptcha.verify(recaptchaToken);
    if (!recaptchaValid) {
      return ctx.respond('Request could not be verified', { code: 403 });
    }
  }

  const uid = user.auth.uid;
  const provider = data.provider;
  const productId = data.productId;
  const attribution = data.attribution;
  const trackingConsent = data.trackingConsent;
  const discount = data.discount;
  const supplemental = data.supplemental;
  const simulate = data.simulate;
  let trial = data.trial;
  let frequency = data.frequency;

  ctx.log(`Intent request: uid=${uid}, provider=${provider}, product=${productId}, frequency=${frequency}, trial=${trial}, simulate=${simulate || 'none'}`);

  // Validate product exists in config
  const product = (omega.config.payment?.products || []).find(p => p.id === productId);
  if (!product) {
    ctx.log(`Product "${productId}" not found (available: ${(omega.config.payment?.products || []).map(p => p.id).join(', ')})`);
    return ctx.respond(`Product '${productId}' not found`, { code: 400 });
  }

  const productType = product.type || 'subscription';

  ctx.log(`Product resolved: id=${product.id}, name=${product.name}, type=${productType}, trialDays=${product.trial?.days || 'none'}`);

  // The provider gate: what a provider sells is its registry row's answer,
  // refused here before an order id is minted or a provider module runs
  const capability = registry.paymentProvider(provider);

  if (!capability) {
    return ctx.respond(`Unknown provider: ${provider}`, { code: 400 });
  }

  if (!(productType === 'subscription' ? capability.subscriptions : capability.oneTime)) {
    ctx.log(`Checkout refused: provider=${provider} does not sell type=${productType}`);
    return ctx.respond(`${capability.name} cannot sell ${productType === 'subscription' ? 'a subscription' : 'a one-time purchase'}. Choose another payment method.`, { code: 400 });
  }

  // Subscription-specific guards
  if (productType === 'subscription') {
    // Require frequency for subscriptions
    if (!frequency) {
      return ctx.respond('Frequency is required for subscription products', { code: 400 });
    }

    // Block checkout unless user has no subscription or is fully cancelled
    const subProductId = user.subscription?.product?.id || 'basic';
    const subStatus = user.subscription?.status;
    if (subProductId !== 'basic' && subStatus !== 'cancelled') {
      ctx.log(`User ${uid} has existing subscription: product=${subProductId}, status=${subStatus}, resourceId=${user.subscription.payment?.resourceId}`);
      return ctx.respond('You already have a subscription. Please cancel your existing subscription before purchasing a new one.', { code: 400 });
    }

    // A provider with no trials sells the plan without one, downgraded the
    // same silent way an ineligible buyer is below
    if (trial && !capability.trials) {
      ctx.log(`Provider ${provider} offers no trials, continuing without trial`);
      trial = false;
    }

    // Resolve trial eligibility: if requested but user has subscription history, silently downgrade
    if (trial) {
      const historySnapshot = await admin.firestore()
        .collection('payments-orders')
        .where('owner', '==', uid)
        .where('type', '==', 'subscription')
        .limit(1)
        .get();

      if (!historySnapshot.empty) {
        ctx.log(`User ${uid} not eligible for trial (has subscription history), continuing without trial`);
        trial = false;
      }
    }
  } else {
    // One-time purchases don't use trial or frequency. `once` is what a
    // one-time buy bills on, and it is written here rather than taken from the
    // caller: a checkout that asked for `annually` on a one-time product put
    // that word on the intent doc, the provider call and the confirmation URL
    // alike ([#668](https://github.com/Omega-JS-Stack/omega/issues/668)).
    trial = false;
    frequency = 'once';
  }

  // Validate discount code (if provided)
  let resolvedDiscount = null;
  if (discount) {
    const discountResult = discountCodes.validate(discount, user);
    if (!discountResult.valid) {
      return ctx.respond(`Invalid discount code: ${discount}`, { code: 400 });
    }
    resolvedDiscount = discountResult;
    ctx.log(`Discount validated: code=${resolvedDiscount.code}, percent=${resolvedDiscount.percent}, amount=${resolvedDiscount.amount}, duration=${resolvedDiscount.duration}`);
  }

  // Mint the order id against the intents that already exist. The id keys the
  // intent doc written below, so an unchecked repeat overwrote another
  // customer's checkout ([#664](https://github.com/Omega-JS-Stack/omega/issues/664)).
  const orderId = await OrderId.mint({ admin, ctx });

  ctx.log(`Generated orderId=${orderId}`);

  // Build redirect URLs
  const confirmationUrl = buildConfirmationUrl(omega.project.websiteUrl, { product, productId, productType, frequency, provider, trial, orderId, discount: resolvedDiscount });
  const cancelUrl = buildCancelUrl(omega.project.websiteUrl, { productId, frequency });

  // Every registry row has an intent module (provider-registry.test.js), so a
  // load that throws here is a framework bug, never the caller's
  const providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);

  // Create the intent via the provider
  let result;
  try {
    result = await providerModule.createIntent({
      uid,
      orderId,
      product,
      productId,
      frequency,
      trial,
      discount: resolvedDiscount,
      simulate,
      confirmationUrl,
      cancelUrl,
      ctx,
    });
  } catch (e) {
    // A REFUSAL the framework itself wrote is the one thing said out loud: a
    // discount code that covers the whole price leaves nothing for PayPal or
    // Coinbase to charge, and that is the buyer's own code and price to hear
    // rather than a fault to hide (`chargeableAmount()` in
    // libraries/payment/discount-codes.js codes it 400,
    // [#786](https://github.com/Omega-JS-Stack/omega/issues/786)).
    if (e.code === 400) {
      return ctx.respond(e.message, { code: 400 });
    }

    // The provider's own words stay in the logs — a client gets one neutral
    // sentence, never an SDK message naming our internals ([#212]).
    ctx.error(`Failed to create ${provider} intent: uid=${uid}, product=${productId}, error=${e.message}`);
    return ctx.respond('We could not start your checkout right now. Please try again shortly.', { code: 500 });
  }

  ctx.log(`${provider} intent created: id=${result.id}, url=${result.url}`);

  // Build timestamps
  const now = powertools.timestamp(new Date(), { output: 'string' });
  const nowUNIX = powertools.timestamp(now, { output: 'unix' });

  // Save to payments-intents collection (keyed by orderId for consistent lookup with payments-orders)
  await admin.firestore().doc(`payments-intents/${orderId}`).set({
    id: orderId,
    intentId: result.id,
    provider: provider,
    owner: uid,
    status: 'pending',
    productId: productId,
    type: productType,
    frequency: frequency,
    trial: trial,
    attribution: attribution,
    trackingConsent: trackingConsent,
    // The CUSTOMER's request context, captured here because this is the only
    // moment the backend hears from their browser: the webhook that completes
    // the order arrives from the provider's servers. Meta and TikTok match a
    // server conversion to the browsing session on exactly this pair
    // ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)), and the
    // order fold copies it off the intent.
    request: {
      ip: ctx.request.geolocation?.ip || null,
      userAgent: ctx.request.client?.userAgent || null,
    },
    discount: resolvedDiscount,
    supplemental: supplemental,
    raw: result.raw,
    metadata: {
      created: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
    },
  });

  ctx.log(`Saved payments-intents/${orderId}: uid=${uid}, product=${productId}, type=${productType}, frequency=${frequency}, trial=${trial}`);

  // Tell the abandoned-cart sweep this shopper is mid-checkout. Asking for a
  // provider session is the loudest "buying it right now" the backend ever
  // hears, and the cart's reminder clock was otherwise set once, when the page
  // opened, and never moved — so a shopper still working through the checkout
  // was mailed about the cart they were paying for
  // ([#655](https://github.com/Omega-JS-Stack/omega/issues/655)).
  //
  // Fire-and-forget, and an `update` on purpose: a checkout reached without the
  // page's cart tracker (an unauthenticated page load, a direct link) has no
  // cart, and this must never CREATE one the sweep would then chase.
  admin.firestore().doc(`${CART_COLLECTION}/${uid}`).update({ lastActivityAt: nowUNIX })
    .then(() => ctx.log(`Updated ${CART_COLLECTION}/${uid}: lastActivityAt=${nowUNIX}`))
    .catch((e) => {
      // Not-found is the ordinary case above, not a fault
      if (e.code !== 5) {
        ctx.error(`Failed to stamp checkout activity on ${CART_COLLECTION}/${uid}: ${e.message}`);
      }
    });

  return ctx.respond({
    id: result.id,
    orderId: orderId,
    url: result.url,
    // What the server actually RECEIVED to match this conversion with — key
    // NAMES only, never a value ([#577](https://github.com/Omega-JS-Stack/omega/issues/577)).
    // The dev palette reads the browser's side of the same question off the
    // document; this is the only way to see which of those cookies survived the
    // trip, which is exactly where a blocked pixel shows up.
    attribution: {
      cookies: Object.keys(attribution?.cookies || {}),
    },
  });
};

/**
 * Which half of the purchaser is missing, if either
 *
 * @param {object} admin - The firebase-admin app
 * @param {string} uid - The authenticated caller's uid
 * @returns {Promise<string|null>} What is missing, phrased for the log line, or null when both exist
 */
async function findMissingPurchaser(admin, uid) {
  // The omega-admin-key lane authenticates with no user token, so there may be no
  // uid to look up at all — getUser('') throws, which would answer a 500 where the
  // whole point is a loud 403
  if (!uid) {
    return 'no auth user';
  }

  if (!await hasAuthUser(admin, uid)) {
    return 'no auth user';
  }

  const userDoc = await admin.firestore().doc(`users/${uid}`).get();

  return userDoc.exists ? null : 'no user doc';
}

/**
 * Build the cancel/back redirect URL
 */
function buildCancelUrl(baseUrl, { productId, frequency }) {
  const url = new URL('/payment/checkout', baseUrl);
  url.searchParams.set('product', productId);

  if (frequency) {
    url.searchParams.set('frequency', frequency);
  }

  url.searchParams.set('payment', 'cancelled');

  return url.toString();
}
