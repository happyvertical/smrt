/**
 * ProductionService — the operational bridge from a production order to
 * actual stock-mutating consume/produce events.
 *
 * Production orders themselves live in `@happyvertical/smrt-commerce` as a
 * `Contract` STI subtype. This service does NOT modify those rows; it
 * simply reads the order's `productId`, looks up the active BOM, and
 * writes the right stock movements through {@link StockService}.
 *
 * Two methods:
 *
 * - {@link consumeMaterials} — for each BOM line, deduct
 *   `qtyPerUnit * (1 + wastePercent / 100) * runQty` from `available` at
 *   the production location. Stamps every movement with
 *   `sourceType: 'ProductionOrder'` + the production order id so audit
 *   queries can roll them up later.
 * - {@link produceFinishedGoods} — receive `runQty` of the finished
 *   product's SKU into `available` at the production location. The caller
 *   supplies the SKU id (the production order references a *product*, not
 *   a *SKU*; in practice the production-order-level "what we are making"
 *   gets resolved to a specific SKU per variant on the line items).
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
import { NoActiveBomForProductError } from '../types.js';

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
 * Operational bridge between a production order and the inventory ledger.
 */
export class ProductionService {
  private constructor(
    public readonly boms: BillOfMaterialsCollection,
    public readonly lines: BomLineCollection,
    public readonly stockService: StockService,
  ) {}

  /** Factory — prefer {@link createProductionService}. */
  static async create(
    options: ProductionServiceOptions,
  ): Promise<ProductionService> {
    const stockService =
      options.stockService ??
      (await createStockService({ db: options.db as DatabaseConfig }));
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
   * Throws {@link NoActiveBomForProductError} if no BOM id is supplied on
   * the order *and* no active BOM exists for the order's `productId`.
   * Throws plain `Error` on missing `locationId` or non-positive `qty`.
   * Re-throws `InsufficientStockError` from `StockService.adjust` if a
   * line would drive `available` below zero — the caller is expected to
   * either pre-flight with {@link BomService.canProduce} or handle the
   * partial-failure case explicitly.
   */
  async consumeMaterials(
    order: ProductionOrderRef,
    options: ConsumeMaterialsOptions,
  ): Promise<ConsumeResult[]> {
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
    const mutationOptions: StockMutationOptions = {
      sourceType: 'ProductionOrder',
      sourceId: orderId,
      reasonCode: options.reasonCode ?? 'production_consume',
      note: options.note,
    };

    const emitted: ConsumeResult[] = [];
    for (const line of lines) {
      const qty = line.effectiveQtyPerUnit() * options.qty;
      if (qty <= 0) continue;
      await this.stockService.adjust(
        line.componentSkuId,
        options.locationId,
        -qty,
        mutationOptions,
      );
      emitted.push({
        componentSkuId: line.componentSkuId,
        qty,
        locationId: options.locationId,
      });
    }
    return emitted;
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

    await this.stockService.receive(
      options.finishedSkuId,
      options.locationId,
      options.qty,
      {
        sourceType: 'ProductionOrder',
        sourceId: orderId,
        reasonCode: options.reasonCode ?? 'production_produce',
        note: options.note,
      },
    );

    return {
      finishedSkuId: options.finishedSkuId,
      qty: options.qty,
      locationId: options.locationId,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the BOM for a production order. Order of preference:
   *
   * 1. Explicit `order.bomId` if supplied.
   * 2. The active BOM for `order.productId`.
   *
   * Throws {@link NoActiveBomForProductError} when neither is available.
   */
  private async resolveBom(
    order: ProductionOrderRef,
  ): Promise<BillOfMaterials> {
    if (order.bomId) {
      const bom = await this.boms.get(order.bomId);
      if (bom) return bom;
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
