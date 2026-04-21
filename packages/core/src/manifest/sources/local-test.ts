/**
 * LocalTestManifestSource — wraps `__smrtManifestLocalTest`, the test
 * manifest that vitest's setup populates with the domain package under test.
 *
 * Highest priority in the composite in test environments. In production the
 * global is undefined and every lookup/entries call is inert.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { getLocalTestManifestCache } from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
  matchManifest,
  materializeEntry,
} from './types.js';

export class LocalTestManifestSource implements ManifestSource {
  readonly name = 'local-test';

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    const manifest = getLocalTestManifestCache();
    if (!manifest) return undefined;

    const def = matchManifest(manifest, query);
    if (!def) return undefined;
    return materializeEntry(def, manifest, this.name);
  }

  *entries(): Iterable<ManifestEntry> {
    yield* manifestEntriesOf(getLocalTestManifestCache(), this.name);
  }
}
