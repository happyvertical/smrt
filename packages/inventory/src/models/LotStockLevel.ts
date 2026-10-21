/**
 * LotStockLevel — materialized quantity at a `(lotId, locationId, state)`
 * tuple.
 *
 * The per-lot companion to {@link StockLevel}: when a {@link StockService}
 * mutation is given a `lotId`, it applies the same deltas here as it does
 * to the SKU-level row. It is a separate table so `StockLevel`'s unique
 * key never changes.
 *
 * **Do not call `create()` or `save()` on LotStockLevel directly.** Only
 * {@link StockService} writes it, in the same transaction as the movement.
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
 * Options accepted by the {@link LotStockLevel} constructor.
 */
export interface LotStockLevelOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  lotId?: string;
  skuId?: string;
  locationId?: string;
  state?: StockState;
  qty?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_lot_stock_levels',
  conflictColumns: ['lot_id', 'location_id', 'state', 'tenant_id'],
  // Materialized state written only by StockService; see StockLevel.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class LotStockLevel extends SmrtObject {
  /** Tenant scope. `null` means the level row is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Plain string reference to the {@link Lot} this row tracks. */
  @field({ required: true, description: 'The lot being counted.' })
  lotId: string = '';

  /** Plain string reference to the Sku, copied from the movement. */
  @field({ description: 'The item the lot is of.' })
  skuId: string = '';

  /** Plain string reference to the {@link InventoryLocation}. */
  @field({ required: true, description: 'Where the lot is kept.' })
  locationId: string = '';

  /** Logical state, same vocabulary as {@link StockLevel.state}. */
  @field({
    required: true,
    description:
      'The state of this stock: available, allocated, wip, qc_hold or damaged.',
  })
  state: StockState = 'available';

  /** Current quantity of the lot in this state at this location. */
  @field({ type: 'decimal', description: 'How many are on hand.' })
  qty: number = 0.0;

  constructor(options: LotStockLevelOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.lotId !== undefined) this.lotId = options.lotId;
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.locationId !== undefined) this.locationId = options.locationId;
    if (options.state !== undefined) this.state = options.state;
    if (options.qty !== undefined) this.qty = options.qty;
  }
}
