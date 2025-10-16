import { TemplateConfig } from './template-loader.js';
/**
 * Resolve local path to absolute path
 *
 * Handles:
 * - Relative paths (./path, ../path)
 * - Absolute paths (/path)
 * - Home directory (~/)
 *
 * Includes path traversal protection to prevent malicious paths
 */
export declare function resolveLocalPath(localPath: string): Promise<string>;
/**
 * Load template configuration from local directory
 */
export declare function loadLocalTemplate(resolvedPath: string): Promise<TemplateConfig>;
//# sourceMappingURL=local-loader.d.ts.map