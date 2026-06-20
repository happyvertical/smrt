/**
 * Serialization utilities for resolved agents
 *
 * Converts ResolvedAgentAvailability (database + manifest data) into
 * a JSON-safe shape suitable for passing to client components.
 *
 * @module @happyvertical/smrt-agents/server
 */

import type { ResolvedAgentAvailability } from '../tenant-agent.js';
import type { AgentAdminRoute, AgentUISlots } from '../ui.js';

/**
 * Serialized agent data for passing to client components.
 *
 * Includes manifest-derived fields (icon, permissions, slots)
 * alongside resolution metadata (source, sourceTenantId).
 */
export interface SerializedAgent {
  /** Agent instance ID, or a synthetic key if no instance exists */
  id: string;
  /** Human-readable name from manifest */
  name?: string;
  /** Human-readable agent class name (e.g., 'Praeco') */
  agentClass: string;
  /** Canonical agent type (qualified name when available) */
  agentType: string;
  /** STI type discriminator (same as agentType) */
  _meta_type?: string;
  /** UI slot definitions from manifest */
  slots?: AgentUISlots;
  /** Admin route declarations from manifest */
  adminRoutes?: AgentAdminRoute[];
  /** How this agent was resolved for the tenant */
  source?: 'explicit' | 'inherited';
  /** Which tenant the binding came from */
  sourceTenantId?: string;
  /** Merged permissions from manifest + tenant overrides */
  permissions?: Record<string, boolean>;
  /** Agent icon from manifest */
  icon?: string;
  /**
   * Tenant-level config overrides.
   *
   * SECURITY (review #1552): this is the tenant's own override blob, carried
   * verbatim into the client payload. The model field `TenantAgent.config` is
   * `@field({ sensitive: true })`, which strips it from the generated CRUD
   * api/mcp surfaces — but this hand-written admin serialization deliberately
   * bypasses that for the authorized admin UI. Do NOT store raw secrets (API
   * keys, tokens) in tenant config; reference them by id via
   * `@happyvertical/smrt-secrets` so only an opaque handle reaches the browser.
   * Dropping this field outright is a breaking change to a public API consumed
   * downstream and is tracked as a separate follow-up.
   */
  config?: Record<string, any>;
}

/**
 * Convert a ResolvedAgentAvailability to a serializable shape for the UI.
 *
 * @param resolved - Output from TenantAgentCollection.resolveForTenant()
 * @returns Serialized agent data safe for JSON transport
 */
export function serializeResolvedAgent(
  resolved: ResolvedAgentAvailability,
): SerializedAgent {
  const manifest = resolved.manifest;

  return {
    id: resolved.agentId || `${resolved.sourceTenantId}:${resolved.agentType}`,
    name: manifest?.name || resolved.agentClass,
    agentClass: resolved.agentClass,
    agentType: resolved.agentType,
    _meta_type: resolved.agentType,
    slots: manifest?.uiSlots as AgentUISlots | undefined,
    adminRoutes: manifest?.adminRoutes as AgentAdminRoute[] | undefined,
    source: resolved.source,
    sourceTenantId: resolved.sourceTenantId,
    permissions: resolved.permissions,
    icon: manifest?.icon,
    config: resolved.config,
  };
}
