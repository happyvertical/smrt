import { getClassName, ObjectRegistry } from '@happyvertical/smrt-core';

/**
 * Return the canonical agent type identifier for storage and dispatch routing.
 *
 * Uses the registry's qualified name when available and falls back to the input
 * name for dynamically defined or unregistered classes.
 */
export function getAgentTypeName(name: string): string {
  const registered = ObjectRegistry.getClass(name);
  return registered?.qualifiedName || registered?.name || name;
}

/**
 * Return the human-readable class name for UI and logs.
 */
export function getAgentClassName(name: string): string {
  const registered = ObjectRegistry.getClass(name);
  return registered?.name || getClassName(name);
}

/**
 * Return all meaningful aliases for an agent type.
 *
 * The qualified name is first so persistence lookups prefer canonical rows,
 * while the simple class name keeps legacy rows discoverable during migration.
 */
export function getAgentTypeAliases(name: string): string[] {
  return Array.from(
    new Set([getAgentTypeName(name), getAgentClassName(name)].filter(Boolean)),
  );
}
