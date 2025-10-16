/**
 * Universal Signaling System Types
 *
 * This module defines the core types for the SMRT signaling system,
 * which provides automatic method tracking and event distribution
 * for logging, metrics, pub/sub, and other observability needs.
 */
/**
 * Signal event type indicating the lifecycle stage
 */
export type SignalType = 'start' | 'step' | 'end' | 'error';
/**
 * Signal emitted during SMRT method execution
 *
 * Signals provide automatic observability into method execution,
 * enabling logging, metrics, pub/sub updates, and other integrations
 * without requiring manual instrumentation.
 */
export interface Signal {
    /**
     * Unique identifier for this specific execution
     * Generated once per method invocation
     */
    id: string;
    /**
     * ID of the SMRT object instance
     */
    objectId: string;
    /**
     * Name of the SMRT class
     */
    className: string;
    /**
     * Name of the method being executed
     */
    method: string;
    /**
     * Signal type indicating lifecycle stage:
     * - 'start': Method execution started
     * - 'step': Manual step within method (optional)
     * - 'end': Method execution completed successfully
     * - 'error': Method execution failed
     */
    type: SignalType;
    /**
     * Optional step label for manual progress tracking
     * Developers can emit custom steps within methods using bus.emit()
     */
    step?: string;
    /**
     * Sanitized method arguments (sensitive data removed)
     * Objects with @sensitive JSDoc tags are excluded
     */
    args?: any[];
    /**
     * Method result (only present on 'end' signals)
     */
    result?: any;
    /**
     * Error that was thrown (only present on 'error' signals)
     */
    error?: Error;
    /**
     * Method execution duration in milliseconds
     * Only present on 'end' and 'error' signals
     */
    duration?: number;
    /**
     * Unix timestamp when signal was emitted
     */
    timestamp: number;
    /**
     * Optional additional context
     * Can include tracing IDs, user context, request metadata, etc.
     */
    metadata?: Record<string, any>;
}
/**
 * Adapter interface for consuming signals
 *
 * Adapters process signals for specific purposes like:
 * - Logging: Write to console, file, or logging service
 * - Metrics: Track execution counts, durations, errors
 * - Pub/Sub: Broadcast real-time updates to clients
 * - Tracing: Send spans to distributed tracing systems
 *
 * Adapters are fire-and-forget - errors are caught and logged
 * but don't interrupt the main execution flow.
 */
export interface ISignalAdapter {
    /**
     * Handle a signal event
     *
     * @param signal - The signal to process
     * @returns Promise that resolves when signal is handled
     *
     * @remarks
     * This method should not throw - errors are caught by the SignalBus.
     * Implementations should handle their own error logging/recovery.
     */
    handle(signal: Signal): Promise<void>;
}
//# sourceMappingURL=signals.d.ts.map