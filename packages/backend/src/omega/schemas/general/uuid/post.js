import env from '../../../libraries/env.js';

export default() => ({
  name: { type: 'string' },
  input: { type: 'string' },
  version: { type: ['string', 'number'], default: '5' },
  namespace: { type: 'string', default: env.get('OMEGA_NAMESPACE') },
});
