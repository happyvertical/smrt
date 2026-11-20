import { ConfigurationError } from '../errors.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

/**
 * What a class that extends a same-named class from another package says it
 * is (#5143): a replacement of that parent, or a subtype registered next to
 * it. The class declares it as `replaceParent` in its own `@smrt()` options,
 * which the manifest carries in `decoratorConfig`.
 */
export type SameNameSubclassChoice = 'replace' | 'subtype';

export const SAME_NAME_SUBCLASS_UNDECLARED =
  'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED';
export const SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR =
  'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR';
export const SAME_NAME_REPLACEMENT_TABLE_MISMATCH =
  'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH';
export const SAME_NAME_SUBTYPE_TABLE_MISMATCH =
  'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH';
export const SAME_NAME_PARENT_UNREGISTERED =
  'CONFIG_SAME_NAME_PARENT_UNREGISTERED';

/**
 * A class that declares `replaceParent` registered before the same-named
 * class it extends. It must register after it (its constructor or its
 * manifest declaration), so what it inherits never depends on load order.
 * `parentKey` is the qualified parent when the declaration names one;
 * `choice` says whether the child replaces its parent or is a subtype of it.
 */
export function sameNameParentUnregistered(
  child: string,
  parentClass: string | undefined,
  parentKey?: string,
  choice?: SameNameSubclassChoice,
): ConfigurationError {
  const parent = parentKey ?? parentClass ?? 'the class it extends';
  const role = choice === 'subtype' ? 'subtype' : 'replacement';
  return new ConfigurationError(
    `${child} declares replaceParent, but the same-named class it extends is not registered yet: ` +
      `register ${parent} before its ${role} ${child}, or import ${parent}'s module first. ` +
      `Under generated activation, regenerate the activation manifest. If ${child} extends no class of its own name, remove replaceParent.`,
    SAME_NAME_PARENT_UNREGISTERED,
    { className: child, parentClass, ...(parentKey ? { parentKey } : {}) },
  );
}

/** A same-named subtype on another table than its single-table parent. */
export function sameNameSubtypeTableMismatch(
  child: string,
  parent: string,
  childTable: string,
  parentTable: string,
): ConfigurationError {
  return new ConfigurationError(
    `${child} declares replaceParent: false, but stores rows in "${childTable}" while its single-table parent ${parent} uses "${parentTable}". ` +
      `A same-named subtype shares its parent's table: remove the tableName from ${child}, or rename ${child} to keep it a separate model.`,
    SAME_NAME_SUBTYPE_TABLE_MISMATCH,
    { className: child, parentName: parent, childTable, parentTable },
  );
}

export const SAME_NAME_TENANCY_UNSUPPORTED =
  'CONFIG_SAME_NAME_TENANCY_UNSUPPORTED';

/**
 * Whether a `tenantScoped` value declares tenancy. Only an absent value or
 * `false` declares none: `true`, any options object and any other value,
 * including one with an unknown `mode`, count as tenancy.
 */
export function declaresTenancy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * A same-named subtype (`replaceParent: false`) in a family that carries
 * tenancy (#5143). A same-named subtype shares its parent's table and simple
 * name, and is supported only in a family where no member declares tenancy:
 * not the subtype, its parent, the parent's replacement, any ancestor, nor a
 * run-time override. `tenancyOwner` is the declaration that carries it (the
 * subtype itself when it declares tenancy of its own).
 */
export function sameNameTenancyUnsupported(
  subtype: string,
  parent: string,
  tenancyOwner: string,
): ConfigurationError {
  const carrier =
    tenancyOwner === subtype
      ? `${subtype} declares tenancy itself`
      : `its family declares tenancy on ${tenancyOwner}`;
  return new ConfigurationError(
    `${subtype} declares replaceParent: false as a subtype of ${parent}, but ${carrier}: ` +
      `a same-named subtype is supported only in a family that declares no tenancy. ` +
      `Give ${subtype} a class name of its own (a differently named subclass inherits its parent's tenancy), ` +
      `or declare replaceParent: true to replace ${parent}.`,
    SAME_NAME_TENANCY_UNSUPPORTED,
    { className: subtype, parentName: parent, tenancyOwner },
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
  if (config?.replaceParent === false) return 'subtype';
  return undefined;
}

/** A class that must declare the choice and did not. */
export function sameNameSubclassUndeclared(
  child: string,
  parent: string,
): ConfigurationError {
  return new ConfigurationError(
    `${child} extends ${parent}, a class of the same name from another package, without saying which it is. ` +
      `Add replaceParent to the @smrt() options of ${child}: ` +
      `replaceParent: true makes it replace ${parent} (one model on the parent's table; the parent's qualified name and aliases resolve to it), ` +
      `replaceParent: false registers it as a subtype of ${parent} under its own qualified name.`,
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

/**
 * A same-named subtype of a parent whose family is not single-table
 * inheritance. A subtype is an STI subtype of its parent, told apart from it
 * by the `_meta_type` discriminator; a plain parent has none.
 */
export function sameNameSubtypeWithoutDiscriminator(
  child: string,
  parent: string,
  tableName: string | undefined,
): ConfigurationError {
  return new ConfigurationError(
    `${child} declares replaceParent: false, but its parent ${parent} is not a single-table-inheritance model: ` +
      `a same-named subtype is registered as an STI subtype of its parent${tableName ? ` in "${tableName}"` : ''}, and ${parent} has no discriminator to tell their rows apart. ` +
      `Declare replaceParent: true on ${child} to replace ${parent}, or rename ${child}.`,
    SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR,
    { className: child, parentName: parent, tableName },
  );
}

/** A replacement that resolves another table than the parent it replaces. */
export function sameNameReplacementTableMismatch(
  child: string,
  parent: string,
  childTable: string | undefined,
  parentTable: string | undefined,
  parentIsSti = false,
): ConfigurationError {
  // replaceParent: false is only open over a single-table-inheritance
  // parent; over any other a separate model needs its own name.
  const alternative = parentIsSti
    ? `or declare replaceParent: false to register it as a subtype of ${parent}`
    : `or rename ${child} to keep it a separate model (${parent} is not single-table inheritance, so replaceParent: false is refused too)`;
  return new ConfigurationError(
    `${child} declares replaceParent: true, but stores rows in "${childTable}" while ${parent} uses "${parentTable}". ` +
      `A replacement shares its parent's table: remove the tableName from ${child}, ${alternative}.`,
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

/** Whether a manifest entry declares tenancy: `tenantScoped`, or a tenant field. */
export function objectDeclaresTenancy(object: SmartObjectDefinition): boolean {
  if (declaresTenancy(object.decoratorConfig?.tenantScoped)) return true;
  return Object.values(object.fields ?? {}).some(
    (field) =>
      (field as { __tenancy?: { isTenantIdField?: unknown } }).__tenancy
        ?.isTenantIdField === true ||
      field._meta?.__tenancy?.isTenantIdField === true,
  );
}

/**
 * The key of the first entry that declares tenancy in the family of the
 * same-named subtype `subtypeKey`, as far as this manifest tells (#5143): the
 * subtype, each ancestor along its declared parents, and every replacement of
 * any of them. `undefined` when none does.
 */
function manifestFamilyTenancyOwner(
  manifest: SmartObjectManifest,
  pairs: readonly SameNamePair[],
  subtypeKey: string,
): string | undefined {
  const seen = new Set<string>();
  const pending = [subtypeKey];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const pair of pairs)
      if (pair.choice === 'replace' && pair.parentKey === key)
        pending.push(pair.key);
    const entry = manifest.objects[key];
    if (!entry) continue;
    if (objectDeclaresTenancy(entry)) return key;
    const parent = entry.extendsQualified ?? entry.extends;
    if (parent)
      pending.push(
        parent.includes(':') || !entry.packageName
          ? parent
          : `${entry.packageName}:${parent}`,
      );
  }
  return undefined;
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

/**
 * A framework base class (`SmrtObject`, ...). The walk reaches one by its
 * qualified key or, for a manifest that records `extends: 'SmrtObject'`, by
 * the simple name prefixed with the child's package; either way the caller
 * only asks once the manifest has no entry under that key.
 */
function isFrameworkRoot(key: string, unqualified: boolean): boolean {
  const className = simpleNameOf(key);
  // A qualified reference names its package: only the framework's own
  // package makes it the framework base (`@vendor/models:SmrtReport` is a
  // foreign model whose family is not known here).
  const packageName = unqualified
    ? undefined
    : key.slice(0, Math.max(0, key.lastIndexOf(':')));
  return FRAMEWORK_PACKAGES.some(
    (frameworkPackage) =>
      (packageName === undefined || packageName === frameworkPackage) &&
      isFrameworkBaseClass(className, frameworkPackage),
  );
}
const FRAMEWORK_PACKAGES = [
  '@happyvertical/smrt-core',
  '@happyvertical/smrt-reports',
] as const;

/**
 * Whether the family of `key` is single-table inheritance, as far as this
 * manifest can tell: `undefined` when an ancestor is not in the manifest.
 */
function familyHasDiscriminator(
  manifest: SmartObjectManifest,
  key: string,
): boolean | undefined {
  const seen = new Set<string>();
  // Whether `next` came from a simple-name `extends` the walk qualified.
  let unqualified = false;
  for (let next: string | undefined = key; next && !seen.has(next); ) {
    seen.add(next);
    const entry: SmartObjectDefinition | undefined = manifest.objects[next];
    // A framework base (`SmrtObject`, ...) is a family root, never an
    // unknown dependency: reaching one means no class declared STI.
    if (!entry) return isFrameworkRoot(next, unqualified) ? false : undefined;
    if (entry.decoratorConfig?.tableStrategy === 'sti') return true;
    if (entry.decoratorConfig?.tableStrategy === 'cti') return false;
    const parent: string | undefined = entry.extendsQualified ?? entry.extends;
    if (!parent) return false;
    unqualified = !parent.includes(':');
    next = !unqualified
      ? parent
      : entry.packageName
        ? `${entry.packageName}:${parent}`
        : parent;
  }
  return false;
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
 * Refuse a manifest whose same-named cross-package subclasses do not say what
 * they are, or say something their storage cannot honour (#5143). Manifest
 * generation runs it (`annotateModelReplacements`), so a package's own build
 * reports a class that declares nothing, whether or not the manifest also
 * carries its parent.
 *
 * - no `replaceParent`: `CONFIG_SAME_NAME_SUBCLASS_UNDECLARED`;
 * - `replaceParent: false` on a parent whose family is not single-table
 *   inheritance: `CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR` (an
 *   ancestor outside this manifest defers the check to registration;
 *   collections store nothing and are exempt);
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
  const pairs = sameNamePairs(manifest);
  for (const { key, child, parentKey, choice } of pairs) {
    const name = child.qualifiedName ?? key;
    if (!choice) {
      requireSameNameSubclassChoice(name, parentKey, child.decoratorConfig);
      continue;
    }
    if (choice === 'subtype' && !child.collectionOf) {
      const tenancyOwner = manifestFamilyTenancyOwner(manifest, pairs, key);
      if (tenancyOwner)
        throw sameNameTenancyUnsupported(
          name,
          parentKey,
          tenancyOwner === key ? name : tenancyOwner,
        );
    }
    const parent = manifest.objects[parentKey];
    if (!parent) continue;
    const parentTable = tableOf(parent);
    if (choice === 'subtype') {
      if (child.collectionOf || parent.collectionOf) continue;
      if (familyHasDiscriminator(manifest, parentKey) === false) {
        throw sameNameSubtypeWithoutDiscriminator(name, parentKey, parentTable);
      }
      // Registration binds a subtype that names no table to its parent's and
      // refuses one that names another (#5143); refuse that one here too.
      const childTable = tableOf(child);
      if (parentTable && childTable && childTable !== parentTable)
        throw sameNameSubtypeTableMismatch(
          name,
          parentKey,
          childTable,
          parentTable,
        );
      continue;
    }
    const childTable = tableOf(child);
    if (parentTable && childTable !== parentTable) {
      throw sameNameReplacementTableMismatch(
        name,
        parentKey,
        childTable,
        parentTable,
        familyHasDiscriminator(manifest, parentKey) === true,
      );
    }
  }
}

/**
 * Parent → effective replacement, from each subclass's declared
 * `replaceParent: true` on its parent's table. A name match alone never
 * replaces: a same-named subclass that declares `replaceParent: false`, or
 * nothing (refused at build by `assertSameNameSubclassChoices`), is not a
 * replacement.
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
 * Same-named subtype → the parent whose generated surface addresses it. A
 * subtype that declares `replaceParent: false` shares its parent's simple
 * name, so a route segment, tool name or row type derived from that name
 * would be the parent's. It gets none of its own unless it declares its own
 * `collection`.
 */
export function sameNameSubtypes(
  manifest: SmartObjectManifest,
): Map<string, string> {
  const subtypes = new Map<string, string>();
  for (const { key, child, parentKey, choice } of sameNamePairs(manifest)) {
    if (choice !== 'subtype' || child.decoratorConfig?.collection) continue;
    const parent = manifest.objects[parentKey];
    if (!parent || tableOf(parent) !== tableOf(child)) continue;
    subtypes.set(child.qualifiedName ?? key, parentKey);
  }
  return subtypes;
}

/**
 * Retain declarations in the manifest for ancestry and schema provenance, with
 * an explicit effective identity. Manifest generation calls it, so it first
 * refuses undeclared or impossible same-named subclasses
 * (`assertSameNameSubclassChoices`).
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

/**
 * Whether an entry has no generated surface of its own: a parent replaced by
 * its declared replacement, or a same-named subtype addressed through its
 * parent's surface. Share a map within one synchronous selection; omit it to
 * inspect the current mutable inventory.
 */
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
  if (!key) return false;
  if (replacements.has(key)) return true;
  if (object.decoratorConfig?.collection) return false;
  // A replacement of a served subtype takes its place: walk the declared
  // replacements to the class it ultimately stands in for (#5143).
  const seen = new Set<string>();
  let currentKey: string = key;
  let current: SmartObjectDefinition | undefined = object;
  while (current && !seen.has(currentKey)) {
    seen.add(currentKey);
    const parentKey = sameNameParentKey(currentKey, current);
    if (!parentKey) return false;
    const choice = sameNameSubclassChoice(current.decoratorConfig);
    const parent: SmartObjectDefinition | undefined =
      manifest.objects[parentKey];
    if (choice === 'subtype')
      return !!parent && tableOf(parent) === tableOf(current);
    if (choice !== 'replace' || parent?.decoratorConfig?.collection)
      return false;
    currentKey = parentKey;
    current = parent;
  }
  return false;
}
