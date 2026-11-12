/**
 * The GitHub write PUT /admin/post makes for an edited post.
 */
const { writeFileBothBranches } = require('../lib/deploy-branch.js');

// Helper: Upload post to GitHub
async function uploadPost(ctx, octokit, data, fetchedPost) {
  const filename = fetchedPost.path;
  const sha = fetchedPost.sha;
  const frontmatter = fetchedPost.frontmatter;
  const owner = data.githubUser;
  const repo = data.githubRepo;

  // Combine content
  const fullContent = `---\n${frontmatter}\n---\n\n${data.body}`;

  // Upload post to BOTH branches: the default branch is the record, and the
  // deploy branch is what CI builds, so a post that skipped it would never
  // reach the live site on a brand running local framework packages.
  const { result, deployBranch } = await writeFileBothBranches({
    ctx,
    octokit,
    owner: owner,
    repo: repo,
    path: filename,
    sha: sha,
    message: `📦 admin/post:edit ${filename}`,
    content: fullContent,
  });

  data.deployBranch = deployBranch;

  ctx.log('uploadPost(): Result', result);

  return result;
}

module.exports = { uploadPost };
