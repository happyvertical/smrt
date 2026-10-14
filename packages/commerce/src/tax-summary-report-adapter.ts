/** Existing report adapter/DataTable bridge for the commerce tax summary. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  buildReportAdapterDescriptor,
  type ReportAdapterDescriptor,
  type ReportAdapterOptions,
} from '@happyvertical/smrt-reports';
import {
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
