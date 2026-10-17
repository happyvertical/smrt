/**
 * `@happyvertical/smrt-reports/spec`: the browser-safe runtime report surface
 * (#4100).
 *
 * The closed `RuntimeReportSpec` grammar and its parser import no Node
 * built-in, so a browser (the planner's assistant, a static host) validates a
 * spec with the same code the server compiles. The server-only pieces stay on
 * the package root: `runtimeReportSpecHash` (`node:crypto`),
 * `compileRuntimeReportSpec` / `runRuntimeReport` (ObjectRegistry and SQL) and
 * the `RuntimeReport` model. `src/__tests__/spec-entry.test.ts` fails when
 * this entry's import graph reaches a Node built-in.
 */

export type {
  RuntimeReportBucket,
  RuntimeReportChart,
  RuntimeReportChartType,
  RuntimeReportDimension,
  RuntimeReportErrorCode,
  RuntimeReportFilter,
  RuntimeReportFilterOp,
  RuntimeReportHaving,
  RuntimeReportHavingOp,
  RuntimeReportMeasure,
  RuntimeReportMeasureFn,
  RuntimeReportScalar,
  RuntimeReportSort,
  RuntimeReportSpec,
} from './runtime-spec.js';
export {
  parseRuntimeReportSpec,
  RUNTIME_REPORT_BUCKETS,
  RUNTIME_REPORT_CHART_TYPES,
  RUNTIME_REPORT_FILTER_OPS,
  RUNTIME_REPORT_HAVING_OPS,
  RUNTIME_REPORT_LIMITS,
  RUNTIME_REPORT_MEASURE_FNS,
  RUNTIME_REPORT_SPEC_VERSION,
  RuntimeReportError,
  runtimeReportSpecDigest,
  serializeRuntimeReportSpec,
} from './runtime-spec.js';
