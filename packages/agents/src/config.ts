/**
 * AgentConfig - Persistent configuration storage for agents
 *
 * This module provides database-backed configuration for agents,
 * enabling consuming apps to persist agent settings.
 *
 * @module
 */

import {
  field,
  type SmrtClassOptions,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  queryGlobal,
  queryWithGlobals,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import { getAgentTypeName } from './identity.js';

/**
 * AgentConfig stores agent configuration in the database
 *
 * Each config record maps to a UI slot for an agent instance:
 * - agentId: The agent instance's ID
 * - agentClass: The canonical agent type (qualified name when available)
 * - slotId: The configuration slot (e.g., 'sources', 'settings')
 * - configData: JSON object containing the configuration
 *
 * @example
 * ```typescript
 * // Save config for an agent slot
 * const config = new AgentConfig({
 *   agentId: agent.id,
 *   agentClass: 'Praeco',
 *   slotId: 'sources',
 *   configData: { scrapers: ['civicweb', 'govstack'] },
 *   db: options.db
 * });
 * await config.initialize();
 * await config.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'agent_configs',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AgentConfig extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global agent configs
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * ID of the agent instance this config belongs to
   */
  @field({ type: 'text' })
  agentId: string = '';

  /**
   * Canonical agent type for this config (qualified name when available)
   */
  @field({ type: 'text' })
  agentClass: string = '';

  /**
   * UI slot ID (e.g., 'sources', 'settings', 'reports')
   */
  @field({ type: 'text' })
  slotId: string = '';

  /**
   * Configuration data stored as JSON
   *
   * Sensitive (#1540): agent config blobs routinely carry API keys/credentials,
   * so this is excluded from generated API/MCP responses and rejected as a
   * `where` filter key.
   */
  @field({ type: 'json', sensitive: true })
  configData: Record<string, any> = {};

  /**
   * Schema version for future migrations
   */
  @field({ type: 'integer' })
  schemaVersion: number = 1;

  /**
   * Load all configs for a specific agent
   *
   * @param agentId - Agent instance ID
   * @param options - Database options
   * @returns Map of slotId → configData
   */
  static async forAgent(
    agentId: string,
    options: SmrtClassOptions,
  ): Promise<Map<string, any>> {
    const configsByAgent = await AgentConfig.forAgents([agentId], options);
    return configsByAgent.get(agentId) ?? new Map();
  }

  /**
   * Load configs for multiple agents in a single query.
   *
   * @param agentIds - Agent instance IDs
   * @param options - Database options
   * @returns Map of agentId -> (slotId -> configData)
   */
  static async forAgents(
    agentIds: string[],
    options: SmrtClassOptions,
  ): Promise<Map<string, Map<string, any>>> {
    const configsByAgent = new Map<string, Map<string, any>>();
    if (agentIds.length === 0) {
      return configsByAgent;
    }

    const collection = await AgentConfigCollection.create(options);
    const configs = await collection.list({
      where: { 'agentId in': agentIds },
    });

    for (const config of configs) {
      if (!configsByAgent.has(config.agentId)) {
        configsByAgent.set(config.agentId, new Map());
      }
      configsByAgent.get(config.agentId)?.set(config.slotId, config.configData);
    }

    return configsByAgent;
  }

  /**
   * Load config for a specific agent and slot
   *
   * @param agentId - Agent instance ID
   * @param slotId - UI slot ID
   * @param options - Database options
   * @returns Config data or undefined if not found
   */
  static async forSlot(
    agentId: string,
    slotId: string,
    options: SmrtClassOptions,
  ): Promise<any | undefined> {
    const collection = await AgentConfigCollection.create(options);
    const configs = await collection.list({
      where: { agentId, slotId },
      limit: 1,
    });
    return configs[0]?.configData;
  }

  /**
   * Save or update config for an agent slot
   *
   * @param data - Config data including agentId, agentClass, slotId, configData
   * @param options - Database options
   * @returns Saved AgentConfig instance
   */
  static async saveSlot(
    data: {
      agentId: string;
      agentClass: string;
      slotId: string;
      configData: Record<string, any>;
    },
    options: SmrtClassOptions,
  ): Promise<AgentConfig> {
    const normalizedAgentClass = getAgentTypeName(data.agentClass);
    const collection = await AgentConfigCollection.create(options);

    // Check for existing config using list with where clause
    const existingConfigs = await collection.list({
      where: { agentId: data.agentId, slotId: data.slotId },
      limit: 1,
    });

    if (existingConfigs.length > 0) {
      // Update existing
      const existing = existingConfigs[0];
      existing.configData = data.configData;
      existing.agentClass = normalizedAgentClass;
      await existing.save();
      return existing;
    }

    // Create new
    const config = await collection.create({
      agentId: data.agentId,
      agentClass: normalizedAgentClass,
      slotId: data.slotId,
      configData: data.configData,
      slug: `${data.agentId}-${data.slotId}`,
    });
    await config.save();
    return config;
  }
}

/**
 * Collection for AgentConfig objects
 */
export class AgentConfigCollection extends SmrtCollection<AgentConfig> {
  static readonly _itemClass = AgentConfig;

  /**
   * Find all configs for a specific tenant
   * @param tenantId - Tenant ID to filter by
   * @returns Array of AgentConfig objects for the tenant
   */
  async findByTenant(tenantId: string): Promise<AgentConfig[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global configs (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global AgentConfig objects
   */
  async findGlobal(): Promise<AgentConfig[]> {
    return queryGlobal<AgentConfig>(this);
  }

  /**
   * Find configs for a tenant including global configs.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID to include
   * @returns Array of AgentConfig objects for the tenant and global configs
   */
  async findWithGlobals(tenantId: string): Promise<AgentConfig[]> {
    return queryWithGlobals<AgentConfig>(
      this,
      tenantId,
      'AgentConfig.findWithGlobals',
    );
  }
}
