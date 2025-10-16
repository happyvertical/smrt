import { TemplateConfig } from './template-loader.js';
/**
 * Load template from git repository
 */
export declare function loadGitTemplate(gitUrl: string): Promise<TemplateConfig>;
/**
 * Get the template directory path (for copying overlay files)
 */
export declare function getGitTemplateDir(config: TemplateConfig): string;
/**
 * Cleanup temporary directory after template is used
 */
export declare function cleanupGitTemplate(config: TemplateConfig): Promise<void>;
//# sourceMappingURL=git-loader.d.ts.map