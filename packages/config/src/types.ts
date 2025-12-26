/**
 * Global SMRT framework options
 * These apply to all modules unless overridden
 */
export interface SmrtGlobalConfig {
  cacheDir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  environment?: 'development' | 'production' | 'test';

  /**
   * Schema migration strategy when parent class schema changes
   *
   * Options:
   * - 'warn': Log warning about schema mismatch, require manual migration (safest)
   * - 'auto-add': Automatically ALTER TABLE to add new parent fields (default, convenient)
   *
   * Note: Removing columns is never automatic - always requires manual migration
   *
   * @default 'auto-add'
   */
  schemaMigration?: {
    strategy?: 'warn' | 'auto-add';
  };

  /**
   * Inheritance configuration
   */
  inheritance?: {
    /**
     * Behavior when an ancestor class is missing from the registry
     *
     * Options:
     * - 'error': Throw an error (strict, catches bugs)
     * - 'warn': Log warning and skip (lenient, default)
     *
     * @default 'warn'
     */
    onMissingAncestor?: 'error' | 'warn';

    /**
     * Size of LRU cache for inheritance chains and merged fields
     *
     * Higher values improve performance but use more memory.
     * Each entry stores one inheritance chain (array of strings).
     *
     * @default 200
     */
    cacheSize?: number;
  };

  /**
   * Embedding configuration for semantic search
   *
   * Project-level settings that apply to all SMRT objects
   * unless overridden in the @smrt() decorator.
   */
  embeddings?: {
    /**
     * Standard dimensions for embeddings in this project
     *
     * All embeddings should use the same dimensions for consistency.
     * Common values: 384, 768, 1536
     *
     * @default 768
     */
    dimensions?: number;

    /**
     * Embedding provider type
     *
     * - 'local': Use local Node.js model (@xenova/transformers)
     * - 'ai': Use AI library (OpenAI, etc.)
     * - 'auto': Try local first, fallback to AI
     *
     * @default 'local'
     */
    provider?: 'local' | 'ai' | 'auto';

    /**
     * Local model to use (when provider is 'local' or 'auto')
     *
     * Hugging Face model ID for @xenova/transformers.
     * Model is downloaded on first use (~440MB for bge-base-en-v1.5).
     *
     * @default 'Xenova/bge-base-en-v1.5'
     */
    localModel?: string;

    /**
     * AI model to use (when provider is 'ai' or fallback)
     *
     * OpenAI embedding model name.
     *
     * @default 'text-embedding-3-small'
     */
    aiModel?: string;

    /**
     * Whether to fallback to AI if local embedding fails
     *
     * Only applies when provider is 'auto'.
     *
     * @default true
     */
    fallbackToAI?: boolean;
  };

  [key: string]: unknown;
}

// ============================================================================
// Site Configuration Types
// ============================================================================

/**
 * A navigation link item
 */
export interface SiteNavigationLink {
  label: string;
  href: string;
  icon?: string;
}

/**
 * Site navigation structure
 */
export interface SiteNavigation {
  /** Primary navigation links (header) */
  primary: SiteNavigationLink[];
  /** Footer navigation links */
  footer?: SiteNavigationLink[];
}

/**
 * Geographic location for the site
 */
export interface SiteLocation {
  /** Display name (e.g., "Bentley" or "Bentley, AB") */
  name: string;
  /** Latitude coordinate */
  latitude: number;
  /** Longitude coordinate */
  longitude: number;
  /** IANA timezone (e.g., "America/Edmonton") */
  timezone: string;
}

/**
 * Site theme/branding colors
 */
export interface SiteTheme {
  /** Primary brand color (hex) */
  primaryColor: string;
  /** Light variant of primary color */
  primaryLight?: string;
  /** Dark variant of primary color */
  primaryDark?: string;
}

/**
 * Publisher/organization information
 */
export interface SitePublisher {
  /** Organization name (e.g., "Blindman Press") */
  name: string;
  /** Organization website URL */
  url?: string;
  /** GitHub organization URL */
  github?: string;
}

/**
 * Site identity and configuration
 * Used by site templates to define site-specific settings
 */
export interface SiteConfig {
  /** Full site name (e.g., "Bentley Alberta") */
  name: string;
  /** Short name for mobile/compact displays */
  shortName?: string;
  /** Site description for SEO */
  description: string;
  /** Production URL */
  url?: string;
  /** Contact email for the site */
  contactEmail?: string;
  /** Publisher/organization info */
  publisher?: SitePublisher;
  /** Geographic location */
  location: SiteLocation;
  /** Navigation structure */
  navigation: SiteNavigation;
  /** Theme/branding */
  theme?: SiteTheme;
  /** Additional metadata */
  meta?: {
    /** Theme color for mobile browsers */
    themeColor?: string;
    /** Open Graph locale */
    ogLocale?: string;
    /** Google Tag Manager ID */
    gtmId?: string;
  };
}

// ============================================================================
// Main Configuration
// ============================================================================

/**
 * Main SMRT configuration structure
 */
export interface SmrtConfig {
  // Global SMRT framework options
  smrt?: SmrtGlobalConfig;

  // Site identity and configuration (for site templates)
  site?: SiteConfig;

  // Module-scoped configurations
  modules?: {
    [moduleName: string]: Record<string, unknown>;
  };

  // Package-scoped configurations
  packages?: {
    [packageName: string]: Record<string, unknown>;
  };
}

/**
 * Options for loading configuration
 */
export interface LoadConfigOptions {
  // Custom config file path (default: auto-detect in cwd)
  configPath?: string;

  // Search parent directories (default: true)
  searchParents?: boolean;

  // Cache loaded config (default: true)
  cache?: boolean;
}
