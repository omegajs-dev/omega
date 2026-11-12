/**
 * The daily prune job (src/hooks/cron/daily/prune-notes.js), run the way the
 * cron runner runs it: the staged module, called with the real omega and ctx.
 *
 * Run (from this target): npx omega test hooks/prune-notes
 */
const path = require('path');
const { defineCases } = require('@omega.js/backend/test');

const OWNER = '_test-notes-prune';
const DAY = 24 * 60 * 60;

function note(id, ageDays) {
  const timestampUNIX = Math.round(Date.now() / 1000) - (ageDays * DAY);

  return {
    id,
    owner: OWNER,
    text: `${ageDays} days old`,
    metadata: { created: { timestamp: new Date(timestampUNIX * 1000).toISOString(), timestampUNIX } },
  };
}

module.exports = defineCases({
  description: 'Notes: the daily job prunes notes older than 30 days',
  type: 'suite',
  timeout: 30000,

  tests: [
    {
      name: 'old-notes-go-and-recent-notes-stay',

      async run({ omega, ctx, firestore, expect }) {
        await firestore.set('notes/prune-old', note('prune-old', 31));
        await firestore.set('notes/prune-recent', note('prune-recent', 29));

        // The runner reads the STAGED job's default export off omega.cwd, and so does this
        const job = require(path.join(omega.cwd, 'hooks', 'cron', 'daily', 'prune-notes.js')).default;
        const result = await job({ ctx, omega, context: {} });

        expect(result.pruned >= 1, 'the job reports what it deleted').toBeTruthy();
        expect(await firestore.exists('notes/prune-old'), 'a 31-day-old note is pruned').toBe(false);
        expect(await firestore.exists('notes/prune-recent'), 'a 29-day-old note is kept').toBeTruthy();
      },
    },
  ],
});
