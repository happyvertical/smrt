/**
 * StockLevelCollection — read helpers and balance aggregations.
 *
 * Mutations live in {@link StockService}. The collection here is for
 * reading the materialized view only; callers that want to change
 * `qty` must go through the service so the StockMovement audit row is
 * also written.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { StockLevel } from '../models/StockLevel.js';
import type { StockState } from '../types.js';

export class StockLevelCollection extends SmrtCollection<StockLevel> {
  static readonly _itemClass = StockLevel;

  /**
   * Fetch the level row for a `(skuId, locationId, state)` tuple, or
   * `null` when the row has never been written. State defaults to
   * `'available'` because that is the common case (selling / picking
   * decisions are driven by available stock).
   */
  async getLevel(
    skuId: string,
    locationId: string,
    state: StockState = 'available',
  ): Promise<StockLevel | null> {
    const matches = await this.list({
      where: { skuId, locationId, state },
      limit: 1,
    });
    return matches[0] ?? null;
  }

  /**
   * Return every level row for the given SKU across all locations and
   * states. Useful for "where is this SKU?" admin screens.
   */
  async findBySku(skuId: string): Promise<StockLevel[]> {
    return this.list({ where: { skuId } });
  }

  /**
   * Return every level row at the given location. Useful for "what is
   * in this warehouse?" reports.
   */
  async findByLocation(locationId: string): Promise<StockLevel[]> {
    return this.list({ where: { locationId } });
  }

  /**
   * Sum `qty` across all level rows for the given SKU. Pass `state` to
   * narrow the sum to one logical state (e.g. only `available`);
   * omit it for grand total across all states.
   */
  async totalForSku(skuId: string, state?: StockState): Promise<number> {
    const where: Record<string, unknown> = { skuId };
    if (state) where.state = state;
    const levels = await this.list({ where });
    return levels.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
  }

  /**
   * Sum `qty` across all level rows at the given location, optionally
   * narrowed by state.
   */
  async totalForLocation(
    locationId: string,
    state?: StockState,
  ): Promise<number> {
    const where: Record<string, unknown> = { locationId };
    if (state) where.state = state;
    const levels = await this.list({ where });
    return levels.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
  }
}
