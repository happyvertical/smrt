import { Signal, ISignalAdapter } from '@smrt/types';
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
export declare class PubSubAdapter implements ISignalAdapter {
    private subscriptions;
    private nextSubscriptionId;
    /**
     * Handle a signal and broadcast to subscribers
     *
     * @param signal - Signal to broadcast
     */
    handle(signal: Signal): Promise<void>;
    /**
     * Subscribe to signals
     *
     * @param callback - Function to call with matching signals
     * @param filter - Optional filter to apply before sending
     * @returns Subscription ID for later unsubscribe
     */
    subscribe(callback: SignalSubscriber, filter?: SignalFilter): string;
    /**
     * Unsubscribe from signals
     *
     * @param subscriptionId - ID returned from subscribe()
     * @returns True if subscription was found and removed
     */
    unsubscribe(subscriptionId: string): boolean;
    /**
     * Get count of active subscriptions
     *
     * @returns Number of active subscribers
     */
    get subscriberCount(): number;
    /**
     * Clear all subscriptions
     *
     * Removes all subscribers. Useful for cleanup or testing.
     */
    clearSubscriptions(): void;
    /**
     * Create filter for specific class
     *
     * @param className - Class name to match
     * @returns Filter function
     */
    static filterByClass(className: string): SignalFilter;
    /**
     * Create filter for specific method
     *
     * @param methodName - Method name to match
     * @returns Filter function
     */
    static filterByMethod(methodName: string): SignalFilter;
    /**
     * Create filter for specific signal type
     *
     * @param type - Signal type to match
     * @returns Filter function
     */
    static filterByType(type: 'start' | 'step' | 'end' | 'error'): SignalFilter;
    /**
     * Create filter for specific class and method
     *
     * @param className - Class name to match
     * @param methodName - Method name to match
     * @returns Filter function
     */
    static filterByClassAndMethod(className: string, methodName: string): SignalFilter;
    /**
     * Combine multiple filters with AND logic
     *
     * @param filters - Filters to combine
     * @returns Combined filter function
     */
    static combineFilters(...filters: SignalFilter[]): SignalFilter;
}
//# sourceMappingURL=pubsub.d.ts.map