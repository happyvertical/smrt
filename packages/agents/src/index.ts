/**
 * @have/agents - Agent framework for building autonomous actors
 *
 * Provides a base Agent class that extends SmrtObject with:
 * - Status tracking
 * - Configuration management integration
 * - Structured logging
 * - Lifecycle hooks
 * - Automatic signal handling for graceful shutdown
 * - Interest-based object discovery via interesting() method
 *
 * Agents can define their own properties for state management - since they extend
 * SmrtObject, any properties defined will be automatically persisted to the database.
 *
 * @example
 * ```typescript
 * import { Agent, type AgentOptions } from '@have/agents';
 * import { getModuleConfig } from '@have/config';
 * import { smrt } from '@happyvertical/smrt-core';
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
 *   constructor(options: AgentOptions = {}) {
 *     super({
 *       ...options,
 *       interests: {
 *         filter: { status: 'active' },
 *         objects: {
 *           Meeting: { sort: 'scheduled_at DESC', limit: 10 },
 *           Document: { filter: { 'type in': ['agenda', 'minutes'] } }
 *         }
 *       }
 *     });
 *   }
 *
 *   async validate(): Promise<void> {
 *     if (!this.config.cronSchedule) {
 *       throw new Error('cronSchedule is required');
 *     }
 *   }
 *
 *   async run(): Promise<void> {
 *     // Query objects the agent is interested in
 *     const items = await this.interesting();
 *     for (const { type, data } of items) {
 *       console.log(`Processing ${type}: ${data.id}`);
 *     }
 *     this.itemsProcessed = items.length;
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

export { Agent, type AgentOptions } from './agent.js';
export type {
  AgentWithInterestsOptions,
  AsyncQualifierFn,
  InterestFilter,
  InterestHandlerFn,
  InterestOptions,
  InterestResult,
  ObjectFilter,
  ObjectInterestConfig,
  QueryFn,
} from './interests.js';
export { mergeFilters, normalizeSort } from './interests.js';
export type { AgentStatusType } from './types.js';
