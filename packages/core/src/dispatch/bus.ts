/**
 * DispatchBus - Central hub for inter-agent communication
 *
 * The DispatchBus provides both in-memory handlers and persistent subscriptions
 * for asynchronous agent-to-agent messaging.
 *
 * @example
 * ```typescript
 * const bus = await createDispatchBus({ db: { type: 'sqlite', url: 'app.db' } });
 *
 * // In-memory handler (immediate)
 * bus.on('campaign.completed', async (payload, metadata) => {
 *   console.log(`Campaign ${payload.campaignId} completed`);
 * });
 *
 * // Persistent subscription (processed later)
 * await bus.subscribe({ signalType: 'campaign.*', subscriber: 'fiscus' });
 *
 * // Emit a dispatch
 * await bus.emit('campaign.completed', { campaignId: '123' }, { source: 'suasor' });
 *
 * // Process pending dispatches
 * await bus.process('fiscus');
 * ```
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE,
  CREATE_SMRT_DISPATCH_TABLE,
} from '../system/schema.js';
import { DispatchCollection } from './collections/Dispatches.js';
import { DispatchSubscriptionCollection } from './collections/DispatchSubscriptions.js';
import { Dispatch } from './models/Dispatch.js';
import { DispatchSubscription } from './models/DispatchSubscription.js';
import type {
  DispatchBusOptions,
  DispatchCleanupOptions,
  DispatchCleanupResult,
  DispatchEmitOptions,
  DispatchHandler,
  DispatchListOptions,
  DispatchMetadata,
  DispatchProcessOptions,
  DispatchRetryOptions,
  DispatchSubscribeOptions,
} from './types.js';

/**
 * Registered in-memory handler
 */
interface RegisteredHandler {
  pattern: string;
  handler: DispatchHandler;
  subscription: DispatchSubscription;
}

/**
 * DispatchBus for inter-agent communication
 */
export class DispatchBus {
  private db: DatabaseInterface;
  private handlers: Map<string, RegisteredHandler[]> = new Map();
  private initialized: boolean = false;

  /**
   * Create a new DispatchBus (use createDispatchBus factory instead)
   */
  constructor(db: DatabaseInterface) {
    this.db = db;
  }

  /**
   * Initialize the dispatch tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create dispatch tables if they don't exist
    const dispatchExists = await DispatchCollection.tableExists(this.db);
    if (!dispatchExists) {
      // Split the DDL into separate statements and execute each
      const statements = CREATE_SMRT_DISPATCH_TABLE.split(';').filter((s) =>
        s.trim(),
      );
      for (const stmt of statements) {
        await this.db.query(stmt);
      }
    }

    const subsExists = await DispatchSubscriptionCollection.tableExists(
      this.db,
    );
    if (!subsExists) {
      const statements = CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE.split(
        ';',
      ).filter((s) => s.trim());
      for (const stmt of statements) {
        await this.db.query(stmt);
      }
    }

    this.initialized = true;
  }

  /**
   * Emit a dispatch message
   *
   * Creates a pending dispatch and immediately notifies any in-memory handlers.
   *
   * @param type - Signal type (e.g., 'campaign.completed')
   * @param payload - Data to send
   * @param options - Emission options (source, sourceId, metadata)
   * @returns The created dispatch
   */
  async emit(
    type: string,
    payload: unknown,
    options: DispatchEmitOptions = {},
  ): Promise<Dispatch> {
    await this.initialize();

    // Query all enabled subscriptions matching this signal type
    const matchingSubs = await DispatchSubscriptionCollection.findBySignalType(
      this.db,
      type,
    );

    // Separate into compete and fanout subscribers
    const fanoutSubs = matchingSubs.filter((s) => s.delivery === 'fanout');
    const competeSubs = matchingSubs.filter((s) => s.delivery !== 'fanout');

    // Create the base dispatch record
    const dispatch = new Dispatch({
      type,
      source: options.source || 'unknown',
      source_id: options.sourceId || null,
      payload: JSON.stringify(payload || {}),
      metadata: JSON.stringify(options.metadata || {}),
      status: 'pending',
    });

    // For fanout subscribers: create a per-subscriber dispatch copy
    for (const sub of fanoutSubs) {
      const fanoutDispatch = new Dispatch({
        type,
        source: options.source || 'unknown',
        source_id: options.sourceId || null,
        payload: JSON.stringify(payload || {}),
        metadata: JSON.stringify(options.metadata || {}),
        status: 'pending',
        target_subscriber: sub.subscriber,
      });
      await DispatchCollection.insert(this.db, fanoutDispatch);
    }

    // For compete subscribers (or if no subscriptions found): insert the original
    // dispatch with target_subscriber = NULL so any compete subscriber can claim it
    if (competeSubs.length > 0 || matchingSubs.length === 0) {
      await DispatchCollection.insert(this.db, dispatch);
    }

    // Notify in-memory handlers immediately (fire-and-forget)
    this.notifyHandlers(type, payload, dispatch.getMetadata());

    return dispatch;
  }

  /**
   * Register an in-memory handler for a signal type
   *
   * In-memory handlers are called immediately when a dispatch is emitted.
   * They don't require processing and are useful for real-time reactions.
   *
   * @param pattern - Signal type pattern (supports wildcards)
   * @param handler - Handler function
   */
  on(pattern: string, handler: DispatchHandler): void {
    const subscription = new DispatchSubscription({
      signal_type: pattern,
      subscriber: '_in_memory_',
      handler: 'callback',
    });

    const registered: RegisteredHandler = { pattern, handler, subscription };

    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, []);
    }
    this.handlers.get(pattern)?.push(registered);
  }

  /**
   * Remove an in-memory handler
   *
   * @param pattern - Signal type pattern
   * @param handler - Handler function to remove
   * @returns True if handler was found and removed
   */
  off(pattern: string, handler: DispatchHandler): boolean {
    const handlers = this.handlers.get(pattern);
    if (!handlers) return false;

    const index = handlers.findIndex((h) => h.handler === handler);
    if (index === -1) return false;

    handlers.splice(index, 1);
    if (handlers.length === 0) {
      this.handlers.delete(pattern);
    }
    return true;
  }

  /**
   * Create a persistent subscription
   *
   * Persistent subscriptions are stored in the database and processed
   * when process() is called for the subscriber.
   *
   * @param options - Subscription options
   */
  async subscribe(options: DispatchSubscribeOptions): Promise<void> {
    await this.initialize();

    const subscription = new DispatchSubscription({
      signal_type: options.signalType,
      subscriber: options.subscriber,
      handler: options.handler || 'handleDispatch',
      delivery: options.delivery || 'compete',
      enabled: options.enabled !== false ? 1 : 0,
    });

    await DispatchSubscriptionCollection.upsert(this.db, subscription);
  }

  /**
   * Remove a persistent subscription
   *
   * @param signalType - Signal type pattern
   * @param subscriber - Subscriber name
   */
  async unsubscribe(signalType: string, subscriber: string): Promise<void> {
    await this.initialize();
    await DispatchSubscriptionCollection.deleteByKey(
      this.db,
      signalType,
      subscriber,
    );
  }

  /**
   * Process pending dispatches for a subscriber
   *
   * Finds all pending dispatches that match the subscriber's subscriptions
   * and invokes the provided handler for each.
   *
   * @param subscriber - Subscriber name
   * @param handler - Handler function to call for each dispatch
   * @param options - Processing options
   * @returns Number of dispatches processed
   */
  async process(
    subscriber: string,
    handler: DispatchHandler,
    options: DispatchProcessOptions = {},
  ): Promise<number> {
    await this.initialize();

    // Get subscriber's subscriptions
    const subscriptions = await DispatchSubscriptionCollection.findBySubscriber(
      this.db,
      subscriber,
    );

    if (subscriptions.length === 0) {
      return 0;
    }

    // Get signal types (including wildcards)
    const signalTypes = subscriptions.map((s) => s.signalType);

    // For non-wildcard subscriptions, we can query directly
    // For wildcards, we need to get all pending and filter
    const hasWildcards = signalTypes.some((t) => t.includes('*'));

    // Build a lookup: for each signal type this subscriber subscribes to,
    // what delivery mode? Used to filter dispatches correctly.
    const deliveryByType = new Map<string, 'compete' | 'fanout'>();
    for (const sub of subscriptions) {
      deliveryByType.set(sub.signalType, sub.delivery);
    }

    // Helper: check if a dispatch should be visible to this subscriber
    const isVisibleToSubscriber = (dispatch: Dispatch): boolean => {
      if (dispatch.targetSubscriber === subscriber) {
        // Targeted at this subscriber (fanout copy) — always visible
        return true;
      }
      if (dispatch.targetSubscriber !== null) {
        // Targeted at a different subscriber — not visible
        return false;
      }
      // Null target (compete dispatch): only visible if this subscriber
      // has a compete subscription matching this dispatch type
      const matchingSub = subscriptions.find((sub) =>
        sub.matches(dispatch.type),
      );
      return matchingSub?.delivery === 'compete';
    };

    let pendingDispatches: Dispatch[];
    if (hasWildcards) {
      // Get all pending dispatches and filter by subscription patterns + target
      const allPending = await DispatchCollection.list(this.db, {
        status: 'pending',
        limit: options.limit || 100,
      });

      pendingDispatches = allPending.filter(
        (dispatch) =>
          subscriptions.some((sub) => sub.matches(dispatch.type)) &&
          isVisibleToSubscriber(dispatch),
      );
    } else {
      // Direct query for exact signal types (with target_subscriber filter)
      const raw = await DispatchCollection.findPending(
        this.db,
        signalTypes,
        options.limit || 100,
        subscriber,
      );
      // Post-filter for delivery mode correctness
      pendingDispatches = raw.filter(isVisibleToSubscriber);
    }

    // Filter by specific signal types if provided
    if (options.signalTypes && options.signalTypes.length > 0) {
      pendingDispatches = pendingDispatches.filter((d) =>
        options.signalTypes?.includes(d.type),
      );
    }

    let processed = 0;

    for (const dispatch of pendingDispatches) {
      // Mark as processing
      dispatch.markProcessing();
      await DispatchCollection.update(this.db, dispatch);

      try {
        // Invoke handler
        await handler(dispatch.payload, dispatch.getMetadata());

        // Mark as completed
        dispatch.markCompleted(subscriber);
        await DispatchCollection.update(this.db, dispatch);
        processed++;
      } catch (error) {
        // Mark as failed
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        dispatch.markFailed(errorMessage);
        await DispatchCollection.update(this.db, dispatch);
      }
    }

    return processed;
  }

  /**
   * Retry failed dispatches
   *
   * Resets failed dispatches to pending status so they can be processed again.
   *
   * @param options - Retry options
   * @returns Number of dispatches reset
   */
  async retry(options: DispatchRetryOptions = {}): Promise<number> {
    await this.initialize();

    const retryable = await DispatchCollection.findRetryable(this.db, options);

    for (const dispatch of retryable) {
      dispatch.resetForRetry();
      await DispatchCollection.update(this.db, dispatch);
    }

    return retryable.length;
  }

  /**
   * Clean up old dispatches
   *
   * @param options - Cleanup options
   * @returns Number of dispatches deleted
   */
  async cleanup(
    options: DispatchCleanupOptions = {},
  ): Promise<DispatchCleanupResult> {
    await this.initialize();
    return DispatchCollection.cleanup(this.db, options);
  }

  /**
   * List dispatches with filtering
   */
  async list(options: DispatchListOptions = {}): Promise<Dispatch[]> {
    await this.initialize();
    return DispatchCollection.list(this.db, options);
  }

  /**
   * Get a dispatch by ID
   */
  async get(id: string): Promise<Dispatch | null> {
    await this.initialize();
    return DispatchCollection.get(this.db, id);
  }

  /**
   * List all subscriptions
   */
  async listSubscriptions(
    subscriber?: string,
  ): Promise<DispatchSubscription[]> {
    await this.initialize();

    if (subscriber) {
      return DispatchSubscriptionCollection.findBySubscriber(
        this.db,
        subscriber,
        false,
      );
    }
    return DispatchSubscriptionCollection.list(this.db);
  }

  /**
   * Notify in-memory handlers (fire-and-forget)
   */
  private notifyHandlers(
    type: string,
    payload: unknown,
    metadata: DispatchMetadata,
  ): void {
    // Collect all matching handlers
    const matchingHandlers: RegisteredHandler[] = [];

    for (const [, handlers] of this.handlers) {
      for (const registered of handlers) {
        if (registered.subscription.matches(type)) {
          matchingHandlers.push(registered);
        }
      }
    }

    // Fire-and-forget - don't await
    for (const registered of matchingHandlers) {
      try {
        const result = registered.handler(payload, metadata);
        // Handle both sync and async handlers
        if (result && typeof result.catch === 'function') {
          void result.catch((error: unknown) => {
            console.error(
              `DispatchBus: Handler for "${registered.pattern}" failed`,
              error,
            );
          });
        }
      } catch (error) {
        console.error(
          `DispatchBus: Handler for "${registered.pattern}" failed`,
          error,
        );
      }
    }
  }
}

/**
 * Create a DispatchBus instance
 *
 * @param options - Bus configuration
 * @returns Initialized DispatchBus
 */
export async function createDispatchBus(
  options: DispatchBusOptions = {},
): Promise<DispatchBus> {
  // Resolve database configuration
  const dbConfig = options.db || options.persistence;

  if (!dbConfig) {
    throw new Error('DispatchBus requires a database configuration');
  }

  // Get or create database interface
  let db: DatabaseInterface;
  if (typeof dbConfig === 'string') {
    db = await getDatabase(dbConfig);
  } else if ('query' in dbConfig) {
    // Already a DatabaseInterface (has query method)
    db = dbConfig as DatabaseInterface;
  } else if ('type' in dbConfig && 'url' in dbConfig) {
    // Database config object - use getDatabase with type and url
    db = await getDatabase({
      type: dbConfig.type as 'sqlite' | 'postgres' | 'duckdb',
      url: dbConfig.url,
    });
  } else {
    throw new Error('Invalid database configuration for DispatchBus');
  }

  const bus = new DispatchBus(db);
  await bus.initialize();

  return bus;
}
