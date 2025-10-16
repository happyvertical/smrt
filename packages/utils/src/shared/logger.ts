/**
 * Universal logging utilities that work in both browser and Node.js
 *
 * Provides a configurable logging system with console and no-op implementations.
 * The global logger can be swapped out for custom implementations as needed.
 */

import type { Logger } from './types';

/**
 * Console-based logger implementation
 *
 * Routes all log messages to the appropriate console methods with optional context.
 */
class ConsoleLogger implements Logger {
  debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.debug(message, context);
    } else {
      console.debug(message);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.info(message, context);
    } else {
      console.info(message);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.warn(message, context);
    } else {
      console.warn(message);
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.error(message, context);
    } else {
      console.error(message);
    }
  }
}

/**
 * No-operation logger that discards all log messages
 *
 * Useful for disabling logging in production or testing environments.
 */
class NoOpLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Global logger instance used throughout the SDK */
let globalLogger: Logger = new ConsoleLogger();

/**
 * Replace the global logger with a custom implementation
 *
 * @param logger - Custom logger implementation
 * @example
 * ```typescript
 * setLogger(new CustomLogger());
 * ```
 */
export const setLogger = (logger: Logger): void => {
  globalLogger = logger;
};

/**
 * Get the current global logger instance
 *
 * @returns Current logger implementation
 * @example
 * ```typescript
 * const logger = getLogger();
 * logger.info('Application started');
 * ```
 */
export const getLogger = (): Logger => {
  return globalLogger;
};

/**
 * Disable all logging by switching to no-op logger
 *
 * @example
 * ```typescript
 * if (process.env.NODE_ENV === 'production') {
 *   disableLogging();
 * }
 * ```
 */
export const disableLogging = (): void => {
  globalLogger = new NoOpLogger();
};

/**
 * Enable console logging by switching to console logger
 *
 * @example
 * ```typescript
 * enableLogging(); // Re-enable after disabling
 * ```
 */
export const enableLogging = (): void => {
  globalLogger = new ConsoleLogger();
};
