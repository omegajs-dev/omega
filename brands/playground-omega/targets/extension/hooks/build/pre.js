// Libraries
import build from '@omega.js/extension/build';
const logger = build.logger('build:pre');

// Hook
export default async ({ projectRoot, mode }) => {
  logger.log(`Running in ${mode} mode from ${projectRoot}`);
}
