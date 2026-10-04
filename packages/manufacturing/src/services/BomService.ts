/**
 * BomService — cost rollup, requirements explosion, and "can we make this?"
 * stock-availability checks for a {@link BillOfMaterials}.
 *
 * The service is the sanctioned planning surface for BOM-driven workflows.
 * It never mutates stock — it answers questions:
 *
 * - "How much does it cost to make one unit?" via {@link computeMaterialCost}
 * - "What do I need to buy / pull to make N units?" via {@link explodeRequirements}
 * - "Do I have enough on hand?" via {@link canProduce}
 *
 * Every method reads one level of the bill by default. Pass `{ levels }` to
 * walk sub-assemblies too: a line whose component SKU belongs to an
 * `Assembly` with an active bill is opened, to the given depth or (`'all'`)
 * down to materials and bought items. {@link explode} returns that walk line
 * by line with the rolled-up totals, and {@link planRequirements} nets it
 * against stock: how much of each sub-assembly is available, how much is
 * short, and what building the shortfall takes.
 *
 * Construct via {@link BomService.create} — the static factory wires up
 * the BOM, BOM-line, and inventory collections so a single `db` (or a
 * pre-built {@link StockService}) drives everything.
 *
 * Material cost resolution is pluggable. Pass a `costResolver` callback to
 * supply unit costs from anywhere — `@happyvertical/smrt-products`
 * (`Material.costPerUnit`), a purchase-order rolling average, a vendor
 * price book, anything. When no resolver is supplied, costs default to
 * `0` and the per-line `costUnavailable` flag is set so UIs can surface
 * "missing cost data" rather than silently rolling up a $0 BOM.
 *
 * @packageDocumentation
 */

import { type DatabaseConfig, resolveDatabase } from '@happyvertical/smrt-core';
import {
  createStockService,
  type StockService,
} from '@happyvertical/smrt-inventory';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { BomLineCollection } from '../collections/BomLineCollection.js';
import { OperationCollection } from '../collections/OperationCollection.js';
import { RoutingStepCollection } from '../collections/RoutingStepCollection.js';
import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import type {
  LabourEstimate,
  OperationRateResolver,
  RoutingStepEstimate,
} from '../operation-types.js';
import {
  type BomCostRollup,
  type BomLineCost,
  BomNotFoundError,
  type CanProduceResult,
  type ExplodedLine,
  type Explosion,
  type ExplosionOptions,
  type ExplosionPathEntry,
  type MaterialRequirement,
  type MaterialShortage,
  type PlannedLine,
  type RequirementsPlan,
  type SubAssemblyLabour,
} from '../types.js';
import { AssemblyService, type ResolvedComponent } from './AssemblyService.js';
import { isMultiLevel, StructureWalk } from './structure-walk.js';

/**
 * Callback signature for resolving the unit cost of a component SKU.
 *
 * Implementations should return the latest known cost in the BOM's
 * currency, or `null` (or `undefined`) when no cost is available. The
 * service treats unresolved costs as `0` and marks the affected line so
 * callers can warn the user.
 *
 * @example
 * ```typescript
 * import { MaterialCollection } from '@happyvertical/smrt-products/models';
 *
 * const materials = await MaterialCollection.create({ db });
 *
 * const bom = await BomService.create({
 *   db,
 *   costResolver: async (componentSkuId) => {
 *     const sku = await skus.get(componentSkuId);
 *     if (!sku?.productId) return null;
 *     const material = await materials.get(sku.productId);
 *     return material?.costPerUnit ?? null;
 *   },
 * });
 * ```
 */
export type ComponentCostResolver = (
  componentSkuId: string,
) => Promise<number | null | undefined> | number | null | undefined;

/**
 * Options accepted by {@link BomService.create}.
 *
 * Either provide a `db` for the service to construct its own internal
 * collections + {@link StockService}, or pass a pre-built `stockService`
 * to share one across subsystems.
 */
export type BomServiceOptions = {
  /**
   * Optional resolver that returns the latest known unit cost for a
   * component SKU. See {@link ComponentCostResolver}. When omitted, all
   * costs default to `0` and per-line `costUnavailable` is set.
   */
  costResolver?: ComponentCostResolver;
  /**
   * Optional resolver that returns the hourly labour rate for an operation,
   * used by {@link BomService.computeLabourEstimate}. When omitted, the
   * estimate reports minutes only and flags every step `rateUnavailable`.
   */
  rateResolver?: OperationRateResolver;
} & (
  | { db: DatabaseConfig; stockService?: StockService }
  | { stockService: StockService; db?: DatabaseConfig }
);

/**
 * BOM-driven planning service. See module documentation for the role
 * this plays in the manufacturing pipeline.
 *
 * @example
 * ```typescript
 * const bomService = await BomService.create({ db });
 * const rollup = await bomService.computeMaterialCost(bom.id!);
 * const requirements = await bomService.explodeRequirements(bom.id!, 100);
 * const check = await bomService.canProduce(bom.id!, 100);
 * ```
 */
export class BomService {
  private constructor(
    public readonly boms: BillOfMaterialsCollection,
    public readonly lines: BomLineCollection,
    public readonly stockService: StockService,
    private readonly costResolver: ComponentCostResolver | undefined,
    public readonly routingSteps: RoutingStepCollection,
    public readonly operations: OperationCollection,
    private readonly rateResolver: OperationRateResolver | undefined,
    /** Resolves components for the multi-level walks. */
    public readonly assemblies: AssemblyService,
  ) {}

  /** Factory — prefer {@link createBomService}. */
  static async create(options: BomServiceOptions): Promise<BomService> {
    const stockService =
      options.stockService ?? (await buildStockService(options));
    // Share the same db that the StockService uses so reads always hit
    // one connection / pool. StockService exposes its `db` as a public
    // field specifically so downstream services can compose against it
    // without reaching into Collection internals.
    // Resolve once: a config object such as `{ type: 'sqlite', url: ':memory:' }`
    // would otherwise yield a separate database per collection.
    const sharedDb = (await resolveDatabase(
      options.stockService ? (options.db ?? stockService.db) : stockService.db,
    )) as unknown as DatabaseConfig;
    const [boms, lines, routingSteps, operations, assemblies] =
      await Promise.all([
        BillOfMaterialsCollection.create({ db: sharedDb }),
        BomLineCollection.create({ db: sharedDb }),
        RoutingStepCollection.create({ db: sharedDb }),
        OperationCollection.create({ db: sharedDb }),
        AssemblyService.create({ db: sharedDb }),
      ]);
    return new BomService(
      boms,
      lines,
      stockService,
      options.costResolver,
      routingSteps,
      operations,
      options.rateResolver,
      assemblies,
    );
  }

  /**
   * Walk every {@link BomLine} for the given BOM, resolve each line's
   * component cost, apply waste, and return the rolled-up material cost
   * per produced unit along with a per-line breakdown.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist.
   *
   * Lines whose cost cannot be resolved contribute `0` to the total and
   * set `costUnavailable: true` on their breakdown row; the aggregate
   * `hasMissingCosts` flag mirrors this so callers can surface a UI
   * warning.
   *
   * With `{ levels }` above 1, a sub-assembly line whose bill the walk opens
   * is costed from that bill instead of the resolver: its `unitCost` is the
   * bill's rolled-up material cost per unit, its `components` hold that
   * bill's lines, and a missing cost anywhere below marks it and
   * `hasMissingCosts` (its known part still counts, so the total is a lower
   * bound). Other lines, including sub-assemblies with no active bill, use
   * the resolver as before.
   */
  async computeMaterialCost(
    bomId: string,
    options: ExplosionOptions = {},
  ): Promise<BomCostRollup> {
    if (isMultiLevel(options.levels))
      return this.computeMultiLevelCost(bomId, options);
    const bom = await this.requireBom(bomId);
    const lines = await this.lines.findByBom(bomId);
    const lineBreakdown: BomLineCost[] = [];
    let totalCost = 0;
    let hasMissingCosts = false;

    for (const line of lines) {
      const effectiveQty = line.effectiveQtyPerUnit();
      const resolved = await this.resolveCost(line.componentSkuId);
      const unitCost = resolved ?? 0;
      const costUnavailable = resolved === null || resolved === undefined;
      const lineCost = unitCost * effectiveQty;
      if (costUnavailable) {
        hasMissingCosts = true;
      } else {
        totalCost += lineCost;
      }

      lineBreakdown.push({
        componentSkuId: line.componentSkuId,
        qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        wastePercent: Number(line.wastePercent ?? 0),
        effectiveQty,
        unitCost,
        lineCost,
        uom: line.uom,
        costUnavailable,
      });
    }

    return {
      bomId,
      totalCost,
      currency: bom.currency || 'USD',
      lineBreakdown,
      hasMissingCosts,
    };
  }

  /**
   * Roll up the estimated labour to build one unit from the bill's routing:
   * total minutes, plus cost when a `rateResolver` was supplied (hourly rate
   * times minutes, per step). A bill with no routing returns an empty
   * estimate with zero totals, so callers can add it to the material cost
   * unconditionally. Retired operations still count: the routing names them.
   *
   * With `{ levels }` above 1, every sub-assembly the walk opens adds its own
   * bill's routing, multiplied by the units of it one unit needs (waste
   * included); see {@link LabourEstimate.subAssemblies}.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist.
   */
  async computeLabourEstimate(
    bomId: string,
    options: ExplosionOptions = {},
  ): Promise<LabourEstimate> {
    if (isMultiLevel(options.levels))
      return this.computeMultiLevelLabour(bomId, options);
    return this.labourFor(await this.requireBom(bomId));
  }

  /** One bill's own routing estimate, per unit of its product. */
  private async labourFor(bom: BillOfMaterials): Promise<LabourEstimate> {
    const bomId = bom.id as string;
    const routing = await this.routingSteps.findByBom(bomId);
    const steps: RoutingStepEstimate[] = [];
    let totalMinutes = 0;
    let totalCost = 0;
    let hasMissingRates = false;

    for (const step of routing) {
      const operation = await this.operations.get(step.operationId);
      const minutes = Number(step.estimatedMinutes ?? 0);
      const rate = operation ? await this.resolveRate(operation) : null;
      const rateUnavailable = rate === null;
      const stepCost = rate === null ? 0 : (minutes / 60) * rate;
      totalMinutes += minutes;
      if (rateUnavailable) hasMissingRates = true;
      else totalCost += stepCost;
      steps.push({
        stepId: step.id as string,
        sequence: step.sequence,
        operationId: step.operationId,
        operationCode: operation?.code ?? '',
        operationName: operation?.name ?? '',
        estimatedMinutes: minutes,
        hourlyRate: rate ?? 0,
        stepCost,
        rateUnavailable,
      });
    }

    return {
      bomId,
      hasRouting: steps.length > 0,
      totalMinutes,
      totalCost,
      currency: bom.currency || 'USD',
      steps,
      hasMissingRates,
    };
  }

  /**
   * Return a "shopping list" of materials needed to produce `qty` units of
   * the parent product against the given BOM. Lines that reference the
   * same component SKU are summed so each `componentSkuId` appears once
   * in the result.
   *
   * Does NOT mutate stock — purely a planning helper. Use
   * {@link ProductionService.consumeMaterials} when you're ready to write
   * stock movements.
   *
   * With `{ levels }` above 1, sub-assemblies with an active bill are
   * replaced by what their bills need, waste compounding down the levels;
   * this is {@link explode}'s `totals`.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist; throws a
   * plain `Error` when `qty` is not a positive finite number.
   */
  async explodeRequirements(
    bomId: string,
    qty: number,
    options: ExplosionOptions = {},
  ): Promise<MaterialRequirement[]> {
    if (isMultiLevel(options.levels))
      return (await this.explode(bomId, qty, options)).totals;
    assertPositiveQty(qty, 'explodeRequirements');
    await this.requireBom(bomId);
    const lines = await this.lines.findByBom(bomId);

    // Sum across duplicate component SKUs. Keep the first-seen `uom` per
    // SKU; if two lines disagree on `uom`, we surface the first one and
    // assume the caller noticed during BOM authoring.
    const aggregate = new Map<string, MaterialRequirement>();
    for (const line of lines) {
      const effectiveQty = line.effectiveQtyPerUnit() * qty;
      const existing = aggregate.get(line.componentSkuId);
      if (existing) {
        existing.totalQty += effectiveQty;
      } else {
        aggregate.set(line.componentSkuId, {
          componentSkuId: line.componentSkuId,
          totalQty: effectiveQty,
          uom: line.uom,
        });
      }
    }

    return Array.from(aggregate.values());
  }

  /**
   * Check whether the requirements for producing `qty` units against the
   * given BOM are currently satisfied by available stock. Returns
   * `{ ok: true, shortages: [] }` when every component has enough
   * `available` stock across all locations; `{ ok: false, shortages: [...] }`
   * with one entry per insufficient component otherwise.
   *
   * Available stock is summed across every location (the planning
   * question is "do we have it at all?"; the operational question of
   * "where do we pull from?" is left to the caller of
   * {@link ProductionService.consumeMaterials}).
   *
   * With `{ levels }` above 1 the check is {@link planRequirements}: a
   * sub-assembly that is short and has an active bill is opened for its
   * shortfall, and each shortage is reported on the line where it occurs,
   * with its `level` and `path`. Stock is allocated as the walk goes, so a
   * component used in two places is not counted twice.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist.
   */
  async canProduce(
    bomId: string,
    qty: number,
    options: ExplosionOptions = {},
  ): Promise<CanProduceResult> {
    if (isMultiLevel(options.levels)) {
      const plan = await this.planRequirements(bomId, qty, options);
      return plan.ok
        ? { ok: true, shortages: [] }
        : { ok: false, shortages: plan.shortages };
    }
    const requirements = await this.explodeRequirements(bomId, qty);

    // Fan the per-component availability queries out in parallel so a
    // BOM with N components costs O(1) round-trips of latency instead
    // of O(N). `totalForSku` is a single aggregate read per component
    // — independent across SKUs — so there's no ordering or
    // consistency concern from running them concurrently.
    const availabilities = await Promise.all(
      requirements.map(async (requirement) => ({
        requirement,
        available: await this.stockService.levels.totalForSku(
          requirement.componentSkuId,
          'available',
        ),
      })),
    );

    const shortages: MaterialShortage[] = [];
    for (const { requirement, available } of availabilities) {
      if (available < requirement.totalQty) {
        shortages.push({
          componentSkuId: requirement.componentSkuId,
          requested: requirement.totalQty,
          available,
        });
      }
    }

    if (shortages.length === 0) {
      return { ok: true, shortages: [] };
    }
    return { ok: false, shortages };
  }

  /**
   * Walk the bill for `qty` units and return every line, depth first, with
   * its level, the path of bills above it and its quantity for the run, plus
   * the rolled-up `totals`. Gross requirements: stock is not read.
   *
   * `levels` (default `1`) says how far to open sub-assemblies; see
   * {@link ExplosionLevels}. Waste compounds: a sub-assembly line's quantity
   * includes its own waste, and its bill's lines are multiplied by it.
   *
   * Throws {@link BomNotFoundError}, `BomStructureCycleError` when stored
   * data already has a product containing itself, `BomExplosionLimitError`
   * past the depth or line limits, and a plain `Error` for a bad `qty` or
   * `levels`.
   */
  async explode(
    bomId: string,
    qty: number,
    options: ExplosionOptions = {},
  ): Promise<Explosion> {
    assertPositiveQty(qty, 'explode');
    const levels = options.levels ?? 1;
    const top = await this.requireBom(bomId);
    const walk = new StructureWalk(this.assemblies, top, levels);
    const lines: ExplodedLine[] = [];

    const visit = async (
      billId: string,
      level: number,
      path: ExplosionPathEntry[],
      parentQty: number,
    ): Promise<void> => {
      for (const line of await walk.linesOf(billId)) {
        const component = await walk.resolve(line.componentSkuId);
        const sub = walk.open(component, level, path);
        const exploded = explodedLine(line, component, level, path, parentQty);
        exploded.expanded = sub !== null;
        lines.push(exploded);
        if (sub)
          await visit(sub.bomId, level + 1, [...path, sub], exploded.totalQty);
      }
    };
    await visit(bomId, 1, [await walk.root()], qty);

    return {
      bomId,
      productId: top.productId,
      qty,
      levels,
      lines,
      totals: sumRequirements(lines.filter((line) => !line.expanded)),
    };
  }

  /**
   * Net the walk against stock: for each line, the available stock (all
   * locations) not yet allocated to an earlier line and how much is short.
   * A sub-assembly that is short and has an active bill is opened for the
   * shortfall only, so its lines say what building that shortfall takes;
   * one covered by stock is not opened. Lines that are short and cannot be
   * opened are the `shortages`, each at its own level.
   *
   * These are facts, not a decision: the application decides whether a
   * short sub-assembly is built or bought. Does not mutate stock.
   *
   * Throws as {@link explode} does.
   */
  async planRequirements(
    bomId: string,
    qty: number,
    options: ExplosionOptions = {},
  ): Promise<RequirementsPlan> {
    assertPositiveQty(qty, 'planRequirements');
    const levels = options.levels ?? 1;
    const top = await this.requireBom(bomId);
    const walk = new StructureWalk(this.assemblies, top, levels);
    const lines: PlannedLine[] = [];
    const shortages: MaterialShortage[] = [];
    const unallocated = new Map<string, Promise<number>>();
    const availableFor = (skuId: string): Promise<number> => {
      let pending = unallocated.get(skuId);
      if (!pending) {
        pending = this.stockService.levels
          .totalForSku(skuId, 'available')
          .then((total) => Math.max(0, Number(total) || 0));
        unallocated.set(skuId, pending);
      }
      return pending;
    };

    const visit = async (
      billId: string,
      level: number,
      path: ExplosionPathEntry[],
      parentQty: number,
    ): Promise<void> => {
      for (const line of await walk.linesOf(billId)) {
        const component = await walk.resolve(line.componentSkuId);
        const base = explodedLine(line, component, level, path, parentQty);
        const available = await availableFor(line.componentSkuId);
        const allocated = Math.min(available, base.totalQty);
        unallocated.set(
          line.componentSkuId,
          Promise.resolve(available - allocated),
        );
        const short = significant(base.totalQty - allocated, base.totalQty);
        const sub = short > 0 ? walk.open(component, level, path) : null;
        lines.push({ ...base, expanded: sub !== null, available, short });
        if (sub) {
          await visit(sub.bomId, level + 1, [...path, sub], short);
        } else if (short > 0) {
          shortages.push({
            componentSkuId: line.componentSkuId,
            requested: base.totalQty,
            available,
            level,
            path,
            uom: base.uom,
            buildable: component.buildable,
          });
        }
      }
    };
    await visit(bomId, 1, [await walk.root()], qty);

    return {
      bomId,
      productId: top.productId,
      qty,
      levels,
      lines,
      shortages,
      ok: shortages.length === 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch a BOM by id or throw {@link BomNotFoundError}. Centralises the
   * "missing BOM" error path so callers don't have to repeat the check.
   */
  private async requireBom(bomId: string): Promise<BillOfMaterials> {
    if (!bomId) throw new BomNotFoundError(bomId);
    const bom = await this.boms.get(bomId);
    if (!bom) throw new BomNotFoundError(bomId);
    return bom;
  }

  /** {@link computeMaterialCost} with `levels` above 1. */
  private async computeMultiLevelCost(
    bomId: string,
    options: ExplosionOptions,
  ): Promise<BomCostRollup> {
    const top = await this.requireBom(bomId);
    const walk = new StructureWalk(this.assemblies, top, options.levels ?? 1);

    const rollUp = async (
      billId: string,
      level: number,
      path: ExplosionPathEntry[],
    ): Promise<Omit<BomCostRollup, 'bomId' | 'currency'>> => {
      const lineBreakdown: BomLineCost[] = [];
      let totalCost = 0;
      let hasMissingCosts = false;
      for (const line of await walk.linesOf(billId)) {
        const component = await walk.resolve(line.componentSkuId);
        const sub = walk.open(component, level, path);
        const effectiveQty = line.effectiveQtyPerUnit();
        const entry: BomLineCost = {
          componentSkuId: line.componentSkuId,
          qtyPerUnit: Number(line.qtyPerUnit ?? 0),
          wastePercent: Number(line.wastePercent ?? 0),
          effectiveQty,
          unitCost: 0,
          lineCost: 0,
          uom: line.uom,
          costUnavailable: false,
        };
        if (sub) {
          const inner = await rollUp(sub.bomId, level + 1, [...path, sub]);
          entry.unitCost = inner.totalCost;
          entry.lineCost = inner.totalCost * effectiveQty;
          entry.costUnavailable = inner.hasMissingCosts;
          entry.subBomId = sub.bomId;
          entry.components = inner.lineBreakdown;
          totalCost += entry.lineCost;
        } else {
          const resolved = await this.resolveCost(line.componentSkuId);
          entry.unitCost = resolved ?? 0;
          entry.lineCost = entry.unitCost * effectiveQty;
          entry.costUnavailable = resolved === null;
          if (!entry.costUnavailable) totalCost += entry.lineCost;
        }
        if (entry.costUnavailable) hasMissingCosts = true;
        lineBreakdown.push(entry);
      }
      return { totalCost, lineBreakdown, hasMissingCosts };
    };

    const rolled = await rollUp(bomId, 1, [await walk.root()]);
    return { bomId, currency: top.currency || 'USD', ...rolled };
  }

  /** {@link computeLabourEstimate} with `levels` above 1. */
  private async computeMultiLevelLabour(
    bomId: string,
    options: ExplosionOptions,
  ): Promise<LabourEstimate> {
    const top = await this.requireBom(bomId);
    const walk = new StructureWalk(this.assemblies, top, options.levels ?? 1);
    const own = await this.labourFor(top);
    const estimates = new Map<string, Promise<LabourEstimate>>();
    const subAssemblies: SubAssemblyLabour[] = [];

    const visit = async (
      billId: string,
      level: number,
      path: ExplosionPathEntry[],
      units: number,
    ): Promise<void> => {
      for (const line of await walk.linesOf(billId)) {
        const component = await walk.resolve(line.componentSkuId);
        const sub = walk.open(component, level, path);
        if (!sub || !component.activeBom) continue;
        const subBill = component.activeBom;
        let estimate = estimates.get(sub.bomId);
        if (!estimate) {
          estimate = this.labourFor(subBill);
          estimates.set(sub.bomId, estimate);
        }
        const unitsPerUnit = units * line.effectiveQtyPerUnit();
        subAssemblies.push({
          lineId: line.id as string,
          componentSkuId: line.componentSkuId,
          name: sub.name,
          level,
          path,
          unitsPerUnit,
          estimate: await estimate,
        });
        await visit(sub.bomId, level + 1, [...path, sub], unitsPerUnit);
      }
    };
    await visit(bomId, 1, [await walk.root()], 1);

    let totalMinutes = own.totalMinutes;
    let totalCost = own.totalCost;
    for (const sub of subAssemblies) {
      totalMinutes += sub.unitsPerUnit * sub.estimate.totalMinutes;
      totalCost += sub.unitsPerUnit * sub.estimate.totalCost;
    }
    return {
      ...own,
      hasRouting:
        own.hasRouting || subAssemblies.some((sub) => sub.estimate.hasRouting),
      totalMinutes,
      totalCost,
      hasMissingRates:
        own.hasMissingRates ||
        subAssemblies.some((sub) => sub.estimate.hasMissingRates),
      subAssemblies,
    };
  }

  /** Run the {@link OperationRateResolver}; `null` when there is no rate. */
  private async resolveRate(
    operation: Parameters<OperationRateResolver>[0],
  ): Promise<number | null> {
    if (!this.rateResolver) return null;
    const value = await this.rateResolver(operation);
    if (value === null || value === undefined || !Number.isFinite(value))
      return null;
    return Number(value);
  }

  /**
   * Run the supplied {@link ComponentCostResolver} for the given component
   * SKU. Returns `null` when no resolver is registered or when the
   * resolver returns `null` / `undefined`.
   */
  private async resolveCost(componentSkuId: string): Promise<number | null> {
    if (!this.costResolver) return null;
    const value = await this.costResolver(componentSkuId);
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;
    return Number(value);
  }
}

/**
 * One line of a walk before stock is considered: quantities for the run,
 * with the parent's quantity (which already carries every waste above it)
 * times this line's quantity per unit including its own waste.
 */
function explodedLine(
  line: BomLine,
  component: ResolvedComponent,
  level: number,
  path: ExplosionPathEntry[],
  parentQty: number,
): ExplodedLine {
  const effectiveQtyPerUnit = line.effectiveQtyPerUnit();
  return {
    lineId: line.id as string,
    bomId: line.bomId,
    level,
    path,
    componentSkuId: line.componentSkuId,
    kind: component.kind,
    name: component.product?.name ?? '',
    skuCode: component.sku?.code ?? '',
    qtyPerUnit: Number(line.qtyPerUnit ?? 0),
    wastePercent: Number(line.wastePercent ?? 0),
    effectiveQtyPerUnit,
    uom: line.uom,
    totalQty: parentQty * effectiveQtyPerUnit,
    buildable: component.buildable,
    subBomId: component.activeBom?.id ?? null,
    expanded: false,
  };
}

/**
 * Sum lines per component SKU, keeping the first unit seen (as the
 * single-level explosion does).
 */
function sumRequirements(lines: ExplodedLine[]): MaterialRequirement[] {
  const totals = new Map<string, MaterialRequirement>();
  for (const line of lines) {
    const existing = totals.get(line.componentSkuId);
    if (existing) existing.totalQty += line.totalQty;
    else
      totals.set(line.componentSkuId, {
        componentSkuId: line.componentSkuId,
        totalQty: line.totalQty,
        uom: line.uom,
      });
  }
  return Array.from(totals.values());
}

/**
 * `value`, or `0` when it is floating-point noise relative to `scale`
 * (`2.2 * 100` is `220.00000000000003`; a stock of 220 covers it).
 */
function significant(value: number, scale: number): number {
  return value > 1e-9 * Math.max(1, Math.abs(scale)) ? value : 0;
}

/**
 * Reject zero / negative / non-finite quantities up front for service
 * methods that accept production-run quantities.
 */
function assertPositiveQty(qty: number, op: string): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${op}: qty must be a positive finite number (got ${qty})`);
  }
}

/**
 * Build a `StockService` from a `db` config in the options. Called only
 * when the caller did not pass a pre-built `stockService` — the option
 * union guarantees `db` is present in that case, but TypeScript can't
 * narrow the discriminated union from a `??` value check, so this helper
 * validates at runtime with a clear message.
 */
async function buildStockService(
  options: BomServiceOptions,
): Promise<StockService> {
  if (!options.db) {
    throw new Error(
      'BomService.create: either `db` or `stockService` is required',
    );
  }
  return createStockService({ db: options.db });
}

/**
 * Convenience factory. Returns a fully-initialized {@link BomService}.
 */
export async function createBomService(
  options: BomServiceOptions,
): Promise<BomService> {
  return BomService.create(options);
}

// Re-export the BomLine type alias to ease typing in adjacent code that
// wires `BomLine[]` payloads through this service.
export type { BomLine };
