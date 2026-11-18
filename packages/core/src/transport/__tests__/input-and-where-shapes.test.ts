/**
 * Two facts the transport kernel's input and query modules are built on,
 * settled here before those modules exist (#5158):
 *
 * 1. A `transient` field is accepted through the collection create path and is
 *    absent from every serialised form, so a declared input field needs no new
 *    plumbing below the transport. The same holds for a relationship accessor,
 *    which is why `transient` alone must never mean "writable".
 * 2. A list `where` is either one record (AND) or a DNF array of arrays of
 *    records, and the collection walks every branch.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import { field, foreignKey, oneToMany } from '../../decorators';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { getTestDatabase } from '../../testing/database';
import { cleanupFileDatabase } from '../../testing/file-cleanup';

@smrt()
class KernelShapeLine extends SmrtObject {
  @foreignKey('KernelShapeOrder')
  kernelShapeOrderId: string = '';

  label: string = '';
}

@smrt()
class KernelShapeOrder extends SmrtObject {
  @field({ required: true })
  name: string = '';

  status: string = 'open';

  priority: number = 0;

  @field({ sensitive: true })
  accessToken: string = '';

  /** Accepted as input, never stored. */
  @field({ transient: true })
  confirmationPhrase: string = '';

  @oneToMany('KernelShapeLine')
  lines: unknown[] = [];
}

class KernelShapeOrders extends SmrtCollection<KernelShapeOrder> {
  static readonly _itemClass = KernelShapeOrder;
}

class KernelShapeLines extends SmrtCollection<KernelShapeLine> {
  static readonly _itemClass = KernelShapeLine;
}

describe('transport kernel input and where shapes', () => {
  let db: DatabaseInterface;
  let dbPath: string;
  let orders: KernelShapeOrders;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `kernel-shapes-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
    // The child table first: the parent's relationship metadata names it.
    await KernelShapeLines.create({ db });
    orders = await KernelShapeOrders.create({ db });
  }, 120000);

  afterEach(async () => {
    await cleanupFileDatabase(db, dbPath);
  });

  describe('transient fields', () => {
    it('are registered as fields, so the constructor path can see them', async () => {
      const fields = await ObjectRegistry.getAllFields('KernelShapeOrder');
      expect(fields.get('confirmationPhrase')?.transient).toBe(true);
      // A relationship accessor is transient too, without being declared so.
      const lines = fields.get('lines');
      expect(lines?.transient ?? lines?._meta?.transient).toBe(true);
    });

    it('reach the instance through collection.create()', async () => {
      const order = await orders.create({
        name: 'first',
        confirmationPhrase: 'delete everything',
      });
      expect(order.confirmationPhrase).toBe('delete everything');
    });

    it('are absent from toJSON, toPublicJSON and toPlain on a new instance', async () => {
      const order = await orders.create({
        name: 'second',
        accessToken: 'tok',
        confirmationPhrase: 'yes',
      });
      for (const json of [
        order.toJSON(),
        order.toPublicJSON(),
        order.toPublicJSON({ permissions: ['anything'] }),
      ] as Record<string, unknown>[]) {
        expect(json).not.toHaveProperty('confirmationPhrase');
        expect(json).not.toHaveProperty('lines');
        expect(json.name).toBe('second');
      }
      // The sensitive field shows the two serialisers still differ as usual.
      expect(order.toJSON()).toHaveProperty('accessToken', 'tok');
      expect(order.toPublicJSON()).not.toHaveProperty('accessToken');
      expect(JSON.stringify(order)).not.toContain('confirmationPhrase');
    });

    it('are not stored, and stay absent after get() and list()', async () => {
      const created = await orders.create({
        name: 'third',
        confirmationPhrase: 'yes',
      });
      const row = await db.get(orders.tableName, { id: created.id });
      expect(row).toBeTruthy();
      expect(Object.keys(row ?? {})).not.toContain('confirmation_phrase');
      expect(Object.keys(row ?? {})).not.toContain('confirmationPhrase');

      const loaded = await orders.get(created.id as string);
      expect(loaded?.confirmationPhrase).toBe('');
      expect(loaded?.toPublicJSON()).not.toHaveProperty('confirmationPhrase');

      const [listed] = await orders.list({ where: { name: 'third' } });
      expect(listed.toPublicJSON()).not.toHaveProperty('confirmationPhrase');
      expect(listed.toJSON()).not.toHaveProperty('confirmationPhrase');
    });

    it('stay absent after an update assigns one', async () => {
      const order = await orders.create({ name: 'fourth' });
      Object.assign(order, { confirmationPhrase: 'again', status: 'closed' });
      await order.save();
      expect(order.toPublicJSON()).not.toHaveProperty('confirmationPhrase');
      const reloaded = await orders.get(order.id as string);
      expect(reloaded?.status).toBe('closed');
      expect(reloaded?.confirmationPhrase).toBe('');
    });

    it('a relationship accessor takes create input the same way', async () => {
      // Why the writable set is declared per field and not derived from
      // `transient`: a relationship accessor is transient as well.
      const order = await orders.create({
        name: 'fifth',
        lines: [{ label: 'given' }],
      });
      expect(order.lines).toEqual([{ label: 'given' }]);
      expect(order.toPublicJSON()).not.toHaveProperty('lines');
    });
  });

  describe('list where shapes', () => {
    beforeEach(async () => {
      await orders.create({ name: 'a', status: 'open', priority: 1 });
      await orders.create({ name: 'b', status: 'open', priority: 5 });
      await orders.create({ name: 'c', status: 'closed', priority: 5 });
      await orders.create({ name: 'd', status: 'closed', priority: 9 });
    });

    const names = (rows: KernelShapeOrder[]) =>
      rows.map((row) => row.name).sort();

    it('a record is an AND of its keys', async () => {
      const rows = await orders.list({
        where: { status: 'open', 'priority >': 1 },
      });
      expect(names(rows)).toEqual(['b']);
    });

    it('a DNF array ORs its branches and ANDs the records in each', async () => {
      const where = [
        [{ status: 'open' }, { 'priority >': 1 }],
        [{ name: 'd' }],
      ];
      expect(names(await orders.list({ where }))).toEqual(['b', 'd']);
      expect(await orders.count({ where })).toBe(2);
    });

    it('validates keys in every branch, not only the first', async () => {
      await expect(
        orders.list({
          where: [[{ status: 'open' }], [{ accessToken: 'tok' }]],
        }),
      ).rejects.toThrow(/sensitive/i);
      await expect(
        orders.list({
          where: [[{ status: 'open' }], [{ noSuchField: 1 }]],
        }),
      ).rejects.toThrow();
    });

    it('refuses an empty array and an empty branch', async () => {
      await expect(orders.list({ where: [] })).rejects.toThrow(
        /each OR branch must contain at least one condition/,
      );
      await expect(
        orders.list({ where: [[{ status: 'open' }], []] }),
      ).rejects.toThrow(/each OR branch must contain at least one condition/);
    });

    it('get() takes a record only', async () => {
      const row = await orders.get({ name: 'c' });
      expect(row?.status).toBe('closed');
    });
  });
});
