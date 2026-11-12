import path from 'path';
import { getRoster } from '../../../../test/roster.js';
import { loadSeedAccounts } from '../../../../test/seed.js';

/**
 * GET /test/roster: the personas the dev palette offers, straight off the seed
 * (the framework's table plus the project's `test/_init.js` accounts), so the
 * palette keeps no list of its own. Development/testing only, and unauthenticated
 * on purpose: the palette asks before anybody is signed in.
 *
 * `?machinery=true` is the sign-in lanes' door: a TESTING backend then offers
 * every seeded account, so a suite finds its own persona here. Any other
 * environment ignores it, and the palette never asks.
 */
export default async ({ ctx, data }) => {
  // Emulator-only: never a route outside development/testing (an explicit
  // positive check, per the context contract, not `!isProduction()`)
  if (!ctx.isDevelopment() && !ctx.isTesting()) {
    return ctx.respond('Not found', { code: 404 });
  }

  // omega.cwd is the consumer's functions/ directory; test/_init.js lives one
  // level up at <projectRoot>/test/ — the same resolution the test-mode watcher
  // makes. Loaded once per process, not per request.
  const projectDir = path.dirname(ctx.omega.cwd);
  const projectAccounts = loadSeedAccounts({ projectDir, config: ctx.omega.config, omega: ctx.omega });

  const personas = getRoster(projectAccounts, { testing: ctx.isTesting(), machinery: data.machinery });
  const machineryServed = personas.some((persona) => persona.label === null);

  ctx.log(`test/roster: ${personas.length} persona(s)${machineryServed ? ' (machinery included)' : ''}`);

  return ctx.respond({ personas });
};
