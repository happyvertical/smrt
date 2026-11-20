/**
 * A same-named subtype (`replaceParent: false`) is supported only in a family
 * that declares no tenancy (#5143).
 *
 * A same-named subtype shares its parent's table and simple name. Its family
 * is the subtype, its recorded same-named parents, every ancestor of those
 * (by declared `extends` and by constructor prototype), and the replacement
 * that took any of their keys. If any member carries tenancy (`tenantScoped`
 * of any value but `false`, including an unknown `mode`; a tenant field; a
 * `@TenantScoped()` declaration; or a run-time tenancy override), the subtype
 * is refused. Conversely, tenancy arriving on a member of a family that
 * already has a registered same-named subtype is refused. Both refusals are
 * `CONFIG_SAME_NAME_TENANCY_UNSUPPORTED`, raised before the registry changes,
 * so a family that holds a same-named subtype never filters its shared table
 * on more than one policy (it filters on none).
 */
import {
  declaresTenancy,
  sameNameSubclassChoice,
  sameNameTenancyUnsupported,
} from '../manifest/model-replacements.js';
import { findClass } from './name-resolver';
import { getRuntimeOverride } from './runtime-overrides';
import {
  getClasses,
  getConstructorIndex,
  getConstructorTenantScopedDeclarations,
} from './shared-state';
import {
  findReplacement,
  recordedSubtypeParent,
  recordedSubtypeParents,
  replacedDeclarations,
} from './subtype-lineage';
import type { RegisteredClass, SmrtObjectConstructor } from './types';

const FRAMEWORK_BASES = new Set(['SmrtObject', 'SmrtClass', 'SmrtCollection']);

/** Whether a registered or pending declaration carries tenancy of any kind. */
export function carriesTenancy(
  key: string | undefined,
  entry: RegisteredClass | undefined,
): boolean {
  if (key && getRuntimeOverride(key)?.tenancy) return true;
  if (!entry) return false;
  if (entry.qualifiedName && getRuntimeOverride(entry.qualifiedName)?.tenancy)
    return true;
  if (entry.tenantScopedConfig || declaresTenancy(entry.config?.tenantScoped))
    return true;
  if (entry.tenantScopedConfigSource === 'invalid-runtime-manifest-conflict')
    return true;
  if (
    getConstructorTenantScopedDeclarations().get(
      entry.constructor as SmrtObjectConstructor,
    )
  )
    return true;
  for (const field of entry.fields?.values() ?? [])
    if (
      field.__tenancy?.isTenantIdField === true ||
      field._meta?.__tenancy?.isTenantIdField === true
    )
      return true;
  return false;
}

/** The keys a declaration's parent may be registered under. */
function parentKeysOf(entry: RegisteredClass): string[] {
  const keys: string[] = [];
  const declared = entry.extends;
  if (declared && !FRAMEWORK_BASES.has(declared)) {
    keys.push(declared);
    if (!declared.includes(':')) {
      const resolved = findClass(declared, entry.packageName);
      if (resolved && resolved !== entry)
        keys.push(resolved.qualifiedName ?? resolved.name);
    }
  }
  if (entry.generatedParentConstructor) {
    const key = getConstructorIndex().get(entry.generatedParentConstructor);
    if (key) keys.push(key);
  }
  for (
    let proto = Object.getPrototypeOf(entry.constructor);
    typeof proto === 'function' && proto.name;
    proto = Object.getPrototypeOf(proto)
  ) {
    const key = getConstructorIndex().get(proto);
    if (key) {
      keys.push(key);
      break;
    }
  }
  return keys;
}

type FamilyStart = ReadonlyArray<
  readonly [key: string, entry: RegisteredClass | undefined]
>;

/**
 * Every member of the family reached upward from `start` (entries not yet
 * registered may be passed with their key), as `[key, entry]`; a key with no
 * registered entry is still visited, for its run-time override.
 */
function* familyMembers(
  start: FamilyStart,
): Generator<readonly [string, RegisteredClass | undefined]> {
  const seen = new Set<string>();
  const seenEntries = new Set<RegisteredClass>();
  const given = new Map<string, RegisteredClass[]>();
  for (const [key, entry] of start)
    if (entry) given.set(key, [...(given.get(key) ?? []), entry]);
  const pending = start.map(([key]) => key);
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    yield [key, undefined];
    const entries = [
      ...(given.get(key) ?? []),
      getClasses().get(key),
      replacedDeclarations().get(key),
      findReplacement(key),
    ];
    for (const entry of entries) {
      if (!entry || seenEntries.has(entry)) continue;
      seenEntries.add(entry);
      yield [entry.qualifiedName ?? key, entry];
      pending.push(...parentKeysOf(entry));
      if (entry.qualifiedName) {
        pending.push(entry.qualifiedName);
        const recorded = recordedSubtypeParent(entry.qualifiedName);
        if (recorded) pending.push(recorded);
      }
    }
    const recorded = recordedSubtypeParent(key);
    if (recorded) pending.push(recorded);
  }
}

/** The key of the first member of the family that carries tenancy. */
function familyTenancyOwner(start: FamilyStart): string | undefined {
  for (const [key, entry] of familyMembers(start))
    if (carriesTenancy(key, entry)) return key;
  return undefined;
}

/**
 * Refuse the same-named subtype `subtypeKey` of `parentKey` when its family
 * carries tenancy anywhere. Called when registration recognises the pair, in
 * either load order, before either side is stored; pass the side that is
 * registering as its pending entry.
 */
export function assertSameNameSubtypeUntenanted(
  subtypeKey: string,
  subtype: RegisteredClass | undefined,
  parentKey: string,
  parent?: RegisteredClass,
): void {
  if (subtype?.collectionOf || parent?.collectionOf) return;
  const owner = familyTenancyOwner([
    [parentKey, parent],
    [subtypeKey, subtype],
  ]);
  if (owner) throw sameNameTenancyUnsupported(subtypeKey, parentKey, owner);
}

/**
 * Refuse tenancy that `declaringKey` brings to any of `keys` (its registry
 * keys, and for a replacement the key it takes over) when the family of a
 * registered same-named subtype includes one of them.
 */
export function assertTenancyAdmitted(
  declaringKey: string,
  keys: Iterable<string | undefined>,
): void {
  const pairs = recordedSubtypeParents();
  if (pairs.size === 0) return;
  const wanted = new Set<string>();
  for (const key of keys) if (key) wanted.add(key);
  for (const [childKey, parentKey] of pairs) {
    const child =
      getClasses().get(childKey) ?? replacedDeclarations().get(childKey);
    if (
      !child ||
      child.collectionOf ||
      sameNameSubclassChoice(child.config) !== 'subtype'
    )
      continue;
    for (const [key] of familyMembers([[childKey, child]]))
      if (wanted.has(key))
        throw sameNameTenancyUnsupported(childKey, parentKey, declaringKey);
  }
}
