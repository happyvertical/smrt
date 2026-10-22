/**
 * LotService and lot-aware StockService — lifecycle tests.
 *
 * Covers receiving lots and serials, corrections and their history, usage
 * and exclusivity, documents, per-lot stock balances, and forward/back
 * tracing including assembly recursion.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InventoryLocationCollection,
  LotCorrectionCollection,
  LotStockLevelCollection,
  StockLevelCollection,
  StockMovementCollection,
} from '../collections/index.js';
import { createLotService, type LotService } from '../services/LotService.js';
import {
  DuplicateLotError,
  LotCorrectionError,
  LotInUseError,
  LotMismatchError,
  LotNotFoundError,
} from '../services/lot-errors.js';
import {
  createStockService,
  InsufficientStockError,
  type StockService,
} from '../services/StockService.js';

describe('LotService', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let lots: LotService;
  let stock: StockService;
  let skuA: string;
  let warehouse: string;
  let store: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-inventory-lots-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const locations = await InventoryLocationCollection.create({ db });
    await StockLevelCollection.create({ db });
    await StockMovementCollection.create({ db });
    stock = await createStockService({ db });
    lots = await createLotService({ db });
    skuA = randomUUID();
    warehouse = (
      await locations.create({ code: 'WH', name: 'WH', kind: 'warehouse' })
    ).id!;
    store = (await locations.create({ code: 'ST', name: 'ST', kind: 'retail' }))
      .id!;
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  describe('receiveLot', () => {
    it('records a lot with normalized lookup key and attributes', async () => {
      const lot = await lots.receiveLot({
        lotNumber: '  ab-12 ',
        skuId: skuA,
        receivedQty: 40,
        unit: 'kg',
        attributes: { grade: 'A' },
        actorProfileId: 'p1',
      });
      expect(lot.lotNumber).toBe('ab-12');
      expect(lot.searchKey).toBe('AB-12');
      expect(lot.kind).toBe('lot');
      expect(lot.status).toBe('active');
      expect(lot.getAttributes()).toEqual({ grade: 'A' });
      const found = await lots.lots.findByLotNumber('AB-12', { skuId: skuA });
      expect(found.map((l) => l.id)).toEqual([lot.id]);
    });

    it('rejects an empty number', async () => {
      await expect(lots.receiveLot({ lotNumber: '   ' })).rejects.toThrow(
        /lotNumber is required/,
      );
    });

    it('allows the same number twice on separate receipts', async () => {
      const a = await lots.receiveLot({ lotNumber: 'L1', skuId: skuA });
      const b = await lots.receiveLot({ lotNumber: 'L1', skuId: skuA });
      expect(a.id).not.toBe(b.id);
      expect(await lots.lots.findByLotNumber('l1')).toHaveLength(2);
    });

    it('returns the same row for a repeated idempotency key', async () => {
      const a = await lots.receiveLot({
        lotNumber: 'L1',
        idempotencyKey: 'rcpt-1',
      });
      const b = await lots.receiveLot({
        lotNumber: 'L1',
        idempotencyKey: 'rcpt-1',
      });
      expect(b.id).toBe(a.id);
      expect(await lots.lots.findByLotNumber('L1')).toHaveLength(1);
    });

    it('keeps an over-long idempotency key within the identity column', async () => {
      const idempotencyKey = 'x'.repeat(400);
      const a = await lots.receiveLot({ lotNumber: 'L2', idempotencyKey });
      const b = await lots.receiveLot({ lotNumber: 'L2', idempotencyKey });
      expect(b.id).toBe(a.id);
      expect(a.identityKey).toMatch(/^kh:[0-9a-f]{64}$/);
    });

    it('records a serial as unique with quantity one', async () => {
      const s = await lots.receiveLot({
        lotNumber: 'sn-1',
        skuId: skuA,
        kind: 'serial',
        receivedQty: 9,
      });
      expect(s.uniqueNumber).toBe(true);
      expect(s.receivedQty).toBe(1);
      const err = await lots
        .receiveLot({ lotNumber: 'SN-1', skuId: skuA, kind: 'serial' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(DuplicateLotError);
      expect(err.existingLotId).toBe(s.id);
      // Same number on another SKU is a different serial.
      await lots.receiveLot({
        lotNumber: 'SN-1',
        skuId: randomUUID(),
        kind: 'serial',
      });
    });

    it('throws DuplicateLotError for a unique lot', async () => {
      await lots.receiveLot({ lotNumber: 'U1', unique: true });
      await expect(
        lots.receiveLot({ lotNumber: 'u1', unique: true }),
      ).rejects.toBeInstanceOf(DuplicateLotError);
    });

    it('accepts an explicit id on related rows', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L1' });
      const usage = await lots.usages.create({
        id: randomUUID(),
        lotId: lot.id!,
        consumerType: 'X',
        consumerId: 'y',
      });
      expect(usage.id).toBeTruthy();
      const found = await lots.usages.get(usage.id!);
      expect(found?.consumerId).toBe('y');
    });
  });

  describe('corrections', () => {
    it('corrects the number and records history', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'AB-1', unique: true });
      const { lot: fixed, correction } = await lots.correctLotNumber(
        lot.id!,
        'ab-2',
        { reason: 'typo', actorProfileId: 'p1' },
      );
      expect(fixed.lotNumber).toBe('ab-2');
      expect(fixed.searchKey).toBe('AB-2');
      expect(correction.oldValue).toBe('AB-1');
      expect(correction.newValue).toBe('ab-2');
      expect(correction.actorProfileId).toBe('p1');
      // The old number is free again, the new one taken.
      await lots.receiveLot({ lotNumber: 'AB-1', unique: true });
      await expect(
        lots.receiveLot({ lotNumber: 'AB-2', unique: true }),
      ).rejects.toBeInstanceOf(DuplicateLotError);
      const history = await lots.history(lot.id!);
      expect(history.map((c) => c.kind)).toEqual(['lot_number']);
    });

    it('refuses a no-op, a missing reason and a clashing number', async () => {
      const a = await lots.receiveLot({ lotNumber: 'A', unique: true });
      await lots.receiveLot({ lotNumber: 'B', unique: true });
      await expect(
        lots.correctLotNumber(a.id!, 'A', { reason: 'x' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
      await expect(
        lots.correctLotNumber(a.id!, 'C', { reason: '  ' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
      await expect(
        lots.correctLotNumber(a.id!, 'b', { reason: 'x' }),
      ).rejects.toBeInstanceOf(DuplicateLotError);
      await expect(
        lots.correctLotNumber(randomUUID(), 'C', { reason: 'x' }),
      ).rejects.toBeInstanceOf(LotNotFoundError);
      expect((await lots.lots.get(a.id!))?.lotNumber).toBe('A');
    });

    it('corrects attributes, one correction per changed key', async () => {
      const lot = await lots.receiveLot({
        lotNumber: 'L',
        attributes: { grade: 'A', origin: 'X' },
      });
      const { lot: updated, corrections } = await lots.correctAttributes(
        lot.id!,
        { grade: 'B', origin: null, same: undefined, color: 'red' },
        { reason: 'recheck' },
      );
      expect(updated.getAttributes()).toEqual({ grade: 'B', color: 'red' });
      expect(corrections.map((c) => c.field).sort()).toEqual([
        'color',
        'grade',
        'origin',
      ]);
      const origin = corrections.find((c) => c.field === 'origin')!;
      expect(origin.oldValue).toBe('"X"');
      expect(origin.newValue).toBe('');
      await expect(
        lots.correctAttributes(lot.id!, { grade: 'B' }, { reason: 'again' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
    });

    it('changes status and refuses an unchanged one', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L' });
      const { lot: q, correction } = await lots.setStatus(
        lot.id!,
        'quarantined',
        {
          reason: 'failed inspection',
        },
      );
      expect(q.status).toBe('quarantined');
      expect(correction.kind).toBe('status');
      expect(correction.oldValue).toBe('active');
      await expect(
        lots.setStatus(lot.id!, 'quarantined', { reason: 'x' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
    });

    it('orders history oldest first', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L' });
      await lots.setStatus(lot.id!, 'quarantined', { reason: '1' });
      await lots.setStatus(lot.id!, 'active', { reason: '2' });
      await lots.setStatus(lot.id!, 'void', { reason: '3' });
      expect((await lots.history(lot.id!)).map((c) => c.reason)).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    it('keeps corrections append-only and the lot referenced', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L' });
      await lots.setStatus(lot.id!, 'void', { reason: 'x' });
      const corrections = await LotCorrectionCollection.create({ db });
      expect(
        await corrections.list({ where: { lotId: lot.id! } }),
      ).toHaveLength(1);
    });
  });

  describe('usage', () => {
    it('is idempotent per consumer', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L' });
      const a = await lots.recordUsage(lot.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
        qty: 5,
      });
      const b = await lots.recordUsage(lot.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
        qty: 5,
      });
      expect(b.id).toBe(a.id);
      expect(await lots.usages.findActiveForLot(lot.id!)).toHaveLength(1);
      expect((await lots.lots.get(lot.id!))?.lastUsedAt).toBeTruthy();
      // Non-exclusive lots can feed several consumers.
      await lots.recordUsage(lot.id!, {
        consumerType: 'Job',
        consumerId: 'j2',
      });
      expect(await lots.usages.findActiveForLot(lot.id!)).toHaveLength(2);
    });

    it('refuses a second consumer of an exclusive lot or serial', async () => {
      const serial = await lots.receiveLot({ lotNumber: 'S1', kind: 'serial' });
      await lots.recordUsage(serial.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
      });
      await expect(
        lots.recordUsage(serial.id!, { consumerType: 'Job', consumerId: 'j2' }),
      ).rejects.toBeInstanceOf(LotInUseError);

      const lot = await lots.receiveLot({ lotNumber: 'L' });
      await lots.recordUsage(lot.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
      });
      await expect(
        lots.recordUsage(lot.id!, {
          consumerType: 'Job',
          consumerId: 'j2',
          exclusive: true,
        }),
      ).rejects.toBeInstanceOf(LotInUseError);
    });

    it('unlinks with a correction, keeps the row, and frees a serial', async () => {
      const serial = await lots.receiveLot({ lotNumber: 'S1', kind: 'serial' });
      const usage = await lots.recordUsage(serial.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
      });
      const { usage: unlinked, correction } = await lots.unlinkUsage(
        usage.id!,
        {
          reason: 'wrong job',
          actorProfileId: 'p1',
        },
      );
      expect(unlinked.status).toBe('unlinked');
      expect(unlinked.unlinkReason).toBe('wrong job');
      expect(correction.kind).toBe('unlink');
      expect(correction.oldValue).toBe('Job:j1');
      expect(correction.newValue).toBe('');
      expect(correction.usageId).toBe(usage.id);
      expect(await lots.usages.get(usage.id!)).toBeTruthy();
      await expect(
        lots.unlinkUsage(usage.id!, { reason: 'again' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
      await lots.recordUsage(serial.id!, {
        consumerType: 'Job',
        consumerId: 'j2',
      });
      expect(await lots.usages.findForConsumer('Job', 'j1')).toHaveLength(0);
      expect(
        await lots.usages.findForConsumer('Job', 'j1', {
          includeUnlinked: true,
        }),
      ).toHaveLength(1);
    });
  });

  describe('documents', () => {
    it('attaches idempotently and detaches with a correction', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L' });
      const a = await lots.attachDocument(lot.id!, { assetId: 'asset-1' });
      const b = await lots.attachDocument(lot.id!, { assetId: 'asset-1' });
      expect(b.id).toBe(a.id);
      expect(a.role).toBe('certificate');
      const { document, correction } = await lots.detachDocument(a.id!, {
        reason: 'wrong file',
      });
      expect(document.detachedAt).toBeTruthy();
      expect(correction.kind).toBe('document_detach');
      expect(correction.documentId).toBe(a.id);
      await expect(
        lots.detachDocument(a.id!, { reason: 'again' }),
      ).rejects.toBeInstanceOf(LotCorrectionError);
      // Re-attaching after detach makes a new link.
      const c = await lots.attachDocument(lot.id!, { assetId: 'asset-1' });
      expect(c.id).not.toBe(a.id);
    });
  });

  describe('StockService with lotId', () => {
    it('tracks lot balances and stamps movements', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L', skuId: skuA });
      const lotLevels = await LotStockLevelCollection.create({ db });
      await stock.receive(skuA, warehouse, 10, { lotId: lot.id });
      await stock.receive(skuA, warehouse, 5); // untracked stock of the same SKU
      await stock.reserve(skuA, warehouse, 4, { lotId: lot.id });
      expect(
        Number(
          (await lotLevels.getLevel(lot.id!, warehouse, 'available'))!.qty,
        ),
      ).toBe(6);
      expect(
        Number(
          (await lotLevels.getLevel(lot.id!, warehouse, 'allocated'))!.qty,
        ),
      ).toBe(4);
      expect(await lotLevels.onHand(lot.id!)).toBe(10);
      expect(await lotLevels.onHand(lot.id!, 'available')).toBe(6);
      await stock.release(skuA, warehouse, 1, { lotId: lot.id });
      await stock.fulfill(skuA, warehouse, 3, { lotId: lot.id });
      expect(await stock.lotLevels.onHand(lot.id!)).toBe(7);
      // SKU-level levels are unchanged in behaviour.
      expect(await stock.levels.totalForSku(skuA)).toBe(12);
      const moves = await stock.movements.list({ where: { lotId: lot.id! } });
      expect(moves).toHaveLength(4);
      const untracked = (await stock.movements.findBySku(skuA)).filter(
        (m) => !m.lotId,
      );
      expect(untracked).toHaveLength(1);
    });

    it('refuses to overdraw a lot even when the SKU has stock', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L', skuId: skuA });
      await stock.receive(skuA, warehouse, 100);
      await stock.receive(skuA, warehouse, 2, { lotId: lot.id });
      const err = await stock
        .reserve(skuA, warehouse, 3, { lotId: lot.id })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InsufficientStockError);
      expect(err.lotId).toBe(lot.id);
      expect(err.available).toBe(2);
      // Nothing leaked into the SKU-level row.
      expect(await stock.levels.totalForSku(skuA, 'allocated')).toBe(0);
      await expect(
        stock.adjust(skuA, warehouse, -3, { lotId: lot.id }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
    });

    it('rejects an unknown lot and a SKU mismatch', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L', skuId: skuA });
      await expect(
        stock.receive(randomUUID(), warehouse, 1, { lotId: lot.id }),
      ).rejects.toBeInstanceOf(LotMismatchError);
      await expect(
        stock.receive(skuA, warehouse, 1, { lotId: randomUUID() }),
      ).rejects.toBeInstanceOf(LotNotFoundError);
      // A lot without a SKU can be received against any SKU.
      const loose = await lots.receiveLot({ lotNumber: 'LOOSE' });
      await stock.receive(skuA, warehouse, 1, { lotId: loose.id });
    });

    it('moves both transfer legs and adjusts by lot', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'L', skuId: skuA });
      await stock.receive(skuA, warehouse, 10, { lotId: lot.id });
      await stock.transfer(skuA, warehouse, store, 4, { lotId: lot.id });
      expect(
        Number((await stock.lotLevels.getLevel(lot.id!, warehouse))!.qty),
      ).toBe(6);
      expect(
        Number((await stock.lotLevels.getLevel(lot.id!, store))!.qty),
      ).toBe(4);
      const moves = await stock.movements.list({ where: { lotId: lot.id! } });
      expect(
        moves.filter((m) => m.reasonCode.startsWith('transfer')),
      ).toHaveLength(2);
      await stock.adjust(skuA, store, -1, { lotId: lot.id });
      await stock.adjust(skuA, store, 2, { lotId: lot.id, state: 'damaged' });
      expect(await stock.lotLevels.onHand(lot.id!)).toBe(11);
    });

    it('receives a lot and its stock atomically in a shared transaction', async () => {
      await expect(
        stock.withTransaction(async (tx) => {
          const txLots = await createLotService({ db: tx.db });
          const lot = await txLots.receiveLot({
            lotNumber: 'ROLL',
            skuId: skuA,
          });
          await tx.receive(skuA, warehouse, 3, { lotId: lot.id });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await lots.lots.findByLotNumber('ROLL')).toHaveLength(0);
      expect(await stock.lotLevels.list({})).toHaveLength(0);

      const lot = await stock.withTransaction(async (tx) => {
        const txLots = await createLotService({ db: tx.db });
        const made = await txLots.receiveLot({ lotNumber: 'OK', skuId: skuA });
        await tx.receive(skuA, warehouse, 3, { lotId: made.id });
        return made;
      });
      expect(await stock.lotLevels.onHand(lot.id!)).toBe(3);
    });
  });

  describe('joined service', () => {
    it('works through createLotService({ db: tx.db }) inside a stock transaction', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'J1', unique: true });
      await stock.withTransaction(async (tx) => {
        const joined = await createLotService({ db: tx.db });
        await joined.recordUsage(lot.id!, {
          consumerType: 'Job',
          consumerId: 'j1',
        });
        await joined.correctLotNumber(lot.id!, 'J2', { reason: 'typo' });
        const made = await joined.receiveLot({ lotNumber: 'J3', unique: true });
        await expect(
          joined.receiveLot({ lotNumber: 'J3', unique: true }),
        ).rejects.toBeInstanceOf(DuplicateLotError);
        await tx.receive(skuA, warehouse, 2, { lotId: made.id });
      });
      expect((await lots.lots.get(lot.id!))?.lotNumber).toBe('J2');
      expect(await lots.usages.findActiveForLot(lot.id!)).toHaveLength(1);
      expect(await lots.lots.findByLotNumber('J3')).toHaveLength(1);
    });

    it('rolls the joined work back with the outer transaction', async () => {
      const lot = await lots.receiveLot({ lotNumber: 'J1' });
      await expect(
        stock.withTransaction(async (tx) => {
          const joined = await createLotService({ db: tx.db });
          await joined.recordUsage(lot.id!, {
            consumerType: 'Job',
            consumerId: 'j1',
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await lots.usages.findActiveForLot(lot.id!)).toHaveLength(0);
    });
  });

  describe('tenancy', () => {
    afterEach(() => disableTenancy());

    it("does not treat another tenant's lot as a duplicate or idempotent match", async () => {
      enableTenancy();
      const other = await withTenant({ tenantId: 'tenant-b' }, async () => {
        const a = await lots.receiveLot({ lotNumber: 'T1', unique: true });
        const k = await lots.receiveLot({
          lotNumber: 'T2',
          idempotencyKey: 'k',
        });
        return { a, k };
      });
      // No tenant context: tenant B's rows are not a match.
      const mine = await lots.receiveLot({ lotNumber: 'T1', unique: true });
      expect(mine.id).not.toBe(other.a.id);
      const mineKeyed = await lots.receiveLot({
        lotNumber: 'T2',
        idempotencyKey: 'k',
      });
      expect(mineKeyed.id).not.toBe(other.k.id);
      // Inside tenant B the same call matches B's own rows.
      await withTenant({ tenantId: 'tenant-b' }, async () => {
        const again = await lots.receiveLot({
          lotNumber: 'T2',
          idempotencyKey: 'k',
        });
        expect(again.id).toBe(other.k.id);
        await expect(
          lots.receiveLot({ lotNumber: 'T1', unique: true }),
        ).rejects.toBeInstanceOf(DuplicateLotError);
      });
    });
  });

  describe('tracing', () => {
    it('traces forward through assemblies with movements and documents', async () => {
      const raw = await lots.receiveLot({ lotNumber: 'RAW', skuId: skuA });
      const part = await lots.receiveLot({ lotNumber: 'PART' });
      const unit = await lots.receiveLot({ lotNumber: 'UNIT', kind: 'serial' });
      await stock.receive(skuA, warehouse, 5, { lotId: raw.id });
      await lots.attachDocument(raw.id!, { assetId: 'cert' });
      await lots.recordUsage(raw.id!, {
        consumerType: 'Lot',
        consumerId: part.id!,
      });
      await lots.recordUsage(part.id!, {
        consumerType: 'Lot',
        consumerId: unit.id!,
      });
      await lots.recordUsage(unit.id!, {
        consumerType: 'Shipment',
        consumerId: 's1',
      });

      const trace = await lots.traceForward(raw.id!);
      expect(trace.lot.id).toBe(raw.id);
      expect(trace.movements).toHaveLength(1);
      expect(trace.documents).toHaveLength(1);
      expect(trace.children.map((c) => c.lot.id)).toEqual([part.id]);
      const leaf = trace.children[0].children[0];
      expect(leaf.lot.id).toBe(unit.id);
      expect(leaf.usages[0].consumerType).toBe('Shipment');
      expect(
        (await lots.traceForward(raw.id!, { depth: 1 })).children[0].children,
      ).toEqual([]);
    });

    it('hides unlinked usages unless asked', async () => {
      const a = await lots.receiveLot({ lotNumber: 'A' });
      const b = await lots.receiveLot({ lotNumber: 'B' });
      const usage = await lots.recordUsage(a.id!, {
        consumerType: 'Lot',
        consumerId: b.id!,
      });
      await lots.unlinkUsage(usage.id!, { reason: 'mistake' });
      expect((await lots.traceForward(a.id!)).children).toHaveLength(0);
      expect(
        (await lots.traceForward(a.id!, { includeUnlinked: true })).children,
      ).toHaveLength(1);
      expect(await lots.traceBack('Lot', b.id!)).toHaveLength(0);
      expect(
        await lots.traceBack('Lot', b.id!, { includeUnlinked: true }),
      ).toHaveLength(1);
    });

    it('traces back from a consumer through assembly lineage', async () => {
      const raw = await lots.receiveLot({ lotNumber: 'RAW' });
      const part = await lots.receiveLot({ lotNumber: 'PART' });
      await lots.recordUsage(raw.id!, {
        consumerType: 'Lot',
        consumerId: part.id!,
      });
      await lots.recordUsage(part.id!, {
        consumerType: 'Job',
        consumerId: 'j1',
      });
      const nodes = await lots.traceBack('Job', 'j1');
      expect(nodes.map((n) => n.lot.id)).toEqual([part.id]);
      expect(nodes[0].usages[0].consumerId).toBe('j1');
      expect(nodes[0].children.map((n) => n.lot.id)).toEqual([raw.id]);
    });

    it('expands a diamond once', async () => {
      const raw = await lots.receiveLot({ lotNumber: 'RAW' });
      const left = await lots.receiveLot({ lotNumber: 'LEFT' });
      const right = await lots.receiveLot({ lotNumber: 'RIGHT' });
      const top = await lots.receiveLot({ lotNumber: 'TOP' });
      for (const [from, to] of [
        [raw, left],
        [raw, right],
        [left, top],
        [right, top],
      ]) {
        await lots.recordUsage(from.id!, {
          consumerType: 'Lot',
          consumerId: to.id!,
          exclusive: false,
        });
      }
      const trace = await lots.traceForward(raw.id!);
      expect(trace.children).toHaveLength(2);
      expect(trace.children[0].children[0]).toBe(trace.children[1].children[0]);
      expect(trace.children[0].children[0].lot.id).toBe(top.id);
    });

    it('survives cycles', async () => {
      const a = await lots.receiveLot({ lotNumber: 'A' });
      const b = await lots.receiveLot({ lotNumber: 'B' });
      await lots.recordUsage(a.id!, { consumerType: 'Lot', consumerId: b.id! });
      await lots.recordUsage(b.id!, { consumerType: 'Lot', consumerId: a.id! });
      const forward = await lots.traceForward(a.id!);
      expect(forward.children).toHaveLength(1);
      expect(forward.children[0].children).toHaveLength(0);
      const back = await lots.traceBack('Lot', a.id!);
      expect(back.map((n) => n.lot.id)).toEqual([b.id]);
      expect(back[0].children).toHaveLength(0);
      await expect(
        lots.recordUsage(a.id!, { consumerType: 'Lot', consumerId: a.id! }),
      ).rejects.toThrow(/itself/);
    });
  });
});
