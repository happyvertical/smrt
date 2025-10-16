/**
 * Template Loader - Resolves and loads templates from various sources
 *
 * Supports:
 * - npm packages (@org/pkg/templates/name)
 * - Git repositories (github:user/repo, https://github.com/user/repo.git)
 * - Local filesystem paths (../path/to/template, /absolute/path)
 */
export interface TemplateConfig {
    name: string;
    description: string;
    framework: string;
    baseGenerator?: {
        command: string;
        args: string[];
        skipPrompts?: boolean;
    };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
}
export interface TemplateSource {
    type: 'npm' | 'git' | 'local';
    location: string;
    resolved: string;
}
/**
 * Resolve a template name to a specific source
 *
 * @param name - Template name or path
 *   - @org/pkg/templates/name (npm package)
 *   - github:user/repo (git shorthand)
 *   - https://github.com/user/repo.git (git URL)
 *   - ../path/to/template (local path)
 *   - short-name (searches installed packages)
 *
 * @returns Template source information
 */
export declare function resolveTemplate(name: string): Promise<TemplateSource>;
/**
 * Load template configuration from resolved source
 */
export declare function loadTemplate(source: TemplateSource): Promise<TemplateConfig>;
//# sourceMappingURL=template-loader.d.ts.map