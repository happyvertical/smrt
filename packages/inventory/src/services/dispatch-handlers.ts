/**
 * Opt-in DispatchBus subscribers that bridge upstream packages to the
 * {@link StockService}.
 *
 * **Off by default.** The package never auto-subscribes — consumer apps
 * call {@link installInventoryDispatchHandlers} from their `smrt.ts`
 * wiring once they have decided they want automatic stock motion when
 * contracts are created and fulfilments ship.
 *
 * The production-order leg (`production_order:posted` → consume
 * materials + produce SKUs) is deliberately *not* installed here; that
 * subscriber lives in `@happyvertical/smrt-manufacturing` (see issue
 * #1250) and depends on the BOM model that ships alongside it.
 *
 * @packageDocumentation
 */

import type {
  DatabaseConfig,
  DispatchBus,
  DispatchHandler,
  DispatchMetadata,
} from '@happyvertical/smrt-core';
import type { StockMutationOptions } from './StockService.js';
import { createStockService, type StockService } from './StockService.js';

/**
 * Shape of a single reserved line in a `contract:created` payload. The
 * producer (typically `@happyvertical/smrt-commerce`) packs one entry
 * per line that needs stock motion; everything else (taxes, fees,
 * non-physical items) should be filtered upstream.
 */
export interface ContractCreatedLine {
  skuId: string;
  locationId: string;
  qty: number;
}

/**
 * Shape of the `contract:created` payload this handler expects. Carries
 * the contract id (used for source attribution on the audit row) and
 * the list of line items to reserve.
 */
export interface ContractCreatedPayload {
  contractId: string;
  lines: ContractCreatedLine[];
}

/**
 * Shape of a single shipped line in a `fulfillment:shipped` payload.
 */
export interface FulfillmentShippedLine {
  skuId: string;
  locationId: string;
  qty: number;
}

/**
 * Shape of the `fulfillment:shipped` payload this handler expects.
 * Producers emit one per shipped fulfilment; the handler fulfils each
 * line against the level created by the matching `contract:created`
 * reservation.
 */
export interface FulfillmentShippedPayload {
  fulfillmentId: string;
  lines: FulfillmentShippedLine[];
}

/**
 * Options accepted by {@link installInventoryDispatchHandlers}.
 *
 * Provide either a pre-built {@link StockService} (when sharing one
 * across multiple subsystems) or a `db` for the helper to construct one
 * on first use.
 */
export type InstallInventoryDispatchHandlersOptions = {
  /**
   * Bus to subscribe on. Typically the app-wide `DispatchBus` created in
   * the application's `smrt.ts`.
   */
  dispatchBus: DispatchBus;
  /**
   * When `true` (default), install the `contract:created` handler.
   * Producers should publish a {@link ContractCreatedPayload}.
   */
  installContractReserved?: boolean;
  /**
   * When `true` (default), install the `fulfillment:shipped` handler.
   * Producers should publish a {@link FulfillmentShippedPayload}.
   */
  installFulfillmentShipped?: boolean;
} & (
  | { stockService: StockService; db?: DatabaseConfig }
  | { db: DatabaseConfig; stockService?: undefined }
);

/**
 * Result handle returned by {@link installInventoryDispatchHandlers}.
 * Call `dispose()` to detach the subscribers (mainly useful in tests
 * and on graceful shutdown).
 */
export interface InstalledInventoryDispatchHandlers {
  /** Resolved StockService — useful for follow-up writes in the same scope. */
  stockService: StockService;
  /** Detach every installed subscriber. Idempotent. */
  dispose(): void;
}

/**
 * Subscribe a {@link StockService}-driven handler to the relevant signals
 * on the given {@link DispatchBus}. Returns a disposer for tests and
 * shutdown hooks.
 *
 * @example
 * ```typescript
 * import { createDispatchBus } from '@happyvertical/smrt-core';
 * import { installInventoryDispatchHandlers } from '@happyvertical/smrt-inventory';
 *
 * const bus = await createDispatchBus({ db });
 * const handlers = await installInventoryDispatchHandlers({
 *   dispatchBus: bus,
 *   db,
 * });
 * ```
 */
export async function installInventoryDispatchHandlers(
  options: InstallInventoryDispatchHandlersOptions,
): Promise<InstalledInventoryDispatchHandlers> {
  const {
    dispatchBus,
    installContractReserved = true,
    installFulfillmentShipped = true,
  } = options;

  const stockService =
    options.stockService ?? (await buildStockService(options));

  const installed: Array<{ pattern: string; handler: DispatchHandler }> = [];

  if (installContractReserved) {
    const handler: DispatchHandler = async (payload, metadata) => {
      await handleContractCreated(
        stockService,
        payload as ContractCreatedPayload,
        metadata,
      );
    };
    dispatchBus.on('contract:created', handler);
    installed.push({ pattern: 'contract:created', handler });
  }

  if (installFulfillmentShipped) {
    const handler: DispatchHandler = async (payload, metadata) => {
      await handleFulfillmentShipped(
        stockService,
        payload as FulfillmentShippedPayload,
        metadata,
      );
    };
    dispatchBus.on('fulfillment:shipped', handler);
    installed.push({ pattern: 'fulfillment:shipped', handler });
  }

  return {
    stockService,
    dispose() {
      for (const entry of installed) {
        dispatchBus.off(entry.pattern, entry.handler);
      }
      installed.length = 0;
    },
  };
}

async function handleContractCreated(
  stockService: StockService,
  payload: ContractCreatedPayload | null | undefined,
  metadata: DispatchMetadata,
): Promise<void> {
  if (
    !payload ||
    !Array.isArray(payload.lines) ||
    !payload.contractId ||
    typeof payload.contractId !== 'string'
  ) {
    // Silent return would hide upstream contract drift — producers
    // emitting the wrong shape never get feedback. Source id is
    // required: without it the resulting StockMovements carry empty
    // `sourceId`, breaking the audit trail back to the originating
    // contract. Reject up front rather than emit unattributable
    // mutations.
    warnMalformedPayload('contract:created', payload, metadata);
    return;
  }
  // Validate every line BEFORE opening a transaction. A silent skip on
  // a null/undefined / shape-broken entry would look like a successful
  // commit while only reserving part of the contract — defeating the
  // "atomic across lines" guarantee just below. Fail the whole event
  // instead so producers get feedback and downstream observers see no
  // partial state.
  if (!areLinesWellFormed(payload.lines)) {
    warnMalformedPayload('contract:created', payload, metadata);
    return;
  }
  const baseOptions: StockMutationOptions = {
    sourceType: 'Contract',
    sourceId: payload.contractId,
    note: metadata.source ? `auto-reserve via ${metadata.source}` : undefined,
  };
  // Atomic across lines: a shortfall on line N rolls back lines 1..N-1.
  // Without this wrapper, an `InsufficientStockError` mid-loop would leave
  // a partially-reserved contract, and `DispatchBus` would only log the
  // async handler error — no compensating release would ever fire.
  await stockService.withTransaction(async (tx) => {
    for (const line of payload.lines) {
      await tx.reserve(line.skuId, line.locationId, line.qty, baseOptions);
    }
  });
}

async function handleFulfillmentShipped(
  stockService: StockService,
  payload: FulfillmentShippedPayload | null | undefined,
  metadata: DispatchMetadata,
): Promise<void> {
  if (
    !payload ||
    !Array.isArray(payload.lines) ||
    !payload.fulfillmentId ||
    typeof payload.fulfillmentId !== 'string'
  ) {
    // Same rationale as `handleContractCreated`: reject when the
    // source id is missing rather than emit StockMovements with no
    // audit attribution.
    warnMalformedPayload('fulfillment:shipped', payload, metadata);
    return;
  }
  // Validate lines up front for the same reason as
  // `handleContractCreated`: a silent skip would partially fulfill the
  // shipment while looking successful.
  if (!areLinesWellFormed(payload.lines)) {
    warnMalformedPayload('fulfillment:shipped', payload, metadata);
    return;
  }
  const baseOptions: StockMutationOptions = {
    sourceType: 'Fulfillment',
    sourceId: payload.fulfillmentId,
    note: metadata.source ? `auto-fulfill via ${metadata.source}` : undefined,
  };
  // Atomic across lines: a shortfall on line N rolls back lines 1..N-1.
  // Same rationale as `handleContractCreated` above — without the tx
  // wrapper, a failing fulfilment leg would leave the audit ledger
  // inconsistent and no compensating reservation-restore would ever fire.
  await stockService.withTransaction(async (tx) => {
    for (const line of payload.lines) {
      await tx.fulfill(line.skuId, line.locationId, line.qty, baseOptions);
    }
  });
}

/**
 * Validate that every entry in a dispatch `lines` array is a usable
 * line shape. Returns `false` as soon as it sees a null/undefined entry
 * (e.g. a serialized sparse array hole), a missing/non-string
 * `skuId` / `locationId`, or a non-finite `qty`. Used by both contract
 * and fulfilment handlers to fail-fast before opening a transaction —
 * a silent `continue` over a bad entry would partially mutate state
 * while making the malformed event look successful.
 */
function areLinesWellFormed(
  lines: ReadonlyArray<
    ContractCreatedLine | FulfillmentShippedLine | null | undefined
  >,
): boolean {
  for (const line of lines) {
    if (!line) return false;
    if (typeof line.skuId !== 'string' || !line.skuId) return false;
    if (typeof line.locationId !== 'string' || !line.locationId) return false;
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty))
      return false;
  }
  return true;
}

/**
 * Surface dispatch payloads that don't match the documented shape. The
 * subscribers used to silently return on a missing `lines` array, which
 * hid producer drift — emitters using stale shapes never got feedback
 * and the resulting "stock didn't move" bugs were a long way from the
 * dispatch layer. The warning carries the source attribution so the
 * culprit shows up in logs.
 */
function warnMalformedPayload(
  signal: string,
  payload: unknown,
  metadata: DispatchMetadata,
): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[@happyvertical/smrt-inventory] dispatch handler ignored a ${signal} ` +
      'event with a malformed payload (missing/non-array `lines`). ' +
      `Source: ${metadata.source ?? '<unknown>'}; payload keys: ` +
      `${payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload}`,
  );
}

/**
 * Build a `StockService` when no pre-built one was supplied. The option
 * union guarantees `db` is present in that branch, but TypeScript can't
 * narrow from a `??` value check, so this helper validates at runtime
 * with a clear error message.
 */
async function buildStockService(
  options: InstallInventoryDispatchHandlersOptions,
): Promise<StockService> {
  if (!options.db) {
    throw new Error(
      'installInventoryDispatchHandlers: either `stockService` or `db` is required',
    );
  }
  return createStockService({ db: options.db });
}
