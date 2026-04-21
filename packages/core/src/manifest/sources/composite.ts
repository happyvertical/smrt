/**
 * CompositeManifestSource — queries a priority-ordered list of sources on
 * behalf of the registry's discovery entry points. Preserves the historical
 * priority from `discoverCachedManifestSync` and `discoverManifestSync`:
 *
 *   1. LocalTestManifestSource   (test env only)
 *   2. TestManifestSource        (test env only)
 *   3. StaticManifestSource      (smrt-core's bundled manifest)
 *   4. EmbeddedManifestSource    (packages' own manifests; Release A)
 *   5. NodeModulesFallbackSource (async fs-walk when everything else misses)
 *
 * Reordering is **out of scope** for Release B — any change to this order
 * is a behavior change that needs its own tests.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { EmbeddedManifestSource } from './embedded.js';
import { NodeModulesFallbackSource } from './fallback.js';
import { LocalTestManifestSource } from './local-test.js';
import { StaticManifestSource } from './static.js';
import { TestManifestSource } from './test.js';
import type {
  ManifestEntry,
  ManifestLookupQuery,
  ManifestSource,
} from './types.js';

export class CompositeManifestSource implements ManifestSource {
  readonly name = 'composite';
  private readonly sources: ManifestSource[];

  constructor(sources?: ManifestSource[]) {
    this.sources = sources ?? defaultSources();
  }

  lookup(query: ManifestLookupQuery): ManifestEntry | undefined {
    for (const source of this.sources) {
      const hit = source.lookup(query);
      if (hit) return hit;
    }
    return undefined;
  }

  *entries(): Iterable<ManifestEntry> {
    const seen = new Set<string>();
    for (const source of this.sources) {
      for (const entry of source.entries()) {
        const key = entry.qualifiedName ?? entry.className;
        if (seen.has(key)) continue;
        seen.add(key);
        yield entry;
      }
    }
  }

  async hydrate(hint: {
    packageName?: string;
    className?: string;
  }): Promise<boolean> {
    for (const source of this.sources) {
      if (source.hydrate && (await source.hydrate(hint))) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Historical priority order. Call sites that need a one-off composite should
 * construct their own via `new CompositeManifestSource([...])`; the default
 * is a module-scoped singleton to minimize garbage.
 */
export function defaultSources(): ManifestSource[] {
  return [
    new LocalTestManifestSource(),
    new TestManifestSource(),
    new StaticManifestSource(),
    new EmbeddedManifestSource(),
    new NodeModulesFallbackSource(),
  ];
}

// Module-scoped default instance. Constructed once at first access.
let defaultCompositeInstance: CompositeManifestSource | undefined;

export function getDefaultCompositeSource(): CompositeManifestSource {
  if (!defaultCompositeInstance) {
    defaultCompositeInstance = new CompositeManifestSource();
  }
  return defaultCompositeInstance;
}

/** Used by tests to reset the cached default singleton between runs. */
export function resetDefaultCompositeSource(): void {
  defaultCompositeInstance = undefined;
}
