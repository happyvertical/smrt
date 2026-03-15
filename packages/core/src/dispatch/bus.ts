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
 * Central hub for inter-agent messaging with both in-memory and persistent delivery.
 *
 * The `DispatchBus` combines two complementary delivery models:
 *
 * - **In-memory handlers** (`on(pattern, handler)`) — called synchronously (fire-and-forget)
 *   when a dispatch is emitted. Fast, but lost on process restart.
 * - **Persistent subscriptions** (`subscribe({ signalType, subscriber })`) — stored in
 *   `_smrt_dispatch_subscriptions` and processed later by calling `process(subscriber, handler)`.
 *   Survive restarts; suitable for background workers and scheduled agents.
 *
 * Signal types support single-segment wildcards: `'campaign.*'` matches `'campaign.completed'`
 * and `'campaign.failed'`, but not `'campaign.phase.two'`.
 *
 * Dispatch lifecycle: `pending → processing → completed` (or `failed` on handler error).
 * Use `retry()` to reset failed dispatches back to `pending`.
 *
 * Create instances via `createDispatchBus()` — do not use `new DispatchBus()` directly
 * in application code.
 *
 * @example
 * ```typescript
 * const bus = await createDispatchBus({ db: myDb });
 *
 * // In-memory: immediate, fire-and-forget
 * bus.on('invoice.paid', async (payload) => {
 *   console.log('Invoice paid:', payload.invoiceId);
 * });
 *
 * // Persistent: processed by 'notifications' agent on next run
 * await bus.subscribe({ signalType: 'invoice.*', subscriber: 'notifications' });
 *
 * // Emit (notifies in-memory handlers immediately, stores persistent dispatch)
 * await bus.emit('invoice.paid', { invoiceId: 'inv-001' }, { source: 'billing' });
 *
 * // Later, in the notifications agent:
 * await bus.process('notifications', async (payload) => {
 *   await sendEmail(payload.invoiceId);
 * });
 * ```
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
    } else {
      // Migrate existing tables: add target_subscriber column (v1.2.0)
      await this.addColumnIfMissing(
        '_smrt_dispatch',
        'target_subscriber',
        'TEXT',
      );
      // Migrate existing tables: add correlation_id column (v1.3.1)
      await this.addColumnIfMissing('_smrt_dispatch', 'correlation_id', 'TEXT');
      // Ensure index exists for correlation_id lookups
      await this.addIndexIfMissing(
        'idx_smrt_dispatch_correlation',
        '_smrt_dispatch',
        'correlation_id',
      );
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
    } else {
      // Migrate existing tables: add delivery column (v1.2.0)
      await this.addColumnIfMissing(
        '_smrt_dispatch_subscriptions',
        'delivery',
        "TEXT NOT NULL DEFAULT 'compete'",
      );
    }

    this.initialized = true;
  }

  /**
   * Add a column to an existing table if it doesn't already exist.
   * Uses a safe try/catch approach since SQLite doesn't support IF NOT EXISTS for ALTER.
   */
  private async addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
      );
    } catch {
      // Column already exists — safe to ignore
    }
  }

  /**
   * Create an index if it doesn't already exist.
   * Uses CREATE INDEX IF NOT EXISTS which is safe for both SQLite and Postgres.
   */
  private async addIndexIfMissing(
    indexName: string,
    table: string,
    column: string,
  ): Promise<void> {
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(${column})`,
    );
  }

  /**
   * Emits a dispatch message.
   *
   * Two things happen atomically (from the caller's perspective):
   * 1. One or more `Dispatch` rows are inserted with `status: 'pending'` into `_smrt_dispatch`.
   * 2. All matching in-memory handlers (registered via `on()`) are invoked
   *    fire-and-forget (errors are caught and logged, not thrown back to the caller).
   *
   * Persistent subscriptions registered via `subscribe()` will see this dispatch
   * the next time `process(subscriber, handler)` is called for their subscriber name.
   *
   * **Delivery modes** affect how dispatches are created:
   * - `compete` subscribers share a single dispatch (`target_subscriber = NULL`).
   *   First subscriber to `process()` claims it (at-most-once delivery).
   * - `fanout` subscribers each get their own dispatch copy (`target_subscriber` set
   *   to the subscriber name), so each processes independently.
   *
   * If no subscriptions exist, one dispatch is created for future processing.
   *
   * @param type - Signal type string, e.g. `'campaign.completed'` or `'invoice.paid'`
   * @param payload - Any JSON-serializable data to attach to the dispatch
   * @param options.source - Name of the emitting agent/component (default `'unknown'`)
   * @param options.sourceId - Optional ID of the specific emitting entity
   * @param options.metadata - Optional additional JSON metadata for the dispatch record
   * @returns A persisted `Dispatch` instance (the compete dispatch, or the first fanout copy if fanout-only)
   *
   * @example
   * ```typescript
   * const dispatch = await bus.emit(
   *   'campaign.completed',
   *   { campaignId: 'cmp-001', impressions: 10_000 },
   *   { source: 'suasor', sourceId: agentId },
   * );
   * console.log(dispatch.id); // UUID of the created dispatch record
   * ```
   *
   * @see {@link on} for in-memory handlers
   * @see {@link subscribe} for persistent subscriptions
   * @see {@link process} to consume pending dispatches
   */
  async emit(
    type: string,
    payload: unknown,
    options: DispatchEmitOptions = {},
  ): Promise<Dispatch> {
    await this.initialize();

    // Query subscriptions to determine if fan-out copies are needed.
    // This runs on every emit() — uses SQL-level exact matching with
    // in-memory fallback only for wildcard subscriptions to minimize I/O.
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
      correlation_id: options.correlationId || null,
    });

    // Track first persisted dispatch to return to caller
    let returnDispatch = dispatch;

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
        correlation_id: options.correlationId || null,
      });
      await DispatchCollection.insert(this.db, fanoutDispatch);
      // If no compete dispatch will be persisted, return the first fanout copy
      if (competeSubs.length === 0 && matchingSubs.length > 0) {
        returnDispatch = fanoutDispatch;
      }
    }

    // For compete subscribers (or if no subscriptions found): insert the original
    // dispatch with target_subscriber = NULL so any compete subscriber can claim it
    if (competeSubs.length > 0 || matchingSubs.length === 0) {
      await DispatchCollection.insert(this.db, dispatch);
    }

    // Notify in-memory handlers immediately (fire-and-forget)
    this.notifyHandlers(type, payload, dispatch.getMetadata());

    return returnDispatch;
  }

  /**
   * Registers an in-memory handler for a signal type pattern.
   *
   * In-memory handlers are called immediately (fire-and-forget) during `emit()`.
   * They are stored only in memory and lost on process restart — use `subscribe()`
   * for durable, restart-safe subscriptions.
   *
   * Pattern matching supports a single-segment wildcard `*`:
   * - `'campaign.*'` matches `'campaign.completed'` and `'campaign.failed'`
   * - `'campaign.*'` does **not** match `'campaign.phase.two'`
   *
   * Multiple handlers may be registered for the same pattern — all will be called.
   *
   * @param pattern - Signal type pattern, optionally with a trailing `.*` wildcard
   * @param handler - Async or sync function to call with `(payload, metadata)`
   *
   * @example
   * ```typescript
   * bus.on('invoice.*', async (payload, metadata) => {
   *   console.log(`Invoice event from ${metadata.source}:`, payload);
   * });
   * ```
   *
   * @see {@link off} to remove a handler
   * @see {@link subscribe} for persistent (restart-safe) subscriptions
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
   * Creates or updates a persistent subscription in the database.
   *
   * Persistent subscriptions survive process restarts. When `process(subscriber, handler)`
   * is called later, all pending dispatches matching this subscriber's signal patterns
   * will be delivered.
   *
   * Calling `subscribe()` with the same `signalType`/`subscriber` pair is idempotent
   * (upsert) — it is safe to call on every agent startup.
   *
   * Set `delivery: 'fanout'` to give each subscriber their own dispatch copy.
   * Default is `'compete'` (at-most-once, first subscriber to process claims it).
   *
   * @param options.signalType - Signal type pattern to subscribe to (wildcards supported)
   * @param options.subscriber - Name that identifies this subscriber (e.g. agent class name)
   * @param options.handler - Optional method name on the subscriber to call (default `'handleDispatch'`)
   * @param options.delivery - `'compete'` (default) for at-most-once, `'fanout'` for per-subscriber copies
   * @param options.enabled - If `false`, subscription is created but disabled (default `true`)
   *
   * @example
   * ```typescript
   * // Subscribe on agent startup (idempotent)
   * await bus.subscribe({ signalType: 'campaign.*', subscriber: 'FiscusAgent' });
   *
   * // Fan-out: each subscriber gets their own dispatch copy
   * await bus.subscribe({
   *   signalType: 'campaign.*',
   *   subscriber: 'AuditorAgent',
   *   delivery: 'fanout',
   * });
   *
   * // Later, process matching pending dispatches
   * await bus.process('FiscusAgent', async (payload, metadata) => { ... });
   * ```
   *
   * @see {@link process} to consume pending dispatches for this subscriber
   * @see {@link unsubscribe} to remove the subscription
   * @see {@link on} for non-persistent in-memory handling
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
   * Processes pending dispatches for a named subscriber.
   *
   * For each matching `pending` dispatch:
   * 1. Sets status to `processing`
   * 2. Calls `handler(payload, metadata)`
   * 3. On success: sets status to `completed`
   * 4. On error: sets status to `failed` (stores the error message)
   *
   * Uses a wildcard-aware query strategy: subscriptions with `*` patterns fetch
   * all pending dispatches and filter in memory; exact-match subscriptions use
   * a direct SQL `IN` query for efficiency.
   *
   * @param subscriber - The subscriber name (must match a `subscribe()` call)
   * @param handler - Function to call for each pending dispatch
   * @param options.limit - Maximum dispatches to process in one call (default 100)
   * @param options.signalTypes - Optional filter to process only specific signal types
   * @returns Number of dispatches successfully processed (excludes failed)
   *
   * @example
   * ```typescript
   * const count = await bus.process('FiscusAgent', async (payload, metadata) => {
   *   if (metadata.signalType === 'campaign.completed') {
   *     await generateInvoice(payload.campaignId);
   *   }
   * });
   * console.log(`Processed ${count} dispatches`);
   * ```
   *
   * @see {@link subscribe} to register the persistent subscription first
   * @see {@link retry} to reset failed dispatches back to pending
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
