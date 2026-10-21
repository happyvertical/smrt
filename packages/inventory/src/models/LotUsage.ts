/**
 * LotUsage — one edge of the trace graph: a lot used by a consumer.
 *
 * The consumer is cross-package attribution (`consumerType` +
 * `consumerId`, for example `'ProductionOrder'` and its id). When the
 * consumer is itself another lot (an assembly), use `consumerType: 'Lot'`
 * so forward and backward traces can walk the lineage.
 *
 * Rows are never deleted. Correcting a mistaken link flips `status` to
 * `unlinked` and writes a {@link LotCorrection}; the original edge stays
 * on record. Write only through {@link LotService}.
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
import type { LotUsageStatus } from '../types.js';
import { Lot } from './Lot.js';

/**
 * Options accepted by the {@link LotUsage} constructor.
 */
export interface LotUsageOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  lotId?: string;
  consumerType?: string;
  consumerId?: string;
  qty?: number | null;
  unit?: string;
  status?: LotUsageStatus;
  linkedAt?: Date | string;
  linkedByProfileId?: string | null;
  unlinkedAt?: Date | string | null;
  unlinkedByProfileId?: string | null;
  unlinkReason?: string;
  movementId?: string | null;
}

const toDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_lot_usages',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  indexes: [
    {
      name: 'inventory_lot_usages_consumer_idx',
      columns: ['consumerType', 'consumerId'],
    },
  ],
})
export class LotUsage extends SmrtObject {
  /** Tenant scope. `null` means the usage is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The lot that was used. */
  @foreignKey(Lot, { required: true, onDelete: 'RESTRICT' })
  lotId: string = '';

  /** Kind of consumer, for example `'ProductionOrder'`; `'Lot'` for an assembly. */
  @field({ required: true, description: 'What kind of record used the lot.' })
  consumerType: string = '';

  /** Id of the consumer. */
  @field({ required: true, description: 'The record that used the lot.' })
  consumerId: string = '';

  /** Quantity used; null means unspecified (the whole lot, or not tracked). */
  @field({ type: 'decimal', nullable: true, description: 'How much was used.' })
  qty: number | null = null;

  /** Unit of measure for `qty`. */
  @field({ description: 'The unit of measure.' })
  unit: string = '';

  /** `active`, or `unlinked` once a correction removed the link. */
  @field({ description: 'Whether the link still stands: active or unlinked.' })
  status: LotUsageStatus = 'active';

  /** When the usage was recorded. */
  @field({ description: 'When the lot was linked.' })
  linkedAt: Date = new Date();

  /** Profile that recorded the usage. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  linkedByProfileId: string | null = null;

  /** When the link was removed, if it was. */
  @field({ type: 'datetime', nullable: true })
  unlinkedAt: Date | null = null;

  /** Profile that removed the link. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  unlinkedByProfileId: string | null = null;

  /** Why the link was removed. */
  @field({ type: 'text', description: 'Why the link was removed.' })
  unlinkReason: string = '';

  /** Optional StockMovement that took this quantity out. */
  @field({
    nullable: true,
    description: 'The stock movement for this use, if any.',
  })
  movementId: string | null = null;

  constructor(options: LotUsageOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.lotId !== undefined) this.lotId = options.lotId;
    if (options.consumerType !== undefined)
      this.consumerType = options.consumerType;
    if (options.consumerId !== undefined) this.consumerId = options.consumerId;
    if (options.qty !== undefined) this.qty = options.qty;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.status !== undefined) this.status = options.status;
    if (options.linkedAt !== undefined)
      this.linkedAt = toDate(options.linkedAt);
    if (options.linkedByProfileId !== undefined)
      this.linkedByProfileId = options.linkedByProfileId;
    if (options.unlinkedAt !== undefined)
      this.unlinkedAt =
        options.unlinkedAt === null ? null : toDate(options.unlinkedAt);
    if (options.unlinkedByProfileId !== undefined)
      this.unlinkedByProfileId = options.unlinkedByProfileId;
    if (options.unlinkReason !== undefined)
      this.unlinkReason = options.unlinkReason;
    if (options.movementId !== undefined) this.movementId = options.movementId;
  }
}
