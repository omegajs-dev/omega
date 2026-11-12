import { run } from '../../cron.js';

export default async ({ ctx, omega, context }) => run('daily', { ctx, omega, context });
