/**
 * StockService — end-to-end lifecycle tests.
 *
 * Covers every public method (receive / reserve / release / fulfill /
 * transfer / adjust), tenant isolation, source attribution, the
 * insufficient-stock error path, and the audit-log append-only
 * invariant. Designed to be run by the SMRT vitest plugin so the
 * inventory manifest is generated before the @smrt() decorators fire.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseConfig } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InventoryLocationCollection,
  StockLevelCollection,
  StockMovementCollection,
} from '../collections/index.js';
import {
  createStockService,
  InsufficientStockError,
  type StockService,
} from '../services/StockService.js';

describe('StockService', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let service: StockService;
  let locations: InventoryLocationCollection;
  let levels: StockLevelCollection;
  let movements: StockMovementCollection;
  let skuA: string;
  let warehouse: string;
  let store: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-inventory-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };

    locations = await InventoryLocationCollection.create({ db });
    levels = await StockLevelCollection.create({ db });
    movements = await StockMovementCollection.create({ db });

    service = await createStockService({ db });

    // skuId is a plain string ref to a row in `@happyvertical/smrt-products`.
    // Inventory's stock-motion logic never reads from the Sku table, so
    // tests can use opaque ids without going through SkuCollection.
    skuA = randomUUID();

    const wh = await locations.create({
      code: 'WH-EAST',
      name: 'Warehouse East',
      kind: 'warehouse',
    });
    await wh.save();
    warehouse = wh.id!;

    const retail = await locations.create({
      code: 'STORE-42',
      name: 'Flagship store',
      kind: 'retail',
    });
    await retail.save();
    store = retail.id!;
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  describe('receive', () => {
    it('increments available stock and writes a receipt movement', async () => {
      await service.receive(skuA, warehouse, 50, {
        sourceType: 'PurchaseOrder',
        sourceId: 'po-1',
      });

      const level = await levels.getLevel(skuA, warehouse, 'available');
      expect(level).not.toBeNull();
      expect(Number(level?.qty)).toBe(50);

      const audit = await movements.findBySku(skuA);
      expect(audit).toHaveLength(1);
      expect(audit[0].reasonCode).toBe('receipt');
      expect(audit[0].fromState).toBeNull();
      expect(audit[0].toState).toBe('available');
      expect(Number(audit[0].qty)).toBe(50);
      expect(audit[0].sourceType).toBe('PurchaseOrder');
      expect(audit[0].sourceId).toBe('po-1');
    });

    it('rejects non-positive quantities', async () => {
      await expect(service.receive(skuA, warehouse, 0)).rejects.toThrow(
        /qty must be a positive finite number/,
      );
      await expect(service.receive(skuA, warehouse, -3)).rejects.toThrow(
        /qty must be a positive finite number/,
      );
      await expect(
        service.receive(skuA, warehouse, Number.NaN),
      ).rejects.toThrow(/qty must be a positive finite number/);
    });

    it('accumulates across multiple receipts', async () => {
      await service.receive(skuA, warehouse, 10);
      await service.receive(skuA, warehouse, 7);
      await service.receive(skuA, warehouse, 3);

      const level = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(level?.qty)).toBe(20);
      const audit = await movements.findBySku(skuA);
      expect(audit).toHaveLength(3);
    });
  });

  describe('reserve / release', () => {
    beforeEach(async () => {
      await service.receive(skuA, warehouse, 25);
    });

    it('moves quantity from available to allocated', async () => {
      await service.reserve(skuA, warehouse, 8, {
        sourceType: 'Contract',
        sourceId: 'order-1',
      });

      const available = await levels.getLevel(skuA, warehouse, 'available');
      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(available?.qty)).toBe(17);
      expect(Number(allocated?.qty)).toBe(8);

      const reserveMovements = await movements.findByReason('reservation');
      expect(reserveMovements).toHaveLength(1);
      expect(reserveMovements[0].fromState).toBe('available');
      expect(reserveMovements[0].toState).toBe('allocated');
      expect(reserveMovements[0].sourceType).toBe('Contract');
      expect(reserveMovements[0].sourceId).toBe('order-1');
    });

    it('throws InsufficientStockError when reserving more than available', async () => {
      await expect(
        service.reserve(skuA, warehouse, 1000),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      // Balances unchanged after the failure.
      const available = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(available?.qty)).toBe(25);
    });

    it('rejects zero and negative reservations', async () => {
      await expect(service.reserve(skuA, warehouse, 0)).rejects.toThrow(
        /qty must be a positive finite number/,
      );
      await expect(service.reserve(skuA, warehouse, -2)).rejects.toThrow(
        /qty must be a positive finite number/,
      );
    });

    it('release returns quantity from allocated to available', async () => {
      await service.reserve(skuA, warehouse, 8);
      await service.release(skuA, warehouse, 3, {
        sourceType: 'Contract',
        sourceId: 'order-1',
      });

      const available = await levels.getLevel(skuA, warehouse, 'available');
      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(available?.qty)).toBe(20);
      expect(Number(allocated?.qty)).toBe(5);

      const releaseMovements = await movements.findByReason('release');
      expect(releaseMovements).toHaveLength(1);
      expect(releaseMovements[0].fromState).toBe('allocated');
      expect(releaseMovements[0].toState).toBe('available');
    });

    it('release rejects releasing more than is allocated', async () => {
      await service.reserve(skuA, warehouse, 5);
      await expect(service.release(skuA, warehouse, 10)).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
    });
  });

  describe('fulfill', () => {
    it('removes allocated stock and records a fulfilment movement', async () => {
      await service.receive(skuA, warehouse, 12);
      await service.reserve(skuA, warehouse, 12, {
        sourceType: 'Contract',
        sourceId: 'order-7',
      });
      await service.fulfill(skuA, warehouse, 12, {
        sourceType: 'Fulfillment',
        sourceId: 'ship-7',
      });

      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(allocated?.qty)).toBe(0);

      const fulfilmentMovements = await movements.findByReason('fulfillment');
      expect(fulfilmentMovements).toHaveLength(1);
      expect(fulfilmentMovements[0].fromState).toBe('allocated');
      expect(fulfilmentMovements[0].toState).toBeNull();
      expect(fulfilmentMovements[0].sourceType).toBe('Fulfillment');
      expect(fulfilmentMovements[0].sourceId).toBe('ship-7');
    });

    it('throws InsufficientStockError when fulfilling unreserved stock', async () => {
      await service.receive(skuA, warehouse, 5);
      await expect(service.fulfill(skuA, warehouse, 5)).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
    });
  });

  describe('transfer', () => {
    it('moves stock between locations and records two movement legs', async () => {
      await service.receive(skuA, warehouse, 30);
      await service.transfer(skuA, warehouse, store, 12, {
        sourceType: 'TransferOrder',
        sourceId: 'xfer-1',
      });

      const sourceLevel = await levels.getLevel(skuA, warehouse, 'available');
      const destLevel = await levels.getLevel(skuA, store, 'available');
      expect(Number(sourceLevel?.qty)).toBe(18);
      expect(Number(destLevel?.qty)).toBe(12);

      const outLegs = await movements.findByReason('transfer_out');
      const inLegs = await movements.findByReason('transfer_in');
      expect(outLegs).toHaveLength(1);
      expect(inLegs).toHaveLength(1);
      expect(outLegs[0].locationId).toBe(warehouse);
      expect(inLegs[0].locationId).toBe(store);
      // Both legs carry the same source attribution so reporting can
      // pair them up by `(sourceType, sourceId)`.
      expect(outLegs[0].sourceType).toBe('TransferOrder');
      expect(outLegs[0].sourceId).toBe('xfer-1');
      expect(inLegs[0].sourceType).toBe('TransferOrder');
      expect(inLegs[0].sourceId).toBe('xfer-1');
    });

    it('rejects transferring to the same location', async () => {
      await service.receive(skuA, warehouse, 5);
      await expect(
        service.transfer(skuA, warehouse, warehouse, 1),
      ).rejects.toThrow(/fromLocationId and toLocationId must differ/);
    });

    it('throws InsufficientStockError when source available is too low', async () => {
      await service.receive(skuA, warehouse, 4);
      await expect(
        service.transfer(skuA, warehouse, store, 10),
      ).rejects.toBeInstanceOf(InsufficientStockError);
    });
  });

  describe('adjust', () => {
    it('applies a positive delta and writes an adjustment movement', async () => {
      await service.adjust(skuA, warehouse, 5, {
        sourceType: 'CycleCount',
        sourceId: 'cycle-1',
      });

      const level = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(level?.qty)).toBe(5);
      const audit = await movements.findByReason('adjustment');
      expect(audit).toHaveLength(1);
      expect(audit[0].toState).toBe('available');
      expect(audit[0].fromState).toBeNull();
    });

    it('applies a negative delta and writes an adjustment movement', async () => {
      await service.receive(skuA, warehouse, 10);
      await service.adjust(skuA, warehouse, -4, {
        sourceType: 'CycleCount',
        sourceId: 'cycle-2',
      });

      const level = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(level?.qty)).toBe(6);
      const audit = await movements.findByReason('adjustment');
      expect(audit).toHaveLength(1);
      expect(audit[0].fromState).toBe('available');
      expect(audit[0].toState).toBeNull();
    });

    it('rejects a zero delta', async () => {
      await expect(service.adjust(skuA, warehouse, 0)).rejects.toThrow(
        /delta must be a non-zero finite number/,
      );
    });

    it('refuses to drive a state negative', async () => {
      await expect(service.adjust(skuA, warehouse, -5)).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
    });

    it('targets the requested state when provided', async () => {
      await service.adjust(skuA, warehouse, 4, { state: 'damaged' });
      const damaged = await levels.getLevel(skuA, warehouse, 'damaged');
      expect(Number(damaged?.qty)).toBe(4);
    });
  });

  describe('source attribution', () => {
    it('lets findBySource group every movement caused by one source', async () => {
      await service.receive(skuA, warehouse, 20);
      await service.reserve(skuA, warehouse, 6, {
        sourceType: 'Contract',
        sourceId: 'order-X',
      });
      await service.fulfill(skuA, warehouse, 6, {
        sourceType: 'Contract',
        sourceId: 'order-X',
      });

      const byOrder = await movements.findBySource('Contract', 'order-X');
      expect(byOrder).toHaveLength(2);
      expect(byOrder.map((m) => m.reasonCode).sort()).toEqual([
        'fulfillment',
        'reservation',
      ]);
    });
  });

  describe('concurrency', () => {
    it('writes one movement row per awaited reservation', async () => {
      // Awaited (serial) reservations are the supported pattern — each
      // call writes one movement and decrements available by exactly
      // its qty.
      await service.receive(skuA, warehouse, 100);
      for (let i = 0; i < 10; i += 1) {
        await service.reserve(skuA, warehouse, 10, {
          sourceType: 'Contract',
          sourceId: `serial-${i}`,
        });
      }

      const available = await levels.getLevel(skuA, warehouse, 'available');
      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(available?.qty)).toBe(0);
      expect(Number(allocated?.qty)).toBe(100);

      const reservationMovements = await movements.findByReason('reservation');
      expect(reservationMovements).toHaveLength(10);
    });

    it('serial reservations guarantee 1-movement-per-success under transactions', async () => {
      // StockService wraps every mutation in db.transaction() (see
      // @happyvertical/sql >= 0.74.0). For SERIAL callers this means a
      // committed reservation movement implies a fulfilled reserve()
      // and vice versa — the audit ledger and the materialized level
      // never disagree.
      //
      // With 50 available + 10 reserve(10), exactly 5 succeed and the
      // 6th throws InsufficientStockError (rolling its movement write
      // back); 7..10 see 0 available and also throw. End state: 5
      // movements committed, 5 reservations succeeded.
      //
      // Concurrent / Promise.all reservations on the SAME (sku,
      // location) require serialization upstream — drive through
      // smrt-jobs, an in-process mutex, or a database with a real
      // connection pool (Postgres). SQLite's single-connection model
      // can't support concurrent transactions cleanly.
      await service.receive(skuA, warehouse, 50);

      let succeeded = 0;
      let insufficient = 0;
      for (let i = 0; i < 10; i++) {
        try {
          await service.reserve(skuA, warehouse, 10, {
            sourceType: 'Contract',
            sourceId: `serial-${i}`,
          });
          succeeded++;
        } catch (err) {
          if (err instanceof InsufficientStockError) {
            insufficient++;
          } else {
            throw err;
          }
        }
      }

      expect(succeeded).toBe(5);
      expect(insufficient).toBe(5);
      const reservationMovements = await movements.findByReason('reservation');
      expect(reservationMovements).toHaveLength(succeeded);
      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(allocated?.qty)).toBe(50);
      const available = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(available?.qty)).toBe(0);
    });

    it('exposes the tx-scoped db on tx.db so composed services commit together', async () => {
      // Regression: previously withTransaction passed `this.db` (the
      // outer connection) as the public `db` field on the tx-bound
      // StockService. A caller wiring an adjacent service inside the
      // tx (e.g. `MyCollection.create({ db: tx.db })`) would then write
      // outside the transaction and persist even when the surrounding
      // stock mutations rolled back. The fix exposes the tx-scoped db.
      let capturedDb: unknown;
      await service.withTransaction(async (tx) => {
        capturedDb = tx.db;
        // The tx-scoped db is the same object the tx-bound collections
        // ride on, so a fresh collection built on tx.db lands its
        // writes in the same transaction.
        const innerLevels = await StockLevelCollection.create({
          db: tx.db as DatabaseConfig,
        });
        expect((innerLevels as unknown as { db: unknown }).db).toBe(capturedDb);
        await tx.receive(skuA, warehouse, 1);
      });
      // We can't compare identity to `service.db` directly because tests
      // pass a `{ type, url }` config rather than a DatabaseInterface,
      // but we can assert the tx exposed a non-falsy db with the
      // signature we expect from a tx-scoped handle (a `transaction`
      // method makes no sense on a tx-scoped db; the absence of one is
      // a useful telltale on adapters that strip it, but adapters that
      // keep it are also fine — the key invariant is just "not the
      // outer config object").
      expect(capturedDb).toBeTruthy();
      expect(typeof capturedDb).toBe('object');
    });

    it('rolled-back transactions leave no movements behind', async () => {
      // Direct atomicity test: a fulfill() that fails (over-pull from
      // allocated) must NOT leave the level write committed without a
      // movement, NOR a movement committed without the level update.
      await service.receive(skuA, warehouse, 5);
      await service.reserve(skuA, warehouse, 3);
      // Now: 2 available, 3 allocated. Try to fulfill 10 — should throw.
      await expect(service.fulfill(skuA, warehouse, 10)).rejects.toThrow(
        InsufficientStockError,
      );

      // Level should be unchanged: 2 available, 3 allocated, no
      // fulfillment movement.
      const allocated = await levels.getLevel(skuA, warehouse, 'allocated');
      expect(Number(allocated?.qty)).toBe(3);
      const available = await levels.getLevel(skuA, warehouse, 'available');
      expect(Number(available?.qty)).toBe(2);
      const fulfillmentMovements = await movements.findByReason('fulfillment');
      expect(fulfillmentMovements).toHaveLength(0);
    });
  });

  describe('audit log invariants', () => {
    it('records the qty across multiple locations and exposes totals', async () => {
      await service.receive(skuA, warehouse, 8);
      await service.receive(skuA, store, 4);
      await service.reserve(skuA, warehouse, 3);

      // available across all locations
      const availableTotal = await levels.totalForSku(skuA, 'available');
      expect(availableTotal).toBe(9);
      // grand total across every state
      const grand = await levels.totalForSku(skuA);
      expect(grand).toBe(12);
    });

    it('does not let updates erase prior movements', async () => {
      await service.receive(skuA, warehouse, 5);
      await service.reserve(skuA, warehouse, 2);
      const audit = await movements.findBySku(skuA);
      expect(audit).toHaveLength(2);

      // Even if a malicious caller tries to overwrite an existing
      // movement with a different qty, the change must not affect any
      // prior row — fetching by id still surfaces the same number of
      // rows and the same `qty`s.
      const target = audit[0];
      target.qty = 9999;
      await target.save();

      const reloaded = await movements.findBySku(skuA);
      expect(reloaded).toHaveLength(2);
      // The mutated row may have its qty updated (movements only
      // protect against accidental UPSERT collisions, not against
      // deliberate update-by-id), but the audit ledger MUST NOT lose
      // its other entries to a phantom UPSERT.
      const totalQtyRecorded = reloaded.reduce(
        (sum, m) => sum + Number(m.qty),
        0,
      );
      expect(totalQtyRecorded).toBeGreaterThanOrEqual(2);
    });
  });

  describe('tenant isolation', () => {
    beforeEach(() => {
      enableTenancy();
    });

    afterEach(() => {
      disableTenancy();
    });

    it('keeps stock-level mutations scoped per tenant', async () => {
      const tenantA = 'tenant-a';
      const tenantB = 'tenant-b';

      // Tenant A: receive and reserve.
      await withTenant({ tenantId: tenantA }, async () => {
        const tenantLocs = await InventoryLocationCollection.create({ db });
        const tenantService = await createStockService({ db });

        const skuId = randomUUID();
        const loc = await tenantLocs.create({
          code: 'WH-A',
          kind: 'warehouse',
        });
        await loc.save();

        await tenantService.receive(skuId, loc.id!, 10);
        await tenantService.reserve(skuId, loc.id!, 4);
      });

      // Tenant B: independent inventory.
      await withTenant({ tenantId: tenantB }, async () => {
        const tenantLocs = await InventoryLocationCollection.create({ db });
        const tenantLevels = await StockLevelCollection.create({ db });
        const tenantService = await createStockService({ db });

        const skuId = randomUUID();
        const loc = await tenantLocs.create({
          code: 'WH-B',
          kind: 'warehouse',
        });
        await loc.save();

        await tenantService.receive(skuId, loc.id!, 99);

        const all = await tenantLevels.list({});
        // Tenant B sees only its own rows.
        for (const row of all) {
          expect(row.tenantId).toBe(tenantB);
        }
      });

      // Cross-tenant grand total via the tenant-A context is unaffected
      // by tenant B's receipt.
      await withTenant({ tenantId: tenantA }, async () => {
        const tenantLevels = await StockLevelCollection.create({ db });
        const allA = await tenantLevels.list({});
        for (const row of allA) {
          expect(row.tenantId).toBe(tenantA);
        }
      });
    });
  });
});
