import { Plugin } from 'vite';
export interface SmrtConsumerOptions {
    /** SMRT packages to scan (e.g., ['@my-org/products', '@my-org/content']) */
    packages?: string[];
    /** Generate TypeScript declarations */
    generateTypes?: boolean;
    /** Output directory for generated types */
    typesDir?: string;
    /** Project root path */
    projectRoot?: string;
    /** SvelteKit integration mode */
    svelteKit?: boolean;
    /** Use static types only (for federation builds) */
    staticTypes?: boolean;
    /** Disable file scanning */
    disableScanning?: boolean;
}
/**
 * Consumer plugin for projects that use SMRT packages
 */
export declare function smrtConsumer(options?: SmrtConsumerOptions): Plugin;
//# sourceMappingURL=index.d.ts.map