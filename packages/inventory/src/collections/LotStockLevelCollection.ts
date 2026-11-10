/**
 * LotStockLevelCollection — read helpers for per-lot balances.
 *
 * Mutations live in {@link StockService}; see {@link StockLevelCollection}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { LotStockLevel } from '../models/LotStockLevel.js';
import type { StockState } from '../types.js';

export class LotStockLevelCollection extends SmrtCollection<LotStockLevel> {
  static readonly _itemClass = LotStockLevel;

  /** The level row for a `(lotId, locationId, state)` tuple, or `null`. */
  async getLevel(
    lotId: string,
    locationId: string,
    state: StockState = 'available',
  ): Promise<LotStockLevel | null> {
    const matches = await this.list({
      where: { lotId, locationId, state },
      limit: 1,
    });
    return matches[0] ?? null;
  }

  /**
   * Sum of the lot's quantity across locations. Pass `state` to narrow
   * to one state; omit it for the total across all states.
   */
  async onHand(lotId: string, state?: StockState): Promise<number> {
    const where: Record<string, unknown> = { lotId };
    if (state) where.state = state;
    const rows = await this.list({ where });
    return rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
  }
}
