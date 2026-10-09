/**
 * @smrt/core - Browser-safe entry point
 *
 * Package `exports["."].browser` resolves here, so every model package that is
 * bundled for a browser (`@field`/`@foreignKey` decorators, `resolveDatabase`,
 * the embedded-write helpers, the change feed, ...) must find the same value
 * exports it finds on the Node entry (#3614). The Node entry stays
 * `index.ts`; this file is that surface minus the modules that serve HTTP,
 * walk the filesystem, or run build tooling.
 *
 * Keep the two entries in sync: `src/__tests__/browser-entry-parity.test.ts`
 * fails when a value exported from `index.ts` is neither exported here nor
 * listed with a reason in `BROWSER_ENTRY_NODE_ONLY`, and when a value a
 * workspace package imports from the package root is unreachable here.
 *
 * From `generators/` only the pure helpers are exported (custom-action metadata,
 * the tenant-gate slot, typed 4xx normalization), as the same named lists
 * `generators/index.ts` uses, so this entry never publishes a name the Node
 * entry does not (the parity test checks both directions).
 *
 * Node-only (not exported here; use the named subpath instead):
 * - Code generators and HTTP servers: `generators/index` (APIGenerator,
 *   MCPGenerator, startRestServer, ...) -> `/generators`, `/generators/rest`,
 *   `/generators/mcp`; `runtime/index` server half -> `/runtime`
 * - Manifest discovery and static manifest loading (`node:fs`/`node:url`):
 *   `manifest/index` -> `/manifest`
 * - Knowledge graph -> `/knowledge`; run-once claims have no subpath (they
 *   need node:crypto and the knowledge graph) and are Node-entry only
 * - Vite plugin, prebuild utilities, test-database helper -> `/vite-plugin`,
 *   `/prebuild`, `/testing`
 *
 * For Node.js applications, use the main entry point instead:
 * import { ... } from '@happyvertical/smrt-core';
 */

// Built-in signal adapters
export * from './adapters/index';
export * from './audit.js';
export { withAuditContext } from './audit-context.js';
// App-side referential integrity applied by `SmrtObject.delete()` (#2371)
export {
  buildCascadePlan,
  type CascadePlan,
  type CascadePolymorphicReference,
  type CascadeReference,
  type CascadeRegistryView,
  type CascadeResult,
  cascadeReferencesTo,
  normalizeOnDelete,
  type OnDeleteAction,
  runCascadeDelete,
} from './cascade';
// Adapter-agnostic change feed — _smrt_changes log, cursor reads, retention,
// manual bump escape hatch (issue #1758)
export {
  type AppendChangeBatch,
  type AppendChangeInput,
  appendChange,
  appendChanges,
  bumpChangeFeed,
  CHANGE_FEED_INTERCEPTOR_NAME,
  CHANGE_FEED_TABLE,
  type ChangeFeedEntry,
  type ChangeFeedPage,
  type ChangeFeedRetention,
  type ChangeOperation,
  DEFAULT_CHANGES_LIMIT,
  drainChangeFeed,
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
// Consumer-supplied change-feed table/row authorization seam (issue #3020).
// Optional and independent of tenant scoping: unset, both generated routes
// keep their pre-#3020 behavior (authenticated + tenant-scoped only).
export {
  type ChangeFeedEntryVisibility,
  type ChangeFeedEntryVisibilityRequest,
  type ChangeFeedTableAuthorizationRequest,
  type ChangeFeedTableAuthorizer,
  type ChangeFeedVisibilityEntry,
  filterVisibleChangeFeedEntries,
  getAuthorizedChangesSince,
  getAuthorizedTenantScopedChangesSince,
  hasChangeFeedEntryVisibilityHook,
  hasChangeFeedTableAuthorizerHook,
  isChangeFeedDenyAll,
  isChangeFeedEntryVisible,
  resolveAuthorizedChangeFeedTables,
  setChangeFeedAuthorizer,
  setChangeFeedEntryVisibility,
} from './change-feed-authz';
// Credential-bearing tables the feed must never disclose (issue #2937). The
// declaring API is `@smrt({ sensitive: true })`; these are exported so a
// deployment can assert what it classifies, and so tooling can explain why a
// table reports no changes.
export {
  CHANGE_FEED_CREDENTIAL_TABLES,
  declareChangeFeedSensitiveTable,
  getChangeFeedSensitiveTables,
  isChangeFeedSensitiveTable,
} from './change-feed-sensitivity';
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
// Canonical bounded query protocol — adapters supply their own authorization
// and execution, while this runtime normalizes the shared envelope (#2444).
export {
  canonicalizeDataQuery,
  createDataQueryFingerprint,
  DataQueryValidationError,
  DEFAULT_DATA_QUERY_PAGE_LIMIT,
  DEFAULT_DATA_QUERY_RESULT_BYTES,
  MAX_DATA_QUERY_CURSOR_LENGTH,
  MAX_DATA_QUERY_FACETS,
  MAX_DATA_QUERY_FILTER_DEPTH,
  MAX_DATA_QUERY_FILTERS,
  MAX_DATA_QUERY_IN_VALUES,
  MAX_DATA_QUERY_OFFSET,
  MAX_DATA_QUERY_PAGE_LIMIT,
  MAX_DATA_QUERY_REQUEST_BYTES,
  MAX_DATA_QUERY_RESULT_BYTES,
  MAX_DATA_QUERY_WARNINGS,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
} from './data-query';
// Database utilities
export {
  type DatabaseConfig,
  isDatabaseInterface,
  type ResolveDatabaseOptions,
  resolveDatabase,
} from './database';
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
// Typed decision routing is provider-neutral and browser-safe. Keep this in
// sync with the node entry because the package root selects browser.ts under
// the browser condition while retaining index.d.ts for types.
export * from './decisions';
export {
  applyPendingDecoratorRegistrations,
  type CompatibleMethodDecorator,
  type CompatibleMethodDecoratorContext,
  type CompatiblePropertyDecorator,
  type CompatiblePropertyDecoratorContext,
  type LegacyPropertyDecoratorTarget,
  registerCompatibleFieldDecorator,
  registerCompatibleMethodDecorator,
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
  type MethodOptions,
  manyToMany,
  meta,
  method,
  type NumericFieldOptions,
  oneToMany,
  type RelationshipFieldOptions,
  type TextFieldOptions,
} from './decorators/index';
// Dispatch system (inter-agent communication)
export * from './dispatch/index';
export {
  isEmbeddedDatabase,
  isPostgresDatabase,
  usesEmbeddedRevisionFallback,
  withEmbeddedWriteQueue,
  withEmbeddedWriteTransaction,
} from './embedded-write-queue';
// Embeddings support (semantic search)
export * from './embeddings/index';
export * from './errors';
// Filesystem boundary (keeps @happyvertical/files out of neutral bundles)
export {
  createFilesystemAdapter,
  type FilesystemAdapterFactory,
  registerFilesystemAdapterFactory,
} from './filesystem-loader';
// Generated SvelteKit route collection access (#3416)
export {
  createGeneratedCollectionAccess,
  type GeneratedCollectionAccess,
  type GeneratedCollectionRuntime,
} from './generated-collection-access';
export {
  type ApiMethodExposure,
  type ApiMethodRejectionCode,
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  CRUD_OPERATIONS,
  type CustomActionFailure,
  type CustomActionMetadata,
  type CustomActionScope,
  classifyMethodWireability,
  classifyParameterWireability,
  coerceCustomActionArgument,
  createClassNamePredicate,
  createManifestClassNamePredicate,
  customActionParameterInputName,
  declaredTypeAcceptsDate,
  declaresRuntimeRestRoute,
  declaresRuntimeRestRouteShape,
  type EffectiveActionMetadata,
  type ExposableMethod,
  isCrudOperation,
  isCrudToolAction,
  type MethodDecoratorConfig,
  normalizeCustomActionFailure,
  queryStringDecoderFor,
  type ResolveApiMethodExposureOptions,
  type ResolveCustomActionMetadataOptions,
  type ResolvedCustomActionMetadata,
  readMethodDecoratorConfig,
  resolveApiMethodExposure,
  resolveCustomActionMetadata,
  resolveDeclaredScopeMismatch,
  resolveEffectiveActionMetadata,
  SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY,
  type ToolEffect,
  toCustomActionBoolean,
  toCustomActionDate,
  toCustomActionNumber,
  type WireabilityOptions,
  type WireabilityVerdict,
  type WireableParameter,
} from './generators/custom-action';
// Tenant entry-point gate (dependency-inversion hook filled by smrt-tenancy)
export {
  runWithTenantGate,
  setTenantEntryPointRunner,
  type TenantEntryPointRunner,
  type TenantGateOptions,
} from './generators/tenant-gate';
// Shared 4xx normalization for generated REST and SvelteKit transports.
export {
  normalizeTypedHttpError,
  type TypedHttpFailure,
} from './generators/typed-http-error';
export { type HierarchyView, SmrtHierarchical } from './hierarchical';
// Global interceptors system (for tenancy, soft-delete, audit logging, etc.)
export * from './interceptors';
export {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  SmrtJunction,
  SmrtJunctionBase,
} from './junction';
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
export type { DiffOptions } from './migrations/differ';
// Schema comparison and migration utilities
export {
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  isAdvisoryOnlyChange,
  isManualOrAdvisoryChange,
  SchemaComparer,
} from './migrations/differ';
export * from './object';
export {
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
} from './polymorphic-association';
export {
  applyPostgresPermissions,
  type PostgresPermissionContract,
  type PostgresPermissionDiagnostic,
  type PostgresPermissionPlan,
  planPostgresPermissions,
  validatePostgresPermissionContract,
} from './postgres-permissions.js';
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
export {
  SmrtRecipe,
  type SmrtRecipeModel,
  type SmrtRecipeModelOptions,
  type SmrtRecipeNavEntry,
} from './recipe';
export {
  deriveRecipeDemo,
  effectiveRecipeDemo,
  isMockableProvider,
  isServerProvider,
  MOCK_PROVIDER_OPTION,
  type PackageBrowserCapability,
  RECIPE_DEMO_MODES,
  type RecipeDemo,
  type RecipeDemoDerivation,
  type RecipeDemoMode,
} from './recipe-demo';
export {
  buildConnectSection,
  buildGlossary,
  type ConnectSection,
  type ConnectSurface,
  createRecipeHelp,
  extractFieldRefs,
  findField,
  type GlossaryEntry,
  type HelpBlock,
  type HelpField,
  type HelpModel,
  helpToMarkdown,
  type Inline,
  parseHelp,
  type RecipeHelp,
  type RenderedHelp,
  type RenderHelpOptions,
  renderHelp,
  resolveHelp,
  validateHelp,
} from './recipe-help';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
export type { RuntimeRegistrationOverride } from './registry/runtime-overrides';
// Revision compare-and-swap predicate helpers (#2620)
export {
  POSTGRES_REVISION_GUARD_EXPRESSION,
  postgresRevisionCandidates,
  postgresRevisionCondition,
} from './revision-guard';
// Fetch-based client. The server/MCP halves of `runtime/index` are node-only.
export { createSmrtClient } from './runtime/client';
export { detectEngine, generateDDLForEngine } from './schema/ddl';
// Per-foreign-key orphan count report (#2753) — read-only, COUNT(*) probe of
// every manifest foreign key, reusing the same predicate the migration
// differ's orphan gate probes with.
export {
  type CollectForeignKeyOrphanCountsOptions,
  collectForeignKeyOrphanCounts,
  type ForeignKeyOrphanCount,
  type ForeignKeyOrphanCountReport,
  type ForeignKeyOrphanSkipped,
} from './schema/foreign-key-orphan-report';
export { planForeignKeyCreation } from './schema/foreign-key-planner';
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
// AI function calling tools
export * from './tools/index';
// IN-list chunking contract for loaders that build IN lists from data-sized
// arrays (#2367); exported so owning packages chunk at the same bound (#3047).
export { chunkArray, IN_LIST_CHUNK_SIZE } from './utils/chunk';
// Display-safe database connection strings (#3527): every banner, log and
// error that names a database URL renders it through these.
export {
  isSensitiveConnectionParam,
  redactDatabaseUrl,
  redactDatabaseUrlsInText,
} from './utils/database-url';
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
// The field-name -> column-name rule `SchemaGenerator` uses, for adapters that
// read `ObjectRegistry.getSchema()` column metadata by field id.
export { toSnakeCase } from './utils/naming';
// Qualified name utilities
export {
  assertScopedPackageName,
  createQualifiedName,
  getClassName,
  getPackageFromQualifiedName,
  isFromPackage,
  isQualifiedName,
  isScopedPackageName,
  isType,
  type ParsedQualifiedName,
  parseQualifiedName,
  qualifiedNamesEqual,
} from './utils/qualified-names';

// Vite plugin excluded (Node.js-only)

// NOTE: Generators (CLI, REST, MCP) are excluded from browser builds
// Use the main entry point for Node.js applications that need generators

// Presentation metadata helpers (#3599): widget hints, display label, selector lookup
export * from './ui-metadata.js';
