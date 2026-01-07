import { createLogger, type Logger } from '@happyvertical/logger';
import { sanitizeConfig } from '@happyvertical/smrt-config';
import {
  createDispatchBus,
  type DispatchBus,
  type DispatchMetadata,
  ObjectRegistry,
  type SmrtCollection,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { AgentConfig } from './config.js';
import type {
  AgentWithInterestsOptions,
  InterestFilter,
  InterestOptions,
  InterestResult,
  ObjectInterestConfig,
} from './interests.js';
import { mergeFilters, normalizeSort } from './interests.js';
import type { AgentStatusType } from './types.js';
import type { AgentUISlots } from './ui.js';

/**
 * Agent constructor options
 */
export interface AgentOptions
  extends SmrtObjectOptions,
    AgentWithInterestsOptions {}

/**
 * Base Agent class for building autonomous actors in the SMRT ecosystem
 *
 * Agents are SmrtObjects that perform specific tasks with:
 * - Status tracking (idle, initializing, running, error, shutdown)
 * - Configuration management via @have/config
 * - Structured logging via @happyvertical/logger
 * - Lifecycle hooks (initialize, validate, run, shutdown)
 * - Automatic signal handling for graceful shutdown
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
   * Creates a new Agent instance
   *
   * @param options - Configuration options including identifiers and metadata
   */
  constructor(options: AgentOptions = {}) {
    super(options);
    this.logger = createLogger({ level: 'info' });
  }

  /**
   * Interest configuration for this agent
   * Lazily accessed from options on first interesting() call
   */
  protected get interests(): InterestOptions | undefined {
    return (this.options as AgentOptions).interests;
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
  async loadConfigs(): Promise<Map<string, any>> {
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
    data: Record<string, any>,
  ): Promise<void> {
    await AgentConfig.saveSlot(
      {
        agentId: this.id,
        agentClass: this.constructor.name,
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
  async getMergedConfig(slotId: string): Promise<any> {
    // Get file-based config from module config
    const fileConfig = (this.config as Record<string, any>)?.[slotId] ?? {};

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
  async exportConfig(options?: { includeSecrets?: boolean }): Promise<any> {
    const dbConfigs = await this.loadConfigs();
    const fileConfig = (this.config as Record<string, any>) ?? {};

    // Merge all configs
    const merged = { ...fileConfig };
    for (const [slotId, data] of dbConfigs) {
      merged[slotId] = { ...merged[slotId], ...data };
    }

    // Sanitize if secrets not included (uses centralized sanitizeConfig from smrt-config)
    if (!options?.includeSecrets) {
      return sanitizeConfig(merged);
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
      this.constructor.name,
      this.handleDispatch.bind(this),
    );
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

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();

    return this;
  }

  /**
   * Set up signal handlers for graceful shutdown
   * Handles SIGTERM and SIGINT
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
   * 1. initialize()
   * 2. validate()
   * 3. run()
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
    try {
      await this.initialize();
      await this.validate();

      this.status = 'running';
      await this.run();
      this.status = 'idle';

      this.logger.info('Agent execution completed');
    } catch (error) {
      this.status = 'error';
      this.logger.error('Agent execution failed', { error });
      throw error;
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

      // Add STI discriminator filter if this is an STI child class
      const tableStrategy = ObjectRegistry.getTableStrategy(_className);
      if (tableStrategy === 'sti') {
        const stiBase = ObjectRegistry.getSTIBase(_className);
        if (stiBase && stiBase !== _className) {
          // Wrap original where clause and add _meta_type filter
          whereClause = `_meta_type = ? AND (${whereClause})`;
          params = [_className, ...params];
        }
      }

      // Build full SQL query
      let sql = `SELECT * FROM ${collection.tableName} WHERE ${whereClause}`;

      // Add ORDER BY if specified
      if (filter.sort) {
        const sorts = Array.isArray(filter.sort) ? filter.sort : [filter.sort];
        sql += ` ORDER BY ${sorts.join(', ')}`;
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
      where?: Record<string, any>;
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
        const aValue = (a.data as Record<string, any>)[field];
        const bValue = (b.data as Record<string, any>)[field];

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
