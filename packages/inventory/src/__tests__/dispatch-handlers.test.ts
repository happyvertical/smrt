/**
 * dispatch-handlers — opt-in DispatchBus subscribers.
 *
 * Verifies that calling installInventoryDispatchHandlers wires up the
 * documented signals so a `contract:created` emit reserves stock and a
 * `fulfillment:shipped` emit removes it. dispose() should detach both
 * subscribers so a second emit after dispose() is a no-op.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchBus, type DispatchBus } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InventoryLocationCollection } from '../collections/index.js';
import { StockLevelCollection } from '../collections/StockLevelCollection.js';
import { StockMovementCollection } from '../collections/StockMovementCollection.js';
import { installInventoryDispatchHandlers } from '../services/dispatch-handlers.js';
import { createStockService } from '../services/StockService.js';

describe('installInventoryDispatchHandlers', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let bus: DispatchBus;
  let locations: InventoryLocationCollection;
  let levels: StockLevelCollection;
  let movements: StockMovementCollection;
  let skuId: string;
  let warehouseId: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-inventory-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    bus = await createDispatchBus({ db });

    locations = await InventoryLocationCollection.create({ db });
    levels = await StockLevelCollection.create({ db });
    movements = await StockMovementCollection.create({ db });

    // skuId is a plain string ref — inventory's stock-motion logic
    // never reads from the Sku table.
    skuId = randomUUID();

    const wh = await locations.create({
      code: 'WH-AUTO',
      kind: 'warehouse',
    });
    await wh.save();
    warehouseId = wh.id!;
  });

  afterEach(async () => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  it('reserves stock on contract:created and fulfils on fulfillment:shipped', async () => {
    const service = await createStockService({ db });
    await service.receive(skuId, warehouseId, 10);

    const handlers = await installInventoryDispatchHandlers({
      dispatchBus: bus,
      stockService: service,
    });

    await bus.emit(
      'contract:created',
      {
        contractId: 'C-1',
        lines: [{ skuId, locationId: warehouseId, qty: 3 }],
      },
      { source: 'commerce' },
    );

    // In-memory handlers are fire-and-forget — emit() returns once the
    // dispatch row is persisted but the in-memory subscriber's async
    // work continues in the background. Yield the event loop until the
    // expected effect has landed (or the timeout trips).
    await waitFor(async () => {
      const allocated = await levels.getLevel(skuId, warehouseId, 'allocated');
      return allocated !== null && Number(allocated.qty) === 3;
    });

    const allocated = await levels.getLevel(skuId, warehouseId, 'allocated');
    expect(Number(allocated?.qty)).toBe(3);
    const reservationMovements = await movements.findByReason('reservation');
    expect(reservationMovements).toHaveLength(1);
    expect(reservationMovements[0].sourceType).toBe('Contract');
    expect(reservationMovements[0].sourceId).toBe('C-1');
    expect(reservationMovements[0].note).toContain('commerce');

    await bus.emit(
      'fulfillment:shipped',
      {
        fulfillmentId: 'F-1',
        lines: [{ skuId, locationId: warehouseId, qty: 3 }],
      },
      { source: 'commerce' },
    );
    await waitFor(async () => {
      const row = await levels.getLevel(skuId, warehouseId, 'allocated');
      return row !== null && Number(row.qty) === 0;
    });

    const allocatedAfter = await levels.getLevel(
      skuId,
      warehouseId,
      'allocated',
    );
    expect(Number(allocatedAfter?.qty)).toBe(0);
    const fulfilmentMovements = await movements.findByReason('fulfillment');
    expect(fulfilmentMovements).toHaveLength(1);
    expect(fulfilmentMovements[0].sourceType).toBe('Fulfillment');
    expect(fulfilmentMovements[0].sourceId).toBe('F-1');

    handlers.dispose();

    // After dispose the bus should not invoke the subscribers; emitting
    // again must not create any further movement rows.
    await bus.emit(
      'contract:created',
      {
        contractId: 'C-2',
        lines: [{ skuId, locationId: warehouseId, qty: 1 }],
      },
      { source: 'commerce' },
    );
    // Give the (non-)handler a chance to run; if it were still wired,
    // a second reservation would land within a few ticks.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reservationsAfterDispose =
      await movements.findByReason('reservation');
    expect(reservationsAfterDispose).toHaveLength(1);
  });

  it('rolls back earlier lines when a later line throws (contract:created)', async () => {
    // One sku with 5 units; the contract asks for 3 on line A (would
    // succeed in isolation) and 10 on line B (overdraws). Without the
    // tx wrapper the dispatch handler would commit line A's reservation
    // and then throw on line B, leaving the contract partially
    // reserved. With the wrapper, neither line lands.
    const service = await createStockService({ db });
    await service.receive(skuId, warehouseId, 5);

    const handlers = await installInventoryDispatchHandlers({
      dispatchBus: bus,
      stockService: service,
    });

    // DispatchBus swallows in-memory handler errors and routes them to
    // `console.error` (see `bus.ts` ~line 612). Intercept that log so we
    // can synchronize on "the handler finished and failed" without
    // depending on internal bus state.
    const consoleErrors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };

    try {
      await bus.emit(
        'contract:created',
        {
          contractId: 'C-ATOMIC',
          lines: [
            { skuId, locationId: warehouseId, qty: 3 },
            { skuId, locationId: warehouseId, qty: 10 },
          ],
        },
        { source: 'commerce' },
      );
      // Wait for the handler's rejection to reach console.error.
      await waitFor(async () => consoleErrors.length > 0, 1_000);
    } finally {
      console.error = originalConsoleError;
      handlers.dispose();
    }

    expect(consoleErrors.length).toBeGreaterThan(0);
    // No reservations should have landed — the whole emit rolled back.
    const reservations = await movements.findByReason('reservation');
    expect(reservations).toHaveLength(0);
    const available = await levels.getLevel(skuId, warehouseId, 'available');
    expect(Number(available?.qty ?? 0)).toBe(5);
    const allocated = await levels.getLevel(skuId, warehouseId, 'allocated');
    expect(Number(allocated?.qty ?? 0)).toBe(0);
  });

  it('rejects contract:created with malformed lines (null entry / wrong types)', async () => {
    // Regression for the round-10 finding: a `lines` array with a null
    // entry (e.g. from a serialized sparse array) would previously be
    // skipped with a `continue`, leaving the contract partially
    // reserved while looking successful to the caller. The fail-fast
    // validation rejects the whole event so the audit trail stays
    // honest and producers get observability.
    const service = await createStockService({ db });
    await service.receive(skuId, warehouseId, 10);
    await installInventoryDispatchHandlers({
      dispatchBus: bus,
      stockService: service,
    });

    const consoleWarns: unknown[] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      consoleWarns.push(args);
    };

    try {
      // Two well-formed lines bracketing a null entry. The handler
      // must drop the WHOLE event (including the well-formed lines)
      // rather than partially reserve.
      await bus.emit(
        'contract:created',
        {
          contractId: 'C-MALFORMED',
          lines: [
            { skuId, locationId: warehouseId, qty: 1 },
            null,
            { skuId, locationId: warehouseId, qty: 2 },
          ],
        },
        { source: 'commerce' },
      );
      await waitFor(async () => consoleWarns.length > 0, 1_000);
    } finally {
      console.warn = originalConsoleWarn;
    }

    expect(consoleWarns.length).toBeGreaterThan(0);
    // No reservations should have landed — neither the bracketing
    // well-formed lines nor the null one.
    const reservations = await movements.findByReason('reservation');
    expect(reservations).toHaveLength(0);
  });

  it('rejects contract:created payloads missing contractId (no audit attribution)', async () => {
    // Regression for the round-7 finding: a payload that has a valid
    // `lines` array but missing `contractId` would previously reserve
    // stock with an empty sourceId, breaking the audit trail. The
    // handler should refuse to mutate state and log instead.
    const service = await createStockService({ db });
    await service.receive(skuId, warehouseId, 10);
    await installInventoryDispatchHandlers({
      dispatchBus: bus,
      stockService: service,
    });

    const consoleWarns: unknown[] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      consoleWarns.push(args);
    };

    try {
      await bus.emit(
        'contract:created',
        {
          // contractId missing
          lines: [{ skuId, locationId: warehouseId, qty: 1 }],
        },
        { source: 'commerce' },
      );
      await waitFor(async () => consoleWarns.length > 0, 1_000);
    } finally {
      console.warn = originalConsoleWarn;
    }

    expect(consoleWarns.length).toBeGreaterThan(0);
    // No reservations should have landed.
    const reservations = await movements.findByReason('reservation');
    expect(reservations).toHaveLength(0);
  });

  it('does not subscribe when callers opt the handlers out', async () => {
    const service = await createStockService({ db });
    await installInventoryDispatchHandlers({
      dispatchBus: bus,
      stockService: service,
      installContractReserved: false,
      installFulfillmentShipped: false,
    });

    await bus.emit(
      'contract:created',
      {
        contractId: 'C-3',
        lines: [{ skuId, locationId: warehouseId, qty: 1 }],
      },
      { source: 'commerce' },
    );
    // Give the (absent) handler time to run if it were wired.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reservations = await movements.findByReason('reservation');
    expect(reservations).toHaveLength(0);
  });
});

/**
 * Spin until `predicate()` returns true or the timeout elapses. Used to
 * synchronize on fire-and-forget DispatchBus handlers without baking in
 * an arbitrary `sleep` that would slow every successful run.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitFor: predicate did not become true within ${timeoutMs}ms`,
  );
}
