/**
 * ProductionRunCompletionCollection — query helpers for
 * {@link ProductionRunCompletion} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ProductionRunCompletion } from '../models/ProductionRunCompletion.js';

export class ProductionRunCompletionCollection extends SmrtCollection<ProductionRunCompletion> {
  static readonly _itemClass = ProductionRunCompletion;

  /** A run's completions in the order they happened. */
  async findByRun(runId: string): Promise<ProductionRunCompletion[]> {
    return this.list({
      where: { runId },
      orderBy: ['completedAt ASC', 'created_at ASC'],
    });
  }
}
