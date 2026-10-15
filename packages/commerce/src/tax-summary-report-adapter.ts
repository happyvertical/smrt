/** Existing report adapter/DataTable bridge for the commerce tax summary. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  assertMaterializedReportRead,
  buildReportAdapterDescriptor,
  type MaterializedReportDrilldownContributor,
  type MaterializedReportDrilldownPresentation,
  type MaterializedReportDrilldownWarning,
  type MaterializedReportHost,
  type MaterializedReportHostContext,
  queryReportMaterializedRows,
  type ReportAdapterDescriptor,
  type ReportAdapterOptions,
} from '@happyvertical/smrt-reports';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  type TaxSummaryContributorDrilldown,
  type TaxSummaryContributorDrilldownOptions,
  type TaxSummaryInvoiceDrilldownOptions,
  TaxSummaryReportCollection,
  type TaxSummaryReportMeasure,
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
} as const satisfies Record<string, TaxSummaryReportMeasure>;

const MEASURE_LABELS: Record<TaxSummaryReportMeasure, string> = {
  taxable: 'Taxable base',
  tax: 'Tax',
  recoverable: 'Recoverable input tax',
  net: 'Net tax',
  ledgerMovement: 'Posted ledger movement',
  difference: 'Reconciliation difference',
  documentCount: 'Document count',
  warning: 'Warning evidence',
};

function warningPresentation(
  pending: readonly string[],
): MaterializedReportDrilldownWarning[] {
  return pending.map((code) => ({
    code,
    kind: code === 'source-state-diverged' ? 'drift' : 'incomplete',
    message:
      code === 'source-state-diverged'
        ? 'The current source evidence no longer matches this materialized report cell.'
        : `This drilldown is incomplete: ${code.replaceAll('-', ' ')}.`,
  }));
}

function presentContributor(
  contributor: TaxSummaryContributorDrilldown['contributors'][number],
): MaterializedReportDrilldownContributor {
  if (contributor.source === 'invoice' || contributor.source === 'contract') {
    const { fact } = contributor;
    return {
      id: `${contributor.source}:${fact.documentType}:${fact.documentId}:${fact.taxCodeId ?? 'unassigned'}:${fact.taxComponentId ?? 'unassigned'}`,
      source: contributor.source,
      identity: fact.documentNumber || fact.documentId,
      date: fact.issueDate,
      party: fact.partyId,
      values: {
        valueMinor: contributor.valueMinor,
        taxableMinor: fact.taxableMinor,
        taxMinor: fact.taxMinor,
      },
    };
  }
  if (contributor.source === 'expense') {
    const tax = contributor.expense.financialBreakdown?.taxes.find(
      (entry) => entry.code === contributor.expenseCode,
    );
    return {
      id: `expense:${contributor.expense.expenseId}:${contributor.expenseCode ?? 'unmapped'}`,
      source: 'expense',
      identity: contributor.expense.expenseId,
      date: contributor.expense.incurredOn,
      values: {
        valueMinor: contributor.valueMinor,
        taxMinor: tax?.amount,
      },
    };
  }
  const { movement } = contributor;
  return {
    id: `ledger:${movement.journalId}:${movement.entryId}`,
    source: 'ledger',
    identity: movement.journalNumber || movement.journalId,
    date: movement.journalDate.toISOString(),
    values: { valueMinor: contributor.valueMinor },
  };
}

/** Normalize commerce source facts before a generic report route serializes them. */
export function presentTaxSummaryDrilldown(
  drilldown: TaxSummaryContributorDrilldown,
): MaterializedReportDrilldownPresentation {
  return {
    version: 1,
    selectedMeasure: {
      id: drilldown.measure,
      label: MEASURE_LABELS[drilldown.measure],
    },
    currency: drilldown.row.currency,
    contributors: drilldown.contributors.map(presentContributor),
    complete: drilldown.complete,
    warnings: warningPresentation(drilldown.pending),
  };
}

/** Create a fixed, server-only tax-summary host for an authenticated template route. */
export function createTaxSummaryMaterializedReportHost(
  database: DatabaseInterface | (() => Promise<DatabaseInterface>),
): MaterializedReportHost<MaterializedReportDrilldownPresentation> {
  const db = async () =>
    typeof database === 'function' ? database() : database;
  const scoped = <T>(
    context: MaterializedReportHostContext,
    task: () => Promise<T>,
  ) => withTenant({ tenantId: context.tenantId }, task);
  const host: MaterializedReportHost<MaterializedReportDrilldownPresentation> =
    {
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
        return presentTaxSummaryDrilldown(
          await drilldownTaxSummaryContributors(await db(), {
            tenantId: context.tenantId,
            reportId: request.id,
            measure,
          }),
        );
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
