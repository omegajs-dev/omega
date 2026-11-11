/**
 * The ONE API address of a brand, and the one test for a host the brand does
 * not own. A brand on its own domain serves its API at `api.<host>`; a brand on
 * a GitHub default Pages host owns no subdomain to put one on, so its API is
 * the Cloud Functions address of its project's `omega_api` function.
 *
 * Browser-safe and stdlib-only (the global `URL`), so every surface, browser
 * and Node alike, derives the address from this same function.
 */

// Every GitHub default Pages host (`<owner>.github.io`, and the bare form): a
// url naming one is an ADDRESS, never a custom domain.
const DEFAULT_PAGES_HOST = /(^|\.)github\.io$/i;

// The region every OMEGA Cloud Function deploys to.
const FUNCTIONS_REGION = 'us-central1';

/**
 * Whether a host is a GitHub default Pages host (`<owner>.github.io`, or the
 * bare form): an ADDRESS the hosting provider owns, never a domain a brand can
 * set a CNAME, a zone or a registrar on.
 * @param {string} host - A bare host, as `brandHost` returns it.
 * @returns {boolean}
 */
function isDefaultPagesHost(host) {
  return DEFAULT_PAGES_HOST.test(String(host || ''));
}

/**
 * The brand's API base url. `https://api.<hostname>` for a host the brand
 * owns (the hostname as the url spells it, path and port dropped); the Cloud
 * Functions address of `omega_api` when the host is a default Pages host.
 * @param {string} [url] - A brand url, absolute as the schema requires.
 * @param {string} [projectId] - The brand's Firebase project id.
 * @param {string} [region] - The functions region, FUNCTIONS_REGION by default.
 * @returns {string} The address, or '' with no absolute url, or a Pages host and no project id.
 */
function apiAddress(url, projectId, region = FUNCTIONS_REGION) {
  if (typeof url !== 'string' || !url) {
    return '';
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return '';
  }

  if (!isDefaultPagesHost(hostname)) {
    return `https://api.${hostname}`;
  }

  return projectId ? `https://${region}-${projectId}.cloudfunctions.net/omega_api` : '';
}

module.exports = { DEFAULT_PAGES_HOST, FUNCTIONS_REGION, isDefaultPagesHost, apiAddress };
