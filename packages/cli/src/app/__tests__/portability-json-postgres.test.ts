/**
 * Logical import of JSON columns on real PostgreSQL (#3839).
 *
 * node-postgres parses json/jsonb into JavaScript values on export, and binds a
 * JavaScript array parameter as a PostgreSQL array literal: before the fix a
 * `["x"]` jsonb value failed import with 22P02 and `[]` came back as `{}`.
 * This exports rows exactly as `exportApplication` reads them, re-imports them
 * through `executeImportPlan`, and asserts every value round-trips, while a
 * real `text[]` column still binds as an array.
 *
 * Skipped unless `SMRT_TEST_POSTGRES_URL` (or `DATABASE_URL`) is set; run it
 * through `pnpm --filter @happyvertical/smrt-cli test:postgres`.
 */
import { randomBytes } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { executeImportPlan } from '../portability.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

const ROWS = [
  { id: 'array', doc: ['x'], plain: ['x', 'y'], labels: ['a', 'b'] },
  { id: 'empty-array', doc: [], plain: [], labels: [] },
  {
    id: 'object',
    doc: { a: [1, { b: null }], c: 'd' },
    plain: {},
    labels: null,
  },
  {
    id: 'string',
    doc: 's',
    plain: 'quote " and {brace}',
    labels: ['{', '"'],
  },
  { id: 'number', doc: 42, plain: 1.5, labels: null },
  { id: 'boolean', doc: true, plain: false, labels: null },
  { id: 'null', doc: null, plain: null, labels: null },
];

describe.skipIf(!pgUrl)(
  'logical import of JSON columns (real PostgreSQL)',
  () => {
    it('round-trips jsonb/json arrays, empty arrays, objects and scalars', async () => {
      const db = await getDatabase({ type: 'postgres', url: pgUrl as string });
      const table = `portability_json_${randomBytes(4).toString('hex')}`;
      const columns = ['id', 'doc', 'plain', 'labels'];
      try {
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, doc jsonb, plain json, labels text[])`,
        );
        for (const row of ROWS) {
          await db.query(
            `INSERT INTO "${table}" (id, doc, plain, labels) VALUES ($1, $2::jsonb, $3::json, $4)`,
            row.id,
            row.doc === null ? null : JSON.stringify(row.doc),
            row.plain === null ? null : JSON.stringify(row.plain),
            row.labels,
          );
        }
        const select = `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY id`;
        const exported = (await db.query(select)).rows;
        const expected = [...ROWS].sort((left, right) =>
          left.id < right.id ? -1 : 1,
        );
        expect(exported).toEqual(expected);
        await db.query(`DELETE FROM "${table}"`);
        await db.transaction?.((tx) =>
          executeImportPlan(
            tx,
            [
              {
                name: table,
                columns,
                columnDefinitions: {
                  id: { type: 'TEXT', primaryKey: true },
                  doc: { type: 'JSON' },
                  plain: { type: 'JSON' },
                  labels: { type: 'TEXT' },
                },
                foreignKeys: [],
                primaryKeys: ['id'],
                deferredColumns: new Set(),
              },
            ],
            new Map([[table, { rows: exported }]]),
          ),
        );
        expect((await db.query(select)).rows).toEqual(expected);
      } finally {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.close?.();
      }
    });
  },
);
