// Optional consumer extension hook: called by `omega deploy` on both lanes, after the local
// scaffold and BEFORE the network precheck, the dispatch, or a local publish. No-op by default.
// A dry run skips it.
//
// Use this for: resetting a release the deploy will recreate, last-mile validations, anything
// that must happen before the publish reaches the release repo.

export default async (ctx) => {
  // ctx = { build, projectRoot, mode }
};
