import { SmartObjectManifest } from '../scanner/types';
export interface SvelteKitOptions {
    enabled: boolean;
    routesDir: string;
    objectsDir: string;
    configPath?: string;
    configFileName?: string;
}
/**
 * Generates SvelteKit API routes from manifest
 */
export declare function generateSvelteKitRoutes(projectRoot: string, manifest: SmartObjectManifest, options: SvelteKitOptions): Promise<void>;
//# sourceMappingURL=sveltekit-generator.d.ts.map