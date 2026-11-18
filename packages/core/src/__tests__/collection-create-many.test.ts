/**
 * `SmrtCollection.createMany`: one all-or-nothing batch with the same rows,
 * ids, STI discriminators, defaults, change-feed entries and per-record
 * fallback semantics as calling `create()` for each input.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  unregisterChangeFeedWriter,
} from '../change-feed.js';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { GlobalInterceptors } from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const engines =
  process.env.SMRT_TEST_PGLITE === '1'
    ? (['pglite'] as const)
    : (['sqlite', 'duckdb'] as const);

@smrt({ tableStrategy: 'sti', tableName: 'cm_items' })
class CmItem extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'integer' }) qty = 0;
}
@smrt()
class CmSpecial extends CmItem {
  @field({ type: 'text' }) note = '';
}
class CmItems extends SmrtCollection<CmItem> {
  static readonly _itemClass = CmItem;
}

@smrt({ tableName: 'cm_invoices' })
class CmInvoice extends SmrtObject {
  @field({ type: 'integer' }) qty = 0;
  @field({ type: 'integer' }) unitPrice = 0;
  @field({ required: true }) label = '';
  @field({
    type: 'integer',
    generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'unitPrice' } },
  })
  total = 0;
}
class CmInvoices extends SmrtCollection<CmInvoice> {
  static readonly _itemClass = CmInvoice;
}

@smrt({ tableStrategy: 'sti', tableName: 'cm_mixed' })
class CmMixedBase extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
@smrt()
class CmMixedChild extends CmMixedBase {
  @field({ type: 'integer' }) qty = 0;
  @field({ type: 'integer' }) unitPrice = 0;
  @field({
    type: 'integer',
    generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'unitPrice' } },
  })
  total = 0;
}
class CmMixeds extends SmrtCollection<CmMixedBase> {
  static readonly _itemClass = CmMixedBase;
}

const hookCalls: string[] = [];
@smrt({ tableName: 'cm_hooked' })
class CmHooked extends SmrtObject {
  @field({ type: 'text' }) name = '';
  // A model-owned lifecycle override cannot be batched: it runs per record.
  protected override async validateBeforeSave() {
    hookCalls.push(this.name);
    await super.validateBeforeSave();
  }
}
class CmHookeds extends SmrtCollection<CmHooked> {
  static readonly _itemClass = CmHooked;
}

const COLUMNS = ['title', 'qty', '_meta_type', 'slug', 'context'];
const stable = (rows: Array<Record<string, unknown>>) =>
  rows
    .map((row) => Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null])))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));

for (const type of engines) {
  describe(`SmrtCollection.createMany (${type})`, () => {
    let db: DatabaseInterface;
    let items: CmItems;
    let invoices: CmInvoices;
    const statements: string[] = [];

    const watch = (database: DatabaseInterface, depth = 0) => {
      const target = database as unknown as Record<string, any>;
      for (const key of [
        'query',
        'insert',
        'update',
        'upsert',
        'get',
      ] as const) {
        const original = target[key]?.bind(target) as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (!original) continue;
        target[key] = (...args: unknown[]) => {
          statements.push(key);
          return original(...args);
        };
      }
      const transaction = target.transaction?.bind(target) as
        | ((...a: unknown[]) => unknown)
        | undefined;
      if (transaction && depth === 0) {
        target.transaction = ((
          fn: (tx: DatabaseInterface) => unknown,
          ...rest: unknown[]
        ) =>
          transaction(
            (tx: DatabaseInterface) => {
              watch(tx, 1);
              return fn(tx);
            },
            ...rest,
          )) as never;
      }
    };

    beforeEach(async () => {
      hookCalls.length = 0;
      statements.length = 0;
      registerChangeFeedWriter();
      db = await getTestDatabase({ type });
      items = await CmItems.create({ db });
      invoices = await CmInvoices.create({ db });
    });
    afterEach(async () => {
      unregisterChangeFeedWriter();
      await db?.close?.();
    });

    const rows = async (table: string) =>
      (await db.query(`SELECT * FROM ${table}`)).rows as Array<
        Record<string, unknown>
      >;

    it('returns nothing for no input', async () => {
      expect(await items.createMany([])).toEqual([]);
    });

    it('persists the same rows as create(), in input order, with STI types', async () => {
      const inputs = [1, 2, 3].map((n) => ({
        title: `Item ${n}`,
        qty: n,
        ...(n === 2 ? { _meta_type: 'CmSpecial', note: 'n' } : {}),
      }));
      const created = await items.createMany(inputs as never);
      expect(created.map((c) => c.title)).toEqual([
        'Item 1',
        'Item 2',
        'Item 3',
      ]);
      expect(created[1]).toBeInstanceOf(CmSpecial);
      expect(created.every((c) => c.isPersisted && c.id)).toBe(true);
      const batch = stable(await rows('cm_items'));

      await db.query('DELETE FROM cm_items');
      for (const input of inputs) await items.create(input as never);
      expect(batch).toEqual(stable(await rows('cm_items')));
      expect(batch.map((r) => r._meta_type)).toHaveLength(3);
    });

    it('keeps explicit ids and stamps created/updated timestamps', async () => {
      const ids = [randomUUID(), randomUUID()];
      const created = await items.createMany(
        ids.map((id, n) => ({ id, title: `T${n}` })) as never,
      );
      expect(created.map((c) => c.id)).toEqual(ids);
      for (const row of await rows('cm_items')) {
        expect(row.created_at).toBeTruthy();
        expect(row.updated_at).toBeTruthy();
      }
    });

    it('uses a bounded number of statements for the whole batch', async () => {
      watch(db);
      await items.createMany(
        Array.from({ length: 300 }, (_, n) => ({
          id: randomUUID(),
          title: `Row ${n}`,
          qty: n,
        })) as never,
      );
      // tombstone probe, collision probe(s), insert(s), one change-feed append.
      expect(statements.length).toBeLessThanOrEqual(12);
      expect(await rows('cm_items')).toHaveLength(300);
    });

    it('records one change-feed entry per row from one append', async () => {
      const created = await items.createMany(
        [1, 2, 3].map((n) => ({ title: `Feed ${n}` })) as never,
      );
      const feed = await getChangesSince(db, { since: 0 });
      expect(
        feed.changes
          .filter((c) => c.table === 'cm_items')
          .map((c) => [c.rowId, c.operation]),
      ).toEqual(created.map((c) => [c.id, 'create']));
    });

    it('reads calculated values back once for the batch', async () => {
      const created = await invoices.createMany(
        [1, 2, 3].map((n) => ({
          label: `Inv ${n}`,
          qty: n,
          unitPrice: 10,
        })) as never,
      );
      expect(created.map((c) => c.total)).toEqual([10, 20, 30]);
    });

    it('rolls back every row when one input is invalid', async () => {
      await expect(
        invoices.createMany([
          { label: 'ok', qty: 1, unitPrice: 1 },
          { qty: 2, unitPrice: 2 },
        ] as never),
      ).rejects.toBeInstanceOf(Error);
      expect(await rows('cm_invoices')).toHaveLength(0);
    });

    it('raises the error create() raises for the same invalid input', async () => {
      const single = await invoices.create({ qty: 2 } as never).then(
        () => null,
        (error: Error) => error,
      );
      const batch = await invoices.createMany([{ qty: 2 }] as never).then(
        () => null,
        (error: Error) => error,
      );
      expect(single).toBeInstanceOf(Error);
      expect(batch?.constructor).toBe(single?.constructor);
      expect((batch as { code?: string }).code).toBe(
        (single as { code?: string }).code,
      );
    });

    it('rolls back the whole batch when completion fails with no caller transaction', async () => {
      GlobalInterceptors.register({
        name: 'cm-failing-bulk',
        priority: 1,
        afterSave() {},
        bulkMutation: {
          compatible: () => true,
          async afterSave() {
            throw new Error('completion failed');
          },
        },
      });
      try {
        await expect(
          items.createMany(
            [1, 2, 3].map((n) => ({ title: `Fail ${n}` })) as never,
          ),
        ).rejects.toThrow('completion failed');
      } finally {
        GlobalInterceptors.unregister('cm-failing-bulk');
      }
      expect(await rows('cm_items')).toHaveLength(0);
      const feed = await getChangesSince(db, { since: 0 });
      expect(feed.changes.filter((c) => c.table === 'cm_items')).toEqual([]);
    });

    it('reads generated values back for later children of a mixed STI batch', async () => {
      const mixed = await CmMixeds.create({ db });
      const created = await mixed.createMany([
        { title: 'plain' },
        { _meta_type: 'CmMixedChild', title: 'child', qty: 3, unitPrice: 7 },
      ] as never);
      expect((created[1] as CmMixedChild).total).toBe(21);
    });

    it('rolls back with the caller transaction', async () => {
      await expect(
        (db.transaction as NonNullable<typeof db.transaction>)(async (tx) => {
          const bound = await CmItems.create({ db: tx });
          await bound.createMany(
            [1, 2].map((n) => ({ title: `Tx ${n}` })) as never,
          );
          expect((await tx.query('SELECT * FROM cm_items')).rows).toHaveLength(
            2,
          );
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await rows('cm_items')).toHaveLength(0);
    });

    it('numbers derived slugs shared inside the batch like sequential create()', async () => {
      await items.createMany(
        Array.from({ length: 3 }, () => ({ title: 'Same' })) as never,
      );
      const batch = (await rows('cm_items')).map((r) => r.slug).sort();
      await db.query('DELETE FROM cm_items');
      for (let n = 0; n < 3; n++)
        await items.create({ title: 'Same' } as never);
      expect((await rows('cm_items')).map((r) => r.slug).sort()).toEqual(batch);
      expect(new Set(batch).size).toBe(3);
    });

    it('adopts an existing natural key exactly like create()', async () => {
      const existing = await items.create({
        title: 'Adopt me',
        qty: 1,
      } as never);
      const [created] = await items.createMany([
        { title: 'Adopt me', qty: 2, slug: existing.slug },
      ] as never);
      expect((await rows('cm_items')).length).toBeLessThanOrEqual(2);
      expect(created.isPersisted).toBe(true);
    });

    it('refuses an explicit id that already exists, as create() does', async () => {
      const first = await items.create({ title: 'A' } as never);
      const batch = await items
        .createMany([{ id: first.id, title: 'B' }] as never)
        .then(
          () => null,
          (error: Error) => error,
        );
      const single = await items
        .create({ id: first.id, title: 'B' } as never)
        .then(
          () => null,
          (error: Error) => error,
        );
      expect(Boolean(batch)).toBe(Boolean(single));
    });

    it('runs a model-owned lifecycle override for every record on the per-record path', async () => {
      const hooked = await CmHookeds.create({ db });
      await hooked.createMany(
        ['a', 'b', 'c'].map((name) => ({ name })) as never,
      );
      expect(hookCalls).toEqual(['a', 'b', 'c']);
      expect(await rows('cm_hooked')).toHaveLength(3);
    });

    it('runs a non-bulk-compatible interceptor for every record', async () => {
      const seen: string[] = [];
      GlobalInterceptors.register({
        name: 'cm-per-record',
        priority: 1,
        afterSave(instance: SmrtObject) {
          seen.push((instance as CmItem).title);
        },
      });
      try {
        await items.createMany(['x', 'y'].map((title) => ({ title })) as never);
      } finally {
        GlobalInterceptors.unregister('cm-per-record');
      }
      expect(seen).toEqual(['x', 'y']);
    });

    it('falls back to create() when the lifecycle is overridden', async () => {
      class Custom extends CmItems {
        calls = 0;
        override async create(...args: Parameters<CmItems['create']>) {
          this.calls++;
          return super.create(...args);
        }
      }
      const custom = await Custom.create({ db });
      await custom.createMany([{ title: 'a' }, { title: 'b' }] as never);
      expect(custom.calls).toBe(2);
    });

    it('does not save() record by record on the fast path', async () => {
      const save = vi.spyOn(SmrtObject.prototype, 'save');
      try {
        await items.createMany([{ title: 'a' }, { title: 'b' }] as never);
        expect(save).not.toHaveBeenCalled();
      } finally {
        save.mockRestore();
      }
    });
  });
}
