/**
 * StaticManifestSource — wraps `__smrtManifestStatic`, smrt-core's own
 * bundled manifest. Third priority in the composite, matching the historical
 * order of `discoverCachedManifestSync` and `discoverManifestSync`.
 *
 * The underlying cache is seeded by `loadStaticManifestSyncWithNode()` on
 * first read, so the first lookup after startup may touch disk. Subsequent
 * lookups are cache hits.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { loadStaticManifestSyncWithNode } from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
  matchManifest,
  materializeEntry,
} from './types.js';

export class StaticManifestSource implements ManifestSource {
  readonly name = 'static';

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    const manifest = loadStaticManifestSyncWithNode();
    if (!manifest) return undefined;

    const def = matchManifest(manifest, query);
    if (!def) return undefined;
    return materializeEntry(def, manifest, this.name);
  }

  *entries(): Iterable<ManifestEntry> {
    yield* manifestEntriesOf(loadStaticManifestSyncWithNode(), this.name);
  }
}
