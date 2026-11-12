/**
 * GET /user/data-request - Check data request status or download data
 *
 * action=status (default): Returns the most recent request with its stored status.
 * action=download: Compiles user data live and returns it. Only works when status is 'completed'.
 *
 * Statuses:
 *   pending   — request submitted, waiting to be processed (omega_cronDaily sets to 'completed' after 14 days)
 *   completed — data is available for download (downloads counter tracks how many times downloaded)
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  const uid = user.auth.uid;

  // Get the most recent request
  const requestsSnapshot = await admin.firestore()
    .collection('data-requests')
    .where('owner', '==', uid)
    .orderBy('metadata.created.timestampUNIX', 'desc')
    .limit(1)
    .get();

  if (requestsSnapshot.empty) {
    return ctx.respond({ request: null });
  }

  const requestDoc = requestsSnapshot.docs[0];
  const request = requestDoc.data();
  const requestId = requestDoc.id;

  const status = request.status;

  // Status check — return the doc as-is
  if (data.action !== 'download') {
    return ctx.respond({
      request: { id: requestId, ...request },
    });
  }

  // Download action — only allowed when status is 'completed'
  if (status !== 'completed') {
    return ctx.respond('Your data request is still being processed. Please check back later.', { code: 400 });
  }

  // Build query list: @omega.js/backend defaults + project-specific queries from config
  const defaultQueries = [
    { path: 'users/{uid}', redact: ['api.privateKey'] },
    { collection: 'data-requests', where: [['owner', '==', '{uid}']] },
    { collection: 'payments-intents', where: [['owner', '==', '{uid}']] },
    { collection: 'payments-orders', where: [['owner', '==', '{uid}']] },
  ];
  const customQueries = omega.config.dataRequest?.queries || [];
  const allQueries = defaultQueries.concat(customQueries);

  // Execute all queries in parallel (+ auth record)
  const queryPromises = allQueries.map(q => {
    if (q.path) {
      // Single document fetch
      const resolvedPath = q.path.replace('{uid}', uid);
      return admin.firestore().doc(resolvedPath).get();
    }

    // Collection query
    let ref = admin.firestore().collection(q.collection);

    for (const [field, op, value] of q.where) {
      ref = ref.where(field, op, value === '{uid}' ? uid : value);
    }

    return ref.get();
  });

  const results = await Promise.all([
    ...queryPromises,
    admin.auth().getUser(uid).catch(() => null),
  ]);

  // Compile data from results
  const authRecordResult = results.pop();
  const exported = {
    exportedAt: ctx.meta.startTime.timestamp,
    authRecord: null,
  };

  // Process query results
  allQueries.forEach((q, i) => {
    const result = results[i];

    if (q.path) {
      // Single document
      const key = q.path.split('/')[0];
      if (!result.exists) {
        exported[key] = null;
        return;
      }

      const docData = result.data();

      // Redact sensitive fields
      if (q.redact) {
        for (const fieldPath of q.redact) {
          const parts = fieldPath.split('.');
          let obj = docData;

          for (let j = 0; j < parts.length - 1; j++) {
            obj = obj?.[parts[j]];
          }

          if (obj) {
            delete obj[parts[parts.length - 1]];
          }
        }
      }

      exported[key] = docData;
      return;
    }

    // Collection query
    const docs = [];

    result.forEach(doc => {
      docs.push({ id: doc.id, ...doc.data() });
    });

    exported[q.collection] = docs;
  });

  // Auth record (always included)
  if (authRecordResult) {
    exported.authRecord = {
      uid: authRecordResult.uid,
      email: authRecordResult.email,
      emailVerified: authRecordResult.emailVerified,
      displayName: authRecordResult.displayName,
      photoURL: authRecordResult.photoURL,
      phoneNumber: authRecordResult.phoneNumber,
      disabled: authRecordResult.disabled,
      creationTime: authRecordResult.metadata.creationTime,
      lastSignInTime: authRecordResult.metadata.lastSignInTime,
      providerData: (authRecordResult.providerData || []).map(p => ({
        providerId: p.providerId,
        uid: p.uid,
        displayName: p.displayName,
        email: p.email,
        photoURL: p.photoURL,
      })),
    };
  } else {
    exported.authRecord = { error: 'Unable to retrieve auth record' };
  }

  // Increment downloads counter + set completed timestamp on first download
  const updateData = {
    downloads: admin.firestore.FieldValue.increment(1),
  };

  if (!request.metadata.completed?.timestampUNIX) {
    updateData['metadata.completed.timestamp'] = ctx.meta.startTime.timestamp;
    updateData['metadata.completed.timestampUNIX'] = ctx.meta.startTime.timestampUNIX;
  }

  await admin.firestore()
    .doc(`data-requests/${requestId}`)
    .update(updateData);

  const downloads = (request.downloads || 0) + 1;

  ctx.log(`Data request ${requestId} downloaded by user ${uid} (download #${downloads})`);

  // Send download confirmation email (fire-and-forget)
  sendDownloadEmail(ctx, user, requestId, downloads);

  return ctx.respond({
    request: { id: requestId, ...request, downloads: downloads },
    data: exported,
  });
};

/**
 * Send data download confirmation email (fire-and-forget)
 */
function sendDownloadEmail(ctx, user, requestId, downloads) {
  const omega = ctx.omega;
  const mailer = ctx.email;
  const uid = user.auth.uid;
  const firstName = user.personal?.name?.first;
  const greeting = firstName ? `Hey ${firstName}, your` : 'Your';
  const downloadDate = ctx.meta.startTime.timestamp;

  mailer.send({
    to: user,
    sender: 'account',
    categories: ['account/data-request-download'],
    subject: `Your data has been downloaded #${requestId}`,
    template: 'card',
    copy: true,
    data: {
      email: {
        preview: `Your personal data export was downloaded on ${downloadDate}.`,
      },
      content: {
        title: 'Data Download Confirmation',
        message: `${greeting} personal data export has been successfully downloaded.

**Download details:**

- **Date:** ${downloadDate}
- **Download #:** ${downloads}
- **Request reference:** #${requestId}
- **Account UID:** ${uid}

If you did not initiate this download, please secure your account immediately and contact us by replying to this email.`,
      },
    },
  })
    .then((result) => {
      ctx.log(`sendDownloadEmail(): Success, status=${result.status}`);
    })
    .catch((e) => {
      ctx.error(`sendDownloadEmail(): Failed: ${e.message}`);
    });
}
