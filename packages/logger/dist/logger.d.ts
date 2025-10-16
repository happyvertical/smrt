/**
 * Core logging interfaces and types
 */
/**
 * Log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Logger configuration
 * - boolean: true = console logger with 'info' level, false = disabled
 * - object: configure logger with specific level
 */
export type LoggerConfig = boolean | {
    level?: LogLevel;
};
/**
 * Structured logger interface
 *
 * All methods accept optional context for structured logging.
 * Context should contain machine-readable metadata.
 */
export interface Logger {
    /**
     * Log debug message (verbose development information)
     *
     * @param message - Human-readable log message
     * @param context - Optional structured metadata
     */
    debug(message: string, context?: Record<string, unknown>): void;
    /**
     * Log informational message (normal operation)
     *
     * @param message - Human-readable log message
     * @param context - Optional structured metadata
     */
    info(message: string, context?: Record<string, unknown>): void;
    /**
     * Log warning message (potential issues)
     *
     * @param message - Human-readable log message
     * @param context - Optional structured metadata
     */
    warn(message: string, context?: Record<string, unknown>): void;
    /**
     * Log error message (failures and exceptions)
     *
     * @param message - Human-readable log message
     * @param context - Optional structured metadata
     */
    error(message: string, context?: Record<string, unknown>): void;
}
//# sourceMappingURL=logger.d.ts.map