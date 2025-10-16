import { TemplateConfig } from './template-loader.js';
/**
 * Resolve npm package path to template configuration
 *
 * Examples:
 * - @happyvertical/praeco/templates/sveltekit
 * - @org/templates
 * - my-template-package
 */
export declare function resolveNpmPackage(packagePath: string): Promise<string>;
/**
 * Load template configuration from npm package
 */
export declare function loadNpmTemplate(resolvedPath: string): Promise<TemplateConfig>;
/**
 * Find template by short name in installed packages
 *
 * Searches for:
 * - Scoped packages with templates directory
 * - Scoped packages direct
 * - Unscoped packages
 */
export declare function findTemplateInPackages(shortName: string): Promise<string | null>;
/**
 * Discover all templates in installed packages
 *
 * Useful for `smrt gnode list-templates` command
 */
export declare function discoverInstalledTemplates(): Promise<Array<{
    name: string;
    source: string;
    config: TemplateConfig;
}>>;
//# sourceMappingURL=npm-loader.d.ts.map