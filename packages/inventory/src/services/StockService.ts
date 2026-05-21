/**
 * StockService — the only sanctioned way to mutate stock.
 *
 * Every mutation goes through one of six methods (`receive`, `reserve`,
 * `release`, `fulfill`, `transfer`, `adjust`). Each one:
 *
 * 1. Updates the materialized {@link StockLevel} row(s) for the affected
 *    `(skuId, locationId, state)` tuples via the
 *    collection's upsert path.
 * 2. Writes exactly one append-only {@link StockMovement} (or two for
 *    `transfer`, one per leg) carrying the reason, source attribution,
 *    quantity, and from/to state transition.
 *
 * Callers should never reach into the level or movement collections
 * directly to mutate balances — doing so silently desyncs the audit
 * ledger and breaks cycle counts.
 *
 * Concurrency: each method is a read-modify-write on the underlying
 * StockLevel row. Awaited (serial) callers always see a consistent
 * balance. Unawaited `Promise.all([reserve, reserve, ...])` against the
 * same `(skuId, locationId)` can over-allocate because the current
 * `@happyvertical/sql` adapter does not lock per-key — callers that
 * need hard atomicity across concurrent reservations should serialise
 * upstream (e.g. via the job runner from `@happyvertical/smrt-jobs`).
 * The audit ledger still emits exactly one StockMovement per successful
 * call, so reconciliation remains intact.
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
    await this.adjustLevel({
      skuId,
      locationId,
      state: 'available',
      delta: qty,
    });
    await this.writeMovement({
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
    await this.transitionState({
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
    await this.transitionState({
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
    await this.assertAvailable(skuId, locationId, 'allocated', qty);
    await this.adjustLevel({
      skuId,
      locationId,
      state: 'allocated',
      delta: -qty,
      // Already enforced via assertAvailable; skipping the second check
      // avoids a needless extra DB round-trip in the hot path.
      enforceNonNegative: false,
    });
    await this.writeMovement({
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
  }

  /**
   * Move `qty` of `available` stock from `fromLocationId` to
   * `toLocationId`. Writes two movement rows — one for the `transfer_out`
   * leg, one for the `transfer_in` leg — so the audit log preserves the
   * lineage in both directions. Throws {@link InsufficientStockError} if
   * source available stock would go negative.
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
    await this.assertAvailable(skuId, fromLocationId, 'available', qty);

    // Source leg: decrement available at origin.
    await this.adjustLevel({
      skuId,
      locationId: fromLocationId,
      state: 'available',
      delta: -qty,
      enforceNonNegative: false,
    });
    await this.writeMovement({
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
    await this.adjustLevel({
      skuId,
      locationId: toLocationId,
      state: 'available',
      delta: qty,
    });
    await this.writeMovement({
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
    if (delta < 0) {
      await this.assertAvailable(skuId, locationId, state, -delta);
    }
    await this.adjustLevel({
      skuId,
      locationId,
      state,
      delta,
      enforceNonNegative: false,
    });
    await this.writeMovement({
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
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read the current level row, sanity-check the result, and throw
   * {@link InsufficientStockError} when the requested quantity is not
   * available. Helper around the common "guard the negative" pattern
   * used by `reserve`, `fulfill`, `transfer`, and `adjust(-delta)`.
   */
  private async assertAvailable(
    skuId: string,
    locationId: string,
    state: StockState,
    requested: number,
  ): Promise<void> {
    const level = await this.levels.getLevel(skuId, locationId, state);
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
   * location. Used by `reserve` and `release`. Composes
   * `assertAvailable` with two paired `adjustLevel` calls.
   */
  private async transitionState(args: {
    skuId: string;
    locationId: string;
    fromState: StockState;
    toState: StockState;
    qty: number;
    reasonCode: StockMovementReason;
    sourceType?: string;
    sourceId?: string;
    note?: string;
  }): Promise<void> {
    await this.assertAvailable(
      args.skuId,
      args.locationId,
      args.fromState,
      args.qty,
    );
    await this.adjustLevel({
      skuId: args.skuId,
      locationId: args.locationId,
      state: args.fromState,
      delta: -args.qty,
      enforceNonNegative: false,
    });
    await this.adjustLevel({
      skuId: args.skuId,
      locationId: args.locationId,
      state: args.toState,
      delta: args.qty,
    });
    await this.writeMovement({
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
   * with the original (non-decremented) balance — gives callers a
   * symmetric error path for "no row exists yet, you can't fulfill from
   * an empty bucket".
   */
  private async adjustLevel(options: AdjustLevelOptions): Promise<StockLevel> {
    const enforce = options.enforceNonNegative ?? options.delta < 0;
    const existing = await this.levels.getLevel(
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
    const level = await this.levels.create({
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
  private async writeMovement(options: WriteMovementOptions): Promise<void> {
    // SmrtCollection.create() persists the row before returning. A
    // follow-up save() would emit a redundant upsert round-trip on every
    // single stock mutation (one or two per service call) — and the
    // movement table is append-only, so there's nothing to re-save.
    await this.movements.create({
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

/**
 * Convenience factory. Returns a fully-initialized {@link StockService}
 * sharing the given database with its internal collections.
 */
export async function createStockService(
  options: StockServiceOptions,
): Promise<StockService> {
  return StockService.create(options);
}
