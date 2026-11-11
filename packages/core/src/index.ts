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
 * - APIGenerator: Generate REST APIs for SMRT objects
 * - CLI: local `smrt` binary transport lives in `@happyvertical/smrt-cli`
 *   (`packages/cli/src/cli-generator.ts`), not in this package.
 * - MCPGenerator: Create MCP servers for AI model integration
 */

// Built-in signal adapters
export * from './adapters/index';
// Opt-in AI call transcripts (#4780), capture side. Browser-safe; keep this
// list identical in index.ts and browser.ts.
export {
  AI_CALL_ID_TAG,
  type AiTranscriptAppSettings,
  type AiTranscriptCaptureReason,
  type AiTranscriptContext,
  type AiTranscriptMessage,
  type AiTranscriptRedactionContext,
  type AiTranscriptRedactionValues,
  type AiTranscriptRedactor,
  aiTranscriptCaptureReason,
  aiTranscriptSampleRate,
  aiTranscriptsEnabled,
  type CaptureAiTranscriptCallOptions,
  captureAiTranscriptCall,
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  DEFAULT_TRANSCRIPT_SAMPLE,
  type FittedAiTranscript,
  fitAiTranscript,
  getAiTranscriptAppSettings,
  getTranscriptRedactor,
  MIN_SENSITIVE_VALUE_LENGTH,
  maybeWithAiTranscripts,
  newAiCallId,
  noteAiTranscriptRun,
  observeAiTranscriptUsage,
  type ResolvedAiTranscriptConfig,
  redactAiTranscriptMessages,
  resolveAiTranscriptConfig,
  setAiTranscriptAppSettings,
  setTranscriptRedactor,
  unwrapAiTranscriptClient,
  withAiTranscripts,
} from './ai-transcripts';
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
  MAX_DATA_QUERY_FIELD_VALUE_DESCRIPTION_LENGTH,
  MAX_DATA_QUERY_FIELD_VALUE_LABEL_LENGTH,
  MAX_DATA_QUERY_FIELD_VALUE_LENGTH,
  MAX_DATA_QUERY_FIELD_VALUES,
  MAX_DATA_QUERY_FILTER_DEPTH,
  MAX_DATA_QUERY_FILTERS,
  MAX_DATA_QUERY_IN_VALUES,
  MAX_DATA_QUERY_OFFSET,
  MAX_DATA_QUERY_PAGE_LIMIT,
  MAX_DATA_QUERY_REQUEST_BYTES,
  MAX_DATA_QUERY_RESULT_BYTES,
  MAX_DATA_QUERY_WARNINGS,
  normalizeDataQueryFieldValues,
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
// Driver-error classification for the persistence path (#2366)
export {
  classifyDatabaseError,
  classifyDialectMessage,
  type DatabaseErrorClassification,
  type DatabaseErrorKind,
  isAbortedTransactionError,
  isDeterministicDatabaseError,
  isNotNullViolationError,
  isTransientConnectionError,
  isTransientDatabaseError,
  isUniqueViolationError,
} from './db-errors';
export type {
  DecisionAnswer,
  DecisionClient,
  DecisionConfig,
  DecisionOptions,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionValue,
  EvaluateOptions,
  EvaluationResult,
} from './decisions';
export { executeDecision } from './decisions';
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
  usesPostgresDialect,
  withCallerOwnedDatabaseTransaction,
  withEmbeddedWriteQueue,
  withEmbeddedWriteTransaction,
} from './embedded-write-queue';
// Embeddings support (semantic search)
export * from './embeddings/index';
export * from './errors';
export * from './external-agent-usage.js';
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
// Code generators (tree-shakeable)
export * from './generators/index';
export { toProviderToolSchema } from './generators/provider-tool-schema.js';
export { type HierarchyView, SmrtHierarchical } from './hierarchical';
// Inference tiers and the binding resolver seam (#4750). Browser-safe; keep
// this list identical in index.ts and browser.ts.
export {
  assertInferenceConfig,
  assertInferenceTranscriptsConfig,
  builtInInferenceResolver,
  compareInferenceTiers,
  DEFAULT_INFERENCE_TIER,
  getInferenceConfig,
  getInferenceExecutor,
  getInferenceResolver,
  getInferenceTranscriptsConfig,
  INFERENCE_FUSION_MODES,
  INFERENCE_TARGET_SOURCES,
  INFERENCE_TARGET_UNBOUND,
  INFERENCE_TIERS,
  type InferenceAlias,
  InferenceBindingError,
  type InferenceCallOptions,
  type InferenceCandidate,
  type InferenceCapabilityFallbackOption,
  type InferenceConfig,
  type InferenceExecutionContext,
  type InferenceExecutor,
  type InferenceFusionDefinition,
  type InferenceFusionGate,
  type InferenceFusionLookup,
  type InferenceFusionMode,
  type InferenceFusionSeat,
  type InferenceFusionSource,
  type InferenceLatency,
  type InferenceModelClient,
  type InferenceModeRequest,
  type InferenceModeState,
  type InferenceRequest,
  type InferenceResolution,
  type InferenceResolutionSource,
  type InferenceResolver,
  type InferenceResolverContext,
  type InferenceRunRecord,
  type InferenceRunStatus,
  type InferenceTarget,
  type InferenceTargetKind,
  type InferenceTargetSource,
  type InferenceTier,
  type InferenceTierRequest,
  type InferenceTranscriptPromptConfig,
  type InferenceTranscriptsConfig,
  type InferenceUsageObservation,
  type InferenceUsageRecord,
  inferenceExecutorFor,
  inferenceModeForTarget,
  inferenceTargetKind,
  inferenceUsageTags,
  isInferenceTargetSource,
  isInferenceTier,
  isInferenceTierRequest,
  lookupInferenceFusion,
  MIN_TRANSCRIPT_MAX_BYTES,
  mergeInferenceConfigs,
  type ResolveInferenceOptions,
  resolveAutoTier,
  resolveInference,
  resolveInferenceFromConfig,
  resolveInferenceMode,
  setInferenceExecutor,
  setInferenceResolver,
} from './inference';
// Inference mode and the typed AI-unavailable state (#4757). Browser-safe;
// keep this list identical in index.ts and browser.ts.
export {
  AI_UNAVAILABLE,
  INFERENCE_MODES,
  INFERENCE_UNAVAILABLE_REASONS,
  type InferenceEntitlementDetails,
  type InferenceMode,
  type InferenceStatus,
  type InferenceUnavailableDetails,
  InferenceUnavailableError,
  type InferenceUnavailableReason,
  inferenceUnavailableMessage,
  inferenceUnavailableStatus,
  isInferenceMode,
  isInferenceUnavailableError,
  isInferenceUnavailableReason,
} from './inference-availability';
export {
  ASSUMED_INFERENCE_CAPABILITIES,
  detectInferenceCapabilities,
  estimateInferenceTokens,
  INFERENCE_CAPABILITY_HEURISTICS,
  INFERENCE_CAPABILITY_SOURCES,
  INFERENCE_PRESET_CAPABILITIES,
  type InferenceCapabilities,
  type InferenceCapabilityEvidence,
  type InferenceCapabilityHeuristic,
  type InferenceCapabilityLayers,
  type InferenceCapabilitySource,
  type InferenceCapabilityTarget,
  inferenceCapabilitiesFromSdk,
  inferenceCapabilityHeuristic,
  inferencePresetFor,
  isInferenceCapabilities,
  parseInferenceTextVerdict,
  resolveInferenceCapabilities,
} from './inference-capabilities';
export {
  checkInferenceGate,
  enforceInferenceGate,
  getInferenceGate,
  INFERENCE_BLOCKED_OPERATION,
  type InferenceGate,
  type InferenceGateDecision,
  type InferenceGateRequest,
  inferenceBlockedUsageRecord,
  inferenceGateRequest,
  isHostedInferenceTarget,
  setInferenceGate,
} from './inference-gate';
export {
  INFERENCE_PRESET_IDS,
  INFERENCE_PRESETS,
  type InferencePresetId,
  isInferencePresetId,
  resolveInferencePreset,
} from './inference-presets';
export {
  configuredAiProvider,
  createInferenceStatusHandler,
  getInferenceStatus,
  type InferenceStatusEvent,
  type InferenceStatusHandlerOptions,
  type InferenceStatusOptions,
  inferenceStatusResponse,
  isInferenceAvailable,
} from './inference-status';
export {
  bindInferenceTarget,
  inferenceTargetIdentity,
  type ResolvedInferenceTarget,
  type ResolveInferenceTargetOptions,
  resolveInferenceTarget,
} from './inference-target';
// Global interceptors system (for tenancy, soft-delete, audit logging, etc.)
export * from './interceptors';
export {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  SmrtJunction,
  SmrtJunctionBase,
} from './junction';
export * from './knowledge';
// Lazy / execute-time config resolvers (for agent_config and similar
// snapshot-prone payloads — see issue #1161)
export type {
  ConfigResolutionContext,
  ConfigResolver,
  ConfigResolverContext,
  LazyConfigSentinel,
  ResolveLazyConfigOptions,
} from './lazy-config';
export {
  createConfigResolverContext,
  getClassConfigResolvers,
  getConfigResolver,
  isLazyConfigSentinel,
  listConfigResolvers,
  preferPersisted,
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
  isAdvisoryOnlyChange,
  isManualOrAdvisoryChange,
  SchemaComparer,
} from './migrations/differ';
export * from './object';
export {
  type OperationPermissionAlias,
  resolveOperationPermissionAlias,
} from './operation-permission.js';
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
  parseRestListWhere,
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
  hasBrowserOption,
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
// Generated-surface exposure a collection class takes from its model.
export {
  type CollectionWriteEscalation,
  type CrudVerb,
  exposedCrudVerbs,
  findCollectionWriteEscalations,
  inheritCollectionExposure,
  inheritedCollectionSurface,
} from './registry/collection-exposure';
export type { RuntimeRegistrationOverride } from './registry/runtime-overrides';
// Subclass models inherit their parent model's generated surface.
export {
  findSubclassExposureEscalations,
  inheritSubclassExposure,
  type SubclassExposureEscalation,
  surfaceOpensOperation,
} from './registry/subclass-exposure';
// Revision compare-and-swap predicate helpers (#2620)
export {
  POSTGRES_REVISION_GUARD_EXPRESSION,
  postgresRevisionCandidates,
  postgresRevisionCondition,
} from './revision-guard';
export * from './run-once';
// Runtime utilities
export * from './runtime/index';
export * from './runtime-exposure.js';
export * from './runtime-model';
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
export { setDatabaseSyncDeviceId } from './sync-device.js';
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
// Presentation metadata helpers (#3599): widget hints, display label, selector lookup
export * from './ui-metadata.js';
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
// Vite plugin for auto-service generation
export { smrtPlugin } from './vite-plugin/index';
