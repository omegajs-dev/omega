import _ from 'lodash';
import powertools from 'node-powertools';

/**
 * POST /admin/firestore/query - Query Firestore collections
 * Admin-only endpoint to run complex queries
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  const queries = powertools.arrayify(data.queries);

  ctx.log('main(): Queries', queries);

  // Run all queries
  const docs = [];

  const runQuery = async (query) => {
    query = query || {};
    query.where = powertools.arrayify(query.where || []);
    query.filter = powertools.arrayify(query.filter || []);
    query.orderBy = powertools.arrayify(query.orderBy || []);

    if (!query.collection) {
      return [];
    }

    let collection = admin.firestore().collection(query.collection);

    // Apply where clauses
    for (const where of query.where) {
      collection = collection.where(where.field, where.operator, where.value);
    }

    // Apply orderBy
    for (const order of query.orderBy) {
      collection = collection.orderBy(order.field, order.order);
    }

    // Apply pagination
    if (query.limit) {
      collection = collection.limit(query.limit);
    }
    if (query.startAt) {
      collection = collection.startAt(query.startAt);
    }
    if (query.startAfter) {
      collection = collection.startAfter(query.startAfter);
    }
    if (query.endAt) {
      collection = collection.endAt(query.endAt);
    }
    if (query.endBefore) {
      collection = collection.endBefore(query.endBefore);
    }

    const snapshot = await collection.get();

    snapshot.forEach((doc) => {
      const exists = docs.find((item) => item.path === doc.ref.path);

      if (!exists && checkFilter(doc.data(), query.filter)) {
        docs.push({
          path: doc.ref.path,
          data: doc.data(),
        });
      }
    });

    // Apply filter index if provided
    if (query.filterIndex) {
      const iS = query.filterIndex[0];
      let iF = query.filterIndex[1];
      iF = iF > docs.length ? docs.length - 1 : iF;
      return docs.slice(iS, iF);
    }

    return docs;
  };

  // Run all queries in parallel
  const ran = await Promise.all(queries.map(runQuery))
    .catch((e) => e);

  if (ran instanceof Error) {
    return ctx.respond(ran.message, { code: 500 });
  }

  return ctx.respond(docs);
};

function checkFilter(data, filters) {
  for (const filter of filters) {
    const fields = powertools.arrayify(`${filter.field}`.split(' || '));
    const matches = filter.matches || '';
    const regex = powertools.regexify(matches);

    let innerPassed = false;

    for (const field of fields) {
      const value = _.get(data, field, undefined);

      if (typeof value === 'undefined') {
        innerPassed = false;
        continue;
      } else if (typeof value === 'string' && value.match(regex)) {
        innerPassed = true;
        break;
      }
    }

    if (!innerPassed) {
      return false;
    }
  }

  return true;
}
