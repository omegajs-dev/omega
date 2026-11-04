/**
 * git-auth: how a GitHub token reaches `git` for ONE push, and how it is kept
 * out of everything that prints ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)).
 *
 * Two lanes push to a repo the checkout is not authenticated for: the snapshot
 * push of `deploy-snapshot.js` and the web deploy's gh-pages push. Both need
 * the same three facts, and both used to spell them themselves, which is how a
 * credential ends up in an argv in one of them and not the other:
 *
 *   - the credential NEVER enters argv or a url. A push url carrying a token is
 *     readable by every other process on the machine, is printed by git's own
 *     error output, and rides the message `execFileSync` throws (which carries
 *     the whole argv) straight into a CI log, outside Actions' masking. It
 *     travels in the config ENV of that one child process instead, which lives
 *     exactly as long as the push and lands on no disk;
 *   - the header is the BASIC form (`x-access-token:<token>`, base64), the one
 *     the checkout action uses: the git endpoints are not the REST API and
 *     ignore a bearer header, so the push falls back to a username prompt
 *     (proven on the first playground push, [#872](https://github.com/Omega-JS-Stack/omega/issues/872));
 *   - a failure is rethrown SCRUBBED, in both the raw form and the base64 the
 *     header carries, so no lane can print what it was careful not to pass:
 *     `scrubbedFailure` is that rethrow, and `scrubToken` the scrub inside it.
 */

// The one config entry either lane sets: git applies `http.<url>.extraheader`
// to every request under that url prefix.
const EXTRAHEADER_KEY = 'http.https://github.com/.extraheader';

/**
 * The token in the form the header carries it.
 *
 * @param {string} token - GitHub token.
 * @returns {string} base64 of `x-access-token:<token>`.
 */
function gitAuthValue(token) {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/**
 * The environment entries that hand `git` the token through its own config, for
 * the lifetime of one child process.
 *
 * @param {string} [token] - GitHub token; without one the result is empty, so a
 *   spread of it is a no-op and git asks for credentials itself.
 * @returns {object} `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, or `{}`.
 */
function gitAuthEnv(token) {
  if (!token) return {};

  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${gitAuthValue(token)}`,
  };
}

/**
 * Every appearance of the token replaced by a placeholder, raw and base64, so a
 * failure can be printed.
 *
 * @param {string} message - Text to scrub.
 * @param {string} [token] - The token to remove (absent scrubs nothing).
 * @returns {string} The text with the token redacted.
 */
function scrubToken(message, token) {
  const text = String(message === undefined || message === null ? '' : message);
  if (!token) return text;

  return text
    .split(token).join('***')
    .split(gitAuthValue(token)).join('***');
}

/**
 * A failed git call rethrown under `what`, its status kept: git's own message
 * quotes what it was given, and a caller's message is never trusted with the
 * credential the lane was careful not to pass.
 *
 * @param {string} what - The failed step, naming the repo (`Pushing ... to <owner>/<repo>`).
 * @param {Error} error - What the git call threw.
 * @param {string} [token] - The token to scrub.
 * @returns {Error} `<what> failed: <scrubbed message>`, to throw.
 */
function scrubbedFailure(what, error, token) {
  const failure = new Error(`${what} failed: ${scrubToken(error && error.message, token)}`);
  failure.status = error && error.status;
  return failure;
}

module.exports = { gitAuthEnv, gitAuthValue, scrubToken, scrubbedFailure, EXTRAHEADER_KEY };
