/**
 * Schema for PUT /marketing/campaign
 * All fields optional except id — only provided fields are updated.
 */
export default() => ({
  id: { type: 'string', required: true },
  type: { type: 'string', default: '' },

  // Content
  name: { type: 'string', default: '' },
  subject: { type: 'string', default: '' },
  preheader: { type: 'string', default: '' },
  template: { type: 'string', default: '' },
  content: { type: 'string', default: '' },
  data: { type: 'object' },

  // Targeting
  lists: { type: 'array' },
  segments: { type: 'array' },
  excludeSegments: { type: 'array' },
  all: { type: 'boolean' },

  // Scheduling
  sendAt: { type: ['string', 'number'], default: '' },
  recurrence: { type: 'object' },

  // UTM
  utm: { type: 'object' },

  // Config
  sender: { type: 'string', default: '' },
  providers: { type: 'array' },
  group: { type: 'string', default: '' },
  categories: { type: 'array' },
});
