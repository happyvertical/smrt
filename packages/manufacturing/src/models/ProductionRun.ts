/**
 * ProductionRun — a build of some quantity of a product against one
 * {@link BillOfMaterials}, reported as it happens: "25 to build, 12 done".
 *
 * The run pins the bill it was started against, carries the target and the
 * completed quantity, and moves through `planned` → `in_progress` → `done`,
 * or to `cancelled`. Each report of finished units is a dated
 * {@link ProductionRunCompletion}; `completedQty` is their sum.
 *
 * Writes go through `ProductionRunService`, which keeps `completedQty` equal
 * to the completions under concurrent reporting and enforces the status
 * transitions. The generated REST/MCP/CLI surfaces are read-only for that
 * reason.
 *
 * This is the shop-floor record of building. It is not the commercial
 * instruction to make goods (`ProductionOrder` in `@happyvertical/smrt-commerce`,
 * which carries terms and money); several runs may serve one order, or none
 * (make to stock). An application that has both links them itself.
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
import { BillOfMaterials } from './BillOfMaterials.js';

/**
 * Where a {@link ProductionRun} is:
 *
 * - `planned` — created, nothing reported yet.
 * - `in_progress` — started, or at least one completion reported.
 * - `done` — the target was reached, or the run was finished short.
 * - `cancelled` — stopped; completions already reported stay.
 */
export type ProductionRunStatus =
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'cancelled';

/** Every {@link ProductionRunStatus}, in lifecycle order. */
export const PRODUCTION_RUN_STATUSES: readonly ProductionRunStatus[] = [
  'planned',
  'in_progress',
  'done',
  'cancelled',
];

/**
 * Options accepted by the {@link ProductionRun} constructor.
 */
export interface ProductionRunOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  bomId?: string;
  targetQty?: number;
  completedQty?: number;
  status?: ProductionRunStatus;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_production_runs',
  // Writes go through ProductionRunService, which serializes completions and
  // enforces the status transitions; generated create/update would bypass it.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ProductionRun extends SmrtObject {
  /** Tenant scope. `null` means the run is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * The bill the run builds against, pinned when the run is created.
   * Restrict: a bill with runs is history and is not deleted.
   */
  @foreignKey(BillOfMaterials, { required: true, onDelete: 'RESTRICT' })
  bomId: string = '';

  /** Units of the bill's product to build. Decimal; greater than zero. */
  @field({ type: 'decimal' })
  targetQty: number = 0.0;

  /** Units reported done so far: the sum of the run's completions. */
  @field({ type: 'decimal' })
  completedQty: number = 0.0;

  /** Lifecycle status; see {@link ProductionRunStatus}. */
  @field({ required: true })
  status: ProductionRunStatus = 'planned';

  constructor(options: ProductionRunOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.bomId !== undefined) this.bomId = options.bomId;
    if (options.targetQty !== undefined) this.targetQty = options.targetQty;
    if (options.completedQty !== undefined)
      this.completedQty = options.completedQty;
    if (options.status !== undefined) this.status = options.status;
  }

  /** Units still to build; `0` once the target is reached. */
  remainingQty(): number {
    return Math.max(0, Number(this.targetQty) - Number(this.completedQty));
  }

  /** Refuses a status outside the lifecycle and impossible quantities. */
  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (!PRODUCTION_RUN_STATUSES.includes(this.status))
      throw new ValidationError(
        `Unknown production run status: ${String(this.status)}`,
        'MANUFACTURING_PRODUCTION_RUN_INVALID',
        { field: 'status' },
      );
    const target = Number(this.targetQty);
    const completed = Number(this.completedQty);
    if (!Number.isFinite(target) || target <= 0)
      throw new ValidationError(
        'A production run needs a target quantity greater than zero.',
        'MANUFACTURING_PRODUCTION_RUN_INVALID',
        { field: 'targetQty' },
      );
    if (!Number.isFinite(completed) || completed < 0)
      throw new ValidationError(
        'A production run cannot have a negative completed quantity.',
        'MANUFACTURING_PRODUCTION_RUN_INVALID',
        { field: 'completedQty' },
      );
  }
}
