/**
 * BillOfMaterials — recipe describing how to produce a finished product.
 *
 * A BOM enumerates the component SKUs (raw materials, trims, sub-assemblies)
 * that must be consumed to produce one unit of a given parent product. The
 * same product may have many BOMs — alternate revisions, alternate recipes,
 * region-specific variations — distinguished by `version` and lifecycle
 * `status`.
 *
 * Strictly industry-neutral: the same model serves apparel, furniture,
 * automotive, CPG, electronics, food production, custom hardware, and any
 * other vertical that builds finished goods from components.
 *
 * Cross-package references (`productId`) are plain string ids — never
 * `@foreignKey()` — so this package can be consumed without pulling in the
 * upstream catalog package.
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
import type { BomStatus } from '../types.js';

/**
 * Options accepted by the {@link BillOfMaterials} constructor.
 */
export interface BillOfMaterialsOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productId?: string;
  version?: number;
  effectiveDate?: Date | string | null;
  status?: BomStatus;
  notes?: string;
  currency?: string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_boms',
  // Natural key: one BOM per (product, version) per tenant. Re-saving the
  // same combination is an upsert rather than a UNIQUE violation.
  conflictColumns: ['product_id', 'version', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class BillOfMaterials extends SmrtObject {
  /** Tenant scope. `null` means the BOM is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the upstream product this BOM produces.
   * Typically a `Product.id` (or any STI subtype thereof) from
   * `@happyvertical/smrt-products`. Cross-package id, intentionally not
   * a `@foreignKey()`, so this package does not pull in `smrt-products`.
   */
  @field({ required: true })
  productId: string = '';

  /**
   * Monotonically increasing revision number scoped per `productId`. Together
   * with `tenantId` and `productId` this forms the natural key — so
   * `version` is an integer and `0` is reserved by convention for unsaved
   * scratch rows.
   */
  @field({ required: true })
  version: number = 1;

  /**
   * Date from which this BOM is intended to take effect for new production
   * runs. Optional — older BOMs imported from legacy systems may have no
   * effective date on file.
   */
  effectiveDate: Date | null = null;

  /**
   * Lifecycle state — `draft`, `active`, or `superseded`. See
   * {@link BomStatus} for the semantics.
   *
   * Most queries that pick "the BOM to use right now" should filter for
   * `status: 'active'`.
   */
  @field({ required: true })
  status: BomStatus = 'draft';

  /**
   * Optional free-form notes shown in admin UIs (revision reason, source
   * document reference, sign-off chain, etc.).
   */
  notes: string = '';

  /**
   * ISO 4217 currency code for cost rollups. Mostly a hint for the rollup
   * service — defaults to `'USD'` so older imports without a currency
   * still produce sensible numbers.
   */
  currency: string = 'USD';

  constructor(options: BillOfMaterialsOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.version !== undefined) this.version = options.version;
    if (options.effectiveDate !== undefined) {
      this.effectiveDate =
        options.effectiveDate === null
          ? null
          : options.effectiveDate instanceof Date
            ? options.effectiveDate
            : new Date(options.effectiveDate);
    }
    if (options.status !== undefined) this.status = options.status;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.currency !== undefined) this.currency = options.currency;
  }
}
