import { TemplateConfig, TemplateSource } from '../loaders/index.js';
export interface GeneratorOptions {
    template: string;
    name: string;
    outputDir: string;
}
/**
 * Generate project from template
 */
export declare function generate(source: TemplateSource, config: TemplateConfig, options: GeneratorOptions): Promise<void>;
//# sourceMappingURL=generator.d.ts.map