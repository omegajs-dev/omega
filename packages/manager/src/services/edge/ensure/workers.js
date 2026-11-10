/**
 * Ensure Workers + routes match `edge.providers.cloudflare.workers`
 * [{ name, route, script, env, secrets }]. script resolves in the brand's
 * workers/ first, then the company tree's, then this service's; secrets
 * names brand .env keys; route supports `{ domain }` templating. Every worker
 * also gets a FUNCTIONS_REGION plain_text binding, config's Cloud Functions region.
 *
 * 1. Resolves every script and secret; a missing one throws before any request.
 * 2. Reads existing workers + zone routes + account ID.
 * 3. For each configured worker: mark create/update;
 *    for each route: ensure it exists and points at the right script.
 *    Unconfigured workers/routes are removed.
 * 4. PUTs worker scripts as multipart form data, POSTs/PUTs/DELETEs routes.
 */
const { join } = require('node:path');
const { FUNCTIONS_REGION } = require('@omega.js/config');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');
const { resolveCompany } = require('@omega.js/config');
const { templateObject } = require('../../../config.js');
const { cacheRead } = require('../lib/read-cache.js');
const { accountId: resolveAccountId } = require('../lib/account-id.js');
const { getZoneId, zoneGate } = require('../lib/ruleset-helper.js');
const { dryRunPlan } = require('../../../lib/run-gates.js');

function resolveScript(brandRoot, script) {
  const brandPath = join(brandRoot, 'workers', script);
  const companyPath = resolveCompany(brandRoot).file(join('workers', script));
  const frameworkPath = join(__dirname, '..', 'workers', script);
  const found = [brandPath, companyPath, frameworkPath].find((p) => p && jetpack.exists(p) === 'file');
  if (!found) {
    throw new Error(`Worker script not found: ${script} (looked in ${brandPath}, the company tree, and ${frameworkPath})`);
  }
  return jetpack.read(found);
}

// Values come from the manage run's environment, the brand .env cascade
function resolveSecrets(workerConfig) {
  return Object.fromEntries((workerConfig.secrets || []).map((name) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Worker ${workerConfig.name}: secret ${name} is not set in the brand .env`);
    }
    return [name, value];
  }));
}

function buildScriptFormData(scriptContent, env, secrets) {
  const formData = new FormData();
  formData.append('metadata', JSON.stringify({
    main_module: 'index.js',
    bindings: [
      ...Object.entries(env || {}).map(([key, value]) => ({
        type: 'plain_text', name: key, text: value,
      })),
      ...Object.entries(secrets).map(([key, value]) => ({
        type: 'secret_text', name: key, text: value,
      })),
    ],
  }));
  formData.append('index.js', new Blob([scriptContent], { type: 'application/javascript+module' }), 'index.js');
  return formData;
}

module.exports = async function ensureWorkers(context) {
  const { cloudflareApi: api, brandRoot, brandConfig, domain, options = {} } = context;
  const zoneId = getZoneId(context);
  const gated = zoneGate(context, 'workers');
  if (gated) return gated;

  // === DIFF config presence first — reads are pointless without any config ===
  const workersConfig = brandConfig?.edge?.providers?.cloudflare?.workers;
  if (!workersConfig || workersConfig.length === 0) {
    console.log(`      ${chalk.dim('⊘ No workers configured')}`);
    return;
  }

  // Scripts and secrets are local inputs: a missing one fails before any request
  const resolved = new Map(workersConfig.map((workerConfig) => [workerConfig, {
    script: resolveScript(brandRoot, workerConfig.script),
    secrets: resolveSecrets(workerConfig),
  }]));

  // === READ ===
  const accountId = await resolveAccountId(context);
  const workersResponse = await api.makeRequest(`/accounts/${accountId}/workers/scripts`);
  const existingWorkers = workersResponse.result || [];
  const routesResponse = await api.makeRequest(`/zones/${zoneId}/workers/routes`);
  const existingRoutes = routesResponse.result || [];

  console.log(`      ${chalk.green('✓')} Read ${chalk.dim(`(${existingWorkers.length} items)`)}`);
  cacheRead(brandRoot, 'workers', {
    count: existingWorkers.length,
    workers: existingWorkers,
    routes: existingRoutes,
    accountId,
  });

  // === DIFF ===
  const workersToCreate = [];
  const workersToUpdate = [];
  const routesToCreate = [];
  const routesToUpdate = [];

  for (const workerConfig of workersConfig) {
    const route = templateObject(workerConfig.route, { domain });
    const { script, secrets } = resolved.get(workerConfig);
    const worker = { name: workerConfig.name, script, env: { FUNCTIONS_REGION, ...workerConfig.env }, secrets };

    const existingWorker = existingWorkers.find((w) => w.id === workerConfig.name);
    if (existingWorker) {
      workersToUpdate.push(worker);
    } else {
      console.log(`      ${chalk.dim('·')} create worker ${chalk.cyan(workerConfig.name)}`);
      workersToCreate.push(worker);
    }

    const existingRoute = existingRoutes.find((r) => r.pattern === route);
    if (existingRoute) {
      if (existingRoute.script !== workerConfig.name) {
        console.log(`      ${chalk.dim('·')} update route ${chalk.cyan(route)} -> ${chalk.cyan(workerConfig.name)}`);
        routesToUpdate.push({ id: existingRoute.id, pattern: route, script: workerConfig.name });
      }
    } else {
      console.log(`      ${chalk.dim('·')} create route ${chalk.cyan(route)} -> ${chalk.cyan(workerConfig.name)}`);
      routesToCreate.push({ pattern: route, script: workerConfig.name });
    }
  }

  // Detect stale routes and workers (in Cloudflare but not in config)
  const configRoutePatterns = new Set(workersConfig.map((w) => templateObject(w.route, { domain })));
  const configWorkerNames = new Set(workersConfig.map((w) => w.name));

  const routesToDelete = existingRoutes.filter((r) => !configRoutePatterns.has(r.pattern));
  const workersToDelete = existingWorkers.filter((w) => !configWorkerNames.has(w.id));

  for (const route of routesToDelete) {
    console.log(`      ${chalk.dim('·')} remove route ${chalk.cyan(route.pattern)}`);
  }
  for (const worker of workersToDelete) {
    console.log(`      ${chalk.dim('·')} remove worker ${chalk.cyan(worker.id)}`);
  }

  if (workersToCreate.length === 0 && workersToUpdate.length === 0
    && routesToCreate.length === 0 && routesToUpdate.length === 0
    && routesToDelete.length === 0 && workersToDelete.length === 0) {
    console.log(`      ${chalk.dim('⊘ No changes needed')}`);
    return;
  }

  if (options.dryRun) {
    dryRunPlan('write the worker + routes');
    return {
      status: 'success',
      output: {
        workers: {
          planned: {
            createWorkers: workersToCreate.length,
            updateWorkers: workersToUpdate.length,
            createRoutes: routesToCreate.length,
            updateRoutes: routesToUpdate.length,
            deleteRoutes: routesToDelete.length,
            deleteWorkers: workersToDelete.length,
          },
        },
      },
    };
  }

  // === WRITE ===
  const output = {
    workersCreated: [], workersUpdated: [], routesCreated: [], routesUpdated: [],
    routesDeleted: [], workersDeleted: [], errors: [],
  };

  for (const worker of [...workersToCreate, ...workersToUpdate]) {
    const isCreate = workersToCreate.includes(worker);
    try {
      await api.makeRequest(`/accounts/${accountId}/workers/scripts/${worker.name}`, {
        method: 'PUT',
        body: buildScriptFormData(worker.script, worker.env, worker.secrets),
      });
      (isCreate ? output.workersCreated : output.workersUpdated).push(worker.name);
      console.log(`      ${chalk.green('✓')} ${isCreate ? 'Created' : 'Updated'} worker: ${chalk.cyan(worker.name)}`);
    } catch (error) {
      console.error(`      ${chalk.red('✗')} Failed to ${isCreate ? 'create' : 'update'} worker ${chalk.cyan(worker.name)}${chalk.dim(`: ${error.message}`)}`);
      output.errors.push({ worker: worker.name, error: error.message });
    }
  }

  for (const route of routesToCreate) {
    try {
      await api.makeRequest(`/zones/${zoneId}/workers/routes`, {
        method: 'POST',
        body: JSON.stringify({ pattern: route.pattern, script: route.script }),
      });
      output.routesCreated.push(route.pattern);
      console.log(`      ${chalk.green('✓')} Created route: ${chalk.cyan(route.pattern)} -> ${chalk.cyan(route.script)}`);
    } catch (error) {
      console.error(`      ${chalk.red('✗')} Failed to create route ${chalk.cyan(route.pattern)}${chalk.dim(`: ${error.message}`)}`);
      output.errors.push({ route: route.pattern, error: error.message });
    }
  }

  for (const route of routesToUpdate) {
    try {
      await api.makeRequest(`/zones/${zoneId}/workers/routes/${route.id}`, {
        method: 'PUT',
        body: JSON.stringify({ pattern: route.pattern, script: route.script }),
      });
      output.routesUpdated.push(route.pattern);
      console.log(`      ${chalk.green('✓')} Updated route: ${chalk.cyan(route.pattern)} -> ${chalk.cyan(route.script)}`);
    } catch (error) {
      console.error(`      ${chalk.red('✗')} Failed to update route ${chalk.cyan(route.pattern)}${chalk.dim(`: ${error.message}`)}`);
      output.errors.push({ route: route.pattern, error: error.message });
    }
  }

  // Delete stale routes (before workers — routes reference worker scripts)
  for (const route of routesToDelete) {
    try {
      await api.makeRequest(`/zones/${zoneId}/workers/routes/${route.id}`, { method: 'DELETE' });
      output.routesDeleted.push(route.pattern);
      console.log(`      ${chalk.green('✓')} Removed route: ${chalk.cyan(route.pattern)}`);
    } catch (error) {
      console.error(`      ${chalk.red('✗')} Failed to remove route ${chalk.cyan(route.pattern)}${chalk.dim(`: ${error.message}`)}`);
      output.errors.push({ route: route.pattern, error: error.message });
    }
  }

  // Delete stale workers
  for (const worker of workersToDelete) {
    try {
      await api.makeRequest(`/accounts/${accountId}/workers/scripts/${worker.id}`, { method: 'DELETE' });
      output.workersDeleted.push(worker.id);
      console.log(`      ${chalk.green('✓')} Removed worker: ${chalk.cyan(worker.id)}`);
    } catch (error) {
      console.error(`      ${chalk.red('✗')} Failed to remove worker ${chalk.cyan(worker.id)}${chalk.dim(`: ${error.message}`)}`);
      output.errors.push({ worker: worker.id, error: error.message });
    }
  }

  return {
    status: output.errors.length > 0 ? 'warned' : 'success',
    ...(output.errors.length > 0 ? { reason: `${output.errors.length} worker(s) failed: ${output.errors.map((e) => e.worker).join(', ')}` } : {}),
    output: { workers: output },
  };
};
