/**
 * AgentConfig - Persistent configuration storage for agents
 *
 * This module provides database-backed configuration for agents,
 * enabling consuming apps to persist agent settings.
 *
 * @module
 */

import {
  type SmrtClassOptions,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * AgentConfig stores agent configuration in the database
 *
 * Each config record maps to a UI slot for an agent instance:
 * - agentId: The agent instance's ID
 * - agentClass: The agent's class name (e.g., 'Praeco')
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
@smrt({
  tableName: 'agent_configs',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AgentConfig extends SmrtObject {
  /**
   * ID of the agent instance this config belongs to
   */
  agentId: string = '';

  /**
   * Class name of the agent (e.g., 'Praeco', 'Caelus')
   */
  agentClass: string = '';

  /**
   * UI slot ID (e.g., 'sources', 'settings', 'reports')
   */
  slotId: string = '';

  /**
   * Configuration data stored as JSON
   */
  configData: Record<string, any> = {};

  /**
   * Schema version for future migrations
   */
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
    const collection = await AgentConfigCollection.create(options);
    const configs = await collection.list({
      where: { agentId },
    });

    return new Map(configs.map((c) => [c.slotId, c.configData]));
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
    const config = await collection.get({ agentId, slotId });
    return config?.configData;
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
    const collection = await AgentConfigCollection.create(options);

    // Check for existing config
    const existing = await collection.get({
      agentId: data.agentId,
      slotId: data.slotId,
    });

    if (existing) {
      // Update existing
      existing.configData = data.configData;
      existing.agentClass = data.agentClass;
      await existing.save();
      return existing;
    }

    // Create new
    const config = await collection.create({
      agentId: data.agentId,
      agentClass: data.agentClass,
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
}
