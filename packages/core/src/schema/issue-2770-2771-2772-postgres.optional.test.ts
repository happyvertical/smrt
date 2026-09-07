/**
 * #2770, #2771, #2772 against a live PostgreSQL server.
 *
 * The mocked/in-memory unit tests in `live-parity.test.ts` and
 * `migrations/__tests__/differ.test.ts` prove the detection and planning
 * logic; these prove it against the exact reproduction fixture the issues
 * carry (a "tag_aliases" table with SQLite-flavored text columns that an
 * older smrt version created on PostgreSQL) and a real PostgreSQL server for
 * the float-width and jsonb/uuid visibility checks that only apply there.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { checkLiveSchemaParity } from './live-parity.js';
import { probeCastSafety } from './text-cast-probe.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!pgUrl)(
  'PostgreSQL float/timestamptz/jsonb convergence (#2770, #2771, #2772)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2770-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0]);
    });

    afterAll(async () => {
      await db?.close?.();
    });

    describe('#2770 float-width drift', () => {
      const table = `i2770_products_${suffix}`;
      const schema = (): Record<string, SchemaDefinition> => ({
        [table]: {
          tableName: table,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            price: { type: 'REAL' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2770',
        },
      });

      afterAll(async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      });

      it('flags live single-precision vs declared double-precision, then converges and is a no-op on rerun', async () => {
        await db.query(
          `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, price REAL)`,
        );
        await db.query(`INSERT INTO "${table}" (id, price) VALUES ('p1', 1.5)`);

        const before = await checkLiveSchemaParity({
          db,
          schemas: schema(),
          includeSystemTables: false,
        });
        const drift = before.findings.find(
          (finding) =>
            finding.kind === 'column_type_drift' && finding.target === 'price',
        );
        expect(drift?.severity).toBe('warning');
        expect(drift?.message).toContain('single-precision');

        const diff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(schema());
        const sql = getSQLFromDiff(diff);
        expect(sql.length).toBeGreaterThan(0);
        for (const statement of sql) {
          await db.query(statement);
        }

        const row = await db.query(
          `SELECT price FROM "${table}" WHERE id = 'p1'`,
        );
        expect(Number(row.rows?.[0]?.price)).toBeCloseTo(1.5);

        const after = await checkLiveSchemaParity({
          db,
          schemas: schema(),
          includeSystemTables: false,
        });
        expect(
          after.findings.find(
            (finding) =>
              finding.kind === 'column_type_drift' &&
              finding.target === 'price',
          ),
        ).toBeUndefined();

        const rerunDiff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(schema());
        expect(getSQLFromDiff(rerunDiff)).toEqual([]);
      });
    });

    describe('probeCastSafety catches shape-valid but semantically-invalid values', () => {
      // A prior review pass flagged that a pure regex "shape" probe accepts
      // an invalid-calendar timestamp and a bracket-balanced-but-malformed
      // JSON document, since neither failure is expressible as a regex.
      // probeCastSafety() runs a real, exception-safe cast attempt instead
      // (see text-cast-probe.ts), so both must be rejected here.
      const table = `i2771_2772_adversarial_${suffix}`;

      afterAll(async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      });

      it('rejects an invalid-calendar timestamp that satisfies an ISO-8601 shape regex', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, bad_date text)`,
        );
        // February 30th does not exist; the shape (YYYY-MM-DDTHH:MM:SS.sssZ)
        // is otherwise indistinguishable from a valid instant.
        await db.query(
          `INSERT INTO "${table}" (id, bad_date) VALUES ('r1', '2023-02-30T10:00:00.000Z')`,
        );

        const result = await probeCastSafety(
          db,
          table,
          'bad_date',
          'timestamptz',
        );
        expect(result.status).toBe('dirty');
        if (result.status === 'dirty') {
          expect(result.count).toBe(1);
          expect(result.sample).toBe('2023-02-30T10:00:00.000Z');
        }
      });

      it('rejects a bracket-balanced but syntactically invalid JSON document', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, bad_json text)`,
        );
        // Missing closing brace after the nested object; a naive `\{.*\}`
        // shape regex still matches because the string contains a `{` and
        // ends in a `}` (the nested object's).
        await db.query(
          `INSERT INTO "${table}" (id, bad_json) VALUES ('r1', '{"a": {"b": 1}')`,
        );

        const result = await probeCastSafety(db, table, 'bad_json', 'jsonb');
        expect(result.status).toBe('dirty');
        if (result.status === 'dirty') {
          expect(result.count).toBe(1);
        }
      });

      it('accepts valid values for both target types', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, good_date text, good_json text)`,
        );
        await db.query(
          `INSERT INTO "${table}" (id, good_date, good_json) VALUES ` +
            `('r1', '2023-01-15T10:00:00.000Z', '{"a": {"b": 1}}')`,
        );

        const dateResult = await probeCastSafety(
          db,
          table,
          'good_date',
          'timestamptz',
        );
        expect(dateResult.status).toBe('clean');
        const jsonResult = await probeCastSafety(
          db,
          table,
          'good_json',
          'jsonb',
        );
        expect(jsonResult.status).toBe('clean');
      });
    });

    describe('#2771/#2772 reproduction fixture (tag_aliases)', () => {
      const table = `tag_aliases_${suffix}`;

      const schema = (): Record<string, SchemaDefinition> => ({
        [table]: {
          tableName: table,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            slug: { type: 'TEXT' },
            context: { type: 'TEXT' },
            created_at: { type: 'TIMESTAMP' },
            updated_at: { type: 'TIMESTAMP' },
            _meta_type: { type: 'TEXT' },
            _meta_data: { type: 'JSON' },
            tag_slug: { type: 'TEXT' },
            alias: { type: 'TEXT' },
            language: { type: 'TEXT' },
            tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2771',
        },
      });

      afterAll(async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      });

      it('applies the fixture, converges via status -> migrate -> status -> migrate, and preserves rows', async () => {
        // Reproduction fixture from #2771/#2772: a table smrt itself would
        // create, but whose live columns carry SQLite-flavored types an
        // older smrt version emitted before targeting Postgres natively.
        await db.query(`
          CREATE TABLE "${table}" (
            id text PRIMARY KEY,
            slug text NOT NULL,
            context text NOT NULL DEFAULT '',
            created_at text NOT NULL,
            updated_at text NOT NULL,
            _meta_type text NOT NULL,
            _meta_data text,
            tag_slug text DEFAULT '',
            alias text DEFAULT '',
            language text DEFAULT '',
            tenant_id text
          )
        `);
        await db.query(`
          INSERT INTO "${table}" (id, slug, context, created_at, updated_at, _meta_type, _meta_data, tag_slug, alias, language, tenant_id) VALUES
            ('11111111-1111-4111-8111-111111111111', 'electronics-alias-1', '', '2023-01-15T10:00:00.000Z', '2023-01-15T10:00:00.000Z', 'TagAlias', '{"source":"legacy-import"}', 'electronics', 'Electronica', 'es', '99999999-9999-4999-8999-999999999999'),
            ('22222222-2222-4222-8222-222222222222', 'books-alias-1', '', '2023-02-20T08:30:00.000Z', '2023-02-20T08:30:00.000Z', 'TagAlias', '{"source":"legacy-import"}', 'books', 'Livres', 'fr', '99999999-9999-4999-8999-999999999999'),
            ('33333333-3333-4333-8333-333333333333', 'refurbished-alias-1', '', '2023-03-05T14:45:00.000Z', '2023-03-05T14:45:00.000Z', 'TagAlias', '{"source":"legacy-import"}', 'refurbished', 'Generalüberholt', 'de', NULL)
        `);

        // status: db:status must now flag the timestamp and jsonb drift
        // (#2771, #2772) that used to be invisible/permanently blocked.
        const before = await checkLiveSchemaParity({
          db,
          schemas: schema(),
          includeSystemTables: false,
        });
        const jsonDrift = before.findings.find(
          (finding) =>
            finding.kind === 'column_type_drift' &&
            finding.target === '_meta_data',
        );
        expect(jsonDrift?.severity).toBe('warning');
        const uuidInfo = before.findings.find(
          (finding) =>
            finding.kind === 'column_type_drift' && finding.target === 'id',
        );
        expect(uuidInfo?.severity).toBe('info');
        expect(uuidInfo?.recommendation).toContain('db:migrate-uuid');

        // migrate: the differ plans the executable timestamptz/jsonb
        // conversions (the uuid conversions are `db:migrate-uuid`'s job, out
        // of scope for this differ pass with UUID/TEXT tolerance).
        const diff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(schema());
        const timestampUpgrade = diff.changes.find(
          (change) =>
            change.type === 'type_upgrade' &&
            (change.name === 'created_at' || change.name === 'updated_at'),
        );
        expect(timestampUpgrade).toBeDefined();
        const jsonUpgrade = diff.changes.find(
          (change) =>
            change.type === 'type_upgrade' && change.name === '_meta_data',
        );
        expect(jsonUpgrade).toBeDefined();

        for (const statement of getSQLFromDiff(diff)) {
          await db.query(statement);
        }

        // status again: converged columns must no longer appear as drift.
        const afterMigrate = await checkLiveSchemaParity({
          db,
          schemas: schema(),
          includeSystemTables: false,
        });
        expect(
          afterMigrate.findings.find(
            (finding) =>
              finding.kind === 'column_type_drift' &&
              (finding.target === 'created_at' ||
                finding.target === 'updated_at' ||
                finding.target === '_meta_data'),
          ),
        ).toBeUndefined();

        // migrate again: no-op.
        const rerunDiff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(schema());
        expect(
          rerunDiff.changes.filter(
            (change) =>
              change.type === 'type_upgrade' &&
              ['created_at', 'updated_at', '_meta_data'].includes(
                change.name ?? '',
              ),
          ),
        ).toEqual([]);

        // Rows survive intact: the timestamps still parse to the same
        // instants and the JSON metadata still round-trips.
        const rows = await db.query(
          `SELECT id, created_at, _meta_data FROM "${table}" ORDER BY id`,
        );
        expect(rows.rows).toHaveLength(3);
        const first = rows.rows?.[0] as {
          created_at: string | Date;
          _meta_data: unknown;
        };
        expect(new Date(first.created_at).toISOString()).toBe(
          '2023-01-15T10:00:00.000Z',
        );
        expect(first._meta_data).toEqual({ source: 'legacy-import' });
      });
    });
  },
);
