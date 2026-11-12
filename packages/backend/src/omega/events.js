/**
 * Events: the one dispatcher for the auth, Firestore and cron triggers.
 *
 * A handler is a module under the consumer's `events/` (`users/on-create`
 * names `events/users/on-create.js`), or an absolute path, which is how the
 * framework points at its OWN handlers. It receives one object:
 * `{ ctx, omega, user, context, change, snapshot }`, where `user`, `change`
 * and `snapshot` are the trigger's own payload (the Auth UserRecord, the
 * Firestore change) and `ctx` is a fresh Context with no request. The consumer's
 * `omega.handlers[<function name>]` hook, when set, runs before and after it.
 */
const Context = require('./context.js');
const { loadHandler } = require('./libraries/load-handler.js');

/**
 * Run one event handler.
 * @param {object} omega - the Omega instance.
 * @param {string} handlerName - a name under the consumer's events/, or an absolute path.
 * @param {object} payload - the trigger's payload: { user, context, change, snapshot }.
 * @returns {Promise<*>} the handler's result; rejects with its error.
 */
function run(omega, handlerName, payload) {
  return new Promise(async function(resolve, reject) {
    const ctx = new Context(omega);

    // An absolute path is used as-is; a name resolves under the consumer's events/
    const handlerPath = handlerName.startsWith('/')
      ? handlerName
      : `${omega.cwd}/events/${handlerName}.js`;

    // The handler's argument (some keys are undefined depending on event type)
    const context = {
      ctx: ctx,
      omega: omega,
      user: payload.user,
      context: payload.context,
      change: payload.change,
      snapshot: payload.snapshot,
    };

    // Load handler
    let handler;
    try {
      handler = loadHandler(handlerPath);
    } catch (e) {
      // A handler that will not load is a server fault, so it goes through the
      // SAME door a 5xx route does: report() logs it AND captures it to Sentry
      // (#380). The require failure rides as the `cause`, keeping its own stack
      // and code; Sentry's linked-errors integration follows the chain.
      return reject(ctx.report(new Error(`EventMiddleware: Failed to load handler @ ${handlerPath}`, { cause: e })));
    }

    // Execute with hooks support
    const hook = omega.handlers[ctx.meta.name];

    try {
      // Pre hook
      if (hook) {
        await hook(context, 'pre');
      }

      // Main execution
      const result = await handler(context);

      // Post hook
      if (hook) {
        await hook(context, 'post');
      }

      return resolve(result);
    } catch (e) {
      // Re-throw a deliberate block untouched: it is the trigger's CLIENT fault,
      // the 4xx lane that never captures. Exactly TWO shapes qualify: an
      // HttpsError (its constructor always sets httpErrorCode, so that property
      // IS how a real block is recognized) and an explicit NUMERIC 4xx code. A
      // string `.code` (ENOENT, messaging/invalid-token) is a system error, not
      // a block, and respond.js rules the same way: its parseInt turns a string
      // code into NaN, which lands on the 500 lane and reports.
      const code = parseInt(e.code);
      if (e.httpErrorCode || (code >= 400 && code <= 499)) {
        return reject(e);
      }

      // Anything else is a server fault: report() logs it AND captures it (#380).
      // It decorates the SAME object in place (code/tag/usage land on the Error)
      // and hands it back, so the rejection value the trigger sees is that one
      // error: `e.code` reads report()'s 500 after capture. A trigger has no
      // res, which report() handles: its header attach is a no-op there.
      return reject(ctx.report(e));
    }
  });
}

module.exports = { run };
