/**
 * Static manifest module for runtime use
 * Uses pre-generated manifest from build time instead of runtime scanning
 */
export { staticManifest as manifest, staticManifest as default, } from './static-manifest';
export type { SmartObjectManifest, SmartObjectDefinition, } from '../scanner/types';
export { ManifestGenerator } from '../scanner/manifest-generator';
/**
 * Get manifest data (static at runtime)
 * No longer requires TypeScript compiler or file scanning
 */
export declare function getManifest(): Promise<import('.').SmartObjectManifest>;
//# sourceMappingURL=index.d.ts.map