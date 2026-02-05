/**
 * TenantAgent - Junction between tenants and agents
 *
 * Represents the binding of an agent class to a specific tenant,
 * with optional permission overrides and status control.
 *
 * The absence of a row means "check parent tenant" — inheritance
 * is a resolution behavior, not stored state.
 */

import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AgentManifestInfo } from './ui.js';

/**
 * Status of a tenant-agent binding
 */
export type TenantAgentStatus = 'active' | 'disabled';

/**
 * Permission definition for merge logic
 */
interface PermissionDef {
  id: string;
  defaultGranted?: boolean;
}

/**
 * Result of resolving agent availability for a tenant
 */
export interface ResolvedAgentAvailability {
  /** Agent class name (e.g., 'Praeco') */
  agentClass: string;
  /** Resolved status */
  status: TenantAgentStatus;
  /** How this was resolved */
  source: 'explicit' | 'inherited';
  /** Which tenant the binding came from */
  sourceTenantId: string;
  /** Merged permissions (manifest defaults overridden by explicit grants/revokes) */
  permissions: Record<string, boolean>;
  /** The agent instance ID (row in agents table), if one exists */
  agentId?: string;
  /** Agent manifest from the build (if available) */
  manifest?: AgentManifestInfo;
  /** Tenant-level config overrides */
  config?: Record<string, any>;
}

/**
 * TenantAgent SmrtObject — junction between tenants and agents
 *
 * Each row represents an explicit binding of an agent class to a tenant.
 * - Presence means explicit override (active or disabled)
 * - Absence means "check parent tenant" (inheritance)
 *
 * Permission overrides:
 * - null/missing key → use defaultGranted from manifest
 * - true → explicitly granted
 * - false → explicitly revoked
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tenant_agents',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'agent_class'],
})
export class TenantAgent extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** Agent class name (e.g., 'Praeco', 'Caelus') */
  agentClass: string = '';

  /** Status of the agent for this tenant */
  status: TenantAgentStatus = 'active';

  /** Explicit permission overrides (JSON). null = use manifest defaults */
  permissions: Record<string, boolean> | null = null;

  /** Tenant-level agent config overrides (JSON) */
  config: Record<string, any> | null = null;
}

/**
 * Collection for managing tenant-agent bindings
 */
export class TenantAgentCollection extends SmrtCollection<TenantAgent> {
  static readonly _itemClass = TenantAgent;

  /**
   * Resolve agent availability for a tenant, walking up the hierarchy.
   *
   * Algorithm:
   * 1. Load explicit entries for this tenant
   * 2. Build result map from explicit entries (source = 'explicit')
   * 3. Merge permissions: manifest defaults overridden by explicit permissions
   * 4. Get tenant's ancestors via hierarchyPath (immediate parent → root)
   * 5. For each ancestor, add inherited agents not already resolved
   * 6. Return only agents that appear somewhere in the hierarchy
   *
   * @param tenantId - The tenant to resolve for
   * @param getAncestorIds - Function that returns ancestor tenant IDs (parent → root order)
   * @param manifests - Map of agent class name to AgentManifestInfo
   */
  async resolveForTenant(
    tenantId: string,
    getAncestorIds: (tenantId: string) => Promise<string[]>,
    manifests?: Map<string, AgentManifestInfo>,
  ): Promise<ResolvedAgentAvailability[]> {
    const result = new Map<string, ResolvedAgentAvailability>();

    // Step 1: Load explicit entries for this tenant
    const explicitEntries = await this.list({
      where: { tenantId },
    });

    // Step 2: Build result from explicit entries
    for (const entry of explicitEntries) {
      const manifest = manifests?.get(entry.agentClass);
      const mergedPermissions = mergePermissions(
        manifest?.permissions,
        entry.permissions,
      );

      result.set(entry.agentClass, {
        agentClass: entry.agentClass,
        status: entry.status,
        source: 'explicit',
        sourceTenantId: tenantId,
        permissions: mergedPermissions,
        manifest,
        config: entry.config ?? undefined,
      });
    }

    // Step 3: Walk ancestors for inherited agents
    const ancestorIds = await getAncestorIds(tenantId);
    for (const ancestorId of ancestorIds) {
      const ancestorEntries = await this.list({
        where: { tenantId: ancestorId },
      });

      for (const entry of ancestorEntries) {
        // Skip if already resolved explicitly or from a closer ancestor
        if (result.has(entry.agentClass)) continue;

        const manifest = manifests?.get(entry.agentClass);
        const mergedPermissions = mergePermissions(
          manifest?.permissions,
          entry.permissions,
        );

        result.set(entry.agentClass, {
          agentClass: entry.agentClass,
          status: entry.status,
          source: 'inherited',
          sourceTenantId: ancestorId,
          permissions: mergedPermissions,
          manifest,
          config: entry.config ?? undefined,
        });
      }
    }

    return Array.from(result.values());
  }

  /**
   * Enable an agent for a tenant (creates or updates binding)
   */
  async enableAgent(
    tenantId: string,
    agentClass: string,
  ): Promise<TenantAgent> {
    const existing = await this.findByTenantAndClass(tenantId, agentClass);
    if (existing) {
      existing.status = 'active';
      await existing.save();
      return existing;
    }

    const entry = await this.create({
      tenantId,
      agentClass,
      status: 'active',
    });
    await entry.save();
    return entry;
  }

  /**
   * Disable an agent for a tenant
   */
  async disableAgent(
    tenantId: string,
    agentClass: string,
  ): Promise<TenantAgent> {
    const existing = await this.findByTenantAndClass(tenantId, agentClass);
    if (existing) {
      existing.status = 'disabled';
      await existing.save();
      return existing;
    }

    const entry = await this.create({
      tenantId,
      agentClass,
      status: 'disabled',
    });
    await entry.save();
    return entry;
  }

  /**
   * Remove explicit override, falling back to inheritance
   */
  async clearOverride(tenantId: string, agentClass: string): Promise<void> {
    const existing = await this.findByTenantAndClass(tenantId, agentClass);
    if (existing) {
      await existing.delete();
    }
  }

  /**
   * Set permission overrides for a tenant's agent binding
   */
  async setPermissions(
    tenantId: string,
    agentClass: string,
    permissions: Record<string, boolean>,
  ): Promise<TenantAgent> {
    const existing = await this.findByTenantAndClass(tenantId, agentClass);
    if (existing) {
      existing.permissions = permissions;
      await existing.save();
      return existing;
    }

    const entry = await this.create({
      tenantId,
      agentClass,
      status: 'active',
      permissions,
    });
    await entry.save();
    return entry;
  }

  /**
   * Find a tenant-agent binding by tenant and agent class
   */
  async findByTenantAndClass(
    tenantId: string,
    agentClass: string,
  ): Promise<TenantAgent | null> {
    const results = await this.list({
      where: { tenantId, agentClass },
    });
    return results[0] ?? null;
  }
}

/**
 * Merge manifest permission defaults with explicit overrides
 */
function mergePermissions(
  manifestPermissions?: PermissionDef[],
  overrides?: Record<string, boolean> | null,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  // Start with manifest defaults
  if (manifestPermissions) {
    for (const perm of manifestPermissions) {
      result[perm.id] = perm.defaultGranted !== false;
    }
  }

  // Apply overrides
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      result[key] = value;
    }
  }

  return result;
}
