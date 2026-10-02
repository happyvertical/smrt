/** Qualified manifest lineage outlives registrations replaced by descendants. */

import { ConfigurationError } from '../errors';
import { transferRuntimeOverride } from './runtime-overrides';
import { getClasses, getInheritanceCache } from './shared-state';
import type { RegisteredClass } from './types';

declare global {
  var __smrtSubtypeParents: Map<string, string> | undefined;
}
function parents(): Map<string, string> {
  globalThis.__smrtSubtypeParents ??= new Map();
  return globalThis.__smrtSubtypeParents;
}
export function clearSubtypeLineage(): void {
  parents().clear();
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
/** Late intermediate manifests can connect a previously disjoint parent/leaf. */
export function reconcileSubtypeLineage(): void {
  const classes = getClasses();
  const groups = new Map<string, Array<[string, RegisteredClass]>>();
  for (const pair of classes) {
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
          !isSubtypeOf(childKey, parentKey)
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
        classes.delete(parentKey);
        getInheritanceCache().clear();
        child.inheritanceChain = undefined;
        child.inheritedFields = undefined;
        child.inheritedMethods = undefined;
      }
    }
  }
}
