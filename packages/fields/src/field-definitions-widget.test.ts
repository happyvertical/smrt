import { describe, expect, it } from 'vitest';
import { sanitizeFieldUIHints } from './field-definitions.js';

describe('sanitizeFieldUIHints ui.widget (#3599)', () => {
  it('keeps a known widget beside the existing hints', () => {
    expect(
      sanitizeFieldUIHints({ widget: 'currency', basic: true, order: 2 }),
    ).toEqual({ widget: 'currency', basic: true, order: 2 });
  });

  it.each(['slider', 3, null, ''])('drops the junk widget %j', (widget) => {
    expect(sanitizeFieldUIHints({ widget })).toBeUndefined();
  });
});

describe('sanitizeFieldUIHints ui.format (#3718)', () => {
  it('keeps a known format and drops junk', () => {
    expect(sanitizeFieldUIHints({ format: 'money', basic: true })).toEqual({
      format: 'money',
      basic: true,
    });
    expect(sanitizeFieldUIHints({ format: 'cents' })).toBeUndefined();
  });
});
