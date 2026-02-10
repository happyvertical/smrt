/**
 * Server-side agent config loading utilities
 *
 * Loads slot configurations from the agent_configs table for a set of agents.
 * Agent-specific table loading (e.g., praeco_sources) stays in the host app.
 *
 * @module @happyvertical/smrt-agents/server
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { AgentConfig } from '../config.js';

/**
 * Load slot configs for multiple agents from the agent_configs table.
 *
 * Returns a nested map: agentId -> slotId -> configData.
 * Agent-specific tables (e.g., praeco_sources, praeco_reports)
 * are NOT loaded here — those stay in the host application.
 *
 * @param agents - Array of agent identifiers (id + agentClass)
 * @param dbOptions - Database options for SmrtCollection.create()
 * @returns Map of agentId -> slotId -> config data
 */
export async function loadSlotConfigs(
  agents: Array<{ id: string; agentClass: string }>,
  dbOptions: SmrtClassOptions,
): Promise<Record<string, Record<string, unknown>>> {
  const configs: Record<string, Record<string, unknown>> = {};

  for (const agent of agents) {
    const agentConfig: Record<string, unknown> = {};

    try {
      const slotConfigs = await AgentConfig.forAgent(agent.id, dbOptions);
      for (const [slotId, configData] of slotConfigs) {
        agentConfig[slotId] = configData;
      }
    } catch {
      // agent_configs table may not exist yet — silently skip
    }

    if (Object.keys(agentConfig).length > 0) {
      configs[agent.id] = agentConfig;
    }
  }

  return configs;
}
