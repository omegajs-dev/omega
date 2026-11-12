/**
 * POST /admin/users/sync - Sync Firebase Auth users to Firestore
 * Admin-only endpoint to synchronize user records
 */
import lodash from 'lodash';
import account from '../../../../helpers/account.js';

const { merge } = lodash;
const { User } = account;

export default async ({ ctx, omega, user, data, analytics }) => {
  const admin = omega.firebase.admin;

  // Require authentication (allow in dev)
  if (!user.authenticated && ctx.isProduction()) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin (allow in dev)
  if (!user.roles.admin && ctx.isProduction()) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Get lastPageToken from meta/stats
  const metaDoc = await admin.firestore().doc('meta/stats').get().catch(e => e);

  if (metaDoc instanceof Error) {
    return ctx.respond(metaDoc.message, { code: 500 });
  }

  const metaData = metaDoc.data() || {};
  const lastPageToken = metaData?.syncUsers?.lastPageToken;
  let processedUsers = 0;

  ctx.log(`Running sync-users based on lastPageToken: ${lastPageToken}`);

  // List firebase auth users
  await omega.utilities.iterateUsers(
    async (batch, index) => {
      // Process user function
      async function processUser(authUser, i) {
        const account = authUser.toJSON();
        const uid = account.uid;
        const email = account.email;
        const created = new Date(account.metadata.creationTime);
        const activity = new Date(account.metadata.lastSignInTime);
        const isAnonymous = account.providerData.length === 0;

        // Skip anonymous users
        if (isAnonymous) {
          return;
        }

        // Get existing user data
        const userDoc = await admin.firestore().doc(`users/${uid}`).get().catch(() => null);
        const userData = userDoc?.data() || {};

        // Build new user object
        const newUser = new User({
          auth: {
            uid: uid,
            email: email,
          },
          metadata: {
            created: {
              timestamp: created.toISOString(),
              timestampUNIX: Math.floor(created.getTime() / 1000),
            },
            updated: {
              timestamp: activity.toISOString(),
              timestampUNIX: Math.floor(activity.getTime() / 1000),
            },
          }
        });

        const finalData = merge(newUser.toJSON(), userData);

        // Set metadata
        finalData.metadata = ctx.metadata({ tag: 'admin/users/sync' });

        // Save to database
        await admin.firestore().doc(`users/${uid}`)
          .set(finalData, { merge: true })
          .then(() => {
            ctx.log(`Synched user: ${uid}`);
            processedUsers++;
          })
          .catch(e => {
            ctx.error(`Failed to sync user: ${uid}`, e);
          });
      }

      // Process each user in batch
      for (let i = 0; i < batch.users.length; i++) {
        await processUser(batch.users[i], i);
      }

      // Save pageToken for resume
      if (batch.pageToken) {
        await admin.firestore().doc('meta/stats')
          .set({
            syncUsers: {
              lastPageToken: batch.pageToken,
            }
          }, { merge: true })
          .then(() => {
            ctx.log(`Saved lastPageToken: ${batch.pageToken}`);
          })
          .catch(e => {
            ctx.error('Failed to update lastPageToken', e);
          });
      }
    },
    { batchSize: 10, log: true, pageToken: lastPageToken }
  );

  ctx.log(`Processed ${processedUsers} users.`);

  // Track analytics
  analytics.event('admin/users/sync', { processed: processedUsers });

  return ctx.respond({ processed: processedUsers });
};
