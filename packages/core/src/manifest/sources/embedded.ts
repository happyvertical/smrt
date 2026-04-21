/**
 * EmbeddedManifestSource — wraps `__smrtManifestCache`, populated by each
 * package's `registerPackageManifest()` shim (Release A, #1132).
 *
 * Fourth priority in the composite. Iterates every cached manifest in turn,
 * matching the historical behavior of `discoverCachedManifestSync`.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { getManifestCache } from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
  matchManifest,
  materializeEntry,
} from './types.js';

export class EmbeddedManifestSource implements ManifestSource {
  readonly name = 'embedded';

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    const cache = getManifestCache();

    // If we have a package hint, try that manifest directly before scanning.
    if (query.packageName) {
      const scoped = cache.get(query.packageName);
      if (scoped) {
        const def = matchManifest(scoped, query);
        if (def) return materializeEntry(def, scoped, this.name);
      }
    }

    for (const manifest of cache.values()) {
      const def = matchManifest(manifest, query);
      if (def) return materializeEntry(def, manifest, this.name);
    }
    return undefined;
  }

  *entries(): Iterable<ManifestEntry> {
    const cache = getManifestCache();
    for (const manifest of cache.values()) {
      yield* manifestEntriesOf(manifest, this.name);
    }
  }
}
