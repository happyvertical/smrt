/**
 * Variant — declarative description of one axis along which SKUs differ.
 *
 * A `Variant` row says "for product X, axis Y has the following allowed
 * values". The actual per-SKU value lives on {@link Sku.attributes}, keyed
 * by `axisName`. This split keeps the axis catalog (form choices, UI
 * grouping, ordering) separate from the per-unit instances.
 *
 * Variant is deliberately generic. `axisName` is free-form — apparel
 * teams might use `'size'` and `'color'`, automotive teams `'trim'` and
 * `'engine'`, CPG teams `'packSize'` and `'flavor'`. The framework never
 * inspects the axis name.
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
 * Options accepted by the {@link Variant} constructor.
 */
export interface VariantOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productId?: string;
  axisName?: string;
  label?: string;
  allowedValues?: string[] | string;
  sortOrder?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_variants',
  conflictColumns: ['product_id', 'axis_name', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Variant extends SmrtObject {
  /** Tenant scope. `null` means the variant axis is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the product this axis belongs to (typically
   * a `Product.id` or `ProductVariant.id` from `@happyvertical/smrt-products`).
   * Cross-package id; intentionally not a `@foreignKey()`.
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

  constructor(options: VariantOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.axisName !== undefined) this.axisName = options.axisName;
    if (options.label !== undefined) this.label = options.label;
    if (options.allowedValues !== undefined)
      this.setValues(options.allowedValues);
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }

  /**
   * Parse and return the {@link allowedValues} JSON array. Returns an empty
   * array if the stored value cannot be parsed as an array.
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
