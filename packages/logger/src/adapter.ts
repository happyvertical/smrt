/**
 * Signal adapter for structured logging
 */

import type { Signal, ISignalAdapter } from '@have/types';
import type { Logger } from './logger.js';

/**
 * Logger Adapter - Converts signals to structured log messages
 *
 * Transforms signals from the SMRT framework into structured log entries.
 * Each signal type is mapped to an appropriate log level:
 * - start → debug
 * - step → debug
 * - end → info
 * - error → error
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger('info');
 * const adapter = new LoggerAdapter(logger);
 * signalBus.register(adapter);
 * ```
 */
export class LoggerAdapter implements ISignalAdapter {
  constructor(private logger: Logger) {}

  /**
   * Handle a signal and log appropriately
   *
   * @param signal - Signal to log
   */
  async handle(signal: Signal): Promise<void> {
    const context: Record<string, unknown> = {
      id: signal.id,
      objectId: signal.objectId,
      className: signal.className,
      method: signal.method,
      timestamp: signal.timestamp,
    };

    // Add optional fields if present
    if (signal.duration !== undefined) {
      context.duration = signal.duration;
    }

    if (signal.metadata) {
      context.metadata = signal.metadata;
    }

    switch (signal.type) {
      case 'start':
        this.logger.debug(
          `${signal.className}.${signal.method}() started`,
          context,
        );
        break;

      case 'step':
        this.logger.debug(
          `${signal.className}.${signal.method}() step: ${signal.step || 'unknown'}`,
          context,
        );
        break;

      case 'end':
        this.logger.info(
          `${signal.className}.${signal.method}() completed in ${signal.duration}ms`,
          {
            ...context,
            result: signal.result !== undefined ? 'present' : 'none',
          },
        );
        break;

      case 'error':
        this.logger.error(
          `${signal.className}.${signal.method}() failed: ${signal.error?.message || 'Unknown error'}`,
          {
            ...context,
            error: signal.error
              ? {
                  message: signal.error.message,
                  name: signal.error.name,
                  stack: signal.error.stack,
                }
              : undefined,
          },
        );
        break;
    }
  }
}
