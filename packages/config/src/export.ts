/**
 * Config export utilities for static site generation
 *
 * These utilities enable exporting database-backed agent configurations
 * to static files for SSG sites.
 *
 * @module
 */

/**
 * Patterns that identify sensitive configuration keys
 * Keys matching these patterns will be filtered out during sanitization
 */
const SECRET_PATTERNS = [
  /apiKey/i,
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /private/i,
  /\bauth\b/i,
  /\bkey\b$/i,
];

/**
 * Check if a key matches any secret pattern
 */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Deep clone and sanitize a config object, removing any secret values
 *
 * @param config - Configuration object to sanitize
 * @returns Sanitized config with secrets removed
 *
 * @example
 * ```typescript
 * const config = {
 *   apiEndpoint: 'https://api.example.com',
 *   apiKey: 'sk-secret-123',
 *   nested: {
 *     password: 'hunter2',
 *     name: 'test'
 *   }
 * };
 *
 * const sanitized = sanitizeConfig(config);
 * // {
 * //   apiEndpoint: 'https://api.example.com',
 * //   nested: { name: 'test' }
 * // }
 * ```
 */
export function sanitizeConfig(config: unknown): unknown {
  if (config === null || config === undefined) {
    return config;
  }

  if (Array.isArray(config)) {
    return config.map((item) => sanitizeConfig(item));
  }

  if (typeof config === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
      // Skip keys that match secret patterns
      if (isSecretKey(key)) {
        continue;
      }

      // Recursively sanitize nested objects
      result[key] = sanitizeConfig(value);
    }

    return result;
  }

  // Primitive values pass through unchanged
  return config;
}

/**
 * Options for config export
 */
export interface ExportConfigOptions {
  /**
   * Include secrets in the export (use with caution!)
   * @default false
   */
  includeSecrets?: boolean;

  /**
   * Output format
   * - 'json': Plain JSON format
   * - 'js': ES module format (export default)
   * @default 'json'
   */
  format?: 'json' | 'js';

  /**
   * Number of spaces for indentation
   * @default 2
   */
  indent?: number;
}

/**
 * Export a configuration object to a string
 *
 * @param config - Configuration object to export
 * @param options - Export options
 * @returns Formatted config string
 *
 * @example
 * ```typescript
 * // Export as JSON
 * const jsonExport = exportConfig(config);
 *
 * // Export as JS module
 * const jsExport = exportConfig(config, { format: 'js' });
 *
 * // Export with secrets (for secure environments)
 * const fullExport = exportConfig(config, { includeSecrets: true });
 * ```
 */
export function exportConfig(
  config: unknown,
  options: ExportConfigOptions = {},
): string {
  const { includeSecrets = false, format = 'json', indent = 2 } = options;

  // Sanitize unless secrets are explicitly requested
  const exportData = includeSecrets ? config : sanitizeConfig(config);

  const jsonString = JSON.stringify(exportData, null, indent);

  if (format === 'js') {
    return `export default ${jsonString};\n`;
  }

  return jsonString;
}

/**
 * Parse an exported config string back to an object
 *
 * @param content - Exported config string (JSON format)
 * @returns Parsed configuration object
 */
export function parseExportedConfig(content: string): unknown {
  // Handle JS module format (strip export default and trailing semicolon)
  const trimmed = content.trim();
  if (trimmed.startsWith('export default')) {
    const jsonPart = trimmed
      .replace(/^export default\s*/, '')
      .replace(/;\s*$/, '');
    return JSON.parse(jsonPart);
  }

  // Plain JSON
  return JSON.parse(content);
}

/**
 * Merge exported config with file-based config
 *
 * This enables the pattern:
 * ```javascript
 * // smrt.config.js
 * import exported from './smrt.exported.json' with { type: 'json' };
 *
 * export default {
 *   modules: {
 *     praeco: {
 *       ...exported,
 *       apiEndpoint: process.env.API_URL, // override with env
 *     }
 *   }
 * };
 * ```
 *
 * @param baseConfig - Base configuration (usually from file)
 * @param exportedConfig - Exported configuration from DB
 * @returns Merged configuration
 */
export function mergeExportedConfig<T extends Record<string, unknown>>(
  baseConfig: T,
  exportedConfig: Partial<T>,
): T {
  const result = { ...baseConfig };

  for (const [key, value] of Object.entries(exportedConfig)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Deep merge objects
      (result as Record<string, unknown>)[key] = mergeExportedConfig(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      // Override primitive values and arrays
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}
