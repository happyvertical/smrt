import { Signal, ISignalAdapter } from '../../../types/src';
import { SanitizationConfig } from './sanitizer.js';
/**
 * Central signal distribution bus
 *
 * SignalBus manages adapter registration and signal distribution
 * with fire-and-forget error handling.
 */
export declare class SignalBus {
    private adapters;
    private sanitizer?;
    /**
     * Create a new SignalBus
     *
     * @param options - Configuration options
     */
    constructor(options?: {
        sanitization?: SanitizationConfig | false;
    });
    /**
     * Register a signal adapter
     *
     * @param adapter - Adapter to register
     */
    register(adapter: ISignalAdapter): void;
    /**
     * Unregister a signal adapter
     *
     * Removes the adapter from the bus to prevent memory leaks.
     *
     * @param adapter - Adapter to unregister
     * @returns True if adapter was found and removed
     */
    unregister(adapter: ISignalAdapter): boolean;
    /**
     * Clear all registered adapters
     *
     * Removes all adapters from the bus. Useful for cleanup or testing.
     */
    clear(): void;
    /**
     * Emit a signal to all registered adapters
     *
     * Signals are sanitized (if configured) before being passed to adapters.
     * Adapters are called in fire-and-forget mode - errors are logged
     * but don't interrupt the main execution flow.
     *
     * @param signal - Signal to emit
     */
    emit(signal: Signal): Promise<void>;
    /**
     * Generate unique execution ID for method invocations
     *
     * @returns Unique execution ID (CUID2)
     */
    generateExecutionId(): string;
    /**
     * Get count of registered adapters
     *
     * @returns Number of registered adapters
     */
    get adapterCount(): number;
}
//# sourceMappingURL=bus.d.ts.map