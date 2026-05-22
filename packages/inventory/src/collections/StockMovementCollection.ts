/**
 * StockMovementCollection — read-only access to the append-only audit log.
 *
 * Treat this collection as a ledger. The `StockService` is the only
 * sanctioned writer; query helpers here exist so reporting code, audit
 * UIs, and cycle-count tooling can reconstruct history.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { StockMovement } from '../models/StockMovement.js';
import type { StockMovementReason } from '../types.js';

export class StockMovementCollection extends SmrtCollection<StockMovement> {
  static readonly _itemClass = StockMovement;

  /**
   * Return every movement for the given SKU, newest first. Useful for a
   * per-SKU audit trail.
   */
  async findBySku(skuId: string): Promise<StockMovement[]> {
    return this.list({ where: { skuId }, orderBy: 'occurredAt DESC' });
  }

  /**
   * Return every movement at the given location, newest first. Useful
   * for a per-warehouse audit trail.
   */
  async findByLocation(locationId: string): Promise<StockMovement[]> {
    return this.list({
      where: { locationId },
      orderBy: 'occurredAt DESC',
    });
  }

  /**
   * Return every movement attributed to the given upstream source — for
   * example `findBySource('Contract', contract.id)` returns every
   * movement caused by the reservation/fulfilment/release of that
   * contract. Newest first.
   */
  async findBySource(
    sourceType: string,
    sourceId: string,
  ): Promise<StockMovement[]> {
    return this.list({
      where: { sourceType, sourceId },
      orderBy: 'occurredAt DESC',
    });
  }

  /**
   * Return every movement with the given reason code (`'receipt'`,
   * `'reservation'`, `'adjustment'`, …). Newest first.
   */
  async findByReason(
    reasonCode: StockMovementReason,
  ): Promise<StockMovement[]> {
    return this.list({
      where: { reasonCode },
      orderBy: 'occurredAt DESC',
    });
  }
}
