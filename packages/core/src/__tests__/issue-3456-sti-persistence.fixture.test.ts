import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { SchemaGenerator } from '../schema/generator.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

const TABLE = 'issue_3456_persistence';
@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_3456_persistence',
  conflictColumns: ['tenant_id', 'context'],
  tenantScoped: { mode: 'optional' },
})
class CalendarPersistence3456 extends SmrtObject {
  @field({ nullable: true }) tenantId: string | null = null;
}
@smrt({
  conflictColumns: ['tenant_id', 'date', 'name'],
  collection: 'holidaypersistence3456',
})
class HolidayPersistence3456 extends CalendarPersistence3456 {
  date: string = '';
  name: string = '';
}
class HolidaysPersistence3456 extends SmrtCollection<HolidayPersistence3456> {
  static readonly _itemClass = HolidayPersistence3456;
}
class CalendarsPersistence3456 extends SmrtCollection<CalendarPersistence3456> {
  static readonly _itemClass = CalendarPersistence3456;
}

@smrt({ conflictColumns: ['date', 'name'] })
class OwnerGuardHoliday3456 extends CalendarPersistence3456 {
  date: string = '';
  name: string = '';
}
class OwnerGuardHolidays3456 extends SmrtCollection<OwnerGuardHoliday3456> {
  static readonly _itemClass = OwnerGuardHoliday3456;
}

const qualified = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor)!.qualifiedName!;
const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
export function runSti3456Persistence(engine: 'sqlite' | 'postgres'): void {
  describe(`STI child conflict persistence on ${engine} (#3456)`, () => {
    let db: DatabaseInterface;
    beforeAll(async () => {
      db = await getDatabase(
        engine === 'postgres'
          ? { type: 'postgres', url: pgUrl!, dbid: randomUUID() }
          : { type: 'sqlite', url: ':memory:' },
      );
      const schema = await new SchemaGenerator().generateSTISchemaFromRegistry(
        qualified(CalendarPersistence3456),
        TABLE,
        new Map(),
        {
          conflictColumns: ObjectRegistry.getConflictColumns(
            qualified(CalendarPersistence3456),
          ),
          tenantScoped: { field: 'tenantId' },
          registry: ObjectRegistry,
        },
      );
      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      const strategy = getDDLStrategy(engine as 'sqlite' | 'postgres');
      await db.query(strategy.generateCreateTable(schema));
      for (const sql of strategy.generateIndexes(schema)) await db.query(sql);
    });
    afterAll(async () => {
      if (db) {
        await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
        await db.close?.();
      }
    });

    it('bootstraps raw aggregated child constraints for usable upserts and convergent parity', async () => {
      const restore = snapshotObjectRegistryState();
      const table = 'issue_3456_raw_aggregate';
      const packageName = '@test/sti3456raw';
      const childName = `${packageName}:RawChild3456`;
      try {
        ObjectRegistry.clear();
        ObjectRegistry.registerFromManifest(
          'RawRoot3456',
          {
            className: 'RawRoot3456',
            name: 'rawroot3456',
            collection: 'rawroots3456',
            filePath: '/test/RawRoot3456.ts',
            fields: {},
            methods: {},
            decoratorConfig: { tableStrategy: 'sti', tableName: table },
          },
          packageName,
        );
        ObjectRegistry.registerFromManifest(
          'RawChild3456',
          {
            className: 'RawChild3456',
            name: 'rawchild3456',
            collection: 'rawchildren3456',
            filePath: '/test/RawChild3456.ts',
            extends: 'RawRoot3456',
            extendsQualified: `${packageName}:RawRoot3456`,
            fields: { date: { type: 'text' }, name: { type: 'text' } },
            methods: {},
            decoratorConfig: { conflictColumns: ['date', 'name'] },
          },
          packageName,
        );
        // No lazy generator or pre-generated manifest schema runs before this bootstrap.
        const schema = ObjectRegistry.getAllSchemasAsDefinitions()[table];
        const strategy = getDDLStrategy(engine);
        await db.query(strategy.generateCreateTable(schema));
        for (const sql of strategy.generateIndexes(schema)) await db.query(sql);
        const firstId = randomUUID();
        await db.query(`INSERT INTO "${table}" (id, _meta_type, date, name, slug)
          VALUES ('${firstId}', '${childName}', '2026-01-01', 'Holiday', 'first')`);
        const upsert =
          await db.query(`INSERT INTO "${table}" (id, _meta_type, date, name, slug)
          VALUES ('${randomUUID()}', '${childName}', '2026-01-01', 'Holiday', 'updated')
          ON CONFLICT (date, name) WHERE _meta_type = '${childName}'
          DO UPDATE SET slug = EXCLUDED.slug RETURNING id, slug`);
        expect(upsert.rows).toEqual([{ id: firstId, slug: 'updated' }]);
        await expect(
          db.query(`INSERT INTO "${table}" (id, _meta_type, date, name, slug)
          VALUES ('${randomUUID()}', '${childName}', '2026-01-01', 'Holiday', 'duplicate')`),
        ).rejects.toThrow(/unique|duplicate/i);
        const diff = await new SchemaComparer(db, {
          engineHint: engine,
        }).compare({ [table]: schema });
        expect(getSQLFromDiff(diff)).toEqual([]);
      } finally {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        restore();
      }
    });
    it('preserves distinct dates sharing a slug and adopts only the same subtype/tenant natural key', async () => {
      const collection = await HolidaysPersistence3456.create({ db });
      const a = await collection.create({
        slug: 'same',
        date: '2026-01-01',
        name: 'Holiday',
        tenantId: '11111111-1111-4111-8111-111111111111',
      });
      const b = await collection.create({
        slug: 'same',
        date: '2026-02-01',
        name: 'Holiday',
        tenantId: a.tenantId,
      });
      expect(a.id).not.toBe(b.id);
      const again = await collection.create({
        slug: 'renamed',
        date: a.date,
        name: a.name,
        tenantId: a.tenantId,
      });
      expect(again.id).toBe(a.id);
      const otherTenant = await collection.create({
        slug: 'same',
        date: a.date,
        name: a.name,
        tenantId: '22222222-2222-4222-8222-222222222222',
      });
      expect(otherTenant.id).not.toBe(a.id);
      const calendars = await CalendarsPersistence3456.create({ db });
      const root = await calendars.create({
        slug: 'same',
        tenantId: a.tenantId,
      });
      expect(root.id).not.toBe(a.id);
      expect((await db.list(TABLE, {})).length).toBe(4);
    });
    it('deduplicates global NULL-tenant keys and preserves rollback', async () => {
      const collection = await HolidaysPersistence3456.create({ db });
      const a = await collection.create({
        slug: 'global',
        date: '2026-03-01',
        name: 'Global',
        tenantId: null,
      });
      const again = await collection.create({
        slug: 'global-other',
        date: a.date,
        name: a.name,
        tenantId: null,
      });
      expect(again.id).toBe(a.id);
      await expect(
        again.withTransaction(async () => {
          again.name = 'Rolled back';
          await again.save();
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await db.get(TABLE, { id: a.id }))!.name).toBe('Global');
    });
    it('refuses cross-owner adoption when an explicit child key omits tenant scope', async () => {
      const collection = await OwnerGuardHolidays3456.create({ db });
      const first = await collection.create({
        date: '2026-06-01',
        name: 'Owned',
        tenantId: '11111111-1111-4111-8111-111111111111',
      });
      await expect(
        collection.create({
          date: first.date,
          name: first.name,
          tenantId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
      expect((await db.get(TABLE, { id: first.id }))!.tenant_id).toBe(
        first.tenantId,
      );
    });
    it('concurrent submissions of one child key retain one identity', async () => {
      const collection = await HolidaysPersistence3456.create({ db });
      const [first, second] = await Promise.all([
        collection.create({
          date: '2026-07-01',
          name: 'Concurrent',
          tenantId: '11111111-1111-4111-8111-111111111111',
        }),
        collection.create({
          date: '2026-07-01',
          name: 'Concurrent',
          tenantId: '11111111-1111-4111-8111-111111111111',
        }),
      ]);
      expect(first.id).toBe(second.id);
    });

    it('replaces the legacy root conflict index and converges migration parity', async () => {
      const schema = await new SchemaGenerator().generateSTISchemaFromRegistry(
        qualified(CalendarPersistence3456),
        TABLE,
        new Map(),
        {
          conflictColumns: ObjectRegistry.getConflictColumns(
            qualified(CalendarPersistence3456),
          ),
          registry: ObjectRegistry,
        },
      );
      const root = schema.indexes.find((index) => index.where?.includes('<>'))!;
      const strategy = getDDLStrategy(engine as 'sqlite' | 'postgres');
      // A legacy full index cannot admit the duplicate child rows already exercised above.
      await db.query(`DELETE FROM "${TABLE}"`);
      await db.query(`DROP INDEX IF EXISTS "${root.name}"`);
      for (const sql of strategy.generateIndexes({
        ...schema,
        indexes: [{ ...root, where: undefined }],
      }))
        await db.query(sql);
      const comparer = new SchemaComparer(db, {
        engineHint: engine as 'sqlite' | 'postgres',
      });
      const diff = await comparer.compare({ [TABLE]: schema });
      expect(diff.changes.some((change) => change.type === 'drop_index')).toBe(
        true,
      );
      expect(diff.changes.some((change) => change.type === 'add_index')).toBe(
        true,
      );
      for (const sql of getSQLFromDiff(diff)) await db.query(sql);
      const collection = await HolidaysPersistence3456.create({ db });
      const first = await collection.create({
        slug: 'migration',
        date: '2026-04-01',
        name: 'Migrated',
        tenantId: '11111111-1111-4111-8111-111111111111',
      });
      const second = await collection.create({
        slug: 'migration',
        date: '2026-05-01',
        name: 'Migrated',
        tenantId: first.tenantId,
      });
      expect(second.id).not.toBe(first.id);
      const repaired = await new SchemaComparer(db, {
        engineHint: engine as 'sqlite' | 'postgres',
      }).compare({ [TABLE]: schema });
      expect(
        repaired.changes.filter(
          (change) =>
            change.type === 'drop_index' || change.type === 'add_index',
        ),
      ).toEqual([]);
    });
  });
}
