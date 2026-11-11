/**
 * Sync the brand's bookmarks to the OMEGA Companion extension.
 *
 * Starts the WebSocket server the extension auto-connects to (it retries
 * every 5s), sends one OMEGA_BOOKMARK_SYNC message, and waits for the
 * extension's ack. Interactive sessions only — a headless run has no
 * Chrome to talk to, so it skips instead of burning the connect wait.
 * Dry runs print the link groups that would sync without opening the
 * server (and without the gcloud function-log lookup — no live reads).
 *
 * Link sources are config + state; groups with unmet inputs are simply
 * absent (a brand without analytics IDs gets no Analytics folder).
 */
const { execFileSync } = require('node:child_process');
const chalk = require('chalk').default;
const { WebSocketServer } = require('ws');
const { sourceRepo, apiAddress } = require('@omega.js/config');
const { isInteractive } = require('@omega.js/devkit/prompt');
const { resolveExtensionPort } = require('../../../lib/automation-client.js');

const CONNECT_TIMEOUT = 10000;

/**
 * Deployed Cloud Function names for the project (for per-function log
 * links). Shells out to gcloud; any failure (no gcloud, no auth, no
 * project) is just "no function links".
 */
function getDeployedFunctions(projectId) {
  try {
    const output = execFileSync(
      'gcloud',
      ['functions', 'list', `--project=${projectId}`, '--format=value(name)'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build the bookmark link groups from brand config.
 *
 * @param {Object} brandConfig - Merged brand config
 * @param {Array} targets - Discovered target dirs ({ target } consulted)
 * @param {Object} [extras] - { deployedFunctions } (injectable; defaults to none)
 * @returns {Object} { Category: [{ title, url }] }
 */
function generateLinks(brandConfig, targets = [], extras = {}) {
  const links = {};

  const brandUrl = brandConfig.brand?.url;
  const domain = brandUrl?.replace(/^https?:\/\//, '');
  const firebaseProjectId = brandConfig.cloud?.config?.projectId;
  const google = brandConfig.analytics?.providers?.google || {};
  const source = sourceRepo(brandConfig);
  const deployedFunctions = extras.deployedFunctions || [];

  // Cloud Console
  if (firebaseProjectId) {
    const functionLogUrl = (fnName) =>
      `https://console.cloud.google.com/logs/query;query=--%20Date:%20%0A--%20Reason:%20%0Aresource.labels.function_name%3D%22${fnName}%22%0A--%20textPayload:%22%22;duration=P7D?project=${firebaseProjectId}`;

    links.Cloud = [
      { title: 'Dashboard', url: `https://console.cloud.google.com/home/dashboard?project=${firebaseProjectId}` },
      { title: 'APIs & Services', url: `https://console.cloud.google.com/apis/dashboard?project=${firebaseProjectId}` },
      { title: 'IAM', url: `https://console.cloud.google.com/iam-admin/iam?project=${firebaseProjectId}` },
    ];

    if (deployedFunctions.length > 0) {
      links.Cloud.push({ title: '───────────', url: `https://console.cloud.google.com/functions/list?project=${firebaseProjectId}` });
      for (const fn of deployedFunctions) {
        links.Cloud.push({ title: `${fn}()`, url: functionLogUrl(fn) });
      }
    }
  }

  // Firebase Console
  if (firebaseProjectId) {
    links.Firebase = [
      { title: 'Overview', url: `https://console.firebase.google.com/project/${firebaseProjectId}/overview` },
      { title: 'Settings', url: `https://console.firebase.google.com/project/${firebaseProjectId}/settings/general` },
      { title: 'Authentication', url: `https://console.firebase.google.com/project/${firebaseProjectId}/authentication/users` },
      { title: 'App Check', url: `https://console.firebase.google.com/project/${firebaseProjectId}/appcheck` },
      { title: 'Firestore Database', url: `https://console.firebase.google.com/project/${firebaseProjectId}/firestore` },
      { title: 'Realtime Database', url: `https://console.firebase.google.com/project/${firebaseProjectId}/database` },
      { title: 'Storage', url: `https://console.firebase.google.com/project/${firebaseProjectId}/storage` },
      { title: 'Hosting', url: `https://console.firebase.google.com/project/${firebaseProjectId}/hosting` },
      { title: 'Functions', url: `https://console.firebase.google.com/project/${firebaseProjectId}/functions` },
    ];
  }

  // Analytics
  if (google.accountId && google.propertyId) {
    links.Analytics = [
      { title: 'Reports', url: `https://analytics.google.com/analytics/web/#/a${google.accountId}p${google.propertyId}/reports/intelligenthome` },
      { title: 'Realtime', url: `https://analytics.google.com/analytics/web/#/a${google.accountId}p${google.propertyId}/reports/dashboard?params=_u..nav%3Dmaui` },
      { title: 'Data Streams', url: `https://analytics.google.com/analytics/web/#/a${google.accountId}p${google.propertyId}/admin/streams` },
    ];
  }

  // Search Console
  if (domain) {
    links.Search = [
      { title: 'Performance', url: `https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain:${domain}` },
      { title: 'Indexing', url: `https://search.google.com/search-console/index?resource_id=sc-domain:${domain}` },
      { title: 'Sitemaps', url: `https://search.google.com/search-console/sitemaps?resource_id=sc-domain:${domain}` },
    ];
  }

  // Stripe Dashboard — per-brand keys, so the key's own account is the
  // dashboard default (no account slug in the URL)
  if (brandConfig.payment?.providers?.stripe) {
    const s = 'https://dashboard.stripe.com';
    links.Stripe = [
      { title: 'Dashboard', url: `${s}/dashboard` },
      { title: 'Products', url: `${s}/products?active=true` },
      { title: 'Customers', url: `${s}/customers` },
      { title: 'Subscriptions', url: `${s}/subscriptions?status=active` },
      { title: 'Radar', url: `${s}/radar` },
      { title: '───────────', url: `${s}/settings` },
      { title: 'Account', url: `${s}/settings/account` },
      { title: 'Profile', url: `${s}/settings/profile` },
      { title: 'Billing', url: `${s}/settings/billing/subscriptions` },
      { title: 'Emails', url: `${s}/settings/emails` },
      { title: 'Payouts', url: `${s}/settings/payouts` },
    ];
  }

  // GitHub: the brand's SOURCE monorepo (#883)
  if (source) {
    links.GitHub = [
      { title: 'Repository', url: `https://github.com/${source.slug}` },
      { title: 'Actions', url: `https://github.com/${source.slug}/actions` },
    ];
  }

  // Live URLs
  const liveLinks = [];
  if (brandUrl) {
    liveLinks.push({ title: 'Website', url: brandUrl });
  }
  const api = apiAddress(brandUrl, firebaseProjectId);
  if (api && targets.some((entry) => entry.target === 'backend')) {
    liveLinks.push({ title: 'API', url: api });
  }
  if (liveLinks.length > 0) {
    links.Live = liveLinks;
  }

  return links;
}

module.exports = async function ensureSync(context) {
  const { brandConfig, targets, options = {} } = context;

  const brandId = brandConfig.brand.id;
  const brandName = brandConfig.brand.name || brandId;
  const groupCount = (links) => Object.keys(links).length;
  const linkCount = (links) => Object.values(links).flat().length;

  if (options.dryRun) {
    const links = generateLinks(brandConfig, targets);
    console.log(`      ${chalk.yellow('[DRY RUN]')} Would sync ${chalk.cyan(linkCount(links))} bookmarks in ${chalk.cyan(groupCount(links))} groups: ${Object.keys(links).join(', ') || '(none)'}`);
    return { output: { sync: { planned: Object.keys(links) } } };
  }

  if (!isInteractive()) {
    console.log(chalk.dim('      ⊘ Interactive sessions only — the sync needs a running Chrome with the Omega extension connected'));
    return { output: { sync: { reason: 'non-interactive' } } };
  }

  const firebaseProjectId = brandConfig.cloud?.config?.projectId;
  const links = generateLinks(brandConfig, targets, {
    deployedFunctions: firebaseProjectId ? getDeployedFunctions(firebaseProjectId) : [],
  });

  const message = {
    type: 'OMEGA_BOOKMARK_SYNC',
    brand: { id: brandId, name: brandName, url: brandConfig.brand?.url },
    links,
  };

  const port = resolveExtensionPort();
  const connectTimeout = Number(process.env.OMEGA_EXTENSION_TIMEOUT) || CONNECT_TIMEOUT;

  return new Promise((resolve) => {
    // Loopback only — the extension connects from this machine; binding all
    // interfaces would expose the sync socket to the LAN for its lifetime
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    let resolved = false;

    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;

      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => resolve(result));
    };

    const timeout = setTimeout(() => {
      console.log(`      ${chalk.yellow('⚠')} Extension not connected (timeout): install the OMEGA Companion from the Chrome Web Store, or load ${chalk.cyan('omega-omega/targets/extension/packaged/chrome/raw/')} unpacked (chrome://extensions → Load unpacked)`);
      cleanup({ status: 'warned', reason: 'extension not connected', output: { sync: { reason: 'extension not connected' } } });
    }, connectTimeout);

    wss.on('error', (error) => {
      clearTimeout(timeout);
      const reason = error.code === 'EADDRINUSE'
        ? `port ${port} already in use (another manager run or the extension MCP server?)`
        : error.message;
      console.log(`      ${chalk.yellow('⚠')} WebSocket server failed: ${reason}`);
      cleanup({ status: 'warned', reason, output: { sync: { reason } } });
    });

    wss.on('connection', (ws) => {
      console.log(`      ${chalk.dim('→')} Extension connected, sending ${chalk.cyan(brandName)} bookmarks (${linkCount(links)} links)...`);

      ws.send(JSON.stringify(message));

      ws.on('message', (data) => {
        clearTimeout(timeout);

        let response = null;
        try {
          response = JSON.parse(data.toString());
        } catch {
          // Non-JSON ack — treat as synced
        }

        if (response && response.success === false) {
          console.log(`      ${chalk.yellow('⚠')} Sync failed${chalk.dim(`: ${response.error}`)}`);
          cleanup({ status: 'warned', reason: 'extension reported a sync failure', output: { sync: { reason: response.error || 'extension reported failure' } } });
          return;
        }

        console.log(`      ${chalk.green('✓')} Bookmarks synced for ${chalk.cyan(brandName)}`);
        cleanup({ output: { sync: { synced: true, links: linkCount(links) } } });
      });

      // Extension closed without answering — the send went out; call it synced
      ws.on('close', () => {
        clearTimeout(timeout);
        cleanup({ output: { sync: { synced: true, links: linkCount(links) } } });
      });
    });

    console.log(`      ${chalk.dim('→')} Waiting for the extension on ${chalk.cyan(`ws://localhost:${port}`)}...`);
  });
};

module.exports.generateLinks = generateLinks;
