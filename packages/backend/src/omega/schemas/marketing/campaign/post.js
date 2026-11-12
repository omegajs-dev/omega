/**
 * Schema for POST /marketing/campaign
 */
export default() => ({
  // Identity
  id: { type: 'string', default: '' },
  type: { type: 'string', default: 'email' },

  // Content
  name: { type: 'string', required: true },
  subject: { type: 'string', required: true },
  preheader: { type: 'string', default: '' },
  template: { type: 'string', default: 'card' },
  data: { type: 'object', default: {} },

  // Targeting
  lists: { type: 'array', default: [] },
  segments: { type: 'array', default: [] },
  excludeSegments: { type: 'array', default: [] },
  all: { type: 'boolean', default: false },

  // Scheduling
  sendAt: { type: ['string', 'number'], default: '' },
  recurrence: { type: 'object' },  // { pattern: 'weekly'|'monthly'|'quarterly'|'yearly'|'daily', hour?, day?, month? }

  // UTM
  utm: { type: 'object', default: {} },

  // Lineage
  recurringId: { type: 'string', default: '' },

  // Push notification targeting
  filters: { type: 'object', default: {} },

  // Config
  test: { type: 'boolean', default: false },
  sender: { type: 'string', default: 'marketing' },
  providers: { type: 'array', default: [] },
  group: { type: 'string', default: '' },
  categories: { type: 'array', default: [] },
});
