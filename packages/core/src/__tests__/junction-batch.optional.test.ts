/** Cross-adapter persistence/rollback regression for compatible junction batches. */
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getChangesSince, registerChangeFeedWriter } from '../change-feed';
import { field, foreignKey } from '../decorators/index';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';
import { getDDLStrategy } from '../schema/ddl/index';

@smrt({ tableName: 'junction_batch_parents' })
class JunctionBatchParent extends SmrtObject {
  @field() name = '';
}

@smrt({
  tableName: 'junction_batch_dialect_links',
  conflictColumns: ['owner_id', 'asset_id'],
})
class JunctionBatchDialectLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field() sortOrder = 0;
  @foreignKey(JunctionBatchParent, {
    constraint: { engines: ['postgres', 'sqlite'] },
  })
  parentId: string | null = null;
}

@smrt()
class JunctionBatchDialectLinks extends SmrtJunction<JunctionBatchDialectLink> {
  static readonly _itemClass = JunctionBatchDialectLink;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(type === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL)(
    `${type} junction batches`,
    () => {
      let db: Awaited<ReturnType<typeof getDatabase>>;
      let links: JunctionBatchDialectLinks;
      beforeAll(async () => {
        // Consumer manifests can register this abstract base without a table.
        ObjectRegistry.register(SmrtPolymorphicAssociation, {});
        db = await getDatabase({
          type,
          url:
            type === 'postgres'
              ? process.env.SMRT_TEST_POSTGRES_URL
              : ':memory:',
          dbid: `junction-batch-${randomUUID()}`,
        });
        const name =
          ObjectRegistry.getClassByConstructor(JunctionBatchDialectLink)
            ?.qualifiedName ?? JunctionBatchDialectLink.name;
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error('Missing junction batch schema');
        await db.query('DROP TABLE IF EXISTS junction_batch_dialect_links');
        await db.query('DROP TABLE IF EXISTS junction_batch_parents');
        const parentName =
          ObjectRegistry.getClassByConstructor(JunctionBatchParent)
            ?.qualifiedName ?? JunctionBatchParent.name;
        await db.query(ObjectRegistry.getSchemaDDL(parentName, type)!);
        await db.query(ObjectRegistry.getSchemaDDL(name, type)!);
        for (const sql of getDDLStrategy(type).generateIndexes(schema))
          await db.query(sql);
        links = await JunctionBatchDialectLinks.create({ db });
        registerChangeFeedWriter();
      });
      beforeEach(async () => {
        await db.query('DELETE FROM junction_batch_dialect_links');
      });
      afterAll(async () => {
        await db?.query('DROP TABLE IF EXISTS junction_batch_dialect_links');
        await db?.query('DROP TABLE IF EXISTS junction_batch_parents');
        await db?.close?.();
      });

      it('runs final normalization in shared compatible batch preparation', async () => {
        const base = SmrtObject.prototype as unknown as {
          normalizePersistenceData(
            data: Readonly<Record<string, unknown>>,
          ): Record<string, unknown> | undefined;
        };
        const normalize = vi.spyOn(base, 'normalizePersistenceData');
        try {
          await links.setLinks('prepared-owner', ['first', 'second']);
          expect(normalize).toHaveBeenCalledTimes(2);
          expect(normalize.mock.calls.map(([row]) => row.asset_id)).toEqual([
            'first',
            'second',
          ]);
          expect(
            (await links.byLeft('prepared-owner')).map((row) => row.assetId),
          ).toEqual(['first', 'second']);
        } finally {
          normalize.mockRestore();
        }
      });

      it('refuses custom normalization batches and preserves ordinary save normalization', async () => {
        const link = await new JunctionBatchDialectLink({ db }).initialize();
        link.ownerId = 'normalized-owner';
        link.assetId = 'asset';
        const custom = link as unknown as {
          normalizePersistenceData(
            data: Readonly<Record<string, unknown>>,
          ): Record<string, unknown> | undefined;
        };
        const declaration = vi
          .spyOn(link as any, 'getPersistenceDerivedColumns')
          .mockReturnValue(['sort_order']);
        const normalize = vi
          .spyOn(custom, 'normalizePersistenceData')
          .mockImplementation((row) => {
            expect(row.asset_id).toBe('asset');
            return { sort_order: 42 };
          });
        try {
          expect(await SmrtObject.tryJunctionBatch([], [link])).toBe(false);
          expect(normalize).not.toHaveBeenCalled();
          expect(await links.byLeft('normalized-owner')).toEqual([]);
          await link.save();
          expect(normalize).toHaveBeenCalledTimes(1);
          expect((await links.byLeft('normalized-owner'))[0].sortOrder).toBe(
            42,
          );
        } finally {
          normalize.mockRestore();
          declaration.mockRestore();
        }
      });

      it('uses one upsert for many links and hydrates canonical IDs and timestamps', async () => {
        const query = vi.spyOn(db, 'query');
        await links.setLinks(
          'owner',
          Array.from({ length: 30 }, (_, i) => `asset-${i}`),
        );
        const writes = query.mock.calls.filter(([sql]) =>
          String(sql).startsWith('INSERT INTO "junction_batch_dialect_links"'),
        );
        query.mockRestore();
        expect(writes).toHaveLength(1);
        const rows = await links.byLeft('owner');
        expect(rows).toHaveLength(30);
        expect(
          rows.every(
            (row) =>
              typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id!),
          ),
        ).toBe(true);
        expect(rows.map((row) => row.sortOrder)).toEqual(
          Array.from({ length: 30 }, (_, i) => i),
        );
        expect(
          rows.every(
            (row) =>
              row.updated_at instanceof Date && row.created_at instanceof Date,
          ),
        ).toBe(true);
        await links.detach('owner', 'asset-0');
        expect(await links.byLeft('owner')).toHaveLength(29);
      });

      it.skipIf(type === 'sqlite')(
        'coerces empty optional native UUID references to NULL',
        async () => {
          const link = await new JunctionBatchDialectLink({ db }).initialize();
          link.ownerId = 'uuid-owner';
          link.assetId = 'a';
          link.parentId = '';
          expect(await SmrtObject.tryJunctionBatch([], [link])).toBe(true);
          expect((await links.byLeft('uuid-owner'))[0].parentId).toBeNull();
        },
      );

      it('rolls replacement and tombstones back with a caller transaction', async () => {
        await links.setLinks('owner', ['before']);
        const before = await links.byLeft('owner');
        const cursor = (await getChangesSince(db, { since: 0, limit: 1000 }))
          .cursor;
        await expect(
          db.transaction(async (tx) => {
            const bound = await JunctionBatchDialectLinks.create({ db: tx });
            await bound.setLinks('owner', ['after-a', 'after-b']);
            throw new Error('caller rollback');
          }),
        ).rejects.toThrow('caller rollback');
        expect((await links.byLeft('owner')).map((row) => row.id)).toEqual(
          before.map((row) => row.id),
        );
        expect(
          (await getChangesSince(db, { since: cursor, limit: 1000 })).changes,
        ).toEqual([]);
      });

      it.skipIf(type !== 'duckdb')(
        'preserves the detectable legacy caller-transaction limitation (#2824)',
        async () => {
          await links.setLinks('legacy-owner', ['before']);
          const row = (await links.byLeft('legacy-owner'))[0];
          await expect(
            db.transaction(async (tx) => {
              await row.withDatabase(tx, () => row.delete());
            }),
          ).rejects.toThrow('Nested transactions are not supported');
          expect((await links.byLeft('legacy-owner'))[0].id).toBe(row.id);
        },
      );

      it('preserves duplicate-input last-write behavior through fallback', async () => {
        await links.setLinks('owner', ['a', 'a', 'b']);
        expect(
          (await links.byLeft('owner')).map((row) => [
            row.assetId,
            row.sortOrder,
          ]),
        ).toEqual([
          ['a', 1],
          ['b', 2],
        ]);
      });

      it('maps a bulk unique failure to the ordinary typed validation contract', async () => {
        await db.query(
          'CREATE UNIQUE INDEX junction_batch_position_unique ON junction_batch_dialect_links (sort_order)',
        );
        try {
          await expect(
            links.setLinks('owner', ['a', 'b'], { sortOrder: 0 }),
          ).rejects.toMatchObject({ code: 'VALIDATION_UNIQUE_CONSTRAINT' });
        } finally {
          await db.query('DROP INDEX junction_batch_position_unique');
        }
      });
    },
  );
}
