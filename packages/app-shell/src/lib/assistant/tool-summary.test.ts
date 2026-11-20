import { describe, expect, it } from 'vitest';
import {
  reportLink,
  reportPresentation,
  shownSummary,
  toolSummary,
} from './tool-summary.ts';

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
    '/home/person/app.db',
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

describe('plain failure reasons for the owner', () => {
  const operator =
    "Invalid WHERE clause operator: 'ne'. Valid operators: =, !=, >, <, like";
  it.each([
    operator,
    { error: operator },
    { content: [{ type: 'text', text: JSON.stringify({ error: operator }) }] },
    JSON.stringify({ structuredContent: { error: { message: operator } } }),
  ])('explains a rejected filter without echoing the raw error: %s', (result) => {
    const summary = toolSummary('dog_list', result, false);
    expect(summary).toBe(
      'That search used a comparison the app cannot do, so nothing was looked up.',
    );
    expect(summary).not.toMatch(/WHERE|operator/);
  });
  it('never leaks SQL, paths or ids from a recognised failure', () => {
    expect(
      toolSummary(
        'dog_create',
        'UNIQUE constraint failed: dogs.id /private/tmp/a.db 12345678-1234-1234-1234-123456789012',
        false,
      ),
    ).toBe('A record with those details already exists.');
  });
  it('keeps the reason stable when a stored summary is shown again', () => {
    for (const raw of [
      operator,
      'Invalid WHERE clause field: owner. Field does not exist on Dog. Valid fields: id',
      'Record not found',
    ]) {
      const first = toolSummary('dog_list', raw, false);
      expect(first).not.toBe('Could not complete this action');
      expect(shownSummary('dog_list', first, false)).toBe(first);
    }
  });
  it('still falls back for unrecognised failures', () => {
    expect(toolSummary('dog_list', 'driver exploded at /tmp/x', false)).toBe(
      'Could not complete this action',
    );
  });
});

it('shows the plain reason for a rejected report filter, live and after a reload (#5172)', () => {
  const summary =
    'A filter in that report used a comparison the app cannot do, so nothing was run.';
  const failure = {
    kind: 'report_failure',
    summary,
    error:
      'The report definition is invalid at spec.filters[0].op: must be one of: eq, ne. Correct that part and run the report again.',
  };
  expect(toolSummary('app_runreport', failure, false)).toBe(summary);
  expect(shownSummary('app_runreport', summary, false)).toBe(summary);
  expect(toolSummary('app_runreport', failure, false)).not.toMatch(
    /Could not complete/,
  );
});
