import { SmrtObject, type SmrtObjectOptions } from '@smrt/core';
import { createLogger, type Logger } from '@have/logger';
import type { AgentStatusType } from './types.js';

/**
 * Base Agent class for building autonomous actors in the SMRT ecosystem
 *
 * Agents are SmrtObjects that perform specific tasks with:
 * - Status tracking (idle, initializing, running, error, shutdown)
 * - Configuration management via @have/config
 * - Structured logging via @have/logger
 * - Lifecycle hooks (initialize, validate, run, shutdown)
 * - Automatic signal handling for graceful shutdown
 *
 * Agents can define their own properties for state management - since they extend
 * SmrtObject, any properties defined will be automatically persisted to the database.
 *
 * **Important**: Extending classes must add the `@smrt()` decorator themselves.
 *
 * @example
 * ```typescript
 * import { Agent } from '@have/agents';
 * import { getModuleConfig } from '@have/config';
 * import { smrt } from '@smrt/core';
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
export abstract class Agent extends SmrtObject {
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
   * Creates a new Agent instance
   *
   * @param options - Configuration options including identifiers and metadata
   */
  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    this.logger = createLogger({ level: 'info' });
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
}
