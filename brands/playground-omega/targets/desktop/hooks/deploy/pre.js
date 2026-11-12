// The playground desktop target's pre-deploy hook (#900, the rework of #899):
// prune the `v<version>` releases on the playground's releases repo down to the
// newest, so a deploy leaves two live. The VERSION comes from `omega bump` at
// the brand root (#869), never from here, and this deploy refuses the target if
// it drifted from the brand's number. The lane itself is shared with the
// extension target, at `scripts/release-lane.js`.

import prepareRelease from '../../../../scripts/release-lane.js';

export default (ctx) => prepareRelease(ctx, { tagFamily: /^v\d/ });
