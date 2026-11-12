/**
 * The one commit POST /admin/post makes: every file (images + post) through the
 * Git Trees API, then the same tree on the deploy branch.
 */
const { commitTreeToDeployBranch } = require('../lib/deploy-branch.js');

// Helper: Commit all files (images + post) in a single commit using Git Trees API
async function commitAll(ctx, octokit, data, files) {
  const owner = data.githubUser;
  const repo = data.githubRepo;

  ctx.log('commitAll(): Committing', files.length, 'files');

  // Get the latest commit SHA on the default branch
  const refResult = await octokit.rest.git.getRef({
    owner: owner,
    repo: repo,
    ref: 'heads/master',
  }).catch(() => {
    // Try 'main' if 'master' fails
    return octokit.rest.git.getRef({
      owner: owner,
      repo: repo,
      ref: 'heads/main',
    });
  });

  const latestCommitSha = refResult.data.object.sha;
  const branch = refResult.data.ref;

  ctx.log('commitAll(): Latest commit', latestCommitSha, 'on', branch);

  // Get the tree SHA of the latest commit
  const commitResult = await octokit.rest.git.getCommit({
    owner: owner,
    repo: repo,
    commit_sha: latestCommitSha,
  });

  const baseTreeSha = commitResult.data.tree.sha;

  // Create blobs for each file
  const treeItems = [];

  for (const file of files) {
    const blob = await octokit.rest.git.createBlob({
      owner: owner,
      repo: repo,
      content: file.content,
      encoding: file.encoding,
    });

    ctx.log('commitAll(): Created blob for', file.path, blob.data.sha);

    treeItems.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.data.sha,
    });
  }

  // Create a new tree with all files
  const newTree = await octokit.rest.git.createTree({
    owner: owner,
    repo: repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  ctx.log('commitAll(): Created tree', newTree.data.sha);

  // Create the commit
  const postPath = files[files.length - 1].path;
  const message = `📦 admin/post:create ${postPath}`;
  const newCommit = await octokit.rest.git.createCommit({
    owner: owner,
    repo: repo,
    message: message,
    tree: newTree.data.sha,
    parents: [latestCommitSha],
  });

  ctx.log('commitAll(): Created commit', newCommit.data.sha);

  // Update the branch ref to point to the new commit
  const updateResult = await octokit.rest.git.updateRef({
    owner: owner,
    repo: repo,
    ref: branch.replace('refs/', ''),
    sha: newCommit.data.sha,
  });

  ctx.log('commitAll(): Updated ref', updateResult.data.object.sha);

  // The same files, on the branch CI builds. The blobs above are repo-level
  // objects, so the tree items are reused and nothing uploads twice; a brand
  // with no deploy branch yet keeps the commit above and is told so.
  const deployed = await commitTreeToDeployBranch({
    ctx,
    octokit,
    owner: owner,
    repo: repo,
    tree: treeItems,
    message: message,
    what: postPath,
  });

  data.deployBranch = deployed.deployBranch;

  return updateResult;
}

module.exports = { commitAll };
