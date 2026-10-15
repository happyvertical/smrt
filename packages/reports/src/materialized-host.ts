import type {
  ReportAdapterDescriptor,
  ReportDataQueryResult,
} from './adapter.js';

/** Verified request context supplied by an application route, never the browser. */
export interface MaterializedReportHostContext {
  userId: string;
  tenantId: string;
  permissions: readonly string[];
}

/** The only browser-controlled selections accepted by a materialized-report host. */
export interface MaterializedReportCellRequest {
  id: string;
  columnId: string;
}

/**
 * Application-owned bridge for one declared materialized report.
 *
 * Registrations are server-only and bind tenant/principal from the route
 * context. Hosts must re-read the selected row before resolving a cell.
 */
export interface MaterializedReportHost<Drilldown = unknown> {
  id: string;
  /** Registered collection and model used by the route's normal read gate. */
  collection: string;
  className: string;
  /** The report host fails closed unless this published permission is present. */
  readPermission: string;
  /** Closed visible columns that may request a source drilldown. */
  drilldownColumnIds: readonly string[];
  descriptor(
    context: MaterializedReportHostContext,
  ): Promise<ReportAdapterDescriptor>;
  query(
    context: MaterializedReportHostContext,
    request: unknown,
  ): Promise<ReportDataQueryResult>;
  drilldown(
    context: MaterializedReportHostContext,
    request: MaterializedReportCellRequest,
  ): Promise<Drilldown>;
}

export function assertMaterializedReportRead(
  host: MaterializedReportHost,
  context: MaterializedReportHostContext,
): void {
  if (!context.permissions.includes(host.readPermission))
    throw new Error('Materialized report access denied.');
}

export function findMaterializedReportHost(
  hosts: readonly MaterializedReportHost[],
  id: string,
): MaterializedReportHost | undefined {
  return hosts.find((host) => host.id === id);
}
