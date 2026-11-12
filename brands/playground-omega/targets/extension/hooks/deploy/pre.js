// The playground extension target's pre-deploy hook (#900): prune the
// `extension-v<version>` releases on the playground's releases repo down to the
// newest, so a deploy leaves two live. The Firefox store refuses a version it
// already holds ("Version 0.0.1 already exists"), so every deploy must carry a
// fresh one: that number comes from `omega bump` at the brand root (#869), never
// from here. The lane itself is shared with the desktop target, at
// `scripts/release-lane.js`.

import prepareRelease from '../../../../scripts/release-lane.js';

export default (ctx) => prepareRelease(ctx, { tagFamily: /^extension-v/ });
