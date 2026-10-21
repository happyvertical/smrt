/**
 * LotCorrection — append-only record of an after-the-fact change to a lot.
 *
 * Fixing a mistyped lot number, editing an attribute, changing status,
 * unlinking a usage or detaching a document each write exactly one
 * correction with the old value, the new value, who did it and why. The
 * reason is mandatory. Like {@link StockMovement}, rows are never updated
 * or deleted. Write only through {@link LotService}.
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { LotCorrectionKind } from '../types.js';
import { Lot } from './Lot.js';

/**
 * Options accepted by the {@link LotCorrection} constructor.
 */
export interface LotCorrectionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  lotId?: string;
  kind?: LotCorrectionKind;
  field?: string;
  oldValue?: string;
  newValue?: string;
  reason?: string;
  usageId?: string | null;
  documentId?: string | null;
  actorProfileId?: string | null;
  correctedAt?: Date | string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_lot_corrections',
  // Append-only: the surrogate id is the only key, as for StockMovement.
  conflictColumns: ['id'],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class LotCorrection extends SmrtObject {
  /** Tenant scope. `null` means the correction is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The lot that was corrected. */
  @foreignKey(Lot, { required: true, onDelete: 'RESTRICT' })
  lotId: string = '';

  /** What was corrected. */
  @field({ required: true, description: 'What was corrected.' })
  kind: LotCorrectionKind = 'attribute';

  /** The attribute key for `attribute` corrections; empty otherwise. */
  @field({ description: 'Which attribute changed, if one did.' })
  field: string = '';

  /** The value before the correction. */
  @field({ type: 'text', description: 'What it was.' })
  oldValue: string = '';

  /** The value after the correction. */
  @field({ type: 'text', description: 'What it is now.' })
  newValue: string = '';

  /** Why the correction was made. Required, at most 1000 characters. */
  @field({
    type: 'text',
    required: true,
    maxLength: 1000,
    description: 'Why it was corrected.',
  })
  reason: string = '';

  /** The {@link LotUsage} unlinked, for `unlink` corrections. */
  @field({ nullable: true })
  usageId: string | null = null;

  /** The {@link LotDocument} detached, for `document_detach` corrections. */
  @field({ nullable: true })
  documentId: string | null = null;

  /** Profile that made the correction. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  actorProfileId: string | null = null;

  /** When the correction was made. */
  @field({ description: 'When it was corrected.' })
  correctedAt: Date = new Date();

  constructor(options: LotCorrectionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.lotId !== undefined) this.lotId = options.lotId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.field !== undefined) this.field = options.field;
    if (options.oldValue !== undefined) this.oldValue = options.oldValue;
    if (options.newValue !== undefined) this.newValue = options.newValue;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.usageId !== undefined) this.usageId = options.usageId;
    if (options.documentId !== undefined) this.documentId = options.documentId;
    if (options.actorProfileId !== undefined)
      this.actorProfileId = options.actorProfileId;
    if (options.correctedAt !== undefined) {
      this.correctedAt =
        options.correctedAt instanceof Date
          ? options.correctedAt
          : new Date(options.correctedAt);
    }
  }
}
