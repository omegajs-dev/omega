import pushid from 'pushid';
import powertools from 'node-powertools';

/**
 * POST /user/feedback - Submit user feedback
 * Saves feedback to Firestore and optionally prompts for review
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  const docId = pushid();

  // Preprocess decision
  const decision = {
    promptReview: false,
    reviewURL: null,
  };

  // Prompt for review if user gave positive rating (like/love) and wrote meaningful positive feedback (50+ chars)
  const totalPositiveLength = (data.positive?.length || 0) + (data.comments?.length || 0);
  if (
    ['like', 'love'].includes(data.rating)
    && totalPositiveLength >= 50
  ) {
    decision.promptReview = true;
  }

  // Get review config from local config
  const reviews = { ...(omega.config.reviews || {}) };
  reviews.enabled = typeof reviews.enabled === 'undefined' ? true : reviews.enabled;
  reviews.sites = reviews.sites || [];

  // If reviews are enabled and there are review sites, build the full review URL
  if (decision.promptReview && reviews.enabled && reviews.sites.length > 0) {
    const site = powertools.random(reviews.sites);
    const brandDomain = new URL(omega.config.brand.url).hostname;

    decision.reviewURL = `https://www.${site}/review/${brandDomain}`;
  } else {
    decision.promptReview = false;
  }

  ctx.log('Feedback submitted', docId, { appReviewData: reviews, settings: data, decision });

  // Save feedback to Firestore
  const write = await admin.firestore().doc(`feedback/${docId}`)
    .set({
      feedback: {
        rating: data.rating,
        positive: data.positive,
        negative: data.negative,
        comments: data.comments,
      },
      decision: decision,
      owner: user?.auth?.uid ?? null,
      metadata: {
        ...ctx.metadata({ tag: 'user/feedback' }),
        created: ctx.meta.startTime,
      },
    }, { merge: true })
    .catch((e) => e);

  if (write instanceof Error) {
    return ctx.respond(`Failed to save feedback: ${write.message}`, { code: 500 });
  }

  return ctx.respond({
    review: decision,
    originalRequest: {
      rating: data.rating,
      positive: data.positive,
      negative: data.negative,
      comments: data.comments,
    },
  });
};
