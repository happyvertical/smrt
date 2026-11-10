/**
 * LotDocument — a document attached to a lot (a certificate, a test
 * report, a delivery note).
 *
 * The file itself is an Asset from `@happyvertical/smrt-assets`, referenced
 * by id; this package takes no dependency on it. Detaching sets
 * `detachedAt` and writes a {@link LotCorrection}; the row stays. Write
 * only through {@link LotService}.
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
import { Lot } from './Lot.js';

/**
 * Options accepted by the {@link LotDocument} constructor.
 */
export interface LotDocumentOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  lotId?: string;
  assetId?: string;
  role?: string;
  attachedAt?: Date | string;
  attachedByProfileId?: string | null;
  detachedAt?: Date | string | null;
  detachedByProfileId?: string | null;
}

const toDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_lot_documents',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  indexes: [{ name: 'inventory_lot_documents_lot_idx', columns: ['lotId'] }],
})
export class LotDocument extends SmrtObject {
  /** Tenant scope. `null` means the document link is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The lot the document belongs to. */
  @foreignKey(Lot, {
    required: true,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
    // DuckDB cannot enforce the constraint; the id is never rewritten.
    constraint: { engines: ['postgres', 'sqlite'] },
  })
  lotId: string = '';

  /** The stored file. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  assetId: string = '';

  /** What the document is for, free text, for example `certificate`. */
  @field({ description: 'What the document is for, for example certificate.' })
  role: string = 'certificate';

  /** When the document was attached. */
  @field({ description: 'When it was attached.' })
  attachedAt: Date = new Date();

  /** Profile that attached it. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  attachedByProfileId: string | null = null;

  /** When it was detached, if it was. */
  @field({ type: 'datetime', nullable: true })
  detachedAt: Date | null = null;

  /** Profile that detached it. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  detachedByProfileId: string | null = null;

  constructor(options: LotDocumentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.lotId !== undefined) this.lotId = options.lotId;
    if (options.assetId !== undefined) this.assetId = options.assetId;
    if (options.role !== undefined) this.role = options.role;
    if (options.attachedAt !== undefined)
      this.attachedAt = toDate(options.attachedAt);
    if (options.attachedByProfileId !== undefined)
      this.attachedByProfileId = options.attachedByProfileId;
    if (options.detachedAt !== undefined)
      this.detachedAt =
        options.detachedAt === null ? null : toDate(options.detachedAt);
    if (options.detachedByProfileId !== undefined)
      this.detachedByProfileId = options.detachedByProfileId;
  }
}
