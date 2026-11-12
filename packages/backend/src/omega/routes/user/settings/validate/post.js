import _ from 'lodash';
import jetpack from 'fs-jetpack';
import powertools from 'node-powertools';
import path from 'path';
import { pathToFileURL } from 'url';
import { validate } from '../../../../helpers/schema.js';

/**
 * POST /user/settings/validate - Validate user settings against defaults
 * Merges user settings with subscription-specific defaults from defaults.js
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to validate other users' settings
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Get user data for subscription
  let userData = user;

  if (uid !== user.auth.uid) {
    const doc = await admin.firestore().doc(`users/${uid}`).get();

    if (!doc.exists) {
      return ctx.respond('User not found', { code: 404 });
    }

    userData = doc.data();
  }

  // Merge existing and new settings
  const mergedSettings = _.merge({}, data.existingSettings, data.newSettings);

  // Resolve defaults path
  const resolvedPath = path.join(omega.cwd, 'defaults.js');

  // Check if file exists
  if (!jetpack.exists(resolvedPath)) {
    return ctx.respond(`Defaults file at ${resolvedPath} does not exist, please add it manually.`, { code: 500 });
  }

  // Load and process defaults
  try {
    const defaults = _.get((await import(pathToFileURL(resolvedPath).href)).default(), data.defaultsPath);
    const combined = combineDefaults(defaults.all, defaults[userData.subscription?.product?.id] || {});

    ctx.log('Combined settings', combined);

    // The defaults are a field declaration: they coerce, and refuse only what they declare
    const { data: validated, error } = validate(combined, mergedSettings);

    if (error) {
      return ctx.respond(error, { code: 400 });
    }

    return ctx.respond(validated);
  } catch (e) {
    return ctx.respond(`Unable to load file at ${resolvedPath}: ${e}`, { code: 500 });
  }
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function combineDefaults(base, override) {
  const done = [];

  powertools.getKeys(override)
    .forEach((keyPath) => {
      const pathMinusLast = keyPath.split('.').slice(0, -1).join('.');
      const valueAtPath = _.get(override, keyPath);
      const valueAtParent = _.get(override, pathMinusLast);

      if (done.includes(pathMinusLast) || isObject(valueAtPath)) {
        return;
      }

      _.set(base, pathMinusLast, valueAtParent);
      done.push(pathMinusLast);
    });

  return base;
}
