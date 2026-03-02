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

/** Return `true` when `key` matches any of the {@link SECRET_PATTERNS}. */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Deep-clone a config object, removing every key that looks like a secret.
 *
 * Keys are tested against the following case-insensitive patterns:
 * `apiKey`, `password`, `secret`, `token`, `credential`, `private`, `auth`
 * (word boundary), and any key ending with `key`.
 * Nested objects are recursively sanitized; arrays are mapped element-by-element.
 * Primitive values (`string`, `number`, `boolean`) pass through unchanged.
 *
 * This function is called automatically by {@link exportConfig} unless
 * `includeSecrets: true` is passed.
 *
 * @param config - Value to sanitize. Accepts any JSON-serializable structure.
 * @returns A new value with all secret keys omitted. `null` / `undefined` are
 *   returned as-is.
 *
 * @example
 * ```ts
 * const sanitized = sanitizeConfig({
 *   apiEndpoint: 'https://api.example.com',
 *   apiKey: 'sk-secret-123',
 *   nested: { password: 'hunter2', name: 'test' },
 * });
 * // => { apiEndpoint: 'https://api.example.com', nested: { name: 'test' } }
 * ```
 *
 * @see {@link exportConfig}
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
 * Options accepted by {@link exportConfig}.
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
 * Serialize a configuration object to a formatted string for SSG file output.
 *
 * By default, {@link sanitizeConfig} is applied before serialization to strip
 * any keys that match secret patterns (API keys, passwords, tokens, etc.).
 * Pass `includeSecrets: true` only in secured server-side contexts.
 *
 * @param config - Configuration object to export. Any JSON-serializable value.
 * @param options - Format, indentation, and secret-inclusion options.
 * @returns A JSON string, or an ES module string (`export default {...};\n`)
 *   when `format: 'js'`.
 *
 * @example
 * ```ts
 * // Write a sanitized JSON export file for SSG
 * const json = exportConfig(agentConfig);
 * await fs.writeFile('./public/config.json', json);
 * ```
 *
 * @example
 * ```ts
 * // ES module format (importable via `import config from './config.js'`)
 * const js = exportConfig(agentConfig, { format: 'js' });
 * ```
 *
 * @see {@link sanitizeConfig}
 * @see {@link parseExportedConfig}
 * @see {@link ExportConfigOptions}
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
 * Parse a config string previously produced by {@link exportConfig} back into
 * a plain JavaScript object.
 *
 * Handles both output formats:
 * - **JSON** — standard `JSON.parse`.
 * - **JS module** — strips the `export default` prefix and trailing semicolon
 *   before parsing as JSON.
 *
 * Throws a `SyntaxError` if the content is not valid JSON after stripping.
 *
 * @param content - Exported config string (`'json'` or `'js'` format).
 * @returns Parsed configuration value.
 *
 * @example
 * ```ts
 * const raw = await fs.readFile('./smrt.exported.json', 'utf8');
 * const config = parseExportedConfig(raw);
 * ```
 *
 * @see {@link exportConfig}
 * @see {@link mergeExportedConfig}
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
 * Shallow-merge an exported (DB-backed) config into a base (file-backed) config.
 *
 * Object values are deep-merged recursively. Primitive values and arrays from
 * `exportedConfig` replace their counterparts in `baseConfig`. This is a
 * one-level-smarter spread that lets file-based env overrides win when placed
 * after the spread.
 *
 * Intended for the SSG pattern where an agent exports its runtime config to a
 * static JSON file and `smrt.config.js` imports it as a base:
 *
 * @example
 * ```js
 * // smrt.config.js
 * import exported from './smrt.exported.json' with { type: 'json' };
 *
 * export default defineConfig({
 *   modules: {
 *     praeco: mergeExportedConfig(exported, {
 *       apiEndpoint: process.env.API_URL, // env override wins
 *     }),
 *   },
 * });
 * ```
 *
 * @param baseConfig - Lower-priority base (typically from the DB export file).
 * @param exportedConfig - Higher-priority overrides (typically env / file-based).
 * @returns A new merged object of type `T`.
 *
 * @see {@link exportConfig}
 * @see {@link parseExportedConfig}
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
