import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { queryReportMaterializedRows } from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../collections/ContractCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { TaxSummaryReportCollection } from '../collections/TaxSummaryReportCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';
import { TaxSummaryReport } from '../models/TaxSummaryReport.js';
import {
  buildTaxSummaryReportAdapterDescriptor,
  drilldownTaxSummaryInvoiceFacts,
  TAX_SUMMARY_REPORT_ADAPTER,
} from '../tax-summary-report-adapter.js';
import { seedInvoiceTaxReportFacts } from './helpers/invoice-tax-report-facts.js';

const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

describe('TaxSummaryReport invoice source (#3940)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activateV2(tenantId: string): Promise<void> {
    const settings = await TaxSettingsCollection.create({ db });
    const migrationId = await settings.beginMoneyMigration(tenantId);
    await settings.activateMoneyV2(tenantId, migrationId);
  }

  it('materializes exact persisted A/B sales rows, DataTable descriptor, and a tenant-bound drilldown', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, () =>
      activateV2(fixture.tenantId),
    );
    const expenses = {
      listReviewedTaxFacts: vi.fn().mockResolvedValue([]),
    };
    const ledgers = {
      listPostedMovements: vi
        .fn()
        .mockImplementation(({ accountIds }: { accountIds: string[] }) =>
          Promise.resolve(
            accountIds.map((accountId) => ({
              tenantId: fixture.tenantId,
              entryId: `entry-${accountId}`,
              accountId,
              currency: 'CAD',
              creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
            })),
          ),
        ),
    };
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: expenses,
      ledgerSource: ledgers,
      expenseComponentMappings: [],
    });

    expect(result).toEqual({ rowCount: 5, complete: true });
    expect(expenses.listReviewedTaxFacts).toHaveBeenCalledWith({
      tenantId: fixture.tenantId,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: 'gst',
          taxableMinor: 221_549,
          taxMinor: 11_078,
          netTaxMinor: 11_078,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: 'pst',
          taxableMinor: 63_406,
          taxMinor: 4_439,
          netTaxMinor: 4_439,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'kind',
          taxCodeKind: 'taxable',
          taxableMinor: 221_549,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'reconciliation',
          taxComponentId: 'gst',
          differenceMinor: 0,
        }),
      ]),
    );

    const gstRow = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    if (!gstRow?.id) throw new Error('Expected GST materialized report row.');
    const drilldown = await drilldownTaxSummaryInvoiceFacts(db, {
      tenantId: fixture.tenantId,
      reportId: gstRow.id,
    });
    expect(drilldown).toHaveLength(4);
    await expect(
      drilldownTaxSummaryInvoiceFacts(db, {
        tenantId: 'tenant-b',
        reportId: gstRow.id,
      }),
    ).rejects.toThrow('not visible to this tenant');

    const descriptor = await buildTaxSummaryReportAdapterDescriptor();
    expect(descriptor.tenantScoped).toBe(true);
    expect(descriptor.dataTable.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'period_from', valueFormat: 'datetime' }),
        expect.objectContaining({ id: 'net_tax_minor', valueFormat: 'money' }),
      ]),
    );
    const dataTableRows = await withTenant({ tenantId: fixture.tenantId }, () =>
      queryReportMaterializedRows(
        TaxSummaryReport,
        {
          version: 1,
          requestId: 'tax-summary-visible',
          mode: 'rows',
          projection: ['id', 'tax_component_id', 'taxable_minor'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        {
          db,
          collection: reports,
          adapter: TAX_SUMMARY_REPORT_ADAPTER,
          execution: 'visible',
        },
      ),
    );
    expect(dataTableRows).toMatchObject({
      execution: 'visible',
      rows: expect.arrayContaining([
        expect.objectContaining({
          tax_component_id: 'gst',
          taxable_minor: 221_549,
        }),
      ]),
      total: { kind: 'exact', value: 5 },
    });
  });

  it('refuses a legacy tenant or missing owner adapters instead of presenting an incomplete total', async () => {
    const reports = await TaxSummaryReportCollection.create({ db });
    await expect(
      reports.refreshTaxSummary({
        tenantId: 'tenant-a',
        from,
        to,
        expenseSource: { listReviewedTaxFacts: async () => [] },
        ledgerSource: { listPostedMovements: async () => [] },
        expenseComponentMappings: [],
      }),
    ).rejects.toThrow('activated v2 money model');

    await withTenant({ tenantId: 'tenant-a' }, () => activateV2('tenant-a'));
    await expect(
      reports.refreshTaxSummary({
        tenantId: 'tenant-a',
        from,
        to,
        expenseSource: undefined as never,
        ledgerSource: { listPostedMovements: async () => [] },
        expenseComponentMappings: [],
      }),
    ).rejects.toThrow('explicit expense and ledger source adapters');
  });

  it('materializes an unknown nullable tax-code kind as an incomplete warning', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, async () => {
      const taxes = await DocumentTaxCollection.create({ db });
      await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: fixture.tenantId,
        documentType: 'invoice',
        documentId: fixture.invoiceAId,
        rows: [
          {
            tenantId: fixture.tenantId,
            documentType: 'invoice',
            documentId: fixture.invoiceAId,
            currency: 'CAD',
            taxCodeId: null,
            taxCodeCode: null,
            kind: null,
            taxComponentId: null,
            taxComponentName: null,
            percent: null,
            liabilityAccountId: null,
            taxableMinor: 1,
            taxMinor: 0,
            recoverableMinor: 0,
          },
        ],
      });
      await activateV2(fixture.tenantId);
    });
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: { listPostedMovements: async () => [] },
      expenseComponentMappings: [],
    });
    expect(result.complete).toBe(false);
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'warning',
          warningCode: 'unassigned-tax-code',
          taxCodeKind: null,
          complete: false,
        }),
      ]),
    );
    expect(rows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'kind',
          taxCodeKind: 'out-of-scope',
        }),
      ]),
    );
  });
});
