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
export * from './collection-read-plan';
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
// Driver-error classification for the persistence path (#2366)
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
  type FieldUIHints,
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
// Filesystem boundary (keeps @happyvertical/files out of neutral bundles)
export {
  createFilesystemAdapter,
  type FilesystemAdapterFactory,
  registerFilesystemAdapterFactory,
} from './filesystem-loader';
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
export {
  importOptionalDependency,
  registerOptionalDependency,
} from './lazy-external';
// Learning memory — confidence-scored, self-correcting recall/capture (#1886)
export {
  DEFAULT_LEARNING_CONFIG,
  type LearningEpisode,
  LearningMemory,
  type LearningMemoryConfig,
  type LearningMemoryOptions,
  type LearningMemoryRecord,
  type LearningOutcome,
  type LearningRecallOptions,
  type LearningSemanticSearch,
} from './learning/index';
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
// Runtime PostgreSQL pool timeouts (#2377). Deliberately narrow: this is what
// another package needs to bound a pool it builds itself, and nothing more.
// The URL rewriter and the engine predicate stay internal, and the parser is
// public through `./migrations` as `parsePostgresTimeoutMs` — one name, one
// place.
export {
  applyPostgresRuntimeTimeouts,
  DEFAULT_POSTGRES_TIMEOUTS,
  POSTGRES_TIMEOUT_ENV_VARS,
  type PostgresTimeoutConfig,
  type ResolvedPostgresTimeouts,
  resolvePostgresTimeouts,
} from './postgres-timeouts';
// Shared list query bounds for every generated read surface (#2367)
export {
  buildDefaultListOrderBy,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_ORDER_BY,
  type ListBoundOptions,
  MAX_LIST_LIMIT,
  QueryBoundsError,
  QueryOrderByError,
  resolveListLimit,
  resolveListOffset,
} from './query-bounds';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
// Runtime utilities
export * from './runtime/index';
export { detectEngine, generateDDLForEngine } from './schema/ddl';
// Live-schema parity check (#2368) — compares a live database to the shape
// the model layer assumes, including hand-DDL `_smrt_*` system tables.
export {
  type ConflictTargetInput,
  checkLiveSchemaParity,
  type ExpectedTableOrigin,
  type LiveParityFinding,
  type LiveParityFindingKind,
  type LiveParitySeverity,
  LiveSchemaParityError,
  type LiveSchemaParityOptions,
  type LiveSchemaParityReport,
} from './schema/live-parity';
export {
  getSystemTableShapes,
  SYSTEM_TABLE_NAMES,
  type SystemTableShape,
} from './schema/system-table-shapes';
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
