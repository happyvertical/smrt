import { ConfigurationError } from '../errors.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

/**
 * What a class that extends a same-named class from another package says it
 * is (#5143), as `replaceParent` in its own `@smrt()` options (the manifest
 * carries it in `decoratorConfig`): `'replace'` for `replaceParent: true`, a
 * replacement of that parent. Anything else declares no replacement.
 */
export type SameNameSubclassChoice = 'replace';

export const SAME_NAME_SUBCLASS_UNDECLARED =
  'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED';
export const SAME_NAME_REPLACEMENT_TABLE_MISMATCH =
  'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH';
export const SAME_NAME_PARENT_UNREGISTERED =
  'CONFIG_SAME_NAME_PARENT_UNREGISTERED';

/**
 * A class that declares `replaceParent` registered before the same-named
 * class it extends. It must register after it (its constructor or its
 * manifest declaration), so what it inherits never depends on load order.
 * `parentKey` is the qualified parent when the declaration names one.
 */
export function sameNameParentUnregistered(
  child: string,
  parentClass: string | undefined,
  parentKey?: string,
): ConfigurationError {
  const parent = parentKey ?? parentClass ?? 'the class it extends';
  return new ConfigurationError(
    `${child} declares replaceParent, but the same-named class it extends is not registered yet: ` +
      `register ${parent} before its replacement ${child}, or import ${parent}'s module first. ` +
      `Under generated activation, regenerate the activation manifest. If ${child} extends no class of its own name, remove replaceParent.`,
    SAME_NAME_PARENT_UNREGISTERED,
    { className: child, parentClass, ...(parentKey ? { parentKey } : {}) },
  );
}

/**
 * The one reading of the declared choice. Manifest generation, both
 * registration paths and lineage reconciliation all decide replacement
 * through this function: nothing infers it from package names, the working
 * directory, file paths or load order.
 */
export function sameNameSubclassChoice(
  config: { replaceParent?: unknown } | null | undefined,
): SameNameSubclassChoice | undefined {
  if (config?.replaceParent === true) return 'replace';
  return undefined;
}

/** A class that must declare the choice and did not. */
export function sameNameSubclassUndeclared(
  child: string,
  parent: string,
): ConfigurationError {
  return new ConfigurationError(
    `${child} extends ${parent}, a class of the same name from another package, without declaring replaceParent. ` +
      `Add replaceParent: true to the @smrt() options of ${child} to make it replace ${parent} ` +
      `(one model on the parent's table; the parent's qualified name and aliases resolve to it), ` +
      `or give ${child} a different class name to keep it a separate model.`,
    SAME_NAME_SUBCLASS_UNDECLARED,
    { className: child, parentName: parent },
  );
}

/** The declared choice, or the error for a class that has to declare one. */
export function requireSameNameSubclassChoice(
  child: string,
  parent: string,
  config: { replaceParent?: unknown } | null | undefined,
): SameNameSubclassChoice {
  const choice = sameNameSubclassChoice(config);
  if (!choice) throw sameNameSubclassUndeclared(child, parent);
  return choice;
}

/** A replacement that resolves another table than the parent it replaces. */
export function sameNameReplacementTableMismatch(
  child: string,
  parent: string,
  childTable: string | undefined,
  parentTable: string | undefined,
): ConfigurationError {
  return new ConfigurationError(
    `${child} declares replaceParent: true, but stores rows in "${childTable}" while ${parent} uses "${parentTable}". ` +
      `A replacement shares its parent's table: remove the tableName from ${child}, or give ${child} a different class name to keep it a separate model.`,
    SAME_NAME_REPLACEMENT_TABLE_MISMATCH,
    { className: child, parentName: parent, childTable, parentTable },
  );
}

function simpleNameOf(key: string): string {
  return key.slice(key.lastIndexOf(':') + 1);
}

function tableOf(object: SmartObjectDefinition): string | undefined {
  return object.schema?.tableName ?? object.decoratorConfig?.tableName;
}

/**
 * The qualified parent of an entry that extends a class of its own simple
 * name from another package: the pair the declared choice governs. Only an
 * import-qualified parent counts, so a parent the scanner could not verify
 * as a model of another package asks for nothing here.
 */
export function sameNameParentKey(
  key: string,
  object: SmartObjectDefinition,
): string | undefined {
  const parentKey = object.extendsQualified ?? object.extends;
  if (!parentKey?.includes(':') || parentKey === key) return undefined;
  return simpleNameOf(parentKey) === object.className ? parentKey : undefined;
}

interface SameNamePair {
  key: string;
  child: SmartObjectDefinition;
  parentKey: string;
  choice: SameNameSubclassChoice | undefined;
}

/** Every same-named cross-package subclass in the manifest, with what it declares. */
function sameNamePairs(manifest: SmartObjectManifest): SameNamePair[] {
  const pairs: SameNamePair[] = [];
  for (const [key, child] of Object.entries(manifest.objects)) {
    const parentKey = sameNameParentKey(key, child);
    if (!parentKey) continue;
    pairs.push({
      key,
      child,
      parentKey,
      choice: sameNameSubclassChoice(child.decoratorConfig),
    });
  }
  return pairs;
}

/**
 * Refuse a manifest whose same-named cross-package subclasses are not
 * declared replacements, or declare a replacement their storage cannot honour
 * (#5143). Manifest generation runs it (`annotateModelReplacements`), and so
 * does generated activation before it resolves any module, so a package's own
 * build reports such a class whether or not the manifest also carries its
 * parent, and nothing is published for it.
 *
 * - no `replaceParent: true`: `CONFIG_SAME_NAME_SUBCLASS_UNDECLARED`;
 * - `replaceParent: true` on another table than the parent's:
 *   `CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH`.
 *
 * A run-time manifest projected from the registry is not validated here: its
 * decorated classes were checked when they registered, and a run-time model
 * (`registerRuntimeModel`) states replacement through its own `replaces`.
 */
export function assertSameNameSubclassChoices(
  manifest: SmartObjectManifest,
): void {
  for (const { key, child, parentKey } of sameNamePairs(manifest)) {
    const name = child.qualifiedName ?? key;
    requireSameNameSubclassChoice(name, parentKey, child.decoratorConfig);
    const parent = manifest.objects[parentKey];
    if (!parent) continue;
    const parentTable = tableOf(parent);
    const childTable = tableOf(child);
    if (parentTable && childTable !== parentTable) {
      throw sameNameReplacementTableMismatch(
        name,
        parentKey,
        childTable,
        parentTable,
      );
    }
  }
}

/**
 * Parent → effective replacement, from each subclass's declared
 * `replaceParent: true` on its parent's table. A name match alone never
 * replaces: a same-named subclass that declares anything else (refused at
 * build by `assertSameNameSubclassChoices`) is not a replacement.
 */
export function modelReplacements(
  manifest: SmartObjectManifest,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const { key, child, parentKey, choice } of sameNamePairs(manifest)) {
    if (choice !== 'replace') continue;
    const parent = manifest.objects[parentKey];
    if (!parent) continue;
    // Collections and other entries without a table have no storage to share.
    const parentTable = tableOf(parent);
    if (!parentTable || tableOf(child) !== parentTable) continue;
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

/**
 * Retain declarations in the manifest for ancestry and schema provenance, with
 * an explicit effective identity. Manifest generation calls it, so it first
 * refuses same-named subclasses that are not declared replacements, or whose
 * replacement is impossible (`assertSameNameSubclassChoices`).
 */
export function annotateModelReplacements<M extends object>(manifest: M): M {
  const source = manifest as unknown as SmartObjectManifest;
  assertSameNameSubclassChoices(source);
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
