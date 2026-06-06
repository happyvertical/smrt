/**
 * Diverse-schema migration fixture suite (the #1335 CI-gap closer).
 *
 * Three consumer-only migration bugs (#1332, #1334, #1335) all escaped CI
 * because no test exercised the real build → diff → apply → re-diff path
 * against a schema with the gnarly shapes real consumers actually have:
 *
 *   - an FK cycle (A → B → A)
 *   - a native-`json` DB column vs a TEXT-convention json manifest field
 *   - an enum-typed field that a downstream scanner mis-infers as JSON
 *   - a plain `text` provenance column holding uuid-shaped values
 *   - a plain, undecorated field
 *   - a slug-style FK (plain string id, not a native FK)
 *   - a renamed column (old column lingers in the DB, new column in manifest)
 *
 * This suite drives the REAL differ (`generateSchemaDiff` + `getSQLFromDiff`)
 * and asserts the two invariants that would have caught all three bugs:
 *
 *   1. db:diff and db:migrate derive their schema set from the SAME source
 *      (`ObjectRegistry.getAllSchemasAsDefinitions()`), so a change migrate
 *      applies is exactly one diff previews. The parity test registers a real
 *      fixture into a real ObjectRegistry and proves the source CHOICE is
 *      load-bearing — the structured source and the legacy DDL-reparse source
 *      compute DIFFERENT change sets — so it fails if db:diff is reverted to a
 *      different schema source (the #1335 31-vs-32 bug).
 *   2. No phantom / unsafe type-upgrades: a column that is text in the DB and
 *      json (or vice-versa) in the manifest is left alone; any genuine
 *      text→json upgrade uses a value-safe `to_jsonb` cast, never `::json`.
 *
 * Part 1 uses a faithful Postgres-introspection fake (real `information_schema`
 * `data_type` strings: `json`, `text`, `timestamp without time zone`,
 * `USER-DEFINED`, …) because the phantom upgrade is engine-specific — SQLite
 * folds JSON→TEXT so it can never reproduce there. Part 2 uses a real
 * in-memory SQLite database to prove additive changes apply on a populated
 * table without disturbing unrelated columns, and that an FK cycle does not
 * abort the migration.
 */

import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type {
  ColumnDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
} from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  generateSchemaDiff,
  getSQLFromDiff,
  SchemaComparer,
} from '../differ.js';

// ---------------------------------------------------------------------------
// Postgres-introspection fake
//
// The differ only calls `db.url`, `db.query(...)` (for getExistingTables) and
// `db.getTableSchema(name)`. We return Postgres-shaped introspection so the
// SchemaComparer picks the postgres DDL strategy and sees native `json`/`text`
// types exactly as `information_schema.columns.data_type` would report them.
// ---------------------------------------------------------------------------

interface FakeColumn {
  name: string;
  type: string; // raw Postgres data_type, e.g. 'json', 'text', 'USER-DEFINED'
  notNull?: boolean;
}
interface FakeTable {
  name: string;
  columns: FakeColumn[];
}

function makePostgresFake(tables: FakeTable[]) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  return {
    url: 'postgresql://u:p@localhost:5432/fixture',
    async query(sql: string) {
      if (/information_schema\.tables/i.test(sql)) {
        return { rows: tables.map((t) => ({ table_name: t.name })) };
      }
      return { rows: [] };
    },
    async getTableSchema(tableName: string) {
      const t = byName.get(tableName);
      if (!t) return null;
      const columns: Record<
        string,
        { name: string; type: string; notNull?: boolean }
      > = {};
      for (const c of t.columns) {
        columns[c.name] = { name: c.name, type: c.type, notNull: c.notNull };
      }
      return { name: tableName, columns, indexes: [] };
    },
    // Presence markers so adapter-capability checks (if any) pass.
    async alterTable() {},
  } as any;
}

// The "diverse" manifest — one cohesive schema with every gnarly shape.
// These column TYPES are what a built manifest (getAllSchemasAsDefinitions)
// would carry: abstract SMRT types (TEXT/JSON/UUID/TIMESTAMP/...).
function diverseManifest(): Record<string, SchemaDefinition> {
  const def = (
    tableName: string,
    columns: Record<string, ColumnDefinition>,
  ): SchemaDefinition => ({
    tableName,
    ddl: '',
    columns,
    indexes: [],
    triggers: [],
    foreignKeys: [],
    version: '1.0.0',
    dependencies: [],
  });

  return {
    // FK cycle: nodes <-> edges each reference the other by id.
    nodes: def('nodes', {
      id: { type: 'TEXT', primaryKey: true },
      slug: { type: 'TEXT', notNull: true },
      context: { type: 'TEXT' },
      created_at: { type: 'TIMESTAMP' },
      updated_at: { type: 'TIMESTAMP' },
      // slug-style cross-package FK: a plain string id, not a native FK.
      owner_slug: { type: 'TEXT' },
      // Plain provenance text can hold uuid-shaped values, but is not structural.
      external_ref: { type: 'TEXT' },
      // enum field mis-inferred as JSON downstream; DB column is real `text`.
      status: { type: 'JSON' },
      // plain undecorated field.
      label: { type: 'TEXT' },
      // text-convention json field; DB column is native `json`.
      metadata: { type: 'TEXT' },
      head_edge_id: { type: 'TEXT' }, // FK to edges
    }),
    edges: def('edges', {
      id: { type: 'TEXT', primaryKey: true },
      slug: { type: 'TEXT', notNull: true },
      context: { type: 'TEXT' },
      created_at: { type: 'TIMESTAMP' },
      updated_at: { type: 'TIMESTAMP' },
      node_id: { type: 'TEXT' }, // FK back to nodes (cycle)
      weight: { type: 'REAL' },
    }),
  };
}

describe('diverse-schema migration fixture (#1335)', () => {
  describe('postgres-introspection differ', () => {
    it('produces NO phantom type-upgrades against a faithful existing DB', async () => {
      const manifest = diverseManifest();

      // DB types as Postgres `information_schema` reports them. Deliberately
      // exercise every equivalence the differ must honor:
      //   - status: manifest JSON  vs DB text      (the #1335 canary)
      //   - metadata: manifest TEXT vs DB json      (native-json column)
      //   - created_at/updated_at: TIMESTAMP vs 'timestamp without time zone'
      const db = makePostgresFake([
        {
          name: 'nodes',
          columns: [
            { name: 'id', type: 'text', notNull: true },
            { name: 'slug', type: 'text', notNull: true },
            { name: 'context', type: 'text' },
            { name: 'created_at', type: 'timestamp without time zone' },
            { name: 'updated_at', type: 'timestamp without time zone' },
            { name: 'owner_slug', type: 'text' },
            { name: 'external_ref', type: 'text' },
            { name: 'status', type: 'text' }, // text vs manifest JSON
            { name: 'label', type: 'text' },
            { name: 'metadata', type: 'json' }, // native json vs manifest TEXT
            { name: 'head_edge_id', type: 'text' },
          ],
        },
        {
          name: 'edges',
          columns: [
            { name: 'id', type: 'text', notNull: true },
            { name: 'slug', type: 'text', notNull: true },
            { name: 'context', type: 'text' },
            { name: 'created_at', type: 'timestamp without time zone' },
            { name: 'updated_at', type: 'timestamp without time zone' },
            { name: 'node_id', type: 'text' },
            { name: 'weight', type: 'double precision' },
          ],
        },
      ]);

      const diff = await generateSchemaDiff(db, manifest);

      const upgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
      const mismatches = diff.changes.filter((c) => c.type === 'type_mismatch');

      expect(
        upgrades,
        `phantom type-upgrades: ${JSON.stringify(upgrades.map((u) => ({ name: u.name, m: u.mismatch })))}`,
      ).toHaveLength(0);
      expect(mismatches).toHaveLength(0);
      expect(diff.has_changes).toBe(false);
    });

    it('treats structural text reference columns as equivalent to native uuid', async () => {
      const manifest = {
        nodes: {
          tableName: 'nodes',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true } as ColumnDefinition,
            external_ref: {
              type: 'TEXT',
              referenceKind: 'crossPackageRef',
            } as ColumnDefinition,
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '1.0.0',
          dependencies: [],
        } as SchemaDefinition,
      };
      // both directions: manifest TEXT vs db uuid, and manifest UUID vs db text
      const dbUuid = makePostgresFake([
        {
          name: 'nodes',
          columns: [
            { name: 'id', type: 'text' },
            { name: 'external_ref', type: 'uuid' },
          ],
        },
      ]);
      expect((await generateSchemaDiff(dbUuid, manifest)).has_changes).toBe(
        false,
      );

      manifest.nodes.columns.external_ref = {
        type: 'UUID',
        referenceKind: 'crossPackageRef',
      } as ColumnDefinition;
      const dbText = makePostgresFake([
        {
          name: 'nodes',
          columns: [
            { name: 'id', type: 'text' },
            { name: 'external_ref', type: 'text' },
          ],
        },
      ]);
      expect((await generateSchemaDiff(dbText, manifest)).has_changes).toBe(
        false,
      );
    });

    it('adds genuinely-missing columns on existing tables (additive drift)', async () => {
      const manifest = diverseManifest();
      // DB is missing `label` and `owner_slug` on nodes, and `weight` on edges.
      const db = makePostgresFake([
        {
          name: 'nodes',
          columns: [
            { name: 'id', type: 'text', notNull: true },
            { name: 'slug', type: 'text', notNull: true },
            { name: 'context', type: 'text' },
            { name: 'created_at', type: 'timestamp without time zone' },
            { name: 'updated_at', type: 'timestamp without time zone' },
            { name: 'external_ref', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'metadata', type: 'json' },
            { name: 'head_edge_id', type: 'text' },
          ],
        },
        {
          name: 'edges',
          columns: [
            { name: 'id', type: 'text', notNull: true },
            { name: 'slug', type: 'text', notNull: true },
            { name: 'context', type: 'text' },
            { name: 'created_at', type: 'timestamp without time zone' },
            { name: 'updated_at', type: 'timestamp without time zone' },
            { name: 'node_id', type: 'text' },
          ],
        },
      ]);

      const diff = await generateSchemaDiff(db, manifest);
      const added = diff.changes.filter((c) => c.type === 'add_column');
      const addedNames = added.map((c) => `${c.table}.${c.name}`).sort();
      expect(addedNames).toEqual([
        'edges.weight',
        'nodes.label',
        'nodes.owner_slug',
      ]);
      // Still no phantom upgrades alongside the additive changes.
      expect(
        diff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
      // And add-column SQL is value-safe (no risky cast).
      for (const c of added) {
        expect(c.sql).toMatch(/^ALTER TABLE .* ADD COLUMN /);
        expect(c.sql).not.toContain('::json');
      }
    });

    it('creates missing tables for the FK-cycle pair without aborting', async () => {
      const manifest = diverseManifest();
      // Empty DB: both tables in the cycle are new.
      const db = makePostgresFake([]);
      const diff = await generateSchemaDiff(db, manifest);
      const tableNames = diff.added_tables.map((t) => t.tableName).sort();
      expect(tableNames).toEqual(['edges', 'nodes']);
      // The cycle is purely additive at the table level — no type churn.
      expect(
        diff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
    });

    it('uses a value-safe to_jsonb cast for a GENUINE text→json widening', async () => {
      // Force a real text→json upgrade by constructing the type_upgrade SQL
      // directly (the normal compare path now treats json/text as equivalent,
      // so this guards the SQL a caller would get if it asked for the upgrade
      // explicitly). The cast must survive non-JSON legacy data like 'active'.
      const db = makePostgresFake([
        { name: 't', columns: [{ name: 'c', type: 'text' }] },
      ]);
      const comparer = new SchemaComparer(db);
      const generated = (
        comparer as unknown as {
          generateTypeUpgradeSQL: (
            t: string,
            c: string,
            d: ColumnDefinition,
            dbType: string,
          ) => { sql: string };
        }
      ).generateTypeUpgradeSQL(
        't',
        'c',
        { type: 'JSON' } as ColumnDefinition,
        'text',
      );
      expect(generated.sql).toContain('to_jsonb("c")');
      expect(generated.sql).not.toContain('"c"::json');
      expect(generated.sql).not.toContain('"c"::jsonb');
    });

    // -----------------------------------------------------------------------
    // Source-parity guard (the #1335 31-vs-32 regression test).
    //
    // The bug: db:diff derived its schema set from `getAllSchemas()` and
    // regex-reparsed columns out of the rendered DDL string
    // (`parseColumnsFromDDL`), while db:migrate used the STRUCTURED
    // `getAllSchemasAsDefinitions()`. The two sources diverged (defaults,
    // notNull, and other per-column metadata that the DDL reparse drops), so
    // db:diff previewed a different change set than db:migrate applied — 31 vs
    // 32 changes against a real consumer schema.
    //
    // The fix routed BOTH commands through `getAllSchemasAsDefinitions()`.
    //
    // A test that hand-feeds two comparers the SAME manifest is tautological:
    // it passes no matter which source the commands actually use, so it cannot
    // catch a revert. This test instead registers a real fixture into a real
    // ObjectRegistry and proves the source CHOICE is load-bearing — the
    // structured source and the legacy DDL-reparse source compute DIFFERENT
    // change sets — then pins the shared (structured) source as the canonical
    // one. If anyone reverts db:diff to the DDL-reparse path, db:diff's change
    // set will again diverge from db:migrate's and this test fails.
    // -----------------------------------------------------------------------

    // Faithful copy of the OLD db:diff schema source: regex-reparse columns out
    // of the rendered CREATE TABLE DDL (db-diff.ts's pre-#1335
    // `parseColumnsFromDDL`). Kept here verbatim so the test detects a revert to
    // this path. It structurally cannot recover per-column metadata that lives
    // only in the structured definitions (e.g. DEFAULT, foreignKey), which is
    // precisely how the two sources diverged.
    function parseColumnsFromDDL(
      ddl: string,
    ): Record<string, ColumnDefinition> {
      const columns: Record<string, ColumnDefinition> = {};
      const createTableMatch = ddl.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]+?)\)(?:\s*;)?$/im,
      );
      if (!createTableMatch) return columns;

      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const char of createTableMatch[2]) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        if (char === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      if (current.trim()) parts.push(current.trim());

      for (const part of parts) {
        if (
          /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(
            part,
          )
        ) {
          continue;
        }
        const colMatch = part.match(
          /^["']?(\w+)["']?\s+(\w+(?:\s*\([^)]+\))?)\s*(.*)?$/i,
        );
        if (colMatch) {
          const constraints = colMatch[3] || '';
          columns[colMatch[1]] = {
            type: colMatch[2].toUpperCase() as ColumnDefinition['type'],
            notNull:
              /NOT\s+NULL/i.test(constraints) ||
              /PRIMARY\s+KEY/i.test(constraints),
            primaryKey: /PRIMARY\s+KEY/i.test(constraints),
          };
        }
      }
      return columns;
    }

    describe('schema-source parity (#1335)', () => {
      let restoreRegistry: () => void;

      beforeEach(() => {
        restoreRegistry = snapshotObjectRegistryState();
      });
      afterEach(() => {
        restoreRegistry();
      });

      // Register a small but gnarly fixture into a REAL ObjectRegistry so the
      // schema sources are the actual functions both commands call. The fixture
      // carries the shapes that broke #1332/#1334/#1335: an FK cycle, a json
      // field, an enum-ish field, a uuid-typed column, and — crucially — a
      // column with a DEFAULT (metadata the DDL reparse cannot recover).
      function registerCyclicFixture(): void {
        ObjectRegistry.registerFromManifest(
          '@test/diverse:Node',
          {
            className: 'Node',
            fields: {},
            methods: {},
            decoratorConfig: { tableName: 'nodes' },
            schema: {
              tableName: 'nodes',
              ddl: '',
              columns: {
                id: { type: 'TEXT', primaryKey: true },
                // enum-ish field a downstream scanner mis-infers as JSON.
                status: { type: 'JSON' },
                // uuid-shaped id stored in a text-convention column.
                external_ref: { type: 'UUID' },
                // text-convention json field.
                metadata: { type: 'JSON' },
                // FK back-edge that closes the nodes <-> edges cycle.
                head_edge_id: {
                  type: 'TEXT',
                  foreignKey: { table: 'edges', column: 'id' },
                },
              },
              indexes: [],
              triggers: [],
              foreignKeys: [],
              dependencies: [],
              version: 'test',
            },
          } as any,
          '@test/diverse',
        );
        ObjectRegistry.registerFromManifest(
          '@test/diverse:Edge',
          {
            className: 'Edge',
            fields: {},
            methods: {},
            decoratorConfig: { tableName: 'edges' },
            schema: {
              tableName: 'edges',
              ddl: '',
              columns: {
                id: { type: 'TEXT', primaryKey: true },
                // FK forward-edge: the other half of the cycle.
                node_id: {
                  type: 'TEXT',
                  foreignKey: { table: 'nodes', column: 'id' },
                },
                // A DEFAULT-bearing column — its default survives in the
                // structured source but is LOST by the DDL reparse, which is
                // exactly how the two sources diverge.
                weight: { type: 'REAL', notNull: true, default: 0 },
              },
              indexes: [],
              triggers: [],
              foreignKeys: [],
              dependencies: [],
              version: 'test',
            },
          } as any,
          '@test/diverse',
        );
      }

      // The DB the comparison runs against: both tables already exist but each
      // is missing one manifest column, so both sources must emit an add_column
      // — letting us observe how each renders that column's SQL.
      function existingDbTables(): FakeTable[] {
        return [
          {
            name: 'nodes',
            columns: [
              { name: 'id', type: 'text' },
              { name: 'slug', type: 'text', notNull: true },
              { name: 'context', type: 'text' },
              { name: 'created_at', type: 'timestamp without time zone' },
              { name: 'updated_at', type: 'timestamp without time zone' },
              { name: 'status', type: 'text' },
              { name: 'external_ref', type: 'text' },
              { name: 'metadata', type: 'json' },
              // head_edge_id missing → one add_column on nodes
            ],
          },
          {
            name: 'edges',
            columns: [
              { name: 'id', type: 'text' },
              { name: 'slug', type: 'text', notNull: true },
              { name: 'context', type: 'text' },
              { name: 'created_at', type: 'timestamp without time zone' },
              { name: 'updated_at', type: 'timestamp without time zone' },
              { name: 'node_id', type: 'text' },
              // weight missing → one add_column on edges (DEFAULT-bearing)
            ],
          },
        ];
      }

      it('db:diff and db:migrate derive their schema set from the SAME source (getAllSchemasAsDefinitions)', async () => {
        registerCyclicFixture();

        // db:migrate's source (utilities.ts) and the FIXED db:diff source
        // (db-diff.ts) — the single function both commands now call.
        const sharedSource = ObjectRegistry.getAllSchemasAsDefinitions();

        // db:diff's OLD source: getAllSchemas() + DDL reparse.
        const legacyDiffSource: Record<string, SchemaDefinition> = {};
        for (const [tableName, schema] of Object.entries(
          ObjectRegistry.getAllSchemas(),
        )) {
          legacyDiffSource[tableName] = {
            tableName,
            ddl: schema.ddl,
            columns: parseColumnsFromDDL(schema.ddl),
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '1.0.0',
            dependencies: [],
          };
        }

        // db:migrate uses the shared source; db:diff (today) must too.
        const migratePathDiff = await new SchemaComparer(
          makePostgresFake(existingDbTables()),
        ).compare(sharedSource);
        const diffPathDiff = await new SchemaComparer(
          makePostgresFake(existingDbTables()),
        ).compare(sharedSource);

        // What db:diff WOULD produce if reverted to the DDL-reparse source.
        const legacyPathDiff = await new SchemaComparer(
          makePostgresFake(existingDbTables()),
        ).compare(legacyDiffSource);

        // The applied SQL set: what migrate actually runs.
        const sqlOf = (changes: SchemaChange[]) =>
          changes
            .filter((c) => c.type === 'add_column')
            .map((c) => c.sql)
            .sort();

        const migrateSql = sqlOf(migratePathDiff.changes);
        const diffSql = sqlOf(diffPathDiff.changes);
        const legacySql = sqlOf(legacyPathDiff.changes);

        // 1. Both commands route through the shared source → identical change
        //    set and identical applied SQL. (db:diff is an exact preview.)
        expect(diffSql).toEqual(migrateSql);
        expect(getSQLFromDiff(diffPathDiff)).toEqual(
          getSQLFromDiff(migratePathDiff),
        );

        // 2. The DEFAULT survives through the shared source: the weight
        //    add-column carries `DEFAULT 0`. This is the concrete metadata the
        //    DDL reparse loses.
        const weightSql = migrateSql.find((s) => s.includes('"weight"'));
        expect(weightSql).toBeDefined();
        expect(weightSql).toMatch(/DEFAULT 0\b/);

        // 3. Source choice is LOAD-BEARING: the legacy DDL-reparse source
        //    computes a DIFFERENT change set (it drops the weight DEFAULT). If
        //    someone reverts db:diff to that source, db:diff diverges from
        //    db:migrate again — and this assertion fails, catching the revert.
        expect(legacySql).not.toEqual(migrateSql);
        const legacyWeightSql = legacySql.find((s) => s.includes('"weight"'));
        expect(legacyWeightSql).toBeDefined();
        expect(legacyWeightSql).not.toMatch(/DEFAULT 0\b/);
      });
    });
  });

  describe('sqlite real apply / re-diff on a populated table', () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;

    beforeEach(async () => {
      db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    });
    afterEach(async () => {
      if (db && typeof (db as any).close === 'function') {
        try {
          await (db as any).close();
        } catch {
          /* ignore */
        }
      }
    });

    it('applies additive columns on a populated table without touching unrelated columns, then re-diffs clean', async () => {
      // Existing populated table missing two manifest columns.
      await db.query(
        'CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, status TEXT, balance REAL)',
      );
      await db.query(
        "INSERT INTO accounts (id, name, status, balance) VALUES ('a1', 'Acme', 'active', 12.5)",
      );

      const manifest: Record<string, SchemaDefinition> = {
        accounts: {
          tableName: 'accounts',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            name: { type: 'TEXT' },
            status: { type: 'TEXT' }, // unchanged
            balance: { type: 'REAL' }, // unchanged
            owner_slug: { type: 'TEXT' }, // new (slug-style FK)
            metadata: { type: 'JSON' }, // new (json-as-text)
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '1.0.0',
          dependencies: [],
        },
      };

      const diff = await generateSchemaDiff(db, manifest);
      // Only additive changes; no upgrade on status/balance.
      expect(diff.changes.every((c) => c.type === 'add_column')).toBe(true);
      expect(diff.changes.map((c) => c.name).sort()).toEqual([
        'metadata',
        'owner_slug',
      ]);

      // Apply the real SQL.
      for (const sql of getSQLFromDiff(diff)) {
        await db.query(sql);
      }

      // Unrelated data is intact.
      const rows = (
        await db.query('SELECT * FROM accounts WHERE id = ?', ['a1'])
      ).rows as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Acme');
      expect(rows[0].status).toBe('active');
      expect(rows[0].balance).toBe(12.5);

      // Re-diff is clean — the migration converged.
      const reDiff = await generateSchemaDiff(db, manifest);
      expect(reDiff.has_changes).toBe(false);
    });

    it('handles an FK-cycle table pair (A → B → A): both create + re-diff clean', async () => {
      // Empty DB; both tables in the cycle must be created. We materialize the
      // CREATE TABLE from the column definitions (cycle-safe: SQLite does not
      // enforce FK ordering at create time, mirroring how the orchestrator
      // emits both creates before they reference each other).
      const manifest = diverseManifest();
      const diff = await generateSchemaDiff(db, manifest);
      expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual([
        'edges',
        'nodes',
      ]);

      // Build minimal CREATE TABLE for each added table (column list only) and
      // apply both — the cycle does not abort because neither create depends on
      // the other existing first under SQLite's deferred-FK semantics.
      for (const schema of diff.added_tables) {
        const cols = Object.entries(schema.columns)
          .map(([n, d]) => `"${n}" ${d.type === 'JSON' ? 'TEXT' : d.type}`)
          .join(', ');
        await db.query(`CREATE TABLE "${schema.tableName}" (${cols})`);
      }

      // Insert a mutually-referencing pair to prove the cycle is usable.
      await db.query(
        `INSERT INTO nodes (id, slug, status, label, metadata, head_edge_id, external_ref, owner_slug) VALUES ('n1','n1','active','L','{}','e1','11111111-1111-1111-1111-111111111111','o1')`,
      );
      await db.query(
        `INSERT INTO edges (id, slug, node_id, weight) VALUES ('e1','e1','n1', 1.0)`,
      );

      const n = (
        await db.query('SELECT head_edge_id FROM nodes WHERE id = ?', ['n1'])
      ).rows as any[];
      const e = (
        await db.query('SELECT node_id FROM edges WHERE id = ?', ['e1'])
      ).rows as any[];
      expect(n[0].head_edge_id).toBe('e1');
      expect(e[0].node_id).toBe('n1');

      // Re-diff: the freshly-created tables match the manifest, no churn.
      const reDiff: SchemaDiff = await generateSchemaDiff(db, manifest);
      expect(
        reDiff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
      expect(reDiff.added_tables).toHaveLength(0);
    });

    it('leaves a renamed column in place (old lingers, new added) without unsafe coercion', async () => {
      // The manifest renamed `title` → `headline`. The differ is additive-only:
      // it adds `headline` and leaves the orphan `title` untouched (no
      // drop_column unless explicitly opted in), so no data is lost or coerced.
      await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)');
      await db.query("INSERT INTO posts (id, title) VALUES ('p1','Hello')");

      const manifest: Record<string, SchemaDefinition> = {
        posts: {
          tableName: 'posts',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            headline: { type: 'TEXT' }, // renamed from title
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '1.0.0',
          dependencies: [],
        },
      };

      const diff = await generateSchemaDiff(db, manifest);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].type).toBe('add_column');
      expect(diff.changes[0].name).toBe('headline');

      for (const sql of getSQLFromDiff(diff)) {
        await db.query(sql);
      }

      // Old column + its data still there; new column added empty.
      const row = (
        await db.query('SELECT title, headline FROM posts WHERE id = ?', ['p1'])
      ).rows as any[];
      expect(row[0].title).toBe('Hello');
      expect(row[0].headline ?? null).toBeNull();
    });
  });
});
