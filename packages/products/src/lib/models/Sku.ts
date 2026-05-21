/**
 * Sku — smallest sellable and countable unit.
 *
 * A SKU is the concrete catalog row that downstream inventory counts.
 * It references a higher-level concept in this same package (a
 * {@link Product} or any of its STI subtypes) via the plain string
 * `productId` field. The same pattern serves apparel (one SKU per
 * size/color), furniture (one SKU per finish), automotive parts,
 * grocery (one SKU per pack size), or any other vertical that needs
 * to count discrete units.
 *
 * Axis values such as `{ size: 'M', color: 'navy' }`, `{ finish: 'walnut' }`,
 * or `{ packSize: '12oz' }` are stored as opaque JSON in `attributes`;
 * the declarative axis catalog lives in {@link ProductVariant} in this
 * same package.
 *
 * Stock balance and movement history for a SKU live in
 * `@happyvertical/smrt-inventory` as `StockLevel` and `StockMovement`.
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
 * Options accepted by the {@link Sku} constructor.
 */
export interface SkuOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productId?: string;
  code?: string;
  barcode?: string;
  name?: string;
  attributes?: Record<string, unknown> | string;
  weightGrams?: number;
  parentSkuId?: string;
  active?: boolean;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'product_skus',
  conflictColumns: ['code', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Sku extends SmrtObject {
  /** Tenant scope. `null` means the SKU is a global record. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to a row in this package — typically a
   * `Product` id (or any of its STI subtypes, such as `Material`
   * upstream or `Style` / `Makeup` in the apparel template).
   */
  productId: string = '';

  /**
   * Stable, human-meaningful identifier such as a UPC, internal SKU
   * code, or part number. Together with `tenantId` this is the natural
   * key (`conflictColumns: ['code', 'tenant_id']`), so re-saving an
   * identical row is an upsert rather than a UNIQUE violation.
   */
  @field({ required: true })
  code: string = '';

  /** Optional scannable barcode (EAN/UPC/Code-128/etc.). */
  barcode: string = '';

  /** Display name for UIs. Optional — `code` is enough for machines. */
  name: string = '';

  /**
   * Axis values for this SKU expressed as JSON, e.g. `{ size: 'M' }`,
   * `{ finish: 'walnut' }`, or `{ voltage: '230V' }`.
   *
   * The persisted column type is text; use {@link getAttributes} and
   * {@link setAttributes} to round-trip parsed values without worrying
   * about parse errors.
   */
  attributes: string = '{}';

  /** Optional physical weight in grams for shipping / cost calculations. */
  @field({ type: 'decimal' })
  weightGrams: number = 0.0;

  /**
   * Optional self-reference for bundles / kits — set to the id of the
   * "parent" SKU that this SKU is a component of.
   */
  parentSkuId: string = '';

  /**
   * Soft-active flag. Inactive SKUs stay queryable for history but
   * should not be offered for sale or production planning.
   */
  active: boolean = true;

  constructor(options: SkuOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.code !== undefined) this.code = options.code;
    if (options.barcode !== undefined) this.barcode = options.barcode;
    if (options.name !== undefined) this.name = options.name;
    if (options.attributes !== undefined)
      this.setAttributes(options.attributes);
    if (options.weightGrams !== undefined)
      this.weightGrams = options.weightGrams;
    if (options.parentSkuId !== undefined)
      this.parentSkuId = options.parentSkuId;
    if (options.active !== undefined) this.active = options.active;
  }

  /**
   * Parse and return the {@link attributes} JSON. Returns an empty
   * object if the stored value is invalid JSON so callers don't have
   * to wrap every read in a try/catch.
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

  /**
   * Serialize axis values back into the stored {@link attributes}
   * string. Accepts either an object (will be `JSON.stringify`'d) or a
   * raw JSON string that the caller has already serialized.
   */
  setAttributes(value: Record<string, unknown> | string): void {
    if (typeof value === 'string') {
      this.attributes = value;
      return;
    }
    this.attributes = JSON.stringify(value ?? {});
  }
}
