/**
 * Operation — one kind of work done to build something: cut, weld, assemble,
 * inspect, bake, pack. A managed list per tenant that routing steps point at.
 *
 * Retiring an operation (`isActive = false`) keeps it on every routing and
 * history that already names it and takes it out of pickers; an operation is
 * never deleted. Time recorded against an operation is not modelled here — it
 * stays in `@happyvertical/smrt-timesheets` or the application.
 *
 * Strictly industry-neutral.
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
 * Options accepted by the {@link Operation} constructor.
 */
export interface OperationOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  code?: string;
  name?: string;
  category?: string;
  isActive?: boolean;
  requiredQualificationId?: string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_operations',
  // Natural key: one operation per code per tenant.
  conflictColumns: ['code', 'tenant_id'],
  // Writes go through OperationService, which rejects a duplicate code and
  // keeps the code fixed; generated create/update would upsert or rename.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Operation extends SmrtObject {
  /** Tenant scope. `null` means the operation is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Short stable code, unique per tenant (`CUT`, `WELD`). Treated as the
   * operation's identity by {@link OperationService}: it is set when the
   * operation is defined and is not changed afterwards; rename the `name`.
   */
  @field({ required: true })
  code: string = '';

  /** Human-readable name shown in lists and pickers. */
  @field({ required: true })
  name: string = '';

  /**
   * Free-text grouping for lists (`fabrication`, `finishing`, `quality`).
   * Empty when the operation is not grouped.
   */
  category: string = '';

  /**
   * `false` once the operation is retired. A retired operation stays on the
   * routings and history that name it and is left out of pickers.
   */
  isActive: boolean = true;

  /**
   * Optional plain string id of the qualification definition a worker needs to
   * start this operation: a `Qualification` from
   * `@happyvertical/smrt-human-resources`. This package does not import or
   * validate it; an application reads it to decide who may start the
   * operation. Empty when no qualification is required.
   */
  requiredQualificationId: string = '';

  constructor(options: OperationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.code !== undefined) this.code = options.code;
    if (options.name !== undefined) this.name = options.name;
    if (options.category !== undefined) this.category = options.category;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.requiredQualificationId !== undefined)
      this.requiredQualificationId = options.requiredQualificationId;
  }

  /** Operations are retired, never deleted, so history keeps resolving. */
  override async delete(): Promise<void> {
    throw new Error(
      `Operation ${this.code || this.id} cannot be deleted; retire it instead.`,
    );
  }
}
