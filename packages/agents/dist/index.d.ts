/**
 * @have/agents - Agent framework for building autonomous actors
 *
 * Provides a base Agent class that extends SmrtObject with:
 * - Status tracking
 * - Configuration management integration
 * - Structured logging
 * - Lifecycle hooks
 * - Automatic signal handling for graceful shutdown
 *
 * Agents can define their own properties for state management - since they extend
 * SmrtObject, any properties defined will be automatically persisted to the database.
 *
 * @example
 * ```typescript
 * import { Agent } from '@have/agents';
 * import { getModuleConfig } from '@have/config';
 * import { smrt } from '@smrt/core';
 *
 * @smrt()
 * class MyAgent extends Agent {
 *   protected config = getModuleConfig('my-agent', {
 *     cronSchedule: '0 2 * * *',
 *     maxRetries: 3
 *   });
 *
 *   // Define your own state properties (automatically persisted)
 *   itemsProcessed: number = 0;
 *
 *   async validate(): Promise<void> {
 *     if (!this.config.cronSchedule) {
 *       throw new Error('cronSchedule is required');
 *     }
 *   }
 *
 *   async run(): Promise<void> {
 *     // Agent logic
 *     this.itemsProcessed = 42;
 *     await this.save(); // Persist state
 *   }
 * }
 *
 * const agent = new MyAgent({ name: 'my-agent' });
 * await agent.execute();
 * ```
 *
 * @module @have/agents
 */
export { Agent } from './agent.js';
export type { AgentStatusType } from './types.js';
//# sourceMappingURL=index.d.ts.map