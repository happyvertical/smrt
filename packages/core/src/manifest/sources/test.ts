/**
 * TestManifestSource — wraps `__smrtManifestTest`, the core-package test
 * manifest populated by the vitest setup when running smrt-core's own tests.
 *
 * Second priority in the composite in test environments. Inert in production.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { getTestManifestCache, shouldLoadCoreTestManifest } from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
  matchManifest,
  materializeEntry,
} from './types.js';

export class TestManifestSource implements ManifestSource {
  readonly name = 'test';

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    if (!shouldLoadCoreTestManifest()) return undefined;
    const manifest = getTestManifestCache();
    if (!manifest) return undefined;

    const def = matchManifest(manifest, query);
    if (!def) return undefined;
    return materializeEntry(def, manifest, this.name);
  }

  *entries(): Iterable<ManifestEntry> {
    if (!shouldLoadCoreTestManifest()) return;
    yield* manifestEntriesOf(getTestManifestCache(), this.name);
  }
}
