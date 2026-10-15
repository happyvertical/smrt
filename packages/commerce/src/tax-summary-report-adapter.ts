/** Existing report adapter/DataTable bridge for the commerce tax summary. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  assertMaterializedReportRead,
  buildReportAdapterDescriptor,
  type MaterializedReportHost,
  type MaterializedReportHostContext,
  queryReportMaterializedRows,
  type ReportAdapterDescriptor,
  type ReportAdapterOptions,
} from '@happyvertical/smrt-reports';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  type TaxSummaryContributorDrilldownOptions,
  type TaxSummaryInvoiceDrilldownOptions,
  TaxSummaryReportCollection,
} from './collections/TaxSummaryReportCollection.js';
import { TaxSummaryReport } from './models/TaxSummaryReport.js';

export const TAX_SUMMARY_REPORT_ADAPTER: ReportAdapterOptions = {
  dataTable: {
    columns: {
      period_from: {
        valueFormat: 'datetime',
        responsive: { keepVisible: true },
      },
      period_to: { valueFormat: 'datetime', responsive: { priority: 1 } },
      currency: { responsive: { keepVisible: true } },
      row_kind: { role: 'status', responsive: { keepVisible: true } },
      taxable_minor: { valueFormat: 'money', align: 'right' },
      tax_minor: { valueFormat: 'money', align: 'right' },
      recoverable_minor: { valueFormat: 'money', align: 'right' },
      net_tax_minor: { valueFormat: 'money', align: 'right' },
      ledger_movement_minor: { valueFormat: 'money', align: 'right' },
      difference_minor: { valueFormat: 'money', align: 'right' },
      document_count: { valueFormat: 'count', align: 'right' },
      complete: { role: 'status', responsive: { keepVisible: true } },
    },
  },
};

const CELL_MEASURES = {
  taxable_minor: 'taxable',
  tax_minor: 'tax',
  recoverable_minor: 'recoverable',
  net_tax_minor: 'net',
  ledger_movement_minor: 'ledgerMovement',
  difference_minor: 'difference',
  document_count: 'documentCount',
} as const;

/** Create a fixed, server-only tax-summary host for an authenticated template route. */
export function createTaxSummaryMaterializedReportHost(
  database: DatabaseInterface | (() => Promise<DatabaseInterface>),
): MaterializedReportHost {
  const db = async () =>
    typeof database === 'function' ? database() : database;
  const scoped = <T>(
    context: MaterializedReportHostContext,
    task: () => Promise<T>,
  ) => withTenant({ tenantId: context.tenantId }, task);
  const host: MaterializedReportHost = {
    id: 'tax-summary',
    collection: 'taxsummaryreports',
    className: 'TaxSummaryReport',
    readPermission: 'taxsummaryreports.read',
    drilldownColumnIds: Object.keys(CELL_MEASURES),
    async descriptor(context) {
      assertMaterializedReportRead(host, context);
      return buildTaxSummaryReportAdapterDescriptor();
    },
    query: (context, request) => {
      assertMaterializedReportRead(host, context);
      return scoped(context, async () =>
        queryReportMaterializedRows(TaxSummaryReport, request, {
          db: await db(),
          adapter: TAX_SUMMARY_REPORT_ADAPTER,
          execution: 'visible',
        }),
      );
    },
    async drilldown(context, request) {
      assertMaterializedReportRead(host, context);
      const measure =
        CELL_MEASURES[request.columnId as keyof typeof CELL_MEASURES];
      if (!measure)
        throw new Error('Tax summary cell is not drilldown-capable.');
      const result = await scoped(context, async () =>
        queryReportMaterializedRows(
          TaxSummaryReport,
          {
            version: 1,
            requestId: `tax-summary-drilldown:${request.id}`,
            mode: 'rows',
            projection: ['id'],
            filter: {
              kind: 'condition',
              field: 'id',
              operator: 'eq',
              value: request.id,
            },
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
          {
            db: await db(),
            adapter: TAX_SUMMARY_REPORT_ADAPTER,
            execution: 'visible',
          },
        ),
      );
      if (result.rows.length !== 1)
        throw new Error('Tax summary row is unavailable.');
      return drilldownTaxSummaryContributors(await db(), {
        tenantId: context.tenantId,
        reportId: request.id,
        measure,
      });
    },
  };
  return host;
}

/** Descriptor consumed by the registered report runtime and DataTable host. */
export function buildTaxSummaryReportAdapterDescriptor(): Promise<ReportAdapterDescriptor> {
  return buildReportAdapterDescriptor(
    TaxSummaryReport,
    TAX_SUMMARY_REPORT_ADAPTER,
  );
}

/**
 * Application drilldown bridge. Callers obtain tenantId from their authenticated
 * principal and must not use a tenant value supplied by the report row.
 */
export async function drilldownTaxSummaryInvoiceFacts(
  db: DatabaseInterface,
  options: TaxSummaryInvoiceDrilldownOptions,
) {
  const reports = await TaxSummaryReportCollection.create({ db });
  return reports.drilldownInvoiceFacts(options);
}

/**
 * Application bridge for a specific report cell. Expense and ledger owners are
 * injected by the host so commerce does not create a package dependency cycle.
 */
export async function drilldownTaxSummaryContributors(
  db: DatabaseInterface,
  options: TaxSummaryContributorDrilldownOptions,
) {
  const reports = await TaxSummaryReportCollection.create({ db });
  return reports.drilldownContributors(options);
}
