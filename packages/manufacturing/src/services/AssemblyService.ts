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

import {
  type DatabaseConfig,
  resolveDatabase,
  ValidationError,
} from '@happyvertical/smrt-core';
import {
  ProductCollection,
  SkuCollection,
} from '@happyvertical/smrt-products/collections';
import {
  Material,
  type Product,
  type Sku,
} from '@happyvertical/smrt-products/models';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { BomLineCollection } from '../collections/BomLineCollection.js';
import { Assembly } from '../models/Assembly.js';
import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import { readOwnAndGlobal } from '../tenant-scope.js';
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

/** Options for {@link AssemblyService.resolveComponent} and the walks built on it. */
export interface ResolveComponentOptions {
  /**
   * The tenant whose structure is being read. When given (including `null`
   * for global records), an assembly's active bill is chosen only among
   * bills with exactly this `tenantId`, and a SKU, product or bill line
   * belonging to another tenant is treated as missing (global rows stay
   * visible), whatever tenant context is active. When omitted, the active
   * tenant context decides what is visible.
   */
  tenantId?: string | null;
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

/**
 * Whether a row belongs to the structure being read: with an explicit
 * `tenantId`, a global row (`tenantId` null) or one of that tenant's rows;
 * without one, whatever the active tenant context returned.
 */
function visibleTo(
  row: { tenantId?: string | null },
  options: ResolveComponentOptions,
): boolean {
  if (options.tenantId === undefined) return true;
  const rowTenant = row.tenantId ?? null;
  return rowTenant === null || rowTenant === options.tenantId;
}

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
    // Resolve once so every collection shares one connection: separate
    // `create` calls with a config object such as `:memory:` would each open
    // their own database.
    const db = (await resolveDatabase(options.db)) as unknown as DatabaseConfig;
    const [products, skus, boms, lines] = await Promise.all([
      ProductCollection.create({ db }),
      SkuCollection.create({ db }),
      BillOfMaterialsCollection.create({ db }),
      BomLineCollection.create({ db }),
    ]);
    return new AssemblyService(products, skus, boms, lines);
  }

  /**
   * Resolve a component SKU to what it is: an assembly (with its active bill,
   * or `null` when it has none), a material, a bought item, or missing. Never
   * throws for an unknown id; it reports `missing` instead.
   *
   * This is the documented link a multi-level explosion walks: recurse into
   * `activeBom` while `kind === 'assembly'`, stop at every other kind. Pass
   * the parent bill's `tenantId` so a shared assembly resolves to that
   * tenant's bill, not another tenant's.
   */
  async resolveComponent(
    skuId: string,
    options: ResolveComponentOptions = {},
  ): Promise<ResolvedComponent> {
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
    // With an explicit tenant, the SKU and product are read as that tenant's
    // or global (a shared material stays visible under a tenant context); one
    // of another tenant is reported as missing, never resolved.
    const sku = await this.byId(this.skus, skuId, options);
    if (!sku || !visibleTo(sku, options)) return missing(null);
    if (!isUuid(sku.productId)) return missing(sku);
    const product = await this.byId(this.products, sku.productId, options);
    if (!product || !visibleTo(product, options)) return missing(sku);

    if (product instanceof Assembly) {
      const activeBom = await this.findActiveBom(product.id!, options);
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

  /**
   * The highest-version active bill for a product. With `options.tenantId`,
   * that tenant's own bill, or else a global one; another tenant's never.
   */
  async findActiveBom(
    productId: string,
    options: ResolveComponentOptions = {},
  ): Promise<BillOfMaterials | null> {
    const owner = options.tenantId;
    if (owner === undefined) return this.boms.findActiveForProduct(productId);
    const active = await readOwnAndGlobal(owner, () =>
      this.boms.list({
        where: { productId, status: 'active' },
        orderBy: 'version DESC',
      }),
    );
    return (
      active.find((bom) => (bom.tenantId ?? null) === owner) ??
      active.find((bom) => (bom.tenantId ?? null) === null) ??
      null
    );
  }

  /**
   * One row by id: through the collection's `get` without an explicit
   * tenant, else as a list read of that tenant's and global rows.
   */
  private async byId<T extends { tenantId?: string | null }>(
    collection: {
      get(filter: { id: string }): Promise<T | null>;
      list(options: { where: { id: string }; limit: number }): Promise<T[]>;
    },
    id: string,
    options: ResolveComponentOptions,
  ): Promise<T | null> {
    const owner = options.tenantId;
    if (owner === undefined) return collection.get({ id });
    const rows = await readOwnAndGlobal(owner, () =>
      collection.list({ where: { id }, limit: 1 }),
    );
    return rows[0] ?? null;
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
    const scope = { tenantId: bom.tenantId ?? null };
    const lines = (
      await readOwnAndGlobal(scope.tenantId, () => this.lines.findByBom(bomId))
    ).filter((line) => visibleTo(line, scope));
    const resolved: BillStructureLine[] = [];
    for (const line of lines) {
      resolved.push({
        line,
        component: await this.resolveCached(line.componentSkuId, cache, scope),
      });
    }
    return { bom, lines: resolved };
  }

  /**
   * Find the path by which adding `componentSkuIds` to a bill for
   * `productId` would make that product contain itself, or `null` when none
   * would. The walk follows each sub-assembly's **active** bill only; a
   * draft or superseded bill is not part of the structure. Pass the bill's
   * `tenantId` so the walk reads that tenant's structure.
   */
  async findCycle(
    productId: string,
    componentSkuIds: readonly string[],
    options: ResolveComponentOptions = {},
  ): Promise<BomCyclePathEntry[] | null> {
    const cache = new Map<string, Promise<ResolvedComponent>>();
    const visited = new Set<string>();

    const walk = async (
      skuIds: readonly string[],
      trail: Product[],
    ): Promise<Product[] | null> => {
      for (const skuId of skuIds) {
        const component = await this.resolveCached(skuId, cache, options);
        const product = component.product;
        if (!product?.id) continue;
        if (product.id === productId) return [...trail, product];
        if (!component.activeBom || visited.has(product.id)) continue;
        visited.add(product.id);
        const billId = component.activeBom.id!;
        const lines = (
          options.tenantId === undefined
            ? await this.lines.findByBom(billId)
            : await readOwnAndGlobal(options.tenantId, () =>
                this.lines.findByBom(billId),
              )
        ).filter((line) => visibleTo(line, options));
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
    const path = await this.findCycle(bom.productId, [line.componentSkuId], {
      tenantId: bom.tenantId ?? null,
    });
    if (path) throw new BomCycleError(line.bomId, path);
  }

  /**
   * Refuse saving a bill as `active` when any of its lines would make its
   * product contain itself. Bills in any other status are not part of the
   * structure and pass.
   *
   * The lines checked are the bill's own and those of any stored bill with
   * the same natural key (`productId`, `version`, and the bill's tenant, or
   * the active tenant when the bill has none yet): saving a new
   * instance with that key upserts onto the stored bill and activates its
   * lines, so they are part of what the save makes active.
   *
   * @throws {BomCycleError} naming the path.
   */
  async assertBillAcyclic(
    bom: Pick<
      BillOfMaterials,
      'id' | 'productId' | 'status' | 'version' | 'tenantId'
    >,
  ): Promise<void> {
    if (bom.status !== 'active') return;
    const billIds = new Set<string>();
    if (isUuid(bom.id)) billIds.add(bom.id);
    // Validation runs before the tenancy interceptor fills `tenantId`, so an
    // omitted tenant is the one the save will be stamped with.
    const tenantId = bom.tenantId ?? getCurrentTenant()?.tenantId ?? null;
    const sameKey = await readOwnAndGlobal(tenantId, () =>
      this.boms.list({
        where: { productId: bom.productId, version: bom.version },
      }),
    );
    for (const stored of sameKey) {
      if (stored.id && (stored.tenantId ?? null) === tenantId)
        billIds.add(stored.id);
    }
    const componentSkuIds: string[] = [];
    for (const billId of billIds) {
      for (const line of await readOwnAndGlobal(tenantId, () =>
        this.lines.findByBom(billId),
      ))
        if (visibleTo(line, { tenantId }))
          componentSkuIds.push(line.componentSkuId);
    }
    if (componentSkuIds.length === 0) return;
    const path = await this.findCycle(bom.productId, componentSkuIds, {
      tenantId,
    });
    if (path) throw new BomCycleError(bom.id || [...billIds][0] || '', path);
  }

  private resolveCached(
    skuId: string,
    cache: Map<string, Promise<ResolvedComponent>>,
    options: ResolveComponentOptions,
  ): Promise<ResolvedComponent> {
    let pending = cache.get(skuId);
    if (!pending) {
      pending = this.resolveComponent(skuId, options);
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
