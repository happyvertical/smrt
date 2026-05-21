/**
 * StockService — the only sanctioned way to mutate stock.
 *
 * Every mutation goes through one of six methods (`receive`, `reserve`,
 * `release`, `fulfill`, `transfer`, `adjust`). Each one:
 *
 * 1. Updates the materialized {@link StockLevel} row(s) for the affected
 *    `(skuId, locationId, state)` tuples via the collection's upsert path.
 * 2. Writes exactly one append-only {@link StockMovement} (or two for
 *    `transfer`, one per leg) carrying the reason, source attribution,
 *    quantity, and from/to state transition.
 *
 * **Atomicity**: each method runs every write inside a single database
 * transaction (`db.transaction(...)` on `@happyvertical/sql >= 0.74.0`).
 * Partial failure — e.g. the level write succeeds but the movement
 * write throws — rolls the entire mutation back, so the materialized
 * balance and the audit ledger never disagree. `transfer` writes both
 * legs (source out, destination in) plus both movement rows in one tx,
 * so a failure mid-`transfer` is also fully rolled back.
 *
 * If the underlying adapter does not expose `transaction()` (rare —
 * sqlite, postgres, and duckdb all do as of 0.74.0; the JSON adapter
 * does too), the service degrades to serial writes and emits a one-time
 * `console.warn`. Tests and consumers that observe that warning should
 * upgrade their adapter.
 *
 * Callers should never reach into the level or movement collections
 * directly to mutate balances — doing so silently desyncs the audit
 * ledger and breaks cycle counts.
 *
 * Concurrency: each method is a read-modify-write on the underlying
 * StockLevel row. Awaited (serial) callers always see a consistent
 * balance. Unawaited `Promise.all([reserve, reserve, ...])` against the
 * same `(skuId, locationId)` can still over-allocate — the per-tx
 * locking guarantees atomicity of each individual call, not isolation
 * across concurrent transactions. Callers that need hard atomicity
 * across concurrent reservations should serialise upstream (e.g. via
 * the job runner from `@happyvertical/smrt-jobs`).
 *
 * @packageDocumentation
 */

import type { DatabaseConfig } from '@happyvertical/smrt-core';
import {
  InventoryLocationCollection,
  StockLevelCollection,
  StockMovementCollection,
} from '../collections/index.js';
import type { StockLevel } from '../models/StockLevel.js';
import type { StockMovementReason, StockState } from '../types.js';

/**
 * Thrown by {@link StockService.reserve} (and {@link StockService.fulfill},
 * {@link StockService.transfer}) when the caller asks to move more stock
 * than the source state currently holds. Carries enough context for a
 * caller to surface a meaningful UI message and decide whether to retry,
 * backorder, or cancel.
 */
export class InsufficientStockError extends Error {
  override name = 'InsufficientStockError';

  constructor(
    public readonly skuId: string,
    public readonly locationId: string,
    public readonly state: StockState,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      `Insufficient stock: sku=${skuId} location=${locationId} state=${state} ` +
        `requested=${requested} available=${available}`,
    );
  }
}

/**
 * Options shared by every {@link StockService} method that wants to leave
 * an audit attribution behind. Pairs neatly with the cross-package
 * pattern in {@link StockMovement.sourceType} / {@link StockMovement.sourceId}.
 */
export interface StockMutationOptions {
  /** Cross-package tag, e.g. `'Contract'`, `'Fulfillment'`, `'CycleCount'`. */
  sourceType?: string;
  /** Cross-package id of the row that caused this mutation. */
  sourceId?: string;
  /** Free-form note shown in audit UIs. */
  note?: string;
  /**
   * Override the reason code stamped on the {@link StockMovement}. Each
   * method picks a sensible default; explicit overrides are useful when a
   * vertical wants to flag a more specific reason (e.g. `'return'`
   * instead of `'receipt'`).
   */
  reasonCode?: StockMovementReason;
}

/**
 * Options accepted by the {@link StockService} factory.
 */
export interface StockServiceOptions {
  /**
   * Database to read/write through. Accepts the same shapes that
   * `SmrtCollection.create({ db })` accepts — a `DatabaseInterface`, a
   * connection-string URL, or a `{ type, url }` config object. Reused by
   * the internal collections so the service, level reads, and movement
   * writes always hit the same connection / pool.
   */
  db: DatabaseConfig;
}

interface AdjustLevelOptions {
  skuId: string;
  locationId: string;
  state: StockState;
  delta: number;
  enforceNonNegative?: boolean;
}

interface WriteMovementOptions {
  skuId: string;
  locationId: string;
  fromState: StockState | null;
  toState: StockState | null;
  qty: number;
  reasonCode: StockMovementReason;
  sourceType?: string;
  sourceId?: string;
  note?: string;
}

/**
 * Sanctioned stock-mutation surface.
 *
 * Construct via {@link createStockService} — the static factory wires up
 * the underlying collections and shares one database connection across
 * level reads and movement writes.
 *
 * @example
 * ```typescript
 * const service = await createStockService({ db });
 * await service.receive(sku.id, warehouse.id, 100, {
 *   sourceType: 'PurchaseOrder',
 *   sourceId: po.id,
 * });
 * await service.reserve(sku.id, warehouse.id, 10, {
 *   sourceType: 'Contract',
 *   sourceId: order.id,
 * });
 * await service.fulfill(sku.id, warehouse.id, 10, {
 *   sourceType: 'Fulfillment',
 *   sourceId: fulfillment.id,
 * });
 * ```
 */
export class StockService {
  private constructor(
    /**
     * The database config this service was bound to (URL string, config
     * object, or already-resolved `DatabaseInterface`). Exposed so
     * downstream services that compose StockService (e.g. BomService,
     * ProductionService in `@happyvertical/smrt-manufacturing`) can pass
     * the same value to their own collection factories without reaching
     * into private fields on the collections.
     */
    public readonly db: DatabaseConfig,
    public readonly levels: StockLevelCollection,
    public readonly movements: StockMovementCollection,
    public readonly locations: InventoryLocationCollection,
    /**
     * Marks a service instance handed to a {@link withTransaction}
     * callback. Public mutation methods on a tx-bound instance skip
     * opening a nested transaction and just execute against the already-
     * bound collections; outer (non-tx) instances open a fresh
     * transaction per mutation. Internal flag — consumers never set it.
     */
    private readonly inTransaction: boolean = false,
  ) {}

  /** Internal factory — prefer {@link createStockService}. */
  static async create(options: StockServiceOptions): Promise<StockService> {
    const { db } = options;
    const [levels, movements, locations] = await Promise.all([
      StockLevelCollection.create({ db }),
      StockMovementCollection.create({ db }),
      InventoryLocationCollection.create({ db }),
    ]);
    return new StockService(db, levels, movements, locations);
  }

  /**
   * Run `work` inside a single database transaction with a tx-bound
   * {@link StockService} instance. All mutation calls on `tx` commit
   * atomically when `work` resolves and roll back if it throws.
   *
   * Use this when you need atomicity ACROSS multiple stock-service
   * calls — e.g. consuming materials for every line of a production
   * order in `@happyvertical/smrt-manufacturing`'s `ProductionService`,
   * or a custom workflow that reserves + fulfills + writes a custom
   * audit comment in one indivisible step. Individual mutation methods
   * (`receive`, `reserve`, etc.) are already atomic on their own — you
   * only need `withTransaction` for cross-call composition.
   *
   * Nesting is safe: calling `tx.withTransaction(...)` inside an
   * already-tx-bound callback simply runs the inner `work` on the same
   * transaction without opening a savepoint.
   *
   * When the underlying adapter does not expose `transaction()`, falls
   * through to a serial run on the regular collections with a one-time
   * warning. All four built-in adapters in `@happyvertical/sql >= 0.74.0`
   * support it; only test stubs would hit this branch.
   */
  async withTransaction<T>(work: (tx: StockService) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this);

    const underlying = (this.levels as unknown as { db?: unknown }).db as
      | { transaction?: (cb: (txDb: unknown) => Promise<T>) => Promise<T> }
      | undefined;

    if (typeof underlying?.transaction !== 'function') {
      warnNonTransactional();
      return work(this);
    }

    return underlying.transaction(async (txDb) => {
      const [levels, movements, locations] = await Promise.all([
        StockLevelCollection.create({ db: txDb as DatabaseConfig }),
        StockMovementCollection.create({ db: txDb as DatabaseConfig }),
        InventoryLocationCollection.create({ db: txDb as DatabaseConfig }),
      ]);
      const tx = new StockService(
        this.db,
        levels,
        movements,
        locations,
        /* inTransaction */ true,
      );
      return work(tx);
    });
  }

  /**
   * Internal: run a single-method mutation in a transaction. If we're
   * already inside one (the instance was handed to a `withTransaction`
   * callback), reuse it; otherwise open a fresh one.
   */
  private async runAtomically<T>(
    work: (tx: {
      levels: StockLevelCollection;
      movements: StockMovementCollection;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.inTransaction) {
      return work({ levels: this.levels, movements: this.movements });
    }
    return this.withTransaction(async (tx) =>
      work({ levels: tx.levels, movements: tx.movements }),
    );
  }

  /**
   * Add `qty` to available stock at the given location. Used for
   * purchase-order receipts, customer returns going back into available
   * inventory, and the "produce" leg of a production order.
   */
  async receive(
    skuId: string,
    locationId: string,
    qty: number,
    options: StockMutationOptions = {},
  ): Promise<void> {
    assertPositiveQty(qty, 'receive');
    await this.runAtomically(async (tx) => {
      await adjustLevel(tx.levels, {
        skuId,
        locationId,
        state: 'available',
        delta: qty,
      });
      await writeMovement(tx.movements, {
        skuId,
        locationId,
        fromState: null,
        toState: 'available',
        qty,
        reasonCode: options.reasonCode ?? 'receipt',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }

  /**
   * Move `qty` from `available` to `allocated` at the given location.
   * Throws {@link InsufficientStockError} if available stock would go
   * negative.
   */
  async reserve(
    skuId: string,
    locationId: string,
    qty: number,
    options: StockMutationOptions = {},
  ): Promise<void> {
    assertPositiveQty(qty, 'reserve');
    await this.runAtomically(async (tx) => {
      await transitionState(tx, {
        skuId,
        locationId,
        fromState: 'available',
        toState: 'allocated',
        qty,
        reasonCode: options.reasonCode ?? 'reservation',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }

  /**
   * Move `qty` from `allocated` back to `available`. Used when a
   * reservation is cancelled and the previously-reserved stock should
   * go back into the available pool.
   */
  async release(
    skuId: string,
    locationId: string,
    qty: number,
    options: StockMutationOptions = {},
  ): Promise<void> {
    assertPositiveQty(qty, 'release');
    await this.runAtomically(async (tx) => {
      await transitionState(tx, {
        skuId,
        locationId,
        fromState: 'allocated',
        toState: 'available',
        qty,
        reasonCode: options.reasonCode ?? 'release',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }

  /**
   * Remove `qty` from `allocated` at the given location. Stock leaves
   * the building entirely (shipped, picked up, consumed). Throws
   * {@link InsufficientStockError} if allocated stock would go negative.
   */
  async fulfill(
    skuId: string,
    locationId: string,
    qty: number,
    options: StockMutationOptions = {},
  ): Promise<void> {
    assertPositiveQty(qty, 'fulfill');
    await this.runAtomically(async (tx) => {
      await assertAvailable(tx.levels, skuId, locationId, 'allocated', qty);
      await adjustLevel(tx.levels, {
        skuId,
        locationId,
        state: 'allocated',
        delta: -qty,
        // Already enforced via assertAvailable; skipping the second check
        // avoids a needless extra DB round-trip in the hot path.
        enforceNonNegative: false,
      });
      await writeMovement(tx.movements, {
        skuId,
        locationId,
        fromState: 'allocated',
        toState: null,
        qty,
        reasonCode: options.reasonCode ?? 'fulfillment',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }

  /**
   * Move `qty` of `available` stock from `fromLocationId` to
   * `toLocationId`. Writes two movement rows — one for the `transfer_out`
   * leg, one for the `transfer_in` leg — so the audit log preserves the
   * lineage in both directions. Throws {@link InsufficientStockError} if
   * source available stock would go negative.
   *
   * Both legs (level writes + movement rows) run inside one transaction
   * — a failure mid-`transfer` rolls back the source debit so there's no
   * "ghost stock disappearance" (source decremented, destination never
   * credited).
   */
  async transfer(
    skuId: string,
    fromLocationId: string,
    toLocationId: string,
    qty: number,
    options: StockMutationOptions = {},
  ): Promise<void> {
    assertPositiveQty(qty, 'transfer');
    if (fromLocationId === toLocationId) {
      throw new Error(
        `transfer: fromLocationId and toLocationId must differ (got ${fromLocationId})`,
      );
    }
    await this.runAtomically(async (tx) => {
      await assertAvailable(tx.levels, skuId, fromLocationId, 'available', qty);

      // Source leg: decrement available at origin.
      await adjustLevel(tx.levels, {
        skuId,
        locationId: fromLocationId,
        state: 'available',
        delta: -qty,
        enforceNonNegative: false,
      });
      await writeMovement(tx.movements, {
        skuId,
        locationId: fromLocationId,
        fromState: 'available',
        toState: null,
        qty,
        reasonCode: options.reasonCode ?? 'transfer_out',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });

      // Destination leg: increment available at destination.
      await adjustLevel(tx.levels, {
        skuId,
        locationId: toLocationId,
        state: 'available',
        delta: qty,
      });
      await writeMovement(tx.movements, {
        skuId,
        locationId: toLocationId,
        fromState: null,
        toState: 'available',
        qty,
        reasonCode: options.reasonCode ?? 'transfer_in',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }

  /**
   * Apply a positive or negative `delta` to a level row. Used for cycle
   * counts and one-off corrections; `delta=+5` adds five units,
   * `delta=-2` removes two. By default the adjustment targets
   * `available` stock; pass an explicit `state` to adjust a different
   * bucket (e.g. `'damaged'` after a quality-control reclassification).
   *
   * Adjusting by `0` is rejected as a probable programming error — the
   * caller almost always meant a non-zero delta and a no-op write would
   * still cost an audit row.
   */
  async adjust(
    skuId: string,
    locationId: string,
    delta: number,
    options: StockMutationOptions & { state?: StockState } = {},
  ): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) {
      throw new Error(
        `adjust: delta must be a non-zero finite number (got ${delta})`,
      );
    }
    const state = options.state ?? 'available';
    await this.runAtomically(async (tx) => {
      if (delta < 0) {
        await assertAvailable(tx.levels, skuId, locationId, state, -delta);
      }
      await adjustLevel(tx.levels, {
        skuId,
        locationId,
        state,
        delta,
        enforceNonNegative: false,
      });
      await writeMovement(tx.movements, {
        skuId,
        locationId,
        fromState: delta < 0 ? state : null,
        toState: delta > 0 ? state : null,
        qty: Math.abs(delta),
        reasonCode: options.reasonCode ?? 'adjustment',
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        note: options.note,
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tx-scoped helpers
//
// These are module-level functions rather than instance methods so each
// call site can pass tx-scoped collections through cleanly. The previous
// versions read `this.levels` / `this.movements` directly which bypassed
// the transaction. Public methods now wrap everything in
// `runAtomically` and call these helpers with the tx-scoped pair.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read the current level row, sanity-check the result, and throw
 * {@link InsufficientStockError} when the requested quantity is not
 * available.
 */
async function assertAvailable(
  levels: StockLevelCollection,
  skuId: string,
  locationId: string,
  state: StockState,
  requested: number,
): Promise<void> {
  const level = await levels.getLevel(skuId, locationId, state);
  const available = level ? Number(level.qty ?? 0) : 0;
  if (available < requested) {
    throw new InsufficientStockError(
      skuId,
      locationId,
      state,
      requested,
      available,
    );
  }
}

/**
 * Atomically transition `qty` from one state to another at a single
 * location. Used by `reserve` and `release`.
 */
async function transitionState(
  tx: { levels: StockLevelCollection; movements: StockMovementCollection },
  args: {
    skuId: string;
    locationId: string;
    fromState: StockState;
    toState: StockState;
    qty: number;
    reasonCode: StockMovementReason;
    sourceType?: string;
    sourceId?: string;
    note?: string;
  },
): Promise<void> {
  await assertAvailable(
    tx.levels,
    args.skuId,
    args.locationId,
    args.fromState,
    args.qty,
  );
  await adjustLevel(tx.levels, {
    skuId: args.skuId,
    locationId: args.locationId,
    state: args.fromState,
    delta: -args.qty,
    enforceNonNegative: false,
  });
  await adjustLevel(tx.levels, {
    skuId: args.skuId,
    locationId: args.locationId,
    state: args.toState,
    delta: args.qty,
  });
  await writeMovement(tx.movements, {
    skuId: args.skuId,
    locationId: args.locationId,
    fromState: args.fromState,
    toState: args.toState,
    qty: args.qty,
    reasonCode: args.reasonCode,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    note: args.note,
  });
}

/**
 * Read-modify-write a level row by `delta`. Creates the row when it
 * doesn't exist yet. When `enforceNonNegative` is set, refuses to
 * write a negative `qty` and throws {@link InsufficientStockError}
 * with the original (non-decremented) balance.
 */
async function adjustLevel(
  levels: StockLevelCollection,
  options: AdjustLevelOptions,
): Promise<StockLevel> {
  const enforce = options.enforceNonNegative ?? options.delta < 0;
  const existing = await levels.getLevel(
    options.skuId,
    options.locationId,
    options.state,
  );
  const previous = existing ? Number(existing.qty ?? 0) : 0;
  const next = previous + options.delta;

  if (enforce && next < 0) {
    throw new InsufficientStockError(
      options.skuId,
      options.locationId,
      options.state,
      Math.abs(options.delta),
      previous,
    );
  }

  if (existing) {
    existing.qty = next;
    await existing.save();
    return existing;
  }

  // SmrtCollection.create() saves the row before returning, so no further
  // save() is needed here. Calling save() again would emit a redundant
  // upsert round-trip on every hot-path first write.
  const level = await levels.create({
    skuId: options.skuId,
    locationId: options.locationId,
    state: options.state,
    qty: next,
  });
  return level;
}

/**
 * Append a movement to the audit log. Never updates an existing row —
 * the natural key is the surrogate id, so each call writes a fresh
 * append-only entry.
 */
async function writeMovement(
  movements: StockMovementCollection,
  options: WriteMovementOptions,
): Promise<void> {
  // SmrtCollection.create() persists the row before returning. A
  // follow-up save() would emit a redundant upsert round-trip on every
  // single stock mutation (one or two per service call) — and the
  // movement table is append-only, so there's nothing to re-save.
  await movements.create({
    skuId: options.skuId,
    locationId: options.locationId,
    fromState: options.fromState,
    toState: options.toState,
    qty: options.qty,
    reasonCode: options.reasonCode,
    sourceType: options.sourceType ?? '',
    sourceId: options.sourceId ?? '',
    note: options.note ?? '',
    occurredAt: new Date(),
  });
}

/**
 * Reject zero / negative / non-finite quantities up front. Most stock
 * mutation methods accept positive quantities only; {@link StockService.adjust}
 * is the exception (it accepts signed deltas) and validates separately.
 */
function assertPositiveQty(qty: number, op: string): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${op}: qty must be a positive finite number (got ${qty})`);
  }
}

let warnedNonTransactional = false;

/**
 * Emit a one-time `console.warn` when the underlying SQL adapter does
 * not expose `transaction()`. All four `@happyvertical/sql >= 0.74.0`
 * adapters implement it — only test stubs or third-party adapters would
 * trip this branch.
 */
function warnNonTransactional(): void {
  if (warnedNonTransactional) return;
  warnedNonTransactional = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[@happyvertical/smrt-inventory] StockService: underlying SQL adapter ' +
      'does not expose `transaction()`. Stock mutations are degrading to ' +
      'non-atomic serial writes — partial failures may leave the materialized ' +
      'level and the audit ledger out of sync. Upgrade @happyvertical/sql to ' +
      '>= 0.74.0 or use one of its built-in adapters.',
  );
}

/**
 * Convenience factory. Returns a fully-initialized {@link StockService}
 * sharing the given database with its internal collections.
 */
export async function createStockService(
  options: StockServiceOptions,
): Promise<StockService> {
  return StockService.create(options);
}
