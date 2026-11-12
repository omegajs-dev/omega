/**
 * The GitHub write POST /admin/repo/content makes.
 */
const { writeFileBothBranches } = require('../../lib/deploy-branch.js');

// Helper: Upload content to GitHub
async function uploadContent(ctx, octokit, data) {
  const owner = data.githubUser;
  const repo = data.githubRepo;
  const filename = data.repoPath;
  const content = data.content;

  ctx.log('uploadContent(): filename', filename);

  // Get existing file
  const existing = await octokit.rest.repos.getContent({
    owner: owner,
    repo: repo,
    path: filename,
  }).catch(e => e);

  ctx.log('uploadContent(): Existing', existing);

  // Quit if error and it's DIFFERENT than 404
  if (existing instanceof Error && existing?.status !== 404) {
    throw existing;
  }

  // Upload content to BOTH branches: the default branch is the record, and the
  // deploy branch is what CI builds, so content that skipped it would never
  // reach the live site on a brand running local framework packages.
  const { result, deployBranch } = await writeFileBothBranches({
    ctx,
    octokit,
    owner: owner,
    repo: repo,
    path: filename,
    sha: existing?.data?.sha || undefined,
    message: `📦 admin/repo/content ${filename}`,
    content: content,
  });

  data.deployBranch = deployBranch;

  ctx.log('uploadContent(): Result', result);

  return result;
}

module.exports = { uploadContent };
