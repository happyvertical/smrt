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

      // Review finding on the fix above: a bare real-cast attempt alone
      // accepts PostgreSQL's session-dependent naive timestamps and its
      // "special" relative date/time keywords, since both cast successfully
      // -- but the resulting instant depends on the *casting session's*
      // TimeZone or is evaluated at cast time, so `USING col::timestamptz`
      // would silently corrupt or reinterpret the data. The probe must
      // reject both, routing them to the explicit `--legacy-timezone=UTC`
      // opt-in instead of auto-converging.
      it('rejects session-dependent naive timestamps and PostgreSQL special values', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, value text)`,
        );
        const naiveAndSpecialValues = [
          '2023-01-15 10:00:00',
          '2023-01-15',
          '01/02/2023',
          'now',
          'today',
          'yesterday',
          'tomorrow',
          'epoch',
          'infinity',
          '-infinity',
          'allballs',
        ];
        for (const [index, value] of naiveAndSpecialValues.entries()) {
          await db.query(
            `INSERT INTO "${table}" (id, value) VALUES ('r${index}', $1)`,
            [value],
          );
        }

        const result = await probeCastSafety(db, table, 'value', 'timestamptz');
        expect(result.status).toBe('dirty');
        if (result.status === 'dirty') {
          expect(result.count).toBe(naiveAndSpecialValues.length);
        }
      });

      it('still accepts explicit-offset timestamps of every supported shape', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, value text)`,
        );
        const explicitOffsetValues = [
          '2023-01-15T10:00:00.000Z',
          '2023-01-15T10:00:00+05:00',
          '2023-01-15T10:00:00-05:30',
          '2023-01-15 10:00:00Z',
        ];
        for (const [index, value] of explicitOffsetValues.entries()) {
          await db.query(
            `INSERT INTO "${table}" (id, value) VALUES ('r${index}', $1)`,
            [value],
          );
        }

        const result = await probeCastSafety(db, table, 'value', 'timestamptz');
        expect(result.status).toBe('clean');
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

    describe('column default is restored after conversion (review finding)', () => {
      // Review finding: PostgreSQL requires DROP DEFAULT before ALTER
      // COLUMN ... TYPE, and the new probe-based conversion helpers emitted
      // that DROP but never the compensating SET DEFAULT, unlike the
      // pre-existing generateTypeUpgradeSQL path. A column with a manifest
      // default (SMRT's own generator emits exactly this for created_at/
      // updated_at: `current_timestamp`) would come out of a successful
      // `db:migrate` NOT NULL with no live default, breaking any writer
      // that relies on the database to supply it.
      const table = `i2771_2772_default_restore_${suffix}`;

      const schema = (): Record<string, SchemaDefinition> => ({
        [table]: {
          tableName: table,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              defaultValue: 'current_timestamp',
            },
            meta: { type: 'JSON', defaultValue: '{}' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2771-default',
        },
      });

      afterAll(async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      });

      it('restores SET DEFAULT for both timestamptz and jsonb conversions', async () => {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(`
          CREATE TABLE "${table}" (
            id text PRIMARY KEY,
            created_at text NOT NULL DEFAULT current_timestamp::text,
            meta text NOT NULL DEFAULT '{}'
          )
        `);
        await db.query(
          `INSERT INTO "${table}" (id, created_at, meta) VALUES ` +
            `('r1', '2023-01-15T10:00:00.000Z', '{"a":1}')`,
        );

        const diff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(schema());
        for (const statement of getSQLFromDiff(diff)) {
          await db.query(statement);
        }

        const liveDefaults = await db.query(
          `SELECT column_name, column_default FROM information_schema.columns ` +
            `WHERE table_name = $1 AND column_name IN ('created_at', 'meta')`,
          [table],
        );
        const defaultsByColumn = new Map(
          (
            liveDefaults.rows as {
              column_name: string;
              column_default: string | null;
            }[]
          ).map((row) => [row.column_name, row.column_default]),
        );
        expect(defaultsByColumn.get('created_at')).not.toBeNull();
        expect(defaultsByColumn.get('meta')).not.toBeNull();
        expect(defaultsByColumn.get('meta')).toContain('jsonb');

        // A writer that omits both columns must still get a value from the
        // live database default, not a NOT NULL violation.
        await db.query(`INSERT INTO "${table}" (id) VALUES ('r2')`);
        const inserted = await db.query(
          `SELECT created_at, meta FROM "${table}" WHERE id = 'r2'`,
        );
        expect(inserted.rows?.[0]?.created_at).toBeTruthy();
        expect(inserted.rows?.[0]?.meta).toEqual({});
      });
    });

    describe('live-only default (not declared by the manifest) is dropped, not resurrected (review finding F6)', () => {
      // Review finding (F6, second final full-diff pass): DROP DEFAULT was
      // gated on the *manifest* default only. PostgreSQL rejects
      // `ALTER COLUMN ... TYPE` whenever the column has ANY existing
      // default that can't auto-cast to the target type, regardless of
      // manifest intent -- so a legacy text column with a live default the
      // manifest does NOT declare (a common residue: a field whose default
      // was dropped from the model, or simply never modeled) previously
      // aborted the whole migration batch with "default for column ...
      // cannot be cast automatically to type jsonb/timestamptz".
      const liveOnlyTable = `i2771_2772_live_default_only_${suffix}`;
      const liveOnlySchema = (): Record<string, SchemaDefinition> => ({
        [liveOnlyTable]: {
          tableName: liveOnlyTable,
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            // No `defaultValue` here -- the manifest does not want a
            // default -- but the live column below has one anyway.
            tags: { type: 'JSON' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2771-live-default-only',
        },
      });

      afterAll(async () => {
        await db.query(`DROP TABLE IF EXISTS "${liveOnlyTable}"`);
      });

      // Review finding (repeat final full-diff pass): unconditionally
      // dropping a live-only default is the same "relaxation"
      // `compareColumnConstraints` already gates behind `relaxColumns`
      // elsewhere in this differ; auto-executing it here would silently
      // weaken the column (any external writer relying on the default now
      // gets NULL/23502) with no advisory and no opt-in. Without
      // `relaxColumns`, the conversion must stay a fail-closed advisory
      // instead -- never abort the batch (the original regression), but
      // never silently drop the default either.
      it('without relaxColumns, blocks with a fail-closed advisory and leaves the live default untouched', async () => {
        await db.query(`DROP TABLE IF EXISTS "${liveOnlyTable}"`);
        await db.query(`
          CREATE TABLE "${liveOnlyTable}" (
            id text PRIMARY KEY,
            tags text DEFAULT ''
          )
        `);
        await db.query(
          `INSERT INTO "${liveOnlyTable}" (id, tags) VALUES ('r1', '{"a":1}')`,
        );

        const diff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
        }).compare(liveOnlySchema());
        const typeUpgrade = diff.changes.find(
          (change) => change.type === 'type_upgrade' && change.name === 'tags',
        );
        expect(typeUpgrade).toBeDefined();
        expect(typeUpgrade?.sql).toBeUndefined();
        expect(typeUpgrade?.sqlStatements).toBeUndefined();
        expect(typeUpgrade?.advisory?.severity).toBe('warning');
        expect(typeUpgrade?.advisory?.message).toContain('live default');
        expect(typeUpgrade?.advisory?.message).toContain('relaxColumns');
        expect(getSQLFromDiff(diff)).toEqual([]);

        const liveDefault = await db.query(
          `SELECT column_default FROM information_schema.columns ` +
            `WHERE table_name = $1 AND column_name = 'tags'`,
          [liveOnlyTable],
        );
        expect(liveDefault.rows?.[0]?.column_default).not.toBeNull();
      });

      it('with relaxColumns, drops the live-only default and converges (does not abort the batch)', async () => {
        await db.query(`DROP TABLE IF EXISTS "${liveOnlyTable}"`);
        await db.query(`
          CREATE TABLE "${liveOnlyTable}" (
            id text PRIMARY KEY,
            tags text DEFAULT ''
          )
        `);
        await db.query(
          `INSERT INTO "${liveOnlyTable}" (id, tags) VALUES ('r1', '{"a":1}')`,
        );

        const diff = await new SchemaComparer(db, {
          ignoreTypeMismatches: false,
          relaxColumns: true,
        }).compare(liveOnlySchema());
        const statements = getSQLFromDiff(diff);
        expect(statements.length).toBeGreaterThan(0);
        // Must not throw "default for column ... cannot be cast
        // automatically to type jsonb" -- the original regression.
        for (const statement of statements) {
          await db.query(statement);
        }

        const liveDefault = await db.query(
          `SELECT column_default FROM information_schema.columns ` +
            `WHERE table_name = $1 AND column_name = 'tags'`,
          [liveOnlyTable],
        );
        expect(liveDefault.rows?.[0]?.column_default).toBeNull();

        const row = await db.query(
          `SELECT tags FROM "${liveOnlyTable}" WHERE id = 'r1'`,
        );
        expect(row.rows?.[0]?.tags).toEqual({ a: 1 });
      });
    });
  },
);
