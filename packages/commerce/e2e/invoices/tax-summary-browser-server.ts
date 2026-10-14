import '../../dist/index.js';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { queryReportMaterializedRows } from '@happyvertical/smrt-reports';
import { disableTenancy, enableTenancy, isTenancyEnabled, withTenant } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from '../../src/collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../../src/collections/DocumentTaxCollection.js';
import { TaxSettingsCollection } from '../../src/collections/TaxSettingsCollection.js';
import { TaxSummaryReportCollection } from '../../src/collections/TaxSummaryReportCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../../src/document-money-internal.js';
import { TaxSummaryReport } from '../../src/models/TaxSummaryReport.js';
import {
  buildTaxSummaryReportAdapterDescriptor,
  drilldownTaxSummaryInvoiceFacts,
  TAX_SUMMARY_REPORT_ADAPTER,
} from '../../src/tax-summary-report-adapter.js';
import { seedInvoiceTaxReportFacts } from '../../src/__tests__/helpers/invoice-tax-report-facts.js';
import '../..//src/collections/ContractCollection.js';

const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

export type TaxSummaryBrowserState = 'data' | 'empty' | 'unknown';

interface TaxSummaryBrowserFixture {
  db: DatabaseInterface;
  descriptor: Awaited<ReturnType<typeof buildTaxSummaryReportAdapterDescriptor>>;
  tenantId: string;
  gstReportId: string | null;
  rows: Array<Record<string, unknown>>;
}

const fixtures = new Map<TaxSummaryBrowserState, Promise<TaxSummaryBrowserFixture>>();

async function activateV2(db: DatabaseInterface, tenantId: string): Promise<void> {
  const settings = await TaxSettingsCollection.create({ db });
  const migrationId = await settings.beginMoneyMigration(tenantId);
  await settings.activateMoneyV2(tenantId, migrationId);
}

async function createFixture(state: TaxSummaryBrowserState): Promise<TaxSummaryBrowserFixture> {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  if (!isTenancyEnabled()) enableTenancy();
  const descriptor = await buildTaxSummaryReportAdapterDescriptor();
  const reports = await TaxSummaryReportCollection.create({ db });
  const tenantId = 'tenant-a';

  if (state !== 'empty') {
    const customers = await CustomerCollection.create({ db });
    await withTenant({ tenantId }, () =>
      Promise.all([
        customers.create({ id: 'party-a', profileId: 'party-a' }),
        customers.create({ id: 'party-b', profileId: 'party-b' }),
      ]),
    );
    const seeded = await withTenant({ tenantId }, () => seedInvoiceTaxReportFacts(db));
    if (state === 'unknown') {
      await withTenant({ tenantId }, async () => {
        const taxes = await DocumentTaxCollection.create({ db });
        await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
          tenantId,
          documentType: 'invoice',
          documentId: seeded.invoiceAId,
          rows: [{
            tenantId,
            documentType: 'invoice',
            documentId: seeded.invoiceAId,
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
          }],
        });
      });
    }
    await withTenant({ tenantId }, () => activateV2(db, tenantId));
    await withTenant({ tenantId: 'tenant-b' }, () => activateV2(db, 'tenant-b'));
    await reports.refreshTaxSummary({
      tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: {
        listPostedMovements: async ({ accountIds }) =>
          accountIds.map((accountId) => ({
            tenantId,
            entryId: `entry-${accountId}`,
            accountId,
            currency: 'CAD',
            creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
          })),
      },
      expenseComponentMappings: [],
    });
  } else {
    await withTenant({ tenantId }, () => activateV2(db, tenantId));
  }

  const projection = [...new Set(['id', ...descriptor.dataTable.columns.map((column) => column.accessor)])];
  const query = await withTenant({ tenantId }, () =>
    queryReportMaterializedRows(
      TaxSummaryReport,
      {
        version: 1,
        requestId: `tax-summary-browser-${state}`,
        mode: 'rows',
        projection,
        page: { kind: 'offset', offset: 0, limit: 50 },
      },
      {
        db,
        collection: reports,
        adapter: TAX_SUMMARY_REPORT_ADAPTER,
        execution: 'visible',
      },
    ),
  );
  const rows = (query.rows ?? []) as Array<Record<string, unknown>>;
  const gst = rows.find(
    (row) => row.row_kind === 'component' && row.tax_component_id === 'gst',
  );

  return {
    db,
    descriptor,
    tenantId,
    gstReportId: typeof gst?.id === 'string' ? gst.id : null,
    rows,
  };
}

function fixture(state: TaxSummaryBrowserState): Promise<TaxSummaryBrowserFixture> {
  const existing = fixtures.get(state);
  if (existing) return existing;
  const next = createFixture(state);
  fixtures.set(state, next);
  return next;
}

export async function readTaxSummaryBrowserFixture(state: TaxSummaryBrowserState) {
  const current = await fixture(state);
  return {
    descriptor: current.descriptor,
    tenantId: current.tenantId,
    gstReportId: current.gstReportId,
    rows: current.rows,
  };
}

export async function drilldownTaxSummaryBrowserFixture(
  reportId: string,
  tenantId: string,
) {
  const current = await fixture('data');
  return drilldownTaxSummaryInvoiceFacts(current.db, { reportId, tenantId });
}

export async function disposeTaxSummaryBrowserFixtures(): Promise<void> {
  for (const current of fixtures.values()) {
    const resolved = await current;
    await resolved.db.close?.();
  }
  fixtures.clear();
  disableTenancy();
}
