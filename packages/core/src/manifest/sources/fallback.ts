/**
 * NodeModulesFallbackSource — fallback fs-walking discovery for consumer
 * runtimes that somehow skipped Release A's self-registration (e.g., a
 * package that didn't wire up `__smrt-register__.ts`, a subpath import
 * that bypassed the main entry, or a bundle that tree-shook the shim).
 *
 * `lookup()` always returns undefined — this source never has entries
 * proactively. `hydrate({ packageName })` walks `node_modules` (or the
 * workspace) and seeds `__smrtManifestCache` via
 * `loadExternalManifestSyncWithNode()`; subsequent lookups then hit
 * `EmbeddedManifestSource`.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import {
  getManifestCache,
  getNodeBuiltins,
  loadExternalManifestSyncWithNode,
} from '../store.js';
import {
  type ManifestEntry,
  type ManifestLookupQuery,
  type ManifestSource,
  manifestEntriesOf,
} from './types.js';

export class NodeModulesFallbackSource implements ManifestSource {
  readonly name = 'node-modules-fallback';

  /**
   * This source never returns hits from `lookup` — its job is to populate
   * the embedded cache via `hydrate`, so that the composite's second pass
   * through `EmbeddedManifestSource.lookup` can succeed. That preserves the
   * historical order (EmbeddedManifestSource sees package manifests first,
   * NodeModulesFallbackSource only does the fs-walk when asked).
   */
  lookup(_query: ManifestLookupQuery): ManifestEntry | undefined {
    return undefined;
  }

  /**
   * Enumerates every manifest currently sitting in the embedded cache. Does
   * NOT walk node_modules up front — that only happens when `hydrate` is
   * invoked with a specific package name or the legacy
   * `loadAllManifests()` path calls `discoverInstalledSmrtPackages()` first.
   */
  *entries(): Iterable<ManifestEntry> {
    const cache = getManifestCache();
    for (const manifest of cache.values()) {
      yield* manifestEntriesOf(manifest, this.name);
    }
  }

  async hydrate(hint: {
    packageName?: string;
    className?: string;
  }): Promise<boolean> {
    if (hint.packageName) {
      const loaded = loadExternalManifestSyncWithNode(hint.packageName, {
        warn: false,
      });
      if (loaded) return true;
    }

    // No package hint → scan every installed @happyvertical/smrt-* package.
    // This is the Release A fallback for bundled consumers that registered
    // classes without preserving package identity.
    if (hint.className && !hint.packageName) {
      const scoped = await this.scanAllInstalled();
      return scoped > 0;
    }

    return false;
  }

  private async scanAllInstalled(): Promise<number> {
    const builtins = getNodeBuiltins();
    if (!builtins) return 0;

    const scopeDir = builtins.path.join(
      process.cwd(),
      'node_modules',
      '@happyvertical',
    );
    if (!builtins.fs.existsSync(scopeDir)) return 0;

    const packages = builtins.fs
      .readdirSync(scopeDir)
      .filter((name: string) => name.startsWith('smrt-'));

    let loaded = 0;
    for (const dir of packages) {
      const packageName = `@happyvertical/${dir}`;
      if (loadExternalManifestSyncWithNode(packageName, { warn: false })) {
        loaded += 1;
      }
    }
    return loaded;
  }
}
