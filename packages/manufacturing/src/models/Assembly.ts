/**
 * Assembly — the product that is made, the counterpart to `Material` (the
 * product that is consumed).
 *
 * A single-table-inheritance subtype of `@happyvertical/smrt-products`
 * `Product`: assembly rows live in the shared `products` table with
 * `productType: 'assembly'` and `_meta_type:
 * '@happyvertical/smrt-manufacturing:Assembly'`. Its own fields are
 * ordinary columns that this package adds to that table.
 *
 * Everything else comes from a neighbour and is deliberately not repeated
 * here:
 *
 * - name, description, price, category and tags from `Product`;
 * - part number, barcode and stock from its `Sku` (`smrt-products`) and the
 *   stock levels in `smrt-inventory`;
 * - what it is made of from its {@link BillOfMaterials} and {@link BomLine}s;
 * - specs, plans and drawings from `ProductAsset` links.
 *
 * **Nesting lives in the bill, not on the assembly.** A sub-assembly is a
 * bill line whose component SKU belongs to another `Assembly`; there is no
 * children list to keep in sync. Use {@link AssemblyService.resolveComponent}
 * to tell a sub-assembly from a material or a bought item.
 *
 * @packageDocumentation
 */

import { field, smrt } from '@happyvertical/smrt-core';
import {
  Product,
  type ProductOptions,
  ProductType,
} from '@happyvertical/smrt-products/models';
import { TenantScoped } from '@happyvertical/smrt-tenancy';

/**
 * Options accepted by the {@link Assembly} constructor.
 */
export interface AssemblyOptions extends ProductOptions {
  estimatedLabourMinutes?: number;
  defaultOperationId?: string;
  partReference?: string;
}

// `@TenantScoped` and the generation config are registered per concrete
// class and are not inherited from the STI parent (see `Material`): repeat
// both so assembly reads are tenant-filtered and the REST/MCP surface
// matches `Product` (CRUD without delete over REST, read-only over MCP)
// instead of falling open.
@TenantScoped({ mode: 'optional' })
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // no delete, matches Product
  },
  mcp: {
    include: ['list', 'get'], // read-only AI tools, matches Product
  },
  cli: { skipApiCheck: true },
})
export class Assembly extends Product {
  override productType: ProductType = ProductType.ASSEMBLY;

  /**
   * Labour to build one unit, in whole minutes. A planning estimate until
   * routing steps (smrt#3445) provide labour per operation; `0` means not
   * estimated.
   */
  @field()
  estimatedLabourMinutes: number = 0;

  /**
   * The operation that work on this assembly is booked to by default.
   * Optional plain string id: the operation model is defined by smrt#3445,
   * so this is not a foreign key.
   */
  @field()
  defaultOperationId: string = '';

  /**
   * The organization's own drawing or part number for this assembly,
   * alongside (not instead of) the SKU code.
   */
  @field()
  partReference: string = '';

  constructor(options: AssemblyOptions = {}) {
    super(options);
    if (options.estimatedLabourMinutes !== undefined)
      this.estimatedLabourMinutes = options.estimatedLabourMinutes;
    if (options.defaultOperationId !== undefined)
      this.defaultOperationId = options.defaultOperationId;
    if (options.partReference !== undefined)
      this.partReference = options.partReference;
  }
}
