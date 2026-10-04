/**
 * AssemblyService — the link between a bill line and the thing it names.
 *
 * A {@link BomLine} points at a component SKU. That SKU belongs to a
 * `Product` row in `@happyvertical/smrt-products`, and the row's subtype
 * decides what the line means:
 *
 * | Component SKU belongs to | Kind | Meaning |
 * |---|---|---|
 * | an {@link Assembly} | `assembly` | a sub-assembly; it is built from its own active bill, if it has one |
 * | a `Material` | `material` | a consumed input; the leaf of the structure |
 * | any other `Product` | `bought` | an item that is bought, not built here |
 * | nothing (unknown SKU or product) | `missing` | the line points at a record that does not exist |
 *
 * {@link AssemblyService.resolveComponent} answers that question for one
 * SKU, and also returns the assembly's active bill. It is the step a
 * multi-level explosion repeats: resolve each line's component, recurse into
 * every `assembly` that has an `activeBom`, stop at everything else.
 *
 * The service also owns the **cycle refusal**: an assembly may not contain
 * itself, directly or through sub-assemblies. {@link BomLine} and
 * {@link BillOfMaterials} call {@link AssemblyService.assertLineAcyclic} and
 * {@link AssemblyService.assertBillAcyclic} before every save, so the
 * generated REST routes refuse a cycle too.
 *
 * @packageDocumentation
 */

import { type DatabaseConfig, ValidationError } from '@happyvertical/smrt-core';
import {
  ProductCollection,
  SkuCollection,
} from '@happyvertical/smrt-products/collections';
import {
  Material,
  type Product,
  type Sku,
} from '@happyvertical/smrt-products/models';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { BomLineCollection } from '../collections/BomLineCollection.js';
import { Assembly } from '../models/Assembly.js';
import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import { BomNotFoundError } from '../types.js';

/**
 * What a component SKU is, as far as building goes. See the table in the
 * {@link AssemblyService} module documentation.
 */
export type ComponentKind = 'assembly' | 'material' | 'bought' | 'missing';

/**
 * The answer to "what is this component SKU?" returned by
 * {@link AssemblyService.resolveComponent}.
 */
export interface ResolvedComponent {
  /** The component SKU id that was resolved. */
  skuId: string;
  /** What the SKU is; see {@link ComponentKind}. */
  kind: ComponentKind;
  /** The SKU row, or `null` when no SKU has this id. */
  sku: Sku | null;
  /**
   * The product the SKU belongs to (an `Assembly`, a `Material` or a plain
   * `Product`), or `null` when the SKU or its product does not exist.
   */
  product: Product | null;
  /** The assembly, when {@link kind} is `assembly`; otherwise `null`. */
  assembly: Assembly | null;
  /**
   * The assembly's active bill (the highest active version), or `null` for
   * an assembly that has no active bill yet and for every other kind.
   */
  activeBom: BillOfMaterials | null;
  /**
   * `true` only for an assembly with an active bill: the component *can* be
   * built here. Whether a shortage is built or bought is the application's
   * decision; this only reports the fact.
   */
  buildable: boolean;
}

/** One bill line together with the component it resolves to. */
export interface BillStructureLine {
  /** The bill line as stored. */
  line: BomLine;
  /** The line's component SKU, resolved. */
  component: ResolvedComponent;
}

/**
 * One level of an assembly's structure, returned by
 * {@link AssemblyService.getBillStructure}. Sub-assembly lines carry their
 * own `activeBom`; pass its id back to `getBillStructure` to open the next
 * level.
 */
export interface BillStructure {
  /** The bill that was read. */
  bom: BillOfMaterials;
  /** Its lines in component-SKU order, each resolved. */
  lines: BillStructureLine[];
}

/** One product on a cycle path reported by {@link BomCycleError}. */
export interface BomCyclePathEntry {
  /** The product id (an assembly, or the bill's own product). */
  productId: string;
  /** The product's name, or its id when it has no name or cannot be read. */
  name: string;
}

/**
 * Thrown when saving a bill line, or saving a bill as active, would make a
 * product contain itself. `path` starts and ends with the bill's product,
 * listing each assembly in between: `Frame → Side panel → Frame`.
 */
export class BomCycleError extends ValidationError {
  override name = 'BomCycleError';

  constructor(
    /** The bill being saved (or the bill of the line being saved). */
    public readonly bomId: string,
    /** The cycle, from the bill's product back to itself. */
    public readonly path: BomCyclePathEntry[],
  ) {
    const first = path[0]?.name ?? '';
    super(
      `Refused: "${first}" would contain itself: ${path
        .map((entry) => entry.name)
        .join(' → ')}`,
      'MANUFACTURING_BOM_CYCLE',
      { bomId, path },
    );
  }
}

/** Options accepted by {@link AssemblyService.create}. */
export interface AssemblyServiceOptions {
  /** Database config or live handle shared by every collection. */
  db: DatabaseConfig;
}

// Ids are UUIDs on every adapter. A value that is not one cannot name a row,
// and passing it to a UUID column on PostgreSQL is a cast error, so it is
// resolved as `missing` without a query.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Resolves components and refuses cycles. Construct with
 * {@link AssemblyService.create} or {@link createAssemblyService}.
 *
 * @example
 * ```typescript
 * const assemblies = await AssemblyService.create({ db });
 * const component = await assemblies.resolveComponent(line.componentSkuId);
 * if (component.kind === 'assembly' && component.activeBom) {
 *   // a sub-assembly that can be built: walk component.activeBom next
 * }
 * ```
 */
export class AssemblyService {
  private constructor(
    /** Every `Product` row, any subtype. */
    public readonly products: ProductCollection,
    /** The SKU catalog. */
    public readonly skus: SkuCollection,
    /** Bills of materials. */
    public readonly boms: BillOfMaterialsCollection,
    /** Bill lines. */
    public readonly lines: BomLineCollection,
  ) {}

  /** Factory — prefer {@link createAssemblyService}. */
  static async create(
    options: AssemblyServiceOptions,
  ): Promise<AssemblyService> {
    const [products, skus, boms, lines] = await Promise.all([
      ProductCollection.create({ db: options.db }),
      SkuCollection.create({ db: options.db }),
      BillOfMaterialsCollection.create({ db: options.db }),
      BomLineCollection.create({ db: options.db }),
    ]);
    return new AssemblyService(products, skus, boms, lines);
  }

  /**
   * Resolve a component SKU to what it is: an assembly (with its active bill,
   * or `null` when it has none), a material, a bought item, or missing. Never
   * throws for an unknown id; it reports `missing` instead.
   *
   * This is the documented link a multi-level explosion walks: recurse into
   * `activeBom` while `kind === 'assembly'`, stop at every other kind.
   */
  async resolveComponent(skuId: string): Promise<ResolvedComponent> {
    const missing = (sku: Sku | null): ResolvedComponent => ({
      skuId,
      kind: 'missing',
      sku,
      product: null,
      assembly: null,
      activeBom: null,
      buildable: false,
    });

    if (!isUuid(skuId)) return missing(null);
    const sku = await this.skus.get({ id: skuId });
    if (!sku) return missing(null);
    if (!isUuid(sku.productId)) return missing(sku);
    const product = await this.products.get({ id: sku.productId });
    if (!product) return missing(sku);

    if (product instanceof Assembly) {
      const activeBom = await this.boms.findActiveForProduct(product.id!);
      return {
        skuId,
        kind: 'assembly',
        sku,
        product,
        assembly: product,
        activeBom,
        buildable: activeBom !== null,
      };
    }

    return {
      skuId,
      kind: product instanceof Material ? 'material' : 'bought',
      sku,
      product,
      assembly: null,
      activeBom: null,
      buildable: false,
    };
  }

  /** `true` when the SKU belongs to an {@link Assembly}. */
  async isAssembly(skuId: string): Promise<boolean> {
    return (await this.resolveComponent(skuId)).kind === 'assembly';
  }

  /**
   * Read one bill and resolve every line's component. Sub-assembly lines say
   * whether they have an active bill of their own (`component.activeBom`);
   * the caller opens the next level by passing that id back in.
   *
   * @throws {BomNotFoundError} when no bill has this id.
   */
  async getBillStructure(bomId: string): Promise<BillStructure> {
    const bom = isUuid(bomId) ? await this.boms.get({ id: bomId }) : null;
    if (!bom) throw new BomNotFoundError(bomId);
    const cache = new Map<string, Promise<ResolvedComponent>>();
    const lines = await this.lines.findByBom(bomId);
    const resolved: BillStructureLine[] = [];
    for (const line of lines) {
      resolved.push({
        line,
        component: await this.resolveCached(line.componentSkuId, cache),
      });
    }
    return { bom, lines: resolved };
  }

  /**
   * Find the path by which adding `componentSkuIds` to a bill for
   * `productId` would make that product contain itself, or `null` when none
   * would. The walk follows each sub-assembly's **active** bill only; a
   * draft or superseded bill is not part of the structure.
   */
  async findCycle(
    productId: string,
    componentSkuIds: readonly string[],
  ): Promise<BomCyclePathEntry[] | null> {
    const cache = new Map<string, Promise<ResolvedComponent>>();
    const visited = new Set<string>();

    const walk = async (
      skuIds: readonly string[],
      trail: Product[],
    ): Promise<Product[] | null> => {
      for (const skuId of skuIds) {
        const component = await this.resolveCached(skuId, cache);
        const product = component.product;
        if (!product?.id) continue;
        if (product.id === productId) return [...trail, product];
        if (!component.activeBom || visited.has(product.id)) continue;
        visited.add(product.id);
        const lines = await this.lines.findByBom(component.activeBom.id!);
        const found = await walk(
          lines.map((line) => line.componentSkuId),
          [...trail, product],
        );
        if (found) return found;
      }
      return null;
    };

    const trail = await walk(componentSkuIds, []);
    if (!trail) return null;
    const self = trail[trail.length - 1];
    return [self, ...trail].map((product) => ({
      productId: product.id!,
      name: product.name || product.id!,
    }));
  }

  /**
   * Refuse a bill line that would make its bill's product contain itself.
   * A line on a draft bill is checked too, so a cycle is refused when it is
   * written rather than when the bill is activated. A line whose bill does
   * not exist is left to the caller.
   *
   * @throws {BomCycleError} naming the path.
   */
  async assertLineAcyclic(
    line: Pick<BomLine, 'bomId' | 'componentSkuId'>,
  ): Promise<void> {
    if (!isUuid(line.bomId)) return;
    const bom = await this.boms.get({ id: line.bomId });
    if (!bom) return;
    const path = await this.findCycle(bom.productId, [line.componentSkuId]);
    if (path) throw new BomCycleError(line.bomId, path);
  }

  /**
   * Refuse saving a bill as `active` when any of its lines would make its
   * product contain itself. Bills in any other status are not part of the
   * structure and pass.
   *
   * @throws {BomCycleError} naming the path.
   */
  async assertBillAcyclic(
    bom: Pick<BillOfMaterials, 'id' | 'productId' | 'status'>,
  ): Promise<void> {
    if (bom.status !== 'active' || !isUuid(bom.id)) return;
    const lines = await this.lines.findByBom(bom.id);
    if (lines.length === 0) return;
    const path = await this.findCycle(
      bom.productId,
      lines.map((line) => line.componentSkuId),
    );
    if (path) throw new BomCycleError(bom.id, path);
  }

  private resolveCached(
    skuId: string,
    cache: Map<string, Promise<ResolvedComponent>>,
  ): Promise<ResolvedComponent> {
    let pending = cache.get(skuId);
    if (!pending) {
      pending = this.resolveComponent(skuId);
      cache.set(skuId, pending);
    }
    return pending;
  }
}

/** Convenience factory for {@link AssemblyService}. */
export function createAssemblyService(
  options: AssemblyServiceOptions,
): Promise<AssemblyService> {
  return AssemblyService.create(options);
}
