import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { historicalSalesReportInvoices } from '../historical-sales-reports.js';
import type { Invoice } from '../models/Invoice.js';

const options = {
  tenantId: 'report-tenant',
  from: new Date('2020-01-01T00:00:00.000Z'),
  to: new Date('2020-01-31T23:59:59.999Z'),
  currency: 'CAD',
};
afterEach(() => vi.restoreAllMocks());
describe('historical report query scope before archive cap', () => {
  it('returns a small matching scope instead of consuming the unrelated archive', async () => {
    const selected = {
      id: 'matching',
      status: 'sent',
      issueDate: options.from,
      currency: 'CAD',
    } as Invoice;
    const list = vi.fn(
      async (query: { where?: Record<string, unknown>; limit?: number }) => {
        // Model a large archive without materializing unrelated database rows.
        const expected = {
          tenantId: options.tenantId,
          moneyAuthority: 'historical',
          'issueDate >=': options.from.toISOString(),
          'issueDate <=': options.to.toISOString(),
          'status not in': ['draft', 'cancelled'],
          currency: 'CAD',
        };
        return isDeepStrictEqual(query.where, expected)
          ? [selected]
          : new Array<Invoice>(100001);
      },
    );
    vi.spyOn(InvoiceCollection, 'create').mockResolvedValue({
      list,
    } as unknown as InvoiceCollection);
    await expect(
      historicalSalesReportInvoices({} as never, options),
    ).resolves.toEqual([selected]);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100001 }),
    );
  });
  it('refuses an oversized matching scope instead of truncating it', async () => {
    const list = vi.fn().mockResolvedValue(new Array<Invoice>(100001));
    vi.spyOn(InvoiceCollection, 'create').mockResolvedValue({
      list,
    } as unknown as InvoiceCollection);
    await expect(
      historicalSalesReportInvoices({} as never, options),
    ).rejects.toThrow('scope exceeds');
  });
  it('omits only the optional currency predicate for a multi-currency report', async () => {
    const list = vi.fn().mockResolvedValue([]);
    vi.spyOn(InvoiceCollection, 'create').mockResolvedValue({
      list,
    } as unknown as InvoiceCollection);
    const { currency: _currency, ...period } = options;
    await historicalSalesReportInvoices({} as never, period);
    expect(list.mock.calls[0][0].where).toEqual({
      tenantId: options.tenantId,
      moneyAuthority: 'historical',
      'issueDate >=': options.from.toISOString(),
      'issueDate <=': options.to.toISOString(),
      'status not in': ['draft', 'cancelled'],
    });
  });
});
