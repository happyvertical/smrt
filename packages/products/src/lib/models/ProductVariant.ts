/**
 * ProductVariant — declarative description of one axis along which a
 * product's SKUs differ.
 *
 * A `ProductVariant` row says "for product X, axis Y has the following
 * allowed values". The actual per-SKU value lives on `Sku.attributes`
 * (also in this package — `Sku` was relocated to `@happyvertical/smrt-products`
 * in Phase 1; inventory only holds stock motion now), keyed by `axisName`.
 * This split keeps the axis catalog (form choices, UI grouping, ordering)
 * separate from the per-unit instances.
 *
 * Deliberately generic. `axisName` is free-form — apparel teams might
 * use `'size'` and `'color'`, automotive teams `'trim'` and `'engine'`,
 * CPG teams `'packSize'` and `'flavor'`. The framework never inspects
 * the axis name.
 *
 * NOT a Product STI subtype — it's its own model with its own table,
 * because the shape (axis declaration) doesn't fit the Product schema
 * (no name, no price, no category — it's metadata about a Product, not
 * a Product itself).
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
 * Options accepted by the {@link ProductVariant} constructor.
 */
export interface ProductVariantOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productId?: string;
  axisName?: string;
  label?: string;
  allowedValues?: string[] | string;
  sortOrder?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'product_variants',
  conflictColumns: ['product_id', 'axis_name', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ProductVariant extends SmrtObject {
  /** Tenant scope. `null` means the variant axis is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the {@link Product} this axis belongs to
   * (or any Product STI subtype — `Material`, or vertical subtypes
   * defined in templates such as the apparel `Style` / `Makeup`).
   */
  @field({ required: true })
  productId: string = '';

  /**
   * The name of the axis (`'size'`, `'color'`, `'finish'`, `'voltage'`,
   * `'packSize'`, …). Free-form — the framework treats this as opaque.
   */
  @field({ required: true })
  axisName: string = '';

  /** Optional human-friendly label for forms / UIs (defaults to `axisName`). */
  label: string = '';

  /**
   * Allowed values for this axis, stored as a JSON string. Named
   * `allowedValues` (rather than `values`) because the unprefixed name
   * collides with the SQL `VALUES` keyword on several engines. Use
   * {@link getValues} / {@link setValues} to round-trip the array form.
   */
  allowedValues: string = '[]';

  /** Sort order for displaying multiple axes in a consistent column order. */
  sortOrder: number = 0;

  constructor(options: ProductVariantOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.axisName !== undefined) this.axisName = options.axisName;
    if (options.label !== undefined) this.label = options.label;
    if (options.allowedValues !== undefined)
      this.setValues(options.allowedValues);
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;

    // Default the label to axisName when no explicit label was supplied.
    // The field docstring promises this behavior and admin UIs render
    // `variant.label` directly; without this fallback an axis declared
    // as `{ axisName: 'size' }` would render with a blank label.
    if (!this.label && this.axisName) {
      this.label = this.axisName;
    }
  }

  /**
   * Parse and return the {@link allowedValues} JSON array. Returns an
   * empty array if the stored value cannot be parsed as an array.
   */
  getValues(): string[] {
    if (!this.allowedValues) return [];
    try {
      const parsed = JSON.parse(this.allowedValues);
      return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
    } catch {
      return [];
    }
  }

  /**
   * Serialize the allowed values back into the stored
   * {@link allowedValues} string. Accepts either an array or a
   * pre-serialized JSON string.
   */
  setValues(value: string[] | string): void {
    if (typeof value === 'string') {
      this.allowedValues = value;
      return;
    }
    this.allowedValues = JSON.stringify(Array.isArray(value) ? value : []);
  }
}
