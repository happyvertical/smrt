/**
 * Signal Bus for Universal Event Distribution
 *
 * This module provides the central SignalBus for distributing signals
 * to registered adapters (logging, metrics, pub/sub, etc.).
 */

import { makeId } from '@have/utils';
import type { ISignalAdapter, Signal } from '@smrt/types';
import type { SanitizationConfig } from './sanitizer.js';
import { SignalSanitizer } from './sanitizer.js';

/**
 * Central signal distribution bus
 *
 * SignalBus manages adapter registration and signal distribution
 * with fire-and-forget error handling.
 */
export class SignalBus {
  private adapters: ISignalAdapter[] = [];
  private sanitizer?: SignalSanitizer;

  /**
   * Create a new SignalBus
   *
   * @param options - Configuration options
   */
  constructor(options?: { sanitization?: SanitizationConfig | false }) {
    if (options && options.sanitization !== false && options.sanitization) {
      this.sanitizer = new SignalSanitizer(options.sanitization);
    }
  }

  /**
   * Register a signal adapter
   *
   * @param adapter - Adapter to register
   */
  register(adapter: ISignalAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Unregister a signal adapter
   *
   * Removes the adapter from the bus to prevent memory leaks.
   *
   * @param adapter - Adapter to unregister
   * @returns True if adapter was found and removed
   */
  unregister(adapter: ISignalAdapter): boolean {
    const index = this.adapters.indexOf(adapter);
    if (index !== -1) {
      this.adapters.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all registered adapters
   *
   * Removes all adapters from the bus. Useful for cleanup or testing.
   */
  clear(): void {
    this.adapters = [];
  }

  /**
   * Emit a signal to all registered adapters
   *
   * Signals are sanitized (if configured) before being passed to adapters.
   * Adapters are called in fire-and-forget mode - errors are logged
   * but don't interrupt the main execution flow.
   *
   * @param signal - Signal to emit
   */
  async emit(signal: Signal): Promise<void> {
    // Sanitize signal if configured
    const sanitizedSignal = this.sanitizer
      ? this.sanitizer.sanitize(signal)
      : signal;

    // Fire-and-forget - don't await adapter promises
    const promises = this.adapters.map(async (adapter, index) => {
      try {
        await adapter.handle(sanitizedSignal);
      } catch (error) {
        // Log adapter errors with detailed context
        const adapterName =
          adapter.constructor.name !== 'Object'
            ? adapter.constructor.name
            : `Adapter[${index}]`;

        console.error(`SignalBus: ${adapterName} failed to handle signal`, {
          signalId: signal.id,
          signalType: signal.type,
          className: signal.className,
          method: signal.method,
          adapterIndex: index,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  name: error.name,
                  stack: error.stack,
                }
              : error,
        });
      }
    });

    // Don't wait for adapters to complete
    // They execute asynchronously without blocking the main flow
    void Promise.allSettled(promises);
  }

  /**
   * Generate unique execution ID for method invocations
   *
   * @returns Unique execution ID (CUID2)
   */
  generateExecutionId(): string {
    return makeId();
  }

  /**
   * Get count of registered adapters
   *
   * @returns Number of registered adapters
   */
  get adapterCount(): number {
    return this.adapters.length;
  }
}
