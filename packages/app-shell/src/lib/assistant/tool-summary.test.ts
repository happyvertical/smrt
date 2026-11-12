import { describe, expect, it } from 'vitest';
import { reportLink, reportPresentation, toolSummary } from './tool-summary.ts';

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

it('accepts only a valid engine report result and same-origin report links', async () => {
  const { result } = await import('../../test/report-fixtures.ts');
  const data = { ...result, reportName: 'sales' };
  expect(
    reportPresentation('app_runreport', {
      content: [{ text: JSON.stringify(data) }],
    })?.href,
  ).toBe('/reports/sales');
  expect(reportPresentation('other_tool', data)).toBeUndefined();
  expect(reportPresentation('app_runreport', data, false)).toBeUndefined();
  expect(
    reportPresentation('app_runreport', { ...data, rows: [{}] }),
  ).toBeUndefined();
  expect(reportLink('javascript:alert(1)')).toBeUndefined();
  expect(
    reportPresentation('app_runreport', { ...data, reportName: '../secret' })
      ?.href,
  ).toBeUndefined();
});
it.each([
  'Made the report Sales by month',
  'Ran Sales by month: 12 rows',
  'Loaded 240 Orders',
  'Merged 3 Customers into Acme Ltd',
  'Calculated Total',
])('preserves safe new-tool summaries: %s', (summary) => {
  expect(toolSummary('app_runreport', { summary })).toBe(summary);
  expect(
    toolSummary('app_mergerecords', {
      summary: 'Merged into 12345678-1234-1234-1234-123456789012',
    }),
  ).not.toContain('12345678');
});

it('preserves a server-tagged report failure across CLI/MCP envelopes while keeping failures sanitized', () => {
  const summary =
    'The total of Total is too large to show exactly. One of the Orders probably has a mistyped Quantity or Price.';
  const failure = { kind: 'report_failure', summary };
  for (const value of [
    failure,
    { structuredContent: failure },
    { content: [{ text: JSON.stringify(failure) }] },
    JSON.stringify({ result: failure }),
  ])
    expect(toolSummary('app_runreport', value, false)).toBe(summary);
  expect(
    toolSummary(
      'app_runreport',
      {
        kind: 'report_failure',
        summary: 'SELECT password FROM /private/app.db',
      },
      false,
    ),
  ).toBe('Could not complete this action');
  expect(toolSummary('app_runreport', 'arbitrary driver text', false)).toBe(
    'Could not complete this action',
  );
});
