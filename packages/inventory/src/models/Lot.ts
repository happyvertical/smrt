/**
 * Lot — a traceable batch of material, or a single serialized unit.
 *
 * A lot is the identity that stock carries when it must be traced back to
 * where it came from (a supplier batch code, a serial number, any
 * caller-defined identifier). Stock on hand per lot lives in
 * {@link LotStockLevel}; who consumed the lot lives in {@link LotUsage};
 * every after-the-fact change is a {@link LotCorrection}.
 *
 * **Write only through {@link LotService}.** The service keeps `searchKey`
 * and `identityKey` in sync with `lotNumber`, records the correction trail,
 * and enforces exclusivity for serials. Direct `save()` calls bypass all of
 * that.
 *
 * `lotNumber` is not unique by default: one supplier lot can legitimately
 * arrive on two receipts. `identityKey` is what the database enforces, and
 * it derives from the number only for unique lots and serials (see
 * {@link LotService.receiveLot}).
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { LotKind } from '../types.js';

/**
 * Options accepted by the {@link Lot} constructor.
 */
export interface LotOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  skuId?: string | null;
  kind?: LotKind;
  lotNumber?: string;
  searchKey?: string;
  identityKey?: string;
  uniqueNumber?: boolean;
  receivedQty?: number;
  unit?: string;
  sourceType?: string;
  sourceId?: string;
  attributes?: Record<string, unknown> | string;
  status?: string;
  receivedAt?: Date | string;
  receivedByProfileId?: string | null;
  lastUsedAt?: Date | string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_lots',
  // The database-enforced identity. Every create is insert-only, so a
  // duplicate identityKey fails instead of silently overwriting the lot.
  conflictColumns: ['identity_key', 'tenant_id'],
  // Writes go through LotService only (number sync, correction trail).
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  indexes: [
    {
      name: 'inventory_lots_search_key_idx',
      columns: ['tenantId', 'searchKey'],
    },
  ],
})
export class Lot extends SmrtObject {
  /** Tenant scope. `null` means the lot is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the catalog Sku. Null when the lot covers
   * uncatalogued material.
   */
  @field({
    nullable: true,
    description: 'The item this lot is of, if catalogued.',
  })
  skuId: string | null = null;

  /** `lot` for a quantity of material, `serial` for one unit. */
  @field({
    description: 'Whether this is a batch (lot) or a single unit (serial).',
  })
  kind: LotKind = 'lot';

  /** The identifier as the caller wrote it: batch code, supplier lot, serial number. */
  @field({
    required: true,
    maxLength: 128,
    description: 'The batch code, supplier lot or serial number.',
  })
  lotNumber: string = '';

  /** `lotNumber` trimmed and upper-cased, for case-insensitive lookup. Service-maintained. */
  @field({
    maxLength: 160,
    description: 'The number in normal form, used for lookup.',
  })
  searchKey: string = '';

  /** What the database keeps unique. Service-maintained; never write it directly. */
  @field({
    required: true,
    maxLength: 160,
    description: 'Internal identity that keeps lots from being created twice.',
  })
  identityKey: string = '';

  /** Whether `identityKey` derives from the number (true for serials). */
  @field({ description: 'Whether the number must be unique for this item.' })
  uniqueNumber: boolean = false;

  /** Quantity on the receipt that created the lot (1 for a serial). */
  @field({ type: 'decimal', description: 'How many came in on the receipt.' })
  receivedQty: number = 0.0;

  /** Unit of measure for `receivedQty`, free text. */
  @field({ description: 'The unit of measure.' })
  unit: string = '';

  /** Receipt attribution, same convention as {@link StockMovement.sourceType}. */
  @field({ description: 'What kind of record received this lot.' })
  sourceType: string = '';

  /** Id of the record that received this lot. */
  @field({ description: 'The record that received this lot.' })
  sourceId: string = '';

  /** Free-form properties as a JSON string; see {@link getAttributes}. */
  @field({
    type: 'text',
    description: 'Anything else worth knowing about this lot, stored as JSON.',
  })
  attributes: string = '{}';

  /**
   * Open string. Documented values: `active`, `quarantined`, `consumed`,
   * `void`.
   */
  @field({
    description: 'Where the lot stands: active, quarantined, consumed or void.',
  })
  status: string = 'active';

  /** When the lot arrived. */
  @field({ description: 'When the lot was received.' })
  receivedAt: Date = new Date();

  /** Profile that received the lot. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  receivedByProfileId: string | null = null;

  /**
   * Touched by {@link LotService.recordUsage} and `unlinkUsage` so that
   * concurrent changes to a lot's usage conflict on its revision.
   */
  @field({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null = null;

  constructor(options: LotOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.lotNumber !== undefined) this.lotNumber = options.lotNumber;
    if (options.searchKey !== undefined) this.searchKey = options.searchKey;
    if (options.identityKey !== undefined)
      this.identityKey = options.identityKey;
    if (options.uniqueNumber !== undefined)
      this.uniqueNumber = options.uniqueNumber;
    if (options.receivedQty !== undefined)
      this.receivedQty = options.receivedQty;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.attributes !== undefined)
      this.setAttributes(options.attributes);
    if (options.status !== undefined) this.status = options.status;
    if (options.receivedAt !== undefined) {
      this.receivedAt =
        options.receivedAt instanceof Date
          ? options.receivedAt
          : new Date(options.receivedAt);
    }
    if (options.receivedByProfileId !== undefined)
      this.receivedByProfileId = options.receivedByProfileId;
    if (options.lastUsedAt !== undefined) {
      this.lastUsedAt =
        options.lastUsedAt === null || options.lastUsedAt instanceof Date
          ? options.lastUsedAt
          : new Date(options.lastUsedAt);
    }
  }

  /**
   * Parse {@link attributes}. Returns an empty object for invalid JSON so
   * callers need no try/catch.
   */
  getAttributes(): Record<string, unknown> {
    if (!this.attributes) return {};
    try {
      const parsed = JSON.parse(this.attributes);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Store attributes from an object or an already-serialized JSON string. */
  setAttributes(value: Record<string, unknown> | string): void {
    this.attributes =
      typeof value === 'string' ? value : JSON.stringify(value ?? {});
  }
}
