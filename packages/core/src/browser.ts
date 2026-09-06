/**
 * @smrt/core - Browser-safe entry point
 *
 * This entry point excludes Node.js-only code generators (CLI, REST, MCP)
 * that contain shebangs and Node.js-specific APIs. Use this for browser
 * builds, federation, and client-side applications.
 *
 * Excluded:
 * - Code generators (APIGenerator, MCPGenerator; the local CLI transport
 *   lives outside core in packages/cli/src/cli-generator.ts)
 * - Runtime manifest utilities (Node.js-only)
 * - Prebuild utilities (Node.js-only)
 *
 * For Node.js applications, use the main entry point instead:
 * import { ... } from '@happyvertical/smrt-core';
 */

// Built-in signal adapters
export * from './adapters/index';
// Core SMRT framework
export * from './class';
export * from './collection';
export type {
  AiUsageConfig,
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config';
// Global configuration (callable function)
export { config } from './config';
// Driver-error classification (#2366). Mirrored from the node entry because the
// package's `browser` export condition resolves here, and consumers that import
// these from the package root — `smrt-users`' TenantIntegrationCollection and
// `smrt-profiles`' OIDC coordinator — must not fail to resolve when bundled for
// the browser. The module is pure: it classifies plain objects and pulls in no
// node built-ins.
export {
  classifyDatabaseError,
  classifyDialectMessage,
  type DatabaseErrorClassification,
  type DatabaseErrorKind,
  isAbortedTransactionError,
  isDeterministicDatabaseError,
  isNotNullViolationError,
  isTransientDatabaseError,
  isUniqueViolationError,
} from './db-errors';
export * from './errors';
export { type HierarchyView, SmrtHierarchical } from './hierarchical';
export {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  SmrtJunction,
} from './junction';
export * from './object';
export {
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
} from './polymorphic-association';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
// Universal signaling system
export * from './signals/index';
// System tables and types (note-taking, migrations, registry, signals)
export * from './system/index';
export type {
  DiscoveryStrategy,
  ForgetOptions,
  ForgetScopeOptions,
  NoteMetadata,
  NoteOptions,
  RecallAllOptions,
  RecallOptions,
  SystemTableConfig,
} from './system/types';
// AI function calling tools
export * from './tools/index';
// Vite plugin excluded (Node.js-only)

// NOTE: Generators (CLI, REST, MCP) are excluded from browser builds
// Use the main entry point for Node.js applications that need generators
