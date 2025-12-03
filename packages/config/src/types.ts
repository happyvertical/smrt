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
