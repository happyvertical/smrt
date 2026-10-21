/**
 * LotUsageCollection — read helpers for lot usage edges. Writes go
 * through {@link LotService}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { LotUsage } from '../models/LotUsage.js';

export class LotUsageCollection extends SmrtCollection<LotUsage> {
  static readonly _itemClass = LotUsage;

  /** Usages of the lot that have not been unlinked, oldest first. */
  async findActiveForLot(lotId: string): Promise<LotUsage[]> {
    return this.list({
      where: { lotId, status: 'active' },
      orderBy: 'linkedAt ASC',
    });
  }

  /** Every usage by one consumer, oldest first. Active only unless asked. */
  async findForConsumer(
    consumerType: string,
    consumerId: string,
    options: { includeUnlinked?: boolean } = {},
  ): Promise<LotUsage[]> {
    const where: Record<string, unknown> = { consumerType, consumerId };
    if (!options.includeUnlinked) where.status = 'active';
    return this.list({ where, orderBy: 'linkedAt ASC' });
  }
}
