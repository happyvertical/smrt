import type { AIClient, AIClientOptions } from '@happyvertical/ai';
import type {
  FilesystemAdapter,
  FilesystemAdapterOptions,
} from '@happyvertical/files';
import { createLogger, type LoggerConfig } from '@happyvertical/logger';
import {
  type AIExplicitConfig,
  getAIConfigBlock,
  mergeAIConfigObjects,
  tryResolveAIProviderConfig,
  withAIAliases,
} from '@happyvertical/smrt-config';
import type {
  AiTokenUsage,
  AiUsageHandler,
  AiUsageListOptions,
  AiUsageSnapshot,
  AiUsageStats,
  AiUsageSummaryOptions,
  SignalAdapter,
  SmrtAiUsageEvent,
  SmrtAiUsageRecord,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AiUsageCollector,
  AiUsagePersistenceHandler,
} from './adapters/ai-usage.js';
import {
  type AiUsageSinkAttribution,
  aiUsageSinkAttribution,
  attachAiUsageRecorder,
  brandAiUsageSink,
  dispatchAiUsageEvent,
  normalizeAiUsageEvent,
  normalizeAiUsageTags,
  normalizeAiUsageTimestamp,
  type ResolvedAiUsageConfig,
  resolveAiUsageConfig,
  resolveAiUsageTenantId,
  unwrapAiUsageSink,
} from './adapters/ai-usage-recorder.js';
import { estimateAiUsageCost } from './adapters/cost-rates.js';
import {
  type AiTranscriptContext,
  aiTranscriptsEnabled,
  captureAiTranscriptCall,
  noteAiTranscriptRun,
  observeAiTranscriptUsage,
  unwrapAiTranscriptClient,
  withAiTranscripts,
} from './ai-transcripts.js';
import { registerChangeFeedWriter } from './change-feed.js';
import {
  getSmrtModuleConfig,
  type SmrtGlobalConfig,
} from './config/global-config.js';
import type {
  AIConfig,
  AiUsageConfig,
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config.js';
import { config } from './config.js';
import type { DatabaseConfig } from './database.js';
import {
  type DecisionClient,
  type DecisionConfig,
  type DecisionOptions,
  type DecisionRequest,
  type DecisionResult,
  executeDecision,
} from './decisions.js';
import { isPerConnectionMemoryUrl } from './embedded-write-queue.js';
import { createFilesystemAdapter } from './filesystem-loader.js';
import { getDatabase, importAI } from './host.js';
import {
  getInferenceConfig as getProcessInferenceConfig,
  InferenceBindingError,
  type InferenceConfig,
  type InferenceFusionLookup,
  type InferenceLatency,
  type InferenceModelClient,
  type InferenceRequest,
  type InferenceResolution,
  type InferenceResolver,
  type InferenceRunRecord,
  type InferenceTarget,
  type InferenceTier,
  type InferenceTierRequest,
  type InferenceUsageObservation,
  type InferenceUsageRecord,
  inferenceExecutorFor,
  inferenceModeForTarget,
  inferenceTargetKind,
  inferenceUsageTags,
  lookupInferenceFusion as lookupInferenceFusionBinding,
  mergeInferenceConfigs,
  resolveInference as resolveInferenceBinding,
  resolveInferenceMode,
} from './inference.js';
import {
  type InferenceStatus,
  InferenceUnavailableError,
  inferenceUnavailableStatus,
} from './inference-availability.js';
import {
  ASSUMED_INFERENCE_CAPABILITIES,
  detectInferenceCapabilities,
  type InferenceCapabilities,
} from './inference-capabilities.js';
import {
  checkInferenceGate,
  enforceInferenceGate,
  inferenceGateRequest,
  isHostedInferenceTarget,
} from './inference-gate.js';
import {
  bindInferenceTarget,
  inferenceTargetIdentity,
} from './inference-target.js';
import { noteNativeDuckDbHandle } from './native-duckdb.js';
import type { AiToolUse } from './object.js';
import {
  applyPostgresRuntimeTimeouts,
  resolveRuntimePoolDbid,
} from './postgres-timeouts.js';
import { detectEngine } from './schema/ddl/index.js';
import { SignalBus } from './signals/bus.js';
import { recordAiRun } from './system/ai-runs.js';
import { ensureSystemTables as ensureFrameworkSystemTables } from './system/bootstrap.js';
import {
  ensureDeferredSystemTableCompatibility,
  tableExists,
} from './system/compatibility.js';
import { SMRT_SCHEMA_VERSION } from './system/schema.js';
import { toSafeInteger } from './utils/safe-integer.js';

/**
 * `_smrt_migrations.version` suffix marking that the deferred (manifest-created)
 * system tables have been through their compatibility pass (issue #2376).
 */
const DEFERRED_COMPATIBILITY_VERSION_SUFFIX = '+deferred-compat';

const logger = createLogger({ level: 'info' });
// The SDK console logger is stateless and exposes no mutable level API. Keep
// one default instance, replacing it when its documented environment input changes.
// Per-object buses/adapters and all explicitly configured loggers remain separate.
let defaultSignalLogger:
  | { envLevel: string | undefined; logger: ReturnType<typeof createLogger> }
  | undefined;

type DatabaseWithConfig = DatabaseInterface & {
  config?: {
    type?: string;
    url?: string;
  };
  type?: string;
};

type AiUsageFilterOptions = Pick<
  AiUsageListOptions,
  | 'since'
  | 'until'
  | 'provider'
  | 'model'
  | 'operation'
  | 'className'
  | 'tenantId'
  | 'promptKey'
  | 'runId'
  | 'tierRequested'
  | 'tierResolved'
>;

interface AiUsageWhereClause {
  conditions: string[];
  params: unknown[];
  nextParamIndex: number;
}

function getDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseWithConfig;
  return db.url || dbWithConfig.config?.url || '';
}

function getDatabaseTypeHint(
  config: DatabaseConfig | undefined,
): string | undefined {
  if (!config || typeof config === 'string') {
    return undefined;
  }

  const configWithType = config as DatabaseWithConfig & {
    client?: unknown;
  };

  if (typeof configWithType.type === 'string') {
    return configWithType.type;
  }

  if (typeof configWithType.config?.type === 'string') {
    return configWithType.config.type;
  }

  if ('query' in configWithType && typeof configWithType.query === 'function') {
    return undefined;
  }

  if ('client' in configWithType && configWithType.client) {
    return 'postgres';
  }

  return undefined;
}

function hydratePersistedAiUsageTokens(row: {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}): AiTokenUsage | undefined {
  const promptTokens =
    row.prompt_tokens === null || row.prompt_tokens === undefined
      ? undefined
      : toSafeInteger(row.prompt_tokens, 'AI usage prompt tokens');
  const completionTokens =
    row.completion_tokens === null || row.completion_tokens === undefined
      ? undefined
      : toSafeInteger(row.completion_tokens, 'AI usage completion tokens');
  const totalTokens =
    row.total_tokens === null || row.total_tokens === undefined
      ? undefined
      : toSafeInteger(row.total_tokens, 'AI usage total tokens');

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function parseAiUsageTags(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return normalizeAiUsageTags(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Spread helper: `{ [name]: value }` for a non-null column, else `{}`. */
function optionalAiUsageColumn<K extends string>(
  name: K,
  value: unknown,
): Partial<Record<K, string>> {
  return value === null || value === undefined
    ? {}
    : ({ [name]: String(value) } as Record<K, string>);
}

function getQueryRows(
  result: Awaited<ReturnType<DatabaseInterface['query']>>,
): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function buildAiUsageWhereClause(
  options: AiUsageFilterOptions,
): AiUsageWhereClause {
  // External harness measurements have a separate nullable summary contract.
  const conditions: string[] = [
    "NOT (operation = 'external-agent' AND id LIKE 'external-agent:%')",
  ];
  const params: unknown[] = [];
  let nextParamIndex = 1;

  if (options.since) {
    conditions.push(`created_at >= $${nextParamIndex++}`);
    params.push(options.since.toISOString());
  }

  if (options.until) {
    conditions.push(`created_at <= $${nextParamIndex++}`);
    params.push(options.until.toISOString());
  }

  if (options.provider) {
    conditions.push(`provider = $${nextParamIndex++}`);
    params.push(options.provider);
  }

  if (options.model) {
    conditions.push(`model = $${nextParamIndex++}`);
    params.push(options.model);
  }

  if (options.operation) {
    conditions.push(`operation = $${nextParamIndex++}`);
    params.push(options.operation);
  }

  if (options.className) {
    conditions.push(`class_name = $${nextParamIndex++}`);
    params.push(options.className);
  }

  if (options.tenantId === null) {
    conditions.push(`tenant_id IS NULL`);
  } else if (options.tenantId) {
    conditions.push(`tenant_id = $${nextParamIndex++}`);
    params.push(options.tenantId);
  }

  // Prompt-run observability columns (#4751).
  if (options.promptKey === null) {
    conditions.push(`prompt_key IS NULL`);
  } else if (options.promptKey) {
    conditions.push(`prompt_key = $${nextParamIndex++}`);
    params.push(options.promptKey);
  }

  if (options.runId) {
    conditions.push(`run_id = $${nextParamIndex++}`);
    params.push(options.runId);
  }

  if (options.tierRequested) {
    conditions.push(`tier_requested = $${nextParamIndex++}`);
    params.push(options.tierRequested);
  }

  if (options.tierResolved) {
    conditions.push(`tier_resolved = $${nextParamIndex++}`);
    params.push(options.tierResolved);
  }

  return {
    conditions,
    params,
    nextParamIndex,
  };
}

/**
 * Configuration options for the SmrtClass
 */
export interface SmrtClassOptions {
  /**
   * Optional custom class name override
   */
  _className?: string;

  /**
   * Database configuration - unified approach matching @happyvertical/sql
   *
   * Supports three formats:
   * - String shortcut: 'products.db' (auto-detects database type)
   * - Config object: { type: 'sqlite', url: 'products.db' }
   * - DatabaseInterface instance: await getDatabase(...)
   *
   * @see DatabaseConfig for type definition
   */
  db?: DatabaseConfig;

  /**
   * Alias for db option - for backward compatibility with documentation
   *
   * @deprecated Use 'db' instead. This alias exists for backward compatibility.
   */
  persistence?: DatabaseConfig;

  /**
   * Filesystem adapter configuration options
   */
  fs?: FilesystemAdapterOptions;

  /**
   * AI client configuration options or instance
   */
  ai?: AIClientOptions | AIClient;

  /**
   * Optional typed-decision provider or already-built decision-capable client.
   * It is independent from `ai`, which remains the generation client.
   */
  decisions?: DecisionConfig | DecisionClient;

  /**
   * Inference tier bindings for this instance, layered over the environment,
   * `config({ inference })` and smrt.config, or a resolver that replaces the
   * process-wide one for this instance (#4750).
   */
  inference?: InferenceConfig | InferenceResolver;

  /**
   * AI usage tracking configuration (overrides global defaults)
   */
  usage?: AiUsageConfig;

  /**
   * Logging configuration (overrides global default)
   */
  logging?: LoggerConfig;

  /**
   * Metrics configuration (overrides global default)
   */
  metrics?: MetricsConfig;

  /**
   * Pub/Sub configuration (overrides global default)
   */
  pubsub?: PubSubConfig;

  /**
   * Sanitization configuration (overrides global default)
   */
  sanitization?: import('./config.js').GlobalSignalConfig['sanitization'];

  /**
   * Custom signal configuration (overrides global default)
   */
  signals?: {
    /** Shared signal bus instance */
    bus?: SignalBus;
    /** Additional custom adapters */
    adapters?: SignalAdapter[];
  };

  /**
   * Internal flag to reuse an already initialized DatabaseInterface instance.
   *
   * Skips database resolution and system-table setup during lightweight hydration.
   * @internal
   */
  _reuseInitializedDb?: boolean;

  /**
   * Internal flag to defer runtime-only services such as signals and AI setup.
   *
   * Lightweight hydration paths set this so plain query reads avoid per-row
   * runtime bootstrap costs.
   * @internal
   */
  _deferRuntimeInitialization?: boolean;
}

/**
 * Foundation class providing core functionality for the SMRT framework
 *
 * SmrtClass provides unified access to database, filesystem, and AI client
 * interfaces. It serves as the foundation for all other classes in the
 * SMRT framework.
 */
export class SmrtClass {
  /**
   * AI client instance for interacting with AI models
   */
  protected _ai!: AIClient;

  /** Optional, independently initialized typed-decision client. */
  protected _decisionClient?: DecisionClient;

  private _decisionClientInitPromise?: Promise<DecisionClient | undefined>;

  /**
   * The resolved provider config the default client was built from, its
   * caller-supplied `onUsage`, and the usage config, kept so tier clients can
   * inherit tuning fields and report through the same handlers (#4750).
   */
  private _aiClientConfig?: Record<string, unknown>;
  private _aiUserOnUsage?: unknown;
  /** Explicit attribution of a sink found in the config, kept on replace. */
  private _aiSinkAttribution?: AiUsageSinkAttribution;
  private _aiUsageResolvedConfig?: ResolvedAiUsageConfig;

  /** Tier clients keyed by resolved `[provider, model, baseUrl]`, then key. */
  private _tierAiClients = new Map<string, Map<string, Promise<AIClient>>>();
  /** Transcript wrappers (#4780) per raw client, built while enabled. */
  private readonly _aiTranscriptClients = new WeakMap<object, unknown>();
  /** Tier-target keys this instance built clients with, masked (#4780). */
  private readonly _aiTranscriptKeys = new Set<string>();
  /** `getCapabilities()` answers per client (#4758). */
  private readonly _aiCapabilityAnswers = new WeakMap<
    object,
    Promise<unknown>
  >();

  /**
   * Filesystem adapter for file operations
   */
  protected _fs!: FilesystemAdapter;

  /**
   * Database interface for data persistence
   */
  protected _db!: DatabaseInterface;
  private _dbEngineHint?: string;

  /**
   * Class name used for identification
   */
  protected _className!: string;

  /**
   * Signal bus for method execution tracking
   */
  protected _signalBus?: SignalBus;

  /**
   * Adapters registered by this instance (for cleanup)
   */
  private _registeredAdapters: SignalAdapter[] = [];

  /**
   * In-memory AI usage collector for quick inspection.
   */
  private _aiUsageCollector?: AiUsageCollector;

  /**
   * Registered AI usage handlers for this instance.
   */
  private _aiUsageHandlers: AiUsageHandler[] = [];
  /** Per-run usage observers (fusion run records, #4753), keyed by run id. */
  private readonly _aiRunUsageListeners = new Map<
    string,
    Set<(event: InferenceUsageObservation) => void>
  >();

  /**
   * Tracks whether optional runtime services (signals, AI, fs) are ready.
   */
  private _runtimeServicesInitialized = false;

  /**
   * Shared in-flight runtime initialization promise for single-flight setup.
   */
  private _runtimeServicesInitPromise?: Promise<void>;

  /**
   * Configuration options provided to the class
   */
  public options: SmrtClassOptions;

  /**
   * Track which databases have had system tables initialized
   * - WeakSet for :memory: databases (URL not unique, track by instance)
   * - Set<string> for all others (URL is unique identifier)
   */
  private static _systemTablesInitialized = new WeakSet<DatabaseInterface>();
  private static _systemTablesInitializedByUrl = new Set<string>();
  private static _systemTablesInitializing = new WeakMap<
    DatabaseInterface,
    Promise<void>
  >();

  /**
   * Creates a new SmrtClass instance
   *
   * @param options - Configuration options for database, filesystem, and AI clients
   */
  constructor(options: SmrtClassOptions = {}) {
    this.options = options;
    this._className = this.constructor.name;
  }

  /**
   * Determines whether this class requires a database to function
   *
   * Override this method in subclasses that require database access
   * to enable early validation during initialization.
   *
   * @returns True if database is required, false otherwise
   * @example
   * ```typescript
   * class MyDataModel extends SmrtClass {
   *   protected requiresDatabase(): boolean {
   *     return true; // This class needs database access
   *   }
   * }
   * ```
   */
  protected requiresDatabase(): boolean {
    return false; // Base class doesn't require database by default
  }

  /**
   * Initializes database, filesystem, and AI client connections
   *
   * This method sets up all required services based on the provided options.
   * It should be called before using any of the service interfaces.
   *
   * @returns Promise that resolves to this instance for chaining
   * @throws {Error} If database is required but not provided in options
   */
  protected async initialize(): Promise<this> {
    await this.initializeCoreResources();

    if (!this.options._deferRuntimeInitialization) {
      await this.initializeRuntimeServices();
    }

    return this;
  }

  /**
   * Initialize core resources required for ORM behavior.
   *
   * This setup is shared by both full runtime initialization and lightweight
   * query hydration. Hydrated objects reuse an existing DB connection and skip
   * repeated system-table checks.
   */
  protected async initializeCoreResources(): Promise<void> {
    // Framework init hook for the change feed (#1758): make sure the writer
    // interceptor observes every save/delete before any instance can write.
    // Idempotent and cheap when already registered.
    registerChangeFeedWriter();

    // Map persistence to db for backward compatibility
    if (this.options.persistence && !this.options.db) {
      this.options.db = this.options.persistence;
    }

    // Validate database configuration if required
    if (this.requiresDatabase() && !this.options.db) {
      throw new Error(
        `${this._className} requires a database configuration. ` +
          `Please provide 'db' in options: { db: { url: '...' } } or { db: 'database.db' }`,
      );
    }

    if (this.options.db) {
      this._dbEngineHint = getDatabaseTypeHint(this.options.db);

      if (
        this.options._reuseInitializedDb &&
        typeof this.options.db === 'object' &&
        'query' in this.options.db
      ) {
        this._db = this.options.db as DatabaseInterface;
        this.options.db = this._db;
        noteNativeDuckDbHandle(this._db, this._dbEngineHint);
      } else {
        // Handle four db config formats (in implementation order):
        // 1. String URL: 'products.db' (shortcut)
        // 2. DatabaseInterface instance: already initialized db (has 'query' method)
        // 3. Config with client: { type: 'postgres', client: pgPool } (SvelteKit pattern)
        // 4. Config object: { type: 'sqlite', url: 'products.db' }
        if (typeof this.options.db === 'string') {
          // Format 1: String shortcut - let getDatabase auto-detect type from URL
          // Preserve connection sharing for file-backed databases while leaving
          // true in-memory databases isolated per instance.
          const isMemoryDb = this.options.db === ':memory:';
          // PostgreSQL URLs pick up the runtime timeout bounds (#2377); the
          // pool identity comes from the one shared rule so a PostgreSQL pool
          // is keyed on its effective pool options, not the URL alone (#3046).
          const bounded = applyPostgresRuntimeTimeouts({
            url: this.options.db,
          });
          this._db = await getDatabase({
            ...bounded,
            ...(isMemoryDb ? {} : { dbid: resolveRuntimePoolDbid(bounded) }),
          } as unknown as Parameters<typeof getDatabase>[0]);
        } else if ('query' in this.options.db) {
          // Format 2: Already a DatabaseInterface instance - return as-is
          this._db = this.options.db as DatabaseInterface;
        } else if ('client' in this.options.db && this.options.db.client) {
          // Format 3: Config with pre-created client (e.g., from SvelteKit's $env-based connection)
          // Pass the client to getDatabase which will use it instead of creating a new connection
          const dbConfig = this.options.db as {
            type?: string;
            client: unknown;
            url?: string;
          };
          // `client` is a runtime-only property the postgres adapter reads
          // but the public `getDatabase` option union does not model, so the
          // literal is routed through the function's own parameter type.
          this._db = await getDatabase({
            type: dbConfig.type || 'postgres',
            client: dbConfig.client,
            url: dbConfig.url,
          } as unknown as Parameters<typeof getDatabase>[0]);
        } else {
          // Format 4: Config object - pass to getDatabase (handles all types uniformly)
          // Preserve connection sharing for file-backed databases while leaving
          // true in-memory databases isolated per instance.
          const dbConfig = this.options.db as { url?: string; type?: string };
          const dbUrl = dbConfig.url || 'memory';
          const isMemoryDb = dbUrl === ':memory:' || dbUrl === 'memory';
          // Keep the config's own key set: an object with no `url` must stay
          // that way so the adapter applies its own default (#2377).
          const bounded = applyPostgresRuntimeTimeouts({ ...this.options.db });
          // The loose config-object variant of `DatabaseConfig` carries an
          // index signature that the closed `getDatabase` option union does
          // not accept structurally, so route through its parameter type.
          this._db = await getDatabase({
            ...bounded,
            ...(isMemoryDb
              ? {}
              : { dbid: resolveRuntimePoolDbid(bounded, dbUrl) }),
          } as unknown as Parameters<typeof getDatabase>[0]);
        }

        /**
         * INTENTIONAL MUTATION: After resolving the database config,
         * we replace options.db with the actual DatabaseInterface instance.
         * This enables child objects to share the same connection via:
         *
         *   const child = new ChildObject({ db: parent.options.db });
         *
         * Without this, passing this.options to getCollection() would use the config object
         * which causes a NEW db instance to be created, losing data isolation.
         *
         * See issue #567 for context on why this pattern is necessary.
         */
        this.options.db = this._db;
        // Identify a native DuckDB root now, so transaction handles later
        // bound to this object resolve to the same engine (#3737).
        noteNativeDuckDbHandle(this._db, this._dbEngineHint);

        await this.ensureSystemTables();
      }
    }
  }

  /**
   * Initialize optional runtime services that are not required for plain ORM reads.
   */
  protected async initializeRuntimeServices(): Promise<void> {
    if (this._runtimeServicesInitialized) {
      return;
    }

    if (!this._runtimeServicesInitPromise) {
      this._runtimeServicesInitPromise = (async () => {
        if (this.options.fs && !this._fs) {
          // Acquired through the boundary in filesystem-loader.ts so the
          // @happyvertical/files SDK (S3/googleapis) never enters
          // provider-neutral consumer bundles (#1977/#1979).
          this._fs = await createFilesystemAdapter(this.options.fs);
        }

        // Initialize AI client with environment variable support
        // Priority: instance options > env vars > global config > defaults
        const globalConfig = config.toJSON();
        const usageConfig = this.mergeAiUsageConfig(globalConfig);
        this.initializeAiUsageHandlers(usageConfig);
        this._aiUsageResolvedConfig = usageConfig;

        // The smrt.config.ts `ai` block (resolved through smrt-config's shared
        // resolver) is the lowest-priority declared source, above SMRT_AI_*.
        // Only a block that names a provider counts: a partial block (model,
        // baseUrl or apiKeyEnv alone) behaves exactly like an absent block.
        const declaredBlock = getAIConfigBlock();
        const aiConfigBlock = declaredBlock?.provider ? declaredBlock : null;
        if (
          !this._ai &&
          (this.options.ai ||
            globalConfig.ai ||
            aiConfigBlock ||
            globalThis.process?.env?.SMRT_AI_PROVIDER)
        ) {
          // Check if options.ai is already a client-like object with embed method
          // This allows passing mock AI clients for testing
          const aiOption = this.options.ai as
            | Record<string, unknown>
            | undefined;
          if (
            aiOption &&
            typeof aiOption === 'object' &&
            typeof aiOption.embed === 'function' &&
            !aiOption.provider
          ) {
            this._ai = aiOption as unknown as AIClient;
          } else {
            // Passthrough tuning fields (timeout, maxRetries, ...) still come
            // from `SMRT_AI_*` via loadEnvConfig. Provider/key/model selection
            // goes through the shared smrt-config resolver below (#3372).
            const { loadEnvConfig } = await import('@happyvertical/utils');

            // Start with global defaults
            const baseConfig = globalConfig.ai || {};

            // Merge with instance options (takes priority over global)
            // Provider ownership holds across these two layers too: the shared
            // canonicalising merge folds provider/type and model/defaultModel,
            // and drops the global layer's provider, key, base URL and model
            // when the instance options name a different provider.
            const userConfig = mergeAIConfigObjects(
              baseConfig,
              this.options.ai,
            );

            // Load environment variables and merge (user options take priority).
            // `AIConfig` carries an index signature, so provider-specific keys
            // (`type`, `onUsage`, `defaultModel`, …) read back as `unknown`.
            const aiConfig = loadEnvConfig<AIConfig>(userConfig, {
              packageName: 'ai',
              prefix: 'SMRT',
              schema: {
                provider: 'string',
                model: 'string',
                apiKey: 'string',
                timeout: 'number',
                maxRetries: 'number',
                temperature: 'number',
                maxTokens: 'number',
              },
            });

            // Provider, key, base URL and model always come from the shared
            // resolver's bound result (options.ai > core global config >
            // smrt.config `ai` block > SMRT_AI_*), so a credential is only ever
            // sent to the provider its own source named; env-loaded values are
            // replaced, not merged. Tuning fields keep their current source.
            // Without a block the provider's own key variable is not consulted
            // (no behaviour change for apps that never declared one).
            const resolvedAi = tryResolveAIProviderConfig({
              explicit: userConfig as AIExplicitConfig,
              config: aiConfigBlock,
              prefixes: ['SMRT_AI'],
              autoDetect: false,
              requireProvider: false,
              providerKeyEnvFallback: Boolean(aiConfigBlock),
            });
            // Replace (never merge) the identity/credential fields with the
            // resolver's bound result, then set both client-facing aliases so
            // no stale `type` / `defaultModel` reaches getAI().
            const bound: Record<string, unknown> = {
              provider: resolvedAi?.provider,
              apiKey: resolvedAi?.apiKey,
              baseUrl: resolvedAi?.baseUrl,
              model: resolvedAi?.model,
            };
            for (const key of [
              'provider',
              'type',
              'apiKey',
              'baseUrl',
              'model',
              'defaultModel',
            ]) {
              delete (aiConfig as Record<string, unknown>)[key];
            }
            for (const [key, value] of Object.entries(bound)) {
              if (value) (aiConfig as Record<string, unknown>)[key] = value;
            }
            Object.assign(
              aiConfig,
              withAIAliases(aiConfig as Record<string, unknown>),
            );

            // A recorder or `withAiUsage()` sink in the config is replaced
            // (keeping the callback it wraps): this client records through
            // the instance pipeline below, so a call is recorded once. The
            // sink's explicit tenant and tags still apply (#3077).
            const configuredOnUsage =
              aiConfig.onUsage ??
              (userConfig as Record<string, unknown>).onUsage ??
              undefined;
            const existingOnUsage = unwrapAiUsageSink(configuredOnUsage);
            const sinkAttribution = aiUsageSinkAttribution(configuredOnUsage);
            aiConfig.onUsage = async (event: unknown) => {
              // Transcript capture (#4780) reads the raw event synchronously,
              // before the caller's (possibly async) callback, so the call
              // knows its substitutions and run before it resolves.
              observeAiTranscriptUsage(event);
              // Record even when the caller's callback throws; its error
              // still propagates (#3077).
              try {
                if (typeof existingOnUsage === 'function') {
                  await (existingOnUsage as (usageEvent: unknown) => unknown)(
                    event,
                  );
                }
              } finally {
                await this.handleAiUsageCallback(
                  event,
                  aiConfig,
                  usageConfig,
                  sinkAttribution,
                );
              }
            };

            // Only initialize if we have a provider configured
            if (aiConfig.provider || aiConfig.type || aiConfig.apiKey) {
              // Use the getAI() factory (loaded lazily to keep the
              // `@happyvertical/ai` module graph off smrt-core's cold-start
              // import path — see issue #2894) to support all AI providers
              // (OpenAI, Anthropic, Gemini, etc.). getAI() returns
              // AIInterface, which we narrow to AIClient for backward
              // compatibility. The index-signature `AIConfig` is routed
              // through getAI's own parameter type rather than the closed
              // union.
              const { getAI } = await importAI();
              this._ai = (await getAI(
                aiConfig as unknown as Parameters<typeof getAI>[0],
              )) as unknown as AIClient;
              this._aiClientConfig = aiConfig as Record<string, unknown>;
              this._aiUserOnUsage = existingOnUsage;
              this._aiSinkAttribution = sinkAttribution;
            }
          }
        }

        await this.initializeSignals();
        this._runtimeServicesInitialized = true;
      })();
    }

    try {
      await this._runtimeServicesInitPromise;
    } finally {
      this._runtimeServicesInitPromise = undefined;
    }
  }

  /**
   * Ensure deferred runtime services are ready before using them.
   */
  protected async ensureRuntimeServicesInitialized(): Promise<void> {
    if (!this._runtimeServicesInitialized) {
      await this.initializeRuntimeServices();
    }
  }

  /**
   * Resolve the AI client, initializing deferred runtime services on demand.
   *
   * With no `tier` this returns the instance's configured client, exactly as
   * before #4750. With a tier it resolves the binding through the inference
   * seam and returns a client for the bound target, cached per resolved
   * `(provider, model, baseUrl)`; a tier with no binding (the unconfigured
   * default) returns the configured client. Pass `options.resolution` to reuse
   * a resolution the caller already made, so the resolver runs once per call.
   *
   * A chain target (`alias`, `candidates`; #4752) returns the registered
   * executor's client, which walks the chain per call; `minimumTier` and
   * `allowPartial` reach it. Without a registered executor a chain target
   * throws rather than falling back to the configured client.
   *
   * Throws `InferenceUnavailableError` (`AI_UNAVAILABLE`, #4757) before any
   * client is built when the resolution is unavailable (mode `off`, ...),
   * when a registered resolver's `mode()` says `off` for an untiered call,
   * or when nothing is configured (`unconfigured`).
   */
  protected async getAiClient(
    tier?: InferenceTierRequest,
    options: {
      latency?: InferenceLatency;
      promptKey?: string;
      resolution?: InferenceResolution;
      minimumTier?: InferenceTier;
      allowPartial?: boolean;
    } = {},
  ): Promise<AIClient> {
    // While the app stores transcripts (#4780) the returned client carries a
    // `callId` per call and captures content; otherwise it is returned as is.
    return this.transcriptClient(await this.resolveAiClient(tier, options));
  }

  /** {@link getAiClient} without the transcript wrapper. */
  private async resolveAiClient(
    tier?: InferenceTierRequest,
    options: {
      latency?: InferenceLatency;
      promptKey?: string;
      resolution?: InferenceResolution;
      minimumTier?: InferenceTier;
      allowPartial?: boolean;
    } = {},
  ): Promise<AIClient> {
    await this.ensureRuntimeServicesInitialized();

    if (tier !== undefined) {
      const request: InferenceRequest = {
        tier,
        ...(options.latency ? { latency: options.latency } : {}),
        ...(options.promptKey ? { promptKey: options.promptKey } : {}),
      };
      const resolution =
        options.resolution ?? (await this.resolveInferenceTier(request));
      if (resolution.unavailable) {
        throw new InferenceUnavailableError({
          reason: resolution.unavailable,
          ...(resolution.mode ? { mode: resolution.mode } : {}),
          tier: resolution.tierResolved,
          owner: this._className,
        });
      }
      // A hosted target (single, or a chain stamped hosted as a whole)
      // passes the gate before its client is built; a hosted target the
      // executor reaches later (a ladder step's resolution) passes it in
      // `clientFor`, per attempt.
      await this.enforceHostedInferenceGate(request, resolution);
      const executor = inferenceExecutorFor(resolution.target);
      if (executor) {
        const tenantId = this.currentTenantId();
        return executor.createClient({
          request: {
            className: this._className,
            ...(tenantId !== undefined ? { tenantId } : {}),
            ...request,
          },
          resolution,
          config: this.getInferenceConfig(),
          ...(options.minimumTier ? { minimumTier: options.minimumTier } : {}),
          ...(options.allowPartial ? { allowPartial: true } : {}),
          clientFor: async (target) => {
            await this.enforceHostedInferenceGate(request, resolution, target);
            return (await this.getAiClientForTarget(
              target,
            )) as unknown as InferenceModelClient;
          },
          resolveTier: (next, overrides) =>
            this.resolveInferenceTier({
              ...request,
              ...(overrides?.promptKey
                ? { promptKey: overrides.promptKey }
                : {}),
              tier: next,
            }),
          recordUsage: (record) => this.recordInferenceUsage(record),
          capabilitiesFor: (target) =>
            this.detectInferenceTargetCapabilities(target),
          ...(this._db ? { db: this._db } : {}),
          decide: (decisionRequest, decisionOptions) =>
            this.decideForInference(decisionRequest, decisionOptions),
          recordRun: (record) => this.recordInferenceRun(record),
          observeUsage: (runId, listener) =>
            this.observeRunUsage(runId, listener),
          lookupFusion: (key) => this.lookupInferenceFusion(key, request),
        }) as unknown as AIClient;
      }
      return this.getAiClientForTarget(
        resolution.target,
        resolution.tierResolved,
      );
    }

    const modeState = await this.resolveInferenceModeState();
    if (modeState?.unavailable) {
      throw new InferenceUnavailableError({
        reason: modeState.unavailable,
        mode: modeState.mode,
        owner: this._className,
      });
    }
    // An explicit stored mode (byo/local/hosted) is the principal's choice of
    // where inference runs: untiered calls take it through `auto` rather than
    // the configured client, so a `local` or keyless `byo` choice never runs
    // on the app's provider.
    if (modeState) return this.resolveAiClient('auto', options);
    return this.requireConfiguredAi();
  }

  /**
   * Where this instance's transcripts go (#4780): its database, class,
   * usage tenant, client key (masked) and `sensitive` field values (masked).
   */
  protected aiTranscriptContext(): AiTranscriptContext {
    return {
      // Read per call: `withDatabase()` rebinds the instance's database.
      db: () => this._db ?? null,
      className: this._className,
      tenantId: () =>
        resolveAiUsageTenantId(
          this._aiSinkAttribution?.tenantId,
          this.currentTenantId(),
        ) ?? null,
      ...(typeof this._aiClientConfig?.provider === 'string'
        ? { provider: this._aiClientConfig.provider }
        : {}),
      ...(typeof this._aiClientConfig?.model === 'string'
        ? { model: this._aiClientConfig.model }
        : {}),
      secrets: () => this.aiTranscriptSecrets(),
      sensitive: () => this.aiTranscriptSensitiveValues(),
    };
  }

  /** Credential values transcripts must never contain. */
  private aiTranscriptSecrets(): string[] {
    const secrets: string[] = [...this._aiTranscriptKeys];
    for (const source of [
      this._aiClientConfig,
      this.options.ai as Record<string, unknown> | undefined,
      this.getDecisionConfig() as Record<string, unknown> | undefined,
    ]) {
      const key = source?.apiKey;
      if (typeof key === 'string' && key.trim() !== '') secrets.push(key);
    }
    return secrets;
  }

  /**
   * Values of this object's `sensitive` fields, masked in transcripts
   * (#4780). `SmrtObject` returns them; plain `SmrtClass` instances have no
   * fields.
   */
  protected aiTranscriptSensitiveValues(): Array<{
    field: string;
    value: string;
  }> {
    return [];
  }

  /**
   * `client` wrapped for transcripts while the app enables them (#4780),
   * else unchanged. Wrappers are cached per client, so identity is stable
   * across calls; a per-call `transcript` default or context `overrides`
   * (a raw `getAI()` client attributed to an explicit tenant) build a fresh
   * one. Subclasses that build their own `getAI()` client pass it here.
   */
  protected transcriptClient<T>(
    client: T,
    transcript?: boolean,
    overrides?: Partial<AiTranscriptContext>,
  ): T {
    if (!client || typeof client !== 'object' || !aiTranscriptsEnabled()) {
      return client;
    }
    const wrappedAlready = unwrapAiTranscriptClient(client) !== client;
    if (transcript === undefined && !overrides && wrappedAlready) {
      return client;
    }
    if (transcript !== undefined || overrides) {
      const context = this.aiTranscriptContext();
      const extraSecrets = overrides?.secrets;
      return withAiTranscripts(client, {
        ...context,
        ...(overrides ?? {}),
        // A site's own credentials add to the instance's, never replace them.
        ...(extraSecrets
          ? {
              secrets: () => [
                ...(context.secrets?.() ?? []),
                ...extraSecrets(),
              ],
            }
          : {}),
        ...(transcript !== undefined ? { transcript } : {}),
      });
    }
    const key = client as unknown as object;
    let wrapped = this._aiTranscriptClients.get(key) as T | undefined;
    if (!wrapped) {
      wrapped = withAiTranscripts(client, this.aiTranscriptContext());
      this._aiTranscriptClients.set(key, wrapped);
    }
    return wrapped;
  }

  /**
   * The hosted gate (#4760) for one target: `byo` / `local` / `app` targets
   * return at once; a `source: 'hosted'` target asks the registered gate and,
   * on a block (or a failing gate: fail closed), records the zero-usage
   * `operation: 'blocked'` row through this instance's usage pipeline and
   * throws `InferenceUnavailableError` (`reason: 'entitlement'`).
   */
  private async enforceHostedInferenceGate(
    request: InferenceRequest,
    resolution: InferenceResolution,
    target: InferenceTarget = resolution.target,
  ): Promise<void> {
    if (!isHostedInferenceTarget(target)) return;
    await enforceInferenceGate(
      this.hostedGateRequest(request, resolution, target),
      {
        record: (row) => this.recordInferenceUsage(row),
        resolution,
        owner: this._className,
      },
    );
  }

  /** The gate request for this instance's class, tenant and user scope. */
  private hostedGateRequest(
    request: InferenceRequest,
    resolution: InferenceResolution,
    target: InferenceTarget,
  ) {
    const { tenantId, userId } = this.inferenceRequestScope();
    return inferenceGateRequest(
      {
        className: this._className,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(userId === null ? { userId: null } : {}),
        ...request,
      },
      resolution,
      target,
    );
  }

  /**
   * The configured client, or `InferenceUnavailableError('unconfigured')`
   * (#4757; before, a plain `Error` "does not have an AI client
   * configured").
   */
  private requireConfiguredAi(tier?: InferenceTier): AIClient {
    if (!this._ai) {
      throw new InferenceUnavailableError({
        reason: 'unconfigured',
        ...(tier ? { tier } : {}),
        owner: this._className,
      });
    }
    return this._ai;
  }

  /**
   * `null` when this instance's AI client serves more than one user (a
   * long-lived agent): resolutions and mode checks then skip every user's
   * stored binding and mode (#4756, #4757). Default `undefined`: the
   * ambient principal's user applies.
   */
  protected inferenceUserScope(): null | undefined {
    return undefined;
  }

  /** This instance's resolver (instance `inference` option) and tenant. */
  private inferenceRequestScope(): {
    resolver: InferenceResolver | undefined;
    tenantId: string | null | undefined;
    userId: null | undefined;
  } {
    const instance = this.options.inference;
    const resolver =
      instance && typeof (instance as InferenceResolver).resolve === 'function'
        ? (instance as InferenceResolver)
        : undefined;
    return {
      resolver,
      tenantId: this.currentTenantId(),
      userId: this.inferenceUserScope(),
    };
  }

  /**
   * The stored mode for an untiered call (registered resolver's `mode()`).
   * A non-`off` result means untiered calls route through `auto`.
   */
  protected async resolveInferenceModeState() {
    const { resolver, tenantId, userId } = this.inferenceRequestScope();
    return resolveInferenceMode(
      {
        className: this._className,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(userId === null ? { userId: null } : {}),
      },
      resolver ? { resolver } : {},
    );
  }

  /**
   * Whether an AI call would run for this instance (#4757), without calling
   * a model or recording usage. With `tier` it resolves the binding the way
   * `getAiClient(tier)` does; without, it checks the stored mode and the
   * configured client. A chain target counts as available (its candidates
   * are tried at call time).
   */
  async getInferenceStatus(
    options: { tier?: InferenceTierRequest } = {},
  ): Promise<InferenceStatus> {
    await this.ensureRuntimeServicesInitialized();
    const configured = this._aiClientConfig;
    if (options.tier === undefined) {
      const state = await this.resolveInferenceModeState();
      if (state?.unavailable) {
        return inferenceUnavailableStatus(state.unavailable, state.mode);
      }
      if (state) {
        // An explicit mode routes untiered calls through `auto`.
        const { tier: _tier, ...routed } = await this.getInferenceStatus({
          tier: 'auto',
        });
        return routed;
      }
      if (!this._ai) return inferenceUnavailableStatus('unconfigured');
      return {
        available: true,
        mode: inferenceModeForTarget(undefined, configured),
      };
    }
    const resolution = await this.resolveInferenceTier({ tier: options.tier });
    const tier = resolution.tierResolved;
    if (resolution.unavailable) {
      return inferenceUnavailableStatus(
        resolution.unavailable,
        resolution.mode,
        tier,
      );
    }
    const target = resolution.target ?? {};
    if (
      inferenceTargetKind(target) === 'single' &&
      !inferenceTargetIdentity(target).provider &&
      !this._ai
    ) {
      return inferenceUnavailableStatus('unconfigured', undefined, tier);
    }
    if (isHostedInferenceTarget(target)) {
      // Ask the hosted gate (#4760) as a probe: decide, record nothing.
      const decision = await checkInferenceGate({
        ...this.hostedGateRequest({ tier: options.tier }, resolution, target),
        probe: true,
      });
      if (decision.action === 'block') {
        return inferenceUnavailableStatus(
          'entitlement',
          'hosted',
          tier,
          decision.details,
        );
      }
    }
    return {
      available: true,
      mode: inferenceModeForTarget(resolution, configured),
      tier,
    };
  }

  /** `true` when {@link getInferenceStatus} reports `available`. */
  async isInferenceAvailable(
    options: { tier?: InferenceTierRequest } = {},
  ): Promise<boolean> {
    return (await this.getInferenceStatus(options)).available;
  }

  /**
   * Pick the generation client for an AI operation and strip the tier keys.
   *
   * Without `tier` this is exactly `getAiClient()` and the options pass
   * through untouched, unless an explicit stored mode (#4757) routes the
   * call through `auto`. With `tier` the binding is resolved once; the target's
   * `params` and `model` become per-call defaults under the caller's options,
   * and `tierRequested` / `tierResolved` are merged over the caller's
   * `usageTags`. Subclasses that call `ai.message()` themselves (prompt
   * helpers forwarding a resolved prompt's `tier`) use this too, so `tier`
   * never reaches the provider as an unknown option. It lives on `SmrtClass`
   * so collections that run prompts (e.g. smrt-facts) bind tiers the same way
   * objects do (#4755).
   */
  protected async prepareAiOperation<
    T extends {
      tier?: InferenceTierRequest;
      latency?: InferenceLatency;
      promptKey?: string;
      usageTags?: Record<string, string>;
      minimumTier?: InferenceTier;
      allowPartial?: boolean;
      toolUse?: AiToolUse;
      transcript?: boolean;
    },
  >(
    options: T,
  ): Promise<{
    ai: AIClient;
    aiOptions: Omit<
      T,
      | 'tier'
      | 'latency'
      | 'promptKey'
      | 'minimumTier'
      | 'allowPartial'
      | 'toolUse'
      | 'transcript'
    >;
    /**
     * The bound model's capabilities (#4758), for a tier call on a `single`
     * target; absent without `tier` (untiered calls are unchanged) and for
     * chain targets (the executor checks each candidate).
     */
    capabilities?: InferenceCapabilities;
    /** True when a registered executor runs the target (chains, fusions). */
    executorRun?: boolean;
    /** The caller's `toolUse` (`AiOperationOptions.toolUse`). */
    toolUse?: AiToolUse;
  }> {
    const {
      tier: requestedTier,
      latency,
      promptKey,
      minimumTier,
      allowPartial,
      toolUse,
      // The transcript directive (#4780) rides on the client, never on the
      // provider call.
      transcript,
      ...rest
    } = options;
    let tier = requestedTier;
    if (tier === undefined) {
      // An explicit stored mode (#4757) routes untiered calls through `auto`
      // so the chosen binding answers with its model, params and tags; an
      // unavailable mode throws from getAiClient().
      const modeState = await this.resolveInferenceModeState();
      if (!modeState || modeState.unavailable) {
        return {
          ai: this.transcriptClient(await this.getAiClient(), transcript),
          aiOptions: rest,
          ...(toolUse ? { toolUse } : {}),
        };
      }
      tier = 'auto';
    }
    const resolution = await this.resolveInferenceTier({
      tier,
      latency,
      ...(promptKey ? { promptKey } : {}),
    });
    // `getAiClient()` stays the seam subclasses override; the per-call
    // directive re-wraps its (already wrapped) client.
    const ai = this.transcriptClient(
      await this.getAiClient(tier, {
        latency,
        promptKey,
        resolution,
        ...(minimumTier ? { minimumTier } : {}),
        ...(allowPartial ? { allowPartial } : {}),
      }),
      transcript,
    );
    // A chain target carries no model or params of its own: each candidate
    // applies its own inside the executor (#4752).
    const single = inferenceTargetKind(resolution.target) === 'single';
    const target = single ? resolution.target : {};
    let capabilities: InferenceCapabilities | undefined;
    if (single) {
      try {
        // The model the call will run: a caller `model` replaces the
        // target's per call (below), so capabilities follow it.
        const requested = (rest as { model?: unknown }).model;
        const callModel =
          typeof requested === 'string' && requested.trim() !== ''
            ? requested.trim()
            : undefined;
        capabilities = await this.detectInferenceTargetCapabilities(
          callModel
            ? { ...resolution.target, model: callModel }
            : resolution.target,
          ai,
          // The client was built for the bound model; its SDK answer does
          // not describe an override.
          { sdk: !callModel || callModel === resolution.target.model?.trim() },
        );
      } catch {
        // Detection never fails a call: an unknown answer is today's
        // behavior.
        capabilities = { ...ASSUMED_INFERENCE_CAPABILITIES };
      }
    }
    return {
      ai,
      ...(capabilities ? { capabilities } : { executorRun: true }),
      ...(toolUse ? { toolUse } : {}),
      aiOptions: {
        ...(target.params ?? {}),
        ...(typeof target.model === 'string' && target.model.trim() !== ''
          ? { model: target.model.trim() }
          : {}),
        ...rest,
        usageTags: {
          ...(rest.usageTags ?? {}),
          ...inferenceUsageTags(tier, resolution),
        },
      } as Omit<
        T,
        | 'tier'
        | 'latency'
        | 'promptKey'
        | 'minimumTier'
        | 'allowPartial'
        | 'toolUse'
        | 'transcript'
      >,
    };
  }

  /**
   * The merged inference config for this instance: smrt.config <
   * `config({ inference })` < environment < instance `inference` options.
   */
  protected getInferenceConfig(): InferenceConfig | undefined {
    const instance = this.options.inference;
    const instanceConfig =
      instance &&
      typeof instance === 'object' &&
      typeof (instance as InferenceResolver).resolve !== 'function'
        ? (instance as InferenceConfig)
        : undefined;
    return mergeInferenceConfigs(getProcessInferenceConfig(), instanceConfig);
  }

  /**
   * Resolve a tier request through the inference seam with this instance's
   * class, tenant, config, and (when given) instance resolver. Never calls a
   * model.
   */
  protected async resolveInferenceTier(
    request: InferenceRequest,
  ): Promise<InferenceResolution> {
    const { resolver, tenantId, userId } = this.inferenceRequestScope();
    return resolveInferenceBinding(
      {
        className: this._className,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(userId === null ? { userId: null } : {}),
        ...request,
      },
      { resolver, config: this.getInferenceConfig() },
    );
  }

  /**
   * The fusion definition `key` runs (#4800): the instance's (or the
   * registered) resolver's stored layer, then the merged `inference.fusions`.
   * Same scope as {@link resolveInferenceTier}; never calls a model.
   */
  protected async lookupInferenceFusion(
    key: string,
    request: InferenceRequest,
  ): Promise<InferenceFusionLookup | undefined> {
    const { resolver, tenantId, userId } = this.inferenceRequestScope();
    return lookupInferenceFusionBinding(
      key,
      {
        className: this._className,
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(userId === null ? { userId: null } : {}),
        ...request,
      },
      { resolver, config: this.getInferenceConfig() },
    );
  }

  /**
   * Capabilities of one `single` tier target (#4758): the client's
   * `getCapabilities()` (cached per client), then the preset table, then the
   * model-name heuristic, then assumed; see `inference-capabilities.ts`.
   * Builds the target's client when `client` is not given; never calls a
   * model. `sdk: false` skips the client's answer: a call that overrides
   * the model runs on a client built for another model, whose answer does
   * not describe the override.
   */
  protected async detectInferenceTargetCapabilities(
    target: InferenceTarget,
    client?: AIClient,
    options: { sdk?: boolean } = {},
  ): Promise<InferenceCapabilities> {
    const ai = client ?? (await this.getAiClientForTarget(target));
    const identity = inferenceTargetIdentity(target);
    const base = this._aiClientConfig;
    // The effective identity the client was built for: the target bound over
    // the configured client under the pair rules (the configured client
    // itself for an empty target).
    const bound: Record<string, unknown> =
      Object.keys(identity).length === 0
        ? (base ?? {})
        : base || identity.provider
          ? bindInferenceTarget(base, target, this._className)
          : identity;
    const read = (key: string) =>
      typeof bound[key] === 'string' && (bound[key] as string).trim() !== ''
        ? (bound[key] as string).trim()
        : undefined;
    return detectInferenceCapabilities(
      {
        provider: read('provider') ?? read('type'),
        model: identity.model ?? read('model') ?? read('defaultModel'),
        baseUrl: read('baseUrl'),
      },
      options.sdk === false ? undefined : await this.sdkCapabilities(ai),
    );
  }

  /** A client's `getCapabilities()` answer, once per client; never throws. */
  private sdkCapabilities(ai: AIClient): Promise<unknown> {
    const key = ai as unknown as object;
    let pending = this._aiCapabilityAnswers.get(key);
    if (!pending) {
      const getCapabilities = (ai as { getCapabilities?: unknown })
        .getCapabilities;
      pending =
        typeof getCapabilities === 'function'
          ? Promise.resolve()
              .then(() => (getCapabilities as () => Promise<unknown>).call(ai))
              .catch(() => undefined)
          : Promise.resolve(undefined);
      this._aiCapabilityAnswers.set(key, pending);
    }
    return pending;
  }

  /**
   * Client for one tier target. Absent fields inherit from the configured
   * client; a target naming another provider drops the configured
   * credentials and model (provider ownership, #3372) and falls back to that
   * provider's own key variable.
   */
  private async getAiClientForTarget(
    target: InferenceTarget,
    tier?: InferenceTier,
  ): Promise<AIClient> {
    if (inferenceExecutorFor(target)) {
      throw new Error(
        `${this._className}: a chain inference target cannot be bound to one client; run it through getAiClient(tier).`,
      );
    }
    const identity = inferenceTargetIdentity(target);
    // A bound key (a user's BYO key, a hosted gateway key) is masked in
    // transcripts like the configured one (#4780).
    if (identity.apiKey) this._aiTranscriptKeys.add(identity.apiKey);
    if (Object.keys(identity).length === 0)
      return this.requireConfiguredAi(tier);

    const base = this._aiClientConfig;
    if (!base && !identity.provider) {
      // An injected (or absent) default client has no provider config to
      // refine. A model-only target keeps the injected client; callers on the
      // object operation path also send the target model per call.
      if (this._ai && !identity.baseUrl && !identity.apiKey) return this._ai;
      if (!this._ai) return this.requireConfiguredAi(tier);
      throw new InferenceBindingError(
        `${this._className} cannot rebind an injected AI client to a new endpoint; the inference target must name a provider.`,
      );
    }

    const tierConfig = bindInferenceTarget(base, target, this._className);
    const field = (config: Record<string, unknown> | undefined, key: string) =>
      typeof config?.[key] === 'string' ? (config[key] as string) : '';

    if (
      base &&
      this._ai &&
      ['provider', 'model', 'baseUrl', 'apiKey'].every(
        (key) => field(base, key) === field(tierConfig, key),
      )
    ) {
      return this._ai;
    }

    const cacheKey = JSON.stringify([
      field(tierConfig, 'provider'),
      field(tierConfig, 'model'),
      field(tierConfig, 'baseUrl'),
    ]);
    const credentialKey = field(tierConfig, 'apiKey');
    let byCredential = this._tierAiClients.get(cacheKey);
    if (!byCredential) {
      byCredential = new Map();
      this._tierAiClients.set(cacheKey, byCredential);
    }
    const cached = byCredential.get(credentialKey);
    if (cached) return cached;

    const userOnUsage = this._aiUserOnUsage;
    const sinkAttribution = this._aiSinkAttribution;
    const usageConfig =
      this._aiUsageResolvedConfig ?? this.mergeAiUsageConfig(config.toJSON());
    tierConfig.onUsage = async (event: unknown) => {
      // Synchronously, before the caller's callback (#4780).
      observeAiTranscriptUsage(event);
      try {
        if (typeof userOnUsage === 'function') {
          await (userOnUsage as (usageEvent: unknown) => unknown)(event);
        }
      } finally {
        await this.handleAiUsageCallback(
          event,
          tierConfig,
          usageConfig,
          sinkAttribution,
        );
      }
    };

    const pending = (async () => {
      // Same lazy SDK import as the default client (#2894).
      const { getAI } = await importAI();
      return (await getAI(
        tierConfig as unknown as Parameters<typeof getAI>[0],
      )) as unknown as AIClient;
    })();
    byCredential.set(credentialKey, pending);
    pending.catch(() => {
      if (byCredential.get(credentialKey) === pending) {
        byCredential.delete(credentialKey);
      }
    });
    return pending;
  }

  /** This instance's tenant id: a value, `null` (global), or unknown. */
  private currentTenantId(): string | null | undefined {
    return 'tenantId' in this &&
      (this as { tenantId?: string | null }).tenantId !== undefined
      ? ((this as { tenantId?: string | null }).tenantId ?? null)
      : undefined;
  }

  /**
   * A fusion gate's decision (#4753): the instance's typed-decision client,
   * as `evaluate()` uses it, with the run's usage tags on the usage row.
   */
  private async decideForInference(
    request: DecisionRequest,
    options: { usageTags?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<DecisionResult | undefined> {
    const decision = await this.getDecisionClient();
    if (!decision) return undefined;
    const result = await executeDecision(decision, request, {
      ...(options.signal ? { signal: options.signal } : {}),
      usageTags: { ...(options.usageTags ?? {}), operation: 'decision' },
    } as DecisionOptions);
    await this.recordAiUsageEvent(
      {
        provider: result.provenance.provider,
        model: result.provenance.model,
        operation: 'decision',
        usage: result.usage,
        tags: { ...(options.usageTags ?? {}), operation: 'decision' },
      },
      result.provenance,
    );
    return result;
  }

  /**
   * Write a fusion run record (#4753) when usage persistence is on. A write
   * failure is logged, never thrown: it must not mask the run's own result.
   */
  private async recordInferenceRun(record: InferenceRunRecord): Promise<void> {
    // A degraded or failed run forces the transcript of its call (#4780),
    // whether or not usage is persisted.
    noteAiTranscriptRun(record.id, record.status);
    const usageConfig =
      this._aiUsageResolvedConfig ?? this.mergeAiUsageConfig(config.toJSON());
    if (!usageConfig.enabled || !usageConfig.persist || !this._db) return;
    try {
      await recordAiRun(this._db, {
        ...record,
        className: this._className,
        tenantId: this.currentTenantId() ?? null,
      });
    } catch (error) {
      logger.warn(
        `[smrt] AI run record failed for fusion ${record.fusionKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private observeRunUsage(
    runId: string,
    listener: (event: InferenceUsageObservation) => void,
  ): () => void {
    let listeners = this._aiRunUsageListeners.get(runId);
    if (!listeners) {
      listeners = new Set();
      this._aiRunUsageListeners.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this._aiRunUsageListeners.get(runId);
      current?.delete(listener);
      if (current && current.size === 0)
        this._aiRunUsageListeners.delete(runId);
    };
  }

  private notifyRunUsage(event: SmrtAiUsageEvent): void {
    const runId = event.tags?.runId;
    if (!runId) return;
    const listeners = this._aiRunUsageListeners.get(runId);
    if (!listeners) return;
    const observation: InferenceUsageObservation = {
      provider: event.provider,
      model: event.model,
      promptTokens: event.usage?.promptTokens ?? 0,
      completionTokens: event.usage?.completionTokens ?? 0,
      totalTokens: event.usage?.totalTokens ?? 0,
      ...(event.estimatedCost !== undefined
        ? { estimatedCost: event.estimatedCost }
        : {}),
      duration: event.duration,
      tags: { ...(event.tags ?? {}) },
    };
    for (const listener of listeners) {
      try {
        listener(observation);
      } catch {
        // An observer must never break usage handling.
      }
    }
  }

  /**
   * Record a zero-token usage row for an inference call that never answered
   * (#4752), through the same handlers SDK usage events reach. The executor
   * calls this once per exhausted call; it is not a second writer.
   */
  private async recordInferenceUsage(
    record: InferenceUsageRecord,
  ): Promise<void> {
    const usageConfig =
      this._aiUsageResolvedConfig ?? this.mergeAiUsageConfig(config.toJSON());
    const firstString = (...values: unknown[]): string | undefined =>
      values.find(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      );
    await this.handleAiUsageCallback(
      {
        // The configured client's identity fills an absent provider/model;
        // 'unknown' keeps the row when there is none, so an exhausted call
        // is never indistinguishable from an unlogged one.
        provider:
          record.provider ??
          firstString(
            this._aiClientConfig?.provider,
            this._aiClientConfig?.type,
          ) ??
          'unknown',
        model:
          record.model ??
          firstString(
            this._aiClientConfig?.model,
            this._aiClientConfig?.defaultModel,
          ) ??
          'unknown',
        operation: record.operation,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        duration: record.duration ?? 0,
        tags: record.tags,
      },
      this._aiClientConfig ?? {},
      usageConfig,
    );
  }

  /**
   * Resolve the AI client if one is configured, otherwise return undefined.
   */
  protected async getOptionalAiClient(): Promise<AIClient | undefined> {
    await this.ensureRuntimeServicesInitialized();
    return this.transcriptClient(this._ai);
  }

  /**
   * Resolve the optional typed-decision client without changing the generation
   * client used by `is()`, `do()`, or `describe()`. The SDK import stays inside
   * this opt-in path so ordinary SMRT applications neither load nor configure
   * the decision provider.
   */
  protected async getDecisionClient(): Promise<DecisionClient | undefined> {
    await this.ensureRuntimeServicesInitialized();

    if (this._decisionClient) return this._decisionClient;
    if (this._decisionClientInitPromise) {
      return this._decisionClientInitPromise;
    }

    this._decisionClientInitPromise = (async () => {
      const instanceDecision = this.options.decisions;
      if (
        instanceDecision &&
        typeof instanceDecision === 'object' &&
        typeof (instanceDecision as DecisionClient).decide === 'function'
      ) {
        this._decisionClient = instanceDecision as DecisionClient;
        return this._decisionClient;
      }

      const configuredDecision = this.getDecisionConfig();
      if (!configuredDecision) return undefined;
      if (configuredDecision.type !== 'typesafe') {
        throw new Error("Decision configuration requires type: 'typesafe'.");
      }

      // `getAI()` is deliberately dynamically imported, matching the existing
      // generation setup. The #1284 SDK adds `decide` as an optional interface
      // capability, so third-party/older clients remain source-compatible.
      const { getAI } = await importAI();
      this._decisionClient = (await getAI(
        configuredDecision as Parameters<typeof getAI>[0],
      )) as unknown as DecisionClient;
      return this._decisionClient;
    })();

    try {
      return await this._decisionClientInitPromise;
    } finally {
      this._decisionClientInitPromise = undefined;
    }
  }

  /**
   * Attempt one typed decision batch against caller-curated state.
   *
   * `undefined` is the explicit legacy-route signal: no decision client was
   * configured. Configured capability, provider, and response errors always
   * propagate. Object methods with registered tools must retain their
   * generation route and therefore do not call this helper.
   */
  protected async attemptDecision(
    request: DecisionRequest,
    options?: DecisionOptions,
  ): Promise<DecisionResult | undefined> {
    const decision = await this.getDecisionClient();
    if (!decision) return undefined;

    const { transcript, ...decisionOptions } = (options ?? {}) as
      | (DecisionOptions & { transcript?: boolean })
      | Record<string, never>;
    // One captured call (#4780): the decision request and its answers, with
    // the call's id on the usage row while transcripts are enabled.
    return captureAiTranscriptCall(
      this.aiTranscriptContext(),
      {
        operation: 'decision',
        request: [{ role: 'decision', content: request }],
        ...(typeof transcript === 'boolean' ? { transcript } : {}),
      },
      async (callId) => {
        const result = await executeDecision(
          decision,
          request,
          (options === undefined && transcript === undefined
            ? undefined
            : decisionOptions) as DecisionOptions | undefined,
        );
        await this.recordAiUsageEvent(
          {
            provider: result.provenance.provider,
            model: result.provenance.model,
            operation: 'decision',
            usage: result.usage,
            tags: { operation: 'decision', ...(callId ? { callId } : {}) },
          },
          result.provenance,
        );
        return result;
      },
    );
  }

  /** Resolve project, global, and instance decision options in that order. */
  protected getDecisionConfig(): DecisionConfig | undefined {
    const instanceDecision = this.options.decisions;
    const instanceConfig =
      instanceDecision &&
      typeof instanceDecision === 'object' &&
      typeof (instanceDecision as DecisionClient).decide !== 'function'
        ? (instanceDecision as Partial<DecisionConfig>)
        : undefined;
    const projectDecision = getSmrtModuleConfig<SmrtGlobalConfig>('smrt', {})
      .decisions as Partial<DecisionConfig> | undefined;
    const globalDecision = config.toJSON().decisions as
      | Partial<DecisionConfig>
      | undefined;
    const resolved = {
      ...projectDecision,
      ...globalDecision,
      ...instanceConfig,
    } as Partial<DecisionConfig>;
    return Object.keys(resolved).length === 0
      ? undefined
      : (resolved as DecisionConfig);
  }

  /**
   * Records an SDK operation through SMRT's established usage handlers. The
   * event carries provider/model/tokens only; prompts, object data, and secrets
   * never enter usage persistence or callbacks.
   */
  protected async recordAiUsageEvent(
    event: unknown,
    providerConfig: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureRuntimeServicesInitialized();
    await this.handleAiUsageCallback(
      event,
      providerConfig,
      this.mergeAiUsageConfig(config.toJSON()),
    );
  }

  /**
   * Return `aiConfig` with `onUsage` wired to this instance's usage pipeline,
   * for clients the instance does not build itself:
   * `getAI(this.withAiUsage(this.options.ai))`. The caller's own `onUsage`
   * runs first and is kept; wiring an already-wired config replaces the
   * previous sink, so a call is recorded once. Rows carry this class name and
   * the tenant from `options.tenantId`, else this instance's `tenantId`, else
   * the ambient tenant (`setAiUsageTenantResolver()`). An explicit
   * `options.tenantId` / `options.tags` travels with the config: another
   * instance that builds its client from it keeps them, and wiring a config
   * that already carries a sink keeps that sink's explicit tenant and tags
   * unless `options` sets its own. Recording failures
   * are logged and never reach the AI call (#3077).
   */
  withAiUsage<T extends object>(
    aiConfig: T,
    options: { tenantId?: string | null; tags?: Record<string, string> } = {},
  ): T & { onUsage: (event: unknown) => Promise<void> } {
    const providerConfig = aiConfig as Record<string, unknown>;
    // A sink already on the config keeps its explicit attribution unless
    // `options` names its own (#3077).
    const inherited = aiUsageSinkAttribution(
      (aiConfig as { onUsage?: unknown }).onUsage,
    );
    const attribution: AiUsageSinkAttribution = {
      tenantId:
        options.tenantId !== undefined ? options.tenantId : inherited?.tenantId,
      tags: options.tags ?? inherited?.tags,
    };
    const sink = brandAiUsageSink(async (event: unknown) => {
      try {
        await this.ensureRuntimeServicesInitialized();
        await this.handleAiUsageCallback(
          event,
          providerConfig,
          this._aiUsageResolvedConfig ??
            this.mergeAiUsageConfig(config.toJSON()),
          attribution,
        );
      } catch (error) {
        logger.warn(
          `[smrt] AI usage recording failed for ${this._className}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, attribution);
    return attachAiUsageRecorder(aiConfig, sink);
  }

  private async isSystemSchemaVersionApplied(
    db: DatabaseInterface,
    version: string,
  ): Promise<boolean> {
    const engine = detectEngine(getDatabaseUrl(db), this._dbEngineHint);

    if (
      engine === 'postgres' &&
      !(await tableExists(db, '_smrt_migrations', this._dbEngineHint))
    ) {
      return false;
    }

    try {
      const versionParam = engine === 'postgres' ? '$1' : '?';
      const rows = await db.query(
        `SELECT 1 FROM _smrt_migrations WHERE version = ${versionParam} LIMIT 1`,
        version,
      );
      return getQueryRows(rows).length > 0;
    } catch (error) {
      if (engine === 'postgres') {
        throw error;
      }

      return false;
    }
  }

  /**
   * Ensure SMRT system tables exist in the database
   *
   * System tables use the _smrt_ prefix and store framework metadata:
   * - _smrt_contexts: Context memory storage for remembered patterns
   * - _smrt_migrations: Schema version tracking
   * - _smrt_schema_migrations / _smrt_backfills: Migration and backfill ledgers
   * - _smrt_embeddings: Embedding vectors for semantic search
   * - _smrt_dispatch / _smrt_dispatch_subscriptions: Inter-agent dispatch queue
   * - _smrt_ai_usage: AI usage telemetry
   * - _smrt_changes: Append-only change feed
   *
   * Note that the _smrt_ prefix alone does NOT mean "system table" — ~25
   * `@smrt()` domain tables (feature flags, prompt overrides, subscription
   * plans, …) carry it too and are created by `db:migrate`, not here. The
   * framework's own list is `SYSTEM_TABLE_NAMES` in
   * `schema/system-table-shapes.ts`, derived from this DDL.
   *
   * This method is idempotent and safe to call multiple times.
   * Tables are only created once per database connection.
   */
  private async ensureSystemTables(): Promise<void> {
    if (!this._db) return;

    const dbUrl = getDatabaseUrl(this._db);

    // Some databases share URLs but are different instances:
    // - :memory: databases (SQLite/DuckDB in-memory)
    // - JSON databases (may have undefined or shared URLs)
    // - Any database with undefined URL
    // Use WeakSet for instance tracking, Set<string> for URL tracking
    const dbConstructorName = this._db.constructor?.name || '';
    const isMemoryDb = isPerConnectionMemoryUrl(dbUrl);
    const isJsonDb = dbConstructorName.toLowerCase().includes('json');
    const hasUndefinedUrl = !dbUrl;
    const useInstanceTracking = isMemoryDb || isJsonDb || hasUndefinedUrl;

    if (useInstanceTracking) {
      // Check WeakSet for databases that may share URLs (track by instance)
      if (SmrtClass._systemTablesInitialized.has(this._db)) {
        return;
      }
    } else {
      // Check Set<string> for URL-based databases (track by URL)
      if (SmrtClass._systemTablesInitializedByUrl.has(dbUrl)) {
        return;
      }
    }

    const db = this._db;
    const pending = SmrtClass._systemTablesInitializing.get(db);
    if (pending) return pending;

    // Share only an actual handle: another handle at the same URL may need
    // to wait for this caller's outer transaction to commit, not just for its
    // initialization statements. Database locks coordinate those handles.
    const initialization = (async () => {
      try {
        await ensureFrameworkSystemTables(db, this._dbEngineHint);
        await this.settleDeferredSystemTableCompatibility(db);
        await this.ensureNativeVectorStorage();

        if (useInstanceTracking) {
          SmrtClass._systemTablesInitialized.add(db);
        } else {
          SmrtClass._systemTablesInitializedByUrl.add(dbUrl);
        }
      } catch (error) {
        const dbInfo = db.constructor?.name || 'unknown database';
        throw new Error(
          `Failed to create system tables for ${dbInfo}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    })();
    SmrtClass._systemTablesInitializing.set(db, initialization);
    try {
      await initialization;
    } finally {
      SmrtClass._systemTablesInitializing.delete(db);
    }
  }

  /**
   * Run the compatibility pass for the system tables `db:migrate` creates, then
   * stamp its own marker in `_smrt_migrations` (issue #2376).
   *
   * Deliberately runs OUTSIDE the bootstrap lock/transaction, and deliberately
   * cannot fail startup:
   *
   * - `_smrt_jobs` / `_smrt_job_events` are created by `db:migrate` from the
   *   jobs manifest, which on a fresh install runs AFTER the framework's first
   *   bootstrap. Gating this pass on {@link SMRT_SCHEMA_VERSION} would mean the
   *   version gets stamped while the tables are still absent and the pass never
   *   runs on that database again. It therefore carries its own marker, which
   *   is written only once every deferred table exists and has been upgraded.
   * - Its statements are ALTER TABLE / CREATE INDEX against tables the
   *   framework does not own. Inside the PostgreSQL bootstrap transaction one
   *   failure (a permissions problem, say) would abort the transaction and roll
   *   back system-table creation with it. Outside, a failure is a logged
   *   warning and the next process start retries — the pass is idempotent and
   *   already tolerates concurrent creators.
   *
   * Until the tables exist this costs two catalog probes per process per
   * database; afterwards the marker short-circuits it.
   */
  private async settleDeferredSystemTableCompatibility(
    db: DatabaseInterface,
  ): Promise<void> {
    const marker = `${SMRT_SCHEMA_VERSION}${DEFERRED_COMPATIBILITY_VERSION_SUFFIX}`;

    try {
      if (await this.isSystemSchemaVersionApplied(db, marker)) {
        return;
      }

      const { settled } = await ensureDeferredSystemTableCompatibility(
        db,
        this._dbEngineHint,
      );
      if (!settled) {
        return;
      }

      const id = crypto.randomUUID();
      const description = 'Deferred SMRT system table compatibility';
      await db.execute`
        INSERT INTO _smrt_migrations (id, version, description)
        VALUES (${id}, ${marker}, ${description})
        ON CONFLICT(version) DO NOTHING
      `;
    } catch (error) {
      logger.warn(
        `[smrt] Deferred system table compatibility did not complete; retrying on the next start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async ensureNativeVectorStorage(): Promise<void> {
    if (!this._db) {
      return;
    }

    try {
      const { ObjectRegistry } = await import('./registry.js');
      const embeddingConfig = ObjectRegistry.getProjectEmbeddingConfig();
      if (embeddingConfig?.storage === 'native') {
        const { EmbeddingStorage } = await import('./embeddings/storage.js');
        const vector = this._db.vector;
        if (vector) {
          const dimensions = embeddingConfig.dimensions || 768;
          await EmbeddingStorage.ensureVectorStorage(
            this._db,
            dimensions,
            vector,
          );
        } else {
          logger.warn(
            '[smrt] Embedding storage set to "native" but database has no vector capability. Falling back to JSON storage.',
          );
        }
      }
    } catch (error) {
      // Don't fail system table initialization for vector setup errors
      logger.warn(
        `[smrt] Failed to initialize vector storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Access system tables through standard database interface
   * System tables use _smrt_ prefix to avoid conflicts with user tables
   */
  protected get systemDb(): DatabaseInterface {
    return this._db;
  }

  /**
   * Return the database engine hint captured from the caller's configuration.
   * Adapters may not expose their original type after construction (notably
   * in-memory DuckDB/JSON connections), so query helpers can combine this
   * hint with their public connection capabilities.
   */
  protected getDatabaseEngineHint(): string | undefined {
    return this._dbEngineHint;
  }

  /**
   * Initialize signal bus and adapters
   *
   * Merges global configuration with instance-specific overrides.
   * Registers built-in and custom adapters based on configuration.
   */
  private async initializeSignals(): Promise<void> {
    const globalConfig = config.toJSON();
    const effectiveConfig = this.mergeSignalConfig(globalConfig);

    // If a shared bus is provided, always use it (don't create new adapters)
    if (this.options.signals?.bus) {
      this._signalBus = this.options.signals.bus;
      return;
    }

    // Otherwise, check if we should initialize signals based on config
    if (!this.shouldInitializeSignals(effectiveConfig)) {
      return;
    }

    this._signalBus = new SignalBus({
      sanitization: effectiveConfig.sanitization,
    });
    await this.registerAdapters(effectiveConfig);
  }

  /**
   * Merge global and instance signal configuration
   *
   * Instance configuration takes priority over global defaults.
   *
   * @param globalConfig - Global configuration from smrt.configure()
   * @returns Merged configuration
   */
  private mergeSignalConfig(
    globalConfig: GlobalSignalConfig,
  ): GlobalSignalConfig {
    return {
      logging: this.options.logging ?? globalConfig.logging,
      metrics: this.options.metrics ?? globalConfig.metrics,
      pubsub: this.options.pubsub ?? globalConfig.pubsub,
      usage: this.mergeAiUsageConfig(globalConfig),
      sanitization: this.options.sanitization ?? globalConfig.sanitization,
      signals: {
        bus: this.options.signals?.bus ?? globalConfig.signals?.bus,
        adapters: [
          ...(globalConfig.signals?.adapters ?? []),
          ...(this.options.signals?.adapters ?? []),
        ],
      },
    };
  }

  /**
   * Check if signals should be initialized
   *
   * Signals are initialized if any adapter is configured.
   *
   * @param config - Effective signal configuration
   * @returns True if signals should be initialized
   */
  private shouldInitializeSignals(config: GlobalSignalConfig): boolean {
    return !!(
      config.logging !== false ||
      config.metrics?.enabled ||
      config.pubsub?.enabled ||
      config.signals?.adapters?.length
    );
  }

  /**
   * Register signal adapters based on configuration
   *
   * @param config - Effective signal configuration
   */
  private async registerAdapters(config: GlobalSignalConfig): Promise<void> {
    if (!this._signalBus) return;

    // Logging adapter (default: enabled with console)
    if (config.logging !== false) {
      const { createLogger, LoggerAdapter } = await import(
        '@happyvertical/logger'
      );
      const logging = config.logging ?? true;
      let logger: ReturnType<typeof createLogger>;
      if (logging === true) {
        const envLevel =
          typeof process === 'undefined'
            ? undefined
            : process.env?.HAVE_LOGGER_LEVEL;
        if (!defaultSignalLogger || defaultSignalLogger.envLevel !== envLevel)
          defaultSignalLogger = { envLevel, logger: createLogger(true) };
        logger = defaultSignalLogger.logger;
      } else {
        logger = createLogger(logging);
      }
      const adapter = new LoggerAdapter(logger);
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Metrics adapter (default: disabled)
    if (config.metrics?.enabled) {
      const { MetricsAdapter } = await import('./adapters/metrics.js');
      const adapter = new MetricsAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Pub/Sub adapter (default: disabled)
    if (config.pubsub?.enabled) {
      const { PubSubAdapter } = await import('./adapters/pubsub.js');
      const adapter = new PubSubAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Custom adapters
    if (config.signals?.adapters) {
      for (const adapter of config.signals.adapters) {
        this._signalBus.register(adapter);
        this._registeredAdapters.push(adapter);
      }
    }
  }

  /**
   * Gets the filesystem adapter instance
   */
  get fs() {
    return this._fs;
  }

  /**
   * Gets the database interface instance
   */
  get db() {
    // Throw helpful error if database is accessed before initialization
    if (!this._db) {
      throw new Error(
        `Database accessed before initialization. ` +
          `Please call await instance.initialize() before accessing the database.`,
      );
    }
    return this._db;
  }

  /**
   * Temporarily bind this initialized instance to another database interface.
   *
   * This is intended for transaction-scoped work where a caller must ensure
   * that every nested SMRT read and write uses the transaction database passed
   * to its callback. The original database is restored whether the callback
   * succeeds or throws. Do not use the same instance concurrently while it is
   * temporarily bound.
   */
  async withDatabase<T>(
    db: DatabaseInterface,
    operation: (bound: this) => Promise<T>,
  ): Promise<T> {
    // Read through the public getter so an uninitialized instance fails with
    // the normal, actionable SmrtClass error before any state is mutated.
    const previousDb = this.db;
    const previousOptionDb = this.options.db;
    // `db` is usually a transaction handle of `previousDb`, which carries no
    // adapter markers; identify the root before swapping it out (#3737).
    noteNativeDuckDbHandle(previousDb, this._dbEngineHint);
    this._db = db;
    this.options.db = db;
    try {
      return await operation(this);
    } finally {
      this._db = previousDb;
      this.options.db = previousOptionDb;
    }
  }

  /**
   * Gets the AI client instance
   */
  get ai() {
    return this.transcriptClient(this._ai);
  }

  /**
   * Get the in-memory AI usage snapshot for this instance.
   */
  getAiUsageSnapshot(): AiUsageSnapshot | undefined {
    return this._aiUsageCollector?.getSnapshot();
  }

  /**
   * Reset the in-memory AI usage collector.
   */
  resetAiUsage(): void {
    this._aiUsageCollector?.reset();
  }

  /**
   * List persisted AI usage records.
   */
  async listAiUsage(
    options: AiUsageListOptions = {},
  ): Promise<SmrtAiUsageRecord[]> {
    if (!this._db) {
      throw new Error(
        `AI usage requires a database configuration. ` +
          `Please call initialize() with a db option before querying usage.`,
      );
    }

    const { conditions, params } = buildAiUsageWhereClause(options);
    let paramIndex = params.length + 1;

    let sql = 'SELECT * FROM _smrt_ai_usage';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY ${
      options.orderBy === 'timestamp ASC' ? 'created_at ASC' : 'created_at DESC'
    }`;

    if (options.limit !== undefined) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const rows = getQueryRows(await this._db.query(sql, ...params));

    return rows.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      model: String(row.model),
      operation: String(row.operation),
      usage: hydratePersistedAiUsageTokens(row),
      estimatedCost:
        row.estimated_cost === null || row.estimated_cost === undefined
          ? undefined
          : Number(row.estimated_cost),
      duration: toSafeInteger(row.duration ?? 0, 'AI usage duration'),
      className:
        row.class_name === null || row.class_name === undefined
          ? undefined
          : String(row.class_name),
      tenantId:
        row.tenant_id === undefined
          ? undefined
          : (row.tenant_id as string | null),
      tags: parseAiUsageTags(row.tags),
      timestamp: normalizeAiUsageTimestamp(row.created_at),
      ...optionalAiUsageColumn('promptKey', row.prompt_key),
      ...optionalAiUsageColumn('tierRequested', row.tier_requested),
      ...optionalAiUsageColumn('tierResolved', row.tier_resolved),
      ...optionalAiUsageColumn('runId', row.run_id),
    }));
  }

  /**
   * Summarize persisted AI usage records by a grouping dimension.
   */
  async summarizeAiUsage(
    options: AiUsageSummaryOptions = {},
  ): Promise<Record<string, AiUsageStats>> {
    if (!this._db) {
      throw new Error(
        `AI usage requires a database configuration. ` +
          `Please call initialize() with a db option before querying usage.`,
      );
    }

    const groupBy = options.groupBy ?? 'model';
    const bucketExpression =
      groupBy === 'provider'
        ? `provider`
        : groupBy === 'model'
          ? `provider || ':' || model`
          : groupBy === 'class'
            ? `COALESCE(class_name, 'unknown')`
            : groupBy === 'tenant'
              ? `COALESCE(tenant_id, 'global')`
              : groupBy === 'operation'
                ? `operation`
                : groupBy === 'prompt'
                  ? `COALESCE(prompt_key, 'unattributed')`
                  : groupBy === 'tier'
                    ? `COALESCE(tier_resolved, tier_requested, 'untiered')`
                    : `substr(CAST(created_at AS TEXT), 1, 10)`;

    const { conditions, params } = buildAiUsageWhereClause(options);

    let sql = `
      SELECT ${bucketExpression} AS bucket,
             COUNT(*) AS call_count,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(duration), 0) AS total_duration,
             COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
             MAX(created_at) AS last_used
      FROM _smrt_ai_usage
    `;

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' GROUP BY bucket ORDER BY bucket ASC';

    const rows = getQueryRows(await this._db.query(sql, ...params));
    const summary: Record<string, AiUsageStats> = {};

    for (const row of rows) {
      const bucket = String(row.bucket);
      summary[bucket] = {
        callCount: toSafeInteger(row.call_count ?? 0, 'AI usage call count'),
        promptTokens: toSafeInteger(
          row.prompt_tokens ?? 0,
          'AI usage prompt-token total',
        ),
        completionTokens: toSafeInteger(
          row.completion_tokens ?? 0,
          'AI usage completion-token total',
        ),
        totalTokens: toSafeInteger(
          row.total_tokens ?? 0,
          'AI usage token total',
        ),
        totalDuration: toSafeInteger(
          row.total_duration ?? 0,
          'AI usage duration total',
        ),
        estimatedCost: Number(row.estimated_cost ?? 0),
        lastUsed: row.last_used ? new Date(String(row.last_used)).getTime() : 0,
      };
    }

    return summary;
  }

  /**
   * Gets the signal bus instance
   *
   * @returns Signal bus if signals are enabled, undefined otherwise
   */
  get signalBus(): SignalBus | undefined {
    return this._signalBus;
  }

  /**
   * Cleanup method to prevent memory leaks
   *
   * Unregisters all adapters from the signal bus that were registered
   * by this instance. Call this when the SmrtClass instance is no longer
   * needed to prevent memory leaks.
   *
   * @example
   * ```typescript
   * const product = new Product({ name: 'Widget' });
   * await product.initialize();
   * // ... use product ...
   * product.destroy(); // Clean up when done
   * ```
   */
  destroy(): void {
    // Only unregister adapters if we own the bus (not shared)
    if (this._signalBus && !this.options.signals?.bus) {
      for (const adapter of this._registeredAdapters) {
        this._signalBus.unregister(adapter);
      }
      this._registeredAdapters = [];
    }

    // TODO: If SmrtClass grows a broader async teardown lifecycle, move
    // AI usage handler cleanup there alongside other connection-bound state.
    this._aiUsageCollector = undefined;
    this._aiUsageHandlers = [];
  }

  private mergeAiUsageConfig(
    globalConfig: GlobalSignalConfig,
  ): ResolvedAiUsageConfig {
    return resolveAiUsageConfig(globalConfig.usage, this.options.usage);
  }

  private initializeAiUsageHandlers(config: ResolvedAiUsageConfig): void {
    this._aiUsageCollector = undefined;
    this._aiUsageHandlers = [];

    if (!config.enabled) {
      return;
    }

    this._aiUsageCollector = new AiUsageCollector();
    this._aiUsageHandlers.push(this._aiUsageCollector);

    if (config.persist && this._db) {
      this._aiUsageHandlers.push(new AiUsagePersistenceHandler(this._db));
    }

    this._aiUsageHandlers.push(...config.handlers);
  }

  private async handleAiUsageCallback(
    event: unknown,
    aiConfig: Record<string, unknown>,
    usageConfig: ResolvedAiUsageConfig,
    overrides: AiUsageSinkAttribution = {},
  ): Promise<void> {
    // Transcript capture (#4780) reads substitutions and run ids off the
    // raw event first, whatever the usage config says.
    observeAiTranscriptUsage(event);
    const observed = this._aiRunUsageListeners.size > 0;
    if (
      !usageConfig.enabled ||
      (this._aiUsageHandlers.length === 0 && !observed)
    ) {
      return;
    }

    const instanceTenantId =
      'tenantId' in this &&
      (this as { tenantId?: string | null }).tenantId !== undefined
        ? ((this as { tenantId?: string | null }).tenantId ?? null)
        : undefined;
    const normalizedEvent = normalizeAiUsageEvent(event, aiConfig, {
      className: this._className,
      tenantId: resolveAiUsageTenantId(overrides.tenantId, instanceTenantId),
      tags: overrides.tags,
    });
    if (!normalizedEvent) {
      return;
    }

    if (observed) {
      // Fusion run observers (#4753) see the event with its estimated cost;
      // dispatch below computes the same estimate for the handlers.
      if (usageConfig.estimateCosts) {
        normalizedEvent.estimatedCost = estimateAiUsageCost(
          normalizedEvent.provider,
          normalizedEvent.model,
          normalizedEvent.usage,
          usageConfig.costRates,
        );
      }
      this.notifyRunUsage(normalizedEvent);
    }

    await dispatchAiUsageEvent(
      normalizedEvent,
      this._aiUsageHandlers,
      usageConfig,
    );
  }
}
