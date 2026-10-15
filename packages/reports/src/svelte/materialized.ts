import type { ReportAdapterDescriptor } from '../adapter.js';

/** Server-projected page for a declared materialized report. */
export interface MaterializedReportPage {
  descriptor: ReportAdapterDescriptor;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  offset: number;
  limit: number;
  /** Closed visible columns that the host permits for source drilldown. */
  drilldownColumnIds?: readonly string[];
}

/** A cell identity only; the authenticated host resolves tenant and report scope. */
export interface MaterializedReportCell {
  id: string;
  columnId: string;
}

/** Host callback for a validated, visible materialized-report cell. */
export type MaterializedReportDrilldown = (
  cell: MaterializedReportCell,
) => void | Promise<void>;
