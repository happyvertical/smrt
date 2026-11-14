import { describe, expect, it } from 'vitest';
import { toolSummary } from './tool-summary.ts';

describe('human tool summaries', () => {
  it.each([
    {
      summary: 'add Product.notes',
      statements: ['ALTER TABLE products'],
      snapshot: '/private/tmp/a.db',
    },
    { data: { summary: 'add Product.notes' } },
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ data: { summary: 'add Product.notes' } }),
        },
      ],
    },
  ])('unwraps builder results without displaying their payload', (result) => {
    expect(toolSummary('app_addfield', JSON.stringify(result))).toBe(
      'add Product.notes',
    );
  });
  it.each([
    undefined,
    null,
    '{"data":',
    { snapshot: '/private/tmp/a.db' },
    'ALTER TABLE products ADD notes',
    '/Users/person/app.db',
  ])('uses a safe phrase for unknown or malformed results: %s', (result) => {
    expect(toolSummary('unknown_tool', result)).toBe('Completed this action');
  });
  it('summarizes describe and list operations and failures', () => {
    expect(toolSummary('app_describe', '{"data":{"models":{}}}')).toBe(
      'Checked the app structure',
    );
    expect(toolSummary('product_list', [{ price: 100 }])).toBe(
      'Checked records',
    );
    expect(toolSummary('app_addfield', 'SQL /private/tmp/a.db', false)).toBe(
      'Could not complete this action',
    );
  });
});
