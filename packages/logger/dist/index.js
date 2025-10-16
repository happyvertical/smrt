class ConsoleLogger {
  constructor(level = "info") {
    this.level = level;
  }
  static LEVELS = [
    "debug",
    "info",
    "warn",
    "error"
  ];
  /**
   * Check if a log level should be output
   *
   * @param level - Log level to check
   * @returns True if level meets threshold
   */
  shouldLog(level) {
    const currentIndex = ConsoleLogger.LEVELS.indexOf(this.level);
    const messageIndex = ConsoleLogger.LEVELS.indexOf(level);
    return messageIndex >= currentIndex;
  }
  /**
   * Format context for console output
   *
   * @param context - Structured metadata
   * @returns Formatted context string
   */
  formatContext(context) {
    if (!context || Object.keys(context).length === 0) {
      return "";
    }
    return ` ${JSON.stringify(context)}`;
  }
  debug(message, context) {
    if (this.shouldLog("debug")) {
      console.debug(`[DEBUG] ${message}${this.formatContext(context)}`);
    }
  }
  info(message, context) {
    if (this.shouldLog("info")) {
      console.info(`[INFO] ${message}${this.formatContext(context)}`);
    }
  }
  warn(message, context) {
    if (this.shouldLog("warn")) {
      console.warn(`[WARN] ${message}${this.formatContext(context)}`);
    }
  }
  error(message, context) {
    if (this.shouldLog("error")) {
      console.error(`[ERROR] ${message}${this.formatContext(context)}`);
    }
  }
}
class LoggerAdapter {
  constructor(logger) {
    this.logger = logger;
  }
  /**
   * Handle a signal and log appropriately
   *
   * @param signal - Signal to log
   */
  async handle(signal) {
    const context = {
      id: signal.id,
      objectId: signal.objectId,
      className: signal.className,
      method: signal.method,
      timestamp: signal.timestamp
    };
    if (signal.duration !== void 0) {
      context.duration = signal.duration;
    }
    if (signal.metadata) {
      context.metadata = signal.metadata;
    }
    switch (signal.type) {
      case "start":
        this.logger.debug(
          `${signal.className}.${signal.method}() started`,
          context
        );
        break;
      case "step":
        this.logger.debug(
          `${signal.className}.${signal.method}() step: ${signal.step || "unknown"}`,
          context
        );
        break;
      case "end":
        this.logger.info(
          `${signal.className}.${signal.method}() completed in ${signal.duration}ms`,
          {
            ...context,
            result: signal.result !== void 0 ? "present" : "none"
          }
        );
        break;
      case "error":
        this.logger.error(
          `${signal.className}.${signal.method}() failed: ${signal.error?.message || "Unknown error"}`,
          {
            ...context,
            error: signal.error ? {
              message: signal.error.message,
              name: signal.error.name,
              stack: signal.error.stack
            } : void 0
          }
        );
        break;
    }
  }
}
class NoopLogger {
  debug(_message, _context) {
  }
  info(_message, _context) {
  }
  warn(_message, _context) {
  }
  error(_message, _context) {
  }
}
function createLogger(config) {
  if (typeof config === "boolean") {
    return config ? new ConsoleLogger("info") : new NoopLogger();
  }
  const level = config.level || "info";
  return new ConsoleLogger(level);
}
export {
  ConsoleLogger,
  LoggerAdapter,
  createLogger
};
//# sourceMappingURL=index.js.map
