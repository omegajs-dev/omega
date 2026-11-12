/**
 * Marketing contact pruning cron job: runs daily, acts on the 1st of each month,
 * and is on unless marketing.prune.enabled is false. Strictly per role: each
 * provider's own engagement decides its own removals, paying customers are kept,
 * and removal is a DELETE, never an unsubscribe.
 *
 *   Stage 1: a re-engagement email to engagement_inactive_5m (excluding _6m),
 *            through the campaigns role, whose provider holds those segments.
 *   Stage 2: the campaigns provider deletes its brand-scoped _6m contacts.
 *   Stage 3: the newsletter provider deletes subscribers inactive by its own stats.
 * The stages: ../helpers/marketing-prune.js.
 */
import { stageReengage, stagePrune, stageNewsletterPrune } from '../helpers/marketing-prune.js';

export default async ({ ctx, omega }) => {
  if (new Date().getDate() !== 1) {
    return;
  }

  // `!== false`, not `!== true`: the switch is default-ON, so a config assembled
  // outside loadConfig()'s materialization (a hand-built omega.config, a test
  // fixture) still runs the monthly prune the schema promises
  if (omega.config?.marketing?.prune?.enabled === false) {
    ctx.log('Marketing prune: disabled (marketing.prune.enabled resolved false, the schema default is true)');
    return;
  }

  const brand = omega.config?.brand;

  ctx.log(`Marketing prune: Starting monthly prune cycle for ${brand?.id || 'unknown'}`);

  // --- Stage 1: Re-engagement email ---
  try {
    await stageReengage(omega, ctx);
  } catch (e) {
    ctx.error('Marketing prune: Stage 1 (re-engagement) failed:', e.message);
  }

  // --- Stage 2: Delete SendGrid-inactive contacts from SendGrid ---
  // Each stage is caught on its own: the lanes are independent by design, so a
  // provider outage in one must never cost the others their monthly run.
  try {
    await stagePrune(omega, ctx);
  } catch (e) {
    ctx.error('Marketing prune: Stage 2 (SendGrid prune) failed:', e.message);
  }

  // --- Stage 3: Delete Beehiiv-inactive subscribers from Beehiiv ---
  try {
    await stageNewsletterPrune(omega, ctx);
  } catch (e) {
    ctx.error('Marketing prune: Stage 3 (Beehiiv prune) failed:', e.message);
  }

  ctx.log(`Marketing prune: Completed for ${brand?.id || 'unknown'}`);
};
