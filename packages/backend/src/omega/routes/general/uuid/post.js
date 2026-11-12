import * as uuid from 'uuid';

export default async ({ ctx, data, analytics }) => {

  const name = data.name || data.input;
  const version = `${data.version}`.replace('v', '');
  const namespace = data.namespace;

  // Validate version
  if (version !== '4' && version !== '5') {
    return ctx.respond(`v${version} is not a valid version.`, { code: 400 });
  }

  // Validate name for v5
  if (version === '5' && !name) {
    return ctx.respond('You must provide a name to hash for UUID v5.', { code: 400 });
  }

  // Generate UUID
  const result = version === '5'
    ? uuid.v5(name, namespace)
    : uuid.v4();

  // Send analytics event
  analytics.event('general/uuid', { version });

  // Log and respond
  ctx.log('UUID Generated', { name, version, namespace, result });

  return ctx.respond({ uuid: result });
};
