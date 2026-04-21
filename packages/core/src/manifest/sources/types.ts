/**
 * ManifestSource abstraction — Release B consolidation of the four
 * overlapping discovery paths into a single pluggable interface.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { parseQualifiedName } from '../../utils/qualified-names.js';
import { lookupCachedManifestEntry } from '../store.js';

/**
 * Inputs for a source lookup. Package- or qualified-name context wins over
 * a bare simple name: implementations MUST prefer a qualified-name or
 * package-scoped match when the query carries one, matching the historical
 * semantics of `discoverManifestEntry()` in manifest-loader.ts.
 *
 * This is the contract that lets multi-package same-simple-name scenarios
 * (issue #951) resolve to the right manifest entry when the caller has
 * package identity available.
 */
export interface ManifestLookupQuery {
  /** Simple class name. Always provided. */
  className: string;
  /** Package name for disambiguation. Preferred when caller has it. */
  packageName?: string;
  /** Fully qualified name (`@pkg:Class`). Takes precedence over className+packageName. */
  qualifiedName?: string;
}

/** A manifest entry produced by a source, with provenance for diagnostics. */
export interface ManifestEntry {
  className: string;
  qualifiedName?: string;
  def: SmartObjectDefinition;
  packageName?: string;
  /** Which source (by `name`) produced this entry. */
  source: string;
}

/**
 * A cached or on-demand source of manifest entries.
 *
 * Four historical paths collapse onto this: `discoverManifestSync` (decorator-
 * time sync lookup), `discoverManifestEntry` (async field hydration),
 * `tryLoadFromExternalPackage` (async lazy load), and the cache lookups that
 * were duplicated across both registry.ts and manifest-loader.ts.
 */
export interface ManifestSource {
  /** Human-readable name for logging and diagnostics. */
  readonly name: string;

  /**
   * Synchronous lookup. Must be a cache hit or a cheap sync fs read.
   * Returns undefined when the source does not have the requested entry.
   */
  lookup(query: ManifestLookupQuery): ManifestEntry | undefined;

  /**
   * Enumerate every entry this source currently knows about. Used by the
   * `loadAllManifests` replacement to register everything upfront, and by
   * parity tests.
   */
  entries(): Iterable<ManifestEntry>;

  /**
   * Optional async hydration from a caller-provided hint. Used when a sync
   * `lookup` misses but the caller has a package name or class name the
   * source could try to populate itself from. Returns true when the source
   * was successfully populated.
   */
  hydrate?(hint: {
    packageName?: string;
    className?: string;
  }): Promise<boolean>;
}

/**
 * Probe a single manifest for a lookup query, honoring the query's
 * qualified-name / package-scoped preference before falling back to simple
 * name matching. Used by every source that wraps one or more
 * `SmartObjectManifest` values.
 */
export function matchManifest(
  manifest: SmartObjectManifest | null | undefined,
  query: ManifestLookupQuery,
): SmartObjectDefinition | undefined {
  if (!manifest?.objects) return undefined;

  // If the query carries package context, treat a mismatch as a hard miss.
  // This is what preserves issue-#951's multi-package-same-simple-name
  // semantics: an `@other/pkg:Widget` query must not resolve to
  // `@acme/pkg:Widget` just because their simple names collide.
  const queryPackage =
    query.packageName ??
    (query.qualifiedName
      ? parseQualifiedName(query.qualifiedName).packageName
      : undefined);

  if (queryPackage) {
    if (manifest.packageName && manifest.packageName !== queryPackage) {
      // Wrong package. The only way to match is a direct qualified-key
      // lookup (for aggregated manifests that contain cross-package entries).
      if (query.qualifiedName && manifest.objects[query.qualifiedName]) {
        return manifest.objects[query.qualifiedName] as SmartObjectDefinition;
      }
      return undefined;
    }

    // Right package (or manifest packageName unset). Prefer direct keys.
    if (query.qualifiedName) {
      const direct = manifest.objects[query.qualifiedName];
      if (direct) return direct as SmartObjectDefinition;
    }
    const qualified = `${queryPackage}:${query.className}`;
    const scoped = manifest.objects[qualified];
    if (scoped) return scoped as SmartObjectDefinition;
  }

  // No package context, or package matched but no qualified hit: fall back
  // to the lenient simple-name lookup that matches pre-Release-B behavior.
  return lookupCachedManifestEntry(
    manifest,
    query.qualifiedName ?? query.className,
  );
}

/**
 * Build a full ManifestEntry around a raw SmartObjectDefinition produced
 * by `matchManifest`, attaching provenance and qualified-name derivation.
 */
export function materializeEntry(
  def: SmartObjectDefinition,
  manifest: SmartObjectManifest | null | undefined,
  sourceName: string,
): ManifestEntry {
  const className = def.className ?? '';
  const packageName = def.packageName ?? manifest?.packageName;
  const qualifiedName =
    packageName && className ? `${packageName}:${className}` : undefined;
  return {
    className,
    qualifiedName,
    def,
    packageName,
    source: sourceName,
  };
}

/**
 * Convert a raw manifest's objects record into ManifestEntry iteration.
 * Shared by every source that wraps a `SmartObjectManifest`.
 */
export function* manifestEntriesOf(
  manifest: SmartObjectManifest | null | undefined,
  sourceName: string,
): Iterable<ManifestEntry> {
  if (!manifest?.objects) {
    return;
  }
  const packageName = manifest.packageName;
  for (const [key, def] of Object.entries(manifest.objects)) {
    if (!def) continue;
    const className = (def as SmartObjectDefinition).className ?? key;
    const qualifiedName = key.includes(':')
      ? key
      : packageName
        ? `${packageName}:${className}`
        : undefined;
    yield {
      className,
      qualifiedName,
      def: def as SmartObjectDefinition,
      packageName,
      source: sourceName,
    };
  }
}
