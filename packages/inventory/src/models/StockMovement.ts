/**
 * StockMovement — append-only audit row written for every stock mutation.
 *
 * Every call into {@link StockService} produces exactly one StockMovement
 * row (or two for `transfer`, one per leg). These rows are the ledger of
 * record: balances on {@link StockLevel} are derived state that could
 * always, in principle, be reconstructed by replaying movements in
 * order.
 *
 * **Movements are append-only.** The package treats updates as a bug and
 * relies on this for cycle-count reconciliation, audit, and source-system
 * attribution. Never call `save()` on a previously-persisted StockMovement
 * with mutated fields, and never let CRUD UIs expose update/delete on the
 * table.
 *
 * Cross-package attribution lives in `sourceType` + `sourceId` so a
 * downstream package can write `'Contract'` + the contract id when it
 * reserves stock, then later query "which movements were caused by
 * contract X?" without joining across the framework.
 *
 * @packageDocumentation
 */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { StockMovementReason, StockState } from '../types.js';

/**
 * Options accepted by the {@link StockMovement} constructor.
 */
export interface StockMovementOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  skuId?: string;
  locationId?: string;
  fromState?: StockState | null;
  toState?: StockState | null;
  qty?: number;
  reasonCode?: StockMovementReason;
  sourceType?: string;
  sourceId?: string;
  note?: string;
  occurredAt?: Date | string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_stock_movements',
  // Append-only: the natural key is the surrogate id, so updates can
  // never collide on conflictColumns. Setting `id` explicitly here
  // documents the intent and prevents future contributors from
  // accidentally adding a "domain natural key" that would let upserts
  // overwrite history.
  conflictColumns: ['id'],
  // Movements are an audit log — never mutate or delete via generated
  // CRUD. Reads are fine for reporting and admin tooling.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class StockMovement extends SmrtObject {
  /** Tenant scope. `null` means the movement is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Plain string reference to the {@link Sku} being moved. */
  @field({ required: true })
  skuId: string = '';

  /** Plain string reference to the {@link InventoryLocation} being mutated. */
  @field({ required: true })
  locationId: string = '';

  /**
   * Origin state for transitions (e.g. `available` → `allocated` for a
   * reservation). `null` indicates "no origin" — used when stock enters
   * the system fresh via {@link StockService.receive} or production.
   */
  fromState: StockState | null = null;

  /**
   * Destination state. `null` indicates "no destination" — used for
   * fulfilment, where stock leaves the building entirely.
   */
  toState: StockState | null = null;

  /** Quantity moved. Always positive; the direction is encoded by from/to. */
  @field({ type: 'decimal' })
  qty: number = 0.0;

  /**
   * Why the movement happened (see {@link StockMovementReason}). Drawn
   * from the canonical list when emitted by {@link StockService}; free-form
   * strings are allowed for vertical-specific reasons.
   */
  @field({ required: true })
  reasonCode: StockMovementReason = 'adjustment';

  /**
   * Cross-package attribution tag — e.g. `'Contract'`, `'Fulfillment'`,
   * `'ProductionOrder'`, `'CycleCount'`. The package writing the
   * movement decides what tag makes sense; readers can group by
   * `(sourceType, sourceId)` to reconstruct "what caused this".
   */
  sourceType: string = '';

  /**
   * Cross-package id of the row that caused this movement. Plain string;
   * the framework never dereferences it.
   */
  sourceId: string = '';

  /** Optional free-form note shown in audit UIs. */
  note: string = '';

  /**
   * When the movement happened. Set to `now` at write time; explicit
   * values are allowed when back-dating an import.
   */
  occurredAt: Date = new Date();

  constructor(options: StockMovementOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.locationId !== undefined) this.locationId = options.locationId;
    if (options.fromState !== undefined) this.fromState = options.fromState;
    if (options.toState !== undefined) this.toState = options.toState;
    if (options.qty !== undefined) this.qty = options.qty;
    if (options.reasonCode !== undefined) this.reasonCode = options.reasonCode;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.note !== undefined) this.note = options.note;
    if (options.occurredAt !== undefined) {
      this.occurredAt =
        options.occurredAt instanceof Date
          ? options.occurredAt
          : new Date(options.occurredAt);
    }
  }
}
