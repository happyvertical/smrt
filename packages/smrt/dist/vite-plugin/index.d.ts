import { Plugin } from 'vite';
import { SmartObjectManifest } from '../scanner/types';
export interface SmrtPluginOptions {
    /** Glob patterns for SMRT source files */
    include?: string[];
    /** Patterns to exclude */
    exclude?: string[];
    /** Output directory for generated files */
    outDir?: string;
    /** Enable hot module replacement */
    hmr?: boolean;
    /** Watch for file changes */
    watch?: boolean;
    /** Generate types */
    generateTypes?: boolean;
    /** Custom base classes to scan for */
    baseClasses?: string[];
    /** Directory to write TypeScript declarations (relative to project root) */
    typeDeclarationsPath?: string;
    /** Plugin execution mode - controls Node.js vs browser compatibility */
    mode?: 'server' | 'client' | 'auto';
    /** Pre-generated manifest for client mode (avoids file scanning) */
    staticManifest?: SmartObjectManifest;
    /** Path to static manifest file for client mode */
    manifestPath?: string;
    /** SvelteKit route auto-generation options */
    svelteKit?: {
        /** Enable SvelteKit route generation (default: false) */
        enabled: boolean;
        /** Output directory for generated routes (default: 'src/routes/api') */
        routesDir?: string;
        /** Directory containing SMRT objects (default: 'src/lib/objects') */
        objectsDir?: string;
        /** Directory for configuration file (default: 'src/lib/server') */
        configPath?: string;
        /** Configuration file name (default: 'smrt.ts') */
        configFileName?: string;
    };
}
export declare function smrtPlugin(options?: SmrtPluginOptions): Plugin;
//# sourceMappingURL=index.d.ts.map