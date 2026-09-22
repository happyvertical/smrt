/**
 * #3041 against a live PostgreSQL server: a native `json` column whose
 * manifest declares `JSON` (mapped to `jsonb` on PostgreSQL) used to be
 * invisible to `db:status` / `db:diff` / `db:migrate`, because `json` and
 * `jsonb` share one comparison bucket. `json` has no equality operator, so a
 * drifted column breaks `SELECT DISTINCT` / `GROUP BY` with SQLSTATE 42883
 * while a manifest-built database (`jsonb`) never reproduces it.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { checkLiveSchemaParity } from './live-parity.js';
import type { ColumnDefinition, SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!pgUrl)(
  'PostgreSQL live json vs declared jsonb drift (#3041)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    const created: string[] = [];

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-3041-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0]);
    });

    afterAll(async () => {
      for (const table of created) {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      }
      await db?.close?.();
    });

    const schemaFor = (
      table: string,
      columns: Record<string, ColumnDefinition>,
    ): Record<string, SchemaDefinition> => ({
      [table]: {
        tableName: table,
        columns: { id: { type: 'TEXT', primaryKey: true }, ...columns },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '3041',
      },
    });

    const liveType = async (table: string, column: string) => {
      const result = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      return result.rows?.[0]?.data_type as string | undefined;
    };

    const jsonTypeDrift = (
      findings: Awaited<ReturnType<typeof checkLiveSchemaParity>>['findings'],
      column: string,
    ) =>
      findings.find(
        (finding) =>
          finding.kind === 'column_type_drift' && finding.target === column,
      );

    it('reports, converges, and is a no-op on rerun for a json _meta_data column', async () => {
      const table = `i3041_accounts_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, _meta_data json)`,
      );
      await db.query(
        `INSERT INTO "${table}" (id, _meta_data) VALUES
           ('a1', '{"kind":"advertiser","n":1}'),
           ('a2', '{"kind":"advertiser","n":1}'),
           ('a3', NULL)`,
      );
      const schema = schemaFor(table, { _meta_data: { type: 'JSON' } });

      // The 42883 failure mode the drift causes.
      await expect(
        db.query(`SELECT DISTINCT _meta_data FROM "${table}"`),
      ).rejects.toThrow(/equality operator for type json/);

      const before = await checkLiveSchemaParity({
        db,
        schemas: schema,
        includeSystemTables: false,
      });
      const finding = jsonTypeDrift(before.findings, '_meta_data');
      expect(finding?.severity).toBe('warning');
      expect(finding?.details).toMatchObject({ actual: 'json' });

      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      const upgrade = diff.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === '_meta_data',
      );
      expect(upgrade?.advisory).toBeUndefined();
      // The preview names the engine type, not a case-only `json -> JSON`.
      expect(upgrade?.mismatch?.expected).toBe('JSONB');
      const sql = getSQLFromDiff(diff);
      expect(sql).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "_meta_data" TYPE jsonb USING "_meta_data"::jsonb`,
      ]);
      for (const statement of sql) await db.query(statement);

      expect(await liveType(table, '_meta_data')).toBe('jsonb');
      const distinct = await db.query(
        `SELECT DISTINCT _meta_data FROM "${table}" WHERE _meta_data IS NOT NULL`,
      );
      expect(distinct.rows).toHaveLength(1);

      const after = await checkLiveSchemaParity({
        db,
        schemas: schema,
        includeSystemTables: false,
      });
      expect(jsonTypeDrift(after.findings, '_meta_data')).toBeUndefined();
      const rerun = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      expect(getSQLFromDiff(rerun)).toEqual([]);
    });

    it('drops and restores a manifest-declared default around the conversion', async () => {
      const table = `i3041_defaulted_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, tags json DEFAULT '[]'::json)`,
      );
      await db.query(`INSERT INTO "${table}" (id) VALUES ('t1')`);
      const schema = schemaFor(table, {
        tags: { type: 'JSON', defaultValue: [] },
      });

      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      const sql = getSQLFromDiff(diff);
      expect(sql[0]).toBe(
        `ALTER TABLE "${table}" ALTER COLUMN "tags" DROP DEFAULT`,
      );
      expect(sql[1]).toBe(
        `ALTER TABLE "${table}" ALTER COLUMN "tags" TYPE jsonb USING "tags"::jsonb`,
      );
      expect(sql[2]).toMatch(/SET DEFAULT .*::jsonb$/);
      for (const statement of sql) await db.query(statement);

      expect(await liveType(table, 'tags')).toBe('jsonb');
      await db.query(`INSERT INTO "${table}" (id) VALUES ('t2')`);
      const row = await db.query(
        `SELECT tags::text AS tags FROM "${table}" WHERE id = 't2'`,
      );
      expect(row.rows?.[0]?.tags).toBe('[]');
      const rerun = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      expect(getSQLFromDiff(rerun)).toEqual([]);
    });

    it('gates dropping a live-only default behind relaxColumns', async () => {
      const table = `i3041_live_default_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, metadata json DEFAULT '{}'::json)`,
      );
      const schema = schemaFor(table, { metadata: { type: 'JSON' } });

      const strict = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      const blocked = strict.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === 'metadata',
      );
      expect(blocked?.advisory?.severity).toBe('warning');
      expect(
        getSQLFromDiff(strict).some((statement) =>
          statement.includes('"metadata"'),
        ),
      ).toBe(false);

      const relaxed = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
        relaxColumns: true,
      }).compare(schema);
      for (const statement of getSQLFromDiff(relaxed)) {
        await db.query(statement);
      }
      expect(await liveType(table, 'metadata')).toBe('jsonb');
    });

    it('fails closed with a masked sample when a json value cannot become jsonb', async () => {
      const table = `i3041_dirty_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, payload json)`,
      );
      // `json` stores the \u0000 escape verbatim; `jsonb` rejects it.
      await db.query(
        `INSERT INTO "${table}" (id, payload) VALUES ('d1', '{"v":"a\\u0000b"}')`,
      );
      const schema = schemaFor(table, { payload: { type: 'JSON' } });

      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      const blocked = diff.changes.find(
        (change) => change.type === 'type_upgrade' && change.name === 'payload',
      );
      expect(blocked?.advisory?.severity).toBe('warning');
      expect(blocked?.advisory?.message).toContain('1 live value(s)');
      expect(blocked?.advisory?.message).not.toContain('a\\u0000b');
      expect(getSQLFromDiff(diff)).toEqual([]);
      expect(await liveType(table, 'payload')).toBe('json');
    });

    it('keeps reporting default drift on a column whose conversion is blocked', async () => {
      const table = `i3041_dirty_default_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, payload json DEFAULT '{}'::json)`,
      );
      await db.query(
        `INSERT INTO "${table}" (id, payload) VALUES ('d1', '{"v":"a\\u0000b"}')`,
      );
      const schema = schemaFor(table, { payload: { type: 'JSON' } });

      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      const payloadChanges = diff.changes.filter(
        (change) => change.name === 'payload',
      );
      expect(
        payloadChanges.some((change) => change.type === 'type_upgrade'),
      ).toBe(true);
      expect(
        payloadChanges.some((change) => change.type !== 'type_upgrade'),
      ).toBe(true);
    });

    it('keeps tolerating a native json column behind a TEXT manifest field (#1335)', async () => {
      const table = `i3041_text_manifest_${suffix}`;
      created.push(table);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, notes json)`,
      );
      const schema = schemaFor(table, { notes: { type: 'TEXT' } });

      const parity = await checkLiveSchemaParity({
        db,
        schemas: schema,
        includeSystemTables: false,
      });
      expect(jsonTypeDrift(parity.findings, 'notes')).toBeUndefined();
      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(schema);
      expect(getSQLFromDiff(diff)).toEqual([]);
    });
  },
);
