/**
 * LotCollection — read helpers for lots. Writes go through
 * {@link LotService}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Lot } from '../models/Lot.js';

/** Normal form of a lot number used for lookup: trimmed and upper-cased. */
export function lotSearchKey(lotNumber: string): string {
  return lotNumber.trim().toUpperCase();
}

export class LotCollection extends SmrtCollection<Lot> {
  static readonly _itemClass = Lot;

  /**
   * Find lots by number, case-insensitively and ignoring surrounding
   * whitespace. A number can match several lots (one supplier lot received
   * twice); pass `skuId` to narrow. Oldest receipt first.
   */
  async findByLotNumber(
    lotNumber: string,
    options: { skuId?: string | null } = {},
  ): Promise<Lot[]> {
    const where: Record<string, unknown> = {
      searchKey: lotSearchKey(lotNumber),
    };
    if (options.skuId !== undefined) where.skuId = options.skuId;
    return this.list({ where, orderBy: 'receivedAt ASC' });
  }
}
