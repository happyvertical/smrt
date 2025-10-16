/**
 * Console logger implementation with configurable log levels
 */

import type { Logger, LogLevel } from './logger.js';

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
export class ConsoleLogger implements Logger {
  private static readonly LEVELS: ReadonlyArray<LogLevel> = [
    'debug',
    'info',
    'warn',
    'error',
  ];

  constructor(private level: LogLevel = 'info') {}

  /**
   * Check if a log level should be output
   *
   * @param level - Log level to check
   * @returns True if level meets threshold
   */
  private shouldLog(level: LogLevel): boolean {
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
  private formatContext(context?: Record<string, unknown>): string {
    if (!context || Object.keys(context).length === 0) {
      return '';
    }
    return ` ${JSON.stringify(context)}`;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(`[DEBUG] ${message}${this.formatContext(context)}`);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(`[INFO] ${message}${this.formatContext(context)}`);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}${this.formatContext(context)}`);
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}${this.formatContext(context)}`);
    }
  }
}
