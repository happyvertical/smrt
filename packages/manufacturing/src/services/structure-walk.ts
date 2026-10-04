/**
 * The shared step of every multi-level walk in {@link BomService}: read a
 * bill's lines, resolve each component, and decide whether to open a
 * sub-assembly's active bill. Explosion, planning, cost and labour all walk
 * the same way through this class, so they agree on what is opened.
 *
 * A walk is bounded three ways: by the caller's `levels`, by
 * {@link MAX_EXPLOSION_DEPTH} and {@link MAX_EXPLOSION_LINES}, and by the path
 * of products above the current line, which turns a cycle already present in
 * stored data into a {@link BomStructureCycleError} instead of a loop.
 *
 * @internal
 * @packageDocumentation
 */

import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import { isOwnOrGlobal, readOwnAndGlobal } from '../tenant-scope.js';
import {
  BomExplosionLimitError,
  type ExplosionLevels,
  type ExplosionPathEntry,
  MAX_EXPLOSION_DEPTH,
  MAX_EXPLOSION_LINES,
} from '../types.js';
import {
  type AssemblyService,
  BomCycleError,
  type BomCyclePathEntry,
  type ResolvedComponent,
} from './AssemblyService.js';

/**
 * Thrown when a multi-level walk meets a product that already contains
 * itself in stored data (a loop saved before cycle refusal existed, or
 * written around it). Carries the loop as `path`, like the
 * {@link BomCycleError} it extends.
 */
export class BomStructureCycleError extends BomCycleError {
  override name = 'BomStructureCycleError';

  constructor(bomId: string, path: BomCyclePathEntry[]) {
    super(bomId, path);
    this.message = `The bill structure contains a cycle: ${path
      .map((entry) => entry.name)
      .join(' → ')}`;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The deepest level a walk may open for `levels`. Throws for anything that is
 * not a whole number from 1 to {@link MAX_EXPLOSION_DEPTH} or `'all'`.
 */
export function maxLevelFor(levels: ExplosionLevels | undefined): number {
  if (levels === undefined) return 1;
  if (levels === 'all') return MAX_EXPLOSION_DEPTH;
  if (!Number.isInteger(levels) || levels < 1 || levels > MAX_EXPLOSION_DEPTH)
    throw new Error(
      `levels must be a whole number from 1 to ${MAX_EXPLOSION_DEPTH}, or 'all' (got ${String(levels)})`,
    );
  return levels;
}

/** `true` when the caller asked for a walk rather than the single-level form. */
export function isMultiLevel(levels: ExplosionLevels | undefined): boolean {
  return maxLevelFor(levels) > 1;
}

/** One walk from one top bill; caches what it reads for the walk's lifetime. */
export class StructureWalk {
  private readonly components = new Map<string, Promise<ResolvedComponent>>();
  private readonly bills = new Map<string, Promise<BomLine[]>>();
  private lineCount = 0;
  /** The deepest level whose lines the walk reads. */
  readonly maxLevel: number;

  constructor(
    private readonly assemblies: AssemblyService,
    /** The bill the walk starts from. */
    readonly top: BillOfMaterials,
    /** The caller's `levels`. */
    readonly levels: ExplosionLevels,
  ) {
    this.maxLevel = maxLevelFor(levels);
  }

  /**
   * Resolve a component SKU, reading assemblies' active bills in the top
   * bill's tenant so a shared assembly opens that tenant's bill.
   */
  resolve(skuId: string): Promise<ResolvedComponent> {
    let pending = this.components.get(skuId);
    if (!pending) {
      pending = this.assemblies.resolveComponent(skuId, {
        tenantId: this.top.tenantId ?? null,
      });
      this.components.set(skuId, pending);
    }
    return pending;
  }

  /**
   * A bill's lines in the top bill's tenant (and global lines), counted
   * against {@link MAX_EXPLOSION_LINES} every time the walk visits them (a
   * shared sub-assembly counts once per use).
   */
  async linesOf(bomId: string): Promise<BomLine[]> {
    let pending = this.bills.get(bomId);
    if (!pending) {
      // The top bill's structure only: its tenant's lines and global ones,
      // as `AssemblyService` reads a structure.
      const tenantId = this.top.tenantId ?? null;
      pending = readOwnAndGlobal(tenantId, () =>
        this.assemblies.lines.findByBom(bomId),
      ).then((lines) => lines.filter((line) => isOwnOrGlobal(line, tenantId)));
      this.bills.set(bomId, pending);
    }
    const lines = await pending;
    this.lineCount += lines.length;
    if (this.lineCount > MAX_EXPLOSION_LINES)
      throw new BomExplosionLimitError(this.top.id as string, 'lines');
    return lines;
  }

  /** The path entry for the top bill. */
  async root(): Promise<ExplosionPathEntry> {
    const productId = this.top.productId;
    let name = productId;
    if (UUID_PATTERN.test(productId)) {
      // Only a name the top bill's tenant may see.
      const owner = this.top.tenantId ?? null;
      const [product] = await readOwnAndGlobal(owner, () =>
        this.assemblies.products.list({ where: { id: productId }, limit: 1 }),
      );
      if (product?.name && isOwnOrGlobal(product, owner)) name = product.name;
    }
    return { bomId: this.top.id as string, productId, name };
  }

  /**
   * The bill to open below a line at `level`, or `null` when the component
   * is not a sub-assembly with an active bill or `levels` stops here.
   *
   * @throws {BomStructureCycleError} when the sub-assembly is already on
   *   `path` (it would contain itself).
   * @throws {BomExplosionLimitError} when `levels: 'all'` would go deeper
   *   than {@link MAX_EXPLOSION_DEPTH}.
   */
  open(
    component: ResolvedComponent,
    level: number,
    path: readonly ExplosionPathEntry[],
  ): ExplosionPathEntry | null {
    const bom = component.activeBom;
    const product = component.product;
    if (!component.buildable || !bom?.id || !product?.id) return null;
    const name = product.name || product.id;
    const at = path.findIndex((entry) => entry.productId === product.id);
    if (at >= 0)
      throw new BomStructureCycleError(this.top.id as string, [
        ...path
          .slice(at)
          .map((entry) => ({ productId: entry.productId, name: entry.name })),
        { productId: product.id, name },
      ]);
    if (level >= this.maxLevel) {
      if (this.levels === 'all')
        throw new BomExplosionLimitError(this.top.id as string, 'depth');
      return null;
    }
    return { bomId: bom.id, productId: product.id, name };
  }
}
