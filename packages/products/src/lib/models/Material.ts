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

import { meta, smrt } from '@happyvertical/smrt-core';
import { Product, type ProductOptions } from './Product';
import { type MaterialKind, ProductType } from './types';

export interface MaterialOptions extends ProductOptions {
  materialKind?: MaterialKind;
  uom?: string;
  costPerUnit?: number;
}

@smrt()
export class Material extends Product {
  override productType: ProductType = ProductType.MATERIAL;

  /** Classification — fabric, trim, thread, label, packaging, component, ... */
  @meta()
  materialKind: MaterialKind = 'component';

  /** Unit of measure — "yards", "meters", "each", "grams", "lbs". */
  @meta()
  uom: string = 'each';

  /**
   * Latest known cost per UOM. For sophisticated cost rollup, manufacturing
   * may pull from purchase-order history instead of this denormalised value.
   */
  @meta()
  costPerUnit: number = 0.0;

  constructor(options: MaterialOptions = {}) {
    super(options);
    if (options.materialKind !== undefined)
      this.materialKind = options.materialKind;
    if (options.uom !== undefined) this.uom = options.uom;
    if (options.costPerUnit !== undefined)
      this.costPerUnit = options.costPerUnit;
  }
}
