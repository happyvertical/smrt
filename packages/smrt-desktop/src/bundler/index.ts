/**
 * `@happyvertical/smrt-desktop/bundler`: the runtime bundler (Node only).
 *
 * This entry is separate from the package root and from `./webview` on
 * purpose: it uses `node:fs`, `node:child_process`, `node:http` and friends,
 * and nothing that is bundled into a browser may import it.
 */

export type {
  BundleErrorCategory,
  BundleErrorCode,
  BundleErrorDetail,
  BundleErrorOrigin,
  BundleFailureDocument,
  BundleStage,
} from './errors.js';
export {
  BUNDLE_EXIT_CODES,
  BUNDLE_STAGES,
  BundleError,
  bundleExitCode,
  bundleFailureDocument,
} from './errors.js';
export type {
  DataDirectory,
  MeasureChild,
  MeasureRequest,
  MeasureSeams,
  SpawnRequest,
} from './measure.js';
export { measureBundle, median, summarizeSeries } from './measure.js';
export type {
  NodePinProvenance,
  NodePinVerification,
} from './node-pins.js';
export {
  isGpgVerified,
  lookupPinProvenance,
  NODE_PIN_PROVENANCE,
  NODE_PINS,
  pinnedVersions,
} from './node-pins.js';
export type {
  BundleEnvironment,
  BundleOptionsInput,
  BundlePlan,
  PlanTarget,
} from './options.js';
export {
  createBundlePlan,
  hostTriple,
} from './options.js';
export type { TreeFs } from './paths.js';
export { nodeTreeFs } from './paths.js';
export type { PnpmRequest, PnpmResult } from './pnpm-runner.js';
export { createPnpmRunner, pnpmCommand } from './pnpm-runner.js';
export type { FeatureDefinition, ProductConfig } from './product-config.js';
export {
  FEATURE_CATALOG,
  PRODUCT_CONFIG_FILE,
  parseProductConfig,
} from './product-config.js';
export type {
  BundleMeasurements,
  BundleReportV1,
  ReportNodePin,
  SeriesStats,
} from './report.js';
export {
  assertVerifiedNodePin,
  BUNDLE_FILES_FILENAME,
  BUNDLE_REPORT_FILENAME,
  formatFileList,
  parseBundleReport,
  serializeBundleReport,
  validateBundleReport,
} from './report.js';
export type { BundleResult, BundleSeams, MeasureInput } from './run.js';
export { runBundle } from './run.js';
export type { CreateBundleSeamsOptions } from './runtime.js';
export {
  createBundleSeams,
  createNodeMeasureSeams,
  defaultNodeCacheDir,
  readToolVersion,
} from './runtime.js';
export type { TargetSpec, TargetTriple } from './targets.js';
export {
  isSupportedTarget,
  SUPPORTED_TARGET_TRIPLES,
  TARGETS,
} from './targets.js';
