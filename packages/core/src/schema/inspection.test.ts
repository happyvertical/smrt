import { describe, expect, it, vi } from 'vitest';
import { getTestDatabase } from '../testing/database.js';
import { inspectTableSchema } from './inspection.js';

it('reuses the public adapter inspector for SQLite', async () => {
  const db = await getTestDatabase({ classes: [], includeSystemTables: false });
  try {
    await db.query(
      'CREATE TABLE inspect_sqlite (id TEXT PRIMARY KEY, value INTEGER)',
    );
    const read = vi.spyOn(db, 'getTableSchema');
    expect(
      (await inspectTableSchema(db, 'inspect_sqlite', 'sqlite'))?.columns,
    ).toHaveProperty('value');
    expect(read).toHaveBeenCalledWith('inspect_sqlite');
  } finally {
    await db.close?.();
  }
});

describe.runIf(process.env.SMRT_TEST_PGLITE === '1')(
  'transaction-bound PostgreSQL inspection',
  () => {
    it('sees uncommitted quoted tables, native columns, FK actions and indexes only on its transaction', async () => {
      const db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      try {
        const rootQuery = vi
          .spyOn(db, 'query')
          .mockRejectedValue(new Error('pooled query forbidden'));
        const rootInspector = vi
          .spyOn(db, 'getTableSchema')
          .mockRejectedValue(new Error('pooled inspection forbidden'));
        await expect(
          db.transaction!(async (tx) => {
            await tx.query('CREATE TABLE parent (id UUID PRIMARY KEY)');
            await tx.query(`CREATE TABLE "Mixed ""Table" (
          id UUID PRIMARY KEY, "order" BIGINT NOT NULL DEFAULT 0,
          parent_id UUID REFERENCES parent(id) ON DELETE SET NULL ON UPDATE CASCADE)`);
            await tx.query(
              'CREATE INDEX partial_order ON "Mixed ""Table" ("order" DESC) WHERE parent_id IS NOT NULL',
            );
            const schema = await inspectTableSchema(
              tx,
              'Mixed "Table',
              'postgres',
            );
            expect(schema?.columns).toMatchObject({
              id: { type: 'uuid', primaryKey: true },
              order: { type: 'bigint', notNull: true, defaultValue: '0' },
              parent_id: { type: 'uuid' },
            });
            expect(schema?.indexes).toContainEqual(
              expect.objectContaining({
                name: 'partial_order',
                columns: ['order'],
                where: expect.stringContaining('IS NOT NULL'),
              }),
            );
            expect(schema?.foreignKeys).toEqual([
              {
                column: 'parent_id',
                referencesTable: 'parent',
                referencesColumn: 'id',
                onDelete: 'SET NULL',
                onUpdate: 'CASCADE',
              },
            ]);
            await tx.query(
              'ALTER TABLE "Mixed ""Table" ADD COLUMN fresh BOOLEAN',
            );
            expect(
              (await inspectTableSchema(tx, 'Mixed "Table', 'postgres'))
                ?.columns,
            ).toHaveProperty('fresh');
            expect(
              await inspectTableSchema(
                tx,
                'missing"; DROP TABLE parent; --',
                'postgres',
              ),
            ).toBeNull();
            expect(rootQuery).not.toHaveBeenCalled();
            expect(rootInspector).not.toHaveBeenCalled();
            throw new Error('roll back inspection fixture');
          }),
        ).rejects.toThrow('roll back inspection fixture');
        rootQuery.mockRestore();
        rootInspector.mockRestore();
        expect(
          (
            await db.query(
              "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1",
              ['Mixed "Table'],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        await db.close?.();
      }
    });
  },
);
