/**
 * BomLineCollection — query helpers for {@link BomLine} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { BomLine } from '../models/BomLine.js';

export class BomLineCollection extends SmrtCollection<BomLine> {
  static readonly _itemClass = BomLine;

  /**
   * Return every line that belongs to the given BOM. Caller-stable order
   * helps make cost rollups and requirements explosions deterministic.
   */
  async findByBom(bomId: string): Promise<BomLine[]> {
    return this.list({ where: { bomId }, orderBy: 'componentSkuId ASC' });
  }

  /**
   * Return every line that references the given component SKU across all
   * BOMs. Useful for "where is this material used?" admin screens and for
   * cost-change impact analysis (a price hike on a raw material affects
   * every BOM in the result).
   */
  async findByComponent(componentSkuId: string): Promise<BomLine[]> {
    return this.list({ where: { componentSkuId }, orderBy: 'bomId ASC' });
  }
}
