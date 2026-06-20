/**
 * Serialization utilities for resolved agents
 *
 * Converts ResolvedAgentAvailability (database + manifest data) into
 * a JSON-safe shape suitable for passing to client components.
 *
 * @module @happyvertical/smrt-agents/server
 */

import { sanitizeConfig } from '@happyvertical/smrt-config';
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
   * Tenant-level config overrides, **secret-sanitized** for client transport.
   *
   * SECURITY (#1553, follow-up to #1552): the raw `TenantAgent.config` is the
   * tenant's own override blob and is `@field({ sensitive: true })` (stripped
   * from the generated CRUD api/mcp surfaces). This hand-written admin
   * serialization runs it through `sanitizeConfig()` from
   * `@happyvertical/smrt-config` before it leaves the server, so secret-shaped
   * keys (apiKey/token/password/…) are dropped and secret-shaped values
   * (`sk-…`, `AKIA…`, `Bearer …`, URL credentials, PEM blocks) are masked —
   * non-secret config still reaches the authorized admin UI for display.
   *
   * This is **display-only**: do not edit-round-trip it back to the server
   * (a masked value would overwrite the real secret). Best practice remains to
   * reference secrets by id via `@happyvertical/smrt-secrets` so only an opaque
   * handle is ever stored in tenant config.
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
    // Secret-sanitize before the blob crosses into the client payload (#1553).
    config: sanitizeConfig(resolved.config) as SerializedAgent['config'],
  };
}
