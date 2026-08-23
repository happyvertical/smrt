/**
 * Chat-facing entry point for principal-bound data tools (#2447).
 *
 * The implementation remains in `@happyvertical/smrt-agents` so chat only
 * offers these as the same `PrincipalTool[]` extra-tools seam as orchestration.
 * No collection or ChatService internals are exposed here.
 */
export {
  createDataSurfaceTools,
  DATA_DISCOVER_FUNCTION_NAME,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_FUNCTION_NAME,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_FUNCTION_NAME,
  DATA_QUERY_TOOL_SLUG,
  type DataSurfaceAuditEntry,
  type DataSurfaceAuditSink,
  DataSurfaceDeadlineError,
  type DataSurfaceDefinition,
  DataSurfaceDeniedError,
  type DataSurfaceExecutionContext,
  type DataSurfaceExecutor,
  type DataSurfaceExecutorResult,
  type DataSurfacePrincipal,
  type DataSurfaceToolsOptions,
  DEFAULT_DATA_SURFACE_DEADLINE_MS,
  MAX_DATA_SURFACE_DEADLINE_MS,
} from '@happyvertical/smrt-agents';
