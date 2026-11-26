/**
 * Effective sensitivity and run-time-model checks for security ceilings
 * (#5196). The guest caller ceiling asks these questions about a class before
 * it lets an unauthenticated caller near its table.
 *
 * @module
 */

import {
  isChangeFeedSensitiveTable,
  isChangeFeedSensitiveWrite,
} from './change-feed-sensitivity.js';
import {
  getEffectiveFieldsSync,
  getInheritanceChain,
} from './registry/inheritance-resolver.js';
import type { RegisteredClass } from './registry/types.js';
import { ObjectRegistry } from './registry.js';

function lookup(name: string): RegisteredClass | undefined {
  return (
    ObjectRegistry.getClass(name) ??
    ObjectRegistry.findClassesByName(name)[0] ??
    undefined
  );
}

/** True when the class was registered by `registerRuntimeModel()`. */
export function isRuntimeModelClass(name: string): boolean {
  return lookup(name)?.runtimeModel === true;
}

function fieldIsSensitive(field: unknown): boolean {
  const f = field as
    | { sensitive?: unknown; _meta?: { sensitive?: unknown } }
    | undefined;
  return f?.sensitive === true || f?._meta?.sensitive === true;
}

/**
 * Whether a class is effectively sensitive: the class (or any registered
 * ancestor) declares `@smrt({ sensitive: true })`, any effective field
 * (including inherited fields) is `sensitive`, or its table is
 * change-feed-sensitive by name or through the class resolver. An unknown
 * class counts as sensitive (fail closed).
 */
export function isEffectivelySensitiveClass(name: string): boolean {
  const registered = lookup(name);
  if (!registered) return true;
  const key = registered.qualifiedName ?? registered.name;

  if (ObjectRegistry.getConfig(key)?.sensitive === true) return true;
  if (registered.config?.sensitive === true) return true;
  for (const ancestorName of getInheritanceChain(key, registered)) {
    if (ancestorName === key) continue;
    const ancestor = lookup(ancestorName);
    if (ancestor?.config?.sensitive === true) return true;
  }

  for (const field of getEffectiveFieldsSync(registered).values()) {
    if (fieldIsSensitive(field)) return true;
  }

  const tableName =
    registered.schema?.tableName ?? ObjectRegistry.getTableName(key);
  if (!tableName) return true;
  if (isChangeFeedSensitiveTable(tableName)) return true;
  return isChangeFeedSensitiveWrite(tableName, registered.constructor);
}
