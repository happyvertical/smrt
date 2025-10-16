import { SmrtObject } from "@have/smrt";
import { createLogger } from "@have/logger";
class Agent extends SmrtObject {
  /**
   * Current agent status
   */
  status = "idle";
  /**
   * Structured logger instance
   * Created with agent's class name as context
   */
  logger;
  /**
   * Signal handlers for graceful shutdown
   */
  signalHandlers = /* @__PURE__ */ new Map();
  /**
   * Creates a new Agent instance
   *
   * @param options - Configuration options including identifiers and metadata
   */
  constructor(options = {}) {
    super(options);
    this.logger = createLogger({ level: "info" });
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
  async initialize() {
    await super.initialize();
    this.status = "initializing";
    this.logger.info("Agent initializing");
    this.setupSignalHandlers();
    return this;
  }
  /**
   * Set up signal handlers for graceful shutdown
   * Handles SIGTERM and SIGINT
   */
  setupSignalHandlers() {
    const signals = ["SIGTERM", "SIGINT"];
    for (const signal of signals) {
      const handler = () => {
        this.logger.info(`Received ${signal}, shutting down gracefully`);
        this.shutdown().then(() => {
          process.exit(0);
        }).catch((error) => {
          this.logger.error("Error during shutdown", { error });
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
  cleanupSignalHandlers() {
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
  async validate() {
    this.logger.info("Validating agent configuration");
  }
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
  async shutdown() {
    this.status = "shutdown";
    this.logger.info("Agent shutting down");
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
  async execute() {
    try {
      await this.initialize();
      await this.validate();
      this.status = "running";
      await this.run();
      this.status = "idle";
      this.logger.info("Agent execution completed");
    } catch (error) {
      this.status = "error";
      this.logger.error("Agent execution failed", { error });
      throw error;
    }
  }
}
export {
  Agent
};
//# sourceMappingURL=index.js.map
