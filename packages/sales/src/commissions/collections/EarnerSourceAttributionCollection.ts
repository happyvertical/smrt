/**
 * EarnerSourceAttributionCollection — collection manager for
 * {@link EarnerSourceAttribution}.
 *
 * The queries here are the indexed primitives; the earner-resolving lookups
 * (single + batched, active-earner filtered, ambiguity fail-closed) live on
 * `EarnerAttributionService`.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { EarnerSourceAttribution } from '../models/EarnerSourceAttribution.js';

export class EarnerSourceAttributionCollection extends SmrtCollection<EarnerSourceAttribution> {
  static readonly _itemClass = EarnerSourceAttribution;

  /** Every mapping for one external key (any status), oldest first. */
  async findBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<EarnerSourceAttribution[]> {
    if (!sourceKind || !sourceId) return [];
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Every mapping for a batch of external keys sharing one kind (any
   * status), in one indexed `IN` query. Empty/duplicate ids are dropped;
   * an empty batch returns `[]` without querying.
   */
  async findBySources(
    sourceKind: string,
    sourceIds: string[],
  ): Promise<EarnerSourceAttribution[]> {
    if (!sourceKind) return [];
    const ids = [...new Set(sourceIds.filter(Boolean))];
    if (ids.length === 0) return [];
    return await this.list({
      where: { sourceKind, sourceId: ids },
      orderBy: 'created_at ASC',
    });
  }

  /** All mappings held by one earner (any status), oldest first. */
  async findByEarner(earnerId: string): Promise<EarnerSourceAttribution[]> {
    return await this.list({
      where: { earnerId },
      orderBy: 'created_at ASC',
    });
  }
}

export default EarnerSourceAttributionCollection;
