/**
 * BomLine — one component on a {@link BillOfMaterials}.
 *
 * Each line declares the component SKU required to produce one unit of the
 * parent product, the quantity-per-unit, the unit of measure (open-ended
 * string — `yards`, `each`, `grams`, `kg`, `m`, anything else the
 * application needs), and an optional `wastePercent` so cost rollups and
 * requirements explosions can account for offcuts, setup losses, and other
 * material consumed but not incorporated into a finished unit.
 *
 * Cross-package references (`componentSkuId`) are plain string ids — never
 * `@foreignKey()` — so this package can ship without a hard runtime
 * dependency on `@happyvertical/smrt-products` (the `Sku` model lives
 * there) or `@happyvertical/smrt-inventory` (which holds the stock
 * levels / movements addressed by the id) even though all three almost
 * always travel together.
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
 * Options accepted by the {@link BomLine} constructor.
 */
export interface BomLineOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  bomId?: string;
  componentSkuId?: string;
  qtyPerUnit?: number;
  uom?: string;
  wastePercent?: number;
  notes?: string;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'manufacturing_bom_lines',
  // Natural key: one row per `(bom, component)` per tenant. Re-saving the
  // same combination updates the row in place rather than violating the
  // UNIQUE constraint. Callers that want to declare two distinct lines for
  // the same component (e.g. "main" vs "trim" passes) should use distinct
  // component SKUs or model the variants in inventory.
  conflictColumns: ['bom_id', 'component_sku_id', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class BomLine extends SmrtObject {
  /** Tenant scope. `null` means the line is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the parent {@link BillOfMaterials}. Within
   * this package this is the only "structural" foreign key — but it is
   * still stored as a plain string to keep with the package's
   * cross-reference convention and to avoid coupling the schema generator
   * to a particular load order.
   */
  @field({ required: true })
  bomId: string = '';

  /**
   * Plain string reference to the component SKU id (raw material, trim,
   * sub-assembly). The `Sku` model itself lives in
   * `@happyvertical/smrt-products`; `@happyvertical/smrt-inventory` uses
   * this id to track stock levels and movements. Cross-package id;
   * never `@foreignKey()`.
   */
  @field({ required: true })
  componentSkuId: string = '';

  /**
   * Quantity of the component required per unit of finished product, in
   * the unit declared by {@link uom}. Decimal so fractional usage like
   * `1.75 yards` or `12.5 grams` round-trips correctly.
   */
  @field({ type: 'decimal' })
  qtyPerUnit: number = 0.0;

  /**
   * Unit of measure for {@link qtyPerUnit}. Open-ended string so the
   * framework does not constrain the vocabulary — `'yards'`, `'each'`,
   * `'grams'`, `'kg'`, `'m'`, `'litres'`, `'sq_ft'`, anything.
   *
   * Conventions follow the upstream `Material.uom` value when applicable.
   */
  uom: string = 'each';

  /**
   * Expected percentage waste on this line. Adds to the effective quantity
   * consumed during cost rollups and requirements explosions so a cutting
   * yield of 10% surfaces in the total cost without callers having to
   * pre-inflate `qtyPerUnit`. Stored as a percent (`10` means 10%), not a
   * fraction (`0.10`).
   */
  @field({ type: 'decimal' })
  wastePercent: number = 0.0;

  /**
   * Optional free-form notes — e.g. "primary structural component",
   * "60-second cure", or "matched batch only".
   */
  notes: string = '';

  constructor(options: BomLineOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.bomId !== undefined) this.bomId = options.bomId;
    if (options.componentSkuId !== undefined)
      this.componentSkuId = options.componentSkuId;
    if (options.qtyPerUnit !== undefined) this.qtyPerUnit = options.qtyPerUnit;
    if (options.uom !== undefined) this.uom = options.uom;
    if (options.wastePercent !== undefined)
      this.wastePercent = options.wastePercent;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Effective quantity consumed per produced unit, including waste. Used
   * by {@link BomService} for cost rollups and requirements explosions.
   *
   * `effectiveQty = qtyPerUnit * (1 + wastePercent / 100)`
   */
  effectiveQtyPerUnit(): number {
    const qty = Number(this.qtyPerUnit ?? 0);
    const waste = Number(this.wastePercent ?? 0);
    return qty * (1 + waste / 100);
  }
}
