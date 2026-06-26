/**
 * Global SMRT configuration system
 *
 * Provides application-level defaults for signal adapters.
 * Configuration follows a three-tier pattern:
 * 1. Global defaults (via smrt.configure())
 * 2. Per-instance overrides (via SmrtClassOptions)
 * 3. Runtime behavior (from merged config)
 */

import type { LoggerConfig } from '@happyvertical/logger';
import type { AiUsageHandler, SignalAdapter } from '@happyvertical/smrt-types';
import type { SignalBus } from './signals/bus.js';
import type { SanitizationConfig } from './signals/sanitizer.js';

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
  [key: string]: unknown;
}

/**
 * AI usage tracking configuration
 */
export interface AiUsageConfig {
  /** Enable normalized AI usage tracking (default: true) */
  enabled?: boolean;

  /** Enable persistence to _smrt_ai_usage when a DB exists (default: true) */
  persist?: boolean;

  /** Enable best-effort cost estimation (default: true) */
  estimateCosts?: boolean;

  /** Override USD-per-1K-token cost rates */
  costRates?: Record<string, { input: number; output: number }>;

  /** Additional usage handlers */
  handlers?: AiUsageHandler[];
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
   * AI usage tracking configuration (default: enabled)
   */
  usage?: AiUsageConfig;

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
 * Singleton configuration manager
 *
 * Manages global SMRT configuration with sensible defaults.
 */
class SmrtConfig {
  private static instance: SmrtConfig;
  private config: GlobalSignalConfig = {
    logging: true, // Default: console logging at info level
  };

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): SmrtConfig {
    if (!SmrtConfig.instance) {
      SmrtConfig.instance = new SmrtConfig();
    }
    return SmrtConfig.instance;
  }

  /**
   * Configure global defaults
   *
   * @param config - Configuration to apply
   */
  configure(config: GlobalSignalConfig): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   *
   * @returns Current global configuration
   */
  getConfig(): GlobalSignalConfig {
    return { ...this.config };
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = { logging: true };
  }
}

/**
 * Global configuration API
 *
 * Callable function with attached methods for managing SMRT configuration.
 *
 * @example
 * ```typescript
 * import { config } from '@happyvertical/smrt-core';
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
function config(options: GlobalSignalConfig): void {
  SmrtConfig.getInstance().configure(options);
}

/**
 * Reset configuration to defaults
 */
config.reset = (): void => {
  SmrtConfig.getInstance().reset();
};

/**
 * Get current configuration as object
 * Called automatically by JSON.stringify()
 *
 * @returns Current global configuration
 */
config.toJSON = (): GlobalSignalConfig => SmrtConfig.getInstance().getConfig();

/**
 * Convert configuration to string
 * Called automatically in string contexts
 *
 * @returns JSON string representation of configuration
 */
config.toString = (): string =>
  JSON.stringify(SmrtConfig.getInstance().getConfig(), null, 2);

export { config };

// Re-export env-config utilities from @happyvertical/utils
export {
  type ConfigOptions,
  convertType,
  loadEnvConfig,
  toCamelCase,
  toScreamingSnakeCase,
} from '@happyvertical/utils';
