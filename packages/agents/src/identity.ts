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

/**
 * Compose a per-instance dispatch subscriber identity from an agent type and an
 * optional instance key (#1890).
 *
 * Multiple durable instances of one agent class each need their own subscriber
 * name so their dispatch subscriptions and pending dispatches never collide —
 * that is what keeps two instances from double-processing each other's work.
 *
 * Returns the bare `agentType` when `instanceKey` is nullish/empty, so a
 * **singleton** agent's subscriber is byte-for-byte unchanged (the N=1 default).
 * When a key is present the identity is `` `${agentType}#${instanceKey}` `` — a
 * stable, reversible composition (the type never contains `#`).
 */
export function instanceScopedSubscriber(
  agentType: string,
  instanceKey?: string | null,
): string {
  return instanceKey ? `${agentType}#${instanceKey}` : agentType;
}
