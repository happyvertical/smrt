/**
 * Pub/Sub Adapter for Signal System
 *
 * Broadcasts signals to subscribers for real-time updates.
 * Supports multiple subscriber types (callbacks, WebSocket, SSE).
 */

import type { ISignalAdapter, Signal } from '@smrt/types';

/**
 * Signal filter function
 *
 * @param signal - Signal to evaluate
 * @returns True if signal should be sent to subscriber
 */
export type SignalFilter = (signal: Signal) => boolean;

/**
 * Signal subscriber callback
 */
export type SignalSubscriber = (signal: Signal) => void | Promise<void>;

/**
 * Subscription configuration
 */
export interface Subscription {
  /** Unique subscription ID */
  id: string;
  /** Callback to invoke with signals */
  callback: SignalSubscriber;
  /** Optional filter to apply before sending */
  filter?: SignalFilter;
}

/**
 * Pub/Sub Adapter - Broadcasts signals to subscribers
 *
 * Enables real-time updates for UI clients via WebSocket/SSE or
 * internal event-driven architectures via callbacks.
 *
 * Features:
 * - Multiple subscribers with independent filters
 * - Fire-and-forget delivery (errors don't block other subscribers)
 * - Flexible filtering (by class, method, type, etc.)
 * - Subscription management (add, remove, list)
 *
 * @example
 * ```typescript
 * const pubsub = new PubSubAdapter();
 * signalBus.register(pubsub);
 *
 * // Subscribe to all error signals
 * const subId = pubsub.subscribe(
 *   (signal) => console.error('Error:', signal),
 *   (signal) => signal.type === 'error'
 * );
 *
 * // Later, unsubscribe
 * pubsub.unsubscribe(subId);
 * ```
 */
export class PubSubAdapter implements ISignalAdapter {
  private subscriptions: Map<string, Subscription> = new Map();
  private nextSubscriptionId = 1;

  /**
   * Handle a signal and broadcast to subscribers
   *
   * @param signal - Signal to broadcast
   */
  async handle(signal: Signal): Promise<void> {
    // Broadcast to all matching subscribers
    const promises: Promise<void>[] = [];

    for (const subscription of this.subscriptions.values()) {
      // Apply filter if present
      if (subscription.filter && !subscription.filter(signal)) {
        continue;
      }

      // Execute callback with error handling
      const promise = (async () => {
        try {
          await subscription.callback(signal);
        } catch (error) {
          console.error(
            `PubSubAdapter: Subscriber ${subscription.id} error:`,
            error,
          );
        }
      })();

      promises.push(promise);
    }

    // Wait for all subscribers to process (fire-and-forget style)
    await Promise.allSettled(promises);
  }

  /**
   * Subscribe to signals
   *
   * @param callback - Function to call with matching signals
   * @param filter - Optional filter to apply before sending
   * @returns Subscription ID for later unsubscribe
   */
  subscribe(callback: SignalSubscriber, filter?: SignalFilter): string {
    const id = `sub-${this.nextSubscriptionId++}`;

    this.subscriptions.set(id, {
      id,
      callback,
      filter,
    });

    return id;
  }

  /**
   * Unsubscribe from signals
   *
   * @param subscriptionId - ID returned from subscribe()
   * @returns True if subscription was found and removed
   */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /**
   * Get count of active subscriptions
   *
   * @returns Number of active subscribers
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Clear all subscriptions
   *
   * Removes all subscribers. Useful for cleanup or testing.
   */
  clearSubscriptions(): void {
    this.subscriptions.clear();
  }

  /**
   * Create filter for specific class
   *
   * @param className - Class name to match
   * @returns Filter function
   */
  static filterByClass(className: string): SignalFilter {
    return (signal: Signal) => signal.className === className;
  }

  /**
   * Create filter for specific method
   *
   * @param methodName - Method name to match
   * @returns Filter function
   */
  static filterByMethod(methodName: string): SignalFilter {
    return (signal: Signal) => signal.method === methodName;
  }

  /**
   * Create filter for specific signal type
   *
   * @param type - Signal type to match
   * @returns Filter function
   */
  static filterByType(type: 'start' | 'step' | 'end' | 'error'): SignalFilter {
    return (signal: Signal) => signal.type === type;
  }

  /**
   * Create filter for specific class and method
   *
   * @param className - Class name to match
   * @param methodName - Method name to match
   * @returns Filter function
   */
  static filterByClassAndMethod(
    className: string,
    methodName: string,
  ): SignalFilter {
    return (signal: Signal) =>
      signal.className === className && signal.method === methodName;
  }

  /**
   * Combine multiple filters with AND logic
   *
   * @param filters - Filters to combine
   * @returns Combined filter function
   */
  static combineFilters(...filters: SignalFilter[]): SignalFilter {
    return (signal: Signal) => filters.every((filter) => filter(signal));
  }
}
