/**
 * Material — STI subtype of Product representing a raw input consumed by
 * manufacturing: fabric, thread, trim, labels, packaging, components.
 *
 * Materials are first-class products in the catalog (the SAP/NetSuite pattern):
 * they have a name, description, vendor, unit cost, and live in inventory just
 * like finished goods. Bills of materials in `@happyvertical/smrt-manufacturing`
 * reference Materials by id.
 *
 * @packageDocumentation
 */

import { type Meta, smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import { Product, type ProductOptions } from './Product';
import { type MaterialKind, ProductType } from './types';

export interface MaterialOptions extends ProductOptions {
  materialKind?: MaterialKind;
  uom?: string;
  costPerUnit?: number;
}

// @TenantScoped is registered per concrete class, so inheriting from
// Product is NOT enough — `MaterialCollection.list()` passes 'Material'
// (not 'Product') to the interceptor, which then fails its
// `isTenantScopedClass(className)` lookup and skips tenant auto-filter
// + auto-populate. Repeat the decorator here so material rows
// participate in the same tenant isolation as their Product parent.
@TenantScoped({ mode: 'optional' })
@smrt()
export class Material extends Product {
  override productType: ProductType = ProductType.MATERIAL;

  // STI child-specific fields use the `Meta<T>` type wrapper rather than
  // the runtime `@meta()` decorator. The scanner detects the wrapper at
  // build time (via the type annotation) and emits the field with
  // `type: 'meta'` in the manifest, which routes it through `_meta_data`
  // JSON storage at schema-generation time. The runtime decorator path
  // doesn't reach the manifest, so STI children that only use `@meta()`
  // get materialized as ordinary columns on the parent's table.

  /** Classification — fabric, trim, thread, label, packaging, component, ... */
  materialKind: Meta<MaterialKind> = 'component';

  /** Unit of measure — "yards", "meters", "each", "grams", "lbs". */
  uom: Meta<string> = 'each';

  /**
   * Latest known cost per UOM. For sophisticated cost rollup, manufacturing
   * may pull from purchase-order history instead of this denormalised value.
   */
  costPerUnit: Meta<number> = 0.0;

  constructor(options: MaterialOptions = {}) {
    super(options);
    if (options.materialKind !== undefined)
      this.materialKind = options.materialKind;
    if (options.uom !== undefined) this.uom = options.uom;
    if (options.costPerUnit !== undefined)
      this.costPerUnit = options.costPerUnit;
  }
}
