/** Qualified manifest lineage outlives registrations replaced by descendants. */

import { ConfigurationError } from '../errors';
import { sameNameSubclassChoice } from '../manifest/model-replacements.js';
import { getRegistryGeneration } from './generation';
import { transferRuntimeOverride } from './runtime-overrides';
import { getClasses, getInheritanceCache } from './shared-state';
import type { RegisteredClass } from './types';

declare global {
  var __smrtRuntimeCoexisting: Set<string> | undefined;
  var __smrtSubtypeParents: Map<string, string> | undefined;
  var __smrtReplacedDeclarations: Map<string, RegisteredClass> | undefined;
}
/** Keep declared bases for inheritance; I/O resolves their effective replacement. */
export function replacedDeclarations(): Map<string, RegisteredClass> {
  globalThis.__smrtReplacedDeclarations ??= new Map();
  return globalThis.__smrtReplacedDeclarations;
}
export function retainReplacedDeclaration(
  key: string,
  entry: RegisteredClass,
): void {
  replacedDeclarations().set(key, {
    ...entry,
    fields: new Map(entry.fields),
    methods: new Map(entry.methods),
  });
}
let replacementGeneration = -1;
let replacementIndex = new Map<string, RegisteredClass>();
export function findReplacement(key: string): RegisteredClass | undefined {
  const generation = getRegistryGeneration();
  if (generation !== replacementGeneration) {
    replacementIndex = new Map();
    for (const entry of getClasses().values()) {
      for (const previous of entry.replacedQualifiedNames ?? []) {
        replacementIndex.set(previous, entry);
      }
    }
    replacementGeneration = generation;
  }
  return replacementIndex.get(key);
}
function parents(): Map<string, string> {
  globalThis.__smrtSubtypeParents ??= new Map();
  return globalThis.__smrtSubtypeParents;
}
/**
 * Registry keys of run-time models (`registerRuntimeModel`) that extend a
 * registered class without `replaces`: they coexist with that class by their
 * own definition, so a later registration of the class never asks them for a
 * `replaceParent` declaration (#5143).
 */
export function runtimeCoexistingModels(): Set<string> {
  globalThis.__smrtRuntimeCoexisting ??= new Set();
  return globalThis.__smrtRuntimeCoexisting;
}
export function clearSubtypeLineage(): void {
  parents().clear();
  replacedDeclarations().clear();
  runtimeCoexistingModels().clear();
}

/** Test registry snapshots restore lineage that ObjectRegistry.clear() drops. */
export function snapshotSubtypeLineage(): () => void {
  const links = new Map(parents());
  const declarations = new Map(replacedDeclarations());
  return () => {
    globalThis.__smrtSubtypeParents = new Map(links);
    globalThis.__smrtReplacedDeclarations = new Map(declarations);
  };
}

/** Roll back only the edited identities, retaining unrelated registrations. */
export function checkpointSubtypeLineage(
  names: ReadonlySet<string>,
): () => void {
  const links = new Map([...names].map((name) => [name, parents().get(name)]));
  const declarations = new Map(
    [...names].map((name) => [name, replacedDeclarations().get(name)]),
  );
  return () => {
    for (const [name, parent] of links)
      if (parent) parents().set(name, parent);
      else parents().delete(name);
    for (const [name, declaration] of declarations)
      if (declaration) replacedDeclarations().set(name, declaration);
      else replacedDeclarations().delete(name);
  };
}
export function recordSubtypeParent(
  name: string,
  parent: string | undefined,
): void {
  if (!parent?.includes(':') || parent === name) return;
  if (name.split(':').at(-1) !== parent.split(':').at(-1)) return;
  if (isSubtypeOf(parent, name)) {
    throw ConfigurationError.circularInheritance(name, [name, parent]);
  }
  parents().set(name, parent);
}
/** The same-named qualified parent recorded for `name`, if any. */
export function recordedSubtypeParent(name: string): string | undefined {
  return parents().get(name);
}
export function isSubtypeOf(child: string, ancestor: string): boolean {
  const visited = new Set<string>();
  for (
    let next = parents().get(child);
    next && !visited.has(next);
    next = parents().get(next)
  ) {
    if (next === ancestor) return true;
    visited.add(next);
  }
  return false;
}
/**
 * Whether the registered class under `key` is a same-named subtype served
 * through its parent's generated surface (#5143): it declares
 * `replaceParent: false`, its recorded same-named parent is registered on the
 * same table, and it declares no `collection` of its own. The run-time
 * generators skip such a class, as the manifest-driven ones do
 * (`isReplacedModel`), so the shared simple name names one surface.
 */
export function servedThroughParent(key: string): boolean {
  const entry = getClasses().get(key);
  return (
    !!entry &&
    typeof entry.config?.collection !== 'string' &&
    isSameNameSubtype(key, entry)
  );
}

/**
 * The name a run-time generator gives the class under `key` its route,
 * tools, commands and schema by (#5143): `undefined` for a same-named subtype
 * served through its parent, the declared `collection` for a same-named
 * subtype that declares one (its simple name is its parent's), and the
 * simple name otherwise.
 */
export function generatedSurfaceName(key: string): string | undefined {
  const entry = getClasses().get(key);
  if (!entry) return undefined;
  if (!isSameNameSubtype(key, entry)) return entry.name || key;
  const collection = entry.config?.collection;
  return typeof collection === 'string' ? collection : undefined;
}

/**
 * A `replaceParent: false` class whose recorded same-named parent shares its
 * table, or a replacement of such a subtype: the replacement takes the
 * subtype's place, so the base still owns the shared surface (#5143).
 */
function isSameNameSubtype(
  key: string,
  entry: RegisteredClass,
  seen = new Set<string>(),
): boolean {
  if (entry.collectionOf || seen.has(key)) return false;
  seen.add(key);
  const choice = sameNameSubclassChoice(entry.config);
  if (choice === 'replace') {
    // Whether or not the subtype declared a collection: the replacement
    // carries it (its configuration starts from the subtype's), so it keeps
    // the subtype's named surface or its service through the base.
    return (entry.replacedQualifiedNames ?? []).some((replaced) => {
      const declaration = replacedDeclarations().get(replaced);
      return !!declaration && isSameNameSubtype(replaced, declaration, seen);
    });
  }
  if (choice !== 'subtype') return false;
  const parentKey = parents().get(entry.qualifiedName ?? key);
  if (!parentKey) return false;
  const parent = getClasses().get(parentKey) ?? findReplacement(parentKey);
  return !!parent && parent.schema?.tableName === entry.schema?.tableName;
}

/**
 * Whether `child` replaces `ancestor`: every same-named class on the recorded
 * path from `child` up to `ancestor` declares `replaceParent: true` (#5143).
 * Ancestry alone never replaces: a class that declares `replaceParent: false`
 * is a subtype, and so is everything that only reaches `ancestor` through it.
 */
export function replacesAncestor(child: string, ancestor: string): boolean {
  const visited = new Set<string>();
  for (let current = child; !visited.has(current); ) {
    visited.add(current);
    const parent = parents().get(current);
    if (!parent) return false;
    const entry =
      getClasses().get(current) ?? replacedDeclarations().get(current);
    if (sameNameSubclassChoice(entry?.config) !== 'replace') return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}

/**
 * Late intermediate manifests can connect a previously disjoint parent/leaf.
 * Only a declared replacement (`replacesAncestor`) removes its parent, so a
 * same-named subtype keeps the pair registered in every load order.
 */
export function reconcileSubtypeLineage(): void {
  if (parents().size === 0) return;
  const classes = getClasses();
  // Only a recorded child can replace a parent. Avoid allocating a group for
  // every unrelated class on every registration in a large cookbook.
  const names = new Set<string>();
  for (const key of parents().keys()) {
    const child = classes.get(key);
    if (child) names.add(child.name);
  }
  const groups = new Map<string, Array<[string, RegisteredClass]>>();
  for (const pair of classes) {
    if (!names.has(pair[1].name)) continue;
    const group = groups.get(pair[1].name) ?? [];
    group.push(pair);
    groups.set(pair[1].name, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const [childKey, child] of group) {
      for (const [parentKey, parent] of group) {
        if (
          !classes.has(childKey) ||
          !classes.has(parentKey) ||
          childKey === parentKey ||
          child.name !== parent.name ||
          child.schema?.tableName !== parent.schema?.tableName ||
          !replacesAncestor(childKey, parentKey)
        )
          continue;
        child.replacedQualifiedNames = [
          ...new Set([
            ...(child.replacedQualifiedNames ?? []),
            parentKey,
            ...(parent.replacedQualifiedNames ?? []),
          ]),
        ];
        transferRuntimeOverride(parentKey, childKey);
        retainReplacedDeclaration(parentKey, parent);
        classes.delete(parentKey);
        getInheritanceCache().clear();
        child.inheritanceChain = undefined;
        child.inheritedFields = undefined;
        child.inheritedMethods = undefined;
      }
    }
  }
}
