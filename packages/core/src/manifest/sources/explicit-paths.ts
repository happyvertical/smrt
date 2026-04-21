/**
 * ExplicitPathsManifestSource — powers
 * `ObjectRegistry.loadAllManifests({ manifestPaths })`, which the
 * `full-registry-integration.test.ts` harness depends on (issue #1008).
 *
 * Constructed with an explicit array of manifest.json paths. Loads each one
 * eagerly at construction time so subsequent `lookup`/`entries` calls are
 * pure Map access. Seeds `__smrtManifestCache` as a side effect so later
 * lookups through the default composite's EmbeddedManifestSource also hit.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import type { SmartObjectManifest } from '../../scanner/types.js';
import { loadManifestFromPathSyncWithNode } from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
  matchManifest,
  materializeEntry,
} from './types.js';

export class ExplicitPathsManifestSource implements ManifestSource {
  readonly name = 'explicit-paths';
  private readonly manifests: SmartObjectManifest[];

  constructor(paths: string[]) {
    this.manifests = paths
      .map((path) => loadManifestFromPathSyncWithNode(path))
      .filter((m): m is SmartObjectManifest => m !== null);
  }

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    for (const manifest of this.manifests) {
      const def = matchManifest(manifest, query);
      if (def) return materializeEntry(def, manifest, this.name);
    }
    return undefined;
  }

  *entries(): Iterable<ManifestEntry> {
    for (const manifest of this.manifests) {
      yield* manifestEntriesOf(manifest, this.name);
    }
  }
}
