import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

/** Same-name inheritance is replacement only when storage is shared. Names alone never suffice. */
export function modelReplacements(
  manifest: SmartObjectManifest,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const [key, child] of Object.entries(manifest.objects)) {
    const parentKey = child.extendsQualified ?? child.extends;
    if (!parentKey?.includes(':') || parentKey === key) continue;
    const parent = manifest.objects[parentKey];
    if (!parent || parent.className !== child.className) continue;
    const parentTable =
      parent.schema?.tableName ?? parent.decoratorConfig?.tableName;
    const childTable =
      child.schema?.tableName ?? child.decoratorConfig?.tableName;
    if (!parentTable || childTable !== parentTable) continue;
    const previous = replacements.get(parentKey);
    if (previous && previous !== key) {
      throw new Error(
        `Sibling same-name model replacements for ${parentKey}: ${previous}, ${key}`,
      );
    }
    replacements.set(parentKey, key);
  }
  for (const [key, next] of replacements) {
    const seen = new Set([key]);
    let target = next;
    let following = replacements.get(target);
    while (following) {
      if (seen.has(target)) throw new Error(`Cyclic model replacement: ${key}`);
      seen.add(target);
      target = following;
      following = replacements.get(target);
    }
    replacements.set(key, target);
  }
  return replacements;
}

/** Retain declarations in the manifest for ancestry and schema provenance, with an explicit effective identity. */
export function annotateModelReplacements<M extends object>(manifest: M): M {
  const source = manifest as unknown as SmartObjectManifest;
  const replacements = modelReplacements(source);
  if (
    !replacements.size &&
    !Object.values(source.objects).some((obj) => obj.replacedBy)
  )
    return manifest;
  return {
    ...manifest,
    objects: Object.fromEntries(
      Object.entries(source.objects).map(([key, value]) => {
        const { replacedBy: _previous, ...declaration } = value;
        return [
          key,
          replacements.has(key)
            ? { ...declaration, replacedBy: replacements.get(key) }
            : declaration,
        ];
      }),
    ),
  };
}

/** Share a map within one synchronous selection; omit it to inspect the current mutable inventory. */
export function isReplacedModel(
  manifest: SmartObjectManifest,
  object: SmartObjectDefinition,
  replacements: ReadonlyMap<string, string> = modelReplacements(manifest),
): boolean {
  const key =
    object.qualifiedName ??
    (object.packageName
      ? `${object.packageName}:${object.className}`
      : undefined);
  return !!key && replacements.has(key);
}
