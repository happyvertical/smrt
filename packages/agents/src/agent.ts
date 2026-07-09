import type { AIClientOptions } from '@happyvertical/ai';
import { createLogger, type Logger } from '@happyvertical/logger';
import { sanitizeConfig } from '@happyvertical/smrt-config';
import {
  type ConfigResolver,
  createDispatchBus,
  type DispatchBus,
  type DispatchMetadata,
  type DispatchTenantScope,
  type LearningEpisode,
  LearningMemory,
  type LearningMemoryRecord,
  type LearningOutcome,
  type LearningSemanticSearch,
  ObjectRegistry,
  resolveDispatchTenantScope,
  type SmrtCollection,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import { type AgentAIOptions, resolveAgentAIOptions } from './ai-config.js';
import { AgentConfig } from './config.js';
import {
  getAgentClassName as resolveAgentClassName,
  getAgentTypeName as resolveAgentTypeName,
} from './identity.js';
import type {
  AgentWithInterestsOptions,
  InterestFilter,
  InterestOptions,
  InterestResult,
  ObjectInterestConfig,
} from './interests.js';
import { mergeFilters, normalizeSort } from './interests.js';
import {
  type AgentLearningDeclaration,
  resolveAgentLearning,
} from './learning.js';
import type { AgentStatusType } from './types.js';
import type { AgentAdminRoute, AgentUISlots } from './ui.js';

/**
 * Agent constructor options
 */
export interface AgentOptions
  extends SmrtObjectOptions,
    AgentWithInterestsOptions {
  /**
   * Optional AI configuration for this agent.
   *
   * When `apiKey` is omitted, the runtime can resolve provider credentials from
   * tenant secrets based on the active tenant context.
   */
  ai?: AgentAIOptions;
  /**
   * Suppress all log output (useful for CLI --json mode)
   * When true, creates a no-op logger that discards all messages
   */
  silent?: boolean;
  /**
   * Opt into process-level SIGTERM/SIGINT handling for this instance.
   *
   * Host runtimes should generally own process lifecycle; this remains available
   * for single-agent CLIs and scripts that explicitly want it. Do not enable
   * this for multiple agents in the same process unless the host coordinates
   * shutdown itself; the first handler to finish exits the process.
   */
  manageProcessSignals?: boolean;
}

/**
 * Base Agent class for building autonomous actors in the SMRT ecosystem
 *
 * Agents are SmrtObjects that perform specific tasks with:
 * - Status tracking (idle, initializing, running, error, shutdown)
 * - Configuration management via @have/config
 * - Structured logging via @happyvertical/logger
 * - Lifecycle hooks (initialize, validate, run, shutdown)
 * - Optional process signal handling for graceful shutdown
 *
 * Agents can define their own properties for state management - since they extend
 * SmrtObject, any properties defined will be automatically persisted to the database.
 *
 * **Important**: Extending classes must add the `@smrt()` decorator themselves
 * to configure CLI/API/MCP exposure.
 *
 * @example
 * ```typescript
 * import { Agent } from '@have/agents';
 * import { getModuleConfig } from '@have/config';
 * import { smrt } from '@happyvertical/smrt-core';
 *
 * @smrt()
 * class MyAgent extends Agent {
 *   protected config = getModuleConfig('my-agent', {
 *     cronSchedule: '0 2 * * *',
 *     maxRetries: 3
 *   });
 *
 *   // Define your own state properties (automatically persisted)
 *   lastCrawl: Date | null = null;
 *   itemsProcessed: number = 0;
 *
 *   async validate(): Promise<void> {
 *     if (!this.config.cronSchedule) {
 *       throw new Error('cronSchedule is required');
 *     }
 *   }
 *
 *   async run(): Promise<void> {
 *     // Agent logic here
 *     this.itemsProcessed = 42;
 *     this.lastCrawl = new Date();
 *     await this.save(); // Persist state
 *   }
 * }
 *
 * const agent = new MyAgent({ name: 'my-agent' });
 * await agent.execute();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  // Abstract class - no direct CLI/API/MCP exposure
  // But must be registered for inheritance chain to work (issue #523)
  cli: false,
  api: false,
  mcp: false,
  // STI: All agents share 'agents' table for polymorphic queries
  tableStrategy: 'sti',
})
export abstract class Agent extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global agents
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * UI slots this agent supports for admin panels
   *
   * Subclasses override this to declare their admin UI slots.
   * Each slot can be implemented by a Svelte component.
   *
   * @example
   * ```typescript
   * static override uiSlots: AgentUISlots = {
   *   sources: {
   *     id: 'sources',
   *     label: 'News Sources',
   *     description: 'Configure scrapers and data sources',
   *     icon: 'database',
   *     order: 1,
   *   },
   *   settings: {
   *     id: 'settings',
   *     label: 'Agent Settings',
   *     description: 'Configure agent behavior',
   *     icon: 'settings',
   *     order: 2,
   *   },
   * };
   * ```
   */
  static uiSlots: AgentUISlots = {};

  /**
   * Admin routes this agent provides
   *
   * Subclasses override this to declare admin route metadata.
   * The vitePluginAgentRoutes Vite plugin reads these from the manifest
   * and registers them so host applications can discover and render them.
   *
   * @example
   * ```typescript
   * static override adminRoutes: AgentAdminRoute[] = [
   *   { path: 'sources', component: 'SourcesPanel', load: 'loadSources' },
   *   { path: 'sources/[sourceId]', component: 'SourceDetail', load: 'loadSourceDetail' },
   * ];
   * ```
   */
  static adminRoutes: AgentAdminRoute[] = [];

  /**
   * Signal types this agent subscribes to by default
   *
   * These are seedable defaults — on `initialize()`, the agent checks the
   * database first and only creates subscriptions that don't already exist.
   * The database is the runtime source of truth, allowing users to customize
   * subscriptions per-tenant via the dashboard without code changes.
   *
   * When declared, `execute()` will automatically call `processDispatches()`
   * before `run()`, so handler agents don't need to manually poll.
   * Override `handleDispatch()` to process incoming dispatches.
   *
   * @example
   * ```typescript
   * @smrt({ agent: { icon: 'mail', tier: 'standard' } })
   * class EmailHandler extends Agent {
   *   static override signalSubscriptions = ['email.received', 'email.bounced'];
   *
   *   async handleDispatch(payload: unknown, metadata: DispatchMetadata) {
   *     // Called automatically during execute() for each pending dispatch
   *   }
   *
   *   async run() { ... }
   * }
   * ```
   */
  static signalSubscriptions: string[] = [];

  /**
   * Execute-time resolvers for `agent_config` fields that should be computed
   * lazily rather than snapshotted at sync time.
   *
   * Each entry is keyed by the agent_config field it produces. The runtime
   * (see {@link resolveLazyConfig}) calls every resolver and overlays the
   * results on top of the persisted config before constructing the agent.
   * That means env-derived values like asset storage paths, S3 buckets, AI
   * provider keys, or tenant-scoped DB URLs stay live: rotating an env var
   * is reflected on the next scheduled run without rewriting the schedule
   * row.
   *
   * Resolvers may be sync or async. Returning `undefined` or `null` leaves
   * the persisted value in place — both are treated as "no overlay" so the
   * common `() => process.env.X ?? null` pattern is safe and won't clobber
   * a snapshotted value when the env var is unset. Throwing falls back to
   * the persisted value (or to whatever
   * {@link ResolveLazyConfigOptions.onError} dictates).
   *
   * @example
   * ```typescript
   * class Praeco extends Agent {
   *   static override configResolvers = {
   *     assetStorage: () => resolveSharedAssetStorage(),
   *     aiKey: async () => loadAIKeyFromSecretsManager(),
   *   };
   * }
   * ```
   */
  static configResolvers: Record<string, ConfigResolver> = {};

  /**
   * Opt-in learning trait declaration (#1886).
   *
   * **Off by default.** Set to `true` (or a config object) on a subclass to
   * wire a confidence-scored recall-before / capture-after loop into the agent
   * lifecycle, backed by {@link LearningMemory}. A non-opted agent behaves
   * byte-for-byte as it does today — the learning branches are never entered.
   *
   * When enabled, `execute()`:
   * 1. recalls confident memories for {@link learningScope} before `run()`,
   *    exposing them via {@link recalledMemories};
   * 2. captures the run outcome after `run()` — a clean completion reinforces
   *    the staged memory (see {@link stageLearning}); a thrown error or an
   *    explicit {@link reportLearningOutcome} failure decays it.
   *
   * @example
   * ```typescript
   * @smrt()
   * class InvoiceAgent extends Agent {
   *   static override learning = true; // reuse floor 0.7, success 0.9, fail 0.3
   *   // or: static override learning = { minConfidence: 0.8, scope: 'invoices' };
   *   protected config = {};
   *   async run() {
   *     const [cached] = this.recalledMemories;
   *     const strategy = cached?.value ?? (await this.generateStrategy());
   *     this.stageLearning({ scope: this.learningScope(), key: 'default', value: strategy });
   *   }
   * }
   * ```
   */
  static learning: AgentLearningDeclaration = false;

  /**
   * Current agent status
   */
  status: AgentStatusType = 'idle';

  /**
   * Structured logger instance
   * Created with agent's class name as context
   */
  protected logger: Logger;

  /**
   * Agent configuration
   * Must be defined by extending classes using getModuleConfig()
   *
   * @example
   * ```typescript
   * protected config = getModuleConfig('my-agent', {
   *   cronSchedule: '0 0 * * *',
   *   maxRetries: 3
   * });
   * ```
   */
  protected abstract config: unknown;

  /**
   * Signal handlers for graceful shutdown
   */
  private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();

  /**
   * Cached DispatchBus instance for inter-agent communication
   */
  private _dispatch: DispatchBus | null = null;

  /**
   * Cached LearningMemory binding. `undefined` = not yet resolved,
   * `null` = learning disabled (resolved once, cheaply).
   */
  private _learningMemory?: LearningMemory | null;

  /**
   * The episode the current run acted on, staged via {@link stageLearning} so
   * the lifecycle can reinforce it after `run()`.
   */
  private _learningEpisode: LearningEpisode | null = null;

  /**
   * Explicit outcome for the current run, set via
   * {@link reportLearningOutcome}. When unset, a clean `run()` is treated as a
   * success and a thrown error as a failure.
   */
  private _learningOutcome: LearningOutcome | null = null;

  /**
   * Memories recalled before `run()` when the learning trait is enabled.
   *
   * Empty for non-opted agents. Populated by the lifecycle (see
   * {@link recallForRun}); read from `run()` to reuse prior knowledge.
   */
  protected recalledMemories: LearningMemoryRecord[] = [];

  /**
   * Creates a new Agent instance
   *
   * @param options - Configuration options including identifiers and metadata
   */
  constructor(options: AgentOptions = {}) {
    super(options);
    // Use no-op logger in silent mode (for CLI --json output)
    this.logger = createLogger(options.silent ? false : { level: 'info' });
  }

  /**
   * Interest configuration for this agent
   * Lazily accessed from options on first interesting() call
   */
  protected get interests(): InterestOptions | undefined {
    return (this.options as AgentOptions).interests;
  }

  /**
   * Canonical agent type for persistence and dispatch routing.
   */
  protected getAgentTypeName(): string {
    const metaType = (this as { _meta_type?: unknown })._meta_type;
    if (typeof metaType === 'string' && metaType.length > 0) {
      return resolveAgentTypeName(metaType);
    }

    return resolveAgentTypeName(this.constructor.name);
  }

  /**
   * Human-readable class name for logs and UI.
   */
  protected getAgentClassName(): string {
    return resolveAgentClassName(this.getAgentTypeName());
  }

  /**
   * Get UI slot definitions for this agent instance
   *
   * Returns the static uiSlots defined on the agent's class.
   * Used by host applications to discover available admin panels.
   *
   * @example
   * ```typescript
   * const slots = agent.getUISlots();
   * for (const [slotId, slot] of Object.entries(slots)) {
   *   console.log(`${slot.label}: ${slot.description}`);
   * }
   * ```
   */
  getUISlots(): AgentUISlots {
    return (this.constructor as typeof Agent).uiSlots;
  }

  // ============================================================================
  // Configuration Management
  // ============================================================================

  /**
   * Load all database-persisted configs for this agent
   *
   * Returns a Map of slotId → configData for all saved configurations.
   * Use getMergedConfig() to get file + db merged config for a slot.
   *
   * @returns Map of slotId to config data
   *
   * @example
   * ```typescript
   * const configs = await agent.loadConfigs();
   * const sources = configs.get('sources');
   * ```
   */
  async loadConfigs(): Promise<Map<string, Record<string, unknown>>> {
    if (!this.id) {
      throw new Error('Agent must be saved before loading configs');
    }
    return AgentConfig.forAgent(this.id, this.options);
  }

  /**
   * Save config for a specific UI slot to the database
   *
   * Persists configuration data that can be modified by admin panels.
   * Use this when the user saves changes in an admin UI.
   *
   * @param slotId - The UI slot ID (e.g., 'sources', 'settings')
   * @param data - Configuration data to save
   *
   * @example
   * ```typescript
   * await agent.saveSlotConfig('sources', {
   *   scrapers: ['civicweb', 'govstack'],
   *   refreshInterval: 3600
   * });
   * ```
   */
  async saveSlotConfig(
    slotId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.id) {
      throw new Error('Agent must be saved before saving slot config');
    }
    await AgentConfig.saveSlot(
      {
        agentId: this.id,
        agentClass: this.getAgentTypeName(),
        slotId,
        configData: data,
      },
      this.options,
    );
  }

  /**
   * Get merged config for a slot (file-based + database)
   *
   * Priority order (highest to lowest):
   * 1. Database-persisted config (from saveSlotConfig)
   * 2. File-based config (from getModuleConfig)
   * 3. Agent class defaults
   *
   * @param slotId - The UI slot ID
   * @returns Merged configuration object
   *
   * @example
   * ```typescript
   * const sourcesConfig = await agent.getMergedConfig('sources');
   * // Returns file config merged with any db overrides
   * ```
   */
  async getMergedConfig(slotId: string): Promise<Record<string, unknown>> {
    // Get file-based config from module config
    const fileConfig =
      ((this.config as Record<string, unknown>)?.[slotId] as
        | Record<string, unknown>
        | undefined) ?? {};

    if (!this.id) {
      return fileConfig;
    }

    // Get db-persisted config
    const dbConfig = await AgentConfig.forSlot(this.id, slotId, this.options);

    // Merge: db overrides file
    return { ...fileConfig, ...(dbConfig ?? {}) };
  }

  /**
   * Export all config for this agent (for static site generation)
   *
   * Merges file-based and database configs, then optionally sanitizes
   * to remove secrets. Use this before building a static site.
   *
   * @param options - Export options
   * @param options.includeSecrets - If true, includes API keys and secrets (default: false)
   * @returns Merged configuration object
   *
   * @example
   * ```typescript
   * // Export for static build (secrets filtered)
   * const config = await agent.exportConfig();
   *
   * // Export with secrets (for secure environments)
   * const fullConfig = await agent.exportConfig({ includeSecrets: true });
   * ```
   */
  async exportConfig(options?: {
    includeSecrets?: boolean;
  }): Promise<Record<string, unknown>> {
    const dbConfigs = await this.loadConfigs();
    const fileConfig = (this.config as Record<string, unknown>) ?? {};

    // Merge all configs
    const merged: Record<string, unknown> = { ...fileConfig };
    for (const [slotId, data] of dbConfigs) {
      merged[slotId] = {
        ...(merged[slotId] as Record<string, unknown> | undefined),
        ...data,
      };
    }

    // Sanitize if secrets not included (uses centralized sanitizeConfig from smrt-config)
    if (!options?.includeSecrets) {
      return sanitizeConfig(merged) as Record<string, unknown>;
    }

    return merged;
  }

  /**
   * Get the DispatchBus for inter-agent communication
   *
   * Creates a DispatchBus lazily on first access. Requires database configuration.
   *
   * @example
   * ```typescript
   * // Emit a dispatch to other agents
   * await this.dispatch.emit('campaign.completed', {
   *   campaignId: '123',
   *   revenue: 5000
   * }, { source: this.constructor.name });
   *
   * // Subscribe to dispatches
   * await this.dispatch.subscribe({
   *   signalType: 'campaign.*',
   *   subscriber: this.constructor.name
   * });
   * ```
   *
   * @throws Error if database is not configured
   */
  async getDispatch(): Promise<DispatchBus> {
    if (!this._dispatch) {
      if (!this._db) {
        throw new Error(
          `Agent ${this.constructor.name} requires database configuration for dispatch. ` +
            `Ensure the agent is initialized with a db option.`,
        );
      }
      this._dispatch = await createDispatchBus({
        db: this._db,
      });
    }
    return this._dispatch;
  }

  /**
   * Handle incoming dispatches
   *
   * Override this method to process dispatches targeted at this agent.
   * Called when process() is invoked for this agent's subscriber name.
   *
   * @param payload - Dispatch payload data
   * @param metadata - Dispatch metadata including type, source, and timing
   *
   * @example
   * ```typescript
   * async handleDispatch(payload: unknown, metadata: DispatchMetadata): Promise<void> {
   *   if (metadata.type === 'campaign.completed') {
   *     const data = payload as { campaignId: string; revenue: number };
   *     await this.recordRevenue(data.campaignId, data.revenue);
   *   }
   * }
   * ```
   */
  async handleDispatch(
    _payload: unknown,
    _metadata: DispatchMetadata,
  ): Promise<void> {
    // Default implementation does nothing
    // Subclasses should override to process dispatches
  }

  /**
   * Process pending dispatches for this agent
   *
   * Finds and processes all pending dispatches that match this agent's subscriptions.
   * Uses handleDispatch() to process each dispatch.
   *
   * @returns Number of dispatches processed
   *
   * @example
   * ```typescript
   * // In your run() method
   * const processed = await this.processDispatches();
   * this.logger.info(`Processed ${processed} dispatches`);
   * ```
   */
  async processDispatches(): Promise<number> {
    const dispatch = await this.getDispatch();
    return dispatch.process(
      this.getAgentTypeName(),
      this.handleDispatch.bind(this),
    );
  }

  // ============================================================================
  // Learning Trait (#1886) — opt-in; inert unless `static learning` is set
  // ============================================================================

  /**
   * Base memory scope for this agent's learning.
   *
   * Defaults to the configured `scope` (if any) or `agent/<agentType>`.
   * Override to shape how memories are filed (e.g. per task type). Recall and
   * capture are additionally isolated by the agent instance id (owner), so
   * memory never bleeds across tenants running the same agent class.
   */
  protected learningScope(): string {
    const resolved = resolveAgentLearning(
      (this.constructor as typeof Agent).learning,
    );
    return resolved.scope ?? `agent/${this.getAgentTypeName()}`;
  }

  /**
   * Optional semantic-search arm for {@link LearningMemory}.
   *
   * Returns `undefined` by default (keyed-context recall only). Override to
   * wire embedding search — e.g. return a bound `collection.semanticSearch`.
   */
  protected getLearningSemanticSearch(): LearningSemanticSearch | undefined {
    return undefined;
  }

  /**
   * Resolve the tenant id used for the learning scope and semantic filtering.
   */
  private resolveLearningTenantId(): string | null {
    const contextTenant = getCurrentTenant()?.tenantId;
    if (typeof contextTenant === 'string') return contextTenant;
    return typeof this.tenantId === 'string' ? this.tenantId : null;
  }

  /**
   * Get this agent's {@link LearningMemory} binding, or `null` when learning is
   * disabled or no database is configured.
   *
   * Cheap and side-effect-free when the trait is off (returns `null` after a
   * single static-flag check), which keeps non-opted agents unchanged.
   */
  getLearningMemory(): LearningMemory | null {
    if (this._learningMemory !== undefined) {
      return this._learningMemory;
    }

    const resolved = resolveAgentLearning(
      (this.constructor as typeof Agent).learning,
    );
    if (!resolved.enabled || !this._db) {
      this._learningMemory = null;
      return null;
    }

    // Ensure a stable owner id so memory is bound to this instance.
    if (!this.id) {
      this.id = crypto.randomUUID();
    }

    this._learningMemory = new LearningMemory({
      db: this.systemDb,
      ownerClass: this.getAgentTypeName(),
      ownerId: this.id as string,
      tenantId: this.resolveLearningTenantId(),
      semanticSearch: this.getLearningSemanticSearch(),
      config: resolved.memoryConfig,
    });
    return this._learningMemory;
  }

  /**
   * Recall relevant memories before `run()`.
   *
   * Default: a scope-wide, confidence-filtered recall of {@link learningScope}.
   * Override to shape the recall (e.g. a keyed lookup or a semantic query).
   */
  protected async recallForRun(
    memory: LearningMemory,
  ): Promise<LearningMemoryRecord[]> {
    return memory.recall(this.learningScope());
  }

  /**
   * Capture the run outcome after `run()`.
   *
   * Default: reinforce the memory staged via {@link stageLearning}. A no-op
   * when nothing was staged. Override for bespoke capture logic.
   */
  protected async captureForRun(
    memory: LearningMemory,
    outcome: LearningOutcome,
  ): Promise<void> {
    if (!this._learningEpisode) return;
    await memory.capture(this._learningEpisode, outcome);
  }

  /**
   * Stage the memory episode the current run acted on, so the lifecycle
   * reinforces it after `run()` completes. Call from `run()`.
   */
  protected stageLearning(episode: LearningEpisode): void {
    this._learningEpisode = episode;
  }

  /**
   * Report an explicit outcome for the current run (e.g. a validated failure
   * that did not throw). Overrides the default success/throw inference.
   */
  protected reportLearningOutcome(outcome: LearningOutcome): void {
    this._learningOutcome = outcome;
  }

  /**
   * Initialize the agent
   * Sets status to 'initializing' and sets up signal handlers
   *
   * Override to perform setup after construction, but always call super.initialize()
   *
   * @example
   * ```typescript
   * async initialize(): Promise<void> {
   *   await super.initialize();
   *   // Custom initialization logic
   * }
   * ```
   */
  async initialize(): Promise<this> {
    await super.initialize();
    this.status = 'initializing';
    this.logger.info('Agent initializing');

    const fileAiConfig =
      typeof this.config === 'object' &&
      this.config !== null &&
      'ai' in (this.config as Record<string, unknown>) &&
      typeof (this.config as Record<string, unknown>).ai === 'object' &&
      (this.config as Record<string, unknown>).ai !== null
        ? ((this.config as Record<string, unknown>).ai as AgentAIOptions)
        : undefined;
    const configuredAi =
      ((this.options as AgentOptions).ai as AgentAIOptions | undefined) ??
      fileAiConfig;
    if (configuredAi && this._db) {
      const resolvedAi = await resolveAgentAIOptions({
        aiConfig: configuredAi,
        db: this._db,
        tenantId:
          getCurrentTenant()?.tenantId ||
          (typeof this.tenantId === 'string' ? this.tenantId : undefined),
      });
      if (resolvedAi) {
        (this.options as AgentOptions).ai = resolvedAi as AIClientOptions &
          Record<string, unknown>;
      }
    }

    if ((this.options as AgentOptions).manageProcessSignals) {
      this.setupSignalHandlers();
    }

    // Seed declarative signal subscriptions (DB is source of truth)
    if (this._db) {
      const dispatch = await this.getDispatch();
      await this.migrateLegacyDispatchSubscriptions(dispatch);

      const subs = (this.constructor as typeof Agent).signalSubscriptions;
      if (subs.length > 0) {
        const subscriber = this.getAgentTypeName();
        const existing = await dispatch.listSubscriptions(subscriber);
        const existingTypes = new Set(existing.map((s) => s.signalType));
        for (const signalType of subs) {
          if (!existingTypes.has(signalType)) {
            await dispatch.subscribe({
              signalType,
              subscriber,
            });
          }
        }
      }
    }

    return this;
  }

  /**
   * Set up signal handlers for graceful shutdown
   * Handles SIGTERM and SIGINT for single-agent processes that explicitly opt in.
   */
  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

    for (const signal of signals) {
      const handler = () => {
        this.logger.info(`Received ${signal}, shutting down gracefully`);
        this.shutdown()
          .then(() => {
            process.exit(0);
          })
          .catch((error) => {
            this.logger.error('Error during shutdown', { error });
            process.exit(1);
          });
      };

      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  /**
   * Migrate legacy simple-name dispatch subscribers to the canonical agent type.
   *
   * Older releases used `this.constructor.name` directly for subscriber IDs.
   * That collides across packages and leaves fan-out dispatches targeted at the
   * wrong subscriber once qualified names are available.
   */
  private async migrateLegacyDispatchSubscriptions(
    dispatch: DispatchBus,
  ): Promise<void> {
    if (!this._db) {
      return;
    }

    const legacySubscriber = this.constructor.name;
    const canonicalSubscriber = this.getAgentTypeName();

    if (legacySubscriber === canonicalSubscriber) {
      return;
    }

    const legacySubscriptions =
      await dispatch.listSubscriptions(legacySubscriber);
    if (legacySubscriptions.length === 0) {
      return;
    }

    const currentSubscriptions =
      await dispatch.listSubscriptions(canonicalSubscriber);
    const currentSignalTypes = new Set(
      currentSubscriptions.map((sub) => sub.signalType),
    );

    for (const subscription of legacySubscriptions) {
      if (!currentSignalTypes.has(subscription.signalType)) {
        await dispatch.subscribe({
          signalType: subscription.signalType,
          subscriber: canonicalSubscriber,
          handler: subscription.handler,
          delivery: subscription.delivery,
          enabled: subscription.enabled,
        });
      }

      await dispatch.unsubscribe(subscription.signalType, legacySubscriber);
    }

    // Tenant isolation (S5 #1398): the bus's subscribe/unsubscribe calls above
    // are tenant-scoped server-side, but this raw UPDATE reaches around the bus
    // directly into `_smrt_dispatch`. Without a tenant predicate it would
    // rewrite the target/processor of EVERY tenant's dispatch rows matching the
    // legacy subscriber name, letting an agent under one tenant retarget another
    // tenant's pending dispatches. Derive the active scope server-side (never
    // from caller input) and restrict the UPDATE to the rows the bus would let
    // this scope read/claim.
    const [tenantClause, tenantParams] = buildDispatchTenantUpdatePredicate(
      resolveDispatchTenantScope(),
    );

    await this._db.query(
      `UPDATE _smrt_dispatch
       SET target_subscriber = CASE
             WHEN target_subscriber = ? THEN ?
             ELSE target_subscriber
           END,
           processed_by = CASE
             WHEN processed_by = ? THEN ?
             ELSE processed_by
           END
       WHERE (target_subscriber = ? OR processed_by = ?)${tenantClause}`,
      legacySubscriber,
      canonicalSubscriber,
      legacySubscriber,
      canonicalSubscriber,
      legacySubscriber,
      legacySubscriber,
      ...tenantParams,
    );
  }

  /**
   * Clean up signal handlers
   */
  private cleanupSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers.entries()) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
  }

  /**
   * Validate configuration and dependencies
   * Override to check agent-specific requirements
   *
   * @throws Error if validation fails
   *
   * @example
   * ```typescript
   * async validate(): Promise<void> {
   *   if (!this.config.apiKey) {
   *     throw new Error('API key is required');
   *   }
   * }
   * ```
   */
  async validate(): Promise<void> {
    this.logger.info('Validating agent configuration');
    // Base implementation - extending agents should override
  }

  /**
   * Main agent logic
   * Must be implemented by extending class
   *
   * Update this.lastRun.itemsProcessed to track work done
   *
   * @example
   * ```typescript
   * async run(): Promise<void> {
   *   this.logger.info('Starting agent work');
   *   let processed = 0;
   *
   *   for (const item of items) {
   *     await this.processItem(item);
   *     processed++;
   *   }
   *
   *   this.lastRun.itemsProcessed = processed;
   *   this.logger.info(`Processed ${processed} items`);
   * }
   * ```
   */
  abstract run(): Promise<void>;

  /**
   * Cleanup and shutdown
   * Override to perform graceful shutdown
   *
   * Always call super.shutdown() to clean up signal handlers
   *
   * @example
   * ```typescript
   * async shutdown(): Promise<void> {
   *   this.logger.info('Cleaning up resources');
   *   await this.cleanup();
   *   await super.shutdown();
   * }
   * ```
   */
  async shutdown(): Promise<void> {
    this.status = 'shutdown';
    this.logger.info('Agent shutting down');
    this.cleanupSignalHandlers();
  }

  /**
   * Execute agent with lifecycle management
   *
   * Runs the full lifecycle:
   * 1. initialize() — seeds signal subscriptions if declared
   * 2. validate()
   * 3. processDispatches() — auto-processes pending dispatches if subscriptions exist
   * 4. run()
   *
   * Note: handleDispatch() callbacks may fire before run() is entered.
   *
   * On error:
   * 1. Sets status to 'error'
   * 2. Logs error
   * 3. Re-throws error
   *
   * @example
   * ```typescript
   * const agent = new MyAgent({ name: 'my-agent' });
   *
   * try {
   *   await agent.execute();
   *   console.log('Agent completed successfully');
   * } catch (error) {
   *   console.error('Agent failed:', error);
   * }
   * ```
   */
  async execute(): Promise<void> {
    // Learning trait (#1886): resolves to null for non-opted agents, so every
    // guarded branch below is skipped and behaviour is unchanged.
    let learning: LearningMemory | null = null;
    try {
      await this.initialize();
      await this.validate();

      this.status = 'running';

      // Auto-process pending dispatches for agents with signal subscriptions
      if (this._db) {
        const dispatch = await this.getDispatch();
        const subs = await dispatch.listSubscriptions(this.getAgentTypeName());
        if (subs.length > 0) {
          const count = await this.processDispatches();
          if (count > 0) {
            this.logger.info(`Processed ${count} pending dispatches`);
          }
        }
      }

      // Learning: recall-before-run
      learning = this.getLearningMemory();
      if (learning) {
        this.recalledMemories = await this.recallForRun(learning);
      }

      await this.run();

      // Learning: capture-after-run (success unless run reported otherwise)
      if (learning) {
        await this.captureForRun(
          learning,
          this._learningOutcome ?? { success: true },
        );
      }

      this.status = 'idle';

      this.logger.info('Agent execution completed');
    } catch (error) {
      // Learning: capture the failure, but never mask the original error.
      if (learning) {
        try {
          await this.captureForRun(learning, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (captureError) {
          this.logger.warn('Learning capture failed during error handling', {
            error: captureError,
          });
        }
      }
      this.status = 'error';
      this.logger.error('Agent execution failed', { error });
      throw error;
    } finally {
      // Reset per-run learning state so a reused instance starts clean.
      this._learningEpisode = null;
      this._learningOutcome = null;
    }
  }

  /**
   * Query objects this agent is interested in
   *
   * Returns items from all configured object types, filtered and sorted
   * according to interest configuration. If handlers are defined on filters,
   * they are called for each matched item and the result is included.
   *
   * @returns Array of { type, data, name?, handled? } results
   * @throws Error if no interests are configured
   *
   * @example
   * ```typescript
   * const items = await this.interesting();
   * for (const { type, data, name, handled } of items) {
   *   console.log(`Processing ${type} from "${name}": action=${handled?.action}`);
   * }
   * ```
   */
  async interesting(): Promise<InterestResult[]> {
    if (!this.interests) {
      throw new Error(
        `Agent ${this.constructor.name} has no interests configured. ` +
          `Set interests in constructor options to use interesting().`,
      );
    }

    if (
      !this.interests.objects ||
      Object.keys(this.interests.objects).length === 0
    ) {
      this.logger.warn('Agent has empty interests.objects configuration');
      return [];
    }

    const results: InterestResult[] = [];

    // Process each object type in interests.objects
    for (const [className, config] of Object.entries(this.interests.objects)) {
      try {
        const items = await this.queryInterestingObjects(className, config);
        results.push(...items);
      } catch (error) {
        // Log warning and continue with other types
        this.logger.warn(`Failed to query ${className} for interests`, {
          error,
        });
      }
    }

    // Apply global qualifier if configured
    if (this.interests.qualify) {
      const allItems = results.map((r) => r.data);
      const qualified = await this.interests.qualify(allItems);

      // Rebuild results array with only qualified items
      const qualifiedSet = new Set(qualified);
      const filteredResults = results.filter((r) => qualifiedSet.has(r.data));

      // Apply global sort if configured
      if (this.interests.sort) {
        return this.sortResults(filteredResults, this.interests.sort);
      }
      return filteredResults;
    }

    // Apply global sort if configured (no global qualifier)
    if (this.interests.sort) {
      return this.sortResults(results, this.interests.sort);
    }

    return results;
  }

  /**
   * Query a single object type based on interest config
   *
   * Supports both single filter and array of filters.
   * Each filter can use standard SDK filters OR custom query function.
   * Returns InterestResult[] with handler results included.
   */
  private async queryInterestingObjects(
    className: string,
    config: ObjectInterestConfig,
  ): Promise<InterestResult[]> {
    // Check if class is registered (case-insensitive)
    if (!ObjectRegistry.hasClass(className)) {
      this.logger.warn(
        `Object type "${className}" not found in ObjectRegistry. ` +
          `Skipping in interests query.`,
      );
      return [];
    }

    // Get collection for this class type
    const collection = await ObjectRegistry.getCollection(
      className,
      this.options,
    );

    // Normalize config to array format
    const filters = this.normalizeInterestConfig(config);

    // Query each filter and collect results
    const allResults: InterestResult[] = [];

    for (const filter of filters) {
      const items = await this.queryInterestFilter(
        className,
        filter,
        collection,
      );

      // Process each item: call handler if defined, build result
      for (const item of items) {
        const result: InterestResult = {
          type: className,
          data: item,
          name: filter.name,
        };

        // Call handler if defined and add to result
        if (filter.handler) {
          result.handled = await filter.handler(item, this);
        }

        allResults.push(result);
      }
    }

    return allResults;
  }

  /**
   * Normalize ObjectInterestConfig to array format
   */
  private normalizeInterestConfig(
    config: ObjectInterestConfig,
  ): InterestFilter[] {
    return Array.isArray(config) ? config : [config];
  }

  /**
   * Query a single interest filter
   *
   * Uses collection.query() for custom query functions,
   * or collection.list() for standard SDK filters.
   */
  private async queryInterestFilter(
    _className: string,
    filter: InterestFilter,
    collection: SmrtCollection<SmrtObject>,
  ): Promise<SmrtObject[]> {
    // Custom query path - uses collection.query() for raw SQL power
    if (filter.query) {
      let [whereClause, params] = filter.query(collection.tableName);

      // Ensure manifest is loaded for this class and its ancestors (Issue #515)
      // This is critical for cross-package STI where getTableStrategy() needs
      // the complete inheritance chain to detect inherited STI configuration
      //
      // We walk the extends chain directly (not using cached getInheritanceChain)
      // to avoid caching an incomplete chain before all manifests are loaded.
      // After loading all ancestors, we invalidate the cache so getTableStrategy
      // rebuilds it with complete data.
      await ObjectRegistry.ensureManifestLoaded(_className);
      let currentClass = ObjectRegistry.getClass(_className);
      while (currentClass?.extends) {
        const parentName = currentClass.extends;
        // Skip framework base classes
        if (
          parentName === 'SmrtObject' ||
          parentName === 'SmrtClass' ||
          parentName === 'SmrtCollection'
        ) {
          break;
        }
        try {
          await ObjectRegistry.ensureManifestLoaded(parentName);
        } catch {
          // Manifest loading can fail for classes not in manifest - continue
        }
        currentClass = ObjectRegistry.getClass(parentName);
      }
      // Invalidate cached chain so getTableStrategy rebuilds with complete data
      ObjectRegistry.invalidateInheritanceCache(_className);

      // Add STI discriminator filter if this is an STI child class.
      // R5-canon: `getSTIBase` returns the qualified name; compare
      // against the qualified form of `_className` so a query against
      // an STI BASE doesn't get an unintended `_meta_type` filter that
      // would hide its descendants.
      const tableStrategy = ObjectRegistry.getTableStrategy(_className);
      if (tableStrategy === 'sti') {
        const stiBase = ObjectRegistry.getSTIBase(_className);
        const classInfo = ObjectRegistry.getClass(_className);
        const qualifiedClassName =
          classInfo?.qualifiedName ?? classInfo?.name ?? _className;
        if (
          stiBase &&
          stiBase !== qualifiedClassName &&
          stiBase !== _className
        ) {
          // Get the qualified name for this class (e.g., '@happyvertical/praeco:Meeting')
          // This is what's stored in the _meta_type column in the database
          const metaTypeValue = classInfo?.qualifiedName || _className;
          // Wrap original where clause and add _meta_type filter
          whereClause = `_meta_type = ? AND (${whereClause})`;
          params = [metaTypeValue, ...params];
        }
      }

      // Build full SQL query
      let sql = `SELECT * FROM ${collection.tableName} WHERE ${whereClause}`;

      // Add ORDER BY if specified.
      // The sort fields are interpolated directly into the SQL string, so
      // validate each field name and direction against the same allowlist
      // collection.list() uses, to prevent SQL injection if filter.sort ever
      // derives from untrusted input.
      if (filter.sort) {
        const sorts = Array.isArray(filter.sort) ? filter.sort : [filter.sort];
        const orderBy = sorts
          .map((item) => {
            const [field, direction = 'ASC'] = item.trim().split(/\s+/);
            if (!/^[a-zA-Z0-9_]+$/.test(field)) {
              throw new Error(`Invalid field name for ordering: ${field}`);
            }
            const normalizedDirection = direction.toUpperCase();
            if (
              normalizedDirection !== 'ASC' &&
              normalizedDirection !== 'DESC'
            ) {
              throw new Error(
                `Invalid sort direction: ${direction}. Must be ASC or DESC.`,
              );
            }
            return `${field} ${normalizedDirection}`;
          })
          .join(', ');
        sql += ` ORDER BY ${orderBy}`;
      }

      // Add LIMIT if specified
      if (filter.limit) {
        sql += ` LIMIT ?`;
        params.push(filter.limit);
      }

      // Execute raw query with hydration
      let items = await collection.query(sql, params);

      // Apply qualifier if configured
      if (filter.qualify) {
        items = await filter.qualify(items);
      }

      return items;
    }

    // Standard filter path - uses collection.list() with SDK filters
    const mergedFilter = mergeFilters(this.interests?.filter, filter.filter);

    const queryOptions: {
      where?: Record<string, unknown>;
      orderBy?: string | string[];
      limit?: number;
    } = {};

    if (Object.keys(mergedFilter).length > 0) {
      queryOptions.where = mergedFilter;
    }
    if (filter.sort) {
      queryOptions.orderBy = filter.sort;
    }
    if (filter.limit) {
      queryOptions.limit = filter.limit;
    }

    // Execute query
    let items = await collection.list(queryOptions);

    // Apply object-specific qualifier if configured
    if (filter.qualify) {
      items = await filter.qualify(items);
    }

    return items;
  }

  /**
   * Sort results by field(s) across all types
   */
  private sortResults(
    results: InterestResult[],
    sort: string | string[],
  ): InterestResult[] {
    const sortFields = normalizeSort(sort);
    if (sortFields.length === 0) return results;

    return [...results].sort((a, b) => {
      for (const sortField of sortFields) {
        const [field, direction = 'ASC'] = sortField.trim().split(/\s+/);
        const aValue = (a.data as unknown as Record<string, string | number>)[
          field
        ];
        const bValue = (b.data as unknown as Record<string, string | number>)[
          field
        ];

        let comparison = 0;
        if (aValue < bValue) comparison = -1;
        else if (aValue > bValue) comparison = 1;

        if (comparison !== 0) {
          return direction.toUpperCase() === 'DESC' ? -comparison : comparison;
        }
      }
      return 0;
    });
  }
}

/**
 * Build the SQL tenant predicate (clause + params) for a raw `_smrt_dispatch`
 * write under the active {@link DispatchTenantScope} (S5 #1398).
 *
 * Mirrors core's `pushTenantPredicate` read/claim semantics so a raw migration
 * UPDATE only ever touches the rows the DispatchBus would let this scope
 * read/claim:
 *
 * - tenancy off (`enforced: false`) → no predicate (pre-tenancy behavior).
 * - active tenant `T` → `(tenant_id = ? OR tenant_id IS NULL)` (own + global).
 * - tenancy on, no active tenant → `tenant_id IS NULL` (fail-closed to global).
 *
 * The returned clause is prefixed with ` AND ` (or empty) so it can be appended
 * directly to an existing `WHERE (...)`.
 */
function buildDispatchTenantUpdatePredicate(
  scope: DispatchTenantScope,
): [clause: string, params: string[]] {
  if (!scope.enforced) {
    return ['', []];
  }
  if (scope.tenantId !== null) {
    return [' AND (tenant_id = ? OR tenant_id IS NULL)', [scope.tenantId]];
  }
  return [' AND tenant_id IS NULL', []];
}
