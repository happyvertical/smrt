/**
 * ProductionService — the operational bridge from a production order to
 * actual stock-mutating consume/produce events.
 *
 * Production orders themselves live in `@happyvertical/smrt-commerce` as a
 * `Contract` STI subtype. This service does NOT modify those rows; it
 * simply reads the order's `productId`, looks up the active BOM, and
 * writes the right stock movements through {@link StockService}.
 *
 * Three methods:
 *
 * - {@link consumeMaterials} — for each BOM line, deduct
 *   `qtyPerUnit * (1 + wastePercent / 100) * runQty` from `available` at
 *   the production location. Stamps every movement with
 *   `sourceType: 'ProductionOrder'` + the production order id so audit
 *   queries can roll them up later. Atomic across BOM lines (one tx).
 * - {@link produceFinishedGoods} — receive `runQty` of the finished
 *   product's SKU into `available` at the production location. The caller
 *   supplies the SKU id (the production order references a *product*, not
 *   a *SKU*; in practice the production-order-level "what we are making"
 *   gets resolved to a specific SKU per variant on the line items).
 * - {@link runProduction} — consume materials AND receive finished
 *   goods in one transaction. Use this when consume + produce should be
 *   jointly atomic (e.g. a make-to-stock workflow where the factory step
 *   is invisible). Calling `consumeMaterials` then `produceFinishedGoods`
 *   separately is NOT jointly atomic — each opens its own transaction
 *   and a failure between them can leave materials deducted with no
 *   finished SKU receipt to balance it.
 *
 * ## Location convention (explicit-arg design)
 *
 * The original design considered carrying `originLocationId` on a per-
 * package mixin of `ProductionOrder`, but that adds a meta field to a
 * model owned by a sibling package. The cleaner design — and the one
 * shipped here — keeps the location explicit on the call:
 *
 * ```typescript
 * await production.consumeMaterials(order, { locationId, qty });
 * await production.produceFinishedGoods(order, { locationId, qty, finishedSkuId });
 * ```
 *
 * Callers that want a "default factory" convention can stash the
 * `locationId` on their own production-order helper or wrap this service
 * with a thin domain-level façade.
 *
 * @packageDocumentation
 */

import type { DatabaseConfig } from '@happyvertical/smrt-core';
import type {
  StockMovementReason,
  StockMutationOptions,
  StockService,
} from '@happyvertical/smrt-inventory';
import { createStockService } from '@happyvertical/smrt-inventory';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { BomLineCollection } from '../collections/BomLineCollection.js';
import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import { BomNotFoundError, NoActiveBomForProductError } from '../types.js';

/**
 * Minimal shape of a production order this service needs. We deliberately
 * accept this structural type rather than importing the `ProductionOrder`
 * class from `@happyvertical/smrt-commerce` — that would either pull a
 * dep on commerce into manufacturing or force commerce to extend a
 * manufacturing interface. Plain duck typing keeps the dependency arrow
 * pointing the way the architecture asks for (manufacturing builds on
 * inventory; commerce stays orthogonal).
 */
export interface ProductionOrderRef {
  /** Production order row id. Used for `sourceId` on every movement. */
  id?: string | null;
  /**
   * Plain string reference to the upstream product the order is asked to
   * produce. Used to look up the active BOM for the consume step.
   */
  productId?: string;
  /**
   * Optional explicit BOM id. When set, {@link consumeMaterials} uses this
   * row even if the product has a different `active` BOM — useful when an
   * order was kicked off against a specific revision.
   */
  bomId?: string;
}

/**
 * Per-call options for {@link ProductionService.consumeMaterials}.
 */
export interface ConsumeMaterialsOptions {
  /**
   * Inventory location id (warehouse / factory) where the materials are
   * pulled from. Required because the production order itself does not
   * carry a stocking location — see "Location convention" in the module
   * doc.
   */
  locationId: string;
  /**
   * Run quantity — how many finished units the BOM is being multiplied
   * by. Each BOM line's `effectiveQtyPerUnit()` is multiplied by this
   * number before being deducted from `available` stock.
   */
  qty: number;
  /**
   * Optional override of the reason code stamped on each
   * {@link StockMovement}. Defaults to `'production_consume'`.
   */
  reasonCode?: StockMovementReason;
  /**
   * Optional free-form note attached to every emitted movement.
   */
  note?: string;
}

/**
 * Per-call options for {@link ProductionService.produceFinishedGoods}.
 */
export interface ProduceFinishedGoodsOptions {
  /**
   * Inventory location id (warehouse / factory) where the finished goods
   * land. Required for the same reason as {@link ConsumeMaterialsOptions.locationId}.
   */
  locationId: string;
  /**
   * Quantity of finished goods produced. Always positive.
   */
  qty: number;
  /**
   * The SKU id of the finished product to receive into `available`. The
   * production order references a `productId` (a `Product` from
   * `@happyvertical/smrt-products`), but a product typically has multiple
   * SKUs (one per variant). The caller decides which concrete SKU each
   * line of the run produces.
   */
  finishedSkuId: string;
  /**
   * Optional override of the reason code stamped on the
   * {@link StockMovement}. Defaults to `'production_produce'`.
   */
  reasonCode?: StockMovementReason;
  /**
   * Optional free-form note attached to the emitted movement.
   */
  note?: string;
}

/**
 * Options accepted by {@link ProductionService.create}.
 *
 * Either pass a `db` for the service to construct its own
 * collections + {@link StockService}, or share a pre-built `stockService`
 * across subsystems.
 */
export type ProductionServiceOptions =
  | { db: DatabaseConfig; stockService?: StockService }
  | { stockService: StockService; db?: DatabaseConfig };

/**
 * A single emitted stock movement, returned by
 * {@link ProductionService.consumeMaterials} so callers can audit / log
 * the impact of a production run without re-querying.
 */
export interface ConsumeResult {
  /** Component SKU id whose stock was deducted. */
  componentSkuId: string;
  /** Quantity deducted (already inflated for waste). */
  qty: number;
  /** Location the stock was deducted from. */
  locationId: string;
}

/**
 * Result of {@link ProductionService.produceFinishedGoods}.
 */
export interface ProduceResult {
  /** Finished SKU id whose stock increased. */
  finishedSkuId: string;
  /** Quantity received. */
  qty: number;
  /** Location the stock was received into. */
  locationId: string;
}

/**
 * Result of {@link ProductionService.runProduction} — the consume + produce
 * pair, run inside one transaction.
 */
export interface RunProductionResult {
  consumed: ConsumeResult[];
  produced: ProduceResult;
}

/**
 * Operational bridge between a production order and the inventory ledger.
 */
export class ProductionService {
  private constructor(
    /**
     * BOM collection bound to the OUTER (non-tx) database. Used for
     * pre-flight reads in `prepareConsume()` — those run before the
     * stock-service transaction opens, by design (read-then-tx keeps
     * the transaction window narrow and rollback only covers actual
     * mutations). DO NOT add BOM writes that depend on the stock-tx
     * rolling them back together — this collection is not tx-scoped
     * and writes here would commit independently. If joint BOM-plus-
     * stock mutations are ever needed, build tx-scoped BOM collections
     * inside the `stockService.withTransaction` callback (mirror the
     * pattern in StockService.withTransaction itself).
     */
    public readonly boms: BillOfMaterialsCollection,
    /**
     * BomLine collection bound to the OUTER database. Same caveat as
     * {@link boms} — pre-flight reads only.
     */
    public readonly lines: BomLineCollection,
    public readonly stockService: StockService,
  ) {}

  /** Factory — prefer {@link createProductionService}. */
  static async create(
    options: ProductionServiceOptions,
  ): Promise<ProductionService> {
    const stockService =
      options.stockService ?? (await buildStockService(options));
    // Share the StockService's db so production + stock writes ride one
    // connection/pool. StockService.db is exposed publicly for this case.
    const sharedDb = options.db ?? stockService.db;
    const [boms, lines] = await Promise.all([
      BillOfMaterialsCollection.create({ db: sharedDb }),
      BomLineCollection.create({ db: sharedDb }),
    ]);
    return new ProductionService(boms, lines, stockService);
  }

  /**
   * Walk every BOM line for the production order's BOM and deduct
   * `effectiveQtyPerUnit() * qty` from `available` at `locationId`. Each
   * deduction goes through {@link StockService.adjust} with `sourceType:
   * 'ProductionOrder'` and `sourceId: order.id`. Returns the list of
   * movements emitted so callers can log / surface them.
   *
   * **Atomic across lines**: all per-line deductions and their audit
   * movements run inside a single `stockService.withTransaction(...)`
   * scope. An `InsufficientStockError` on line N+1 rolls back lines 1..N
   * so production-order posting never leaves materials half-consumed.
   * Pre-flight with {@link BomService.canProduce} when you'd rather know
   * upfront than discover the shortfall mid-run.
   *
   * Throws {@link NoActiveBomForProductError} if no BOM id is supplied
   * on the order *and* no active BOM exists for the order's `productId`.
   * Throws {@link BomNotFoundError} if `order.bomId` is supplied but
   * doesn't resolve. Throws plain `Error` on missing `locationId` or
   * non-positive `qty`. Re-throws `InsufficientStockError` from
   * `StockService.adjust` if a line would drive `available` below zero.
   */
  async consumeMaterials(
    order: ProductionOrderRef,
    options: ConsumeMaterialsOptions,
  ): Promise<ConsumeResult[]> {
    const ctx = await this.prepareConsume(order, options);
    return this.stockService.withTransaction(async (tx) =>
      this.consumeMaterialsWith(tx, ctx),
    );
  }

  /**
   * Receive `qty` of the finished SKU into `available` at `locationId`.
   * Goes through {@link StockService.receive} with `sourceType:
   * 'ProductionOrder'` and `sourceId: order.id`. Returns a single
   * {@link ProduceResult} describing what landed.
   *
   * Throws plain `Error` on missing required arguments or non-positive
   * `qty`.
   */
  async produceFinishedGoods(
    order: ProductionOrderRef,
    options: ProduceFinishedGoodsOptions,
  ): Promise<ProduceResult> {
    const ctx = prepareProduce(order, options);
    return this.stockService.withTransaction(async (tx) =>
      this.produceFinishedGoodsWith(tx, ctx),
    );
  }

  /**
   * Atomically consume materials AND receive finished goods for one
   * production run.
   *
   * Both calls share a single `stockService.withTransaction(...)` scope:
   *
   * - Materials are deducted line-by-line via {@link StockService.adjust}.
   * - Finished goods are received via {@link StockService.receive}.
   * - If ANY step throws — a BOM-line shortage, the produce-leg adapter
   *   failing, a tenancy mismatch surfaced by an interceptor — every
   *   write in the transaction rolls back. The materials are restored
   *   and the finished SKU's `available` row is unchanged. Callers
   *   never observe "materials deducted but finished goods missing".
   *
   * Use this when consume + produce should be one indivisible event —
   * e.g. a make-to-stock workflow posting `production_order:completed`
   * where the shop floor step is invisible to the ledger.
   *
   * The two-call form (call {@link consumeMaterials} then {@link
   * produceFinishedGoods} separately) is still appropriate when the
   * factory step is a real wall-clock gap that other observers need to
   * see — work-in-progress dashboards, partial-run reporting, etc.
   *
   * Throws the same errors as the individual methods: missing args
   * (plain `Error`), unresolvable BOM ({@link BomNotFoundError} /
   * {@link NoActiveBomForProductError}), or `InsufficientStockError`
   * if a line would drive `available` below zero.
   */
  async runProduction(
    order: ProductionOrderRef,
    options: {
      consume: ConsumeMaterialsOptions;
      produce: ProduceFinishedGoodsOptions;
    },
  ): Promise<RunProductionResult> {
    const consumeCtx = await this.prepareConsume(order, options.consume);
    const produceCtx = prepareProduce(order, options.produce);
    return this.stockService.withTransaction(async (tx) => {
      const consumed = await this.consumeMaterialsWith(tx, consumeCtx);
      const produced = await this.produceFinishedGoodsWith(tx, produceCtx);
      return { consumed, produced };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validate consume args, resolve the BOM + lines, and pre-compute the
   * mutation attribution. Anything that can throw without a tx open
   * happens here so the transaction we open later doesn't have to roll
   * back over a validation miss.
   */
  private async prepareConsume(
    order: ProductionOrderRef,
    options: ConsumeMaterialsOptions,
  ): Promise<ConsumeContext> {
    assertLocationId(options.locationId, 'consumeMaterials');
    assertPositiveQty(options.qty, 'consumeMaterials');
    const orderId = order.id ?? '';
    if (!orderId) {
      throw new Error(
        'consumeMaterials: order.id is required for source attribution',
      );
    }
    const bom = await this.resolveBom(order);
    const lines = await this.lines.findByBom(bom.id!);
    return {
      orderId,
      lines,
      runQty: options.qty,
      locationId: options.locationId,
      mutationOptions: {
        sourceType: 'ProductionOrder',
        sourceId: orderId,
        reasonCode: options.reasonCode ?? 'production_consume',
        note: options.note,
      },
    };
  }

  /**
   * Execute the consume leg against a caller-supplied tx-bound
   * {@link StockService}. Public entry points (`consumeMaterials`,
   * `runProduction`) open the tx and call through here. Each per-line
   * `tx.adjust(...)` shares the same transaction so a shortfall on
   * line N+1 rolls back lines 1..N.
   */
  private async consumeMaterialsWith(
    tx: StockService,
    ctx: ConsumeContext,
  ): Promise<ConsumeResult[]> {
    const emitted: ConsumeResult[] = [];
    for (const line of ctx.lines) {
      const qty = line.effectiveQtyPerUnit() * ctx.runQty;
      if (qty <= 0) continue;
      await tx.adjust(
        line.componentSkuId,
        ctx.locationId,
        -qty,
        ctx.mutationOptions,
      );
      emitted.push({
        componentSkuId: line.componentSkuId,
        qty,
        locationId: ctx.locationId,
      });
    }
    return emitted;
  }

  /**
   * Execute the produce leg against a caller-supplied tx-bound
   * {@link StockService}. Public entry points (`produceFinishedGoods`,
   * `runProduction`) open the tx and call through here.
   */
  private async produceFinishedGoodsWith(
    tx: StockService,
    ctx: ProduceContext,
  ): Promise<ProduceResult> {
    await tx.receive(
      ctx.finishedSkuId,
      ctx.locationId,
      ctx.qty,
      ctx.mutationOptions,
    );
    return {
      finishedSkuId: ctx.finishedSkuId,
      qty: ctx.qty,
      locationId: ctx.locationId,
    };
  }

  /**
   * Resolve the BOM for a production order. Order of preference:
   *
   * 1. Explicit `order.bomId` if supplied — the caller pinned a specific
   *    revision; we honor that pin or fail. We deliberately do NOT fall
   *    back to the active BOM when `order.bomId` is stale or mistyped,
   *    because silently switching recipes would have the production run
   *    consume materials against a different BOM than the order locked.
   * 2. The active BOM for `order.productId`.
   *
   * Throws {@link BomNotFoundError} when an explicit `order.bomId` is
   * supplied but doesn't resolve to a row.
   *
   * Throws {@link NoActiveBomForProductError} when no `bomId` was supplied
   * and the product has no active BOM (or `productId` is empty).
   */
  private async resolveBom(
    order: ProductionOrderRef,
  ): Promise<BillOfMaterials> {
    if (order.bomId) {
      const bom = await this.boms.get(order.bomId);
      if (!bom) throw new BomNotFoundError(order.bomId);
      return bom;
    }
    const productId = order.productId ?? '';
    if (!productId) {
      throw new NoActiveBomForProductError(productId);
    }
    const active = await this.boms.findActiveForProduct(productId);
    if (!active) throw new NoActiveBomForProductError(productId);
    return active;
  }
}

/**
 * Pre-computed consume work that an open transaction can apply without
 * any further validation. Built by {@link ProductionService.prepareConsume}.
 */
interface ConsumeContext {
  orderId: string;
  lines: BomLine[];
  runQty: number;
  locationId: string;
  mutationOptions: StockMutationOptions;
}

/**
 * Pre-computed produce work that an open transaction can apply without
 * any further validation. Built by {@link prepareProduce}.
 */
interface ProduceContext {
  orderId: string;
  finishedSkuId: string;
  qty: number;
  locationId: string;
  mutationOptions: StockMutationOptions;
}

/**
 * Validate produce args and pre-compute the mutation attribution.
 * Mirrors {@link ProductionService.prepareConsume}; it's a free function
 * because the produce leg doesn't need access to any collection state.
 */
function prepareProduce(
  order: ProductionOrderRef,
  options: ProduceFinishedGoodsOptions,
): ProduceContext {
  assertLocationId(options.locationId, 'produceFinishedGoods');
  assertPositiveQty(options.qty, 'produceFinishedGoods');
  if (!options.finishedSkuId) {
    throw new Error(
      'produceFinishedGoods: finishedSkuId is required (the production order references a productId; the caller picks which SKU is being produced)',
    );
  }
  const orderId = order.id ?? '';
  if (!orderId) {
    throw new Error(
      'produceFinishedGoods: order.id is required for source attribution',
    );
  }
  return {
    orderId,
    finishedSkuId: options.finishedSkuId,
    qty: options.qty,
    locationId: options.locationId,
    mutationOptions: {
      sourceType: 'ProductionOrder',
      sourceId: orderId,
      reasonCode: options.reasonCode ?? 'production_produce',
      note: options.note,
    },
  };
}

function assertPositiveQty(qty: number, op: string): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${op}: qty must be a positive finite number (got ${qty})`);
  }
}

function assertLocationId(locationId: string, op: string): void {
  if (!locationId || typeof locationId !== 'string') {
    throw new Error(`${op}: locationId is required`);
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
  options: ProductionServiceOptions,
): Promise<StockService> {
  if (!options.db) {
    throw new Error(
      'ProductionService.create: either `db` or `stockService` is required',
    );
  }
  return createStockService({ db: options.db });
}

/**
 * Convenience factory. Returns a fully-initialized {@link ProductionService}.
 */
export async function createProductionService(
  options: ProductionServiceOptions,
): Promise<ProductionService> {
  return ProductionService.create(options);
}

// Re-export the BomLine type so callers don't have to reach into the
// models barrel just to type service results.
export type { BomLine };
