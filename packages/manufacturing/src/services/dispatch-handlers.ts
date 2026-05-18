/**
 * Opt-in DispatchBus subscribers that bridge upstream production-order
 * signals to {@link ProductionService}.
 *
 * **Off by default.** The package never auto-subscribes — consumer apps
 * call {@link installManufacturingDispatchHandlers} from their `smrt.ts`
 * wiring once they have decided they want a `production_order:posted`
 * emit to consume materials and produce finished goods automatically.
 *
 * Two paired toggles let consumers wire only the legs they want:
 *
 * - `installProductionPosted` (default `true`) — on `production_order:posted`,
 *   call {@link ProductionService.consumeMaterials} once.
 * - `installProductionCompleted` (default `false`) — on `production_order:completed`,
 *   call {@link ProductionService.produceFinishedGoods} once. Off by default
 *   because not every shop emits a separate "completed" event; lots of
 *   workflows expect consume + produce to happen atomically when the
 *   order is posted. Set both flags to `true` to get the split lifecycle.
 *
 * @packageDocumentation
 */

import type {
  DispatchBus,
  DispatchHandler,
  DispatchMetadata,
} from '@happyvertical/smrt-core';
import type { StockService } from '@happyvertical/smrt-inventory';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  createProductionService,
  type ProductionService,
} from './ProductionService.js';

/**
 * Shape of a `production_order:posted` payload this handler expects.
 *
 * The producer (typically the application's smrt.ts wiring once a
 * `ProductionOrder` row transitions to the posted state) packs one
 * payload per posted order. The handler consumes materials for every
 * unit declared by `qty`, attributed to `('ProductionOrder', productionOrderId)`
 * on each emitted {@link StockMovement}.
 */
export interface ProductionOrderPostedPayload {
  /** Production order row id. Used for `sourceId` on every movement. */
  productionOrderId: string;
  /**
   * Plain string reference to the upstream product the order is asked to
   * produce. Used to resolve the active BOM at consume time.
   */
  productId: string;
  /**
   * Inventory location id (factory / warehouse) where materials are
   * pulled from.
   */
  locationId: string;
  /**
   * Run quantity. Each BOM line's effective qty is multiplied by this
   * before being deducted from `available`.
   */
  qty: number;
  /**
   * Optional explicit BOM id, e.g. when the order locked itself to a
   * specific BOM revision when it was created. Falls back to the active
   * BOM for `productId` if omitted.
   */
  bomId?: string;
  /**
   * Optional finished SKU id. When provided AND the
   * `installProductionPosted` handler is wired to also produce in one
   * shot (which only happens when `installProductionCompleted` is false
   * and `producedOnPosted` is true), this is the SKU to receive into
   * `available`.
   */
  finishedSkuId?: string;
}

/**
 * Shape of a `production_order:completed` payload this handler expects.
 *
 * Typically emitted when the factory signs off the run and finished
 * goods are physically available to ship. Only used when callers opt in
 * via `installProductionCompleted`.
 */
export interface ProductionOrderCompletedPayload {
  /** Production order row id. Used for `sourceId` on the receipt movement. */
  productionOrderId: string;
  /**
   * SKU id of the finished product to receive into `available`. Required.
   */
  finishedSkuId: string;
  /** Inventory location id where the finished goods land. */
  locationId: string;
  /** Quantity received. */
  qty: number;
}

/**
 * Options accepted by {@link installManufacturingDispatchHandlers}.
 *
 * Provide either a pre-built {@link ProductionService} (when sharing
 * across subsystems) or a `db` / `stockService` for the helper to
 * construct one on first use.
 */
export type InstallManufacturingDispatchHandlersOptions = {
  /** Bus to subscribe on. Typically the app-wide DispatchBus. */
  dispatchBus: DispatchBus;
  /**
   * When `true` (default), install the `production_order:posted` handler.
   */
  installProductionPosted?: boolean;
  /**
   * When `true` (default `false`), install the
   * `production_order:completed` handler. Off by default because many
   * workflows want consume+produce to happen on `posted`; opt in to the
   * split lifecycle when your shop emits a separate completion event.
   */
  installProductionCompleted?: boolean;
  /**
   * When `true` (default `false`) AND `installProductionCompleted` is
   * false, the `production_order:posted` handler also calls
   * {@link ProductionService.produceFinishedGoods} after consume —
   * handy for "make-to-stock instantly" workflows where the factory
   * step is invisible.
   *
   * Ignored when `installProductionCompleted` is `true` (in that case
   * production is the completed-handler's job).
   */
  producedOnPosted?: boolean;
} & (
  | {
      productionService: ProductionService;
      db?: DatabaseInterface;
      stockService?: StockService;
    }
  | {
      stockService: StockService;
      db?: DatabaseInterface;
      productionService?: undefined;
    }
  | {
      db: DatabaseInterface;
      stockService?: undefined;
      productionService?: undefined;
    }
);

/**
 * Result handle returned by {@link installManufacturingDispatchHandlers}.
 * Call `dispose()` to detach the subscribers (mainly useful in tests and
 * on graceful shutdown).
 */
export interface InstalledManufacturingDispatchHandlers {
  /** Resolved ProductionService — useful for follow-up writes in the same scope. */
  productionService: ProductionService;
  /** Detach every installed subscriber. Idempotent. */
  dispose(): void;
}

/**
 * Subscribe production-order handlers to the given DispatchBus.
 *
 * @example
 * ```typescript
 * import { createDispatchBus } from '@happyvertical/smrt-core';
 * import { installManufacturingDispatchHandlers } from '@happyvertical/smrt-manufacturing';
 *
 * const bus = await createDispatchBus({ db });
 * const handlers = await installManufacturingDispatchHandlers({
 *   dispatchBus: bus,
 *   db,
 *   producedOnPosted: true, // consume + produce in one shot
 * });
 * ```
 */
export async function installManufacturingDispatchHandlers(
  options: InstallManufacturingDispatchHandlersOptions,
): Promise<InstalledManufacturingDispatchHandlers> {
  const {
    dispatchBus,
    installProductionPosted = true,
    installProductionCompleted = false,
    producedOnPosted = false,
  } = options;

  const productionService =
    options.productionService ??
    (await createProductionService(
      options.stockService
        ? { stockService: options.stockService }
        : { db: options.db as DatabaseInterface },
    ));

  const installed: Array<{ pattern: string; handler: DispatchHandler }> = [];

  if (installProductionPosted) {
    const shouldProduceOnPosted =
      producedOnPosted && !installProductionCompleted;
    const handler: DispatchHandler = async (payload, metadata) => {
      await handleProductionPosted(
        productionService,
        payload as ProductionOrderPostedPayload,
        metadata,
        shouldProduceOnPosted,
      );
    };
    dispatchBus.on('production_order:posted', handler);
    installed.push({ pattern: 'production_order:posted', handler });
  }

  if (installProductionCompleted) {
    const handler: DispatchHandler = async (payload, metadata) => {
      await handleProductionCompleted(
        productionService,
        payload as ProductionOrderCompletedPayload,
        metadata,
      );
    };
    dispatchBus.on('production_order:completed', handler);
    installed.push({ pattern: 'production_order:completed', handler });
  }

  return {
    productionService,
    dispose() {
      for (const entry of installed) {
        dispatchBus.off(entry.pattern, entry.handler);
      }
      installed.length = 0;
    },
  };
}

async function handleProductionPosted(
  productionService: ProductionService,
  payload: ProductionOrderPostedPayload | null | undefined,
  metadata: DispatchMetadata,
  shouldProduce: boolean,
): Promise<void> {
  if (!payload || !payload.productionOrderId) return;
  const note = metadata.source
    ? `auto-consume via ${metadata.source}`
    : undefined;

  await productionService.consumeMaterials(
    {
      id: payload.productionOrderId,
      productId: payload.productId,
      bomId: payload.bomId,
    },
    {
      locationId: payload.locationId,
      qty: payload.qty,
      note,
    },
  );

  if (shouldProduce && payload.finishedSkuId) {
    await productionService.produceFinishedGoods(
      { id: payload.productionOrderId, productId: payload.productId },
      {
        locationId: payload.locationId,
        qty: payload.qty,
        finishedSkuId: payload.finishedSkuId,
        note: metadata.source
          ? `auto-produce via ${metadata.source}`
          : undefined,
      },
    );
  }
}

async function handleProductionCompleted(
  productionService: ProductionService,
  payload: ProductionOrderCompletedPayload | null | undefined,
  metadata: DispatchMetadata,
): Promise<void> {
  if (!payload || !payload.productionOrderId) return;
  await productionService.produceFinishedGoods(
    { id: payload.productionOrderId },
    {
      locationId: payload.locationId,
      qty: payload.qty,
      finishedSkuId: payload.finishedSkuId,
      note: metadata.source ? `auto-produce via ${metadata.source}` : undefined,
    },
  );
}
