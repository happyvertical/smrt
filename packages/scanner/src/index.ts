/**
 * @happyvertical/smrt-scanner
 *
 * High-performance TypeScript scanner for SMRT manifest generation.
 * Uses OXC (Rust-based parser) for 2-3x faster scanning than TypeScript compiler.
 *
 * @example
 * ```typescript
 * import { OxcScanner } from '@happyvertical/smrt-scanner';
 *
 * const scanner = new OxcScanner({
 *   include: ['src/** /*.ts'],
 *   exclude: ['** /*.test.ts'],
 * });
 *
 * const results = await scanner.scan();
 * console.log(`Found ${results.classes.length} SMRT classes`);
 * ```
 */

export {
  type AgentSurfaceToolNameOptions,
  checkAgentSurfaceToolNames,
  type ExtractAgentSurfaceOptions,
  emptyAgentSurface,
  extractAgentSurface,
  type GeneratedModelToolName,
  isAgentSurfaceSourcePath,
  isPrunedAgentSurfacePath,
  mergeAgentSurfaces,
  scanSvelteAgentSurface,
  sourceMayDeclareAgentSurface,
} from './agent-surface.js';
export {
  discoverSourceFiles,
  normalizeGlobSeparators,
  relativeGlobToCwd,
  type SourceDiscoveryOptions,
} from './discovery.js';
export { InheritanceResolver } from './inheritance-resolver.js';
export { ManifestAdapter } from './manifest-adapter.js';
export {
  classifyNumericFieldName,
  lintNumericPrecision,
  type NumericPrecisionFinding,
  type NumericPrecisionKind,
  sourceMayContainNumericPrecisionIssue,
  splitIdentifierWords,
} from './numeric-precision-lint.js';
export {
  extractSmrtImports,
  parseAgentSurfaceFile,
  parseFile,
  parseSource,
} from './oxc-parser.js';
export { OxcScanner } from './scanner.js';
export * from './types.js';
export {
  type VerifyManifestCompletenessOptions,
  type VerifyManifestCompletenessResult,
  type VerifyManifestStatus,
  verifyManifestCompleteness,
} from './verify-completeness.js';
