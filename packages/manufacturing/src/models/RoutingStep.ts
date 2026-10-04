/**
 * RoutingStep — one operation in the routing of a {@link BillOfMaterials}.
 *
 * A routing is the ordered list of steps for building one unit of the bill's
 * product. It is optional: a bill with no routing steps behaves exactly as a
 * bill always has. Steps are ordered by `sequence`, unique within the bill.
 *
 * Cross-package-style references (`bomId`, `operationId`) are plain string ids,
 * as elsewhere in this package.
 *
 * @packageDocumentation
 */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Options accepted by the {@link RoutingStep} constructor.
 */
export interface RoutingStepOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  bomId?: string;
  operationId?: string;
  sequence?: number;
  estimatedMinutes?: number;
  notes?: string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_routing_steps',
  // One step per position per bill per tenant.
  conflictColumns: ['bom_id', 'sequence', 'tenant_id'],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class RoutingStep extends SmrtObject {
  /** Tenant scope. `null` means the step is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Plain string id of the owning {@link BillOfMaterials}. */
  @field({ required: true })
  bomId: string = '';

  /** Plain string id of the {@link Operation} performed at this step. */
  @field({ required: true })
  operationId: string = '';

  /** Position in the routing, starting at 1 and without gaps. */
  @field({ required: true })
  sequence: number = 1;

  /**
   * Estimated working minutes at this step to build one unit of the bill's
   * product. Decimal so `7.5` round-trips.
   */
  @field({ type: 'decimal' })
  estimatedMinutes: number = 0.0;

  /** Optional free-form note for this step. */
  notes: string = '';

  constructor(options: RoutingStepOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.bomId !== undefined) this.bomId = options.bomId;
    if (options.operationId !== undefined)
      this.operationId = options.operationId;
    if (options.sequence !== undefined) this.sequence = options.sequence;
    if (options.estimatedMinutes !== undefined)
      this.estimatedMinutes = options.estimatedMinutes;
    if (options.notes !== undefined) this.notes = options.notes;
  }
}
