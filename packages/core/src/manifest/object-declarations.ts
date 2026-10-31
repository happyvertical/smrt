/**
 * Manifest -> generated object-type declaration selection.
 *
 * Every emitter of the per-object `XData` row interfaces (the physical
 * `smrt-objects.d.ts` / `smrt-types.d.ts` prebuild files, the Vite ambient
 * `virtual-modules.d.ts`, the `@smrt/types` virtual module in server and client
 * mode, and the consumer fallback module) reads this selection, so they agree
 * on how many declarations exist and in which order.
 *
 * A declaration describes one CLASS, not one manifest listing. An aggregated
 * consumer manifest can list one class several times: when workspace libraries
 * are built, each library that consumes another package's model scans that
 * model's source under its own package name (#3110), so the class appears once
 * under its declaring package and again under every consumer package. Those
 * listings name the same declaring source file and class with the same fields,
 * so they collapse to a single declaration (#3296). Listings without an
 * absolute source path, or whose fields disagree, cannot be proven to be the
 * same class and keep one declaration each.
 *
 * Pure and dependency-free: the scanner, the Vite plugin, the consumer plugin
 * and the prebuild CLI all import it.
 */

import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

/** One generated object-type declaration and the listings it describes. */
export interface ObjectDeclaration {
  /** Interface name emitted for the class's row payload, e.g. `ProductData`. */
  interfaceName: string;
  /**
   * The listing the declaration is rendered from: the first listing in
   * deterministic qualified-identity order. Every collapsed listing has the
   * same fields, so the choice never changes the rendered declaration.
   */
  obj: SmartObjectDefinition;
  /** Manifest key of {@link obj}. */
  manifestKey: string;
  /** Every manifest key that names this class, in qualified-identity order. */
  manifestKeys: string[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSourcePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function isAbsoluteSourcePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:\//.test(filePath);
}

/** JSON with object keys sorted at every depth, for structural comparison. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareText)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The identity of the class a manifest listing describes.
 *
 * Two listings are the same class only when they name the same class in the
 * same absolute declaring source file AND describe the same fields. A path is
 * only machine-local evidence (separately built packages can share a
 * `/app/src/...` layout), so the field shape the declaration is rendered from
 * must agree too: listings that collapse always render identical
 * declarations, and a stale or unrelated listing stays separate instead of
 * silently supplying (or losing) fields. A relative `filePath` is relative to
 * whichever root scanned it, so two equal relative paths from different
 * packages may be different files; such listings fall back to their qualified
 * name (or manifest key), which keeps them distinct.
 */
export function objectDeclarationIdentity(
  manifestKey: string,
  obj: SmartObjectDefinition,
): string {
  const filePath =
    typeof obj.filePath === 'string' ? normalizeSourcePath(obj.filePath) : '';
  if (filePath && isAbsoluteSourcePath(filePath)) {
    return `source\0${filePath}\0${obj.className}\0${canonicalJson(obj.fields ?? {})}`;
  }
  return `listing\0${obj.qualifiedName || manifestKey}`;
}

/**
 * Manifest entries in the deterministic qualified-identity order every
 * declaration emitter shares (#2749): qualified name (or manifest key), then
 * manifest key.
 */
function orderedEntries(
  manifest: SmartObjectManifest,
): Array<[string, SmartObjectDefinition]> {
  return Object.entries(manifest.objects ?? {}).sort(
    ([leftKey, left], [rightKey, right]) =>
      compareText(
        left.qualifiedName || leftKey,
        right.qualifiedName || rightKey,
      ) || compareText(leftKey, rightKey),
  );
}

/**
 * Select one declaration per class described by the manifest, in deterministic
 * qualified-identity order of each class's first listing.
 */
export function selectObjectDeclarations(
  manifest: SmartObjectManifest,
): ObjectDeclaration[] {
  const byIdentity = new Map<string, ObjectDeclaration>();
  for (const [manifestKey, obj] of orderedEntries(manifest)) {
    const identity = objectDeclarationIdentity(manifestKey, obj);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.manifestKeys.push(manifestKey);
      continue;
    }
    byIdentity.set(identity, {
      interfaceName: `${obj.className}Data`,
      obj,
      manifestKey,
      manifestKeys: [manifestKey],
    });
  }
  return [...byIdentity.values()];
}
