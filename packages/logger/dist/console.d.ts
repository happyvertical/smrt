import { Logger, LogLevel } from './logger.js';
/**
 * Console-based logger with level filtering
 *
 * Logs are written to console with appropriate severity levels.
 * Messages are only output if they meet the configured log level threshold.
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger('info');
 * logger.debug('Debug message');  // Not output (below 'info')
 * logger.info('Info message');    // Output
 * logger.error('Error message');  // Output
 * ```
 */
export declare class ConsoleLogger implements Logger {
    private level;
    private static readonly LEVELS;
    constructor(level?: LogLevel);
    /**
     * Check if a log level should be output
     *
     * @param level - Log level to check
     * @returns True if level meets threshold
     */
    private shouldLog;
    /**
     * Format context for console output
     *
     * @param context - Structured metadata
     * @returns Formatted context string
     */
    private formatContext;
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
}
//# sourceMappingURL=console.d.ts.map