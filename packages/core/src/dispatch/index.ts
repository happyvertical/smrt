/**
 * Dispatch Module - Inter-Agent Communication
 *
 * Provides the DispatchBus for asynchronous agent-to-agent messaging.
 *
 * ## Delivery modes
 *
 * - **compete** (default): At-most-once delivery. First subscriber to process
 *   claims the dispatch. Other subscribers won't see it.
 * - **fanout**: Each subscriber gets their own copy of the dispatch and
 *   processes independently.
 *
 * @example
 * ```typescript
 * import { createDispatchBus } from '@happyvertical/smrt-core';
 *
 * const bus = await createDispatchBus({ db: { type: 'sqlite', url: 'app.db' } });
 *
 * // Emit a dispatch
 * await bus.emit('campaign.completed', { campaignId: '123' }, { source: 'suasor' });
 *
 * // Subscribe with compete delivery (default — first-to-claim)
 * await bus.subscribe({ signalType: 'campaign.*', subscriber: 'fiscus' });
 *
 * // Subscribe with fan-out delivery (each subscriber gets own copy)
 * await bus.subscribe({
 *   signalType: 'campaign.*',
 *   subscriber: 'auditor',
 *   delivery: 'fanout',
 * });
 *
 * // Process pending dispatches
 * await bus.process('fiscus', async (payload, metadata) => {
 *   console.log(`Processing ${metadata.type} from ${metadata.source}`);
 * });
 * ```
 *
 * @packageDocumentation
 */

// Main bus class and factory
export { createDispatchBus, DispatchBus } from './bus.js';
// Collections (for advanced use cases)
export { DispatchCollection } from './collections/Dispatches.js';
export { DispatchSubscriptionCollection } from './collections/DispatchSubscriptions.js';
// Models
export { Dispatch, type DispatchData } from './models/Dispatch.js';
export {
  DispatchSubscription,
  type DispatchSubscriptionData,
} from './models/DispatchSubscription.js';
// Tenant resolver inversion hook (registered by @happyvertical/smrt-tenancy)
export {
  type DispatchTenantResolver,
  type DispatchTenantScope,
  resolveDispatchTenantId,
  resolveDispatchTenantScope,
  setDispatchTenantResolver,
} from './tenant-resolver.js';

// Types
export type {
  DispatchBusOptions,
  DispatchCleanupOptions,
  DispatchCleanupResult,
  DispatchEmitOptions,
  DispatchHandler,
  DispatchListOptions,
  DispatchMetadata,
  DispatchProcessOptions,
  DispatchRetryOptions,
  DispatchStatus,
  DispatchSubscribeOptions,
} from './types.js';
