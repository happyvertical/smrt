import type { MaterializedReportHost } from '@happyvertical/smrt-reports';

/**
 * Server-only materialized-report registrations for this application.
 *
 * Add fixed, application-owned hosts here. Browser requests select only one of
 * these ids; they never supply a tenant, report constructor, or database.
 */
export const materializedReportHosts: readonly MaterializedReportHost[] = [];
