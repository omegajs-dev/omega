/**
 * Reset usage cron job
 *
 * Runs daily at midnight UTC and handles different reset schedules:
 * - Local storage: cleared every day
 * - Unauthenticated usage collection: deleted every day
 * - Authenticated user daily counters: reset every day
 * - Authenticated user monthly counters: reset on the 1st of each month
 * - Per-user overrides (`usage.overrides`): never touched — an admin granted
 *   those credits and a reset is not a revoke ([#647](https://github.com/Omega-JS-Stack/omega/issues/647))
 */

// The features contract, shared with the gate, through the backend's one account door
import account from '../../../helpers/account.js';

const { isCountedFeature } = account;

// The key under `usage` that is NOT a counter: a map of admin-granted limits.
// Named rather than shape-tested, because a brand feature could legitimately be
// called anything and the shape test below is what protects the rest.
const OVERRIDES_KEY = 'overrides';

// Counters that live on a USER doc with no catalog entry: the framework's own
// anti-abuse gates, which pass consume() an explicit limit because they are
// security controls rather than plan features. Only the ids that reach a user
// document belong here — an anonymous-keyed counter (signups, the public
// marketing subscribe lane) lives in the `usage` collection this cron deletes
// wholesale.
const FRAMEWORK_COUNTERS = ['email-preferences'];

/**
 * Is this value a usage COUNTER block rather than something else stored beside
 * one? The shape is what answers: the counters `consume()` writes.
 * @param {*} value - a value under the user doc's `usage` key
 * @returns {boolean}
 */
function isCounterBlock(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (typeof value.daily === 'number' || typeof value.monthly === 'number');
}

export default async ({ ctx, omega, context }) => {
  const storage = omega.storage({ name: 'usage', temporary: true, clear: false, log: false });

  ctx.log('Starting...');

  // Clear local storage (daily)
  clearLocal(ctx, storage);

  // Clear unauthenticated usage collection (daily)
  await clearUnauthenticatedUsage(ctx, omega);

  // Reset authenticated user counters (daily + monthly on 1st)
  await resetAuthenticated(omega, ctx);
};

function clearLocal(ctx, storage) {
  ctx.log('local: Clearing...');
  storage.setState({}).write();
  ctx.log('local: Completed!');
}

async function clearUnauthenticatedUsage(ctx, omega) {
  const admin = omega.firebase.admin;

  ctx.log('unauthenticated: Deleting usage collection...');

  await admin.firestore().recursiveDelete(admin.firestore().collection('usage'))
  .then(() => {
    ctx.log('unauthenticated: Completed!');
  })
  .catch((e) => {
    ctx.report(`Error deleting usage collection: ${e}`, { code: 500 });
  });
}

async function resetAuthenticated(omega, ctx) {
  const isFirstOfMonth = new Date().getDate() === 1;

  // The field paths to QUERY on. A Firestore query names a field, so the ids
  // have to be enumerable: every counted feature the catalog defines, plus the
  // framework's own gates, which count on a user doc with an explicit limit and
  // carry no catalog entry ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
  // This list decides who is FOUND; it does not decide what is reset — see
  // below, where every counter-shaped key on the fetched document is cleared.
  const catalog = omega.config.features || {};
  const features = [
    ...Object.keys(catalog).filter((id) => isCountedFeature(catalog[id])),
    ...FRAMEWORK_COUNTERS.filter((id) => !catalog[id]),
  ];

  ctx.log(`authenticated: Resetting ${isFirstOfMonth ? 'daily + monthly' : 'daily'} for features`, features);

  // Collect all user IDs that need resetting (deduplicated across features)
  // Each entry maps uid -> { ref, usage } so we only write once per user
  const usersToReset = {};

  for (const feature of features) {
    // Query users with daily > 0 for this feature
    await omega.utilities.iterateCollection((batch) => {
      return new Promise(async (resolve) => {
        for (const doc of batch.docs) {
          if (!usersToReset[doc.id]) {
            usersToReset[doc.id] = { ref: doc.ref, usage: doc.data().usage || {} };
          }
        }
        return resolve();
      });
    }, {
      collection: 'users',
      where: [
        { field: `usage.${feature}.daily`, operator: '>', value: 0 },
      ],
      batchSize: 5000,
      log: false,
    })
    .catch(e => {
      ctx.report(`Error querying ${feature}.daily: ${e}`, { code: 500 });
    });

    // On the 1st, also query users with monthly > 0
    if (isFirstOfMonth) {
      await omega.utilities.iterateCollection((batch) => {
        return new Promise(async (resolve) => {
          for (const doc of batch.docs) {
            if (!usersToReset[doc.id]) {
              usersToReset[doc.id] = { ref: doc.ref, usage: doc.data().usage || {} };
            }
          }
          return resolve();
        });
      }, {
        collection: 'users',
        where: [
          { field: `usage.${feature}.monthly`, operator: '>', value: 0 },
        ],
        batchSize: 5000,
        log: false,
      })
      .catch(e => {
        ctx.report(`Error querying ${feature}.monthly: ${e}`, { code: 500 });
      });
    }
  }

  const userIds = Object.keys(usersToReset);
  ctx.log(`authenticated: Found ${userIds.length} users to reset`);

  // Single write per user: reset daily (always) + monthly (on 1st) on EVERY
  // counter block the document carries, whatever its key. Catalog membership is
  // deliberately not the test — a counter the catalog never named is still a
  // counter, and sweeping only the catalog left the framework's own gates
  // growing forever, which permanently refused a user after five uses.
  // `usage.overrides` is a map of LIMITS, not counts, so it is skipped: an
  // admin granted those credits and a reset is not a revoke.
  for (const uid of userIds) {
    const { ref, usage } = usersToReset[uid];

    for (const key of Object.keys(usage)) {
      if (key === OVERRIDES_KEY || !isCounterBlock(usage[key])) {
        continue;
      }

      usage[key].daily = 0;

      if (isFirstOfMonth) {
        usage[key].monthly = 0;
      }
    }

    await ref.update({ usage })
    .then(() => {
      ctx.log(`authenticated: Reset ${uid}`);
    })
    .catch(e => {
      ctx.report(`Error resetting ${uid}: ${e}`, { code: 500 });
    });
  }

  ctx.log(`authenticated: Completed!`);
}
