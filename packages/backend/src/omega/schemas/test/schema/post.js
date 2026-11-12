/**
 * The reference schema: every field option of the declaration vocabulary, and
 * a plan split. test/helpers/settings.test.js pins its resolved output.
 */
export default({ user }) => {
  const isPremium = user.plan !== 'basic';

  const fields = {
    // Basic types
    stringField: { type: 'string', default: 'default-string' },
    numberField: { type: 'number', default: 42 },
    booleanField: { type: 'boolean', default: false },
    arrayField: { type: 'array', default: ['a', 'b', 'c'] },
    objectField: { type: 'object', default: { key: 'value' } },

    // Required fields (only required for premium users: a plan split)
    requiredField: { type: 'string', required: true },
    conditionalRequired: { type: 'string', required: isPremium },

    // Function defaults
    functionDefault: { type: 'string', default: () => `generated-${Date.now()}` },
    userBasedDefault: { type: 'string', default: user.uid || 'anonymous' },

    // Forced value (overrides user input)
    forcedValue: { type: 'string', value: 'always-this-value' },

    // Min/max for numbers
    minNumber: { type: 'number', default: 5, min: 1 },
    maxNumber: { type: 'number', default: 50, max: 100 },
    clampedNumber: { type: 'number', default: 50, min: 10, max: 100 },

    // Min/max for strings (length)
    maxLengthString: { type: 'string', default: '', max: 10 },

    // Min/max for arrays (length), and each item through `of`
    maxLengthArray: { type: 'array', default: [], max: 3 },
    tags: { type: 'array', of: { type: 'string', max: 5 }, default: [], max: 3 },

    // Plan-based limits
    planBasedLimit: { type: 'number', default: 10, min: 1, max: 100 },

    // Multiple allowed types
    multiType: { type: ['string', 'number'], default: 'default' },

    // Any type
    anyType: { type: 'any', default: null },

    // Allowed values and a pattern (both judge only what the caller sent)
    mode: { type: 'string', enum: ['quick', 'full'], default: 'quick' },
    zip: { type: 'string', pattern: /^\d{5}$/ },

    // Clean with regex
    cleanedString: { type: 'string', default: '', clean: /[^a-zA-Z0-9]/g },

    // Clean with function
    cleanedFunction: { type: 'string', default: '', clean: (value) => value.toLowerCase().trim() },

    // Nested object
    nested: { type: 'object', fields: {
      level1: { type: 'string', default: 'nested-default' },
    } },
  };

  if (isPremium) {
    fields.planBasedLimit.max = 1000;

    // Premium-only field (not available to basic users)
    fields.premiumOnlyField = { type: 'string', default: 'premium-feature' };
  }

  return fields;
};
