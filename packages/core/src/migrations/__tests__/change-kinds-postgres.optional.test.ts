/** Real PostgreSQL counterpart to change-kinds.test.ts; no external service is started. */
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { classifySchemaChange, decideSchemaChange } from '../change-kinds.js';
import { SchemaComparer } from '../differ.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const table = 'change_kinds_4925';
const parent = 'change_kinds_parent_4925';
const current = (columns: SchemaDefinition['columns']): SchemaDefinition => ({
  tableName: table,
  columns: { id: { type: 'TEXT', primaryKey: true }, ...columns },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4925',
});

describe.skipIf(!pgUrl)(
  'schema change kinds on real PostgreSQL (#4925)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    beforeAll(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl });
    });
    const clean = async () => {
      await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await db.query(`DROP TABLE IF EXISTS "${parent}" CASCADE`);
    };
    afterEach(clean);
    afterAll(async () => {
      await clean();
      await db.close?.();
    });

    async function compare(schema: SchemaDefinition) {
      const changes = (
        await new SchemaComparer(db, { engineHint: 'postgres' }).compare({
          [table]: schema,
        })
      ).changes;
      for (const change of changes)
        expect(classifySchemaChange(change)).not.toBe('unlisted');
      return changes;
    }

    it('distinguishes live NULLs, a required missing column, and executable NOT NULL', async () => {
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, missing_value TEXT, existing_value TEXT)`,
      );
      await db.query(`INSERT INTO "${table}" VALUES ('one', NULL, 'retained')`);
      const changes = await compare(
        current({
          missing_value: { type: 'TEXT', notNull: true },
          existing_value: { type: 'TEXT', notNull: true },
          required: { type: 'TEXT', notNull: true },
        }),
      );
      expect(changes.map(classifySchemaChange)).toEqual(
        expect.arrayContaining([
          'column.required-nulls',
          'column.required-missing',
          'column.set-not-null',
        ]),
      );
    });

    it.each([
      ['JSON', 'not json', 'type.invalid-json'],
      ['TIMESTAMP', 'not a timestamp', 'type.invalid-timestamp'],
    ] as const)('refuses invalid text-to-%s values', async (type, value, kind) => {
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, value TEXT)`,
      );
      await db.query(`INSERT INTO "${table}" VALUES ('one', $1)`, [value]);
      const changes = await compare(current({ value: { type } }));
      expect(changes.map(classifySchemaChange)).toContain(kind);
      expect(
        changes.find((change) => classifySchemaChange(change) === kind),
      ).toBeDefined();
    });

    it('stops for orphan references and names the child column with the data reason', async () => {
      await db.query(`CREATE TABLE "${parent}" (id TEXT PRIMARY KEY)`);
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, parent_id TEXT)`,
      );
      await db.query(`INSERT INTO "${table}" VALUES ('one', 'missing')`);
      const schema = current({ parent_id: { type: 'TEXT' } });
      schema.foreignKeys = [
        {
          column: 'parent_id',
          referencesTable: parent,
          referencesColumn: 'id',
        },
      ];
      const changes = await compare(schema);
      const change = changes.find((change) => change.orphanBlocked);
      expect(change).toBeDefined();
      if (!change) throw new Error('Missing expected orphan FK change');
      const verdict = decideSchemaChange(change, 'postgres');
      expect(verdict.kind).toBe('foreign-key.orphans');
      expect(verdict.message).toContain(`${table}.parent_id: would lose data`);
    });

    it('keeps a live-constraint UUID convergence refusal as a non-data exception', async () => {
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, parent_id UUID)`,
      );
      await db.query(
        `CREATE TABLE "${parent}" (id TEXT PRIMARY KEY REFERENCES "${table}" (id))`,
      );
      const schema = current({
        id: { type: 'UUID', primaryKey: true },
        parent_id: { type: 'UUID' },
      });
      schema.foreignKeys = [
        { column: 'parent_id', referencesTable: table, referencesColumn: 'id' },
      ];
      const changes = await compare(schema);
      expect(changes.map(classifySchemaChange)).toEqual(
        expect.arrayContaining([
          'type.uuid-constraints-unavailable',
          'foreign-key.type-convergence-unavailable',
        ]),
      );
    });

    it('adds a foreign key with no orphans and reports a disabled foreign key as an exception', async () => {
      await db.query(`CREATE TABLE "${parent}" (id TEXT PRIMARY KEY)`);
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, parent_id TEXT)`,
      );
      const schema = current({ parent_id: { type: 'TEXT' } });
      schema.foreignKeys = [
        {
          column: 'parent_id',
          referencesTable: parent,
          referencesColumn: 'id',
        },
      ];
      const change = (await compare(schema)).find(
        (change) => change.type === 'add_foreign_key',
      );
      expect(change && classifySchemaChange(change)).toBe('foreign-key.add');
      for (const sql of change?.sqlStatements ?? []) await db.query(sql);
      schema.foreignKeys[0].engines = ['sqlite'];
      const disabled = (await compare(schema)).find(
        (change) => change.type === 'drop_foreign_key',
      );
      expect(disabled && classifySchemaChange(disabled)).toBe(
        'foreign-key.drop-unavailable',
      );
    });
  },
);
