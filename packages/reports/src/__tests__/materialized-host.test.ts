import { describe, expect, it } from 'vitest';
import { assertMaterializedReportRead } from '../materialized-host.js';

const host = {
  id: 'tax-summary',
  collection: 'taxsummaryreports',
  className: 'TaxSummaryReport',
  readPermission: 'taxsummaryreports.read',
  descriptor: async () => {
    throw new Error('unused');
  },
  query: async () => {
    throw new Error('unused');
  },
  drilldown: async () => {
    throw new Error('unused');
  },
};

describe('materialized report hosts', () => {
  it('fails closed when the authenticated principal lacks the declared read permission', () => {
    expect(() =>
      assertMaterializedReportRead(host, {
        userId: 'u',
        tenantId: 'a',
        permissions: [],
      }),
    ).toThrow(/access denied/i);
    expect(() =>
      assertMaterializedReportRead(host, {
        userId: 'u',
        tenantId: 'a',
        permissions: ['taxsummaryreports.read'],
      }),
    ).not.toThrow();
  });
});
