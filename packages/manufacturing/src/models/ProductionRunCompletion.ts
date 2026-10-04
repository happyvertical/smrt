/**
 * ProductionRunCompletion — one dated report of finished units on a
 * {@link ProductionRun} ("12 done on Tuesday").
 *
 * Written only by `ProductionRunService.recordCompletion`, in the same
 * transaction that adds `qty` to the run's `completedQty` and, when the
 * caller asks, posts the stock movements; those movements carry
 * `sourceType: 'ProductionRunCompletion'` and this row's id. Read-only over
 * the generated surfaces.
 *
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
  ValidationError,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { ProductionRun } from './ProductionRun.js';

/**
 * Options accepted by the {@link ProductionRunCompletion} constructor.
 */
export interface ProductionRunCompletionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  runId?: string;
  qty?: number;
  completedAt?: Date | string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_production_run_completions',
  // Written only by ProductionRunService.recordCompletion.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ProductionRunCompletion extends SmrtObject {
  /** Tenant scope. `null` means a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The run the units were built on. Cascade: completions belong to their run. */
  @foreignKey(ProductionRun, { required: true, onDelete: 'CASCADE' })
  runId: string = '';

  /** Units finished in this report. Decimal; greater than zero. */
  @field({ type: 'decimal' })
  qty: number = 0.0;

  /** When the units were finished (defaults to when the report was made). */
  completedAt: Date = new Date();

  constructor(options: ProductionRunCompletionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.runId !== undefined) this.runId = options.runId;
    if (options.qty !== undefined) this.qty = options.qty;
    if (options.completedAt !== undefined)
      this.completedAt =
        options.completedAt instanceof Date
          ? options.completedAt
          : new Date(options.completedAt);
  }

  /** Refuses a report of zero, negative or non-finite units. */
  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    const qty = Number(this.qty);
    if (!Number.isFinite(qty) || qty <= 0)
      throw new ValidationError(
        'A completion needs a quantity greater than zero.',
        'MANUFACTURING_PRODUCTION_RUN_INVALID',
        { field: 'qty' },
      );
  }
}
