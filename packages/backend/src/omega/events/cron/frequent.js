import { run } from '../../cron.js';

export default async ({ ctx, omega, context }) => run('frequent', { ctx, omega, context });
