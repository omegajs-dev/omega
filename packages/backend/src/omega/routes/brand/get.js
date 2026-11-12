/**
 * GET /brand - Public brand configuration
 * Returns a safe subset of the project's config (no secrets)
 */
import { buildPublicConfig } from './public-config.js';

export default async ({ ctx, omega }) => {
  const config = omega.config;

  return ctx.respond(buildPublicConfig(config));
};
