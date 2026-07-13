import type { SmartObjectDefinition } from '@happyvertical/smrt-core';
import { getPackageFromQualifiedName } from '@happyvertical/smrt-core';

/**
 * Resolve the package that owns one manifest entry.
 *
 * Aggregate consumer manifests contain dependency entries alongside local
 * objects. Entry-level provenance must win over the containing manifest so
 * those dependencies retain their qualified registry identities.
 */
export function resolveManifestEntryPackageName(
  name: string,
  definition: SmartObjectDefinition,
  fallback?: string,
): string | undefined {
  // Only explicit entry provenance may override the containing manifest.
  // Qualified keys and qualifiedName are identity values that runtime:check
  // validates, so neither may let a malformed local entry reclassify itself
  // as external when the container already has an owner.
  return (
    definition.packageName ||
    fallback ||
    getPackageFromQualifiedName(name) ||
    (definition.qualifiedName
      ? getPackageFromQualifiedName(definition.qualifiedName)
      : undefined)
  );
}
