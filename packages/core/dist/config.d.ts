import { SignalBus } from './signals/bus.js';
import { ISignalAdapter } from '@smrt/types';
import { LoggerConfig } from '@have/logger';
import { SanitizationConfig } from './signals/sanitizer.js';
/**
 * Metrics adapter configuration
 */
export interface MetricsConfig {
    /** Enable metrics tracking */
    enabled: boolean;
}
/**
 * Pub/Sub adapter configuration
 */
export interface PubSubConfig {
    /** Enable pub/sub broadcasting */
    enabled: boolean;
}
/**
 * Global signal configuration
 *
 * Application-level defaults for signal adapters.
 * These can be overridden per-instance via SmrtClassOptions.
 */
export interface GlobalSignalConfig {
    /** Logging configuration (default: true with console, info level) */
    logging?: LoggerConfig;
    /** Metrics configuration (default: undefined/disabled) */
    metrics?: MetricsConfig;
    /** Pub/Sub configuration (default: undefined/disabled) */
    pubsub?: PubSubConfig;
    /**
     * Signal sanitization configuration (default: enabled with standard redactions)
     * Set to false to disable sanitization
     */
    sanitization?: SanitizationConfig | false;
    /** Custom signal configuration */
    signals?: {
        /** Shared signal bus instance */
        bus?: SignalBus;
        /** Additional custom adapters */
        adapters?: ISignalAdapter[];
    };
}
/**
 * Global configuration API
 *
 * Callable function with attached methods for managing SMRT configuration.
 *
 * @example
 * ```typescript
 * import { config } from '@smrt/core';
 *
 * // Set application-level defaults
 * config({
 *   logging: { level: 'debug' },
 *   metrics: { enabled: true },
 *   pubsub: { enabled: false }
 * });
 *
 * // Reset to defaults
 * config.reset();
 *
 * // Get current configuration
 * const current = config.toJSON();
 *
 * // Auto-convert to string
 * console.log(`Config: ${config}`);
 *
 * // Auto-convert to JSON
 * JSON.stringify(config);
 *
 * // All SmrtClass instances now use these defaults
 * const product = new Product({ name: 'Widget' });
 * await product.initialize();
 * // product has logging at debug level and metrics enabled
 * ```
 */
declare function config(options: GlobalSignalConfig): void;
declare namespace config {
    var reset: () => void;
    var toJSON: () => GlobalSignalConfig;
    var toString: () => string;
}
export { config };
//# sourceMappingURL=config.d.ts.map