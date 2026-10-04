/**
 * ProductionRunCollection — query helpers for {@link ProductionRun} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  ProductionRun,
  type ProductionRunStatus,
} from '../models/ProductionRun.js';

export class ProductionRunCollection extends SmrtCollection<ProductionRun> {
  static readonly _itemClass = ProductionRun;

  /** Runs against one bill, newest first. */
  async findByBom(bomId: string): Promise<ProductionRun[]> {
    return this.list({ where: { bomId }, orderBy: 'created_at DESC' });
  }

  /** Runs in one status, oldest first (a work queue). */
  async findByStatus(status: ProductionRunStatus): Promise<ProductionRun[]> {
    return this.list({ where: { status }, orderBy: 'created_at ASC' });
  }
}
