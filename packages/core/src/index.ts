/**
 * @smrt/core - Core AI agent framework with standardized collections and code generators
 *
 * This package provides the foundational framework for building vertical AI agents.
 * It provides core abstractions and integrates with other HAVE SDK packages
 * (ai, files, sql) to provide a unified interface.
 *
 * Key components:
 * - SmrtClass: Foundation class providing access to database, filesystem, and AI
 * - SmrtObject: Persistent object with unique identifiers and database storage
 * - SmrtCollection: Collection interface for managing sets of SmrtObjects
 *
 * Generators:
 * - CLIGenerator: Create admin CLI tools from SMRT objects
 * - APIGenerator: Generate REST APIs for SMRT objects
 * - MCPGenerator: Create MCP servers for AI model integration
 */

// Built-in signal adapters
export * from './adapters/index';
// Adapter-agnostic change feed — _smrt_changes log, cursor reads, retention,
// manual bump escape hatch (issue #1758)
export {
  type AppendChangeInput,
  appendChange,
  bumpChangeFeed,
  CHANGE_FEED_INTERCEPTOR_NAME,
  CHANGE_FEED_TABLE,
  type ChangeFeedEntry,
  type ChangeFeedPage,
  type ChangeFeedRetention,
  type ChangeOperation,
  DEFAULT_CHANGES_LIMIT,
  ensureChangeFeedTable,
  type GetChangesOptions,
  getChangesSince,
  getTableVersion,
  getTenantScopedChangesSince,
  MAX_CHANGES_LIMIT,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
  unregisterChangeFeedWriter,
} from './change-feed';
// Live change-signal bus — the push spine for the generated `_events` SSE
// route (issue #1763). Coarse signals (no row payloads), in-process +
// cross-replica via the adapter notification capability. Publish/broadcast/
// ensure stay internal — only the subscribe + lifecycle surface is public.
export {
  CHANGE_SIGNAL_CHANNEL,
  type ChangeSignal,
  type ChangeSignalListener,
  resetChangeSignals,
  stopChangeSignalListeners,
  subscribeToChangeSignals,
} from './change-signals';
// R10: generated child accessors for @oneToMany relationships
export {
  applyOneToManyChildAccessors,
  childAccessorName,
} from './child-accessors';
// Core SMRT framework
export * from './class';
export * from './collection';
// Opt-in collection read cache (issue #1498)
export {
  broadcastCacheInvalidation,
  CACHE_INVALIDATION_CHANNEL,
  type CollectionCacheConfig,
  ensureCacheInvalidationListener,
  getCacheGeneration,
  invalidateCollectionCache,
  resetCollectionCache,
  resolveDbCacheKey,
  stopCacheInvalidationListeners,
} from './collection-cache';
export type {
  AiUsageConfig,
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config';
// Global configuration (callable function)
export { config } from './config';
// Database utilities
export {
  type DatabaseConfig,
  isDatabaseInterface,
  type ResolveDatabaseOptions,
  resolveDatabase,
} from './database';
export {
  applyPendingDecoratorRegistrations,
  type CompatiblePropertyDecorator,
  type CompatiblePropertyDecoratorContext,
  type LegacyPropertyDecoratorTarget,
  registerCompatibleFieldDecorator,
} from './decorators/compatibility';
// Property decorators for field definition
// Re-export decorator versions with priority over field helpers
export {
  type CrossPackageRefOptions,
  crossPackageRef,
  type FieldOptions,
  field,
  foreignKey,
  type Meta,
  manyToMany,
  meta,
  type NumericFieldOptions,
  oneToMany,
  type RelationshipFieldOptions,
  type TextFieldOptions,
} from './decorators/index';
// Dispatch system (inter-agent communication)
export * from './dispatch/index';
// Embeddings support (semantic search)
export * from './embeddings/index';
export * from './errors';
// Code generators (tree-shakeable)
export * from './generators/index';
export { type HierarchyView, SmrtHierarchical } from './hierarchical';
// Global interceptors system (for tenancy, soft-delete, audit logging, etc.)
export * from './interceptors';
export {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  SmrtJunction,
} from './junction';
export * from './knowledge';
// Lazy / execute-time config resolvers (for agent_config and similar
// snapshot-prone payloads — see issue #1161)
export type {
  ConfigResolver,
  LazyConfigSentinel,
  ResolveLazyConfigOptions,
} from './lazy-config';
export {
  getClassConfigResolvers,
  getConfigResolver,
  isLazyConfigSentinel,
  listConfigResolvers,
  registerConfigResolver,
  resetConfigResolvers,
  resolveLazyConfig,
  unregisterConfigResolver,
} from './lazy-config';
// Static manifest (generated at build time)
export * from './manifest/index';
export type { DiffOptions } from './migrations/differ';
// Schema comparison and migration utilities
export {
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  SchemaComparer,
} from './migrations/differ';
export * from './object';
export {
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
} from './polymorphic-association';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
// Runtime utilities
export * from './runtime/index';
export { detectEngine, generateDDLForEngine } from './schema/ddl';
// Schema types (for generated code from SchemaCodeGenerator)
export type { SchemaDefinition } from './schema/types';
// Universal signaling system
export * from './signals/index';
// Idempotent sync-apply batch write contract (#1759) — shared by the runtime
// REST generator and the generated SvelteKit sync route
export * from './sync/apply';
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
// Table existence verification cache (for test setup reset)
export { resetVerifiedTables } from './table-cache';
// Testing utilities (for test setup only)
export {
  getTestDatabase,
  type TestDatabaseOptions,
} from './testing/database';
// AI function calling tools
export * from './tools/index';
// JSON utilities with optional SIMD acceleration
export {
  clone,
  getAdapterInfo,
  isValid,
  type JSONAdapter,
  type ParseError,
  parse,
  type Result,
  type StringifyError,
  safeParse,
  safeStringify,
  stringify,
} from './utils/json';
// Qualified name utilities
export {
  createQualifiedName,
  getClassName,
  getPackageFromQualifiedName,
  isFromPackage,
  isQualifiedName,
  isType,
  type ParsedQualifiedName,
  parseQualifiedName,
  qualifiedNamesEqual,
} from './utils/qualified-names';
// Vite plugin for auto-service generation
export { smrtPlugin } from './vite-plugin/index';
