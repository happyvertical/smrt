/**
 * #3226 against a live PostgreSQL server: a nullable legacy `text` column
 * whose only non-castable values are empty text converges to its typed
 * column under the opt-in `emptyTextAsNull`, storing those values as NULL.
 * Without the opt-in the advisory names the empty-text count; any other
 * bad value, and any NOT NULL column, still blocks.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { probeCastSafety } from './text-cast-probe.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!pgUrl)(
  'PostgreSQL empty text -> NULL convergence opt-in (#3226)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    const table = `i3226_contents_${suffix}`;

    const schema = (
      options: { notNull?: boolean } = {},
    ): Record<string, SchemaDefinition> => ({
      [table]: {
        tableName: table,
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          published_at: {
            type: 'TIMESTAMP',
            ...(options.notNull ? { notNull: true } : {}),
          },
          payload: { type: 'JSON' },
          position: { type: 'INTEGER' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '3226',
      },
    });

    async function createFixture(
      rows: [string, string | null, string | null, string | null][],
      options: { notNull?: boolean } = {},
    ): Promise<void> {
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
      await db.query(
        `CREATE TABLE "${table}" (id text PRIMARY KEY, ` +
          `published_at text${options.notNull ? ' NOT NULL' : ''}, ` +
          'payload text, position text)',
      );
      for (const row of rows) {
        await db.query(
          `INSERT INTO "${table}" (id, published_at, payload, position) VALUES ($1, $2, $3, $4)`,
          row,
        );
      }
    }

    async function liveTypes(): Promise<Record<string, string>> {
      const result = await db.query(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1',
        [table],
      );
      return Object.fromEntries(
        (result.rows as { column_name: string; data_type: string }[]).map(
          (row) => [row.column_name, row.data_type],
        ),
      );
    }

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-3226-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0]);
    });

    afterAll(async () => {
      await db?.query(`DROP TABLE IF EXISTS "${table}"`);
      await db?.close?.();
    });

    it('probe counts empty text separately and samples it as an empty string', async () => {
      await createFixture([
        ['a', '2026-01-02T03:04:05Z', '{"a":1}', '1'],
        ['b', '', '', ''],
        ['c', '   ', null, null],
        ['d', null, null, null],
      ]);

      const probe = await probeCastSafety(
        db,
        table,
        'published_at',
        'timestamptz',
      );
      expect(probe).toMatchObject({
        status: 'dirty',
        count: 2,
        emptyCount: 2,
        sample: '',
      });
    });

    it('without the opt-in, blocks and names the empty-text count', async () => {
      await createFixture([
        ['a', '2026-01-02T03:04:05Z', '{"a":1}', '1'],
        ['b', '', '', ''],
      ]);

      const diff = await new SchemaComparer(db).compare(schema());
      const upgrade = diff.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === 'published_at',
      );
      expect(upgrade?.sql).toBeUndefined();
      expect(upgrade?.advisory?.message).toContain('(sample: (empty))');
      expect(upgrade?.advisory?.message).toContain("All 1 are empty text ('')");
      expect(upgrade?.advisory?.message).toContain('--empty-text-as-null');
      expect(upgrade?.advisory?.suggestedSql?.join('\n')).toContain(
        'CASE WHEN btrim',
      );
      const jsonUpgrade = diff.changes.find(
        (change) => change.type === 'type_upgrade' && change.name === 'payload',
      );
      expect(jsonUpgrade?.sql).toBeUndefined();
      expect(jsonUpgrade?.advisory?.message).toContain('--empty-text-as-null');
    });

    it('with the opt-in, converges: empty text becomes NULL, valid values are preserved, rerun is a no-op', async () => {
      await createFixture([
        ['a', '2026-01-02T03:04:05Z', '{"a":1}', ' 42 '],
        ['b', '', '', ''],
        ['c', ' \t', '  ', ' '],
        ['d', null, null, null],
      ]);

      const diff = await new SchemaComparer(db, {
        emptyTextAsNull: true,
      }).compare(schema());
      const upgrade = diff.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === 'published_at',
      );
      expect(upgrade?.note).toContain('2 empty-text value(s) become NULL');
      for (const statement of getSQLFromDiff(diff)) {
        await db.query(statement);
      }

      expect(await liveTypes()).toMatchObject({
        published_at: 'timestamp with time zone',
        payload: 'jsonb',
        position: 'bigint',
      });
      const rows = await db.query(
        `SELECT id, published_at, payload, position FROM "${table}" ORDER BY id`,
      );
      const byId = new Map(
        (rows.rows as Record<string, unknown>[]).map((row) => [row.id, row]),
      );
      expect(
        new Date(byId.get('a')?.published_at as string).toISOString(),
      ).toBe('2026-01-02T03:04:05.000Z');
      expect(byId.get('a')?.payload).toEqual({ a: 1 });
      expect(Number(byId.get('a')?.position)).toBe(42);
      for (const id of ['b', 'c', 'd']) {
        expect(byId.get(id)?.published_at).toBeNull();
        expect(byId.get(id)?.payload).toBeNull();
        expect(byId.get(id)?.position).toBeNull();
      }

      const rerun = await new SchemaComparer(db, {
        emptyTextAsNull: true,
      }).compare(schema());
      expect(getSQLFromDiff(rerun)).toEqual([]);
    });

    it('with the opt-in, any other non-castable value still blocks', async () => {
      await createFixture([
        ['a', 'not a date', null, null],
        ['b', '', null, null],
      ]);

      const diff = await new SchemaComparer(db, {
        emptyTextAsNull: true,
      }).compare(schema());
      const upgrade = diff.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === 'published_at',
      );
      expect(upgrade?.sql).toBeUndefined();
      expect(upgrade?.advisory?.message).toContain('2 live value(s)');
      expect(upgrade?.advisory?.message).toContain(
        "1 of them are empty text ('')",
      );
      expect(upgrade?.advisory?.message).not.toContain('(sample: (empty))');
    });

    it('with the opt-in, a NOT NULL column still blocks', async () => {
      await createFixture(
        [
          ['a', '2026-01-02T03:04:05Z', null, null],
          ['b', '', null, null],
        ],
        { notNull: true },
      );

      const diff = await new SchemaComparer(db, {
        emptyTextAsNull: true,
      }).compare(schema({ notNull: true }));
      const upgrade = diff.changes.find(
        (change) =>
          change.type === 'type_upgrade' && change.name === 'published_at',
      );
      expect(upgrade?.sql).toBeUndefined();
      expect(upgrade?.advisory?.message).toContain('The column is NOT NULL');
    });
  },
);
