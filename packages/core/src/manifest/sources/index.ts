/**
 * Release B manifest-source abstraction (issue #1133).
 *
 * Six concrete sources live under this directory. The composite in
 * `composite.ts` queries them in historical priority order and is the
 * primary entry point the registry's discovery paths delegate to.
 */

export {
  CompositeManifestSource,
  defaultSources,
  getDefaultCompositeSource,
  resetDefaultCompositeSource,
} from './composite.js';
export { EmbeddedManifestSource } from './embedded.js';
export { ExplicitPathsManifestSource } from './explicit-paths.js';
export { NodeModulesFallbackSource } from './fallback.js';
export { LocalTestManifestSource } from './local-test.js';
export { StaticManifestSource } from './static.js';
export { TestManifestSource } from './test.js';
export type {
  ManifestEntry,
  ManifestLookupQuery,
  ManifestSource,
} from './types.js';
export { manifestEntriesOf, matchManifest, materializeEntry } from './types.js';
