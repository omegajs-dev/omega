/**
 * POST /admin/backup - Backup Firestore
 * Admin-only endpoint to export Firestore to Cloud Storage
 */
import moment from 'moment';
import powertools from 'node-powertools';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();

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

  // Parse deletion regex if provided
  data.deletionRegex = data.deletionRegex
    ? powertools.regexify(data.deletionRegex)
    : data.deletionRegex;

  // Setup Firestore Admin Client
  const client = new admin.firestore.v1.FirestoreAdminClient({});
  const projectId = omega.project.projectId;
  const resourceZone = omega.project.resourceZone;
  const databaseName = client.databasePath(projectId, '(default)');
  const bucketName = `bm-backup-firestore-${projectId}`;
  const bucketAddress = `gs://${bucketName}`;

  // Ensure bucket exists
  await createBucket(ctx, bucketName, resourceZone);

  // Export documents
  const result = await client.exportDocuments({
    name: databaseName,
    outputUriPrefix: bucketAddress,
    collectionIds: [],
  }).catch(async (e) => {
    await setMetaStats(ctx, e);
    return e;
  });

  if (result instanceof Error) {
    return ctx.respond(result.message, { code: 500 });
  }

  const response = result[0];

  ctx.log('Saved backup successfully:', response.metadata.outputUriPrefix);

  await setMetaStats(ctx, null);

  // Track analytics
  analytics.event('admin/backup', { status: 'success' });

  return ctx.respond({ name: response['name'] });
};

// Helper: Set meta stats
async function setMetaStats(ctx, error) {
  const admin = ctx.omega.firebase.admin;
  const isError = error instanceof Error;

  await admin.firestore().doc('meta/stats')
    .set({
      backups: {
        lastBackup: {
          date: {
            timestamp: ctx.meta.startTime.timestamp,
            timestampUNIX: ctx.meta.startTime.timestampUNIX,
          },
          status: {
            success: !isError,
            error: isError ? error.message : null,
          }
        }
      },
      metadata: ctx.metadata({ tag: 'admin/backup' }),
    }, { merge: true })
    .catch(e => {
      ctx.error('Failed to update meta stats', e);
    });
}

// Helper: Create bucket if it doesn't exist
async function createBucket(ctx, bucketName, resourceZone) {
  try {
    const meta = await storage.bucket(bucketName).getMetadata();
    ctx.log(`${bucketName} metadata`, meta[0]);
  } catch (e) {
    // Bucket doesn't exist, create it
    const result = await storage.createBucket(bucketName, {
      location: resourceZone,
      storageClass: 'COLDLINE',
    }).catch(err => err);

    ctx.log('storageCreation', result);
  }
}
