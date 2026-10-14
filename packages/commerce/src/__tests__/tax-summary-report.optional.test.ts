import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { TaxSummaryReportCollection } from '../collections/TaxSummaryReportCollection.js';
import { drilldownTaxSummaryInvoiceFacts } from '../tax-summary-report-adapter.js';
import { seedInvoiceTaxReportFacts } from './helpers/invoice-tax-report-facts.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

describePostgres('TaxSummaryReport on PostgreSQL (#3940)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'Customer',
        'DocumentTax',
        'Invoice',
        'InvoiceLineItem',
        'PaymentAllocation',
        'TaxSettings',
        'TaxSummaryReport',
      ],
    });
    db = isolated.baseDb;
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('materializes and drills down tenant-scoped persisted A/B Invoice facts', async () => {
    const tenantId = randomUUID();
    const fixture = await withTenant({ tenantId }, () =>
      seedInvoiceTaxReportFacts(db, tenantId, randomUUID()),
    );
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
    });
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: {
        listPostedMovements: async ({ accountIds }) =>
          accountIds.map((accountId) => ({
            tenantId,
            entryId: `${accountId}-entry`,
            accountId,
            currency: 'CAD',
            creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
          })),
      },
      expenseComponentMappings: [],
    });
    expect(result).toEqual({ rowCount: 5, complete: true });
    const rows = await withTenant({ tenantId }, () =>
      reports.list({ where: { tenantId } }),
    );
    const gst = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    expect(gst).toMatchObject({
      taxableMinor: 221_549,
      taxMinor: 11_078,
      documentCount: 2,
    });
    if (!gst?.id) throw new Error('Expected persisted GST report row.');
    const facts = await drilldownTaxSummaryInvoiceFacts(db, {
      tenantId,
      reportId: gst.id,
    });
    expect(facts).toHaveLength(4);
    const foreignTenantId = randomUUID();
    await withTenant({ tenantId: foreignTenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration(foreignTenantId);
      await settings.activateMoneyV2(foreignTenantId, migrationId);
    });
    await expect(
      drilldownTaxSummaryInvoiceFacts(db, {
        tenantId: foreignTenantId,
        reportId: gst.id,
      }),
    ).rejects.toThrow('not visible to this tenant');
  });

  it('serializes concurrent same-period refreshes to one deterministic row set', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, () =>
      seedInvoiceTaxReportFacts(db, tenantId, randomUUID()),
    );
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
    });
    const options = {
      tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: {
        listPostedMovements: async ({ accountIds }: { accountIds: string[] }) =>
          accountIds.map((accountId) => ({
            tenantId,
            entryId: `${accountId}-entry`,
            accountId,
            currency: 'CAD',
            creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
          })),
      },
      expenseComponentMappings: [],
    };
    const first = await TaxSummaryReportCollection.create({ db });
    const second = await TaxSummaryReportCollection.create({ db });
    await Promise.all([
      first.refreshTaxSummary(options),
      second.refreshTaxSummary(options),
    ]);
    const rows = await withTenant({ tenantId }, () =>
      first.list({ where: { tenantId } }),
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.id))).toHaveLength(5);
    expect(new Set(rows.map((row) => row.dimensionKey))).toHaveLength(5);
  });
});
