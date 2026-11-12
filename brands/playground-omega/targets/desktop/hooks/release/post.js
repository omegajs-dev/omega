// Optional consumer extension hook — called AFTER the release publishes successfully (after
// electron-builder + mirror-downloads finish). No-op by default.
//
// Use this for: posting to Slack/Discord, kicking off downstream workflows, updating a
// changelog page on your marketing site, sending notification emails.

export default async (ctx) => {
  // ctx = { build, projectRoot, artifacts }   // artifacts: array of release/ paths
};
