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
// SECURITY (S5 #1406): @smrt() generation config is ALSO registered per
// concrete class and is NOT inherited from the STI parent. An empty
// `@smrt()` here would resolve `getConfig('Material').api/.mcp` to
// `undefined`, which the REST + MCP generators treat as "expose
// EVERYTHING" — including `delete`, `create`, and `update` MCP tools —
// even though the `Product` base deliberately restricts itself to CRUD
// (no delete) over REST and read-only (`list`/`get`) over MCP. The
// products `mcp.ts` generator enumerates the whole registry, so a
// silently-wide-open Material surface ships the moment the package's own
// server is generated. Re-declare the parent's restricted posture so the
// STI child matches its base — and so consumers copying this canonical
// subtype example (apparel `Style`/`Makeup`, automotive `Model`/`Trim`,
// …) inherit the secure pattern instead of an accidental open surface.
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // no delete, matches Product
  },
  mcp: {
    include: ['list', 'get'], // read-only AI tools, matches Product
  },
  cli: true,
})
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
