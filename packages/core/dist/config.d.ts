import { LoggerConfig } from '@have/logger';
import { SignalAdapter } from '@smrt/types';
import { SignalBus } from './signals/bus.js';
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
 * AI provider configuration
 *
 * Global defaults for AI client initialization.
 * Provides fallback values when AI options are not specified per-instance.
 */
export interface AIConfig {
    /**
     * Default AI provider to use
     * Examples: 'openai', 'anthropic', 'claude-cli', 'gemini', etc.
     */
    provider?: string;
    /**
     * Default model to use with the provider
     * Examples: 'gpt-4', 'claude-3-opus', 'sonnet', etc.
     */
    model?: string;
    /**
     * Default API key for the provider
     * Can be overridden by environment variables or instance options
     */
    apiKey?: string;
    /**
     * Additional provider-specific options
     */
    [key: string]: any;
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
     * AI provider configuration (default: undefined)
     * Provides global defaults for AI client initialization
     */
    ai?: AIConfig;
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
        adapters?: SignalAdapter[];
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
 *   pubsub: { enabled: false },
 *   ai: {
 *     provider: 'claude-cli',
 *     model: 'sonnet'
 *   }
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
 * // product has logging at debug level, metrics enabled, and uses claude-cli by default
 * ```
 */
declare function config(options: GlobalSignalConfig): void;
declare namespace config {
    var reset: () => void;
    var toJSON: () => GlobalSignalConfig;
    var toString: () => string;
}
export { config };
export { loadEnvConfig, toCamelCase, toScreamingSnakeCase, convertType, type ConfigOptions, } from '@have/utils';
//# sourceMappingURL=config.d.ts.map