import path from 'path';
import powertools from 'node-powertools';
import transitions from './transitions/index.js';
import { trackPayment, isTrialConversion } from './analytics.js';
import loadProvider from '../../../libraries/load-provider.js';
import { hasAuthUser } from '../../../libraries/auth-user.js';
import account from '../../../helpers/account.js';

/**
 * Firestore trigger: payments-webhooks/{eventId} onWrite
 *
 * Processes pending webhook events:
 * 1. Loads the provider library
 * 2. Fetches the resource from the provider API — the ONLY trusted source, never
 *    the object the webhook payload carried (a lookup that cannot be answered
 *    refuses or defers, it never processes)
 * 3. Branches on event.category to transform + write:
 *    - subscription → toUnifiedSubscription → users/{uid}.subscription + payments-orders/{orderId}
 *    - one-time    → toUnifiedOneTime → payments-orders/{orderId}
 * 4. Detects state transitions and dispatches handler files (non-blocking)
 * 5. Marks the webhook as completed
 */
export default async ({ ctx, context, change }) => {
  const omega = ctx.omega;
  const admin = omega.firebase.admin;

  const dataAfter = change.after.data();

  // Short-circuit: deleted doc or non-pending status
  if (!dataAfter || dataAfter.status !== 'pending') {
    return;
  }

  const eventId = context.params.eventId;
  const webhookRef = admin.firestore().doc(`payments-webhooks/${eventId}`);

  // A doc that already completed once and is pending again is a REPROCESS (a
  // redelivery, or a doc put back to pending) — the transitions that fire on the
  // event type alone must not dispatch their email a second time.
  const previouslyCompleted = change.before.data()?.status === 'completed';

  // Set status to processing
  await webhookRef.set({ status: 'processing' }, { merge: true });

  // Hoisted so orderId is available in catch block for audit trail
  let orderId = null;
  let passThruOrderId = null;
  let library = null;

  // Whether this event was REFUSED — a terminal decision, taken before anything is
  // written. The failure path reads it: a refusal that could not even record itself
  // must not fall back to writing a doc the PAYLOAD named
  // ([#535](https://github.com/Omega-JS-Stack/omega/issues/535)).
  let refused = false;

  // The transition claim this run WON, once it has one — hoisted because the claim
  // outlives the block that took it. It is settled at the end of the run: 'done'
  // when the pipeline got all the way through, 'failed' beside the webhook doc's
  // own failure stamp, so the cron's retry of this same event id can retake it
  // ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
  const claimTicket = { orderId: null, transitionName: null };

  try {
    const provider = dataAfter.provider;
    // What the event's own payload claimed about whose subscription this is. It
    // is a CLAIM, not the answer: once the lookup succeeds, the provider's record
    // is what steers the write and this is only what that is checked against
    // ([#509](https://github.com/Omega-JS-Stack/omega/issues/509)).
    const payloadUid = dataAfter.owner;
    let uid = payloadUid;
    const raw = dataAfter.raw;
    const eventType = dataAfter.event?.type;
    const category = dataAfter.event?.category;
    const resourceType = dataAfter.event?.resourceType;
    const resourceId = dataAfter.event?.resourceId;
    // The refund's OWN id, which the parser keeps beside the resource the refund
    // reversed — an identifier, and the key its details are looked up by
    // ([#510](https://github.com/Omega-JS-Stack/omega/issues/510)).
    const refundId = dataAfter.event?.refundId || null;
    // THIS charge's own id, where the event names one — the id one charge is
    // reported to the platforms under
    // ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).
    const chargeId = dataAfter.event?.chargeId || null;

    ctx.log(`Processing webhook ${eventId}: provider=${provider}, eventType=${eventType}, category=${category}, resourceType=${resourceType}, resourceId=${resourceId}, uid=${uid || 'null'}`);

    // Validate category
    if (!category) {
      throw new Error(`Webhook event has no category — cannot process`);
    }

    // Load the shared library for this provider
    try {
      library = loadProvider(path.join(import.meta.dirname, '../../../libraries/payment/providers'), provider);
    } catch (e) {
      throw new Error(`Unknown provider library: ${provider}`);
    }

    // Fetch the resource from the provider API. Its answer is the ONLY thing this
    // pipeline acts on: the object the webhook carried is whatever the caller
    // posted, and letting it stand in for a lookup that failed let unverified data
    // drive real subscription state and real conversions
    // ([#506](https://github.com/Omega-JS-Stack/omega/issues/506)). So a failed
    // lookup produces no resource at all — only which KIND of failure it was.
    let resource;

    // What a refund actually moved. It rides in the same block because it is the
    // same kind of thing: an amount read out of the envelope is an amount the
    // caller chose, and it was landing on the order record, the customer's refund
    // email and the refund conversion
    // ([#510](https://github.com/Omega-JS-Stack/omega/issues/510)). The provider
    // answers for it too — from the resource already in hand, or from a lookup of
    // the refund's own record — and a lookup that fails is classified by the same
    // seam as the one above.
    const isRefund = transitions.REFUND_EVENTS.includes(eventType);
    let refundDetails = null;

    try {
      resource = await library.fetchResource(resourceType, resourceId, { admin, ctx, eventType, raw, config: omega.config });

      if (isRefund && library.getRefundDetails) {
        refundDetails = await library.getRefundDetails(resource, { raw, refundId, eventType, resourceType, ctx });
      }
    } catch (e) {
      // The provider answered, and the record it answered with belongs to another
      // order: the refund lookup's key came from the payload, and an unrelated
      // refund id from the same merchant account imported another customer's
      // numbers onto this one ([#532](https://github.com/Omega-JS-Stack/omega/issues/532)).
      // No retry can relate two unrelated records, so it is refused and
      // acknowledged — the same terminal shape as every other decision here.
      if (e.refundNotLinked) {
        refused = true;

        await acknowledgeRefusal(webhookRef, refuseRefundNotLinked({ ctx, error: e, eventId, eventType, provider, uid }), { ctx, eventId, eventType, provider, uid });

        return;
      }

      // Unreachable is not "gone": the answer exists and this attempt could not read
      // it, so the event DEFERS — the throw marks the doc failed and the retry sweep
      // (events/cron/frequent/retry-failed-webhooks.js) is the reconciliation path.
      if (!e.notFound) {
        throw e;
      }

      // The provider affirmatively does not have it. Nothing will ever make this
      // event processable, so it is refused and acknowledged rather than redelivered
      // forever — the same terminal-decision shape as the refusals below.
      //
      // The failure names the lookup that actually missed, which is not always the
      // event's own resource: a refund's details come from a lookup of their own
      // ([#510](https://github.com/Omega-JS-Stack/omega/issues/510)).
      refused = true;

      await acknowledgeRefusal(webhookRef, refuseResourceNotFound({
        ctx,
        error: e,
        eventId,
        eventType,
        provider,
        resourceType: e.resourceType || resourceType,
        resourceId: e.resourceId || resourceId,
        uid,
      }), { ctx, eventId, eventType, provider, uid });

      return;
    }

    // v2 resources spell the field `status`, v1 sale resources spell it `state` —
    // reading only the first reported `status=unknown` on a fetch that plainly
    // succeeded, which is exactly the confusion this line exists to prevent
    // ([#347](https://github.com/Omega-JS-Stack/omega/issues/347)).
    const resourceStatus = resource.status ?? resource.state ?? 'unknown';
    ctx.log(`Fetched resource: type=${resourceType}, id=${resourceId}, status=${resourceStatus}, source=provider API`);

    // The lookup answered, so the record it answered with is what says who this
    // event belongs to. Every provider's resource carries the uid we put on it —
    // Stripe `metadata.uid`, PayPal `custom_id`, Chargebee `meta_data`/`cf_uid` —
    // and reading the payload's uid instead let an event naming a REAL resource
    // steer that resource's write onto whatever uid the caller typed
    // ([#509](https://github.com/Omega-JS-Stack/omega/issues/509)). It also covers
    // what this block was originally for: events like PAYMENT.SALE, whose payload
    // carries no custom_id at all while the parent subscription does.
    const providerUid = library.getUid ? library.getUid(resource) : null;

    // Chargebee hosted-page checkouts don't forward subscription[meta_data] to the
    // subscription, so the record answers no uid at all — but the hosted page's
    // pass_thru_content holds ours, and it is a record of the PROVIDER's, not the
    // caller's. It used to be consulted only when the payload claimed nothing
    // (`!uid`), i.e. never in the one case where a claim needed checking: a forged
    // uid on a not-yet-backfilled subscription steered unchecked
    // ([#533](https://github.com/Omega-JS-Stack/omega/issues/533)).
    let resolvedFromPassThru = false;

    if (providerUid) {
      // The payload's claim is only ever a cross-check now, and a claim that
      // contradicts the provider is refused outright — not silently corrected to
      // the provider's uid, because an event that lies about its owner has
      // nothing left in it worth acting on.
      if (payloadUid && payloadUid !== providerUid) {
        refused = true;

        await acknowledgeRefusal(webhookRef, refuseUidMismatch({ ctx, eventId, eventType, provider, resourceType, resourceId, payloadUid, providerUid, source: 'record' }), { ctx, eventId, eventType, provider, uid });

        return;
      }

      if (uid !== providerUid) {
        uid = providerUid;
        ctx.log(`UID resolved from fetched resource: uid=${uid}, provider=${provider}, resourceType=${resourceType}`);

        // Update the webhook doc with the resolved UID so it's persisted for debugging
        await webhookRef.set({ owner: uid }, { merge: true });
      }
    } else {
      const passThruResult = library.resolveUidFromHostedPage
        ? await library.resolveUidFromHostedPage(resourceId, ctx)
        : null;

      if (passThruResult?.uid) {
        // The hosted page answered, so it is the record that steers — and a payload
        // that contradicts it earns the same refusal a contradicted record does.
        if (payloadUid && payloadUid !== passThruResult.uid) {
          refused = true;

          await acknowledgeRefusal(webhookRef, refuseUidMismatch({ ctx, eventId, eventType, provider, resourceType, resourceId, payloadUid, providerUid: passThruResult.uid, source: 'hosted-page' }), { ctx, eventId, eventType, provider, uid });

          return;
        }

        uid = passThruResult.uid;
        passThruOrderId = passThruResult.orderId || null;
        resolvedFromPassThru = true;
        ctx.log(`UID resolved from hosted page pass_thru_content: uid=${uid}, orderId=${passThruOrderId}, resourceId=${resourceId}`);

        await webhookRef.set({ owner: uid }, { merge: true });
      } else if (payloadUid) {
        // Nothing left to check against: the record carries no uid, and no other
        // record of this provider's answered either — the hosted-page scan covers
        // only the last 25, so a miss honestly means "not in the window", never
        // "not this uid", and refusing on it would break every older hosted-page
        // checkout. The payload steers, which is the pre-#509 behavior — so the
        // line that says so is the only warning a human gets that this write was
        // never cross-checked.
        ctx.warn(`UID FALLBACK: ${eventType} (${provider}) — ${resourceType} ${resourceId} carries no uid metadata and no other ${provider} record answered for it, so the event's own payload steers this write unchecked (uid=${payloadUid}, event=${eventId})`);
      }
    }

    // Validate UID — must have one by now
    if (!uid) {
      throw new Error(`Webhook event has no UID — could not extract from webhook parse, fetched ${resourceType} resource, or hosted page pass_thru_content`);
    }

    // Backfill: if UID was resolved from pass_thru_content, set meta_data on the subscription
    // so future webhooks (renewals, cancellations) can resolve the UID directly
    if (resolvedFromPassThru && resourceType === 'subscription' && library.setMetaData) {
      library.setMetaData(resource, { uid, orderId: passThruOrderId })
        .then(() => ctx.log(`Backfilled meta_data on subscription ${resourceId} + customer: uid=${uid}, orderId=${passThruOrderId}`))
        .catch((e) => ctx.error(`Failed to backfill meta_data on ${resourceType} ${resourceId}: ${e.message}`));
    }

    // Build timestamps
    const now = powertools.timestamp(new Date(), { output: 'string' });
    const nowUNIX = powertools.timestamp(now, { output: 'unix' });
    const webhookReceivedUNIX = dataAfter.metadata?.created?.timestampUNIX || nowUNIX;

    // Extract orderId from resource (provider-agnostic)
    // Falls back to pass_thru_content orderId when meta_data wasn't available on the resource
    orderId = library.getOrderId(resource) || passThruOrderId;

    // Process the payment event (subscription or one-time)
    if (category !== 'subscription' && category !== 'one-time') {
      throw new Error(`Unknown event category: ${category}`);
    }

    const { transition, refusal } = await processPaymentEvent({ category, library, resource, resourceType, uid, provider, eventType, eventId, resourceId, chargeId, orderId, now, nowUNIX, webhookReceivedUNIX, previouslyCompleted, ctx, isRefund, refundDetails, claimTicket });

    // Mark webhook as completed (include transition name + any refusal for auditing/testing).
    // Both are written on EVERY pass, so a reprocess that now finds its order clears
    // the refusal it was stamped with rather than leaving a stale flag behind.
    await webhookRef.set({
      status: 'completed',
      owner: uid,
      orderId: orderId,
      transition: transition,
      refusal: refusal,
      metadata: {
        completed: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
    }, { merge: true });

    ctx.log(`Webhook ${eventId} completed`);

    // The transition is finished: its handler, its analytics fire and its marketing
    // sync are all away. Last, so a throw anywhere above still settles as `failed`.
    await transitions.settleClaim({ admin, claim: claimTicket, status: 'done' });
  } catch (e) {
    ctx.error(`Webhook ${eventId} failed: ${e.message}`, e);

    const now = powertools.timestamp(new Date(), { output: 'string' });
    const nowUNIX = powertools.timestamp(now, { output: 'unix' });

    // Mark as failed with error message, counting the attempt — the frequent cron's
    // sweep re-flips a failed doc to pending until this count reaches its ceiling
    // (events/cron/frequent/retry-failed-webhooks.js)
    //
    // Unless the failure is PERMANENT: a malformed envelope is a programmer/parser
    // error, not a provider that could not be reached, and deferring it burned the
    // whole ladder before dead-lettering something the first attempt already knew
    // was unprocessable ([#536](https://github.com/Omega-JS-Stack/omega/issues/536)).
    // Dead-lettered where it stands, so the sweep leaves it for the human it needs.
    await webhookRef.set({
      status: 'failed',
      error: e.message || String(e),
      retryCount: (dataAfter.retryCount || 0) + 1,
      ...(e.permanent ? { deadLetter: true } : {}),
    }, { merge: true });

    // And release the claim the same way: the sweep re-runs this event id, and a
    // claim left standing would refuse the retry that is meant to finish the job.
    await transitions.settleClaim({ admin, claim: claimTicket, status: 'failed' });

    if (e.permanent) {
      ctx.error(`PERMANENT FAILURE: webhook ${eventId} (provider=${dataAfter.provider}, event=${dataAfter.event?.type || 'unknown'}) cannot be processed by any retry — dead-lettered on its first attempt: ${e.message}`);
    }

    // A REFUSED event is already terminal: the decision was made, and the only thing
    // that failed is the stamp recording it. The payload-derived intent write below
    // is the one doc a refused forgery could still reach — named by the caller, not
    // by anything the provider confirmed — so a refusal writes nothing else at all,
    // and the retry sweep re-lands the stamp on the next pass
    // ([#535](https://github.com/Omega-JS-Stack/omega/issues/535)).
    if (refused) {
      ctx.warn(`Webhook ${eventId} was REFUSED and its refusal stamp did not land (${e.message}) — nothing else is written for a refused event, and the retry sweep re-lands the stamp`);

      return;
    }

    // A throw before the orderId was resolved (a fetchResource failure, an
    // unresolvable UID) would otherwise leave the intent pending forever — resolve
    // it from what IS available: the webhook doc, or the raw payload the provider
    // library can read an orderId out of.
    if (!orderId) {
      orderId = resolveOrderIdAfterFailure({ dataAfter, library, ctx }) || passThruOrderId;

      if (orderId) {
        ctx.log(`Resolved orderId ${orderId} for failed webhook ${eventId} from the webhook payload`);
      } else {
        ctx.warn(`Webhook ${eventId} failed with no resolvable orderId — its payments-intents doc (if any) stays pending and needs manual reconciliation`);
      }
    }

    // Mark intent as failed if we resolved the orderId before the error
    if (orderId) {
      await admin.firestore().doc(`payments-intents/${orderId}`).set({
        status: 'failed',
        error: e.message || String(e),
        metadata: {
          completed: {
            timestamp: now,
            timestampUNIX: nowUNIX,
          },
        },
      }, { merge: true });
    }
  }
};

/**
 * Acknowledge an event the pipeline decided not to act on
 *
 * A refusal is a DECISION, not a failure: the doc completes so the provider stops
 * redelivering an event nothing here will ever act on, the retry ladder is left
 * untouched, and the stamp on the event's own doc — which already carries the
 * payload as delivered (`raw`) — is what a human reconciles from. The one shape
 * every terminal refusal taken before processing writes.
 *
 * It is also where the family REPORTS itself
 * ([#550](https://github.com/Omega-JS-Stack/omega/issues/550)): a refusal is an
 * attack signal, and a stamp plus a log line is only ever read by someone
 * already looking. One capture at the shared seam, so every reason reports
 * exactly once and a new one inherits it for free — never a capture per catch.
 *
 * @param {object} webhookRef - The event's own Firestore document reference
 * @param {object} refusal - The stamp from the refuse*() that decided it
 * @param {object} event - What the report names the refusal by
 * @param {object} event.ctx - Assistant instance
 * @param {string} event.eventId - The webhook doc id (the provider's event id)
 * @param {string} event.eventType - The provider's event name
 * @param {string} event.provider - The provider that sent it
 * @param {string|null} event.uid - The owner the event resolved to, if any
 */
async function acknowledgeRefusal(webhookRef, refusal, { ctx, eventId, eventType, provider, uid }) {
  const refusedAt = powertools.timestamp(new Date(), { output: 'string' });

  reportRefusal(ctx, {
    message: `Payment webhook refused: ${refusal.reason} (${eventType} from ${provider}, event=${eventId})`,
    refusal: refusal,
    eventId: eventId,
    eventType: eventType,
    provider: provider,
    uid: uid,
  });

  await webhookRef.set({
    status: 'completed',
    transition: null,
    refusal: refusal,
    metadata: {
      completed: {
        timestamp: refusedAt,
        timestampUNIX: powertools.timestamp(refusedAt, { output: 'unix' }),
      },
    },
  }, { merge: true });
}

/**
 * Report a refusal to the error reporter, as a warning
 *
 * The ONE place this pipeline assembles a capture. `libraries.sentry` is the
 * backend's one capture handle (context/respond.js reads the same one)
 * and is null whenever no DSN is configured, so the optional chain IS the no-op.
 * WARNING, not an exception: nothing here failed — the pipeline made a decision,
 * correctly.
 *
 * IDS ONLY, per the scrub rules ([docs/shared/monitoring.md]): the refusal stamp
 * the refuse*() built is what rides, plus the event's own identifiers. The
 * payload never does, and no email is assembled at all, so there is nothing for
 * the scrub to take out.
 *
 * Reported BEFORE the stamp is written, deliberately: a refusal whose stamp
 * could not land ([#535](https://github.com/Omega-JS-Stack/omega/issues/535)) is
 * more alarming than one that did, not less.
 *
 * @param {object} ctx - Assistant instance
 * @param {object} options
 * @param {string} options.message - What the dashboard shows as the title
 * @param {object} options.refusal - The stamp from the refuse*() that decided it
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string|null} options.uid - The owner the event resolved to, if any
 * @param {object} [options.extra] - Ids beyond the stamp's own, if the refusal has any
 */
function reportRefusal(ctx, { message, refusal, eventId, eventType, provider, uid, extra = {} }) {
  ctx.omega.sentry?.captureMessage?.(message, {
    level: 'warning',
    // Searchable on the dashboard: the reason groups the family, the provider
    // says who sent it, and the event id is what a human looks the delivery up
    // by in the provider's own dashboard.
    tags: {
      refusal: refusal.reason,
      provider: provider,
      eventId: eventId,
    },
    ...(uid ? { user: { id: uid } } : {}),
    extra: {
      ...refusal,
      eventId: eventId,
      eventType: eventType,
      provider: provider,
      uid: uid || null,
      ...extra,
    },
  });
}

/**
 * Read the resource out of a webhook envelope
 *
 * Every provider nests it somewhere else — Stripe at data.object, Chargebee at
 * content.<type>, PayPal at resource — so each library names its own shape.
 *
 * IDENTIFIERS ONLY. What comes back is the caller's own object, so it may name
 * which order a failed event belongs to and nothing more; the state a resource is
 * IN comes from the provider's lookup, never from here
 * ([#506](https://github.com/Omega-JS-Stack/omega/issues/506)).
 *
 * The Stripe-shaped default below serves the null-library case only (the library
 * failed to load); every provider library, test included, exports extractResource().
 *
 * @param {object|null} library - Provider library (null when loading it was what failed)
 * @param {object} raw - The raw webhook payload the provider sent
 * @returns {object|null}
 */
function extractRawResource(library, raw) {
  if (library?.extractResource) {
    return library.extractResource(raw);
  }

  return raw?.data?.object || null;
}

/**
 * Resolve the orderId for a webhook that threw before the happy path resolved one
 *
 * @param {object} options
 * @param {object} options.dataAfter - The webhook doc's data
 * @param {object|null} options.library - Provider library (null when loading it was what failed)
 * @param {object} options.ctx - Assistant instance
 * @returns {string|null}
 */
function resolveOrderIdAfterFailure({ dataAfter, library, ctx }) {
  // An earlier pass may already have stamped it on the doc
  if (dataAfter.orderId) {
    return dataAfter.orderId;
  }

  const rawObject = extractRawResource(library, dataAfter.raw);

  if (!library?.getOrderId || !rawObject) {
    return null;
  }

  // The same extraction the happy path uses, over the webhook payload instead of
  // the fetched resource
  try {
    return library.getOrderId(rawObject) || null;
  } catch (e) {
    ctx.error(`resolveOrderIdAfterFailure(): ${dataAfter.provider} getOrderId() threw on the webhook payload: ${e.message}`, e);
    return null;
  }
}

/**
 * Process a payment event (subscription or one-time)
 * 1. Staleness check
 * 2. Read user doc (for transition detection)
 * 3. Transform raw resource → unified object
 * 4. Build order object
 * 5. Detect and dispatch transition handlers (non-blocking)
 * 6. Track analytics (non-blocking)
 * 7. Write to Firestore in ONE batch (user doc for subscriptions + payments-orders + payments-intents)
 *
 * @returns {Promise<{ transition: string|null, refusal: object|null }>} What the
 *   caller stamps back on the event doc: the transition detected, and the refusal
 *   when the pipeline declined to act on the event at all.
 */
async function processPaymentEvent({ category, library, resource, resourceType, uid, provider, eventType, eventId, resourceId, chargeId, orderId, now, nowUNIX, webhookReceivedUNIX, previouslyCompleted, ctx, isRefund, refundDetails, claimTicket }) {
  const omega = ctx.omega;
  const admin = omega.firebase.admin;
  const isSubscription = category === 'subscription';

  // Staleness check: skip if a newer webhook already wrote to this order
  let existingOrder = null;

  if (orderId) {
    const existingDoc = await admin.firestore().doc(`payments-orders/${orderId}`).get();
    if (existingDoc.exists) {
      existingOrder = existingDoc.data();
      const existingUpdatedUNIX = existingOrder.metadata?.updated?.timestampUNIX || 0;
      if (webhookReceivedUNIX < existingUpdatedUNIX) {
        ctx.log(`Stale webhook ${eventId}: received=${webhookReceivedUNIX}, existing updated=${existingUpdatedUNIX}, skipping`);
        return { transition: null, refusal: null };
      }
    }
  } else {
    // The guard keys on the order — without one, an out-of-order delivery cannot be
    // detected at all. Processing continues, but the unguarded window is visible.
    ctx.warn(`Webhook ${eventId} has no orderId (provider=${provider}, ${resourceType} ${resourceId}) — the staleness guard cannot run, so an out-of-order delivery for this resource would be applied as-is`);
  }

  // A refund UPDATES a purchase — it can never DEFINE one. With no order record
  // behind it, the refund event used to be read as a fresh purchase definition:
  // payments-orders/{orderId} was minted with `unified.status: 'completed'` and the
  // REFUND's id as the resource, so a reversal was booked as revenue while the
  // trail said one-time/purchase-refunded. Reachable whenever the purchase write is
  // missing — a lost or failed purchase webhook, a webhook registered after the
  // sale, or PayPal delivering REFUNDED before the capture.
  //
  // So the pipeline refuses, loudly, and writes nothing else: the refusal is stamped
  // on the event's own doc for a human to reconcile from, which surfaces the lost
  // purchase webhook instead of letting it masquerade as revenue
  // ([#335](https://github.com/Omega-JS-Stack/omega/issues/335)).
  if (!isSubscription && isRefund && !existingOrder?.unified) {
    return {
      transition: null,
      refusal: refuseRefundWithoutOrder({ ctx, resource, refundDetails, eventId, eventType, provider, resourceType, resourceId, uid, orderId }),
    };
  }

  // Read current user doc (needed for transition detection + handler context)
  const userDoc = await admin.firestore().doc(`users/${uid}`).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const before = isSubscription ? (userData.subscription || null) : null;

  ctx.log(`User doc for ${uid}: exists=${userDoc.exists}, email=${userData?.auth?.email || 'null'}, name=${userData?.personal?.name?.first || 'null'}, subscription=${userData?.subscription?.product?.id || 'null'}`);

  // A user doc is born at SIGNUP, never at a payment event. A uid with no auth
  // user in this project is not this project's customer at all: a QA checkout run
  // against the emulator with real test-mode keys delivers its webhooks to the
  // DEPLOYED backend (the emulator has no webhook path), and the event minted a
  // LIVE users/{uid} holding nothing but a subscription block
  // ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)).
  //
  // So an absent user doc has to prove the uid before anything is written under
  // it. A doc that already exists takes no auth lookup and no new behavior — an
  // update or a delete creates nothing, so it is left exactly as it was.
  if (!userDoc.exists && !(await hasAuthUser(admin, uid))) {
    return {
      transition: null,
      refusal: refuseUserWithoutAuth({ ctx, eventId, eventType, provider, uid, orderId }),
    };
  }

  // Auto-fill user name from payment provider if not already set
  if (!userData?.personal?.name?.first) {
    const customerName = await extractCustomerName(resource, resourceType);
    if (customerName?.first) {
      await admin.firestore().doc(`users/${uid}`).set({
        personal: { name: customerName },
      }, { merge: true });
      ctx.log(`Auto-filled user name from ${resourceType}: ${customerName.first} ${customerName.last || ''}`);
    }
  }

  // Transform raw resource → unified object
  const transformOptions = { config: omega.config, eventName: eventType, eventId: eventId };
  let unified = isSubscription
    ? library.toUnifiedSubscription(resource, transformOptions)
    : library.toUnifiedOneTime(resource, transformOptions);

  // Override: immediately suspend on payment denial
  // Providers keep the sub active while retrying, but we revoke access right away.
  // If the retry succeeds (e.g. PAYMENT.SALE.COMPLETED), it will restore active status.
  // PayPal: PAYMENT.SALE.DENIED, Stripe: invoice.payment_failed, Chargebee: payment_failed
  const PAYMENT_DENIED_EVENTS = ['PAYMENT.SALE.DENIED', 'invoice.payment_failed', 'payment_failed'];
  if (isSubscription && PAYMENT_DENIED_EVENTS.includes(eventType) && unified.status === 'active') {
    ctx.log(`Overriding status to suspended: ${eventType} received but provider still says active`);
    unified.status = 'suspended';
  }

  // A refund UPDATES a purchase record — it does not redefine the purchase.
  //
  // A one-time refund's resource is the bare charge that moved the money back: it
  // names no product and no price, so re-deriving the order from it degraded a
  // completed purchase to product=unknown and price=0, and replaced the checkout
  // resourceId with the charge id. Merge instead — the purchase stays exactly what
  // it was, and only the refund outcome is written
  // ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)). A one-time refund
  // with no purchase to merge onto never reaches here — the guard above refused it.
  const isOneTimeRefund = !isSubscription && isRefund;

  if (isOneTimeRefund) {
    unified = applyRefundToPurchase(existingOrder.unified, unified, { refundDetails, now, nowUNIX });
  }

  ctx.log(`Unified ${category}: product=${unified.product.id}, status=${unified.status}`, unified);

  // Read checkout context from payments-intents (attribution, trackingConsent, request, discount, supplemental)
  let intentData = {};
  if (orderId) {
    const intentDoc = await admin.firestore().doc(`payments-intents/${orderId}`).get();
    intentData = intentDoc.exists ? intentDoc.data() : {};
  }

  // Build the order object (single source of truth for handlers + Firestore)
  const order = {
    id: orderId,
    type: category,
    owner: uid,
    productId: unified.product.id,
    provider: provider,
    // A refund event names the charge that reversed the payment, never the
    // checkout resource the purchase was made through — keep the purchase's own
    resourceId: isOneTimeRefund ? (existingOrder.resourceId || resourceId) : resourceId,
    unified: unified,
    attribution: intentData.attribution || {},
    trackingConsent: intentData.trackingConsent || null,
    // The requester's IP + user agent, captured when the intent was created —
    // what Meta and TikTok match a server conversion to the browsing session on
    // ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)). A webhook's
    // own request is the PROVIDER's, never the customer's, so this can only
    // come from the intent.
    request: intentData.request || null,
    discount: intentData.discount || null,
    supplemental: intentData.supplemental || {},
    metadata: {
      created: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
      updated: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
      updatedBy: {
        event: {
          name: eventType,
          id: eventId,
        },
      },
    },
  };

  // Detect and dispatch transition (non-blocking)
  const shouldRunHandlers = !ctx.isTesting() || process.env.TEST_EXTENDED_MODE;
  const transitionName = transitions.detectTransition(category, before, unified, eventType, { previouslyCompleted });

  if (!transitionName && previouslyCompleted && isRefund) {
    ctx.log(`Transition suppressed (idempotency): webhook ${eventId} already completed once, so its refund email was already sent`);
  }

  // The event that LOST the claim below, once there is one. Everything the
  // transition drives reads it: the handler, the analytics fire, and the marketing
  // sync were all three duplicated by the racing pair, so all three are gated on it
  // ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
  let suppressedBy = null;

  if (transitionName) {
    ctx.log(`Transition detected: ${category}/${transitionName} (before.status=${before?.status || 'null'}, after.status=${unified.status})`);

    // Claim it before anything is dispatched. Detection is a diff against the
    // user doc, so two webhooks for the same checkout in flight at once BOTH
    // detect the same transition — the claim is what makes only one of them act
    // on it ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)). Without
    // an order there is nothing to claim on, exactly as the staleness guard above
    // has nothing to compare against, and the dispatch goes out unguarded.
    const claim = orderId
      ? await transitions.claim({ admin, orderId, transitionName, eventId, now, nowUNIX })
      : { claimed: true, eventId: eventId };

    if (!claim.claimed) {
      suppressedBy = claim.eventId;
      ctx.log(`Transition suppressed (claimed by ${suppressedBy}): ${category}/${transitionName} on payments-orders/${orderId}`);
    } else {
      // Hand the claim to the trigger, which settles it once the run ends. Only the
      // run that TOOK a claim may settle it, so a loser hands over nothing.
      claimTicket.orderId = orderId;
      claimTicket.transitionName = transitionName;

      if (shouldRunHandlers) {
        transitions.dispatch(transitionName, category, {
          before, after: unified, order, uid, userDoc: userData, ctx, refundDetails,
        });
      } else {
        ctx.log(`Transition handler skipped (testing mode): ${category}/${transitionName}`);
      }
    }
  }

  // Track payment analytics (non-blocking)
  // Fires independently of transitions — renewals have no transition but still need tracking.
  // `before` rides along for the same reason the transition detector reads it: a plan change
  // needs the plan it came from, and a trial's outcome is only legible against the prior term
  // ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).
  //
  // A run that lost the claim tracks NOTHING. The resolver is keyed on the
  // transition, so the duplicate fired the same conversion twice — GA4 counted two
  // `trial_start`s, deduplicating neither a custom event nor a second id
  // ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)). Nulling the
  // transition instead would be worse than doing nothing: the resolver's `!transitionName`
  // branches would read the duplicate as a RENEWAL and fire `subscription_payment`.
  if (suppressedBy) {
    ctx.log(`Payment analytics suppressed (claimed by ${suppressedBy}): ${category}/${transitionName} was already tracked`);
  } else if (shouldRunHandlers) {
    trackPayment({ category, transitionName, eventType, unified, order, userDoc: userData, refundDetails, before, uid, provider, chargeId, ctx });
  } else {
    ctx.log(`Payment analytics skipped (testing mode): ${category}/${transitionName || 'no transition'}`);
  }

  // A persisted discount belongs to the subscription it was applied to, and to
  // that one only ([#333]). The unified object carries no discount key at all,
  // so the merge below would preserve the node forever: a customer who churned
  // and resubscribed kept a spent claim on the new subscription, where the
  // billing card reads `source: 'winback'` as "already claimed" and silently
  // never pitches the save offer again, one the backend would grant.
  //
  // So the claim's stamp is compared against the subscription THIS event is
  // about, and a mismatch clears the node: a new subscription is a clean slate.
  // A node with no stamp was written before the stamp existed and nothing can
  // prove it belongs to an older subscription, so it is read as riding the one
  // it is found on (no live discount is ever taken away on a guess) and stamped
  // there, so it clears on the next resubscribe like any other.
  //
  // The gate needs the RESOURCE to be a subscription, not just the category: a
  // subscription-category event can ride an invoice or sale resource (Stripe
  // charge.refunded, PayPal raw-payload fallback), whose id would never match
  // the stamp and would wrongly clear a live discount.
  const claimedDiscount = isSubscription && resourceType === 'subscription' && before?.discount?.valid === true ? before.discount : null;
  const liveResourceId = unified.payment?.resourceId || null;
  let discountWrite = null;

  if (claimedDiscount && liveResourceId) {
    if (!claimedDiscount.resourceId) {
      discountWrite = { resourceId: liveResourceId };
      ctx.log(`Adopting users/${uid}.subscription.discount onto ${liveResourceId}: the claim carries no subscription stamp, so it is the one it is riding`);
    } else if (claimedDiscount.resourceId !== liveResourceId) {
      discountWrite = account.User.EMPTY_DISCOUNT;
      ctx.log(`Clearing users/${uid}.subscription.discount: claimed on ${claimedDiscount.resourceId}, this event is for ${liveResourceId}, so the discount ended with the subscription it was applied to`);
    }
  }

  // The three writes this event produces — the user's subscription, the order and
  // the intent — land TOGETHER. As separate awaits, anything that threw between
  // them left the state split: a user paid with no order behind it, or an order
  // whose intent still says pending. The batch makes it all-or-nothing.
  const batch = admin.firestore().batch();

  // Write unified subscription to user doc (subscriptions only)
  //
  // A charge that CONVERTED the trial stamps the outcome on its way past. The
  // provider payloads carry `trial.claimed` — "this subscription HAD a trial", true
  // for its whole life — and nothing else says the first paid charge happened, so
  // without the stamp the next renewal reads exactly like the conversion did
  // ([#697](https://github.com/Omega-JS-Stack/omega/issues/697)). It is STATE, not
  // reporting: it is written whether or not the analytics fire ran, and it is the
  // same field and the same value the trial-lapse sweep stamps when no webhook ever
  // announces the outcome, so the two paths cannot disagree about a trial's fate.
  if (isSubscription) {
    const subscriptionWrite = { ...unified };

    if (discountWrite) {
      subscriptionWrite.discount = discountWrite;
    }

    if (isTrialConversion({ transitionName, eventType, unified, before })) {
      subscriptionWrite.trial = { ...unified.trial, outcome: 'converted' };
      ctx.log(`Trial converted: stamping users/${uid}.subscription.trial.outcome=converted (the first paid charge on ${unified.payment?.resourceId})`);
    }

    batch.set(admin.firestore().doc(`users/${uid}`), {
      subscription: subscriptionWrite,
    }, { merge: true });
  }

  if (orderId) {
    const orderRef = admin.firestore().doc(`payments-orders/${orderId}`);
    const orderSnap = await orderRef.get();

    // Initialize requests on first creation only (avoid overwriting cancel/refund
    // data set by endpoints). Keyed on the field rather than the document: the
    // transition claim above writes `transitions` onto this same order first, so on
    // a brand-new order the document now EXISTS by the time the writes are built —
    // and a plain existence test would have left every new order without its
    // requests node ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
    if (!orderSnap.data()?.requests) {
      order.requests = {
        cancellation: null,
        refund: null,
      };
    }

    if (orderSnap.exists) {
      // Preserve original created timestamp on subsequent webhook events
      order.metadata.created = orderSnap.data().metadata?.created || order.metadata.created;
    }

    // Write to payments-orders/{orderId}
    batch.set(orderRef, order, { merge: true });

    // Update payments-intents/{orderId} status to match webhook outcome
    batch.set(admin.firestore().doc(`payments-intents/${orderId}`), {
      status: 'completed',
      metadata: {
        completed: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
    }, { merge: true });
  }

  await batch.commit();

  if (isSubscription) {
    ctx.log(`Updated users/${uid}.subscription: status=${unified.status}, product=${unified.product.id}`);

    // Sync marketing contact with updated subscription data (non-blocking).
    // Suppressed on a lost claim for the same reason the analytics fire is: the
    // winner syncs this exact subscription state, so the duplicate only re-sent the
    // same contact ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
    if (suppressedBy) {
      ctx.log(`Marketing sync suppressed (claimed by ${suppressedBy}): the subscription was already synced`);
    } else if (shouldRunHandlers) {
      const email = ctx.email;
      const updatedUserDoc = { ...userData, subscription: unified };
      email.sync(updatedUserDoc)
        .then((r) => ctx.log('Marketing sync after payment:', r))
        .catch((e) => ctx.error('Marketing sync after payment failed:', e));
    } else {
      ctx.log('Marketing sync skipped (testing mode)');
    }
  }

  if (orderId) {
    ctx.log(`Updated payments-orders/${orderId}: type=${category}, uid=${uid}, eventType=${eventType}`);
    ctx.log(`Updated payments-intents/${orderId}: status=completed`);
  }

  // Mark abandoned cart as completed (non-blocking, fire-and-forget)
  const { default: { COLLECTION } } = await import('../../../libraries/abandoned-cart-config.js');
  admin.firestore().doc(`${COLLECTION}/${uid}`).set({
    status: 'completed',
    metadata: {
      updated: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
    },
  }, { merge: true })
    .then(() => ctx.log(`Updated ${COLLECTION}/${uid}: status=completed`))
    .catch((e) => {
      // Ignore not-found — cart may not exist for this user
      if (e.code !== 5) {
        ctx.error(`Failed to update ${COLLECTION}/${uid}: ${e.message}`);
      }
    });

  return { transition: transitionName, refusal: null };
}

/**
 * Record a refund on the unified purchase it reversed
 *
 * The purchase — product, price, the resource it was bought through — is kept
 * exactly as the completed purchase wrote it. Only the outcome changes: the
 * status, the refund itself, and which event last touched the record.
 *
 * @param {object} purchase - The unified one-time object already on the order
 * @param {object} derived - The unified object derived from the refund's own resource
 * @param {object} options
 * @param {object|null} options.refundDetails - The library's { amount, currency, reason }
 * @param {string} options.now - Timestamp string
 * @param {number} options.nowUNIX - Timestamp seconds
 * @returns {object} Unified one-time object
 */
function applyRefundToPurchase(purchase, derived, { refundDetails, now, nowUNIX }) {
  return {
    ...purchase,
    status: 'refunded',
    payment: {
      ...purchase.payment,
      refund: {
        amount: refundDetails?.amount || null,
        currency: refundDetails?.currency || 'USD',
        reason: refundDetails?.reason || null,
        date: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
      updatedBy: derived.payment?.updatedBy || purchase.payment?.updatedBy || null,
    },
  };
}

/**
 * Refuse a refund that has no purchase behind it, loudly, and say so on the record
 *
 * The books are the point: nothing is written to payments-orders or
 * payments-intents, so no revenue is invented. What the reconciler needs is stamped
 * on the event's OWN doc, which already carries the refund payload as delivered
 * (`raw`), the owner and the order it named: the reason it was refused, and the id
 * of the capture the refund reversed — the only pointer back to the purchase whose
 * webhook never landed ([#335](https://github.com/Omega-JS-Stack/omega/issues/335)).
 *
 * @param {object} options
 * @param {object} options.ctx - Assistant instance
 * @param {object} options.resource - The refund resource fetched from the provider
 * @param {object|null} options.refundDetails - The library's { amount, currency, reason }
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string} options.resourceType - The parsed event's resource type
 * @param {string} options.resourceId - The refund's own id
 * @param {string} options.uid - The owner the event resolved to
 * @param {string|null} options.orderId - The order the refund named, which does not exist
 * @returns {{ reason: string, captureId: string|null }} The refusal stamp for the event doc
 */
function refuseRefundWithoutOrder({ ctx, resource, refundDetails, eventId, eventType, provider, resourceType, resourceId, uid, orderId }) {
  const captureId = extractParentResourceId(resource);

  ctx.error(`REFUND WITHOUT ORDER: ${eventType} (${provider}) reversed ${resourceType} ${resourceId} but payments-orders/${orderId || 'null'} does not exist — refusing to mint an order from a refund (owner=${uid}, capture=${captureId || 'unknown'}, amount=${refundDetails?.amount || 'unknown'} ${refundDetails?.currency || 'USD'}). Stamped on payments-webhooks/${eventId} as refusal.reason=refund-without-order: the purchase behind this refund never wrote an order and needs manual reconciliation`);

  return {
    reason: 'refund-without-order',
    captureId: captureId,
  };
}

/**
 * Refuse an event whose resource the provider does not have
 *
 * The lookup is the trust boundary: the provider answered, and its answer was that
 * this resource does not exist. The object the webhook carried says otherwise, but
 * it is only what the caller posted — processing off it is exactly the hole this
 * refusal closes ([#506](https://github.com/Omega-JS-Stack/omega/issues/506)).
 *
 * Acknowledged, not failed: no retry could ever turn a resource the provider does
 * not have into one it does, so the doc completes and the provider stops
 * redelivering an event nothing here will ever act on. Nothing else is written —
 * no subscription, no order, no intent, no conversion — and the stamp on the
 * event's own doc, which already holds the payload as delivered (`raw`), is what a
 * human reconciles from.
 *
 * @param {object} options
 * @param {object} options.ctx - Assistant instance
 * @param {Error} options.error - The classified failure the lookup threw
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string} options.resourceType - The parsed event's resource type
 * @param {string} options.resourceId - The resource the provider does not have
 * @param {string|null} options.uid - The owner the event parsed to, if any
 * @returns {{ reason: string, resourceType: string, resourceId: string }} The refusal stamp for the event doc
 */
function refuseResourceNotFound({ ctx, error, eventId, eventType, provider, resourceType, resourceId, uid }) {
  ctx.error(`RESOURCE NOT FOUND: ${eventType} (${provider}) named ${resourceType} ${resourceId}, which ${provider} does not have — refusing to process the event off the object its payload carried (event=${eventId}, owner=${uid || 'null'}): ${error.message}. Stamped on payments-webhooks/${eventId} as refusal.reason=resource-not-found`);

  return {
    reason: 'resource-not-found',
    resourceType: resourceType,
    resourceId: resourceId,
  };
}

/**
 * Refuse an event whose payload claims a different owner than the provider's record
 *
 * The lookup succeeded, so the provider named the uid this resource belongs to.
 * The payload named another one. Only one of the two can be acted on, and the
 * payload is whatever the caller posted — so an event naming a REAL subscription
 * with a forged metadata uid used to move that subscription onto the forged uid
 * ([#509](https://github.com/Omega-JS-Stack/omega/issues/509)).
 *
 * Refused, not corrected: the provider's uid is the trustworthy half, but an event
 * that lies about its owner has nothing left in it worth writing, and quietly
 * processing it under the real owner would hide the forgery. Acknowledged rather
 * than failed, for the same reason as every other terminal decision here — no
 * retry can make the payload agree with the record.
 *
 * @param {object} options
 * @param {object} options.ctx - Assistant instance
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string} options.resourceType - The parsed event's resource type
 * @param {string} options.resourceId - The resource the event named
 * @param {string} options.payloadUid - The owner the payload claimed
 * @param {string} options.providerUid - The owner the provider's record carries
 * @param {string} options.source - Which of the provider's records answered ('record' | 'hosted-page')
 * @returns {{ reason: string, payloadUid: string, providerUid: string, source: string }} The refusal stamp for the event doc
 */
function refuseUidMismatch({ ctx, eventId, eventType, provider, resourceType, resourceId, payloadUid, providerUid, source }) {
  const answered = source === 'hosted-page'
    ? `whose ${provider} hosted page's pass_thru_content names uid=${providerUid}`
    : `whose ${provider} record belongs to uid=${providerUid}`;

  ctx.error(`UID MISMATCH: ${eventType} (${provider}) named ${resourceType} ${resourceId}, ${answered}, but the event's payload claims uid=${payloadUid} — refusing to write a resource onto an owner the provider does not agree with (event=${eventId}). Stamped on payments-webhooks/${eventId} as refusal.reason=uid-mismatch: an event that names a real resource under the wrong owner is a forgery until proven otherwise, and needs manual reconciliation`);

  return {
    reason: 'uid-mismatch',
    payloadUid: payloadUid,
    providerUid: providerUid,
    source: source,
  };
}

/**
 * Refuse a refund whose record belongs to a different order
 *
 * The refund's numbers come from the provider, looked up by an id the PAYLOAD
 * carried ([#510](https://github.com/Omega-JS-Stack/omega/issues/510)) — and an
 * id is only self-consistent when what it names is also what gets written. A
 * refund id is not: pair a real sale with an unrelated refund id from the same
 * merchant account and another customer's amount, currency and reason land on this
 * order, its email and its refund conversion
 * ([#532](https://github.com/Omega-JS-Stack/omega/issues/532)).
 *
 * So the record has to point back at the resource the event named
 * ([../../../libraries/payment/refund-linkage.js](../../../libraries/payment/refund-linkage.js)),
 * and one that points elsewhere is refused: acknowledged rather than failed, for
 * the same reason as every other terminal decision here — no retry can relate two
 * unrelated records.
 *
 * @param {object} options
 * @param {object} options.ctx - Assistant instance
 * @param {Error} options.error - The linkage failure the lookup threw
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string|null} options.uid - The owner the event parsed to, if any
 * @returns {{ reason: string, refundType: string, refundId: string, resourceType: string, resourceId: string, linkedTo: string }} The refusal stamp for the event doc
 */
function refuseRefundNotLinked({ ctx, error, eventId, eventType, provider, uid }) {
  ctx.error(`REFUND NOT LINKED: ${eventType} (${provider}) named ${error.resourceType} ${error.resourceId}, but the ${error.refundType} ${error.refundId} its payload pointed at names ${error.field} ${error.linkedTo} — refusing to record another record's refund on this order (event=${eventId}, owner=${uid || 'null'}). Stamped on payments-webhooks/${eventId} as refusal.reason=refund-not-linked: a refund id the caller chose that resolves to someone else's record is a forgery until proven otherwise, and needs manual reconciliation`);

  return {
    reason: 'refund-not-linked',
    refundType: error.refundType,
    refundId: error.refundId,
    resourceType: error.resourceType,
    resourceId: error.resourceId,
    linkedTo: error.linkedTo,
  };
}

/**
 * Refuse to create a user doc for a uid this project has no auth user for
 *
 * The event is acknowledged — the route answered 2xx when it stored it, and the
 * doc is completed rather than failed, so the provider stops redelivering an
 * event nothing here will ever act on. What a human needs to see it is the
 * warning plus the stamp on the event's own doc, which already carries the
 * payload as delivered ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)).
 *
 * @param {object} options
 * @param {object} options.ctx - Assistant instance
 * @param {string} options.eventId - The webhook doc id (the provider's event id)
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.provider - The provider that sent it
 * @param {string} options.uid - The owner the event resolved to
 * @param {string|null} options.orderId - The order the event named, if any
 * @returns {{ reason: string }} The refusal stamp for the event doc
 */
function refuseUserWithoutAuth({ ctx, eventId, eventType, provider, uid, orderId }) {
  ctx.warn(`USER WITHOUT AUTH: ${eventType} (${provider}) resolved to uid=${uid}, which has no auth user in this project and no user doc — refusing to create one from a payment event (event=${eventId}, order=${orderId || 'null'}). Stamped on payments-webhooks/${eventId} as refusal.reason=user-without-auth: the checkout behind this event belongs to another project, typically a local QA run against the emulator with real test-mode keys`);

  const refusal = { reason: 'user-without-auth' };

  // The stamp is the record; this is the alarm. A log line in Cloud Logging is
  // only ever read by someone already looking, and the whole point of the guard
  // is that nobody knows to look — money moved somewhere for a uid this project
  // does not have (Ian 2026-08-20).
  //
  // Reported through the same helper the acknowledged family uses (#550), from
  // here rather than there: this refusal is decided mid-processing and stamped by
  // the completion write, so it never passes acknowledgeRefusal().
  reportRefusal(ctx, {
    message: `Payment webhook refused: user without auth (uid=${uid})`,
    refusal: refusal,
    eventId: eventId,
    eventType: eventType,
    provider: provider,
    uid: uid,
    extra: { orderId: orderId || null },
  });

  return refusal;
}

/**
 * The id of the resource a refund reversed, read off the payload's `up` link
 *
 * PayPal points a refund at the capture it reversed with a HATEOAS link whose
 * `rel` is `up`, and the id is that URL's last segment. Providers that ship no
 * such links answer null, which the refusal stamp carries honestly rather than
 * guessing at a capture.
 *
 * @param {object} resource - The refund resource fetched from the provider
 * @returns {string|null}
 */
function extractParentResourceId(resource) {
  const up = (resource?.links || []).find((link) => link?.rel === 'up');

  if (!up?.href) {
    return null;
  }

  return up.href.split('/').filter(Boolean).pop() || null;
}

/**
 * Extract customer name from a raw payment provider resource
 *
 * @param {object} resource - Raw provider resource (Stripe subscription, session, invoice)
 * @param {string} resourceType - 'subscription' | 'session' | 'invoice'
 * @returns {{ first: string, last: string }|null}
 */
async function extractCustomerName(resource, resourceType) {
  let fullName = null;

  // Checkout sessions have customer_details.name
  if (resourceType === 'session') {
    fullName = resource.customer_details?.name;
  }

  // Invoices have customer_name
  if (resourceType === 'invoice') {
    fullName = resource.customer_name;
  }

  // PayPal orders have payer.name
  if (resourceType === 'order') {
    const givenName = resource.payer?.name?.given_name;
    const surname = resource.payer?.name?.surname;

    if (givenName) {
      const { capitalize } = await import('../../../libraries/infer-contact.js');
      return {
        first: capitalize(givenName) || null,
        last: capitalize(surname) || null,
      };
    }
  }

  // Chargebee subscriptions carry shipping_address / billing_address with first_name + last_name
  if (resourceType === 'subscription') {
    const addr = resource.shipping_address || resource.billing_address;
    if (addr?.first_name) {
      const { capitalize } = await import('../../../libraries/infer-contact.js');
      return {
        first: capitalize(addr.first_name) || null,
        last: capitalize(addr.last_name) || null,
      };
    }
  }

  if (!fullName) {
    return null;
  }

  const { capitalize } = await import('../../../libraries/infer-contact.js');
  const parts = fullName.trim().split(/\s+/);
  return {
    first: capitalize(parts[0]) || null,
    last: capitalize(parts.slice(1).join(' ')) || null,
  };
}
