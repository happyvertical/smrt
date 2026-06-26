import { describe, expect, it } from 'vitest';
import { reportRowIdentity } from '../refresh.js';
import type { ReportDefinition } from '../types.js';

describe('report refresh', () => {
  it('uses stable IDs from grouping columns', () => {
    const definition: ReportDefinition = {
      reportClassName: 'RefreshRevenueReport',
      sourceClassName: 'RefreshInvoice',
      sourceTable: 'refresh_invoices',
      fields: [
        {
          fieldName: 'customerId',
          columnName: 'customer_id',
          report: { kind: 'group', sourceColumn: 'customerId' },
        },
      ],
    };
    const row = { customer_id: 'cust_1', revenue: 125 };

    expect(reportRowIdentity(row, definition)).toBe(
      reportRowIdentity(row, definition),
    );
  });
});
