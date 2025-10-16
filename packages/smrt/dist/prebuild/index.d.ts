import { SmartObjectManifest } from '../scanner/types';
export interface PrebuildOptions {
    /** Path to manifest file or manifest object */
    manifest: string | SmartObjectManifest;
    /** Output directory for generated types */
    outDir: string;
    /** Include virtual module declarations */
    includeVirtualModules?: boolean;
    /** Include object type definitions */
    includeObjectTypes?: boolean;
    /** Project root path for resolving relative paths */
    projectRoot?: string;
}
/**
 * Generate TypeScript declaration files from SMRT manifest
 */
export declare function generateDeclarations(options: PrebuildOptions): Promise<void>;
/**
 * CLI command for generating declarations
 */
export declare function generateDeclarationsFromCLI(args: string[]): Promise<void>;
//# sourceMappingURL=index.d.ts.map