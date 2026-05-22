/**
 * StockLevel — materialized quantity at a `(skuId, locationId, state)` tuple.
 *
 * StockLevel is the live, mutable view of on-hand stock. There is at most
 * one row per `(skuId, locationId, state)` per tenant; the natural key
 * (`conflictColumns`) gives us idempotent upserts. Each row's `qty`
 * floats up and down as the {@link StockService} processes
 * receive/reserve/release/fulfill/transfer/adjust calls.
 *
 * **Do not call `create()` or `save()` on StockLevel directly.** All
 * mutations must go through {@link StockService}, which guarantees that
 * the level change and the corresponding append-only StockMovement land
 * together. Direct writes will silently desync the audit ledger and make
 * cycle counts unreliable.
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
import type { StockState } from '../types.js';

/**
 * Options accepted by the {@link StockLevel} constructor.
 */
export interface StockLevelOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  skuId?: string;
  locationId?: string;
  state?: StockState;
  qty?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_stock_levels',
  conflictColumns: ['sku_id', 'location_id', 'state', 'tenant_id'],
  // StockLevel is materialized state, written only by StockService.
  // Mirror the read-only api/mcp posture on the CLI — `cli: true` would
  // generate create/update/delete subcommands that let a CLI user
  // mutate `qty` (or delete a row) without writing a paired
  // StockMovement, silently desyncing the audit ledger from the
  // materialized balance. The Gotchas section in CLAUDE.md spells out
  // the "never call StockLevel.save() directly" rule; the CLI must
  // follow the same constraint.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class StockLevel extends SmrtObject {
  /** Tenant scope. `null` means the level row is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Plain string reference to the {@link Sku} this row tracks. */
  @field({ required: true })
  skuId: string = '';

  /** Plain string reference to the {@link InventoryLocation} this row tracks. */
  @field({ required: true })
  locationId: string = '';

  /** Logical state — `available`, `allocated`, `wip`, `qc_hold`, `damaged`. */
  @field({ required: true })
  state: StockState = 'available';

  /**
   * Current quantity. Fractional values are allowed (`= 0.0`) for
   * domains that count in units of measure other than whole pieces
   * (kilograms, litres, metres).
   */
  @field({ type: 'decimal' })
  qty: number = 0.0;

  constructor(options: StockLevelOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.locationId !== undefined) this.locationId = options.locationId;
    if (options.state !== undefined) this.state = options.state;
    if (options.qty !== undefined) this.qty = options.qty;
  }
}
